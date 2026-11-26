/**
 * viewer.ts — Entry point for the reader page.
 *
 * Boots the settings engine, loads the PDF named in ?file=, then wires the
 * render engine, dark-mode engine, command handlers, keyboard engine, toolbar,
 * and command palette together. This is the file that turns command ids into
 * real behavior by registering handlers on the CommandRegistry.
 */

import { settings } from '../core/settings';
import { commands } from '../core/commands';
import { ShortcutManager } from '../core/shortcuts';
import { PDFViewer } from './pdfViewer';
import { DarkModeEngine } from './darkmode';
import { SearchController } from './search';
import { AnnotationManager } from './annotations';
import { TtsController } from './tts';
import { Toolbar } from '../ui/toolbar';
import { AnnotationBar } from '../ui/annotationBar';
import { DisplayPanel } from '../ui/displayPanel';
import { SidebarPanel } from '../ui/sidebarPanel';
import { CommandPalette } from '../ui/commandPalette';
import { installTooltips } from '../ui/tooltip';
import { dock } from '../ui/dock';
import { dismiss } from '../ui/motion';
import './viewer.css';

async function main() {
  await settings.init();

  // Apply the saved theme instantly on load (no cross-fade from light to dark).
  document.body.classList.add('theme-boot');
  installTooltips();
  const scroll = document.getElementById('scroll')!;
  const pdf = new PDFViewer(scroll);
  const dark = new DarkModeEngine(scroll, pdf);
  const search = new SearchController(pdf);
  const annot = new AnnotationManager(pdf, toast);
  const toolbar = new Toolbar(commands);
  new AnnotationBar(commands, annot);
  new SidebarPanel(pdf);
  const display = new DisplayPanel();
  const tts = new TtsController(pdf, toast);
  const shortcuts = new ShortcutManager(
    (id) => commands.dispatch(id),
    (whenExpr) => commands.evalWhen(whenExpr),
  );
  const palette = new CommandPalette(commands, shortcuts);

  // Keep toolbar status + layout attributes in sync with the render state.
  pdf.onChange((s) => {
    toolbar.updateStatus(s);
    scroll.dataset.layout = s.layout;
  });

  // Smooth scrolling (wheel + arrows + programmatic) follows the setting.
  const applySmooth = () => scroll.classList.toggle('smooth', settings.get<boolean>('viewing.smoothScroll'));
  applySmooth();
  settings.subscribe('viewing.smoothScroll', applySmooth);

  // Live-apply layout defaults from settings on boot.
  pdf.state.layout = settings.get('viewing.layoutMode');
  pdf.state.fit = settings.get('viewing.fitMode');
  pdf.state.scale = settings.get('viewing.defaultZoom');
  pdf.state.rotation = settings.get('viewing.defaultRotation');

  registerCommands(pdf, dark, palette, search, annot, display, tts);
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('theme-boot')));

  // Re-apply keybindings whenever the keymap changes in settings.
  settings.subscribe('shortcuts.keymap', () => shortcuts.rebuild());
  shortcuts.attach(window);

  // Debounced re-fit on resize.
  let rt: number | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => void pdf.handleResize(), 150);
  });

  // Re-render crisply when devicePixelRatio changes (browser zoom, or dragging
  // the window to a monitor with different scaling) — otherwise canvases stay
  // rasterised for the old DPR and small text looks blurry/jagged.
  const watchDpr = () => {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener('change', () => {
      void pdf.handleResize(true);
      watchDpr();
    }, { once: true });
  };
  watchDpr();

  // Ctrl/⌘ + wheel, and trackpad pinch (which the browser reports as wheel +
  // ctrlKey), zoom the document. rAF-throttled so a burst of wheel events does
  // at most one re-render per frame.
  let pendingZoom = 0;
  let zoomRaf = 0;
  scroll.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      pendingZoom += -e.deltaY;
      const at = { x: e.clientX, y: e.clientY }; // keep the spot under the cursor still
      if (!zoomRaf) {
        zoomRaf = requestAnimationFrame(() => {
          zoomRaf = 0;
          const factor = Math.exp(pendingZoom * 0.0015);
          pendingZoom = 0;
          void pdf.setZoom(pdf.state.scale * factor, { at });
        });
      }
    },
    { passive: false },
  );

  const file = resolveFileParam();
  if (!file) {
    showDropZone(pdf, annot);
    return;
  }
  try {
    await pdf.load(file);
    await annot.load();
  } catch (err) {
    console.error(err);
    showError(String(err));
  }
}

/** Register every command id this page knows how to perform. */
function registerCommands(
  pdf: PDFViewer,
  dark: DarkModeEngine,
  palette: CommandPalette,
  search: SearchController,
  annot: AnnotationManager,
  display: DisplayPanel,
  tts: TtsController,
) {
  commands.registerAll({
    // Navigation
    'nav.nextPage': () => pdf.nextPage(),
    'nav.prevPage': () => pdf.prevPage(),
    'nav.firstPage': () => pdf.firstPage(),
    'nav.lastPage': () => pdf.lastPage(),
    'nav.gotoPage': () => {
      const n = Number(prompt('Go to page:', String(pdf.state.page)));
      if (!Number.isNaN(n)) void pdf.goToPage(n);
    },
    'nav.scrollDown': () => pdf.scrollBy(window.innerHeight * 0.9),
    'nav.scrollUp': () => pdf.scrollBy(-window.innerHeight * 0.9),
    'nav.lineDown': () => pdf.scrollBy(120),
    'nav.lineUp': () => pdf.scrollBy(-120),

    // View
    'view.zoomIn': () => pdf.zoomIn(),
    'view.zoomOut': () => pdf.zoomOut(),
    'view.fitWidth': () => pdf.setFit('width'),
    'view.fitPage': () => pdf.setFit('page'),
    'view.fitHeight': () => pdf.setFit('height'),
    'view.actualSize': () => pdf.actualSize(),
    'view.rotateCW': () => pdf.rotate(90),
    'view.rotateCCW': () => pdf.rotate(-90),
    'view.cycleLayout': () => pdf.cycleLayout(),
    'view.presentation': () => togglePresentation(),
    'view.toggleSidebar': () => toggleSetting('viewing.sidebar.visible'),
    'view.toggleToolbar': () => toggleSetting('ui.toolbarVisible'),
    'view.distractionFree': () => toggleSetting('ui.distractionFree'),

    // Dark mode
    'dark.toggle': () => dark.toggle(),
    'dark.panel': () => display.toggle(),
    'dark.cyclePreset': () => dark.cyclePreset(),
    'dark.brightnessUp': () => dark.nudgeBrightness(0.1),
    'dark.brightnessDown': () => dark.nudgeBrightness(-0.1),

    // Annotation
    'annot.toggleMode': () => annot.toggleMode(),
    'annot.highlight': () => annot.setTool('highlight'),
    'annot.underline': () => annot.setTool('underline'),
    'annot.strike': () => annot.setTool('strike'),
    'annot.pen': () => annot.setTool('pen'),
    'annot.rectangle': () => annot.setTool('rectangle'),
    'annot.ellipse': () => annot.setTool('ellipse'),
    'annot.arrow': () => annot.setTool('arrow'),
    'annot.note': () => annot.setTool('note'),
    'annot.textbox': () => annot.setTool('textbox'),
    'annot.stamp': () => annot.loadStamp(),
    'annot.eraser': () => annot.setTool('eraser'),
    'annot.clearAll': () => annot.clearAll(),
    'annot.clearPage': () => annot.clearPage(),
    'annot.clearView': () => annot.clearInView(),
    'annot.undo': () => annot.undo(),
    'annot.redo': () => annot.redo(),
    'annot.export': () => annot.exportPdf(),

    // Search
    'search.open': () => search.show(window.getSelection()?.toString().trim() || ''),
    'search.openSlash': () => search.show(),
    'search.next': () => search.next(),
    'search.prev': () => search.prev(),

    // TTS
    'tts.playPause': () => tts.playPause(),
    'tts.stop': () => tts.stop(),
    'tts.nextSentence': () => tts.nextSentence(),
    'tts.prevSentence': () => tts.prevSentence(),
    'tts.speedUp': () => tts.speedUp(),
    'tts.speedDown': () => tts.speedDown(),
    'tts.readFromCursor': () => tts.readFromCursor(),

    // General
    'app.commandPalette': () => palette.toggle(),
    'app.settings': () => chrome.runtime.openOptionsPage?.(),
    'app.help': () => palette.show(),
    // Esc rolls the topmost sub-toolbar back to the main toolbar (fields like
    // the search box and the palette handle their own Esc first).
    'app.escape': () => {
      const a = document.activeElement as HTMLElement | null;
      if (a && (a.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName))) return;
      const top = dock().top();
      if (top === 'display') display.close();
      else if (top === 'search') search.close();
      else if (top === 'tts') tts.close();
      else if (top === 'annot' && annot.isActive()) annot.toggleMode();
    },

    // Later-step placeholders so bindings resolve without throwing.
    ...stubbed(['app.bookmark']),
  });
}

function stubbed(ids: string[]): Record<string, () => void> {
  const out: Record<string, () => void> = {};
  for (const id of ids) out[id] = () => toast(`"${id}" lands in a later step`);
  return out;
}

async function toggleSetting(path: string) {
  await settings.set(path, !settings.get<boolean>(path));
}

function togglePresentation() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
}

function resolveFileParam(): string | null {
  const p = new URLSearchParams(location.search).get('file');
  if (!p) return null;
  // A malformed %-escape would throw; fall back to the raw value rather than
  // leaving the reader on a blank page.
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

function showDropZone(pdf: PDFViewer, annot: AnnotationManager) {
  const dz = document.getElementById('dropzone')!;
  dz.hidden = false;
  const onFile = (file: File) => {
    const url = URL.createObjectURL(file);
    dz.hidden = true;
    pdf
      .load(url)
      .then(() => annot.load())
      .catch((err) => {
        console.error(err);
        dz.hidden = false;
        showError(String(err));
      });
  };
  dz.addEventListener('dragover', (e) => e.preventDefault());
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  });
  (dz.querySelector('input[type=file]') as HTMLInputElement)?.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) onFile(f);
  });
}

function showError(msg: string) {
  const el = document.getElementById('error')!;
  el.hidden = false;
  el.textContent = `Could not open PDF: ${msg}`;
}

/** One message at a time, above the toolbar; fades in and out (ui/motion.ts). */
function toast(msg: string) {
  document.querySelectorAll('.lumen-toast:not(.is-leaving)').forEach((t) => dismiss(t));
  const t = document.createElement('div');
  t.className = 'lumen-toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => dismiss(t), Math.min(4000, 1400 + msg.length * 30));
}

void main();
