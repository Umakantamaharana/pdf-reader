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

// ---------------------------------------------------------------------------
// Clean reading — rule-based rewrite of the spoken text (no AI).
//
// Runs on the (text, map) pair *before* sentence splitting, so abbreviations
// like "e.g." / "Fig." no longer cut sentences in half, and every inserted or
// kept character still maps back to a page offset (highlighting stays right).
// Removes what a listener can't follow without looking (citations, URLs,
// figure/table/equation refs, stats parentheticals, footnote marks, inline
// maths) and reads symbols/abbreviations as words.
// ---------------------------------------------------------------------------

type Replacer = string | ((m: RegExpExecArray) => string);

function appendRange(dst: number[], src: number[], from: number, to: number): void {
  for (let i = from; i < to; i++) dst.push(src[i]);
}

/** Regex replace that keeps `map` aligned (inserted chars map to the match start). */
function replaceMapped(rt: ReadingText, re: RegExp, rep: Replacer): ReadingText {
  const src = rt.text;
  let out = '';
  const map: number[] = [];
  let last = 0;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out += src.slice(last, m.index);
    appendRange(map, rt.map, last, m.index);
    const r = typeof rep === 'function' ? rep(m) : rep.replace(/\$(\d)/g, (_, d) => m![Number(d)] ?? '');
    const at = rt.map[m.index] ?? (map.length ? map[map.length - 1] : 0);
    for (let i = 0; i < r.length; i++) {
      out += r[i];
      map.push(at);
    }
    last = m.index + m[0].length;
    if (!re.global) break;
  }
  out += src.slice(last);
  appendRange(map, rt.map, last, src.length);
  return { text: out, map };
}

const GREEK: Record<string, string> = {
  α: 'alpha', β: 'beta', γ: 'gamma', δ: 'delta', ε: 'epsilon', ζ: 'zeta', η: 'eta', θ: 'theta',
  κ: 'kappa', λ: 'lambda', μ: 'mu', ν: 'nu', ξ: 'xi', π: 'pi', ρ: 'rho', σ: 'sigma', τ: 'tau',
  φ: 'phi', χ: 'chi', ψ: 'psi', ω: 'omega', Δ: 'delta', Σ: 'sigma', Ω: 'omega',
};

/** Symbols that mark a token as mathematics (not everyday prose punctuation). */
const MATH_SYM = /[=≠∑∏∫√∂∇∈∉⊂⊆⊇∀∃↦∞⊕⊗∘^_∥⟨⟩]/;
const SUBSUP = /[₀-₉ₐ-ₜ⁰-⁹ⁱⁿ⁺⁻ᵢ-ᵪⱼ]/;

/** Drop runs of mathematical tokens (inline equations, variable soup). */
function dropMath(rt: ReadingText): ReadingText {
  const tokens: Array<{ s: number; e: number; math: boolean; small: boolean }> = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rt.text))) {
    const t = m[0].replace(/^[("'[]+|[)"'\].,;:!?]+$/g, '');
    const raw = m[0];
    const math =
      MATH_SYM.test(t) || SUBSUP.test(t) ||
      (/^[\p{Script=Greek}]+\d*$/u.test(t) && t.length > 1) ||
      /(^|[^\p{L}])[a-zA-Z]\(\w{1,3}\)/u.test(raw) || /\w\[\w{1,3}\]/.test(raw);
    // Single letters / short numbers glue a run together ("x = a + b").
    const small = /^([a-zA-Z]|\d{1,3}|[+\-−*/×·<>≤≥±()]+)$/.test(t);
    tokens.push({ s: m.index, e: m.index + m[0].length, math, small });
  }
  const cuts: Array<[number, number]> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].math) continue;
    let a = i, b = i;
    while (a > 0 && (tokens[a - 1].math || tokens[a - 1].small)) a--;
    while (b < tokens.length - 1 && (tokens[b + 1].math || tokens[b + 1].small)) b++;
    // Keep a trailing sentence-ending period that was stuck to the last token.
    let end = tokens[b].e;
    const tail = rt.text.slice(tokens[b].s, end);
    const punct = /[.;:!?]+$/.exec(tail);
    if (punct) end -= punct[0].length;
    cuts.push([tokens[a].s, end]);
    i = b;
  }
  if (!cuts.length) return rt;
  let out = '';
  const map: number[] = [];
  let last = 0;
  for (const [s, e] of cuts) {
    out += rt.text.slice(last, s);
    appendRange(map, rt.map, last, s);
    last = e;
  }
  out += rt.text.slice(last);
  appendRange(map, rt.map, last, rt.text.length);
  return { text: out, map };
}

/** Apply the clean-reading rules (see block comment above). */
export function cleanForSpeech(input: ReadingText): ReadingText {
  let rt = input;
  const R = (re: RegExp, rep: Replacer) => (rt = replaceMapped(rt, re, rep));

  // 1. Links, DOIs, e-mail addresses.
  // (Lazy + lookahead so a sentence's final full stop isn't swallowed.)
  R(/\b(?:https?:\/\/|www\.)\S+?(?=[.,;:!?)\]]*(?:\s|$))/gi, '');
  R(/\b(?:doi|arxiv|isbn):?\s*\S+?(?=[.,;:!?)\]]*(?:\s|$))/gi, '');
  R(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '');
  // 2. Citations: [12], [3, 5–7], (Smith et al., 2019; Lee 2021).
  R(/\s?\[\d+(?:\s*[-–,]\s*\d+)*\]/g, '');
  R(/\s?\((?:see\s+|e\.g\.,?\s+)?(?:[A-Z][\p{L}'’-]+(?:\s+(?:et\s+al\.?|and|&)(?:\s+[A-Z][\p{L}'’-]+)?)?,?\s+(?:19|20)\d{2}[a-z]?[;,]?\s*)+\)/gu, '');
  // 3. Parenthetical references to figures/tables/equations/sections.
  R(/\s?\((?:see\s+|cf\.\s+)?(?:figs?\.?|figures?|tables?|tab\.|eqs?\.?|equations?|sections?|sec\.|appendix|§)\s*[\w.\-–, ]{0,16}\)/gi, '');
  // 4. Statistics parentheticals: (p < 0.05), (n = 120, SD = 3.1).
  R(/\s?\(\s*[\p{L}]{1,3}\s*[=<>≤≥]\s*[-\d.,]+(?:\s*[,;]\s*[\p{L}]{1,3}\s*[=<>≤≥]\s*[-\d.,]+)*\s*\)/gu, '');
  // 5. Footnote markers glued to words: word¹, word*, word†.
  R(/([\p{L})\].,;])[⁰¹²³⁴⁵⁶⁷⁸⁹*†‡§¶]+/gu, '$1');
  // 6. Inline maths.
  rt = dropMath(rt);
  // 7. Abbreviations (before sentence splitting, so their dots don't end sentences).
  R(/\be\.\s?g\.,?/gi, 'for example,');
  R(/\bi\.\s?e\.,?/gi, 'that is,');
  R(/\betc\.(?=\s+[a-z,;])/g, 'and so on');
  R(/\betc\./g, 'and so on.');
  R(/\bet\s+al\.?/g, 'and colleagues');
  R(/\bvs\.?(?=\s)/gi, 'versus');
  R(/\bcf\.\s?/gi, 'compare ');
  R(/\bapprox\.\s?/gi, 'approximately ');
  R(/\bresp\./gi, 'respectively');
  R(/\bw\.r\.t\./gi, 'with respect to');
  R(/\bFigs\.\s?/g, 'figures ');
  R(/\bFig\.\s?/g, 'figure ');
  R(/\bEqs\.\s?/g, 'equations ');
  R(/\bEq\.\s?/g, 'equation ');
  R(/\bSec\.\s?/g, 'section ');
  R(/\bCh\.\s?/g, 'chapter ');
  R(/\bVol\.\s?/g, 'volume ');
  R(/\bpp\.\s?(?=\d)/g, 'pages ');
  R(/\bp\.\s?(?=\d)/g, 'page ');
  R(/\bNo\.\s?(?=\d)/g, 'number ');
  R(/\bDr\.\s?/g, 'Doctor ');
  R(/\bProf\.\s?/g, 'Professor ');
  R(/\bMr\.\s?/g, 'Mister ');
  R(/\bMrs\.\s?/g, 'Missus ');
  R(/\bMs\.\s?/g, 'Miz ');
  R(/\bca\.\s?(?=\d)/g, 'about ');
  // 8. Symbols read as words.
  R(/(\d)\s*[–—-]\s*(\d)/g, '$1 to $2');
  R(/\s*%/g, ' percent');
  R(/\s*±\s*/g, ' plus or minus ');
  R(/≈\s*/g, 'about ');
  R(/~\s*(?=\d)/g, 'about ');
  R(/(\d)\s*[×x]\s*(\d)/g, '$1 by $2');
  R(/\s*≤\s*/g, ' at most ');
  R(/\s*≥\s*/g, ' at least ');
  R(/(\w)\s*<\s*(\w)/g, '$1 less than $2');
  R(/(\w)\s*>\s*(\w)/g, '$1 more than $2');
  R(/\s*°\s*C\b/g, ' degrees Celsius');
  R(/\s*°\s*F\b/g, ' degrees Fahrenheit');
  R(/\s*°/g, ' degrees');
  R(/\s*&\s*/g, ' and ');
  R(/\s*→\s*/g, ' to ');
  R(/[\p{Script=Greek}]/gu, (m) => (GREEK[m[0]] ? ` ${GREEK[m[0]]} ` : ''));
  // 9. Bullets, stray glyphs, tidy-up.
  R(/[•▪◦‣■□►▶✓✔✗✘※]/g, '');
  R(/\(\s*\)|\[\s*\]/g, '');
  R(/[ \t]+([,.;:!?])/g, '$1');
  R(/([,;:])(?:\s*[,;:])+/g, '$1');
  R(/[ \t]{2,}/g, ' ');
  return rt;
}
