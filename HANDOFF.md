# HANDOFF.md

Current status, recent work, open issues and release steps for **sobelpdf**.
Last updated **27 November 2026** · version **1.0.0**.

---

## Status at a glance

- `npm run build` is green (`tsc --noEmit` + `vite build`). There is no automated test
  suite or browser harness, so behaviour is verified manually in Chrome (see the smoke
  test below).
- All major features are implemented (see README → Features).
- Prepared for its first Chrome Web Store submission: unused permissions removed,
  version 1.0.0, privacy policy in `PRIVACY.md`.

## What was done in the 1.0 cycle

**Rendering and navigation**

- Fixed concurrent renders onto one canvas. Canvases are double-buffered, so zooming no
  longer flickers.
- Canvases and page offsets are snapped to device pixels, so small text stays crisp at
  125% / 150% display scaling. Pages re-render when the device pixel ratio changes.
- Zoom is a GPU `transform` preview on `.pdf-content`, committed once at the end. Sidebar
  open/close uses the same idea (FLIP).
- Fit width / height / page and 100%. Zoom anchors on the viewport centre, or on the
  cursor for Ctrl+wheel.
- PDF links work (internal destinations, named actions, http/mailto), with Back/Forward
  history.
- The text layer rotates with the page. A pdf.js-style selection guard stops selections
  jumping; selected text keeps the PDF lettering.
- Dark page placeholder, so cycling layouts doesn't flash white.

**Dark mode and theme**

- Single "Soft Night" theme (brightness 1, contrast 0.6); schema v2 migration replaced
  the old presets.
- The UI follows dark mode via `body.lumen-dark` tokens. Neutral accent, cross-fades,
  dark dropdowns.
- Black/white annotation colours swap with the theme (stored in "paper" colours).

**Read aloud**

- ONNX Runtime WASM is served locally. transformers.js pointed it at a CDN, which the
  MV3 CSP blocked, so the neural voice never ran before.
- The voice runs in a worker on GPU or CPU (`tts.device`). WebGPU out-of-memory is
  detected and the voice falls back to the CPU.
- "Read like a person" line filter plus Clean reading rules (`readingText.ts`).
- Look-ahead buffer (`tts.lookahead`); long sentences are synthesised in chunks.

**Annotations**

- Fixed doubled multi-line marks. Text box focus, editing and placement fixed.
- Colour palette popover with per-theme presets. Tool colours are stored per theme.
- Font family and size for text boxes and notes, also used in the exported PDF.
- Erase in view / this page / everything (one undo step each).

**Interface**

- Dock: annotation, read-aloud, night-mode and find bars roll in over the main toolbar.
- Sidebar Contents tab (outline tree) with a slide animation.
- Animated panels (`ui/motion.ts`), custom tooltips, toolbar toggle states.
- Shortcuts remapped to common conventions, with alternatives and ⌘ on macOS. Fixed:
  shifted symbols (`?`, `+`) never matched before.

**Release prep**

- Removed the unused `offscreen` and `downloads` permissions, the never-requested
  optional `tabs` permission, the dead `models/*` and `wasm/*` web-accessible entries,
  and the offscreen-document stub. Dropped the broken `lint` script.

---

## Known issues / limitations

1. **Not verified in a real browser by automation.** Animations, the voice worker,
   WebGPU fallback and backdrop-filter effects need a manual check in Chrome.
2. **Voice worker is new.** If it fails to start, the reader falls back to the browser
   voice. Check the console for "Kokoro failed to load" and the reason.
3. **CPU voice is single-threaded.** Multi-threaded WASM would need cross-origin
   isolation (COOP/COEP in the manifest). That could affect loading cross-site PDFs and
   needs testing before enabling.
4. **Clean reading is rule-based.** Removing an equation can leave a sentence that reads
   oddly ("showed that works"). The planned fix is AI rephrasing (see the roadmap).
5. **Custom-colors dark mode** is basic. Smart invert is the recommended and default mode.
6. **Bookmarks** (`b`) are not implemented yet; the key shows a "coming soon" message.
7. **Highlights on rotated pages** paint above the text (the rotation wrapper forms a
   stacking context). They are semi-transparent, so still readable.
8. **declarativeNetRequest redirect** substitutes the matched URL (`\0`) without encoding.
   Fine for typical URLs; unusual characters could be mangled.
9. **Printed contents pages without real links** can't be clicked; only PDFs that contain
   link annotations work.

## Roadmap

1. **AI rephrasing for read-aloud** ("Natural" mode). Pipeline: extract → clean rules →
   rewrite one paragraph → validate (numbers and names must come from the source, length
   ≤ 1.3×) → speak, with the look-ahead buffer. Model order: Chrome's built-in AI
   (Prompt / Rewriter API) when available, then Qwen2.5-0.5B-Instruct (4-bit,
   transformers.js, on the CPU in the worker), with Qwen3-0.6B / Llama-3.2-1B as options
   for stronger machines. Make the model download opt-in (400 MB+). The prompt design is
   recorded in the 1.0 development conversation and should be moved into `docs/` when
   this work starts.
2. **Bookmarks** as a third sidebar tab.
3. **Resume where you left off** (`general.rememberLastPage` / `restoreZoom` exist in
   the schema but nothing uses them yet).
4. **Annotation list** in the sidebar (jump to any highlight or note, filter by colour).
5. **Read-aloud progress bar** with click-to-seek.
6. Multi-threaded WASM (see known issue 3).

---

## Smoke test (manual, before every release)

1. Open a PDF link: it opens in sobelpdf and the toolbar is visible at the bottom.
2. Scroll with the arrows and Space (smooth); zoom with Ctrl+wheel and the buttons
   (smooth, then crisp).
3. Toggle the sidebar (`s`): it slides and the pages glide. Open the Contents tab and
   click an entry, then press Alt+← to come back.
4. Click a link on a contents page or a cross-reference.
5. `Shift+D` dark mode: cross-fade, photos stay positive, thumbnails go dark.
6. Annotate (`a`): multi-line highlight (single layer), text box (type, drag, change
   font), sticky note, palette colours, erase this page, then Ctrl+Z.
7. `Ctrl+S` export and check the annotations in the exported PDF.
8. `Ctrl+Shift+U` read aloud: neural voice loads (GPU or CPU), the page stays
   responsive, words are highlighted, no gaps between sentences.
9. Settings: switch the voice to CPU and back; change a shortcut and test it.
10. Check the console for errors.

---

## Releasing to the Chrome Web Store

### 1. Prepare the package

```bash
# bump "version" in BOTH manifest.json and package.json for every new upload
npm install --onnxruntime-node-install-cuda=skip
npm run build
cd dist && zip -r ../sobelpdf-v1.0.0.zip . && cd ..
```

Load `dist/` unpacked once more and run the smoke test before uploading.

### 2. Developer account

- Go to <https://chrome.google.com/webstore/devconsole>, sign in, accept the agreement,
  and pay the one-time US $5 registration fee.
- Verify the contact email. Optionally add a publisher display name ("Umakanta
  Maharana").

### 3. Create the item

**Upload**

1. Click **New item** and upload `sobelpdf-v1.0.0.zip`.

**Store listing**

1. Name and summary come from the manifest. Add a detailed description; the README
   *Features* section is a good basis.
2. Choose a category (Productivity / Tools) and a language.
3. Add at least one screenshot, 1280×800 or 640×400. Suggested set: light mode, dark
   mode, annotations, the Contents sidebar, the read-aloud bar.
4. Add a small promo tile, 440×280, and the 128×128 icon (`public/icons/icon128.png`).

**Privacy practices tab**

1. **Single purpose:** "View, search, annotate and read aloud PDF documents."
2. **Remote code:** "No, I am not using remote code." The voice model is a data file;
   all JavaScript and WASM are bundled.
3. **Data usage:** declare that no user data is collected. Tick the certifications that
   data is not sold or transferred.
4. **Privacy policy URL:** host `PRIVACY.md` publicly. The repo is private, so use a
   public GitHub Gist, GitHub Pages from a separate public repo, or a Google Doc shared
   with "Anyone with the link".

**Permission justifications** (paste per permission):

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings and annotations locally. |
| `unlimitedStorage` | Annotations can include images (signatures/stamps), and the optional on-device voice model (up to ~330 MB) is cached for offline use. |
| `declarativeNetRequest` | Opens links to `.pdf` files in the extension's PDF viewer instead of the default viewer. |
| `contextMenus` | Adds "Open in sobelpdf" to the right-click menu for PDF links. |
| Host permission `<all_urls>` | The reader must fetch and display PDF files from whichever website the user opens them on. Content is processed locally and never transmitted. |

**Distribution**

1. Choose Public or Unlisted, and the regions.

### 4. Submit and review

- Click **Submit for review**. Broad host access (`<all_urls>`) usually triggers a
  longer, in-depth review: from a few days to a few weeks.
- If rejected, the email names the policy. Usual causes are an unjustified permission, a
  missing privacy policy or a vague single purpose. Fix it, bump the version, rebuild,
  re-zip and upload.

### 5. Updates

Bump the version, rebuild and zip, then open the item → **Package** → **Upload new
package** → **Submit for review**. Users update automatically.

---

## Repo / git

- `main` is the release branch. Feature work happens on short-lived branches that are
  merged into `main`.
- Commits are authored by **Umakanta Maharana** (`umakantamaharana70@gmail.com`), with no
  AI attribution trailers.
- `node_modules/` and `dist/` are git-ignored. `public/pdfjs/` **is** committed, so the
  repo builds self-contained.
- Remote: `https://github.com/Umakantamaharana/pdf-reader.git` (private). Pushing over
  HTTPS needs a GitHub personal access token, or use SSH.
