/**
 * colorPicker.ts — Annotation colour button + palette popover.
 *
 * Replaces the bare native <input type=color>. The popover offers:
 *  - a grid of predefined colours tuned to the current theme (deep inks for a
 *    white page, bright inks for a dark page; translucent-friendly pastels
 *    for the highlighter), and
 *  - a hue "gradient" slider plus a shade slider for anything in between,
 *    with a native picker as a last resort ("Custom…").
 * It pops in above the button (ui/motion.ts) and closes on outside click/Esc.
 */

import { dismiss } from './motion';

export interface ColorPickerOptions {
  /** Current colour, or null when the active tool has no colour. */
  get(): string | null;
  set(color: string): void;
  /** Preset swatches for the current tool + theme. */
  presets(): string[];
}

export const INK_LIGHT = ['#000000', '#4b5563', '#b91c1c', '#c2410c', '#a16207', '#15803d', '#0f766e', '#1d4ed8', '#4338ca', '#7e22ce', '#be185d', '#78350f'];
export const INK_DARK = ['#ffffff', '#d1d5db', '#f87171', '#fb923c', '#facc15', '#4ade80', '#2dd4bf', '#60a5fa', '#a5b4fc', '#c084fc', '#f472b6', '#d6a36c'];
export const HIGHLIGHTERS = ['#ffe066', '#bef264', '#86efac', '#67e8f9', '#93c5fd', '#c4b5fd', '#f9a8d4', '#fdba74'];

export class ColorPicker {
  readonly el: HTMLButtonElement;
  private swatch: HTMLSpanElement;
  private opts: ColorPickerOptions;
  private pop: HTMLDivElement | null = null;

  constructor(opts: ColorPickerOptions) {
    this.opts = opts;
    this.el = document.createElement('button');
    this.el.className = 'annot-tbtn cp-button';
    this.el.title = 'Colour';
    this.el.setAttribute('aria-label', 'Colour');
    this.el.setAttribute('aria-haspopup', 'dialog');
    this.swatch = document.createElement('span');
    this.swatch.className = 'cp-current';
    this.el.appendChild(this.swatch);
    this.el.addEventListener('click', () => (this.pop ? this.close() : this.open()));
  }

  /** Reflect the current colour on the button (and an open popover). */
  refresh(): void {
    const c = this.opts.get();
    this.el.disabled = !c;
    this.swatch.style.background = c ?? 'transparent';
    if (this.pop && !c) this.close();
    else if (this.pop) this.markSelected(c!);
  }

  private open(): void {
    const current = this.opts.get();
    if (!current) return;
    const pop = document.createElement('div');
    pop.className = 'color-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Choose colour');
    const [h, , l] = hexToHsl(current);
    pop.innerHTML = `
      <div class="cp-grid">${this.opts
        .presets()
        .map((c) => `<button class="cp-swatch" data-c="${c}" style="background:${c}" title="${c}" aria-label="${c}"></button>`)
        .join('')}</div>
      <label class="cp-row" title="Hue">
        <input type="range" class="cp-hue" min="0" max="360" step="1" value="${Math.round(h)}" aria-label="Hue" />
      </label>
      <label class="cp-row" title="Shade">
        <input type="range" class="cp-light" min="12" max="88" step="1" value="${Math.round(Math.min(88, Math.max(12, l)))}" aria-label="Shade" />
      </label>
      <div class="cp-foot">
        <span class="cp-preview"></span><span class="cp-hex"></span>
        <label class="cp-custom">Custom…<input type="color" value="${current}" /></label>
      </div>`;
    document.body.appendChild(pop);
    this.pop = pop;

    const hue = pop.querySelector<HTMLInputElement>('.cp-hue')!;
    const light = pop.querySelector<HTMLInputElement>('.cp-light')!;
    const fromSliders = () => {
      const c = hslToHex(Number(hue.value), 85, Number(light.value));
      this.apply(c, false);
    };
    hue.addEventListener('input', fromSliders);
    light.addEventListener('input', fromSliders);
    pop.querySelectorAll<HTMLButtonElement>('.cp-swatch').forEach((b) =>
      b.addEventListener('click', () => this.apply(b.dataset.c!, true)),
    );
    pop.querySelector<HTMLInputElement>('.cp-custom input')!.addEventListener('input', (e) =>
      this.apply((e.target as HTMLInputElement).value, true),
    );
    this.updateShadeTrack(Number(hue.value));
    this.markSelected(current);
    this.place();

    // Close on outside press / Esc (deferred so the opening click doesn't count).
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onOutside, true);
      document.addEventListener('keydown', this.onKey, true);
    });
  }

  private apply(color: string, syncSliders: boolean): void {
    this.opts.set(color);
    this.swatch.style.background = color;
    if (!this.pop) return;
    if (syncSliders) {
      const [h, , l] = hexToHsl(color);
      this.pop.querySelector<HTMLInputElement>('.cp-hue')!.value = String(Math.round(h));
      this.pop.querySelector<HTMLInputElement>('.cp-light')!.value = String(Math.round(Math.min(88, Math.max(12, l))));
    }
    this.updateShadeTrack(Number(this.pop.querySelector<HTMLInputElement>('.cp-hue')!.value));
    this.markSelected(color);
  }

  private markSelected(color: string): void {
    if (!this.pop) return;
    this.pop.querySelectorAll<HTMLButtonElement>('.cp-swatch').forEach((b) =>
      b.classList.toggle('is-selected', b.dataset.c!.toLowerCase() === color.toLowerCase()),
    );
    this.pop.querySelector<HTMLElement>('.cp-preview')!.style.background = color;
    this.pop.querySelector<HTMLElement>('.cp-hex')!.textContent = color.toUpperCase();
  }

  /** The shade slider's track runs dark → light in the chosen hue. */
  private updateShadeTrack(h: number): void {
    const t = this.pop?.querySelector<HTMLElement>('.cp-light');
    if (t) t.style.setProperty('--cp-hue', String(h));
  }

  /** Sit above the button (the bars live at the bottom), clamped on screen. */
  private place(): void {
    if (!this.pop) return;
    const r = this.el.getBoundingClientRect();
    const pw = this.pop.offsetWidth;
    const ph = this.pop.offsetHeight;
    const left = Math.min(window.innerWidth - pw - 8, Math.max(8, r.left + r.width / 2 - pw / 2));
    const above = r.top - ph - 10;
    this.pop.style.left = `${Math.round(left)}px`;
    this.pop.style.top = `${Math.round(above >= 8 ? above : r.bottom + 10)}px`;
  }

  close(): void {
    document.removeEventListener('pointerdown', this.onOutside, true);
    document.removeEventListener('keydown', this.onKey, true);
    dismiss(this.pop);
    this.pop = null;
  }

  private onOutside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (this.pop?.contains(t) || this.el.contains(t)) return;
    this.close();
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.close();
    }
  };
}

// ---- colour maths --------------------------------------------------------

export function hexToHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, s * 100, l * 100];
}

export function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
