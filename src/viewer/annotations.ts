/**
 * annotations.ts — Annotation layer + middle-click eraser.
 *
 * Tools: text highlight / underline / strikethrough (from the text layer
 * selection), freehand pen, rectangle, and arrow. Sticky notes, text boxes,
 * stamps, and pdf-lib export are wired in the next sub-step.
 *
 * Coordinate model (scale-independent, so annotations survive zoom with no
 * re-render): text marks store page-relative fractions [0..1]; vector strokes
 * store PDF points against an SVG `viewBox="0 0 W H"`. Both layers are sized to
 * the page element, so a browser zoom just rescales them.
 *
 * Middle mouse button = instant eraser. Holding the wheel button and dragging
 * deletes any stroke/mark it passes over, without leaving the current tool —
 * globally when enabled in settings, otherwise only in annotation mode.
 */

import { PDFViewer } from './pdfViewer';
import { settings } from '../core/settings';

const SVGNS = 'http://www.w3.org/2000/svg';

export type AnnotTool =
  | 'none' | 'highlight' | 'underline' | 'strike' | 'pen' | 'rectangle' | 'ellipse' | 'arrow'
  | 'note' | 'textbox' | 'stamp' | 'eraser';

interface FracRect { x: number; y: number; w: number; h: number } // 0..1 of page
interface Pt { x: number; y: number } // PDF points
interface Box { x: number; y: number; w: number; h: number } // PDF points

type Annot =
  | { id: string; page: number; type: 'highlight' | 'underline' | 'strike'; color: string; opacity: number; rects: FracRect[] }
  | { id: string; page: number; type: 'pen'; color: string; width: number; points: Pt[] }
  | { id: string; page: number; type: 'rectangle'; color: string; width: number; box: Box }
  | { id: string; page: number; type: 'ellipse'; color: string; width: number; box: Box }
  | { id: string; page: number; type: 'arrow'; color: string; width: number; from: Pt; to: Pt }
  | { id: string; page: number; type: 'note'; color: string; at: Pt; text: string }
  | { id: string; page: number; type: 'textbox'; color: string; at: Pt; text: string; fontPts: number }
  | { id: string; page: number; type: 'stamp'; box: Box; dataUrl: string };

interface Overlay { rot: HTMLDivElement; hl: HTMLDivElement; svg: SVGSVGElement; dom: HTMLDivElement; pageW: number; pageH: number }

type UndoOp = { kind: 'add'; annots: Annot[] } | { kind: 'del'; annots: Annot[] };

export class AnnotationManager {
  private pdf: PDFViewer;
  private toast: (m: string) => void;

  private annots: Annot[] = [];
  private overlays = new Map<number, Overlay>();
  private undoStack: UndoOp[] = [];
  private redoStack: UndoOp[] = [];

  private active = false;
  private tool: AnnotTool = 'none';
  private idSeq = 0;
  private saveTimer: number | undefined;

  // drawing gesture state
  private drawing: { pageNum: number; annot: Annot; preview: SVGElement; origin: Pt } | null = null;
  // erasing gesture state
  private erasing: { deleted: Annot[] } | null = null;
  // stamp image awaiting placement
  private pendingStamp: { dataUrl: string; aspect: number } | null = null;

  constructor(pdf: PDFViewer, toast: (m: string) => void = () => {}) {
    this.pdf = pdf;
    this.toast = toast;
    this.tool = settings.get<AnnotTool>('annotation.defaultTool') as AnnotTool;

    // Re-attach overlays whenever a page (re)renders (e.g. after a layout change).
    this.pdf.onPageRendered((pageNum) => void this.renderPage(pageNum));

    // Middle-button eraser works even outside the per-page SVG, so listen high up.
    window.addEventListener('pointerdown', this.onGlobalPointerDown, true);
    window.addEventListener('pointermove', this.onGlobalPointerMove, true);
    window.addEventListener('pointerup', this.onGlobalPointerUp, true);
    // Suppress the browser's middle-click autoscroll puck.
    window.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    window.addEventListener('mousedown', (e) => { if (e.button === 1 && this.middleEraserAllowed()) e.preventDefault(); });

    // Text marks are captured on mouseup when a text tool is active.
    document.addEventListener('mouseup', () => this.captureSelectionMark());
  }

  /** Load persisted annotations for the current document and paint them. */
  async load(): Promise<void> {
    const key = this.storageKey();
    const data = await new Promise<any>((res) => chrome.storage.local.get(key, (r) => res(r?.[key])));
    this.annots = Array.isArray(data) ? data : [];
    this.idSeq = this.annots.reduce((max, a) => Math.max(max, Number(a.id.split('-')[1]) || 0), 0);
    for (let p = 1; p <= this.pdf.state.pageCount; p++) void this.renderPage(p);
  }

  // ---- Mode & tool ------------------------------------------------------

  toggleMode(): void {
    this.active = !this.active;
    this.applyInteractivity();
    document.body.classList.toggle('annot-active', this.active);
    if (!this.active) document.body.classList.remove('annot-eraser');
    this.emitTool();
    this.toast(this.active ? 'Annotation mode on' : 'Annotation mode off');
  }

  setTool(tool: AnnotTool): void {
    this.active = true;
    this.tool = tool;
    document.body.classList.add('annot-active');
    document.body.classList.toggle('annot-eraser', tool === 'eraser');
    this.applyInteractivity();
    this.emitTool();
    this.toast(`Tool: ${tool}`);
  }

  isActive(): boolean {
    return this.active;
  }

  getTool(): AnnotTool {
    return this.tool;
  }

  private toolListeners = new Set<(tool: AnnotTool, active: boolean) => void>();
  onToolChange(cb: (tool: AnnotTool, active: boolean) => void): () => void {
    this.toolListeners.add(cb);
    return () => this.toolListeners.delete(cb);
  }
  private emitTool(): void {
    this.toolListeners.forEach((cb) => cb(this.tool, this.active));
  }

  /** Settings dot-path whose color the given tool draws with. */
  colorPathForTool(tool: AnnotTool = this.tool): string | null {
    if (['highlight', 'underline', 'strike'].includes(tool)) return 'annotation.highlightColor';
    if (tool === 'pen') return 'annotation.penColor';
    if (['rectangle', 'ellipse', 'arrow'].includes(tool)) return 'annotation.shapeColor';
    if (tool === 'note') return 'annotation.highlightColor';
    if (tool === 'textbox') return 'annotation.penColor';
    return null;
  }

  /** Decide which layer should receive pointer events for the current tool. */
  private applyInteractivity(): void {
    // Tools that draw/place on the page capture the pointer via the SVG layer.
    const capturing = this.active && ['pen', 'rectangle', 'ellipse', 'arrow', 'eraser', 'note', 'textbox', 'stamp'].includes(this.tool);
    for (const [pageNum, ov] of this.overlays) {
      ov.svg.style.pointerEvents = capturing ? 'auto' : 'none';
      const tl = this.pdf.getPageEl(pageNum)?.querySelector('.textLayer') as HTMLElement | null;
      // text-mark tools need selectable text; capturing tools must not select text
      if (tl) tl.style.pointerEvents = capturing ? 'none' : '';
    }
  }

  // ---- Overlay creation & rendering ------------------------------------

  private async ensureOverlay(pageNum: number): Promise<Overlay | null> {
    const el = this.pdf.getPageEl(pageNum);
    if (!el) return null;
    let ov = this.overlays.get(pageNum);
    if (ov && el.contains(ov.rot)) return ov;

    const { width: pageW, height: pageH } = await this.pdf.getPageSize(pageNum);
    // Page dimensions drive the rotation wrapper's CSS sizing.
    el.style.setProperty('--page-w', String(pageW));
    el.style.setProperty('--page-h', String(pageH));

    // Wrapper is sized to the UNROTATED page and rotated by CSS to align with
    // the rotated canvas, so annotation coords stay rotation-independent.
    const rot = document.createElement('div');
    rot.className = 'annot-rot';
    const hl = document.createElement('div');
    hl.className = 'annot-hl';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'annot-svg');
    svg.setAttribute('viewBox', `0 0 ${pageW} ${pageH}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const dom = document.createElement('div');
    dom.className = 'annot-dom';
    rot.append(hl, svg, dom);
    el.appendChild(rot);

    ov = { rot, hl, svg, dom, pageW, pageH };
    this.overlays.set(pageNum, ov);
    this.wireSvgDrawing(pageNum, ov);
    this.applyInteractivity();
    return ov;
  }

  private async renderPage(pageNum: number): Promise<void> {
    const ov = await this.ensureOverlay(pageNum);
    if (!ov) return;
    ov.rot.dataset.rot = String(this.pdf.state.rotation); // keep aligned with the canvas
    ov.hl.replaceChildren();
    ov.svg.replaceChildren();
    ov.dom.replaceChildren();
    for (const a of this.annots) {
      if (a.page !== pageNum) continue;
      this.renderAnnot(ov, a);
    }
  }

  private renderAnnot(ov: Overlay, a: Annot): void {
    if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') {
      for (const r of a.rects) {
        const d = document.createElement('div');
        d.className = `mark mark-${a.type}`;
        d.style.left = `${r.x * 100}%`;
        d.style.width = `${r.w * 100}%`;
        if (a.type === 'highlight') {
          d.style.top = `${r.y * 100}%`;
          d.style.height = `${r.h * 100}%`;
          d.style.background = a.color;
          d.style.opacity = String(a.opacity);
        } else {
          const yLine = a.type === 'underline' ? r.y + r.h : r.y + r.h / 2;
          d.style.top = `${yLine * 100}%`;
          d.style.height = `2px`;
          d.style.marginTop = a.type === 'underline' ? '-2px' : '-1px';
          d.style.background = a.color;
        }
        d.dataset.id = a.id;
        ov.hl.appendChild(d);
      }
    } else if (a.type === 'pen') {
      const pl = document.createElementNS(SVGNS, 'polyline');
      pl.setAttribute('points', a.points.map((p) => `${p.x},${p.y}`).join(' '));
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', a.color);
      pl.setAttribute('stroke-width', String(a.width));
      pl.setAttribute('stroke-linecap', 'round');
      pl.setAttribute('stroke-linejoin', 'round');
      pl.dataset.id = a.id;
      ov.svg.appendChild(pl);
    } else if (a.type === 'rectangle') {
      const r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('x', String(a.box.x));
      r.setAttribute('y', String(a.box.y));
      r.setAttribute('width', String(a.box.w));
      r.setAttribute('height', String(a.box.h));
      r.setAttribute('fill', 'none');
      r.setAttribute('stroke', a.color);
      r.setAttribute('stroke-width', String(a.width));
      r.dataset.id = a.id;
      ov.svg.appendChild(r);
    } else if (a.type === 'ellipse') {
      const e = document.createElementNS(SVGNS, 'ellipse');
      e.setAttribute('cx', String(a.box.x + a.box.w / 2));
      e.setAttribute('cy', String(a.box.y + a.box.h / 2));
      e.setAttribute('rx', String(a.box.w / 2));
      e.setAttribute('ry', String(a.box.h / 2));
      e.setAttribute('fill', 'none');
      e.setAttribute('stroke', a.color);
      e.setAttribute('stroke-width', String(a.width));
      e.dataset.id = a.id;
      ov.svg.appendChild(e);
    } else if (a.type === 'arrow') {
      ov.svg.appendChild(this.arrowPath(a));
    } else if (a.type === 'note') {
      const m = document.createElement('div');
      m.className = 'annot-note';
      m.dataset.id = a.id;
      m.style.left = `${(a.at.x / ov.pageW) * 100}%`;
      m.style.top = `${(a.at.y / ov.pageH) * 100}%`;
      m.style.background = a.color;
      m.title = a.text || 'Note';
      m.textContent = '🗨';
      m.addEventListener('click', (e) => { e.stopPropagation(); this.openNoteEditor(a, m); });
      this.makeDraggable(m, a.page, (pt) => { (a as any).at = pt; this.scheduleSave(); });
      ov.dom.appendChild(m);
    } else if (a.type === 'textbox') {
      const t = document.createElement('div');
      t.className = 'annot-textbox';
      t.dataset.id = a.id;
      t.contentEditable = 'true';
      t.textContent = a.text;
      t.style.left = `${(a.at.x / ov.pageW) * 100}%`;
      t.style.top = `${(a.at.y / ov.pageH) * 100}%`;
      t.style.color = a.color;
      t.style.fontSize = `calc(var(--scale-factor, 1) * ${a.fontPts}px)`;
      t.addEventListener('input', () => { (a as any).text = t.textContent ?? ''; this.scheduleSave(); });
      t.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't start a new placement
      this.makeDraggable(t, a.page, (pt) => { (a as any).at = pt; this.scheduleSave(); }, true);
      ov.dom.appendChild(t);
    } else if (a.type === 'stamp') {
      const img = document.createElement('img');
      img.className = 'annot-stamp';
      img.dataset.id = a.id;
      img.src = a.dataUrl;
      img.style.left = `${(a.box.x / ov.pageW) * 100}%`;
      img.style.top = `${(a.box.y / ov.pageH) * 100}%`;
      img.style.width = `${(a.box.w / ov.pageW) * 100}%`;
      img.draggable = false;
      this.makeDraggable(img, a.page, (pt) => { (a as any).box = { ...a.box, x: pt.x, y: pt.y }; this.scheduleSave(); });
      ov.dom.appendChild(img);
    }
  }

  /** Drag a placed DOM annotation; reports the new top-left point (PDF points). */
  private makeDraggable(el: HTMLElement, pageNum: number, onMove: (pt: Pt) => void, editable = false): void {
    el.addEventListener('pointerdown', (e) => {
      if (editable && document.activeElement === el) return; // let the caret work
      if (!this.active) return;
      if ((e as PointerEvent).button !== 0 || this.tool === 'eraser') return;
      e.preventDefault();
      e.stopPropagation();
      const ov = this.overlays.get(pageNum)!;
      const start = this.clientToPt(ov, pageNum, e.clientX, e.clientY);
      const el0 = { x: parseFloat(el.style.left) , y: parseFloat(el.style.top) };
      const onPm = (ev: PointerEvent) => {
        const now = this.clientToPt(ov, pageNum, ev.clientX, ev.clientY);
        const nx = ((el0.x / 100) * ov.pageW) + (now.x - start.x);
        const ny = ((el0.y / 100) * ov.pageH) + (now.y - start.y);
        el.style.left = `${(nx / ov.pageW) * 100}%`;
        el.style.top = `${(ny / ov.pageH) * 100}%`;
        onMove({ x: nx, y: ny });
      };
      const onPu = () => {
        window.removeEventListener('pointermove', onPm, true);
        window.removeEventListener('pointerup', onPu, true);
      };
      window.addEventListener('pointermove', onPm, true);
      window.addEventListener('pointerup', onPu, true);
    });
  }

  private arrowPath(a: Extract<Annot, { type: 'arrow' }>): SVGElement {
    const g = document.createElementNS(SVGNS, 'g');
    g.dataset.id = a.id;
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', String(a.from.x));
    line.setAttribute('y1', String(a.from.y));
    line.setAttribute('x2', String(a.to.x));
    line.setAttribute('y2', String(a.to.y));
    line.setAttribute('stroke', a.color);
    line.setAttribute('stroke-width', String(a.width));
    line.setAttribute('stroke-linecap', 'round');
    const ang = Math.atan2(a.to.y - a.from.y, a.to.x - a.from.x);
    const head = Math.max(8, a.width * 4);
    const head1 = { x: a.to.x - head * Math.cos(ang - Math.PI / 6), y: a.to.y - head * Math.sin(ang - Math.PI / 6) };
    const head2 = { x: a.to.x - head * Math.cos(ang + Math.PI / 6), y: a.to.y - head * Math.sin(ang + Math.PI / 6) };
    const poly = document.createElementNS(SVGNS, 'polyline');
    poly.setAttribute('points', `${head1.x},${head1.y} ${a.to.x},${a.to.y} ${head2.x},${head2.y}`);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', a.color);
    poly.setAttribute('stroke-width', String(a.width));
    poly.setAttribute('stroke-linecap', 'round');
    poly.setAttribute('stroke-linejoin', 'round');
    g.append(line, poly);
    return g;
  }

  // ---- Text-selection marks --------------------------------------------

  private captureSelectionMark(): void {
    if (!this.active || !['highlight', 'underline', 'strike'].includes(this.tool)) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const pageEl = (range.startContainer.parentElement as HTMLElement)?.closest('.pdf-page') as HTMLElement | null;
    if (!pageEl) return;
    const pageNum = Number(pageEl.dataset.page);
    const rects: FracRect[] = [];
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue;
      // Map two opposite corners through the rotation; a screen-axis-aligned rect
      // stays axis-aligned under 90° steps, so min/extent recovers the rect.
      const a = this.clientToFrac(pageNum, cr.left, cr.top);
      const b = this.clientToFrac(pageNum, cr.right, cr.bottom);
      rects.push({
        x: Math.min(a.fx, b.fx),
        y: Math.min(a.fy, b.fy),
        w: Math.abs(b.fx - a.fx),
        h: Math.abs(b.fy - a.fy),
      });
    }
    if (!rects.length) return;
    const type = this.tool as 'highlight' | 'underline' | 'strike';
    this.add({
      id: this.newId(),
      page: pageNum,
      type,
      color: settings.get<string>('annotation.highlightColor'),
      opacity: settings.get<number>('annotation.highlightOpacity'),
      rects,
    });
    sel.removeAllRanges();
  }

  // ---- Placement (note / textbox / stamp) ------------------------------

  private placeAt(pageNum: number, ov: Overlay, clientX: number, clientY: number): void {
    const at = this.clientToPt(ov, pageNum, clientX, clientY);
    if (this.tool === 'note') {
      const a: Annot = { id: this.newId(), page: pageNum, type: 'note', color: settings.get<string>('annotation.highlightColor'), at, text: '' };
      this.add(a);
      const el = ov.dom.querySelector(`[data-id="${a.id}"]`) as HTMLElement;
      if (el) this.openNoteEditor(a, el);
    } else if (this.tool === 'textbox') {
      const a: Annot = { id: this.newId(), page: pageNum, type: 'textbox', color: settings.get<string>('annotation.penColor'), at, text: 'Text', fontPts: 14 };
      this.add(a);
      const el = ov.dom.querySelector(`[data-id="${a.id}"]`) as HTMLElement;
      if (el) { el.focus(); document.getSelection()?.selectAllChildren(el); }
    } else if (this.tool === 'stamp') {
      if (!this.pendingStamp) { void this.loadStamp(); return; }
      const w = 160, h = w / this.pendingStamp.aspect;
      this.add({ id: this.newId(), page: pageNum, type: 'stamp', box: { x: at.x, y: at.y, w, h }, dataUrl: this.pendingStamp.dataUrl });
    }
  }

  /** Open a file picker for a stamp/signature image, then await a click to place. */
  async loadStamp(): Promise<void> {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const dataUrl = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.readAsDataURL(file); });
      const aspect = await new Promise<number>((res) => { const im = new Image(); im.onload = () => res(im.naturalWidth / im.naturalHeight || 1); im.src = dataUrl; });
      this.pendingStamp = { dataUrl, aspect };
      this.setTool('stamp');
      this.toast('Click on the page to place the image');
    };
    input.click();
  }

  private openNoteEditor(a: Extract<Annot, { type: 'note' }>, marker: HTMLElement): void {
    document.querySelector('.annot-note-editor')?.remove();
    const panel = document.createElement('div');
    panel.className = 'annot-note-editor';
    const rect = marker.getBoundingClientRect();
    panel.style.left = `${Math.min(rect.right + 8, window.innerWidth - 260)}px`;
    panel.style.top = `${Math.max(12, rect.top)}px`;
    const ta = document.createElement('textarea');
    ta.value = a.text;
    ta.placeholder = 'Write a note…';
    ta.addEventListener('input', () => { a.text = ta.value; marker.title = ta.value; this.scheduleSave(); });
    const close = document.createElement('button');
    close.textContent = 'Done';
    close.addEventListener('click', () => panel.remove());
    panel.append(ta, close);
    document.body.appendChild(panel);
    ta.focus();
  }

  // ---- Vector drawing ---------------------------------------------------

  private wireSvgDrawing(pageNum: number, ov: Overlay): void {
    ov.svg.addEventListener('pointerdown', (e) => {
      if (e.button === 1) return; // middle button handled globally (eraser)
      if (!this.active) return;
      if (this.tool === 'eraser') {
        this.startErase();
        this.eraseAt(pageNum, e.clientX, e.clientY);
        ov.svg.setPointerCapture(e.pointerId);
        return;
      }
      if (['note', 'textbox', 'stamp'].includes(this.tool)) {
        e.preventDefault();
        this.placeAt(pageNum, ov, e.clientX, e.clientY);
        return;
      }
      if (!['pen', 'rectangle', 'ellipse', 'arrow'].includes(this.tool)) return;
      e.preventDefault();
      ov.svg.setPointerCapture(e.pointerId);
      const p = this.clientToPt(ov, pageNum, e.clientX, e.clientY);
      const color = this.tool === 'pen' ? settings.get<string>('annotation.penColor') : settings.get<string>('annotation.shapeColor');
      const width = settings.get<number>('annotation.penWidth');
      let annot: Annot;
      if (this.tool === 'pen') annot = { id: this.newId(), page: pageNum, type: 'pen', color, width, points: [p] };
      else if (this.tool === 'rectangle') annot = { id: this.newId(), page: pageNum, type: 'rectangle', color, width, box: { x: p.x, y: p.y, w: 0, h: 0 } };
      else if (this.tool === 'ellipse') annot = { id: this.newId(), page: pageNum, type: 'ellipse', color, width, box: { x: p.x, y: p.y, w: 0, h: 0 } };
      else annot = { id: this.newId(), page: pageNum, type: 'arrow', color, width, from: p, to: p };
      const preview = document.createElementNS(SVGNS, 'g');
      ov.svg.appendChild(preview);
      this.drawing = { pageNum, annot, preview, origin: p };
      this.updatePreview(ov, p);
    });

    ov.svg.addEventListener('pointermove', (e) => {
      if (this.erasing) return void this.eraseAt(pageNum, e.clientX, e.clientY);
      if (!this.drawing || this.drawing.pageNum !== pageNum) return;
      const p = this.clientToPt(ov, pageNum, e.clientX, e.clientY);
      const a = this.drawing.annot;
      const o = this.drawing.origin;
      if (a.type === 'pen') a.points.push(p);
      else if (a.type === 'rectangle' || a.type === 'ellipse') a.box = { x: Math.min(o.x, p.x), y: Math.min(o.y, p.y), w: Math.abs(p.x - o.x), h: Math.abs(p.y - o.y) };
      else if (a.type === 'arrow') a.to = p;
      this.updatePreview(ov, p);
    });

    const finish = (e: PointerEvent) => {
      if (this.erasing) return void this.endErase();
      if (!this.drawing) return;
      const a = this.drawing.annot;
      this.drawing.preview.remove();
      this.drawing = null;
      ov.svg.releasePointerCapture?.(e.pointerId);
      const trivial =
        (a.type === 'pen' && a.points.length < 2) ||
        ((a.type === 'rectangle' || a.type === 'ellipse') && a.box.w < 2 && a.box.h < 2) ||
        (a.type === 'arrow' && Math.hypot(a.to.x - a.from.x, a.to.y - a.from.y) < 3);
      if (!trivial) this.add(a);
    };
    ov.svg.addEventListener('pointerup', finish);
    ov.svg.addEventListener('pointercancel', finish);
  }

  private updatePreview(_ov: Overlay, _p: Pt): void {
    if (!this.drawing) return;
    this.drawing.preview.replaceChildren();
    const a = this.drawing.annot;
    const el = this.renderToFragment(a);
    if (el) this.drawing.preview.appendChild(el);
  }

  private renderToFragment(a: Annot): SVGElement | null {
    const tmp = document.createElementNS(SVGNS, 'g');
    const fake: Overlay = { rot: document.createElement('div'), hl: document.createElement('div'), svg: tmp as unknown as SVGSVGElement, dom: document.createElement('div'), pageW: 0, pageH: 0 };
    if (a.type === 'pen' || a.type === 'rectangle' || a.type === 'ellipse' || a.type === 'arrow') {
      this.renderAnnot(fake, a);
      return tmp;
    }
    return null;
  }

  // ---- Eraser -----------------------------------------------------------

  private middleEraserAllowed(): boolean {
    const cfg = settings.get<any>('annotation.middleClickEraser');
    return cfg?.enabled && (cfg.global || this.active);
  }

  private onGlobalPointerDown = (e: PointerEvent) => {
    if (e.button !== 1 || !this.middleEraserAllowed()) return;
    const pageEl = (e.target as HTMLElement)?.closest?.('.pdf-page') as HTMLElement | null;
    if (!pageEl) return;
    e.preventDefault();
    e.stopPropagation();
    this.startErase();
    this.eraseAt(Number(pageEl.dataset.page), e.clientX, e.clientY);
  };
  private onGlobalPointerMove = (e: PointerEvent) => {
    if (!this.erasing || !(e.buttons & 4)) return; // bit 4 = middle button held
    const pageEl = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement)?.closest?.('.pdf-page') as HTMLElement | null;
    if (pageEl) this.eraseAt(Number(pageEl.dataset.page), e.clientX, e.clientY);
  };
  private onGlobalPointerUp = (e: PointerEvent) => {
    if (this.erasing && e.button === 1) this.endErase();
  };

  private startErase(): void {
    if (!this.erasing) this.erasing = { deleted: [] };
  }
  private endErase(): void {
    if (this.erasing?.deleted.length) {
      this.undoStack.push({ kind: 'del', annots: this.erasing.deleted });
      this.redoStack = [];
      this.scheduleSave();
    }
    this.erasing = null;
  }

  private eraseAt(pageNum: number, clientX: number, clientY: number): void {
    const ov = this.overlays.get(pageNum);
    if (!ov) return;
    const p = this.clientToPt(ov, pageNum, clientX, clientY);
    const scale = this.pageScale(pageNum);
    const radiusPx = settings.get<number>('annotation.middleClickEraser.radius') ?? 12;
    const r = radiusPx / scale; // points
    const hits = this.annots.filter((a) => a.page === pageNum && this.hitTest(a, p, r, ov));
    if (!hits.length) return;
    const ids = new Set(hits.map((h) => h.id));
    this.annots = this.annots.filter((a) => !ids.has(a.id));
    if (this.erasing) this.erasing.deleted.push(...hits);
    void this.renderPage(pageNum);
  }

  private hitTest(a: Annot, p: Pt, r: number, ov: Overlay): boolean {
    if (a.type === 'pen') {
      for (let i = 1; i < a.points.length; i++) if (distToSeg(p, a.points[i - 1], a.points[i]) <= r + a.width) return true;
      return false;
    }
    if (a.type === 'arrow') return distToSeg(p, a.from, a.to) <= r + a.width;
    if (a.type === 'rectangle') {
      const b = a.box;
      const near = (v: number, lo: number, hi: number) => v >= lo - r && v <= hi + r;
      const onV = near(p.x, b.x, b.x) || near(p.x, b.x + b.w, b.x + b.w);
      const onH = near(p.y, b.y, b.y) || near(p.y, b.y + b.h, b.y + b.h);
      return (onV && p.y >= b.y - r && p.y <= b.y + b.h + r) || (onH && p.x >= b.x - r && p.x <= b.x + b.w + r);
    }
    if (a.type === 'ellipse') {
      const cx = a.box.x + a.box.w / 2, cy = a.box.y + a.box.h / 2;
      const rx = a.box.w / 2 || 1, ry = a.box.h / 2 || 1;
      const d = Math.hypot((p.x - cx) / rx, (p.y - cy) / ry); // ~1 on the ellipse
      return Math.abs(d - 1) <= r / Math.min(rx, ry);
    }
    if (a.type === 'note') return Math.hypot(p.x - a.at.x, p.y - a.at.y) <= r + 11;
    if (a.type === 'textbox') {
      return p.x >= a.at.x - r && p.x <= a.at.x + 120 + r && p.y >= a.at.y - r && p.y <= a.at.y + a.fontPts * 1.5 + r;
    }
    if (a.type === 'stamp') {
      const b = a.box;
      return p.x >= b.x - r && p.x <= b.x + b.w + r && p.y >= b.y - r && p.y <= b.y + b.h + r;
    }
    // text marks: rects are fractions → convert to points for the hit test
    for (const rc of a.rects) {
      const x = rc.x * ov.pageW, y = rc.y * ov.pageH, w = rc.w * ov.pageW, h = rc.h * ov.pageH;
      if (p.x >= x - r && p.x <= x + w + r && p.y >= y - r && p.y <= y + h + r) return true;
    }
    return false;
  }

  // ---- Mutation / undo / persistence -----------------------------------

  private add(a: Annot): void {
    this.annots.push(a);
    this.undoStack.push({ kind: 'add', annots: [a] });
    this.redoStack = [];
    void this.renderPage(a.page);
    this.scheduleSave();
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    if (op.kind === 'add') this.annots = this.annots.filter((a) => !op.annots.includes(a));
    else this.annots.push(...op.annots);
    this.redoStack.push(op);
    this.rerenderPages(op.annots);
    this.scheduleSave();
  }
  redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    if (op.kind === 'add') this.annots.push(...op.annots);
    else this.annots = this.annots.filter((a) => !op.annots.includes(a));
    this.undoStack.push(op);
    this.rerenderPages(op.annots);
    this.scheduleSave();
  }

  private rerenderPages(annots: Annot[]): void {
    for (const p of new Set(annots.map((a) => a.page))) void this.renderPage(p);
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (settings.get<boolean>('annotation.autosave')) {
        chrome.storage.local.set({ [this.storageKey()]: this.annots });
      }
    }, 400);
  }

  // ---- Geometry helpers -------------------------------------------------

  private pageScale(pageNum: number): number {
    const el = this.pdf.getPageEl(pageNum);
    const ov = this.overlays.get(pageNum);
    if (!el || !ov) return 1;
    return el.getBoundingClientRect().width / ov.pageW;
  }

  /** Client coords → fraction of the UNROTATED page (inverse of the page rotation). */
  private clientToFrac(pageNum: number, clientX: number, clientY: number): { fx: number; fy: number } {
    const pr = this.pdf.getPageEl(pageNum)!.getBoundingClientRect();
    const fx = (clientX - pr.left) / pr.width;
    const fy = (clientY - pr.top) / pr.height;
    switch (this.pdf.state.rotation) {
      case 90: return { fx: fy, fy: 1 - fx };
      case 180: return { fx: 1 - fx, fy: 1 - fy };
      case 270: return { fx: 1 - fy, fy: fx };
      default: return { fx, fy };
    }
  }

  private clientToPt(ov: Overlay, pageNum: number, clientX: number, clientY: number): Pt {
    const { fx, fy } = this.clientToFrac(pageNum, clientX, clientY);
    return { x: fx * ov.pageW, y: fy * ov.pageH };
  }

  private newId(): string {
    return `a-${++this.idSeq}`;
  }
  private storageKey(): string {
    return `lumen.annot.${this.pdf.fingerprint()}`;
  }

  getAll(): Annot[] {
    return this.annots;
  }

  // ---- Export (bake annotations into a downloadable PDF) ----------------

  async exportPdf(): Promise<void> {
    if (settings.get<boolean>('general.confirmOnExport') && !confirm(`Export this PDF with ${this.annots.length} annotation(s)?`)) return;
    const doc = this.pdf.getDocument();
    if (!doc) return;
    this.toast('Exporting…');
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
    const srcBytes = await doc.getData();
    const out = await PDFDocument.load(srcBytes);
    const font = await out.embedFont(StandardFonts.Helvetica);
    const pages = out.getPages();

    for (const a of this.annots) {
      const page = pages[a.page - 1];
      if (!page) continue;
      const { width: W, height: H } = page.getSize();
      const col = (hex: string) => { const [r, g, b] = hexToRgb(hex); return rgb(r, g, b); };
      const flipY = (y: number) => H - y; // PDF.js top-left → pdf-lib bottom-left

      if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') {
        for (const r of a.rects) {
          const x = r.x * W, w = r.w * W, yTop = r.y * H, h = r.h * H;
          if (a.type === 'highlight') {
            page.drawRectangle({ x, y: flipY(yTop + h), width: w, height: h, color: col(a.color), opacity: a.opacity });
          } else {
            const yLine = a.type === 'underline' ? yTop + h : yTop + h / 2;
            page.drawLine({ start: { x, y: flipY(yLine) }, end: { x: x + w, y: flipY(yLine) }, thickness: 1.5, color: col(a.color) });
          }
        }
      } else if (a.type === 'pen') {
        for (let i = 1; i < a.points.length; i++) {
          page.drawLine({ start: { x: a.points[i - 1].x, y: flipY(a.points[i - 1].y) }, end: { x: a.points[i].x, y: flipY(a.points[i].y) }, thickness: a.width, color: col(a.color) });
        }
      } else if (a.type === 'rectangle') {
        const { x, y, w, h } = a.box;
        page.drawRectangle({ x, y: flipY(y + h), width: w, height: h, borderColor: col(a.color), borderWidth: a.width });
      } else if (a.type === 'ellipse') {
        page.drawEllipse({ x: a.box.x + a.box.w / 2, y: flipY(a.box.y + a.box.h / 2), xScale: a.box.w / 2, yScale: a.box.h / 2, borderColor: col(a.color), borderWidth: a.width });
      } else if (a.type === 'arrow') {
        page.drawLine({ start: { x: a.from.x, y: flipY(a.from.y) }, end: { x: a.to.x, y: flipY(a.to.y) }, thickness: a.width, color: col(a.color) });
        const ang = Math.atan2(a.to.y - a.from.y, a.to.x - a.from.x);
        const head = Math.max(8, a.width * 4);
        for (const s of [-1, 1]) {
          const hx = a.to.x - head * Math.cos(ang + (s * Math.PI) / 6);
          const hy = a.to.y - head * Math.sin(ang + (s * Math.PI) / 6);
          page.drawLine({ start: { x: a.to.x, y: flipY(a.to.y) }, end: { x: hx, y: flipY(hy) }, thickness: a.width, color: col(a.color) });
        }
      } else if (a.type === 'note') {
        // Round marker to match the on-screen bubble (the old filled square read
        // as a stray box next to the note text).
        const nr = 7;
        page.drawEllipse({ x: a.at.x + nr, y: flipY(a.at.y + nr), xScale: nr, yScale: nr, color: col(a.color) });
        if (a.text) page.drawText(a.text, { x: a.at.x + 2 * nr + 5, y: flipY(a.at.y + nr + 3), size: 9, font, color: rgb(0.1, 0.1, 0.1), maxWidth: W - a.at.x - 2 * nr - 9 });
      } else if (a.type === 'textbox') {
        page.drawText(a.text, { x: a.at.x, y: flipY(a.at.y + a.fontPts), size: a.fontPts, font, color: col(a.color), maxWidth: W - a.at.x });
      } else if (a.type === 'stamp') {
        const { bytes, mime } = dataUrlToBytes(a.dataUrl);
        const img = mime.includes('png') ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        page.drawImage(img, { x: a.box.x, y: flipY(a.box.y + a.box.h), width: a.box.w, height: a.box.h });
      }
    }

    const result = await out.save();
    const blob = new Blob([result as BlobPart], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `annotated-${this.pdf.fingerprint().slice(0, 8)}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    this.toast('Exported ✓');
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const [head, b64] = dataUrl.split(',');
  const mime = /data:(.*?);/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mime };
}

function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
