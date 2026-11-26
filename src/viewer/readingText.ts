/**
 * readingText.ts — Turns a page's raw text items into what a human would read
 * aloud.
 *
 * pdf.js gives every glyph run on the page: body prose, but also chart axis
 * ticks and legends, table cells, running headers/footers and page numbers.
 * Reading all of it sounds robotic ("Figure 3 0 10 20 30 Q1 Q2 …"). This module
 *
 *  1. groups items into visual lines,
 *  2. drops lines that aren't prose (see `classifyLines`) when `skipNonProse`,
 *  3. joins the rest with real word breaks at line ends (pdf.js items carry
 *     no whitespace across lines, so "end of" + "line" became "end ofline"),
 *     de-hyphenating words split across lines, and
 *  4. marks headings as sentence boundaries so they get a pause.
 *
 * It returns the spoken text plus `map`, an offset table from each spoken
 * character back to its position in the page's *joined item text* (the
 * coordinate space the text layer and highlighting use), so sentence/word
 * highlighting stays exact even though spoken text differs from page text.
 */

import type { PageTextGeometry, PageTextItem } from './pdfViewer';

/** Marks a forced sentence break (after a heading); treated as whitespace. */
export const BREAK = ' ';

export interface ReadingText {
  text: string;
  /** map[k] = joined-item-text offset of spoken char k (separators map to the
   *  end of the item before them). Length text.length. */
  map: number[];
}

type Region = { x: number; y: number; w: number; h: number }; // page fractions

interface Line {
  first: number; // item index range [first, last]
  last: number;
  text: string;
  size: number; // font size (max item height)
  top: number; // page-fraction vertical center
  cx: number;
  cy: number;
  keep: boolean;
  heading: boolean;
}

export function buildReadingText(geom: PageTextGeometry, imageRegions: Region[], skipNonProse: boolean): ReadingText {
  const { items } = geom;
  const lines = groupLines(items, geom);
  if (skipNonProse) classifyLines(lines, imageRegions);

  // Joined-text offset of each item's first char.
  const offs: number[] = [];
  let acc = 0;
  for (const it of items) {
    offs.push(acc);
    acc += it.str.length;
  }

  let text = '';
  const map: number[] = [];
  const push = (ch: string, at: number) => {
    text += ch;
    map.push(at);
  };

  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    if (!ln.keep) continue;
    for (let i = ln.first; i <= ln.last; i++) {
      const s = items[i].str;
      for (let k = 0; k < s.length; k++) push(s[k], offs[i] + k);
    }
    const lineEnd = offs[ln.last] + items[ln.last].str.length;
    if (ln.heading) {
      push(BREAK, lineEnd);
      continue;
    }
    // De-hyphenate "exam-" / "ple" across a line break when the next kept line
    // continues in lowercase; otherwise separate lines with a space.
    const next = lines.slice(li + 1).find((l) => l.keep);
    if (/[A-Za-z]-$/.test(text) && next && /^[a-z]/.test(next.text.trimStart())) {
      text = text.slice(0, -1);
      map.pop();
    } else if (!/\s$/.test(text)) {
      push(' ', lineEnd);
    }
  }
  return { text, map };
}

/** Group consecutive items into visual lines (content-stream order). */
function groupLines(items: PageTextItem[], geom: PageTextGeometry): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  let curBase = 0;
  const W = geom.width || 1;
  const H = geom.height || 1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const base = it.y + it.h;
    const sameLine = cur && Math.abs(base - curBase) < Math.max(2, 0.5 * Math.max(cur.size, it.h)) && !items[i - 1]?.hasEOL;
    if (!cur || !sameLine) {
      cur = { first: i, last: i, text: '', size: 0, top: 0, cx: 0, cy: 0, keep: true, heading: false };
      lines.push(cur);
      curBase = base;
    }
    cur.last = i;
    cur.text += it.str;
    if (it.str.trim()) cur.size = Math.max(cur.size, it.h);
  }
  for (const ln of lines) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = ln.first; i <= ln.last; i++) {
      const it = items[i];
      if (!it.str.trim()) continue;
      x0 = Math.min(x0, it.x); x1 = Math.max(x1, it.x + it.w);
      y0 = Math.min(y0, it.y); y1 = Math.max(y1, it.y + it.h);
    }
    if (x0 === Infinity) { x0 = x1 = y0 = y1 = 0; }
    ln.cx = (x0 + x1) / 2 / W;
    ln.cy = (y0 + y1) / 2 / H;
    ln.top = ln.cy;
  }
  // Whitespace-only lines carry nothing to read.
  for (const ln of lines) if (!ln.text.trim()) ln.keep = false;
  return lines;
}

const TERMINAL = /[.!?:;,…)"'”’]$/;
const BULLET = /^\s*([•●▪◦‣\-–—*]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s/;

/**
 * Decide which lines are prose. A line is dropped when it is
 *  - much smaller than the body text (chart labels, footnote markers, fine print),
 *  - mostly digits/symbols (axis ticks, table figures, equations, page numbers),
 *  - a short running header/footer in the top/bottom margin,
 *  - inside a raster image (labels baked over a figure), or
 *  - part of a cluster of ≥3 short, unpunctuated fragments (chart legends,
 *    axis titles, diagram boxes, table headers).
 * Body-size or larger short lines that stand alone are kept as headings.
 */
function classifyLines(lines: Line[], imageRegions: Region[]): void {
  const body = bodyFontSize(lines);
  const words = (t: string) => t.trim().split(/\s+/).filter(Boolean);
  const nonProse = new Array<boolean>(lines.length).fill(false);
  const fragment = new Array<boolean>(lines.length).fill(false);

  lines.forEach((ln, i) => {
    if (!ln.keep) return;
    const t = ln.text.trim();
    const w = words(t);
    const chars = t.replace(/\s/g, '');
    const letters = (chars.match(/\p{L}/gu) ?? []).length;
    const letterRatio = chars.length ? letters / chars.length : 0;

    const small = body > 0 && ln.size > 0 && ln.size < 0.8 * body;
    const numeric = letterRatio < 0.5 && w.length < 12;
    const margin = (ln.top < 0.07 || ln.top > 0.93) && w.length <= 10;
    const inImage = imageRegions.some(
      (r) => ln.cx >= r.x && ln.cx <= r.x + r.w && ln.cy >= r.y && ln.cy <= r.y + r.h,
    );
    if (small || numeric || margin || inImage) nonProse[i] = true;

    const big = body > 0 && ln.size >= 1.15 * body;
    fragment[i] = !nonProse[i] && !big && w.length <= 3 && !TERMINAL.test(t) && !BULLET.test(t);
  });

  // Clusters of fragments (interleaved with already-dropped lines) = figure/table text.
  let i = 0;
  while (i < lines.length) {
    if (!(fragment[i] || nonProse[i]) || !lines[i].keep) { i++; continue; }
    let j = i;
    let frags = 0;
    while (j < lines.length && lines[j].keep && (fragment[j] || nonProse[j])) {
      if (fragment[j]) frags++;
      j++;
    }
    if (frags >= 3 || (frags >= 2 && j - i >= 4)) for (let k = i; k < j; k++) if (fragment[k]) nonProse[k] = true;
    i = Math.max(j, i + 1);
  }

  lines.forEach((ln, idx) => {
    if (ln.keep && nonProse[idx]) ln.keep = false;
  });
  lines.forEach((ln, idx) => {
    if (!ln.keep) return;
    const t = ln.text.trim();
    const big = body > 0 && ln.size >= 1.15 * body;
    // A wrapped line that continues in lowercase is mid-sentence, not a heading.
    const next = lines.slice(idx + 1).find((l) => l.keep);
    const continues = !!next && /^[a-z]/.test(next.text.trimStart());
    // Stand-alone short line without terminal punctuation → heading: pause after it.
    ln.heading = (big || fragment[idx]) && !continues && !TERMINAL.test(t) && words(t).length <= 14;
  });
}

/** Most common font size weighted by character count = the body text size. */
function bodyFontSize(lines: Line[]): number {
  const hist = new Map<number, number>();
  for (const ln of lines) {
    if (!ln.keep || ln.size <= 0) continue;
    const k = Math.round(ln.size * 2) / 2;
    hist.set(k, (hist.get(k) ?? 0) + ln.text.trim().length);
  }
  let best = 0;
  let bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { best = k; bestN = n; }
  return best;
}
