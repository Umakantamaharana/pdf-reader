# CLAUDE.md

Guidance for AI agents (and humans) working in this repo. Read this before making
changes.

## What this is

**Lumen PDF** — a Manifest V3 Chrome extension: a keyboard-first PDF reader and
annotator. TypeScript + Vite + `@crxjs/vite-plugin`. Runtime libs: `pdfjs-dist`
(render), `pdf-lib` (annotation export), `kokoro-js` + `@huggingface/transformers`
(neural TTS). No framework — plain DOM and classes.

## Commands

```bash
npm install
npm run build       # tsc --noEmit THEN vite build → dist/   (run this to verify a change)
npm run typecheck   # tsc --noEmit only
npm run dev         # vite build --watch (dev mode)
```

There is **no test suite** and **no browser/E2E harness** — correctness is verified by
`tsc` + a clean `vite build`, and by reasoning about the coordinate math. After any
change, run `npm run build` and make sure it's green. Load/verify manually via
`chrome://extensions` → Load unpacked → `dist/`.

## Hard constraints (MV3 — do not violate)

- **No remote code.** CSP is `script-src 'self' 'wasm-unsafe-eval'`. Everything must be
  bundled. The pdf.js worker and ONNX WASM are emitted locally by Vite; pdf.js cmaps +
  standard fonts ship in `public/pdfjs/`. Do **not** add CDN `<script>`/font/icon
  dependencies. Icons are inlined SVG (`src/ui/icons.ts`) for exactly this reason.
- **Reference bundled pdf.js assets by absolute URL** via `chrome.runtime.getURL('pdfjs/…')`,
  never a relative path (the viewer lives under `/src/viewer/`, so relative paths 404).
- **No blob: workers** — onnxruntime runs single-threaded on the main thread
  (`wasm.numThreads = 1; wasm.proxy = false`); WebGPU is used when available.
- Anything added to `public/` is copied to the extension root and must also be listed
  under `web_accessible_resources` in `manifest.json` if the page fetches it.

## Core architecture & data flow

- **`core/schema.ts` is the single source of truth.** It defines `AppSettings`
  (the whole settings model + `DEFAULT_SETTINGS`) and `COMMANDS` (the command catalog
  with default keybindings). Command **ids are persisted** in keymaps/history — keep
  them stable; add by appending.
- **Settings** (`core/settings.ts`) is a reactive singleton. `settings.get(path)` /
  `settings.set(path, v)` use dot-paths; `settings.subscribe(path, fn)` fires on that
  path or any ancestor/descendant, and cross-context changes sync via
  `chrome.storage.onChanged`. Stored data is deep-merged over `DEFAULT_SETTINGS`, so
  **adding a field to the schema auto-back-fills existing users** (no migration needed
  for additive changes; use `migrations[version]` only for shape changes +
  bump `SCHEMA_VERSION`).
- **Commands** (`core/commands.ts`): `commands.dispatch(id)` runs a handler. Handlers
  are registered in **`viewer/viewer.ts` → `registerCommands()`** — this is where ids
  become behavior. The toolbar, annotation bar, palette, and keyboard all go through
  `dispatch`, so UI and keyboard stay in sync automatically.
- **Shortcuts** (`core/shortcuts.ts`) maps canonical chords/sequences → command ids and
  calls `dispatch`. It knows nothing about what commands do.
- **`viewer/pdfViewer.ts`** owns rendering state (`ViewerState`) and emits via
  `onChange`. Other engines attach as layers and react to `onPageRendered(pageNum)`
  (fired when a page's canvas + text layer finish) — search re-paints highlights, dark
  mode re-applies image protection, annotations re-draw. **If you add a per-page
  overlay, hook `onPageRendered`** so it survives zoom/layout/eviction re-renders.

## Coordinate model (important for annotations)

Annotations are stored **scale-independently** so they survive zoom with no re-render:

- Text marks (highlight/underline/strike) store **page-relative fractions `[0..1]`**.
- Vector strokes/shapes store **PDF points** against an SVG `viewBox="0 0 W H"`.
- Overlays live in a `.annot-rot` wrapper **sized to the unrotated page and rotated by
  CSS** to match the canvas; pointer input is inverse-mapped through the rotation
  (`clientToFrac`). `getPageSize()` returns the unrotated (scale 1, rotation 0) size —
  the coordinate space everything is stored in.

Export (`annotations.ts → exportPdf`) bakes annotations into a copy of the PDF with
pdf-lib, flipping Y (pdf.js is top-left origin, pdf-lib is bottom-left).

## Gotchas worth knowing

- **Centering vs. zoom clip:** the page scroller uses **block layout + `margin:auto`**,
  not flexbox centering — flex `align-items:center` pushes an overflowing (zoomed) page
  off-screen on both sides and clips the left. Don't reintroduce flex centering there.
- **Smooth scroll** is a custom rAF tween in `pdfViewer.scrollBy` (CSS
  `scroll-behavior:smooth` is unreliable / ignored under reduced-motion). It's gated on
  the container's `.smooth` class (toggled from `viewing.smoothScroll`).
- **Canvas eviction:** pages more than `KEEP_MARGIN` from the viewport have their canvas
  freed; they re-render (and re-fire `onPageRendered`) on return. Don't assume a page
  that rendered once is still rendered.
- **Dark-mode image protection** uses `backdrop-filter` to re-invert image regions
  (Chrome-only) and only engages in `smart-invert` mode. Regions come from
  `pdfViewer.getImageRegions()` (replays the operator list, transform-tracked).
- **TTS** lazy-loads Kokoro and falls back **WebGPU → WASM → native browser voice**;
  native is used while the model downloads. `space` is bound to play/pause.
- **`src/shim/node-empty.ts`** stubs `fs/promises` and `path` (aliased in
  `vite.config.ts`) because kokoro-js statically imports them on a dead server path.

## How to…

- **Add a command:** append to `COMMANDS` in `schema.ts` (id, title, category,
  defaultKeys) → register its handler in `viewer.ts/registerCommands` → (optional) add a
  toolbar/annotation-bar button with an `icon(...)`.
- **Add a setting:** add the field to `AppSettings` + `DEFAULT_SETTINGS` in `schema.ts`
  → it auto-back-fills; add a control to `src/ui/settings.ts` `SECTIONS` if it should be
  user-editable; read it with `settings.get()` and react with `settings.subscribe()`.
- **Add an icon:** add the inner SVG paths to `PATHS` in `src/ui/icons.ts`; use
  `icon('name')` as `innerHTML`. Keep stroke-based, 24×24, `currentColor`.

## Conventions

- Keep the **glassmorphism** look consistent: new bars/panels/popovers use the
  `--glass-*` tokens (translucent bg + `backdrop-filter: var(--glass-blur)` + hairline
  border + shadow + inner highlight). Both `viewer.css` and `settings.css` share the
  palette/accent.
- Files are self-documenting with a header comment explaining their role — preserve/add
  one when creating files.
- Prefer the existing settings/command/subscribe plumbing over ad-hoc state.

## Attribution for commits

End commit messages with:

```
Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```
