/**
 * sidebarPanel.ts — Page-thumbnail navigator (the ☰ toolbar button / `s` key).
 *
 * Renders a lazy column of page thumbnails; clicking one jumps the viewer to
 * that page, and the thumbnail for the current page stays highlighted and in
 * view. Visibility is driven by `viewing.sidebar.visible`, so the keyboard
 * toggle, the toolbar button and the Settings page all control the same state.
 */

import { PDFViewer } from '../viewer/pdfViewer';
import { settings } from '../core/settings';

export class SidebarPanel {
  private pdf: PDFViewer;
  private el: HTMLElement;
  private list: HTMLDivElement;
  private builtFor = '';
  private observer: IntersectionObserver | null = null;
  private thumbs = new Map<number, HTMLCanvasElement>();
  private rendered = new Set<number>();

  constructor(pdf: PDFViewer) {
    this.pdf = pdf;
    this.el = document.createElement('aside');
    this.el.className = 'lumen-sidebar';
    const head = document.createElement('div');
    head.className = 'sb-head';
    head.textContent = 'Pages';
    this.list = document.createElement('div');
    this.list.className = 'sb-list';
    this.el.append(head, this.list);
    document.body.appendChild(this.el);

    this.apply(settings.get<boolean>('viewing.sidebar.visible'));
    settings.subscribe('viewing.sidebar', () => this.apply(settings.get<boolean>('viewing.sidebar.visible')));

    this.pdf.onChange((s) => {
      this.ensureBuilt();
      this.highlight(s.page);
    });
  }

  private apply(visible: boolean): void {
    this.el.hidden = !visible;
    document.body.classList.toggle('sidebar-open', visible);
    if (visible) this.ensureBuilt();
    // Opening/closing changes the usable width, so re-fit width/page modes.
    void this.pdf.handleResize();
  }

  private ensureBuilt(): void {
    const doc = this.pdf.getDocument();
    if (!doc || this.pdf.state.pageCount === 0) return;
    if (this.builtFor === this.pdf.fingerprint() && this.list.childElementCount === this.pdf.state.pageCount) return;
    this.build();
  }

  private build(): void {
    this.builtFor = this.pdf.fingerprint();
    this.list.replaceChildren();
    this.thumbs.clear();
    this.rendered.clear();
    this.observer?.disconnect();
    this.observer = new IntersectionObserver(
      (ents) => {
        for (const e of ents) if (e.isIntersecting) void this.renderThumb(Number((e.target as HTMLElement).dataset.page));
      },
      { root: this.list, rootMargin: '300px 0px' },
    );

    for (let n = 1; n <= this.pdf.state.pageCount; n++) {
      const item = document.createElement('button');
      item.className = 'sb-item';
      item.dataset.page = String(n);
      item.title = `Page ${n}`;
      const canvas = document.createElement('canvas');
      canvas.className = 'sb-thumb';
      const label = document.createElement('span');
      label.className = 'sb-num';
      label.textContent = String(n);
      item.append(canvas, label);
      item.addEventListener('click', () => void this.pdf.goToPage(n));
      this.thumbs.set(n, canvas);
      this.list.appendChild(item);
      this.observer.observe(item);
    }
    this.highlight(this.pdf.state.page);
  }

  private async renderThumb(pageNum: number): Promise<void> {
    if (this.rendered.has(pageNum)) return;
    const doc = this.pdf.getDocument();
    const canvas = this.thumbs.get(pageNum);
    if (!doc || !canvas) return;
    this.rendered.add(pageNum);
    try {
      const page = await doc.getPage(pageNum);
      const targetW = 150;
      const base = page.getViewport({ scale: 1, rotation: this.pdf.state.rotation });
      const scale = targetW / base.width;
      const vp = page.getViewport({ scale, rotation: this.pdf.state.rotation });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      const ctx = canvas.getContext('2d', { alpha: false })!;
      await page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;
    } catch {
      this.rendered.delete(pageNum); // allow a retry on the next pass
    }
  }

  private highlight(page: number): void {
    const prev = this.list.querySelector('.sb-item.active');
    if (prev?.getAttribute('data-page') === String(page)) return;
    prev?.classList.remove('active');
    const cur = this.list.querySelector(`.sb-item[data-page="${page}"]`) as HTMLElement | null;
    cur?.classList.add('active');
    cur?.scrollIntoView({ block: 'nearest' });
  }
}
