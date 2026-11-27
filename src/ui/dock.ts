/**
 * dock.ts — The toolbar slot, shared by the main toolbar and its sub-toolbars.
 *
 * Every bar (main, annotation, read-aloud, display) is a "face" of one drum at
 * the toolbar's position. Opening a sub-toolbar rolls the drum FORWARD (the
 * current face tips down and away, the new one rolls in from the top); closing
 * it rolls BACKWARD to whatever was underneath — usually the main toolbar.
 * Faces form a stack, so e.g. opening Display while annotating and closing it
 * returns to the annotation bar.
 *
 * The dock owns positioning (bottom centre, or a vertical bar on the left —
 * settings.ui.toolbarPosition; on the left the drum rolls sideways); faces are
 * plain flex bars and know nothing about where they sit. 3D is switched on
 * only while a face is rolling (see pulse()).
 */

type Listener = (top: string) => void;

class Dock {
  readonly el: HTMLDivElement;
  private faces = new Map<string, HTMLElement>();
  private stack: string[] = ['main'];
  private listeners = new Set<Listener>();

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'lumen-dock';
    document.body.appendChild(this.el);
  }

  register(name: string, face: HTMLElement): void {
    face.classList.add('dock-face');
    face.dataset.face = name;
    this.faces.set(name, face);
    this.el.appendChild(face);
    // The face showing at start must sit at 0°. Only roll() used to set the
    // angle, so the main toolbar began edge-on (90°) — invisible until a
    // sub-toolbar had been opened and closed.
    const active = this.top() === name;
    face.style.setProperty('--roll', active ? '0deg' : '90deg');
    face.classList.toggle('is-active', active);
  }

  top(): string {
    return this.stack[this.stack.length - 1];
  }

  isOpen(name: string): boolean {
    return this.stack.includes(name) && name !== 'main';
  }

  /** Roll a sub-toolbar in (forward). Re-opening an open face brings it to the top. */
  open(name: string): void {
    if (this.top() === name) return;
    const prev = this.top();
    this.stack = this.stack.filter((n) => n !== name);
    this.stack.push(name);
    this.roll(prev, name, 'forward');
  }

  /** Roll a sub-toolbar out (backward) to the face beneath it. */
  close(name: string): void {
    if (name === 'main' || !this.stack.includes(name)) return;
    if (this.top() !== name) {
      // Not visible: just drop it from the stack.
      this.stack = this.stack.filter((n) => n !== name);
      return;
    }
    this.stack.pop();
    this.roll(name, this.top(), 'backward');
  }

  toggle(name: string): void {
    this.isOpen(name) ? this.close(name) : this.open(name);
  }

  onChange(fn: Listener): void {
    this.listeners.add(fn);
  }

  private pulseTimer: number | undefined;

  /**
   * Enable the 3D context only while something animates. At rest the faces
   * have no 3D transform / perspective: Chrome renders backdrop-filter inside a
   * 3D context with flicker artifacts on repaints (e.g. hovering a button) —
   * the toolbar "hover glitch".
   */
  pulse(ms = 560): void {
    this.el.classList.add('is-rolling');
    clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => this.el.classList.remove('is-rolling'), ms);
  }

  private roll(fromName: string, toName: string, dir: 'forward' | 'backward'): void {
    const from = this.faces.get(fromName);
    const to = this.faces.get(toName);
    this.pulse();
    // Forward: the old face tips down/toward you (-90°) while the new one rolls
    // down from the top (+90° → 0). Backward is the mirror image.
    const enterAt = dir === 'forward' ? '90deg' : '-90deg';
    const leaveTo = dir === 'forward' ? '-90deg' : '90deg';
    if (to) {
      to.classList.add('no-anim');
      to.style.setProperty('--roll', enterAt);
      void to.offsetWidth; // commit the start angle before animating
      to.classList.remove('no-anim');
      to.style.setProperty('--roll', '0deg');
      to.classList.add('is-active');
    }
    if (from && from !== to) {
      from.style.setProperty('--roll', leaveTo);
      from.classList.remove('is-active');
    }
    this.listeners.forEach((fn) => fn(this.top()));
  }
}

let instance: Dock | null = null;
export function dock(): Dock {
  return (instance ??= new Dock());
}
