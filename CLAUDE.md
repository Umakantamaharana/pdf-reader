# CLAUDE.md

Engineering guide for anyone (humans or AI coding assistants) changing this repo. Read
it before making changes. For status and the release checklist see
[HANDOFF.md](./HANDOFF.md); for features see [README.md](./README.md).

## What this is

**sobelpdf** is a Manifest V3 Chrome extension: a keyboard-first PDF reader and
annotator.

- **Stack:** TypeScript + Vite + `@crxjs/vite-plugin`. No framework; plain DOM and
  classes.
- **Runtime libraries:** `pdfjs-dist` (rendering), `pdf-lib` (annotated export),
  `kokoro-js` + `@huggingface/transformers` / `onnxruntime-web` (neural TTS).

## Commands

```bash
npm install --onnxruntime-node-install-cuda=skip   # skip the optional CUDA download
npm run build       # tsc --noEmit THEN vite build → dist/   (run this to verify a change)
npm run typecheck   # tsc --noEmit only
npm run dev         # vite build --watch
```

There is **no test suite** and **no browser/E2E harness**. Correctness is verified by
`tsc`, a clean `vite build`, small `tsx` scripts for pure logic (e.g. `readingText.ts`),
and the manual smoke test in HANDOFF.md. Run `npm run build` after every change. To
check behaviour, load `dist/` unpacked in `chrome://extensions`.

## Hard constraints (MV3 — do not violate)

- **No remote code.** The CSP is `script-src 'self' 'wasm-unsafe-eval'; worker-src
  'self'`, so everything must be bundled. The pdf.js worker, the ONNX Runtime WASM and
  the voice worker are emitted locally by Vite; pdf.js cmaps and standard fonts ship in
  `public/pdfjs/`. Never add CDN scripts, fonts or icons. Icons are inline SVG
  (`src/ui/icons.ts`) and fonts are local system stacks.
- **ONNX WASM path:** transformers.js sets `env.backends.onnx.wasm.wasmPaths` to a
  jsDelivr URL on import, and ORT would `import()` its `.mjs` glue from there, which the
  CSP blocks. `kokoroWorker.ts` overrides it with `{ wasm: <local ?url> }`. Keep that
  override.
- **Reference bundled pdf.js assets by absolute URL** via
  `chrome.runtime.getURL('pdfjs/…')`, never a relative path. The viewer lives under
  `/src/viewer/`, so relative paths 404.
- **No blob: workers.** Workers must be bundled files
  (`new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })`). ORT runs
  single-threaded (`numThreads = 1`) because the pages are not cross-origin isolated.
- Anything in `public/` is copied to the extension root. If a page fetches it, it must
  also be listed under `web_accessible_resources`.
- **Permissions are minimal on purpose** (the store rejects unused ones). Don't add a
  permission without code that uses it, and add its justification to HANDOFF.md.

## Core architecture & data flow

- **`core/schema.ts` is the single source of truth.** It defines `AppSettings`,
  `DEFAULT_SETTINGS` and `COMMANDS` (the command catalogue with default keys).
  - Command **ids are persisted** in keymaps, so keep them stable and add new ones by
    appending.
  - `defaultKeys` may list alternatives separated by `|`.
- **Settings** (`core/settings.ts`) is a reactive singleton.
  - `get(path)` / `set(path, v)` / `patch({...})` use dot-paths.
  - `subscribe(path, fn)` fires for that path, its ancestors and its descendants.
    Changes in other contexts sync via `chrome.storage.onChanged`.
  - Stored data is deep-merged over defaults, so **adding a field auto-back-fills**.
    Arrays are replaced, not merged. Use `migrations[version]` and bump `SCHEMA_VERSION`
    only for shape changes (v1→v2 replaced the colour presets).
- **Commands** (`core/commands.ts`): `commands.dispatch(id)` runs a handler. Handlers
  are registered in **`viewer/viewer.ts` → `registerCommands()`**. The toolbar, bars,
  palette and keyboard all dispatch, so they stay in sync.
- **Shortcuts** (`core/shortcuts.ts`) map canonical chords and sequences to command ids.
  - Every ctrl chord gets a ⌘ twin on macOS.
  - Shifted symbols are matched by their character (`?`, and `plus` for `+`).
  - The Settings keymap capture uses the same `eventToChord`.
- **`viewer/pdfViewer.ts`** owns rendering state (`ViewerState`) and emits `onChange`.
  - Other engines react to `onPageRendered(pageNum)`, which fires when a page's canvas
    and text layer finish. Search re-paints, dark mode re-protects images, annotations
    re-draw.
  - **A per-page overlay must hook `onPageRendered`** to survive zoom, layout changes
    and eviction.
- **The dock** (`ui/dock.ts`) is the single toolbar slot. The main toolbar and every
  sub-toolbar (annotation, read-aloud, night mode, find) are faces of one drum:
  `dock().open(name)` rolls forward, `close(name)` rolls back, and faces stack. Don't
  position a bar yourself; register a face.
- **Theme:** `darkmode.ts` toggles `body.lumen-dark`, and every UI colour is a CSS token
  that switches with it (`viewer.css` / `settings.css` / popup).

## Rendering, zoom & layout

- **Pages live in `.pdf-content` inside the scroller.** Append pages to `content`, not
  to the scroller.
- **Double-buffered canvases:** `doRenderPage` draws into a detached canvas and swaps it
  in. Canvases are sized to integer device pixels (`pixelBox`). Don't cache a page's
  `<canvas>`; it's replaced on every render.
- **Render guard:** each entry has `pending` (shared in-flight render) and `gen`
  (invalidation counter). Stale renders discard their result. Keep both when touching
  `renderPage`.
- **Zoom = GPU preview, then commit** (`zoomTo` / `commitZoom`): a `transform: scale()`
  on `.pdf-content`, then the real boxes resize around the same anchor in one frame and
  re-render. `renderPage` does nothing while `animating`.
- **Sidebar resize = FLIP** (`flipResize`): the margin changes instantly, the layout is
  applied once, then the difference plays back as a transform.
- **Centring:** block layout + `margin-left: round(…)` snapped to `--dpx`, not flexbox.
  Flex centring clips the left side of a zoomed page.
- **Smooth scroll** is a rAF tween in `scrollBy`, gated on the scroller's `.smooth`
  class.
- **Canvas eviction:** pages more than `KEEP_MARGIN` away are freed and re-render
  (re-firing `onPageRendered`) when they come back.
- **Links:** `renderLinks` places hit boxes in percent of the page. Internal jumps go
  through `followLink` (Back/Forward history); the outline uses it too.
- **Text selection:** `selectionGuard.ts` (ported from pdf.js) must be re-attached
  whenever a text layer re-renders. `::selection` keeps `color: transparent` so the
  fallback font never shows.

## Coordinate model (annotations)

Annotations are stored **independently of scale**:

- Text marks store **page fractions `[0..1]`**. Strokes and shapes store **PDF points**
  against an SVG `viewBox="0 0 W H"`.
- Overlays sit in `.annot-rot`, sized to the **unrotated** page and rotated by CSS.
  Pointer input is inverse-mapped (`clientToFrac`). `getPageSize()` is the unrotated,
  scale-1 size.
- **Colours are stored in "paper" (light-theme) form.** `stored()` and `shown()` swap
  pure black and white in dark mode (`swapBW`). Tool colours in settings are *screen*
  colours, per theme (`annotation.colors.light|dark`).
- **Text marks** take their boxes from text-node ranges only (`textRects`), merged per
  line. Don't use `range.getClientRects()` directly; it doubles the boxes.
- **Export** (`exportPdf`) uses pdf-lib and flips Y (pdf.js is top-left origin, pdf-lib
  bottom-left). Text boxes and notes use the closest standard font.

## Read aloud

- **`tts.ts` reads `readingText.ts` output, not raw page text.**
  - `buildReadingText` filters non-prose lines.
  - `cleanForSpeech` applies the Clean rules (`tts.readingMode`) on `(text, map)`
    *before* sentence splitting.
  - `map` converts spoken offsets back to page offsets for highlighting. Never index
    page text with spoken offsets.
- **Neural voice:** `KokoroClient` is a handle to `kokoroWorker.ts`; one client is one
  model on one device. `dispose()` frees its memory, including GPU memory.
  - Device order comes from `tts.device` (auto / gpu / cpu).
  - A GPU error or NaN/silent output triggers `fallBackToCpu`.
  - The browser voice is used while loading or if the neural voice fails.
- **Look-ahead buffer** (`fillBuffer`, `tts.lookahead`): one clip at a time, keyed by
  voice|speed|text, cleared on stop and on speed changes.
- **`src/shim/node-empty.ts`** stubs `fs/promises` and `path` (aliased in
  `vite.config.ts`) because kokoro-js imports them on an unused server code path.

## UI conventions

- **Glassmorphism** for every bar, panel and popover: the `--glass-*` tokens.
- **Shared shape and motion tokens:** `--bar-radius`, `--panel-radius`, `--bar-height`,
  `--btn-size`, `--motion-in/out/ease`, `--theme-fade`. Keep bars visually identical.
- **Animate, don't pop:**
  - Popovers leave via `dismiss(el)` and toggle via `setOpen(el, bool)` (`ui/motion.ts`).
  - Bars use the dock.
  - Don't toggle `hidden` or call `.remove()` directly on visible UI.
- **No brand blue:** the accent is a neutral ink (`--accent` / `--accent-ink`). Content
  colours (palettes, search and TTS highlights) are the exception.
- **Tooltips:** set `title`; `ui/tooltip.ts` turns it into the styled tooltip.
- Every file starts with a header comment explaining its role. Keep it current.
- Prefer the existing settings, command and subscribe plumbing over ad-hoc state.

## How to…

- **Add a command:**
  1. Append it to `COMMANDS` in `schema.ts`.
  2. Register its handler in `viewer.ts` → `registerCommands`.
  3. Optionally add a button with `icon(...)`.
- **Add a setting:**
  1. Add the field to `AppSettings` + `DEFAULT_SETTINGS` (it back-fills).
  2. Add a control to `SECTIONS` in `src/ui/settings.ts` if users should edit it.
  3. Read it with `settings.get()` and react with `settings.subscribe()`.
- **Add a sub-toolbar:** build the bar element, then `dock().register('name', el)`. Open
  and close it with `dock().open/close`, and handle Esc in the `app.escape` command.
- **Add an icon:** add the inner SVG paths to `PATHS` in `src/ui/icons.ts` (24×24,
  stroke-based, `currentColor`).

## Commits

- Author: **Umakanta Maharana** `<umakantamaharana70@gmail.com>` (the repo's git
  config).
- Do **not** add AI attribution trailers (no `Co-Authored-By` lines for assistants).
- Use a short imperative subject line; the body groups changes by area.
- Bump `version` in `manifest.json` + `package.json` for every store upload.
