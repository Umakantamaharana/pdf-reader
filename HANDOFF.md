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

## Recent fixes (most recent session)

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
