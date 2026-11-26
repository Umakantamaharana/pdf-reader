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
  page?: PDFPageProxy;
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

export class PDFViewer {
  private container: HTMLElement;
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
    this.container.innerHTML = '';
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
        this.container.appendChild(row);
      }
    } else {
      for (let i = 1; i <= count; i++) {
        const e = makeEntry(i);
        this.entries[i - 1] = e;
        this.container.appendChild(e.el);
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
    await Promise.all(
      this.entries.map(async (entry, i) => {
        if (!entry) return;
        const page = entry.page ?? (await this.doc!.getPage(i + 1));
        entry.page = page;
        const vp = page.getViewport({ scale: effScale, rotation: this.state.rotation });
        entry.el.style.width = `${Math.floor(vp.width)}px`;
        entry.el.style.height = `${Math.floor(vp.height)}px`;
      }),
    );
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

  /** Render a single page to its canvas at device pixel ratio. Idempotent. */
  private async renderPage(pageNum: number): Promise<void> {
    if (!this.doc) return;
    const entry = this.entries[pageNum - 1];
    if (!entry || entry.rendered || entry.rendering) return;

    const page = entry.page ?? (await this.doc.getPage(pageNum));
    entry.page = page;
    const effScale = await this.effectiveScale();
    const dpr = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: effScale, rotation: this.state.rotation });

    const canvas = entry.canvas;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    entry.el.style.width = `${Math.floor(viewport.width)}px`;
    entry.el.style.height = `${Math.floor(viewport.height)}px`;

    // The text layer positions its spans using the --scale-factor CSS variable.
    entry.el.style.setProperty('--scale-factor', String(effScale));

    const ctx = canvas.getContext('2d', { alpha: false })!;
    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    entry.rendering = task;
    try {
      await task.promise;
      entry.rendered = true;
      await this.renderTextLayer(entry, page, viewport);
      this.pageRenderedListeners.forEach((fn) => fn(pageNum));
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') console.error('render error', err);
    } finally {
      entry.rendering = null;
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
    entry.textDivs = textLayer.textDivs as HTMLElement[];
    entry.textItems = textLayer.textContentItemsStr;
    entry.textLayerRendered = true;
    this.textCache.set(Number(entry.el.dataset.page), entry.textItems);
  }

  /** Invalidate all cached renders (after zoom / rotation / layout change). */
  private async rerenderAll(): Promise<void> {
    // Anchor the viewport: remember where we are as a fraction of the scrollable
    // range so a zoom keeps the same place instead of jumping to the top.
    const el = this.container;
    if (this.scrollRaf != null) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = null;
    }
    const prevMax = el.scrollHeight - el.clientHeight;
    const ratio = prevMax > 0 ? el.scrollTop / prevMax : 0;

    for (const e of this.entries) {
      if (!e) continue;
      e.rendering?.cancel();
      e.rendering = null;
      e.rendered = false;
      e.textLayerRendered = false;
      e.textLayerDiv.replaceChildren();
    }
    await this.presize();

    if (this.state.layout === 'single') {
      await this.renderPage(this.state.page);
    } else {
      // Restore the anchored position before deciding what's visible, then
      // re-render every page in view (the observer won't re-fire for pages that
      // were already intersecting before the zoom).
      const newMax = el.scrollHeight - el.clientHeight;
      el.scrollTop = ratio * newMax;
      await this.renderVisiblePages();
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
    const pad = 32;
    const availH = this.container.clientHeight - pad;
    // In two-page mode a single page gets half the width minus the spread gap.
    const twoUp = this.state.layout === 'two-page';
    const spreadGap = 12;
    const availW = twoUp
      ? (this.container.clientWidth - pad - spreadGap) / 2
      : this.container.clientWidth - pad;
    if (this.state.fit === 'width') return (this.state.scale = clamp(availW / unit.width));
    if (this.state.fit === 'page') return (this.state.scale = clamp(Math.min(availW / unit.width, availH / unit.height)));
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

  async setZoom(scale: number): Promise<void> {
    this.state.fit = 'actual';
    this.state.scale = clamp(scale);
    await this.rerenderAll();
  }
  zoomIn(): Promise<void> {
    return this.setZoom(this.state.scale * 1.15);
  }
  zoomOut(): Promise<void> {
    return this.setZoom(this.state.scale / 1.15);
  }

  async setFit(fit: FitMode): Promise<void> {
    this.state.fit = fit;
    await this.rerenderAll();
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
    if (!this.doc) return [];
    const page = await this.doc.getPage(pageNum);
    const tc = await page.getTextContent({ includeMarkedContent: false });
    const items = tc.items.map((it: any) => (typeof it.str === 'string' ? it.str : ''));
    this.textCache.set(pageNum, items);
    return items;
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

  /** Re-fit on container resize (debounced by the caller). */
  async handleResize(): Promise<void> {
    if (this.state.fit === 'width' || this.state.fit === 'page' || this.state.fit === 'auto') {
      await this.rerenderAll();
    }
  }
}

function clamp(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}
