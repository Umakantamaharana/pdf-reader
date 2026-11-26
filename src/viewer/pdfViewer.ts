/**
 * pdfViewer.ts — PDF.js rendering engine.
 *
 * Handles document loading, lazy per-page canvas rendering, navigation,
 * zoom/fit, layout modes (single / two-page / continuous), and rotation.
 * The worker is imported with `?url` so Vite emits it locally — no remote code
 * is fetched, satisfying the Manifest V3 CSP.
 *
 * It is view-only: dark mode, annotations, and TTS attach as separate layers.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { LayoutMode, FitMode } from '../core/schema';
import { guardTextLayer } from './selectionGuard';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export interface ViewerState {
  page: number; // 1-based current page
  pageCount: number;
  scale: number;
  rotation: number;
  layout: LayoutMode;
  fit: FitMode;
}

type StateListener = (s: ViewerState) => void;

interface PageEntry {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textLayerDiv: HTMLDivElement;
  textLayerRendered: boolean;
  textDivs: HTMLElement[]; // one span per text item (index-aligned with textItems)
  textItems: string[]; // the item strings, index-aligned with textDivs
  rendered: boolean;
  rendering: pdfjsLib.RenderTask | null;
  /** In-flight renderPage() call (set synchronously, before any await) so
   *  concurrent callers — observer, renderVisiblePages, goToPage — share one
   *  render instead of racing two page.render() calls onto the same canvas. */
  pending: Promise<void> | null;
  /** Bumped on every invalidation; a render that started under an older
   *  generation discards its result instead of marking the page rendered. */
  gen: number;
  page?: PDFPageProxy;
}

/** One text item with its box on the unrotated page (PDF points, top-left origin). */
export interface PageTextItem {
  str: string;
  hasEOL: boolean;
  x: number;
  y: number; // top of the glyph box
  w: number;
  h: number; // ≈ font size
}
export interface PageTextGeometry {
  items: PageTextItem[];
  width: number;
  height: number;
}

/** Exposes a rendered page's text spans + item strings for search/annotation. */
export interface PageTextLayer {
  divs: HTMLElement[];
  items: string[];
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
/** Keep this many pages rendered on each side of the viewport; free the rest. */
const KEEP_MARGIN = 4;
/** Gap between the two pages of a spread (must match .pdf-spread gap in CSS). */
const SPREAD_GAP = 12;
/** Wait this long after the last zoom step before re-rasterising pages. */
const ZOOM_SETTLE_MS = 140;
/** Duration of the animated zoom for buttons / keys / fit changes. */
const ZOOM_ANIM_MS = 220;
/** Multiplicative step for one zoom-in / zoom-out press. */
const ZOOM_STEP = 1.2;

interface PixelBox { w: number; h: number; cssW: string; cssH: string }

/** Integer device-pixel bitmap size for a viewport, and the exact CSS size
 *  that maps it 1:1 onto device pixels at this DPR. */
function pixelBox(width: number, height: number, dpr: number): PixelBox {
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  return { w, h, cssW: `${w / dpr}px`, cssH: `${h / dpr}px` };
}

/** Free a canvas's backing store right away instead of waiting for GC. */
function releaseCanvas(c: HTMLCanvasElement): void {
  c.width = 0;
  c.height = 0;
}

export class PDFViewer {
  private container: HTMLElement;
  private content: HTMLDivElement;
  private doc: PDFDocumentProxy | null = null;
  private entries: PageEntry[] = [];
  private observer: IntersectionObserver | null = null;
  private visible = new Set<number>(); // page numbers currently intersecting the viewport
  private listeners = new Set<StateListener>();
  private pageRenderedListeners = new Set<(pageNum: number) => void>();
  private textCache = new Map<number, string[]>();

  state: ViewerState = {
    page: 1,
    pageCount: 0,
    scale: 1,
    rotation: 0,
    layout: 'continuous',
    fit: 'width',
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.classList.add('pdf-scroll');
    // All pages live in one inner box so a zoom can be animated as a single
    // GPU transform on it (compositor-only, smooth even on low-end machines).
    this.content = document.createElement('div');
    this.content.className = 'pdf-content';
    this.container.appendChild(this.content);
  }

  onChange(fn: StateListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn({ ...this.state }));
  }

  /** Load a PDF from a URL (remote, file://, blob:, or data:). */
  async load(url: string): Promise<void> {
    // Resolve bundled pdf.js assets to absolute extension URLs. Relative paths
    // would resolve against the viewer's subfolder (…/src/viewer/) and 404; the
    // assets ship at the extension root under /pdfjs/ (see public/pdfjs).
    const assetBase = chrome?.runtime?.getURL?.('pdfjs/') ?? 'pdfjs/';
    const task = pdfjsLib.getDocument({
      url,
      cMapUrl: `${assetBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetBase}standard_fonts/`,
      useSystemFonts: true,
    });
    this.doc = await task.promise;
    this.state.pageCount = this.doc.numPages;
    await this.buildLayout();
    this.emit();
  }

  /** (Re)build the page scaffold for the current layout and wire lazy rendering. */
  private async buildLayout(): Promise<void> {
    if (!this.doc) return;
    this.teardownObserver();
    this.cancelZoomFx();
    this.content.replaceChildren();
    this.entries = [];
    this.container.dataset.layout = this.state.layout;

    const count = this.doc.numPages;
    const makeEntry = (pageNum: number): PageEntry => {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      el.dataset.page = String(pageNum);
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-canvas';
      el.appendChild(canvas);
      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      el.appendChild(textLayerDiv);
      return {
        el,
        canvas,
        textLayerDiv,
        textLayerRendered: false,
        textDivs: [],
        textItems: [],
        rendered: false,
        rendering: null,
        pending: null,
        gen: 0,
      };
    };

    if (this.state.layout === 'two-page') {
      for (let i = 1; i <= count; i += 2) {
        const row = document.createElement('div');
        row.className = 'pdf-spread';
        const left = makeEntry(i);
        this.entries[i - 1] = left;
        row.appendChild(left.el);
        if (i + 1 <= count) {
          const right = makeEntry(i + 1);
          this.entries[i] = right;
          row.appendChild(right.el);
        }
        this.content.appendChild(row);
      }
    } else {
      for (let i = 1; i <= count; i++) {
        const e = makeEntry(i);
        this.entries[i - 1] = e;
        this.content.appendChild(e.el);
      }
    }

    // Reserve height so scrollbars are correct before a page renders.
    await this.presize();

    if (this.state.layout === 'continuous' || this.state.layout === 'two-page') {
      this.setupObserver();
    } else {
      // single-page: only the current page is in flow
      this.applySinglePageVisibility();
      await this.renderPage(this.state.page);
    }
  }

  /** Reserve each page's box at the current scale so scrollbars are correct
   *  before a page renders. Page proxies are fetched in parallel (and reused
   *  once cached) so large documents don't block load on a sequential loop. */
  private async presize(): Promise<void> {
    if (!this.doc) return;
    const effScale = await this.effectiveScale();
    const dpr = window.devicePixelRatio || 1;
    // One device pixel in CSS px — lets CSS snap page offsets to the pixel grid.
    this.container.style.setProperty('--dpx', `${1 / dpr}px`);
    await Promise.all(
      this.entries.map(async (entry, i) => {
        if (!entry) return;
        const page = entry.page ?? (await this.doc!.getPage(i + 1));
        entry.page = page;
        const vp = page.getViewport({ scale: effScale, rotation: this.state.rotation });
        const box = pixelBox(vp.width, vp.height, dpr);
        this.applyBox(entry, box);
        // Scale the (still stale) canvas and overlays with the box immediately,
        // so a zoom looks like a smooth stretch until the crisp re-render swaps in.
        entry.canvas.style.width = box.cssW;
        entry.canvas.style.height = box.cssH;
        entry.el.style.setProperty('--scale-factor', String(effScale));
      }),
    );
    this.shownScale = effScale;
    this.updateSpreadWidths();
  }

  /** Scale currently laid out on screen (differs from state.scale mid-animation). */
  private shownScale = 1;

  /** Two-page spreads are centered as a unit; give them their exact width too. */
  private updateSpreadWidths(): void {
    for (const row of Array.from(this.container.querySelectorAll<HTMLElement>('.pdf-spread'))) {
      let w = 0;
      const pages = Array.from(row.children) as HTMLElement[];
      pages.forEach((p) => (w += parseFloat(p.style.width) || 0));
      w += SPREAD_GAP * Math.max(0, pages.length - 1);
      row.style.setProperty('--pw', `${w}px`);
    }
  }

  private applyBox(entry: PageEntry, box: PixelBox): void {
    entry.el.style.width = box.cssW;
    entry.el.style.height = box.cssH;
    entry.el.style.setProperty('--pw', box.cssW);
  }

  private setupObserver(): void {
    this.observer = new IntersectionObserver(
      (ents) => {
        for (const ent of ents) {
          const pageNum = Number((ent.target as HTMLElement).dataset.page);
          if (ent.isIntersecting) {
            this.visible.add(pageNum);
            void this.renderPage(pageNum);
            if (ent.intersectionRatio > 0.5 && pageNum !== this.state.page) {
              this.state.page = pageNum;
              this.emit();
            }
          } else {
            this.visible.delete(pageNum);
          }
        }
        this.evictDistantPages();
      },
      { root: this.container, rootMargin: '200px 0px', threshold: [0, 0.5, 1] },
    );
    this.entries.forEach((e) => e && this.observer!.observe(e.el));
  }

  private teardownObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.visible.clear();
  }

  /**
   * Free canvases + text layers for pages far outside the viewport so long
   * documents don't accumulate unbounded canvas memory. The page element keeps
   * its presized box, so scroll position is unaffected; the page re-renders
   * (and re-fires onPageRendered, re-attaching search/dark/annotation layers)
   * when it scrolls back into view.
   */
  private evictDistantPages(): void {
    if (this.visible.size === 0) return;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of this.visible) {
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    }
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e || !e.rendered) continue;
      const pageNum = i + 1;
      if (pageNum < lo - KEEP_MARGIN || pageNum > hi + KEEP_MARGIN) this.releasePage(e);
    }
  }

  private releasePage(entry: PageEntry): void {
    entry.gen++;
    entry.pending = null;
    entry.rendering?.cancel();
    entry.rendering = null;
    // Zeroing the backing store releases the memory; the CSS box size is kept.
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.rendered = false;
    entry.textLayerRendered = false;
    entry.textLayerDiv.replaceChildren();
    entry.textDivs = [];
    entry.textItems = [];
  }

  /** Render a single page to its canvas at device pixel ratio. Idempotent:
   *  concurrent calls for the same page share one in-flight render. */
  private renderPage(pageNum: number): Promise<void> {
    if (!this.doc) return Promise.resolve();
    // Mid zoom-animation the boxes are being resized every frame; rendering now
    // would snap a page to the final size. The animation re-renders when done.
    if (this.animating) return Promise.resolve();
    const entry = this.entries[pageNum - 1];
    if (!entry || entry.rendered) return Promise.resolve();
    if (entry.pending) return entry.pending;
    const gen = entry.gen;
    const p = this.doRenderPage(pageNum, entry, gen).finally(() => {
      if (entry.pending === p) entry.pending = null;
    });
    entry.pending = p;
    return p;
  }

  private async doRenderPage(pageNum: number, entry: PageEntry, gen: number): Promise<void> {
    const page = entry.page ?? (await this.doc!.getPage(pageNum));
    entry.page = page;
    const effScale = await this.effectiveScale();
    // Invalidated (zoom/rotate/evict) while we were awaiting — a newer render owns the page.
    if (gen !== entry.gen) return;
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: effScale, rotation: this.state.rotation });
    const box = pixelBox(viewport.width, viewport.height, dpr);

    // Double-buffer: draw into a detached canvas and swap it in only once it is
    // complete. Resetting the visible canvas's width/height (the old approach)
    // blanks it to white for the whole render, which flickered on every zoom.
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = box.w;
    canvas.height = box.h;
    canvas.style.width = box.cssW;
    canvas.style.height = box.cssH;
    this.applyBox(entry, box);

    // The text layer positions its spans using the --scale-factor CSS variable.
    entry.el.style.setProperty('--scale-factor', String(effScale));

    const ctx = canvas.getContext('2d', { alpha: false })!;
    // Map the viewport exactly onto the integer bitmap so the bitmap is shown
    // 1:1 on device pixels (no browser resampling → crisp small text, also on
    // fractional-DPR displays like 125% / 150% Windows scaling).
    const sx = box.w / viewport.width;
    const sy = box.h / viewport.height;
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: sx !== 1 || sy !== 1 ? [sx, 0, 0, sy, 0, 0] : undefined,
    });
    entry.rendering = task;
    try {
      await task.promise;
      if (gen !== entry.gen) return;
      entry.el.replaceChild(canvas, entry.canvas);
      releaseCanvas(entry.canvas);
      entry.canvas = canvas;
      entry.rendered = true;
      await this.renderTextLayer(entry, page, viewport);
      if (gen !== entry.gen) return;
      this.pageRenderedListeners.forEach((fn) => fn(pageNum));
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') console.error('render error', err);
      releaseCanvas(canvas);
    } finally {
      // Only clear our own task — a cancelled older render settling late must
      // not wipe the reference to the newer one that replaced it.
      if (entry.rendering === task) entry.rendering = null;
    }
  }

  /** Render the selectable/searchable text layer over a page's canvas. */
  private async renderTextLayer(entry: PageEntry, page: PDFPageProxy, viewport: any): Promise<void> {
    if (entry.textLayerRendered) return;
    entry.textLayerDiv.replaceChildren();
    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: false }),
      container: entry.textLayerDiv,
      viewport,
    });
    await textLayer.render();
    guardTextLayer(entry.textLayerDiv); // smooth selection across span gaps
    entry.textDivs = textLayer.textDivs as HTMLElement[];
    entry.textItems = textLayer.textContentItemsStr;
    entry.textLayerRendered = true;
    this.textCache.set(Number(entry.el.dataset.page), entry.textItems);
  }

  private renderTimer: number | undefined;

  /** Invalidate all cached renders (after zoom / rotation / layout change).
   *  The layout (box sizes + scroll anchor) updates immediately; with
   *  `debounceMs` the crisp re-render waits until a zoom gesture settles, so a
   *  burst of Ctrl+wheel / pinch events doesn't re-rasterise every frame. */
  private async rerenderAll(debounceMs = 0, at?: { x: number; y: number }): Promise<void> {
    // Anchor the viewport: remember which point of which page sits under the
    // anchor (viewport centre, or the cursor for Ctrl+wheel) so a zoom keeps
    // that spot still instead of drifting or jumping to the top.
    if (this.scrollRaf != null) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = null;
    }
    this.cancelZoomFx();
    const anchor = this.captureAnchor(at);

    for (const e of this.entries) {
      if (!e) continue;
      e.gen++;
      e.pending = null;
      e.rendering?.cancel();
      e.rendering = null;
      e.rendered = false;
      e.textLayerRendered = false;
      e.textLayerDiv.replaceChildren();
    }
    await this.presize();

    // Restore the anchored position before deciding what's visible.
    if (this.state.layout !== 'single') this.restoreAnchor(anchor);
    // Re-render every page in view (the observer won't re-fire for pages that
    // were already intersecting before the zoom).
    const render = () =>
      this.state.layout === 'single' ? this.renderPage(this.state.page) : this.renderVisiblePages();
    clearTimeout(this.renderTimer);
    if (debounceMs > 0) {
      this.renderTimer = window.setTimeout(() => void render(), debounceMs);
    } else {
      await render();
    }
    this.emit();
  }

  /** Render all pages whose element currently overlaps the scroll viewport. */
  private async renderVisiblePages(): Promise<void> {
    const cr = this.container.getBoundingClientRect();
    const jobs: Promise<void>[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (!e) continue;
      const r = e.el.getBoundingClientRect();
      if (r.bottom >= cr.top - 300 && r.top <= cr.bottom + 300) jobs.push(this.renderPage(i + 1));
    }
    await Promise.all(jobs);
  }

  /** Resolve the scale actually used, honoring fit modes against the viewport. */
  private async effectiveScale(): Promise<number> {
    if (!this.doc) return this.state.scale;
    // 'actual' = manual zoom: use whatever scale the user set (NOT a reset to 1).
    if (this.state.fit === 'actual') return this.state.scale;
    const page = await this.doc.getPage(this.state.page || 1);
    const unit = page.getViewport({ scale: 1, rotation: this.state.rotation });
    return (this.state.scale = this.fitFor(unit.width, unit.height));
    return this.state.scale;
  }

  // ---- Public controls (wired to commands) ------------------------------

  async goToPage(n: number): Promise<void> {
    if (!this.doc) return;
    const page = Math.min(Math.max(1, Math.round(n)), this.state.pageCount);
    this.state.page = page;
    if (this.state.layout === 'single') {
      this.applySinglePageVisibility();
      await this.renderPage(page);
    } else {
      // Honor the smoothScroll setting (the container carries a `.smooth` class)
      // so disabling it makes page jumps instant everywhere, not just on wheel.
      const behavior: ScrollBehavior = this.container.classList.contains('smooth') ? 'smooth' : 'auto';
      this.entries[page - 1]?.el.scrollIntoView({ behavior, block: 'start' });
      await this.renderPage(page);
    }
    this.emit();
  }

  /**
   * Resolve a PDF destination (named string or explicit array, as found in the
   * outline) to a 1-based page and, when the destination specifies one, the
   * target's distance from the page top in PDF points (unrotated).
   */
  async resolveDestination(dest: unknown): Promise<{ page: number; top: number | null } | null> {
    if (!this.doc || dest == null) return null;
    try {
      const explicit: any[] | null = typeof dest === 'string' ? await this.doc.getDestination(dest) : (dest as any[]);
      if (!Array.isArray(explicit) || explicit.length === 0) return null;
      const ref = explicit[0];
      const index = typeof ref === 'number' ? ref : await this.doc.getPageIndex(ref);
      const page = index + 1;
      const kind = explicit[1]?.name;
      const pdfTop =
        kind === 'XYZ' ? explicit[3] : kind === 'FitH' || kind === 'FitBH' ? explicit[2] : kind === 'FitR' ? explicit[5] : null;
      if (typeof pdfTop !== 'number') return { page, top: null };
      const p = this.entries[index]?.page ?? (await this.doc.getPage(page));
      const vp = p.getViewport({ scale: 1, rotation: 0 });
      return { page, top: Math.max(0, vp.convertToViewportPoint(0, pdfTop)[1]) };
    } catch {
      return null;
    }
  }

  /** Jump to an outline/link destination, scrolling to the exact heading when known. */
  async goToDestination(dest: unknown): Promise<void> {
    const target = await this.resolveDestination(dest);
    if (!target) return;
    const entry = this.entries[target.page - 1];
    if (this.state.layout === 'single' || target.top == null || this.state.rotation !== 0 || !entry) {
      return this.goToPage(target.page);
    }
    this.state.page = target.page;
    const scale = await this.effectiveScale();
    const pageTop = entry.el.getBoundingClientRect().top - this.container.getBoundingClientRect().top + this.container.scrollTop;
    const behavior: ScrollBehavior = this.container.classList.contains('smooth') ? 'smooth' : 'auto';
    this.container.scrollTo({ top: Math.max(0, pageTop + target.top * scale - 12), behavior });
    await this.renderPage(target.page);
    this.emit();
  }

  nextPage(): Promise<void> {
    const step = this.state.layout === 'two-page' ? 2 : 1;
    return this.goToPage(this.state.page + step);
  }
  prevPage(): Promise<void> {
    const step = this.state.layout === 'two-page' ? 2 : 1;
    return this.goToPage(this.state.page - step);
  }
  firstPage(): Promise<void> {
    return this.goToPage(1);
  }
  lastPage(): Promise<void> {
    return this.goToPage(this.state.pageCount);
  }

  private scrollRaf: number | null = null;
  private scrollTarget = 0;

  scrollBy(delta: number): void {
    const smooth = this.container.classList.contains('smooth');
    if (!smooth) {
      if (this.scrollRaf != null) {
        cancelAnimationFrame(this.scrollRaf);
        this.scrollRaf = null;
      }
      this.container.scrollTop += delta;
      return;
    }
    // Custom rAF tween — CSS `scroll-behavior: smooth` is ignored under
    // prefers-reduced-motion and some engines treat programmatic scrolls as
    // instant, which made arrow keys jump. Animating ourselves guarantees a
    // glide and lets rapid key presses accumulate onto the in-flight target.
    const maxTop = this.container.scrollHeight - this.container.clientHeight;
    const base = this.scrollRaf != null ? this.scrollTarget : this.container.scrollTop;
    this.scrollTarget = Math.max(0, Math.min(maxTop, base + delta));
    this.animateScroll();
  }

  private animateScroll(): void {
    const el = this.container;
    const start = el.scrollTop;
    const dist = this.scrollTarget - start;
    if (Math.abs(dist) < 1) {
      el.scrollTop = this.scrollTarget;
      this.scrollRaf = null;
      return;
    }
    const dur = Math.min(450, 130 + Math.abs(dist) * 0.45);
    const t0 = performance.now();
    const ease = (p: number) => 1 - Math.pow(1 - p, 3); // easeOutCubic
    if (this.scrollRaf != null) cancelAnimationFrame(this.scrollRaf);
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      el.scrollTop = start + dist * ease(p);
      if (p < 1) {
        this.scrollRaf = requestAnimationFrame(step);
      } else {
        el.scrollTop = this.scrollTarget;
        this.scrollRaf = null;
      }
    };
    this.scrollRaf = requestAnimationFrame(step);
  }

  /**
   * Zoom to `scale`, anchored on `at` (the cursor for Ctrl+wheel / pinch) or
   * the viewport centre. Buttons/keys animate; gestures follow the fingers.
   */
  async setZoom(scale: number, opts: { animate?: boolean; at?: { x: number; y: number } } = {}): Promise<void> {
    this.state.fit = 'actual';
    this.state.scale = clamp(scale);
    this.zoomTo(this.state.scale, { animate: !!opts.animate, at: opts.at });
  }
  zoomIn(): Promise<void> {
    return this.setZoom(this.state.scale * ZOOM_STEP, { animate: true });
  }
  zoomOut(): Promise<void> {
    return this.setZoom(this.state.scale / ZOOM_STEP, { animate: true });
  }
  /** 100% — the PDF's own size. */
  actualSize(): Promise<void> {
    return this.setZoom(1, { animate: true });
  }

  async setFit(fit: FitMode): Promise<void> {
    this.state.fit = fit;
    const target = await this.effectiveScale();
    this.zoomTo(target, { animate: true });
  }

  // ---- Zoom animation ----------------------------------------------------
  //
  // A zoom is shown as a CSS `transform: scale()` on the page container,
  // which the compositor animates on the GPU without re-laying-out or
  // re-painting anything — so it stays fluid on weak hardware. Only when the
  // zoom settles is it "committed": the transform is dropped and, in the same
  // frame, the real page boxes are resized around the same anchor point,
  // followed by one crisp re-render. Rapid presses / wheel bursts just
  // retarget the running transform.

  private animating = false;
  private animToken = 0;
  private fx: { from: number; target: number; at: { x: number; y: number }; timer?: number } | null = null;

  private zoomTo(target: number, opts: { animate: boolean; at?: { x: number; y: number } }): void {
    if (!this.doc || !this.entries.length) return;
    const smooth = this.container.classList.contains('smooth');
    const animate = opts.animate && smooth;
    if (!this.fx) {
      if (Math.abs(target - this.shownScale) < 1e-4) return;
      if (this.scrollRaf != null) {
        cancelAnimationFrame(this.scrollRaf);
        this.scrollRaf = null;
      }
      const cr = this.container.getBoundingClientRect();
      const at = opts.at ?? { x: cr.left + this.container.clientWidth / 2, y: cr.top + this.container.clientHeight / 2 };
      const box = this.content.getBoundingClientRect();
      // Pages that fit the width stay centred; wider ones zoom about the anchor.
      const fits = this.container.scrollWidth <= this.container.clientWidth + 1;
      const ox = fits ? box.width / 2 : at.x - box.left;
      const oy = at.y - box.top;
      this.content.style.transformOrigin = `${ox}px ${oy}px`;
      this.fx = { from: this.shownScale, target, at: { x: box.left + ox, y: at.y } };
      this.animating = true;
      this.content.classList.add('zooming');
    }
    this.fx.target = target;
    this.content.style.transition = animate ? `transform ${ZOOM_ANIM_MS}ms cubic-bezier(0.22, 0.8, 0.24, 1)` : 'none';
    this.content.style.transform = `scale(${target / this.fx.from})`;
    clearTimeout(this.fx.timer);
    this.fx.timer = window.setTimeout(() => this.commitZoom(), animate ? ZOOM_ANIM_MS + 30 : ZOOM_SETTLE_MS);
  }

  /** Swap the GPU preview for the real layout (same frame), then re-render crisply. */
  private commitZoom(): void {
    const fx = this.fx;
    if (!fx) return;
    this.cancelZoomFx();
    const anchor = this.captureAnchor(fx.at); // untransformed layout, same content point
    this.applyScaleSync(fx.target);
    if (this.state.layout !== 'single') this.restoreAnchor(anchor);
    void this.rerenderAll(0, fx.at);
  }

  /** Drop an in-flight transform zoom without committing it. */
  private cancelZoomFx(): void {
    if (!this.fx) return;
    clearTimeout(this.fx.timer);
    this.fx = null;
    this.content.style.transition = 'none';
    this.content.style.transform = '';
    this.content.classList.remove('zooming');
    this.animating = false;
  }

  /**
   * Animate a change of the scroller's size (e.g. the sidebar opening) the
   * cheap way — FLIP: run `mutate` (which changes the size instantly), lay the
   * pages out ONCE at their final fit, then play the difference back as a
   * single compositor transform from where the pages were to where they are.
   * No per-frame relayout, no transient horizontal scrollbar; one crisp
   * re-render at the end.
   */
  async flipResize(mutate: () => void, durationMs: number): Promise<void> {
    if (!this.doc || !this.entries.length || !this.container.classList.contains('smooth')) {
      mutate();
      if (this.doc) await this.handleResize();
      return;
    }
    this.cancelZoomFx();
    const anchor = this.captureAnchor();
    const ref = anchor?.el;
    const r0 = ref?.getBoundingClientRect();
    mutate();
    if (this.state.fit !== 'actual') {
      const s = this.fitScaleSync();
      if (s != null) {
        this.state.scale = s;
        this.applyScaleSync(s);
      }
    }
    if (anchor && this.state.layout !== 'single') {
      const cr = this.container.getBoundingClientRect();
      this.restoreAnchor({ ...anchor, x: cr.left + this.container.clientWidth / 2, y: cr.top + this.container.clientHeight / 2 });
    }
    const token = ++this.animToken;
    if (ref && r0) {
      const r1 = ref.getBoundingClientRect();
      const c1 = this.content.getBoundingClientRect();
      const k = r1.width > 0 ? r0.width / r1.width : 1;
      const tx = r0.left - c1.left - k * (r1.left - c1.left);
      const ty = r0.top - c1.top - k * (r1.top - c1.top);
      const el = this.content;
      el.classList.add('zooming');
      el.style.transition = 'none';
      el.style.transformOrigin = '0 0';
      el.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
      void el.offsetWidth; // commit the "before" pose
      this.animating = true;
      el.style.transition = `transform ${durationMs}ms cubic-bezier(0.22, 0.8, 0.24, 1)`;
      el.style.transform = '';
      await new Promise((r) => setTimeout(r, durationMs + 30));
      if (token !== this.animToken) return;
      el.style.transition = '';
      el.classList.remove('zooming');
      this.animating = false;
    }
    await this.rerenderAll();
    this.emit();
  }

  /** Fit scale for the current container size, from the cached page proxy. */
  private fitScaleSync(): number | null {
    const page = this.entries[(this.state.page || 1) - 1]?.page;
    if (!page) return null;
    const unit = page.getViewport({ scale: 1, rotation: this.state.rotation });
    return this.fitFor(unit.width, unit.height);
  }

  /** Scale for the current fit mode given an unscaled page size. */
  private fitFor(w: number, h: number): number {
    const pad = 32;
    const availH = this.container.clientHeight - pad;
    const twoUp = this.state.layout === 'two-page';
    const availW = twoUp ? (this.container.clientWidth - pad - SPREAD_GAP) / 2 : this.container.clientWidth - pad;
    if (this.state.fit === 'width') return clamp(availW / w);
    if (this.state.fit === 'height') return clamp(availH / h);
    if (this.state.fit === 'page') return clamp(Math.min(availW / w, availH / h));
    return this.state.scale;
  }

  /** Synchronous presize at an explicit scale (one animation frame). */
  private applyScaleSync(scale: number): void {
    const dpr = window.devicePixelRatio || 1;
    for (const entry of this.entries) {
      if (!entry?.page) continue;
      const vp = entry.page.getViewport({ scale, rotation: this.state.rotation });
      const box = pixelBox(vp.width, vp.height, dpr);
      this.applyBox(entry, box);
      entry.canvas.style.width = box.cssW;
      entry.canvas.style.height = box.cssH;
      entry.el.style.setProperty('--scale-factor', String(scale));
    }
    this.shownScale = scale;
    this.updateSpreadWidths();
  }

  /** Which page point is under the anchor (viewport centre by default). */
  private captureAnchor(at?: { x: number; y: number }): { el: HTMLElement; fx: number; fy: number; x: number; y: number } | null {
    const cr = this.container.getBoundingClientRect();
    const x = at?.x ?? cr.left + this.container.clientWidth / 2;
    const y = at?.y ?? cr.top + this.container.clientHeight / 2;
    let best: { el: HTMLElement; d: number } | null = null;
    for (const e of this.entries) {
      if (!e || e.el.style.display === 'none') continue;
      const r = e.el.getBoundingClientRect();
      if (r.bottom < cr.top - 2000 || r.top > cr.bottom + 2000) continue;
      const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (!best || d < best.d) best = { el: e.el, d };
      if (d === 0) break;
    }
    if (!best) return null;
    const r = best.el.getBoundingClientRect();
    return { el: best.el, fx: (x - r.left) / (r.width || 1), fy: (y - r.top) / (r.height || 1), x, y };
  }

  private restoreAnchor(a: ReturnType<PDFViewer['captureAnchor']>): void {
    if (!a) return;
    const r = a.el.getBoundingClientRect();
    this.container.scrollTop += r.top + a.fy * r.height - a.y;
    this.container.scrollLeft += r.left + a.fx * r.width - a.x;
  }

  async rotate(deltaDeg: number): Promise<void> {
    this.state.rotation = (((this.state.rotation + deltaDeg) % 360) + 360) % 360;
    await this.rerenderAll();
  }

  async setLayout(layout: LayoutMode): Promise<void> {
    this.state.layout = layout;
    await this.buildLayout();
    await this.goToPage(this.state.page);
    this.emit();
  }

  cycleLayout(): Promise<void> {
    const order: LayoutMode[] = ['single', 'two-page', 'continuous'];
    const next = order[(order.indexOf(this.state.layout) + 1) % order.length];
    return this.setLayout(next);
  }

  private applySinglePageVisibility(): void {
    this.entries.forEach((e, i) => {
      if (e) e.el.style.display = i === this.state.page - 1 ? '' : 'none';
    });
  }

  getDocument(): PDFDocumentProxy | null {
    return this.doc;
  }

  // ---- Text / search hooks ---------------------------------------------

  /** Fired each time a page's text layer finishes rendering. */
  onPageRendered(fn: (pageNum: number) => void): () => void {
    this.pageRenderedListeners.add(fn);
    return () => this.pageRenderedListeners.delete(fn);
  }

  /** Rendered text spans + item strings for a page, or null if not yet rendered. */
  getTextLayer(pageNum: number): PageTextLayer | null {
    const e = this.entries[pageNum - 1];
    return e?.textLayerRendered ? { divs: e.textDivs, items: e.textItems } : null;
  }

  /** Per-item text strings for a page (cached). Cheap — used to find matches. */
  async getPageItems(pageNum: number): Promise<string[]> {
    const cached = this.textCache.get(pageNum);
    if (cached) return cached;
    const { items } = await this.getPageTextItems(pageNum);
    const strs = items.map((it) => it.str);
    this.textCache.set(pageNum, strs);
    return strs;
  }

  /**
   * Text items with geometry (unrotated, scale 1, top-left origin), index-aligned
   * with the text layer's spans. Used by TTS to tell prose from chart labels,
   * tables, running headers and page numbers.
   */
  private geomCache = new Map<number, PageTextGeometry>();
  async getPageTextItems(pageNum: number): Promise<PageTextGeometry> {
    const cached = this.geomCache.get(pageNum);
    if (cached) return cached;
    if (!this.doc) return { items: [], width: 0, height: 0 };
    const page = this.entries[pageNum - 1]?.page ?? (await this.doc.getPage(pageNum));
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    const tc = await page.getTextContent({ includeMarkedContent: false });
    const items: PageTextItem[] = [];
    for (const it of tc.items as any[]) {
      if (typeof it.str !== 'string') continue; // marked content (not in the text layer either)
      const tr: number[] = it.transform ?? [1, 0, 0, 1, 0, 0];
      const [x, baseline] = vp.convertToViewportPoint(tr[4], tr[5]);
      const h = Math.abs(it.height) || Math.hypot(tr[2], tr[3]) || 0;
      items.push({ str: it.str, hasEOL: !!it.hasEOL, x, y: baseline - h, w: Math.abs(it.width) || 0, h });
    }
    const geom = { items, width: vp.width, height: vp.height };
    this.geomCache.set(pageNum, geom);
    return geom;
  }

  /** Scroll a page into view and ensure its canvas + text layer are rendered. */
  async ensurePageRendered(pageNum: number): Promise<void> {
    const entry = this.entries[pageNum - 1];
    if (!entry) return;
    if (this.state.layout === 'single') {
      this.state.page = pageNum;
      this.applySinglePageVisibility();
    }
    await this.renderPage(pageNum);
  }

  getPageEl(pageNum: number): HTMLElement | undefined {
    return this.entries[pageNum - 1]?.el;
  }

  /** Unscaled (scale=1, rotation=0) page size in PDF points — the coordinate
   *  space annotations are stored in so they survive zoom. */
  private sizeCache = new Map<number, { width: number; height: number }>();
  async getPageSize(pageNum: number): Promise<{ width: number; height: number }> {
    const cached = this.sizeCache.get(pageNum);
    if (cached) return cached;
    const page = this.entries[pageNum - 1]?.page ?? (await this.doc!.getPage(pageNum));
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    const size = { width: vp.width, height: vp.height };
    this.sizeCache.set(pageNum, size);
    return size;
  }

  /** Stable per-document id for persisting annotations. */
  fingerprint(): string {
    return this.doc?.fingerprints?.[0] ?? 'unknown';
  }

  /**
   * Bounding boxes (fractions of the unrotated page) of every raster image on a
   * page, found by replaying the operator list and tracking the transform. Used
   * by dark mode to re-invert image areas so photos aren't shown as negatives.
   */
  private imageCache = new Map<number, Array<{ x: number; y: number; w: number; h: number }>>();
  async getImageRegions(pageNum: number): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
    const cached = this.imageCache.get(pageNum);
    if (cached) return cached;
    if (!this.doc) return [];
    const page = await this.doc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    const ops = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    const mul = pdfjsLib.Util.transform;
    let ctm: number[] = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    const regions: Array<{ x: number; y: number; w: number; h: number }> = [];
    const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);

    for (let i = 0; i < ops.fnArray.length; i++) {
      const fn = ops.fnArray[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, ops.argsArray[i] as number[]);
      else if (imageOps.has(fn)) {
        // images draw a unit square under the current transform
        const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => {
          const ux = ctm[0] * x + ctm[2] * y + ctm[4];
          const uy = ctm[1] * x + ctm[3] * y + ctm[5];
          return vp.convertToViewportPoint(ux, uy);
        });
        const xs = corners.map((p) => p[0]);
        const ys = corners.map((p) => p[1]);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        if (maxX - minX > 2 && maxY - minY > 2) {
          regions.push({ x: minX / vp.width, y: minY / vp.height, w: (maxX - minX) / vp.width, h: (maxY - minY) / vp.height });
        }
      }
    }
    this.imageCache.set(pageNum, regions);
    return regions;
  }

  /** Re-fit on container resize (debounced by the caller). `force` re-renders
   *  regardless of fit mode — used when devicePixelRatio changes (browser zoom,
   *  or the window moving to a monitor with different scaling). */
  async handleResize(force = false): Promise<void> {
    if (force || this.state.fit !== 'actual') {
      await this.rerenderAll();
    }
  }
}

function clamp(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}
