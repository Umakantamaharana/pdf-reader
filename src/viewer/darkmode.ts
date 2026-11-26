/**
 * darkmode.ts — CSS/SVG-filter dark-mode & color-control engine.
 *
 * Strategy (per the chosen approach): instead of per-pixel canvas work, we drive
 * everything with cheap, GPU-composited CSS filters applied to the page layer:
 *
 *   filter: invert(1) hue-rotate(180deg) brightness(b) contrast(c)
 *
 * The invert+hue-rotate pair flips light/dark while keeping hues roughly correct.
 * A tint overlay (mix-blend-mode) maps the inverted "white" to the user's chosen
 * background color and "black" to the foreground color, giving true custom
 * black/slate/sepia palettes rather than a flat negative.
 *
 * `smartImageProtection` re-inverts a declared set of image regions by stamping
 * a second `invert(1) hue-rotate(180deg)` filter on them, cancelling the global
 * one so photos/diagrams render normally. (Region detection from the PDF operator
 * list is wired in the annotation/text-layer step; this engine exposes the hook.)
 *
 * All values come from settings.darkMode and update live via subscription.
 */

import { settings } from '../core/settings';
import { AppSettings, ColorPreset } from '../core/schema';
import { PDFViewer } from './pdfViewer';

export class DarkModeEngine {
  private root: HTMLElement; // the scroll container whose children are page layers
  private pdf: PDFViewer;
  private styleEl: HTMLStyleElement;
  private unsub: Array<() => void> = [];
  private renderedPages = new Set<number>();

  constructor(root: HTMLElement, pdf: PDFViewer) {
    this.root = root;
    this.pdf = pdf;
    this.styleEl = document.createElement('style');
    this.styleEl.id = 'lumen-darkmode-style';
    document.head.appendChild(this.styleEl);

    this.apply(settings.get<AppSettings['darkMode']>('darkMode'));
    this.unsub.push(settings.subscribe('darkMode', () => this.apply(settings.get('darkMode'))));

    // Re-protect images as each page renders (and after zoom/layout rebuilds).
    this.pdf.onPageRendered((pageNum) => {
      this.renderedPages.add(pageNum);
      void this.updateImageProtection(pageNum);
    });
  }

  private activePreset(dm: AppSettings['darkMode']): ColorPreset {
    return dm.presets.find((p) => p.id === dm.activePresetId) ?? dm.presets[0];
  }

  apply(dm: AppSettings['darkMode']): void {
    this.root.classList.toggle('dark-active', dm.enabled && dm.mode !== 'off');
    this.root.dataset.darkMode = dm.enabled ? dm.mode : 'off';

    // Image-protection overlays depend on the current dark settings.
    for (const p of this.renderedPages) void this.updateImageProtection(p);

    if (!dm.enabled || dm.mode === 'off') {
      this.styleEl.textContent = '';
      return;
    }

    const b = clamp(dm.brightness, 0.5, 1.5);
    const c = clamp(dm.contrast, 0.5, 1.5);
    const preset = this.activePreset(dm);

    // Page canvases get the inversion filter. The tint layer recolors the result.
    const invertFilter =
      dm.mode === 'smart-invert'
        ? `invert(1) hue-rotate(180deg) brightness(${b}) contrast(${c})`
        : `brightness(${b}) contrast(${c})`;

    const css = `
      .pdf-scroll.dark-active { background: ${preset.background}; }
      .pdf-scroll.dark-active .pdf-canvas { filter: ${invertFilter}; }
      ${
        dm.mode === 'custom-colors'
          ? `.pdf-scroll.dark-active .pdf-page::after {
               content: ''; position: absolute; inset: 0; pointer-events: none;
               background: ${preset.background};
               mix-blend-mode: multiply; }
             .pdf-scroll.dark-active .pdf-page { color: ${preset.foreground}; }`
          : `.pdf-scroll.dark-active .pdf-page::after {
               content: ''; position: absolute; inset: 0; pointer-events: none;
               mix-blend-mode: screen;
               background: ${preset.background};
               opacity: 0.0; }`
      }
    `;
    this.styleEl.textContent = css;
  }

  /**
   * Re-invert image regions so photos/diagrams render normally under smart
   * invert. Each region gets a backdrop-filter patch that cancels the page's
   * invert+hue-rotate for the pixels behind it. Only smart-invert inverts the
   * canvas, so protection only applies there.
   */
  private async updateImageProtection(pageNum: number): Promise<void> {
    const el = this.pdf.getPageEl(pageNum);
    if (!el) return;
    el.querySelector('.dark-img-wrap')?.remove();
    const dm = settings.get<AppSettings['darkMode']>('darkMode');
    if (!dm.enabled || dm.mode !== 'smart-invert' || !dm.smartImageProtection) return;
    const regions = await this.pdf.getImageRegions(pageNum);
    if (!regions.length) return;
    const { width: pw, height: ph } = await this.pdf.getPageSize(pageNum);
    el.style.setProperty('--page-w', String(pw));
    el.style.setProperty('--page-h', String(ph));
    const wrap = document.createElement('div');
    wrap.className = 'annot-rot dark-img-wrap';
    wrap.dataset.rot = String(this.pdf.state.rotation);
    for (const r of regions) {
      const d = document.createElement('div');
      d.className = 'pdf-image-protect';
      d.style.left = `${r.x * 100}%`;
      d.style.top = `${r.y * 100}%`;
      d.style.width = `${r.w * 100}%`;
      d.style.height = `${r.h * 100}%`;
      wrap.appendChild(d);
    }
    el.appendChild(wrap);
  }

  // ---- Command-facing controls -----------------------------------------

  async toggle(): Promise<void> {
    await settings.set('darkMode.enabled', !settings.get<boolean>('darkMode.enabled'));
  }

  async cyclePreset(): Promise<void> {
    const dm = settings.get<AppSettings['darkMode']>('darkMode');
    const idx = dm.presets.findIndex((p) => p.id === dm.activePresetId);
    const next = dm.presets[(idx + 1) % dm.presets.length];
    await settings.patch({ 'darkMode.enabled': true, 'darkMode.activePresetId': next.id });
  }

  async nudgeBrightness(delta: number): Promise<void> {
    const v = clamp(settings.get<number>('darkMode.brightness') + delta, 0.5, 1.5);
    await settings.set('darkMode.brightness', round2(v));
  }

  async nudgeContrast(delta: number): Promise<void> {
    const v = clamp(settings.get<number>('darkMode.contrast') + delta, 0.5, 1.5);
    await settings.set('darkMode.contrast', round2(v));
  }

  destroy(): void {
    this.unsub.forEach((u) => u());
    this.styleEl.remove();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
