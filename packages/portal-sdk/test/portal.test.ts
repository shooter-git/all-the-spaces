// @vitest-environment happy-dom
import { wrap } from '@allthespaces/bridge-protocol';
import { describe, expect, it, vi } from 'vitest';
import { connect, StaleSaveError } from '../src/index.ts';

describe('the SDK on its own (standalone, while building a creation)', () => {
  it('connects as the only player and host', async () => {
    const portal = await connect();
    expect(portal.standalone).toBe(true);
    expect(portal.me.name).toBe('You');
    expect(portal.session.isHost).toBe(true);
    expect(portal.session.players).toHaveLength(1);
  });

  it('saves and reads back, upgrading older saves', async () => {
    const v1 = await connect({ save: { version: 1 } });
    await v1.save.personal.set('page', { lines: ['hello'] });
    const v2 = await connect({
      save: {
        version: 2,
        migrate: (old, from) => (from === 1 ? { pages: [old] } : old),
      },
    });
    expect(await v2.save.personal.get('page')).toEqual({ pages: [{ lines: ['hello'] }] });
    const storage = v2.storage;
    await storage.setItem('volume', '0.4');
    expect(await storage.getItem('volume')).toBe('0.4');
  });

  it('shares values with everyone in the session', async () => {
    const portal = await connect();
    const seen = vi.fn();
    portal.session.onChange('board', seen);
    await portal.session.set('board', [1, 2, 3]);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveBeenCalledWith([1, 2, 3], 'you');
    expect(portal.session.get('board')).toEqual([1, 2, 3]);
    await portal.session.scores.add(5);
    await portal.session.scores.add(2);
    expect(portal.session.scores.table()[0]?.score).toBe(7);
  });

  it('turns keys into actions', async () => {
    const portal = await connect();
    portal.input.define({ move: 'stick', jump: { button: 'Jump' } });
    const jumped = vi.fn();
    portal.input.onPress('jump', jumped);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
    const move = portal.input.stick('move');
    expect(move.x).toBeCloseTo(Math.SQRT1_2);
    expect(move.y).toBeCloseTo(Math.SQRT1_2);
    expect(jumped).toHaveBeenCalledOnce();
    expect(portal.input.isDown('jump')).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
    expect(portal.input.isDown('jump')).toBe(false);
  });
});

describe('inside the app', () => {
  it('turns a refused save into a StaleSaveError', async () => {
    const p = await connect({ standaloneAfterMs: 0 });
    const bridge = (
      p as unknown as { bridge: { useHost: (h: unknown) => void; deliver: (d: unknown) => void } }
    ).bridge;
    // A pretend host that refuses every save as stale (someone else saved in the meantime).
    bridge.useHost({
      postMessage: (d: { msg: { type: string; id?: number } }) => {
        if (d.msg.type === 'save:set') {
          queueMicrotask(() =>
            bridge.deliver(
              wrap({ type: 'result', re: d.msg.id, ok: false, error: 'stale', code: 'stale' }),
            ),
          );
        }
      },
    });
    await expect(p.save.shared.set('board', [1])).rejects.toBeInstanceOf(StaleSaveError);
  });

  it('hands over the gamepads the app relays', async () => {
    const p = await connect({ standaloneAfterMs: 0 });
    const bridge = (p as unknown as { bridge: { deliver: (d: unknown) => void } }).bridge;
    expect(p.input.gamepads()).toEqual([]);
    const pad = { index: 0, axes: [0.5, -1, 0, 0], buttons: [1, 0, 0.2] };
    bridge.deliver(wrap({ type: 'gamepads', data: [pad] }));
    expect(p.input.gamepads()).toEqual([pad]);
  });

  it('runs exit handlers before asking to leave', async () => {
    const p = await connect({ standaloneAfterMs: 0 });
    const posted: { type: string }[] = [];
    (p as unknown as { bridge: { useHost: (h: unknown) => void } }).bridge.useHost({
      postMessage: (d: { msg: { type: string } }) => posted.push(d.msg),
    });
    const order: string[] = [];
    p.onExit(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('saved');
    });
    p.exit();
    await new Promise((r) => setTimeout(r, 60));
    expect(order).toEqual(['saved']);
    expect(posted.map((m) => m.type)).toContain('request-exit');
  });
});

describe("a creation's own buttons", () => {
  const key = (target: EventTarget, type: 'keydown' | 'keyup', code: string) => {
    const e = new KeyboardEvent(type, { code, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  };

  it('keep Enter and Space while they have keyboard focus, even with two button actions', async () => {
    const portal = await connect();
    // The first button action gets Space, the second E and Enter.
    portal.input.define({ jump: 'button', use: 'button' });
    const jumped = vi.fn();
    const used = vi.fn();
    portal.input.onPress('jump', jumped);
    portal.input.onPress('use', used);
    const restart = document.createElement('button');
    const help = document.createElement('a');
    help.href = '#help';
    document.body.append(restart, help);

    for (const control of [restart, help]) {
      control.focus();
      for (const code of ['Enter', 'Space']) {
        expect(key(control, 'keydown', code).defaultPrevented).toBe(false);
        key(control, 'keyup', code);
      }
    }
    expect(jumped).not.toHaveBeenCalled();
    expect(used).not.toHaveBeenCalled();

    // Other keys still play while a button has focus.
    restart.focus();
    expect(key(restart, 'keydown', 'KeyE').defaultPrevented).toBe(true);
    key(restart, 'keyup', 'KeyE');
    expect(used).toHaveBeenCalledOnce();
    restart.remove();
    help.remove();
  });

  it('leave Enter and Space to the game when the game has focus', async () => {
    const portal = await connect();
    portal.input.define({ jump: 'button', use: 'button' });
    const used = vi.fn();
    portal.input.onPress('use', used);
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    canvas.focus();
    expect(key(canvas, 'keydown', 'Enter').defaultPrevented).toBe(true);
    key(canvas, 'keyup', 'Enter');
    expect(used).toHaveBeenCalledOnce();
    canvas.remove();
  });
});
