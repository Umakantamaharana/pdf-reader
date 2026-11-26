# Lumen PDF — Keyboard-First Reader & Annotator

A fast, private, keyboard-driven PDF reader and annotator built as a **Manifest V3
Chrome extension**. Everything runs locally: rendering, annotations, dark mode, and
even neural text-to-speech work offline, with no page content ever sent to a server.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178c6) ![pdf.js](https://img.shields.io/badge/pdf.js-4.x-red)

---

## Features

- **Rendering** — pdf.js engine with lazy per-page canvas rendering, a selectable/
  searchable text layer, and off-screen canvas eviction so large documents stay light.
- **Layouts** — single page, two-page spread, and continuous scroll (press `l` to cycle).
- **Zoom & fit** — fit-width / fit-page / actual size, **Ctrl + wheel and trackpad
  pinch** zoom, and zoom anchoring so the page keeps its place.
- **Smooth scrolling** — a real animated glide on arrow keys / half-page scroll
  (works even under `prefers-reduced-motion`).
- **Rotation** — 90° steps, with annotations and image protection kept aligned.
- **Smart dark mode** — GPU-composited CSS-filter inversion with **image protection**
  (photos/diagrams are re-inverted so they don't look like negatives), custom color
  presets, and live brightness/contrast.
- **Annotations** — highlight, underline, strikethrough, pen, rectangle, ellipse,
  arrow, sticky notes, text boxes, and image/signature stamps. Middle-click eraser,
  undo/redo, autosave to `chrome.storage`, and **export to a flattened PDF** (pdf-lib).
- **Find in document** — case-sensitive, whole-word, and regex search with
  highlight-all, painted via the CSS Custom Highlight API (no DOM mutation).
- **Thumbnail sidebar** — lazy page thumbnails; click to jump (toggle with `s`).
- **Text-to-speech** — on-device **Kokoro-82M** neural voice (WebGPU → WASM →
  browser-voice fallback) with sentence/word highlighting and adjustable speed.
- **Command palette** — `Ctrl+K` fuzzy launcher for every action.
- **Fully re-bindable keymap** — chords and Vim-style sequences (`g g`, `z z`),
  edited live on the Settings page with conflict detection.

---

## Install (from source)

Requires Node 18+ and Chrome/Chromium **116+**.

```bash
npm install
npm run build        # type-checks, then builds the extension into ./dist
```

Then load it in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the **`dist/`** folder
4. (Optional) On the extension card, enable **Allow access to file URLs** to open
   local `file://` PDFs.

Open a PDF by navigating to any `.pdf` URL (it redirects into the reader), via the
right-click **"Open in Lumen PDF"** menu, the toolbar popup, or `Alt+Shift+P` on a
PDF tab. With no file, the reader shows a drag-and-drop zone.

### Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | `vite build --watch` (development mode) — rebuilds `dist/` on change |
| `npm run build` | `tsc --noEmit && vite build` — production bundle |
| `npm run typecheck` | Type-check only |
| `npm run lint` | ESLint (see *Known limitations* — ESLint isn't yet a dependency) |

---

## Default keyboard shortcuts

Navigation: `j`/`k` next/prev page · `g g` first · `Shift+G` last · `Ctrl+G` go to page
· `d`/`u` half-page · `↓`/`↑` line scroll.

View: `Ctrl+=`/`Ctrl+-` zoom · `Shift+W` fit width · `Shift+F` fit page · `r`/`Shift+R`
rotate · `l` cycle layout · `s` sidebar · `t` toolbar · `z z` distraction-free · `F5`
presentation.

Dark mode: `Shift+I` toggle · `Shift+D` display panel · `Shift+P` cycle preset.

Annotation: `a` toggle mode · `h` highlight · `Shift+U` underline · `Shift+S` strike ·
`p` pen · `Shift+O` box · `Shift+C` circle · `Shift+A` arrow · `n` note · `Shift+T` text
· `Shift+M` stamp · `e` eraser · `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo · `Ctrl+S` export.

TTS: `Space` play/pause · `Shift+Space` stop · `Ctrl+←`/`Ctrl+→` sentence · `[`/`]`
speed · `Shift+Enter` read from cursor.

Search: `Ctrl+F` or `/` find · `Ctrl+N`/`Ctrl+Shift+N` next/prev.

General: `Ctrl+K` command palette · `Ctrl+,` settings · `?` shortcut help.

All of these are editable on the Settings page (`Ctrl+,` → *Shortcut Keymap*).

---

## Architecture

Vite + `@crxjs/vite-plugin` bundle the MV3 extension. The pdf.js worker and the
ONNX/WASM runtime are emitted locally, and pdf.js cmaps + standard fonts are shipped
in `public/pdfjs/`, so **no remote code is ever fetched** (required by the MV3 CSP).

```
src/
  core/
    schema.ts        Single source of truth: settings model + command catalog + default keymap
    settings.ts      Reactive settings engine (chrome.storage, deep-merge, migrations, subscribe)
    commands.ts      Command registry + dispatcher (ids → handlers)
    shortcuts.ts     Keyboard engine (chord + Vim-sequence resolution)
  viewer/
    viewer.ts        Entry point — wires every engine and registers command handlers
    pdfViewer.ts     Render engine: lazy canvas, layouts, zoom/fit/rotation, eviction, smooth scroll
    darkmode.ts      CSS-filter dark mode + image-region re-inversion
    annotations.ts   Annotation layer, eraser, undo/redo, pdf-lib export
    search.ts        Find-in-document (CSS Custom Highlight API)
    tts.ts           Read-aloud (Kokoro neural + native fallback)
    viewer.html/css  Reader shell + styles
  ui/
    toolbar.ts  annotationBar.ts  displayPanel.ts  sidebarPanel.ts
    commandPalette.ts  settings.ts  popup.ts  icons.ts (inline SVG set)
  background/
    service-worker.ts  MV3 coordinator: PDF redirect rule, context menu, commands
  offscreen/           Offscreen-document scaffold (reserved for background TTS)
  shim/node-empty.ts   Stubs Node built-ins that kokoro-js statically imports
public/pdfjs/          Bundled pdf.js cmaps + standard_fonts (shipped to the extension root)
manifest.json  vite.config.ts  tsconfig.json
```

For contributor conventions and gotchas see **[CLAUDE.md](./CLAUDE.md)**; for current
status and open issues see **[HANDOFF.md](./HANDOFF.md)**.

---

## Privacy

Lumen PDF reads only the document you open and stores settings + annotations in
`chrome.storage` (local by default, optionally synced to your Chrome account). Page
content is never transmitted. The only network request the extension can make is a
**one-time download of the Kokoro TTS model** from Hugging Face, and only if you start
read-aloud with the neural engine selected; it's cached after that and the browser
voice is used in the meantime.

## License

Not yet specified — add a `LICENSE` file before distributing.
