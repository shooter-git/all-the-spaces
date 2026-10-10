import type { GamepadState, HostMessage } from '@allthespaces/bridge-protocol';
import type { Bridge } from './bridge.ts';

/** A stick (two axes: move, look) or a button (jump, use…). */
export type ActionSpec =
  | 'stick'
  | 'button'
  | { stick: true; keys?: [up: string, left: string, down: string, right: string] }
  | { button: string; keys?: string[] };

const STICK_KEYS: [string, string, string, string][] = [
  ['KeyW', 'KeyA', 'KeyS', 'KeyD'],
  ['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'],
];
const BUTTON_KEYS = [['Space'], ['KeyE', 'Enter'], ['KeyQ'], ['KeyF'], ['KeyR'], ['ShiftLeft']];
/** Keys that press a focused button or follow a focused link: those stay with the control. */
const ACTIVATION_KEYS = new Set(['Enter', 'NumpadEnter', 'Space']);
/**
 * A creation's own controls. Not any [tabindex]: games often make their canvas focusable, and
 * Space and Enter on the canvas belong to the game.
 */
const CONTROLS =
  'button, a[href], select, summary, [role="button"], [role="link"], [role="checkbox"], ' +
  '[role="radio"], [role="switch"], [role="tab"], [role="option"], [role^="menuitem"]';
/** Standard gamepad buttons: A, B, X, Y, then the shoulders. */
const PAD_BUTTONS = [0, 1, 2, 3, 4, 5];

interface Stick {
  name: string;
  keys: [string, string, string, string];
  index: number;
  touch: { x: number; y: number };
}
interface Button {
  name: string;
  label: string;
  keys: string[];
  pad: number;
  touch: boolean;
  down: boolean;
}

/**
 * Input that works everywhere: keyboard, gamepad and touch. Define your actions once; on touch
 * screens the SDK draws a joystick and buttons (re-laid out when the screen turns), and
 * gamepads are relayed from the host page (browsers don't let creations read them directly).
 *
 * Pointers (mouse, touch, pen with pressure and tilt) work as normal DOM pointer events.
 */
export class PortalInput {
  private readonly sticks = new Map<string, Stick>();
  private readonly buttons = new Map<string, Button>();
  private readonly keys = new Set<string>();
  private pads: GamepadState[] = [];
  private readonly pressListeners = new Map<string, Set<() => void>>();
  private overlay: HTMLElement | null = null;

  constructor(
    bridge: Bridge,
    private touch: boolean,
  ) {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, [contenteditable]')) return;
      // Keyboard users can still press the creation's own buttons (and menus, links…).
      if (ACTIVATION_KEYS.has(e.code) && target?.closest?.(CONTROLS)) return;
      if (!this.keys.has(e.code)) {
        this.keys.add(e.code);
        for (const b of this.buttons.values()) if (b.keys.includes(e.code)) this.press(b);
      }
      if (this.claims(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      for (const b of this.buttons.values()) if (b.keys.includes(e.code)) this.release(b);
    });
    window.addEventListener('blur', () => this.keys.clear());
    bridge.on((msg: HostMessage) => {
      if (msg.type !== 'gamepads') return;
      const before = this.pads;
      this.pads = msg.data;
      for (const b of this.buttons.values()) {
        const was = before.some((p) => (p.buttons[b.pad] ?? 0) > 0.5);
        const now = this.pads.some((p) => (p.buttons[b.pad] ?? 0) > 0.5);
        if (now && !was) this.press(b);
        if (!now && was) this.release(b);
      }
    });
  }

  /**
   * Your actions, e.g. `{ move: 'stick', jump: { button: 'Jump' }, use: 'button' }`. The first
   * stick gets W A S D (and the left gamepad stick), the second the arrow keys (and the right
   * stick); buttons get Space, E, Q, F… and the gamepad's A, B, X, Y in order.
   */
  define(actions: Record<string, ActionSpec>) {
    let s = 0;
    let b = 0;
    for (const [name, spec] of Object.entries(actions)) {
      if (spec === 'stick' || (typeof spec === 'object' && 'stick' in spec)) {
        const keys = (typeof spec === 'object' && spec.keys) || STICK_KEYS[s] || STICK_KEYS[0];
        this.sticks.set(name, {
          name,
          keys: keys as Stick['keys'],
          index: s,
          touch: { x: 0, y: 0 },
        });
        s++;
      } else {
        const label = typeof spec === 'object' ? spec.button : name;
        const keys = (typeof spec === 'object' && spec.keys) || BUTTON_KEYS[b] || [];
        this.buttons.set(name, {
          name,
          label,
          keys,
          pad: PAD_BUTTONS[b] ?? b,
          touch: false,
          down: false,
        });
        b++;
      }
    }
    if (this.touch) this.drawTouchControls();
  }

  /**
   * The gamepads the app relays, as they are now (axes from -1 to 1, buttons from 0 to 1), for a
   * creation that reads pads itself. Browsers don't let creations read them directly.
   */
  gamepads(): readonly GamepadState[] {
    return this.pads;
  }

  /** A stick's position: x to the right, y forward/up, each from -1 to 1. */
  stick(name: string): { x: number; y: number } {
    const st = this.sticks.get(name);
    if (!st) return { x: 0, y: 0 };
    const [up, left, down, right] = st.keys;
    let x = (this.keys.has(right) ? 1 : 0) - (this.keys.has(left) ? 1 : 0) + st.touch.x;
    let y = (this.keys.has(up) ? 1 : 0) - (this.keys.has(down) ? 1 : 0) + st.touch.y;
    for (const p of this.pads) {
      const ax = p.axes[st.index * 2] ?? 0;
      const ay = p.axes[st.index * 2 + 1] ?? 0;
      if (Math.hypot(ax, ay) > 0.15) {
        x += ax;
        y -= ay;
      }
    }
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  /** Whether a button is held down right now. */
  isDown(name: string): boolean {
    return this.buttons.get(name)?.down ?? false;
  }

  /** Called each time a button is pressed. */
  onPress(name: string, listener: () => void) {
    let set = this.pressListeners.get(name);
    if (!set) {
      set = new Set();
      this.pressListeners.set(name, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Shows or hides the on-screen controls (they're shown automatically on touch screens). */
  showTouchControls(show: boolean) {
    this.touch = show;
    if (show) this.drawTouchControls();
    else this.overlay?.remove();
  }

  private claims(code: string) {
    return (
      [...this.sticks.values()].some((s) => s.keys.includes(code)) ||
      [...this.buttons.values()].some((b) => b.keys.includes(code))
    );
  }

  private press(b: Button) {
    if (b.down) return;
    b.down = true;
    for (const l of this.pressListeners.get(b.name) ?? []) l();
  }

  private release(b: Button) {
    const stillHeld =
      b.keys.some((k) => this.keys.has(k)) ||
      b.touch ||
      this.pads.some((p) => (p.buttons[b.pad] ?? 0) > 0.5);
    if (!stillHeld) b.down = false;
  }

  private drawTouchControls() {
    this.overlay?.remove();
    ensureStyles();
    const overlay = document.createElement('div');
    overlay.className = 'ats-touch';
    for (const st of this.sticks.values()) {
      const pad = document.createElement('div');
      pad.className = `ats-touch-stick ats-touch-stick-${st.index === 0 ? 'left' : 'right'}`;
      pad.setAttribute('role', 'application');
      pad.setAttribute('aria-label', `${st.name}: drag to move`);
      const knob = document.createElement('div');
      knob.className = 'ats-touch-knob';
      pad.append(knob);
      let active: number | null = null;
      const update = (e: PointerEvent) => {
        const r = pad.getBoundingClientRect();
        const radius = r.width / 2;
        let dx = e.clientX - (r.left + radius);
        let dy = e.clientY - (r.top + radius);
        const len = Math.hypot(dx, dy);
        if (len > radius) {
          dx = (dx / len) * radius;
          dy = (dy / len) * radius;
        }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        st.touch = { x: dx / radius, y: -dy / radius };
      };
      const end = () => {
        active = null;
        knob.style.transform = '';
        st.touch = { x: 0, y: 0 };
      };
      pad.addEventListener('pointerdown', (e) => {
        active = e.pointerId;
        pad.setPointerCapture(e.pointerId);
        update(e);
      });
      pad.addEventListener('pointermove', (e) => active === e.pointerId && update(e));
      pad.addEventListener('pointerup', end);
      pad.addEventListener('pointercancel', end);
      overlay.append(pad);
    }
    const buttons = document.createElement('div');
    buttons.className = 'ats-touch-buttons';
    for (const b of this.buttons.values()) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'ats-touch-button';
      el.textContent = b.label;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.touch = true;
        this.press(b);
      });
      const up = () => {
        b.touch = false;
        this.release(b);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('pointerleave', up);
      buttons.append(el);
    }
    overlay.append(buttons);
    document.body.append(overlay);
    this.overlay = overlay;
  }
}

let styled = false;
function ensureStyles() {
  if (styled) return;
  styled = true;
  const style = document.createElement('style');
  style.textContent = `
.ats-touch{position:fixed;inset:0;pointer-events:none;z-index:2147483000;
  padding:calc(16px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(16px + env(safe-area-inset-left))}
.ats-touch>*{pointer-events:auto;touch-action:none;-webkit-user-select:none;user-select:none}
.ats-touch-stick{position:absolute;bottom:calc(20px + env(safe-area-inset-bottom));width:132px;height:132px;border-radius:50%;
  background:rgba(251,249,247,.22);border:1px solid rgba(251,249,247,.45);backdrop-filter:blur(6px)}
.ats-touch-stick-left{left:calc(20px + env(safe-area-inset-left))}
.ats-touch-stick-right{right:calc(20px + env(safe-area-inset-right));bottom:calc(170px + env(safe-area-inset-bottom))}
.ats-touch-knob{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;
  background:rgba(251,249,247,.85);box-shadow:0 2px 8px rgba(0,0,0,.2);transition:transform 60ms}
.ats-touch-buttons{position:absolute;right:calc(20px + env(safe-area-inset-right));bottom:calc(24px + env(safe-area-inset-bottom));
  display:flex;flex-wrap:wrap-reverse;justify-content:flex-end;gap:12px;max-width:180px}
.ats-touch-button{min-width:64px;min-height:64px;border-radius:50%;border:1px solid rgba(251,249,247,.5);
  background:rgba(46,44,51,.45);color:#fbf9f7;font:600 14px system-ui,sans-serif;backdrop-filter:blur(6px)}
.ats-touch-button:active{background:rgba(63,91,124,.8)}
@media (orientation:landscape){.ats-touch-stick{width:120px;height:120px}
  .ats-touch-stick-right{bottom:calc(20px + env(safe-area-inset-bottom));right:calc(170px + env(safe-area-inset-right))}}`;
  document.head.append(style);
}
