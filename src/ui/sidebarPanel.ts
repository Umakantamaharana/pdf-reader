/**
 * sidebarPanel.ts — Left navigator (the ☰ toolbar button / `s` key) with two
 * tabs:
 *
 *  - **Pages** — a lazy column of page thumbnails; clicking one jumps there and
 *    the current page's thumbnail stays highlighted and in view.
 *  - **Contents** — the PDF's outline (bookmarks / table of contents) as a
 *    collapsible tree; clicking an entry jumps to that heading, and the section
 *    containing the current page is highlighted.
 *
 * Visibility is driven by `viewing.sidebar.visible` and the tab by
 * `viewing.sidebar.activeTab`, so keyboard, toolbar and Settings share state.
 */

import { PDFViewer } from '../viewer/pdfViewer';
import { settings } from '../core/settings';
import { icon } from './icons';

type Tab = 'thumbnails' | 'outline';

/** Sidebar slide duration — keep in sync with .lumen-sidebar in viewer.css. */
const SLIDE_MS = 320;

interface OutlineNode {
  title: string;
  dest: unknown;
  url?: string | null;
  items: OutlineNode[];
  count?: number;
  bold?: boolean;
  italic?: boolean;
}

export class SidebarPanel {
  private pdf: PDFViewer;
  private el: HTMLElement;
  private list: HTMLDivElement;
  private builtFor = '';
  private observer: IntersectionObserver | null = null;
  private thumbs = new Map<number, HTMLCanvasElement>();
  private rendered = new Set<number>();

  private outlineEl: HTMLDivElement;
  private tabBtns = new Map<Tab, HTMLButtonElement>();
  private outlineFor = '';
  /** Outline rows paired with their resolved start page (for "you are here"). */
  private outlineRows: Array<{ row: HTMLElement; node: OutlineNode; page: number }> = [];
  private wasVisible: boolean | null = null;

  constructor(pdf: PDFViewer) {
    this.pdf = pdf;
    this.el = document.createElement('aside');
    this.el.className = 'lumen-sidebar';
    const head = document.createElement('div');
    head.className = 'sb-tabs';
    head.setAttribute('role', 'tablist');
    for (const [tab, label, ico] of [
      ['thumbnails', 'Pages', 'files'],
      ['outline', 'Contents', 'list'],
    ] as const) {
      const b = document.createElement('button');
      b.className = 'sb-tab';
      b.setAttribute('role', 'tab');
      b.innerHTML = `${icon(ico)}<span>${label}</span>`;
      b.addEventListener('click', () => void settings.set('viewing.sidebar.activeTab', tab));
      this.tabBtns.set(tab, b);
      head.appendChild(b);
    }
    this.list = document.createElement('div');
    this.list.className = 'sb-list';
    this.outlineEl = document.createElement('div');
    this.outlineEl.className = 'sb-outline';
    this.el.append(head, this.list, this.outlineEl);
    document.body.appendChild(this.el);

    this.apply();
    settings.subscribe('viewing.sidebar', () => this.apply());

    this.pdf.onChange((s) => {
      this.ensureBuilt();
      this.highlight(s.page);
    });
  }

  private tab(): Tab {
    return settings.get<string>('viewing.sidebar.activeTab') === 'outline' ? 'outline' : 'thumbnails';
  }

  private apply(): void {
    const visible = settings.get<boolean>('viewing.sidebar.visible');
    const tab = this.tab();
    // Slide in/out (CSS) rather than appearing/disappearing in one frame.
    this.el.classList.toggle('is-open', visible);
    this.el.inert = !visible;
    this.list.hidden = tab !== 'thumbnails';
    this.outlineEl.hidden = tab !== 'outline';
    for (const [t, b] of this.tabBtns) {
      b.classList.toggle('active', t === tab);
      b.setAttribute('aria-selected', String(t === tab));
    }
    if (visible) this.ensureBuilt();
    // Opening/closing changes the usable width: the pages re-fit smoothly
    // frame by frame while the sidebar slides (switching tabs doesn't).
    if (visible !== this.wasVisible) {
      const first = this.wasVisible === null;
      this.wasVisible = visible;
      const resize = () => document.body.classList.toggle('sidebar-open', visible);
      // The page area resizes instantly; the pages glide to their new place
      // and size as one GPU transform (FLIP) in step with the slide.
      if (first) resize();
      else void this.pdf.flipResize(resize, SLIDE_MS);
    }
  }

  private ensureBuilt(): void {
    const doc = this.pdf.getDocument();
    if (!doc || this.pdf.state.pageCount === 0) return;
    if (this.tab() === 'outline') {
      if (this.outlineFor !== this.pdf.fingerprint()) void this.buildOutline();
      return;
    }
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

  // ---- Contents (outline) ----------------------------------------------

  private async buildOutline(): Promise<void> {
    const doc = this.pdf.getDocument();
    if (!doc) return;
    const fp = this.pdf.fingerprint();
    this.outlineFor = fp;
    this.outlineRows = [];
    this.outlineEl.replaceChildren();
    let outline: OutlineNode[] | null = null;
    try {
      outline = (await doc.getOutline()) as OutlineNode[] | null;
    } catch {
      outline = null;
    }
    if (this.outlineFor !== fp) return; // a different document loaded meanwhile
    if (!outline?.length) {
      const empty = document.createElement('div');
      empty.className = 'sb-empty';
      empty.textContent = 'This document has no table of contents.';
      this.outlineEl.appendChild(empty);
      return;
    }
    this.outlineEl.appendChild(this.renderOutline(outline, 0));
    // Resolve each entry's page in the background for the current-section marker.
    await Promise.all(
      this.outlineRows.map(async (r) => {
        r.page = (await this.pdf.resolveDestination(r.node.dest))?.page ?? 0;
      }),
    );
    this.highlightOutline(this.pdf.state.page);
  }

  private renderOutline(nodes: OutlineNode[], depth: number): HTMLUListElement {
    const ul = document.createElement('ul');
    ul.className = 'sb-tree';
    ul.setAttribute('role', depth === 0 ? 'tree' : 'group');
    for (const node of nodes) {
      const li = document.createElement('li');
      li.setAttribute('role', 'treeitem');
      const row = document.createElement('div');
      row.className = 'sb-node';
      row.style.paddingLeft = `${4 + depth * 12}px`;

      const hasKids = node.items?.length > 0;
      const toggle = document.createElement('button');
      toggle.className = 'sb-toggle';
      toggle.tabIndex = -1;
      if (hasKids) {
        toggle.innerHTML = icon('chevron-right');
        toggle.setAttribute('aria-label', 'Expand or collapse');
      } else {
        toggle.classList.add('leaf');
      }

      const link = document.createElement('button');
      link.className = 'sb-link';
      link.textContent = node.title || 'Untitled';
      link.title = node.title || '';
      if (node.bold) link.style.fontWeight = '600';
      if (node.italic) link.style.fontStyle = 'italic';
      link.addEventListener('click', () => {
        if (node.dest != null) void this.pdf.followLink(node.dest);
        else if (node.url) window.open(node.url, '_blank', 'noopener');
      });

      row.append(toggle, link);
      li.appendChild(row);
      this.outlineRows.push({ row, node, page: 0 });

      if (hasKids) {
        const kids = this.renderOutline(node.items, depth + 1);
        // pdf.js `count` < 0 means the author saved this entry collapsed.
        const open = depth === 0 ? (node.count ?? 1) >= 0 : (node.count ?? -1) > 0;
        li.classList.toggle('open', open);
        li.setAttribute('aria-expanded', String(open));
        toggle.addEventListener('click', () => {
          const now = !li.classList.contains('open');
          li.classList.toggle('open', now);
          li.setAttribute('aria-expanded', String(now));
        });
        li.appendChild(kids);
      }
      ul.appendChild(li);
    }
    return ul;
  }

  /** Mark the last outline entry starting at or before the current page. */
  private highlightOutline(page: number): void {
    let best: HTMLElement | null = null;
    let bestPage = 0;
    for (const r of this.outlineRows) {
      if (r.page > 0 && r.page <= page && r.page >= bestPage) {
        best = r.row;
        bestPage = r.page;
      }
    }
    const prev = this.outlineEl.querySelector('.sb-node.current');
    if (prev === best) return;
    prev?.classList.remove('current');
    if (!best) return;
    best.classList.add('current');
    // Only reveal it if its branch is expanded (don't force-open the tree).
    if (best.offsetParent) best.scrollIntoView({ block: 'nearest' });
  }

  private highlight(page: number): void {
    this.highlightOutline(page);
    const prev = this.list.querySelector('.sb-item.active');
    if (prev?.getAttribute('data-page') === String(page)) return;
    prev?.classList.remove('active');
    const cur = this.list.querySelector(`.sb-item[data-page="${page}"]`) as HTMLElement | null;
    cur?.classList.add('active');
    cur?.scrollIntoView({ block: 'nearest' });
  }
}
