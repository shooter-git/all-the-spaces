/**
 * The supervisor's API. Every request carries a ticket signed by the server for one action on one
 * workspace or Architect, valid for a minute. Requests are logged as one line (what, for whom,
 * whether it worked) — never file contents, and never terminal traffic.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { verifyToken } from '@ats/shared';
import { WebSocketServer } from 'ws';
import { type Log, log } from './log.ts';
import { HOLD_MS } from './sandboxes/containers.ts';
import type { Sandboxes } from './sandboxes.ts';

export interface Ticket {
  act: string;
  ws?: string;
  /** Architect (user id). */
  a?: string;
  /** Provider. */
  p?: string;
  sha?: string | null;
  env?: Record<string, string>;
  /** `open`: the whole internet (the group allows it). */
  net?: string;
}

// Source archives for publish checks can be large (base64 of up to ~300 MB), and so can a room's
// bake input (tens of MB with detailed furniture).
const MAX_BODY = 420 * 1024 * 1024;

export function createSupervisorServer(
  sandboxes: Sandboxes,
  opts: { secret: string; egressContainer: string; log?: Log },
) {
  const logger = opts.log ?? log;
  const audit = (entry: Record<string, unknown>) => logger.info(entry, 'request');
  const ticketOf = (text: unknown) =>
    typeof text === 'string' ? verifyToken<Ticket>('supervisor', text, opts.secret) : null;

  const readBody = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new Error('Too large');
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  };
  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (Buffer.isBuffer(body)) {
      res.writeHead(status, { 'content-type': 'application/octet-stream' });
      res.end(body);
    } else {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    }
  };

  type Handler = (t: Ticket, body: Record<string, unknown>) => Promise<unknown>;
  const need = (v: unknown, what: string) => {
    if (typeof v !== 'string' || !v) throw new Error(`Missing ${what}`);
    return v;
  };
  const stepOf = (b: Record<string, unknown>) => {
    if (b.step !== 'prepare' && b.step !== 'finish') throw new Error('Bad step');
    return b.step;
  };

  /**
   * Work run in a container that's already there (a workspace's checks, an installer), which can
   * take longer than one request should be held: it's started once, and each call waits on it for
   * at most HOLD_MS before answering `{ pending: true }`. The server then asks again with
   * `wait: true`, which only ever waits (it never starts the work twice). Asked while it's still
   * going, the same work is waited on, not started again; a finished answer is kept a few minutes
   * for the server to collect.
   */
  const going = new Map<
    string,
    { work: Promise<{ value: unknown } | { error: unknown }>; settled: boolean }
  >();
  const held =
    (handler: Handler): Handler =>
    async (t, b) => {
      const key = JSON.stringify([t.act, t.ws, t.a, t.p, b.what]);
      let entry = going.get(key);
      if (b.wait === true) {
        if (!entry) throw Object.assign(new Error('Nothing is running'), { status: 404 });
      } else if (!entry || entry.settled) {
        const work = handler(t, b).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const started = { work, settled: false };
        going.set(key, started);
        void work.then(() => {
          started.settled = true;
          setTimeout(() => {
            if (going.get(key) === started) going.delete(key);
          }, 5 * 60_000).unref();
        });
        entry = started;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        entry.work,
        new Promise<null>((r) => {
          timer = setTimeout(() => r(null), HOLD_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!outcome) return { pending: true };
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    };

  const actions: Record<string, Handler> = {
    'sandbox.start': (t) =>
      sandboxes.startSandbox({
        ws: need(t.ws, 'ws'),
        architect: need(t.a, 'a'),
        provider: need(t.p, 'p'),
        sha: t.sha ?? null,
        env: t.env ?? {},
        net: t.net === 'open' ? 'open' : 'limited',
      }),
    // Says whether a checkpoint was saved (for the log): sleeping never depends on it.
    'sandbox.stop': async (t) => ({ ok: true, ...(await sandboxes.stopSandbox(need(t.ws, 'ws'))) }),
    'sandbox.status': (t) => sandboxes.sandboxStatus(need(t.ws, 'ws')),
    'sandbox.activity': (t) => sandboxes.sandboxActivity(need(t.ws, 'ws')),
    'sandbox.type': (t, b) =>
      sandboxes.type(
        sandboxes.names.sandbox(need(t.ws, 'ws')),
        String(b.text ?? '').slice(0, 4000),
      ),
    'sandbox.launch': (t, b) =>
      sandboxes.launch(
        sandboxes.names.sandbox(need(t.ws, 'ws')),
        String(b.command ?? '').slice(0, 4000),
        { provider: need(t.p, 'p'), sha: need(t.sha, 'sha') },
      ),
    'sandbox.paste': (t, b) =>
      sandboxes.paste(
        sandboxes.names.sandbox(need(t.ws, 'ws')),
        String(b.text ?? '').slice(0, 4000),
      ),
    'workspace.uploads': (t) => sandboxes.listUploads(need(t.ws, 'ws')),
    'workspace.pictures': (t) => sandboxes.listPictures(need(t.ws, 'ws')),
    'workspace.changes': (t) => sandboxes.changedFiles(need(t.ws, 'ws')),
    'workspace.view': async (t, b) => {
      const bytes = await sandboxes.viewFile(need(t.ws, 'ws'), String(b.path ?? ''));
      if (!bytes) throw Object.assign(new Error('Not found'), { status: 404 });
      return bytes;
    },
    'workspace.unupload': (t, b) => sandboxes.removeUpload(need(t.ws, 'ws'), String(b.name ?? '')),
    'workspace.upload': (t, b) =>
      sandboxes.upload(
        need(t.ws, 'ws'),
        String(b.name ?? ''),
        Buffer.from(String(b.data ?? ''), 'base64'),
      ),
    'workspace.uploadpack': (t, b) =>
      sandboxes.uploadPack(
        need(t.ws, 'ws'),
        String(b.folder ?? ''),
        (Array.isArray(b.files) ? b.files : []).map((f: { path?: unknown; data?: unknown }) => ({
          path: String(f?.path ?? ''),
          data: Buffer.from(String(f?.data ?? ''), 'base64'),
        })),
      ),
    'sandbox.check': held((t) => sandboxes.check(need(t.ws, 'ws'))),
    'sandbox.run': held((t, b) => sandboxes.runFixed(need(t.ws, 'ws'), String(b.what ?? ''))),
    'workspace.read': async (t, b) => {
      const bytes = await sandboxes.readFile(need(t.ws, 'ws'), String(b.path ?? ''));
      if (!bytes) throw Object.assign(new Error('Not found'), { status: 404 });
      return bytes;
    },
    'workspace.write': (t, b) =>
      sandboxes.writeFile(
        need(t.ws, 'ws'),
        String(b.path ?? ''),
        Buffer.from(String(b.data ?? ''), 'base64'),
      ),
    'workspace.init': async (t, b) => {
      const files = new Map<string, Uint8Array>();
      for (const [path, data] of Object.entries((b.files ?? {}) as Record<string, string>))
        files.set(path, Buffer.from(data, 'base64'));
      return sandboxes.initWorkspace(need(t.ws, 'ws'), files);
    },
    'workspace.archive': (t) => sandboxes.archiveWorkspace(need(t.ws, 'ws')),
    'workspace.delete': async (t) => {
      await sandboxes.deleteWorkspace(need(t.ws, 'ws'));
      return { ok: true };
    },
    'preview.start': async (t) => {
      await sandboxes.startPreview(need(t.ws, 'ws'));
      return { ok: true };
    },
    'preview.stop': async (t) => {
      await sandboxes.stopPreview(need(t.ws, 'ws'));
      return { ok: true };
    },
    'preview.status': async (t) => ({ status: await sandboxes.previewStatus(need(t.ws, 'ws')) }),
    'preview.file': async (t, b) => {
      const bytes = await sandboxes.previewFile(
        need(t.ws, 'ws'),
        Number(b.stamp),
        String(b.path ?? ''),
      );
      if (!bytes) throw Object.assign(new Error('Not found'), { status: 404 });
      return bytes;
    },
    'connect.start': async (t) => {
      await sandboxes.startConnect(need(t.a, 'a'), need(t.p, 'p'));
      return { ok: true };
    },
    'connect.stop': async (t) => {
      await sandboxes.stopConnect(need(t.a, 'a'), need(t.p, 'p'));
      return { ok: true };
    },
    'connect.install': held((t) => sandboxes.install(need(t.a, 'a'), need(t.p, 'p'))),
    'connect.status': (t) => sandboxes.connectStatus(need(t.a, 'a'), need(t.p, 'p')),
    'api-keys': async () => sandboxes.apiKeys(),
    'connect.forget': async (t) => {
      await sandboxes.forget(need(t.a, 'a'), need(t.p, 'p'));
      return { ok: true };
    },
    'connect.launch': (t, b) =>
      sandboxes.launch(
        sandboxes.names.connect(need(t.a, 'a'), need(t.p, 'p') as 'claude'),
        String(b.command ?? '').slice(0, 4000),
        { provider: need(t.p, 'p'), sha: need(t.sha, 'sha') },
      ),
    // Only ever for one workspace: an Architect never sees what another's sandbox tried.
    'egress.blocked': async (t, b) => ({
      blocked: await sandboxes.blocked(
        opts.egressContainer,
        Number(b.since) || Date.now() - 3600_000,
        need(t.ws, 'ws'),
      ),
    }),
    'containers.list': async () => ({ containers: await sandboxes.list() }),
    'job.init': (t, b) =>
      sandboxes.initJob(need(t.ws, 'job'), Buffer.from(String(b.tar ?? ''), 'base64')),
    // A step is started, then waited on in calls of at most HOLD_MS, like a room's bake.
    'job.run': (t, b) => sandboxes.startStep(need(t.ws, 'job'), stepOf(b)),
    'job.wait': (t, b) => sandboxes.waitStep(need(t.ws, 'job'), stepOf(b)),
    'job.files': (t) => sandboxes.jobFiles(need(t.ws, 'job')),
    'job.delete': async (t) => {
      await sandboxes.deleteJob(need(t.ws, 'job'));
      return { ok: true };
    },
    // Lighting bakes for a place the server is building: its rooms in numbered slots, at most
    // `bake.slots` at once across every build (a room asked for beyond that is told it's busy).
    'bake.slots': () => sandboxes.bakeSlots(),
    'bake.init': (t, b) =>
      sandboxes.bakeInit(
        need(t.ws, 'job'),
        typeof b.sky === 'string' && b.sky ? Buffer.from(b.sky, 'base64') : null,
      ),
    'bake.room': (t, b) =>
      sandboxes.bakeRoom(need(t.ws, 'job'), b.slot, Buffer.from(String(b.input ?? ''), 'base64')),
    'bake.wait': (t, b) => sandboxes.bakeWait(need(t.ws, 'job'), b.slot),
    'bake.files': (t, b) => sandboxes.bakeFiles(need(t.ws, 'job'), b.slot),
    'bake.delete': async (t) => {
      await sandboxes.deleteBake(need(t.ws, 'job'));
      return { ok: true };
    },
  };

  const server = createServer(async (req, res) => {
    const match = req.method === 'POST' ? /^\/v1\/([a-z]+\.[a-z]+)$/.exec(req.url ?? '') : null;
    if (!match) return send(res, 404, { error: 'Not found' });
    const act = match[1] as string;
    let t: Ticket | null = null;
    try {
      const body = await readBody(req);
      t = ticketOf(body.ticket);
      if (!t || t.act !== act || !actions[act]) {
        audit({ act, ok: false, why: 'ticket' });
        return send(res, 403, { error: 'Not allowed' });
      }
      const result = await (actions[act] as Handler)(t, body);
      audit({ act, ws: t.ws, a: t.a, p: t.p, ok: true });
      return send(res, 200, result);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      audit({
        act,
        ws: t?.ws,
        a: t?.a,
        p: t?.p,
        ok: false,
        why: (err as Error).message.slice(0, 200),
      });
      return send(res, status, { error: (err as Error).message.slice(0, 500) });
    }
  });

  // Terminals: bytes are relayed as they are; nothing is kept or logged.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  /** Open terminals per container (their tags). */
  const active = new Map<string, Set<string>>();
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const t = url.pathname === '/v1/terminal' ? ticketOf(url.searchParams.get('ticket')) : null;
    if (t?.act !== 'terminal') {
      audit({ act: 'terminal', ok: false, why: 'ticket' });
      socket.destroy();
      return;
    }
    const cols = Number(url.searchParams.get('cols')) || 100;
    const rows = Number(url.searchParams.get('rows')) || 30;
    let term: Awaited<ReturnType<Sandboxes['terminal']>>;
    try {
      term = t.ws
        ? await sandboxes.terminal(sandboxes.names.sandbox(t.ws), cols, rows, '/workspace')
        : await sandboxes.terminal(
            sandboxes.names.connect(need(t.a, 'a'), need(t.p, 'p') as 'claude'),
            cols,
            rows,
            '/home/architect',
          );
    } catch (err) {
      audit({
        act: 'terminal',
        ws: t.ws,
        a: t.a,
        p: t.p,
        ok: false,
        why: (err as Error).message.slice(0, 200),
      });
      socket.destroy();
      return;
    }
    const container = t.ws
      ? sandboxes.names.sandbox(t.ws)
      : sandboxes.names.connect(need(t.a, 'a'), need(t.p, 'p') as 'claude');
    wss.handleUpgrade(req, socket, head, (ws) => {
      audit({ act: 'terminal', ws: t.ws, a: t.a, p: t.p, ok: true, opened: true });
      // Terminals that went away without saying so (a dropped connection) are hung up.
      let open = active.get(container);
      if (!open) {
        open = new Set();
        active.set(container, open);
      }
      open.add(term.tag);
      void sandboxes.reap(container, [...open]);
      term.stream.on('data', (d: Buffer) => ws.readyState === ws.OPEN && ws.send(d));
      term.stream.on('close', () => ws.close());
      term.stream.on('error', () => ws.close());
      // Strictly in order: keys typed right after "back to live" must reach the assistant, not
      // tmux's scroll mode. (Scrolling and resizing are about the session, not what's in it.)
      let queue: Promise<unknown> = Promise.resolve();
      const next = (step: () => unknown) => {
        queue = queue.then(step).catch(() => {});
      };
      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          next(() => term.stream.write(data as Buffer));
          return;
        }
        let m: { type?: string; cols?: unknown; rows?: unknown; lines?: unknown };
        try {
          m = JSON.parse(data.toString());
        } catch {
          return;
        }
        if (m.type === 'resize') next(() => term.resize(Number(m.cols), Number(m.rows)));
        else if (m.type === 'scroll' && Number.isFinite(Number(m.lines)))
          next(() => sandboxes.scroll(container, Number(m.lines)));
        else if (m.type === 'live') next(() => sandboxes.live(container));
      });
      ws.on('close', () => {
        term.stream.destroy();
        void term.close();
        active.get(container)?.delete(term.tag);
        audit({ act: 'terminal', ws: t.ws, a: t.a, p: t.p, ok: true, closed: true });
      });
    });
  });
  return server;
}
