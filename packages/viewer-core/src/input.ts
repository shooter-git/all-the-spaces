/**
 * Movement intent from keyboard, mouse and touch. Touch controls (joystick, look-drag, tap) are
 * drawn by the app's UI and feed in through `setJoystick`, `addLook` and the viewer's tapToWalk.
 */
export class InputState {
  /** Strafe right (+x) and forward (+z), each in [-1, 1]. */
  readonly move = { x: 0, z: 0 };
  run = false;
  /** Accumulated look rotation since the last frame, in radians. */
  private lookX = 0;
  private lookY = 0;
  private readonly keys = new Set<string>();
  private joystick = { x: 0, z: 0 };
  private readonly cleanups: (() => void)[] = [];
  /** Set by the app to show/hide hints ("click to look around"). */
  onPointerLockChange?: (locked: boolean) => void;

  attach(canvas: HTMLCanvasElement, options: { pointerLock: boolean }) {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      this.keys.add(e.code);
      if (
        [
          'KeyW',
          'KeyA',
          'KeyS',
          'KeyD',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Space',
        ].includes(e.code)
      ) {
        e.preventDefault();
      }
      this.recompute();
    };
    const up = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      this.recompute();
    };
    const blur = () => {
      this.keys.clear();
      this.recompute();
    };
    // Starting to type (e.g. in chat) lets go of any keys held for walking.
    const focus = (e: FocusEvent) => {
      if (isTyping(e)) blur();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('focusin', focus);
    this.cleanups.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('focusin', focus);
      window.removeEventListener('blur', blur);
    });

    if (options.pointerLock) {
      const click = () => {
        if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
      };
      const move = (e: MouseEvent) => {
        if (document.pointerLockElement === canvas)
          this.addLook(e.movementX * 0.0022, e.movementY * 0.0022);
      };
      const lockChange = () => this.onPointerLockChange?.(document.pointerLockElement === canvas);
      canvas.addEventListener('click', click);
      document.addEventListener('mousemove', move);
      document.addEventListener('pointerlockchange', lockChange);
      this.cleanups.push(() => {
        canvas.removeEventListener('click', click);
        document.removeEventListener('mousemove', move);
        document.removeEventListener('pointerlockchange', lockChange);
        if (document.pointerLockElement === canvas) document.exitPointerLock();
      });
    }
  }

  /** Touch joystick position (x right, z forward), magnitude ≤ 1. */
  setJoystick(x: number, z: number) {
    this.joystick = { x, z };
    this.recompute();
  }

  /** Adds look rotation (e.g. from a touch drag): radians right and down. */
  addLook(dx: number, dy: number) {
    this.lookX += dx;
    this.lookY += dy;
  }

  takeLook(): { x: number; y: number } {
    const out = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }

  get hasManualInput() {
    return this.move.x !== 0 || this.move.z !== 0;
  }

  private recompute() {
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    const kx = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
    const kz = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0);
    this.move.x = kx || this.joystick.x;
    this.move.z = kz || this.joystick.z;
    this.run = k('ShiftLeft', 'ShiftRight') || Math.hypot(this.joystick.x, this.joystick.z) > 0.95;
  }

  detach() {
    for (const c of this.cleanups.splice(0)) c();
  }
}

function isTyping(e: Event) {
  const t = e.target as HTMLElement | null;
  return Boolean(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
}
