# Lumen PDF — Keyboard-First PDF Reader & Annotator

A fast, private PDF reader and annotator for Chrome (Manifest V3). Everything runs on
your computer: rendering, annotations, dark mode and even the neural read-aloud voice.
No page content is ever sent to a server.

Built with TypeScript, Vite and `@crxjs/vite-plugin`, on top of
[pdf.js](https://mozilla.github.io/pdf.js/) (rendering), [pdf-lib](https://pdf-lib.js.org/)
(annotated export) and [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
via `kokoro-js` (on-device text-to-speech).

> **Status:** v1.0.0 · private repository · © Umakanta Maharana, all rights reserved.

---

## Contents

- [Features](#features)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Install from source](#install-from-source)
- [Building a release](#building-a-release)
- [Settings](#settings)
- [Privacy](#privacy)
- [Architecture](#architecture)
- [Project docs](#project-docs)

---

## Features

### Reading

- **Opens PDFs automatically.** Any `.pdf` link or tab opens in Lumen. You can also
  right-click → *Open in Lumen PDF*, use the toolbar popup (paste a URL), press
  `Alt+Shift+P` on a PDF tab, or drag a file onto the empty reader. Local files work
  once *Allow access to file URLs* is turned on for the extension.
- **Three layouts:** continuous scroll, single page, and two-page spread (`l` cycles).
- **Fit width, fit height, fit whole page, 100%**, plus zoom in/out. Zoom is animated on
  the GPU, so it stays smooth on low-end laptops. Ctrl + scroll and trackpad pinch zoom
  around the cursor.
- **Crisp text at every size:** pages are drawn at the screen's exact pixel density,
  including 125% / 150% display scaling, and redrawn if the window moves to another
  monitor.
- **Smooth scrolling** on arrow keys, Space and page jumps.
- **Rotation** in 90° steps, with annotations, links and text selection kept aligned.
- **Working PDF links:** contents pages, cross-references, footnotes and web links are
  clickable. Back / Forward (`Alt+←` / `Alt+→`) return you to where you were, like a
  browser.
- **Sidebar** (`s`) with two tabs:
  - *Pages:* live thumbnails; the current page is highlighted.
  - *Contents:* the PDF's table of contents as a collapsible tree. It jumps to the exact
    heading and marks the section you're reading.
- **Find in document** (`Ctrl+F`): case-sensitive, whole-word and regex modes, with every
  match highlighted.
- **Smooth text selection:** dragging across gaps between words no longer jumps to the
  rest of the page, and selected text keeps the PDF's own lettering.
- **Large documents stay fast:** pages are drawn lazily and off-screen pages release
  their memory.

### Night mode

- **One-key dark mode** (`Shift+D`) using *smart invert*. The page is inverted on the
  GPU, and photos and diagrams are re-inverted so they don't look like negatives.
- **"Soft Night" theme** (brightness 1, contrast 0.6): light-grey text on charcoal,
  easy on the eyes.
- **Night-mode toolbar** (`Alt+Shift+D`): mode, theme, live brightness and contrast
  sliders, and image protection.
- **The whole interface follows the theme:** toolbars, sidebar, menus, the Settings page
  and the popup switch between light and dark with a gentle cross-fade.
- **Sidebar thumbnails** are dark in dark mode too.

### Annotations

- **Tools:** highlight, underline, strikethrough, pen, box, circle, arrow, sticky note,
  text box, and image/signature stamp.
- **Colour palette:** preset swatches tuned to the current theme (deep inks on paper,
  bright inks on a dark page, highlighter pastels), a hue slider and a shade slider, and
  a custom colour picker.
- **Sensible defaults per theme:** black ink in light mode; white ink and a green pen in
  dark mode; yellow highlighter. Black and white annotations swap automatically when you
  change theme, so ink always stays visible.
- **Text boxes and notes** with font family (Sans, Serif, Mono, Handwriting) and size
  (6–72 pt). Changes apply live to the box you're editing.
- **Editing:** click a text box to type, drag to move, Esc to finish. Empty boxes
  disappear on their own.
- **Erasing:** eraser tool, middle-click to erase, and an erase menu for *what's in
  view*, *this page* or *everything*. Every erase can be undone.
- **Undo / redo,** autosave per document, and **export to a new PDF** with every
  annotation baked in (`Ctrl+S`).

### Read aloud

- **On-device neural voice** (Kokoro-82M, 7 voices) that runs offline once downloaded.
  The browser's built-in voice is used while it downloads, or if you prefer it.
- **Runs on GPU or CPU** (choose in Settings). It works in a background worker, so the
  page never freezes. If the graphics card runs out of memory, it switches to the CPU
  automatically.
- **Reads like a person:** skips chart and axis labels, tables of numbers, running
  headers and footers, page numbers, and text over images. Words split across lines are
  joined, and it pauses after headings.
- **Clean reading style:** drops citations ([12], (Smith et al., 2019)), links and DOIs,
  references such as "(see Table 3)", statistics such as "(p < 0.05)", footnote marks and
  inline maths. Symbols and abbreviations are read as words: "%" → *percent*, "±" →
  *plus or minus*, "e.g." → *for example*, "Fig." → *figure*, "α" → *alpha*.
- **Prepare-ahead buffer:** the next 1–5 sentences are generated while the current one
  plays, so there are no gaps between sentences.
- **Live highlighting** of the current sentence and word, with automatic scrolling.
- **Speed control** (`[` / `]`), sentence skip, read from a selection, and media keys.

### Interface

- **One toolbar slot.** The annotation, read-aloud, night-mode and find bars roll in over
  the main toolbar and roll back out when closed (×, or Esc).
- **The toolbar shows the state of toggles** (sidebar, dark mode, annotate…), can be
  hidden with `t`, and can float or dock at the top or bottom.
- **Command palette** (`Ctrl+K`): fuzzy search across every action.
- **Animated panels and tooltips** that wait for a deliberate hover.
- **Fully re-bindable keyboard shortcuts,** including Vim-style sequences (`g g`,
  `z z`) and multiple keys per action. On macOS every `Ctrl` shortcut also works with
  `⌘`.

---

## Keyboard shortcuts

Shortcuts follow common conventions (Adobe Acrobat, Chrome's PDF viewer, browsers,
VS Code, Edge Read Aloud). All of them can be changed in **Settings → Shortcut keymap**,
and `?` shows them in the reader.

| Action | Keys |
|---|---|
| Next / previous page | `→` / `←` (also `j` / `k`) |
| First / last page | `Home` / `End` (also `g g` / `Shift+G`) |
| Scroll one screen down / up | `Space` / `Shift+Space` (also `d` / `u`) |
| Go to page | `Ctrl+G` |
| Back / forward after a link | `Alt+←` / `Alt+→` |
| Zoom in / out / 100% | `Ctrl+=` / `Ctrl+−` / `Ctrl+1` |
| Fit height / width / whole page | `Ctrl+0` / `Ctrl+2` (also `w`) / `Ctrl+3` |
| Rotate right / left | `Ctrl+]` / `Ctrl+[` (also `r` / `Shift+R`) |
| Cycle layout | `l` |
| Sidebar / toolbar | `F4` or `s` / `F8` or `t` |
| Presentation (full screen) / distraction-free | `F5` / `z z` |
| Find, next, previous | `Ctrl+F` or `/`, `F3`, `Shift+F3` |
| Dark mode / night-mode toolbar | `Shift+D` / `Alt+Shift+D` |
| Brightness up / down | `Alt+]` / `Alt+[` |
| Annotation mode | `a` |
| Highlight · underline · strike | `h` · `Shift+U` · `Shift+S` |
| Pen · box · circle · arrow | `p` · `Shift+O` · `Shift+C` · `Shift+A` |
| Note · text box · stamp · eraser | `n` · `Shift+T` · `Shift+M` · `e` |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` or `Ctrl+Y` |
| Erase this page / everything | `Shift+Del` / `Ctrl+Shift+Del` |
| Export annotated PDF | `Ctrl+S` |
| Read aloud play / pause | `Ctrl+Shift+U` (also the media play key) |
| Previous / next sentence | `Ctrl+←` / `Ctrl+→` |
| Slower / faster | `[` / `]` |
| Read from selection | `Shift+Enter` |
| Command palette | `Ctrl+K` or `Ctrl+Shift+P` |
| Settings | `Ctrl+,` |
| Shortcut list | `?` or `Ctrl+/` |
| Close the current bar / leave a mode | `Esc` |

---

## Install from source

Requirements: Node 18+ (22 recommended) and Chrome / Chromium 116+.

```bash
npm install --onnxruntime-node-install-cuda=skip
npm run build        # type-checks, then builds the extension into ./dist
```

The `--onnxruntime-node-install-cuda=skip` flag avoids an optional CUDA download that
fails on machines without NVIDIA tooling. The extension never uses it.

Load it in Chrome:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose the **`dist/`** folder
4. Optional: on the extension's card, click **Details** and enable **Allow access to file
   URLs** to open local PDFs

After rebuilding, click **reload ↻** on the extension card.

| Script | What it does |
|---|---|
| `npm run build` | `tsc --noEmit && vite build`: production build into `dist/` |
| `npm run dev` | Rebuilds `dist/` on every change (then reload the extension) |
| `npm run typecheck` | Type-check only |

---

## Building a release

```bash
npm run build
cd dist && zip -r ../lumen-pdf-v$(node -p "require('../package.json').version").zip . && cd ..
```

Upload the zip in the Chrome Web Store Developer Dashboard. The version in
`manifest.json` (and `package.json`) must go up for every new upload. See
[HANDOFF.md](./HANDOFF.md#releasing-to-the-chrome-web-store) for the full checklist and
the permission justifications.

---

## Settings

Open them with `Ctrl+,`, the gear on the toolbar, or the popup. Settings are stored in
`chrome.storage`, on this device by default or synced to your Chrome account if you
choose. You can export and import them as JSON.

| Section | Highlights |
|---|---|
| General | Storage (local / sync), confirm before export |
| Viewing | Default layout, default fit, smooth scrolling & zoom animation, sidebar |
| Dark mode | On/off, mode, image protection, brightness, contrast, theme |
| Annotation | Highlight and pen colours per theme, opacity, middle-click eraser |
| Read aloud | Engine, voice, speed, word/sentence highlight, **runs on GPU / CPU**, **reading style (clean / verbatim)**, **prepare-ahead buffer**, skip non-prose |
| Interface | Toolbar visibility, position, density |
| Shortcut keymap | Re-bind any action, with conflict detection |

---

## Privacy

- Lumen reads **only the PDF you open**, inside your browser. Page content is never
  uploaded anywhere.
- Settings and annotations are kept in `chrome.storage`, on this device by default or
  synced through your own Chrome account if you enable sync.
- The **only network request** Lumen makes on its own is a one-time download of the
  open-source Kokoro voice model (about 80–330 MB) from Hugging Face. It happens only
  when you first use the neural voice, and the model is cached afterwards. It is a data
  file; no code is downloaded. Everything else is bundled with the extension.
- No analytics, no tracking, no accounts.

---

## Architecture

```
src/
  core/
    schema.ts        Single source of truth: settings model, defaults, command catalogue + default keys
    settings.ts      Reactive settings (chrome.storage, deep-merge over defaults, migrations, subscribe)
    commands.ts      Command registry: ids → handlers
    shortcuts.ts     Keyboard engine (chords, Vim sequences, alternatives, ⌘ mirroring)
  viewer/
    viewer.ts        Entry point: wires every engine, registers command handlers
    pdfViewer.ts     Rendering: lazy double-buffered canvases, layouts, fit/zoom (GPU preview),
                     rotation, eviction, links + back/forward history, smooth scroll
    selectionGuard.ts  Keeps text selection from jumping across span gaps (from pdf.js)
    darkmode.ts      Smart-invert dark mode, image protection, theme flag for the UI
    annotations.ts   Annotation layer, tools, eraser scopes, undo/redo, pdf-lib export
    search.ts        Find in document (CSS Custom Highlight API)
    tts.ts           Read-aloud controller: sentences, highlighting, buffer, engine fallback
    readingText.ts   Prose detection + clean-reading rules (keeps a map back to page text)
    kokoroWorker.ts  Neural voice in a worker (GPU or CPU); kokoroClient.ts is its handle
  ui/
    dock.ts          The toolbar slot: main toolbar + sub-toolbars with the roll animation
    toolbar.ts  annotationBar.ts  displayPanel.ts (night mode)  sidebarPanel.ts
    colorPicker.ts  commandPalette.ts  tooltip.ts  motion.ts  icons.ts (inline SVG)
    settings.ts/.html/.css  popup.ts/.html
  background/
    service-worker.ts  PDF redirect rule, context menu, keyboard command, popup messages
  shim/node-empty.ts Stubs Node built-ins that kokoro-js imports on an unused server path
public/pdfjs/        Bundled pdf.js character maps + standard fonts
```

Everything the extension runs is bundled: the pdf.js worker, the ONNX Runtime WASM file
and the pdf.js fonts are emitted locally, as the Manifest V3 security policy requires.

---

## Project docs

- **[HANDOFF.md](./HANDOFF.md):** current status, known issues, roadmap and the
  release checklist.
- **[CLAUDE.md](./CLAUDE.md):** engineering guide: constraints, architecture,
  conventions and gotchas, for anyone (human or AI assistant) changing the code.
- **[PRIVACY.md](./PRIVACY.md):** the privacy policy for the store listing.
