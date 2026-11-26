/**
 * search.ts — Find-in-document with match highlighting.
 *
 * Matching runs over each page's extracted text items; highlighting is painted
 * with the CSS Custom Highlight API (no DOM mutation of the text layer, so
 * selection and annotations stay intact). The text layer gives us an exact
 * item→span correspondence, so a character range in the joined page text maps
 * cleanly to a DOM Range across spans.
 *
 * Options (case-sensitive / regex / whole-words / highlight-all) come from
 * settings.search and can be toggled live from the search bar.
 */

import { PDFViewer } from './pdfViewer';
import { settings } from '../core/settings';
import { icon } from '../ui/icons';
import { dock } from '../ui/dock';

interface Match {
  page: number;
  start: number; // char offset in the page's joined item text
  end: number;
}

const HL_ALL = 'lumen-search';
const HL_ACTIVE = 'lumen-search-active';
const supportsHighlightAPI = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (globalThis as any).Highlight === 'function';

export class SearchController {
  private pdf: PDFViewer;
  private bar: HTMLDivElement;
  private input: HTMLInputElement;
  private countEl: HTMLSpanElement;
  private open = false;

  private query = '';
  private matches: Match[] = [];
  private active = -1;
  private searchToken = 0;

  constructor(pdf: PDFViewer) {
    this.pdf = pdf;
    this.bar = this.buildBar();
    this.input = this.bar.querySelector('.search-input')!;
    this.countEl = this.bar.querySelector('.search-count')!;

    // Re-paint a page's highlights when its text layer (re)renders.
    this.pdf.onPageRendered((pageNum) => {
      if (this.open && this.query) this.decoratePage(pageNum);
    });
  }

  // ---- Command entry points --------------------------------------------

  show(initial = ''): void {
    this.open = true;
    // The find bar is a dock face like every other sub-toolbar: it rolls in
    // over the toolbar and rolls back out when closed.
    dock().open('search');
    if (initial) this.input.value = initial;
    this.input.focus();
    this.input.select();
    if (this.input.value) void this.run(this.input.value);
  }

  close(): void {
    this.open = false;
    dock().close('search');
    // Don't leave keystrokes going into a bar that is rolling away.
    if (this.bar.contains(document.activeElement)) (document.getElementById('scroll') as HTMLElement | null)?.focus();
    this.clearHighlights();
    this.matches = [];
    this.active = -1;
  }

  toggle(initial = ''): void {
    this.open ? this.close() : this.show(initial);
  }

  next(): void {
    void this.step(1);
  }
  prev(): void {
    void this.step(-1);
  }

  // ---- Core search ------------------------------------------------------

  private async run(query: string): Promise<void> {
    this.query = query;
    const token = ++this.searchToken;
    this.clearHighlights();
    this.matches = [];
    this.active = -1;

    if (!query) {
      this.updateCount();
      return;
    }
    const re = this.buildRegex(query);
    if (!re) {
      this.countEl.textContent = 'bad regex';
      return;
    }

    const pageCount = this.pdf.state.pageCount;
    for (let p = 1; p <= pageCount; p++) {
      if (token !== this.searchToken) return; // superseded by a newer query
      const items = await this.pdf.getPageItems(p);
      const text = items.join('');
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        this.matches.push({ page: p, start: m.index, end: m.index + m[0].length });
      }
    }
    if (token !== this.searchToken) return;

    this.updateCount();
    // Decorate any already-rendered pages, then jump to the first match.
    this.repaintVisible();
    if (this.matches.length) await this.step(1, true);
  }

  private async step(dir: number, firstJump = false): Promise<void> {
    if (!this.matches.length) return;
    this.active = firstJump
      ? 0
      : (this.active + dir + this.matches.length) % this.matches.length;
    const match = this.matches[this.active];
    await this.pdf.ensurePageRendered(match.page);
    // Give the text layer a tick to attach if it just rendered.
    this.decoratePage(match.page);
    this.scrollToActive(match);
    this.updateCount();
  }

  // ---- Highlight painting ----------------------------------------------

  private repaintVisible(): void {
    const pages = new Set(this.matches.map((m) => m.page));
    for (const p of pages) if (this.pdf.getTextLayer(p)) this.decoratePage(p);
  }

  /** Rebuild the "all matches" + "active" highlights including this page. */
  private decoratePage(_pageNum: number): void {
    if (!supportsHighlightAPI) return;
    const all = new (globalThis as any).Highlight();
    const activeHl = new (globalThis as any).Highlight();

    this.matches.forEach((m, i) => {
      const layer = this.pdf.getTextLayer(m.page);
      if (!layer) return;
      const range = this.rangeFor(layer.items, layer.divs, m.start, m.end);
      if (!range) return;
      (i === this.active ? activeHl : all).add(range);
    });

    CSS.highlights.set(HL_ALL, all);
    CSS.highlights.set(HL_ACTIVE, activeHl);
  }

  private clearHighlights(): void {
    if (!supportsHighlightAPI) return;
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_ACTIVE);
  }

  /** Map a [start,end) char range in the joined item text to a DOM Range. */
  private rangeFor(items: string[], divs: HTMLElement[], start: number, end: number): Range | null {
    const s = this.locate(items, start, false);
    const e = this.locate(items, end, true);
    if (!s || !e) return null;
    const startNode = divs[s.item]?.firstChild;
    const endNode = divs[e.item]?.firstChild;
    if (!startNode || !endNode) return null;
    try {
      const range = document.createRange();
      range.setStart(startNode, Math.min(s.local, (startNode as Text).length));
      range.setEnd(endNode, Math.min(e.local, (endNode as Text).length));
      return range;
    } catch {
      return null;
    }
  }

  /** Find the item index + local offset for a char position. */
  private locate(items: string[], pos: number, isEnd: boolean): { item: number; local: number } | null {
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
      const len = items[i].length;
      const within = isEnd ? pos <= acc + len && pos > acc : pos >= acc && pos < acc + len;
      if (within) return { item: i, local: pos - acc };
      acc += len;
    }
    // Clamp end that lands exactly past the final item.
    if (isEnd && pos === acc && items.length) return { item: items.length - 1, local: items[items.length - 1].length };
    return null;
  }

  private scrollToActive(match: Match): void {
    const layer = this.pdf.getTextLayer(match.page);
    const loc = layer && this.locate(layer.items, match.start, false);
    const target = (loc && layer!.divs[loc.item]) || this.pdf.getPageEl(match.page);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  private buildRegex(query: string): RegExp | null {
    const s = settings.get<any>('search');
    const flags = 'g' + (s.caseSensitive ? '' : 'i');
    try {
      let src = s.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (s.wholeWords) src = `\\b(?:${src})\\b`;
      return new RegExp(src, flags);
    } catch {
      return null;
    }
  }

  private updateCount(): void {
    if (!this.query) {
      this.countEl.textContent = '';
    } else if (!this.matches.length) {
      this.countEl.textContent = 'No results';
    } else {
      this.countEl.textContent = `${this.active + 1} / ${this.matches.length}`;
    }
  }

  // ---- UI ---------------------------------------------------------------

  private buildBar(): HTMLDivElement {
    const bar = document.createElement('div');
    bar.className = 'search-bar';
    bar.innerHTML = `
      <span class="search-ico">${icon('search')}</span>
      <input class="search-input" type="text" placeholder="Find in document…" spellcheck="false" />
      <span class="search-count"></span>
      <button class="search-btn" data-act="prev" title="Previous (Shift+Enter / Shift+F3)" aria-label="Previous match">${icon('chevron-up')}</button>
      <button class="search-btn" data-act="next" title="Next (Enter / F3)" aria-label="Next match">${icon('chevron-down')}</button>
      <label class="search-toggle" title="Match case"><input type="checkbox" data-opt="caseSensitive" />Aa</label>
      <label class="search-toggle" title="Whole words"><input type="checkbox" data-opt="wholeWords" />W</label>
      <label class="search-toggle" title="Regex"><input type="checkbox" data-opt="regex" />.*</label>
      <button class="search-btn" data-act="close" title="Close (Esc)" aria-label="Close">${icon('x')}</button>`;
    dock().register('search', bar);

    const input = bar.querySelector('.search-input') as HTMLInputElement;
    let debounce: number | undefined;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = window.setTimeout(() => void this.run(input.value), 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? this.prev() : this.next();
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    bar.querySelectorAll<HTMLInputElement>('input[data-opt]').forEach((cb) => {
      const path = `search.${cb.dataset.opt}`;
      cb.checked = settings.get<boolean>(path);
      cb.addEventListener('change', async () => {
        await settings.set(path, cb.checked);
        void this.run(this.input.value);
      });
    });
    bar.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'next') this.next();
        else if (act === 'prev') this.prev();
        else if (act === 'close') this.close();
      });
    });
    return bar;
  }
}
