# HANDOFF.md

Current status, recent work, and open issues for **Lumen PDF**. Last updated
**2026-11-26**.

## Status at a glance

Builds clean (`npm run build` — `tsc --noEmit` + `vite build` both green) and loads as
an unpacked MV3 extension. All major features are implemented and wired. The items in
**Known issues / TODO** below are the remaining gaps.

## What works

- pdf.js rendering with lazy canvas + text layer, off-screen canvas eviction.
- Layouts: single / two-page / continuous (`l` to cycle; toolbar icon reflects mode).
- Zoom: fit-width / fit-page / actual, Ctrl+wheel & trackpad-pinch zoom, zoom anchoring.
- Smooth animated scrolling on arrows / half-page (rAF tween).
- Rotation in 90° steps with aligned annotations and image protection.
- Dark mode: `smart-invert` (with image protection), `custom-colors`, `off`; presets;
  brightness/contrast; display panel + settings both drive it.
- Annotations: highlight, underline, strike, pen, rectangle, ellipse, arrow, note,
  textbox, stamp/signature; middle-click eraser; undo/redo; autosave; PDF export.
- Find-in-document (case / whole-word / regex / highlight-all) via CSS Highlight API.
- Thumbnail sidebar (`s`) with lazy render + current-page highlight.
- TTS: Kokoro neural (WebGPU→WASM→native fallback) with sentence/word highlighting.
- Command palette (`Ctrl+K`), full re-bindable keymap, import/export settings, local↔sync.
- pdf.js cmaps + standard fonts bundled (`public/pdfjs/`) → correct CJK/standard-font PDFs.

## Recent fixes (2026-11-27)

- **Kokoro never actually ran** — transformers.js pointed ONNX Runtime at a jsDelivr CDN
  and the MV3 CSP blocked the remote `.mjs`, so both WebGPU and WASM failed. Now uses the
  locally bundled `.wasm`. Also prefetches the next sentence, fixes speed-nudge doubling.
- **TTS reads like a person** (`viewer/readingText.ts`, `tts.skipNonProse`): skips chart /
  axis labels, numeric lines, running headers/footers, page numbers, text over images;
  joins lines with spaces, de-hyphenates, pauses after headings.
- **TTS bar close (×) button**; Stop no longer hides the bar.
- **Zoom flicker** — pages are double-buffered and re-rendered once the zoom settles
  (140 ms); the stale canvas stretches meanwhile.
- **Small-text shimmer** — canvases sized to whole device pixels, page left edge snapped
  to the device-pixel grid, re-render on DPR change (monitor/browser zoom).
- **Render race** (two renders on one canvas) and **rotated text layer** misalignment.
- **Dark mode**: sidebar thumbnails follow it; 0.45 s cross-fade on toggle; single
  **Soft Night** theme (brightness 1, contrast 0.6) replaces the 4 presets (schema v2
  migration); dark `<select>` popups in viewer + settings.

- **Doubled multi-line highlight/underline/strike** — `range.getClientRects()` returned
  span border boxes *and* their text rects; marks now use text-node rects only, merged
  per line (`annotations.ts → textRects / mergeLineRects`).
- **Annotation bar close (×)** button.
- **Flashing toolbar tooltips** — native `title` tooltips replaced by one styled,
  delayed tooltip (`ui/tooltip.ts`); the layout button no longer rewrites itself on
  every page/zoom change.
- **Sidebar Contents tab** — PDF outline as a collapsible tree next to Pages; jumps to
  the exact heading (`pdfViewer.goToDestination`) and marks the current section.

- **Text box**: focuses on placement (add() is async — the element was looked up before
  it existed); click = edit with caret, drag = move, right-click inert (no browser menu),
  clicking away only finishes editing (no stray new box), empty boxes are removed.
- **Layout-cycle white flash in dark mode** — unpainted page boxes now use the filtered
  page colour instead of `#fff`.
- **Sub-toolbars on top** — annotation + read-aloud bars share `ui/topStack.ts`; the
  Display panel opens top-right.
- **UI follows the page theme** — light chrome when dark mode is off, dark when on
  (`body.lumen-dark` tokens in `viewer.css` / `settings.css` / popup), neutral accent
  (no blue), cross-faded; unused `ui.theme` control removed from Settings.
- **Black↔white annotation swap in dark mode** (`swapBW`); colours are stored in
  light-theme ("paper") form so export is unchanged.

- **Dock with roll animation** — sub-toolbars replace the main toolbar (roll forward),
  closing rolls back; Esc closes the topmost. Night mode is now a toolbar, not a popup.
- **Fit width / fit height** buttons; **animated zoom** anchored on the viewport centre
  (Ctrl+wheel anchors on the cursor). Toolbar readout is just the page (click → go to).
- **Shortcuts remapped to common conventions** (Acrobat / Chrome PDF / browsers /
  VS Code / Edge Read Aloud); `?`/shifted-symbol bindings now actually fire.
- Tooltip: longer first delay, instant for neighbours, never on a rolling face.

- **Kokoro WebGPU out-of-memory** (`VK_ERROR_OUT_OF_DEVICE_MEMORY` + cascading "Invalid
  Buffer" errors on low-VRAM GPUs): GPU device errors / NaN-or-silent output now trigger a
  reload on WASM, and `tts.preferWebGPU` is switched off. Long sentences are synthesised in
  ≤220-char chunks to cap per-call memory.
- **Erase all annotations** (`annot.clearAll`, undoable): trash button in the annotation
  bar, double-click the eraser button, double middle-click on a page, or Ctrl+Shift+Del.

- **Toolbar invisible on first load** — the dock only set a face's angle when rolling, so
  the initial main face sat at 90° (edge-on). Faces now register at their resting angle.
  Toggling the toolbar (`t`) tips it away/back instead of display:none; the reveal handle fades.
- **Sidebar slides** in/out (0.32 s) and the pages re-fit every frame while it moves
  (`pdfViewer.animateResize`) — no scale jump, no transient horizontal scrollbar.

- **Consistent, animated panels** — find bar moved into the dock (same spot/roll as other
  bars); command palette fades + lifts; note editor pops in/out; messages fade in/out one at
  a time above the toolbar; error banner drops in. All bars share height/padding/radius/
  button size (tokens in `viewer.css`). Toolbar toggle buttons show an animated on/off state.

- **Jumpy text selection** — ported pdf.js's selection guard (`.endOfContent` block moved
  after the selection focus) so dragging over gaps no longer grabs the rest of the page.
- **Choppy zoom on low-end machines** — zoom now animates as a compositor-only CSS transform
  on `.pdf-content` and commits the real layout once at the end (Ctrl+wheel/pinch too).
  Sidebar open/close now uses the same idea (FLIP: `pdfViewer.flipResize`).
- **Colour palette popover** (`ui/colorPicker.ts`): theme-aware preset swatches + hue/shade
  sliders + native "Custom…". Colours are stored **per theme** (`annotation.colors.light|dark`):
  ink defaults black (light) / white (dark), pen black / green, highlighter yellow.
- **Erase menu** (trash): in view / this page (Shift+Del) / everything (Ctrl+Shift+Del); all
  one undo step each.

## Earlier fixes

- **TTS fell back to the browser voice even after the model downloaded** — root cause
  was WebGPU building its inference session failing with no WASM retry. `ensureKokoro`
  now tries **WebGPU → WASM → native** in order. (`viewer/tts.ts`)
- **Zoom "clip"** — a zoomed page shifted left with parts unreachable. Switched the page
  scroller from flexbox centering to **block layout + `margin:auto`**. (`viewer/viewer.css`)
- **Arrow-key scroll jumped** — replaced CSS-smooth reliance with a **rAF scroll tween**.
  (`viewer/pdfViewer.ts`)
- **Ctrl/trackpad-pinch zoom** added (`wheel` + ctrlKey, rAF-throttled). (`viewer/viewer.ts`)
- **Zoom anchoring** so the page keeps its place across zoom re-renders.
- **Sidebar implemented** (the ☰ / `s` toggle previously did nothing). (`ui/sidebarPanel.ts`)
- **Circle/ellipse tool** was dead — it was missing from the pointer-capture list. (`viewer/annotations.ts`)
- **Note export** drew a stray filled square — now a round marker matching the UI.
- **Dark native scrollbars** (`color-scheme: dark` + styled webkit scrollbars).
- **Glassmorphism pass** across all bars/panels + **inline Lucide-style SVG icons**
  (`ui/icons.ts`); layout toolbar icon updates per mode.
- **Settings page restyled** to match the viewer's glass theme. (`ui/settings.css`)
- Earlier: pdf.js **cmaps/standard_fonts bundling** + absolute `getURL` paths; canvas
  eviction; `presize` parallelized; robust `?file=` decode; drop-zone error handling.

## Known issues / TODO

1. **Dark mode `custom-colors` is low-quality.** It multiplies the chosen background over
   a non-inverted canvas → dark text on a dark background (hard to read), and a single
   blend can't serve both dark presets and the light sepia preset. **`smart-invert` is
   the working, default mode.** Fixing custom-colors needs per-preset blend logic and a
   real browser to eyeball. (`viewer/darkmode.ts`)
2. **TTS model download UX.** First play with the Kokoro engine downloads a few hundred
   MB from Hugging Face (browser voice meanwhile). Consider defaulting `tts.engine` to
   `native`, or gating the download behind an explicit opt-in. `space` triggering it is a
   product decision to revisit.
3. **ESLint not installed.** `npm run lint` is defined but ESLint isn't a devDependency —
   add `eslint` + a config, or drop the script.
4. **No automated tests / browser harness.** Verification is `tsc` + `vite build` only.
   The glass blur, rotated-page highlights, and `backdrop-filter` image protection have
   not been machine-verified — eyeball them in Chrome.
5. **Rotated-page highlights paint above text** (cosmetic; the rotation wrapper forms a
   stacking context). Semi-transparent, so still readable.
6. **Offscreen document is a stub.** `offscreen/offscreen.ts` + `ensureOffscreen()` are
   scaffolding for future background TTS and currently unused.
7. **Manifest cleanup.** `web_accessible_resources` lists `models/*` and `wasm/*`
   patterns that nothing emits (harmless, but dead).
8. **declarativeNetRequest redirect** substitutes the raw matched URL (`\0`) unencoded
   into `?file=`; fine for typical URLs but could mangle ones with unusual characters.
9. **No LICENSE file** — add one before distributing.

## Build / run / verify

```bash
npm install
npm run build          # must be green before committing
# chrome://extensions → Developer mode → Load unpacked → select ./dist
```

Manual smoke test: open a PDF → scroll with ↓/↑ (should glide) → zoom in past page
width (left edge reachable) → Ctrl/pinch zoom → `s` sidebar → `a` then draw a circle →
`Shift+I` dark mode on a page with a photo (photo stays positive) → `Ctrl+F` search →
`Space` read-aloud → `Ctrl+S` export and check the annotations in the output PDF.

## Repo / git

- `main` branch; `node_modules/` and `dist/` are git-ignored; `public/pdfjs/` **is**
  committed so the repo builds self-contained.
- Remote: `https://github.com/Umakantamaharana/pdf-reader.git` (push needs a GitHub PAT
  over HTTPS — password auth is not supported).
