import type { WebSocket as ClientSocket } from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { architectGroups } from '../../access.ts';
import { record } from '../../audit.ts';
import type { AppContext } from '../../context.ts';
import { getSession } from '../../session.ts';
import { Prov, type WorkspaceShared } from './shared.ts';

/** Typing in a terminal marks its workspace active at most this often. */
const TOUCH_EVERY_MS = 30_000;

/** The terminal: a websocket between the browser and an Architect's sandbox. */
export async function terminalRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  { appOrigin, ownWorkspace, touch }: WorkspaceShared,
) {
  const { db } = ctx;

  // ---- Terminal -----------------------------------------------------------------------------

  /**
   * Relays a terminal between the browser and a sandbox. The bytes pass straight through: they
   * are never logged, stored or inspected (C5). Only opening and closing are recorded.
   */
  app.get<{ Querystring: { target?: string; cols?: string; rows?: string } }>(
    '/api/studio/terminal',
    { websocket: true },
    async (socket: ClientSocket, req) => {
      // Listen for the browser leaving straight away: it may go while we're still checking who
      // it is, and the sandbox's end must never be left open without it.
      let gone = false;
      let upstream: WebSocket | null = null;
      let opened: (() => void) | null = null;
      socket.on('close', () => {
        gone = true;
        if (upstream?.readyState === WebSocket.OPEN) upstream.close();
        else if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
        opened?.();
      });
      if (req.headers.origin !== appOrigin) return socket.close(1008, 'origin');
      const session = await getSession(ctx, req);
      if (!session || !ctx.supervisor) return socket.close(1008, 'sign in');
      const me = session.user.id;
      const target = String(req.query.target ?? '');
      const cols = Math.max(20, Math.min(400, Number(req.query.cols) || 100));
      const rows = Math.max(5, Math.min(200, Number(req.query.rows) || 30));
      let claims: Record<string, unknown>;
      let workspaceId: string | null = null;
      let groupId: string | null = null;
      if (target.startsWith('connect:')) {
        const p = Prov.safeParse(target.slice(8));
        if (!p.success || !(await architectGroups(db, me)).length)
          return socket.close(1008, 'target');
        claims = { a: me, p: p.data };
      } else if (target.startsWith('ws:')) {
        const ws = await ownWorkspace(me, target.slice(3));
        if (ws?.status !== 'running') return socket.close(1008, 'target');
        claims = { ws: ws.id };
        workspaceId = ws.id;
        groupId = ws.groupId;
      } else return socket.close(1008, 'target');
      if (gone) return;

      const up = new WebSocket(ctx.supervisor.terminalUrl(claims, cols, rows));
      upstream = up;
      // Before anything is awaited: closing a socket that hasn't connected yet emits an error,
      // and an unheard one would take the whole server down.
      up.on('error', () => socket.close(1011, 'sandbox'));
      await record(db, { groupId, actorUserId: me, action: 'terminal.opened', target });
      opened = () => {
        record(db, { groupId, actorUserId: me, action: 'terminal.closed', target }).then(
          () => {},
          () => {},
        );
      };
      if (gone) {
        up.terminate();
        opened();
        return;
      }
      let lastTouch = 0;
      up.on('open', () => {
        if (gone) up.close();
      });
      up.on('message', (data, isBinary) => {
        if (socket.readyState === socket.OPEN) socket.send(data as Buffer, { binary: isBinary });
      });
      up.on('close', () => socket.close());
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (up.readyState !== WebSocket.OPEN) return;
        up.send(data, { binary: isBinary });
        // Typing keeps a workspace awake (at most one database write every TOUCH_EVERY_MS).
        if (workspaceId && Date.now() - lastTouch > TOUCH_EVERY_MS) {
          lastTouch = Date.now();
          touch(workspaceId).then(
            () => {},
            () => {},
          );
        }
      });
    },
  );
}
