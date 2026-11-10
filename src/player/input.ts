// Keyboard + mouse + pointer lock. Only ever constructed in 'play' mode.
import type { MoveInput } from './controller';

const SENS = 0.0022; // radians per pixel

export interface InputEvents {
  onFly(): void;
  onMute(): void;
  onLockChange(locked: boolean): void;
  onLockError(): void;
}

export class Input {
  readonly keys = new Set<string>();
  private dx = 0;
  private dy = 0;
  private jumpEdge = false;
  /** true while we are playing without pointer lock (lock refused): look by dragging. */
  dragLook = false;
  private dragging = false;
  enabled = false;
  private off: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, private ev: InputEvents) {
    const on = <K extends keyof WindowEventMap>(t: K, f: (e: WindowEventMap[K]) => void, o?: AddEventListenerOptions) => {
      window.addEventListener(t, f as EventListener, o);
      this.off.push(() => window.removeEventListener(t, f as EventListener, o));
    };
    const onDoc = <K extends keyof DocumentEventMap>(t: K, f: (e: DocumentEventMap[K]) => void) => {
      document.addEventListener(t, f as EventListener);
      this.off.push(() => document.removeEventListener(t, f as EventListener));
    };
    on('keydown', (e) => {
      if (!this.enabled) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ControlLeft', 'ControlRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.jumpEdge = true;
      if (e.code === 'KeyF') this.ev.onFly();
      if (e.code === 'KeyM') this.ev.onMute();
    });
    on('keyup', (e) => this.keys.delete(e.code));
    on('blur', () => this.release());
    onDoc('visibilitychange', () => document.hidden && this.release());
    on('mousemove', (e) => {
      if (!this.enabled) return;
      if (!this.locked && !(this.dragLook && this.dragging)) return;
      // Clamp the occasional giant spike browsers emit right after locking.
      this.dx += Math.max(-250, Math.min(250, e.movementX));
      this.dy += Math.max(-250, Math.min(250, e.movementY));
    });
    on('mousedown', () => (this.dragging = true));
    on('mouseup', () => (this.dragging = false));
    onDoc('pointerlockchange', () => this.ev.onLockChange(this.locked));
    onDoc('pointerlockerror', () => this.ev.onLockError());
  }

  get locked() {
    return document.pointerLockElement === this.canvas;
  }

  requestLock() {
    // Refusals arrive as a 'pointerlockerror' event (handled in the constructor); the promise form
    // rejects too, so swallow that to avoid an unhandled rejection.
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      this.ev.onLockError();
    }
  }

  release() {
    this.keys.clear();
    this.jumpEdge = false;
    this.dragging = false;
  }

  /** Consume mouse delta (radians). */
  takeLook(): [number, number] {
    const r: [number, number] = [this.dx * SENS, this.dy * SENS];
    this.dx = this.dy = 0;
    return r;
  }

  read(out: MoveInput): MoveInput {
    const k = this.keys;
    const a = (...c: string[]) => (c.some((x) => k.has(x)) ? 1 : 0);
    out.z = a('KeyW', 'ArrowUp') - a('KeyS', 'ArrowDown');
    out.x = a('KeyD', 'ArrowRight') - a('KeyA', 'ArrowLeft');
    out.y = a('Space') - a('KeyC', 'ControlLeft', 'ControlRight');
    out.run = !!a('ShiftLeft', 'ShiftRight');
    out.jump = this.jumpEdge;
    this.jumpEdge = false;
    return out;
  }

  dispose() {
    for (const f of this.off) f();
  }
}
