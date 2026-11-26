/**
 * settings.ts — Searchable settings page.
 *
 * Renders controls from a declarative descriptor bound to dot-paths in the
 * SettingsManager, plus a full keymap editor with live conflict detection.
 * Every control writes straight to settings, which fans out to all open
 * contexts via chrome.storage.onChanged.
 */

import { settings } from '../core/settings';
import { COMMANDS } from '../core/schema';
import { ShortcutManager, eventToChord } from '../core/shortcuts';
import './settings.css';

type Control =
  | { kind: 'toggle'; path: string; label: string; help?: string }
  | { kind: 'select'; path: string; label: string; options: { value: string; label: string }[] }
  | { kind: 'slider'; path: string; label: string; min: number; max: number; step: number }
  | { kind: 'color'; path: string; label: string }
  | { kind: 'number'; path: string; label: string; min?: number; max?: number; step?: number };

interface Section {
  title: string;
  controls: Control[];
}

const SECTIONS: Section[] = [
  {
    title: 'General',
    controls: [
      { kind: 'toggle', path: 'general.rememberLastPage', label: 'Remember last page' },
      { kind: 'toggle', path: 'general.restoreZoom', label: 'Restore zoom level' },
      { kind: 'toggle', path: 'general.confirmOnExport', label: 'Confirm before exporting' },
      { kind: 'select', path: 'meta.storageMode', label: 'Settings storage', options: [
        { value: 'local', label: 'Local (this device)' },
        { value: 'sync', label: 'Synced (Chrome account)' },
      ] },
    ],
  },
  {
    title: 'Viewing & Layout',
    controls: [
      { kind: 'select', path: 'viewing.layoutMode', label: 'Layout', options: [
        { value: 'single', label: 'Single page' },
        { value: 'two-page', label: 'Two-page spread' },
        { value: 'continuous', label: 'Continuous scroll' },
      ] },
      { kind: 'select', path: 'viewing.fitMode', label: 'Default fit', options: [
        { value: 'width', label: 'Fit width' },
        { value: 'height', label: 'Fit height' },
        { value: 'page', label: 'Fit whole page' },
        { value: 'actual', label: 'Actual size' },
      ] },
      { kind: 'toggle', path: 'viewing.smoothScroll', label: 'Smooth scrolling & zoom animation' },
      { kind: 'toggle', path: 'viewing.sidebar.visible', label: 'Show sidebar' },
    ],
  },
  {
    title: 'Dark Mode & Colors',
    controls: [
      { kind: 'toggle', path: 'darkMode.enabled', label: 'Enable dark / invert mode' },
      { kind: 'select', path: 'darkMode.mode', label: 'Mode', options: [
        { value: 'smart-invert', label: 'Smart invert' },
        { value: 'custom-colors', label: 'Custom colors' },
        { value: 'off', label: 'Off' },
      ] },
      { kind: 'toggle', path: 'darkMode.smartImageProtection', label: 'Protect images from inversion' },
      { kind: 'slider', path: 'darkMode.brightness', label: 'Brightness', min: 0.5, max: 1.5, step: 0.05 },
      { kind: 'slider', path: 'darkMode.contrast', label: 'Contrast', min: 0.5, max: 1.5, step: 0.05 },
      { kind: 'select', path: 'darkMode.activePresetId', label: 'Theme', options: [
        { value: 'soft-night', label: 'Soft Night (brightness 1 · contrast 0.6)' },
      ] },
    ],
  },
  {
    title: 'Annotation',
    controls: [
      { kind: 'toggle', path: 'annotation.enabled', label: 'Enable annotations' },
      { kind: 'color', path: 'annotation.colors.light.highlight', label: 'Highlight color (light mode)' },
      { kind: 'color', path: 'annotation.colors.dark.highlight', label: 'Highlight color (dark mode)' },
      { kind: 'slider', path: 'annotation.highlightOpacity', label: 'Highlight opacity', min: 0.1, max: 1, step: 0.05 },
      { kind: 'color', path: 'annotation.colors.light.pen', label: 'Pen color (light mode)' },
      { kind: 'color', path: 'annotation.colors.dark.pen', label: 'Pen color (dark mode)' },
      { kind: 'slider', path: 'annotation.penWidth', label: 'Pen width', min: 1, max: 12, step: 1 },
      { kind: 'toggle', path: 'annotation.middleClickEraser.enabled', label: 'Middle-click eraser' },
      { kind: 'toggle', path: 'annotation.middleClickEraser.global', label: 'Eraser works outside annotation mode' },
      { kind: 'slider', path: 'annotation.middleClickEraser.radius', label: 'Eraser radius (px)', min: 4, max: 40, step: 1 },
    ],
  },
  {
    title: 'Text-to-Speech',
    controls: [
      { kind: 'toggle', path: 'tts.enabled', label: 'Enable TTS' },
      { kind: 'select', path: 'tts.engine', label: 'Engine', options: [
        { value: 'kokoro', label: 'Kokoro-82M (best quality)' },
        { value: 'piper', label: 'Piper (fast / low-end)' },
        { value: 'native', label: 'Browser voices' },
      ] },
      { kind: 'slider', path: 'tts.speed', label: 'Speed', min: 0.5, max: 2, step: 0.1 },
      { kind: 'select', path: 'tts.highlightGranularity', label: 'Highlight while reading', options: [
        { value: 'word', label: 'Word' },
        { value: 'sentence', label: 'Sentence' },
      ] },
      { kind: 'select', path: 'tts.device', label: 'Neural voice runs on', options: [
        { value: 'auto', label: 'Auto (GPU, CPU if it fails)' },
        { value: 'gpu', label: 'GPU (WebGPU)' },
        { value: 'cpu', label: 'CPU (works everywhere)' },
      ] },
      { kind: 'select', path: 'tts.readingMode', label: 'Reading style', options: [
        { value: 'clean', label: 'Clean — skip citations, links, maths; read symbols as words' },
        { value: 'verbatim', label: 'Verbatim — read the text as written' },
      ] },
      { kind: 'select', path: 'tts.lookahead', label: 'Prepare ahead (buffer)', options: [
        { value: 'off', label: 'Off' },
        { value: '1', label: '1 sentence' },
        { value: '2', label: '2 sentences' },
        { value: '3', label: '3 sentences' },
        { value: '5', label: '5 sentences' },
      ] },
      { kind: 'toggle', path: 'tts.skipNonProse', label: 'Read like a person (skip charts, tables, headers & page numbers)' },
      { kind: 'toggle', path: 'tts.fallbackToNativeWhileLoading', label: 'Use browser voice while model loads' },
    ],
  },
  {
    title: 'Interface',
    controls: [
      { kind: 'toggle', path: 'ui.toolbarVisible', label: 'Show toolbar' },
      { kind: 'select', path: 'ui.toolbarPosition', label: 'Toolbar position', options: [
        { value: 'floating', label: 'Floating' },
        { value: 'docked-top', label: 'Docked top' },
        { value: 'docked-bottom', label: 'Docked bottom' },
      ] },
      { kind: 'toggle', path: 'ui.distractionFree', label: 'Distraction-free (hide all UI)' },
      { kind: 'toggle', path: 'commandPalette.enabled', label: 'Enable command palette' },
    ],
  },
  {
    title: 'Keyboard',
    controls: [
      { kind: 'toggle', path: 'shortcuts.enabled', label: 'Enable keyboard shortcuts' },
      { kind: 'toggle', path: 'shortcuts.vimEnabled', label: 'Vim-style sequences (g g, z z…)' },
      { kind: 'toggle', path: 'shortcuts.ignoreWhenTypingInInputs', label: 'Ignore shortcuts while typing' },
      { kind: 'number', path: 'shortcuts.sequenceTimeoutMs', label: 'Sequence timeout (ms)', min: 300, max: 2000, step: 50 },
    ],
  },
];

const shortcuts = new ShortcutManager(() => {});

/** The settings page follows the reader's theme: dark while dark mode is on. */
function applyTheme() {
  const dm = settings.get<any>('darkMode');
  document.body.classList.toggle('lumen-dark', !!dm?.enabled && dm?.mode !== 'off');
}

async function boot() {
  await settings.init();
  document.body.classList.add('theme-boot');
  applyTheme();
  settings.subscribe('darkMode', applyTheme);
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('theme-boot')));
  shortcuts.rebuild();
  render();
  wireHeader();
}

function render() {
  const root = document.getElementById('panels')!;
  root.innerHTML = '';
  for (const section of SECTIONS) root.appendChild(renderSection(section));
  root.appendChild(renderKeymap());
}

function renderSection(section: Section): HTMLElement {
  const el = document.createElement('section');
  el.className = 'panel';
  el.dataset.search = (section.title + ' ' + section.controls.map((c) => c.label).join(' ')).toLowerCase();
  el.innerHTML = `<h2>${section.title}</h2>`;
  const grid = document.createElement('div');
  grid.className = 'panel-grid';
  for (const c of section.controls) grid.appendChild(renderControl(c));
  el.appendChild(grid);
  return el;
}

function renderControl(c: Control): HTMLElement {
  const row = document.createElement('label');
  row.className = 'control';
  row.dataset.search = c.label.toLowerCase();
  const name = document.createElement('span');
  name.className = 'control-label';
  name.textContent = c.label;
  row.appendChild(name);

  const current = settings.get(c.path);
  let input: HTMLElement;

  if (c.kind === 'toggle') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'switch';
    cb.checked = !!current;
    cb.addEventListener('change', () => commit(c.path, cb.checked));
    input = cb;
  } else if (c.kind === 'select') {
    const sel = document.createElement('select');
    for (const o of c.options) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === current) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => commit(c.path, sel.value));
    input = sel;
  } else if (c.kind === 'slider') {
    const wrap = document.createElement('span');
    wrap.className = 'slider-wrap';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(c.min); range.max = String(c.max); range.step = String(c.step);
    range.value = String(current);
    const out = document.createElement('output');
    out.textContent = String(current);
    range.addEventListener('input', () => { out.textContent = range.value; commit(c.path, Number(range.value)); });
    wrap.append(range, out);
    input = wrap;
  } else if (c.kind === 'color') {
    const col = document.createElement('input');
    col.type = 'color';
    col.value = String(current);
    col.addEventListener('input', () => commit(c.path, col.value));
    input = col;
  } else {
    const num = document.createElement('input');
    num.type = 'number';
    if (c.min != null) num.min = String(c.min);
    if (c.max != null) num.max = String(c.max);
    if (c.step != null) num.step = String(c.step);
    num.value = String(current);
    num.addEventListener('change', () => commit(c.path, Number(num.value)));
    input = num;
  }

  input.classList.add('control-input');
  row.appendChild(input);
  return row;
}

async function commit(path: string, value: unknown) {
  if (path === 'meta.storageMode') {
    await settings.setStorageMode(value as 'local' | 'sync');
  }
  await settings.set(path, value);
}

/** Keymap editor: capture a chord/sequence per command, warn on conflicts. */
function renderKeymap(): HTMLElement {
  const el = document.createElement('section');
  el.className = 'panel';
  el.dataset.search = 'keyboard shortcuts keymap rebind ' + COMMANDS.map((c) => c.title.toLowerCase()).join(' ');
  el.innerHTML = `<h2>Shortcut Keymap</h2><p class="muted">Click a key field and press keys. Multi-key Vim sequences are supported.</p>`;
  const list = document.createElement('div');
  list.className = 'keymap';

  for (const cmd of COMMANDS) {
    const row = document.createElement('div');
    row.className = 'keymap-row';
    row.dataset.search = (cmd.title + ' ' + cmd.category).toLowerCase();

    const title = document.createElement('span');
    title.textContent = cmd.title;
    title.className = 'keymap-title';

    const key = document.createElement('button');
    key.className = 'keymap-key';
    key.textContent = bindingLabel(cmd.id);
    key.addEventListener('click', () => captureBinding(cmd.id, key));

    const reset = document.createElement('button');
    reset.className = 'keymap-reset';
    reset.textContent = '↺';
    reset.title = 'Reset to default';
    reset.addEventListener('click', async () => {
      await shortcuts.resetBinding(cmd.id);
      refreshKeymap(list);
    });

    row.append(title, key, reset);
    list.appendChild(row);
  }
  el.appendChild(list);
  return el;
}

/** All bindings of a command, e.g. "ctrl+= / ctrl+plus" (⌘ twins omitted). */
function bindingLabel(id: string): string {
  const all = shortcuts.bindingsFor(id).filter((b) => !/(^|[ +])meta\+/.test(b) || !shortcuts.bindingsFor(id).includes(b.replace(/meta\+/g, 'ctrl+')));
  return all.length ? all.join('  /  ') : '—';
}

function refreshKeymap(list: HTMLElement) {
  shortcuts.rebuild();
  const conflicts = new Set(shortcuts.detectConflicts().flatMap((c) => c.commandIds));
  list.querySelectorAll('.keymap-row').forEach((rowEl, i) => {
    const cmd = COMMANDS[i];
    const key = rowEl.querySelector('.keymap-key') as HTMLButtonElement;
    key.textContent = bindingLabel(cmd.id);
    key.classList.toggle('conflict', conflicts.has(cmd.id));
  });
}

function captureBinding(id: string, btn: HTMLButtonElement) {
  btn.textContent = 'press keys…';
  btn.classList.add('capturing');
  const seq: string[] = [];
  const onKey = async (e: KeyboardEvent) => {
    e.preventDefault();
    if (e.key === 'Escape') return finish();
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    // Same normalisation the viewer uses, so a captured key always matches.
    seq.push(eventToChord(e));
    btn.textContent = seq.join(' ');
  };
  const finish = async () => {
    window.removeEventListener('keydown', onKey, true);
    btn.classList.remove('capturing');
    if (seq.length) {
      const res = await shortcuts.rebind(id, seq.join(' '));
      if (!res.ok) {
        const taken = COMMANDS.find((c) => c.id === res.conflictWith)?.title ?? res.conflictWith;
        if (confirm(`That binding is used by "${taken}". Override?`)) {
          await shortcuts.rebind(id, seq.join(' '), true);
        }
      }
    }
    const list = btn.closest('.keymap') as HTMLElement;
    refreshKeymap(list);
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', finish, { once: true });
}

function wireHeader() {
  const search = document.getElementById('search') as HTMLInputElement;
  search.addEventListener('input', () => filter(search.value.trim().toLowerCase()));
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); }
  });

  document.getElementById('export')!.addEventListener('click', () => {
    const blob = new Blob([settings.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lumen-settings.json';
    a.click();
  });
  const fileInput = document.getElementById('import-file') as HTMLInputElement;
  document.getElementById('import')!.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    await settings.importJSON(await f.text());
    render();
  });
  document.getElementById('reset')!.addEventListener('click', async () => {
    if (confirm('Reset all settings to defaults?')) { await settings.reset(); render(); }
  });
}

function filter(q: string) {
  document.querySelectorAll<HTMLElement>('.panel').forEach((panel) => {
    let any = false;
    panel.querySelectorAll<HTMLElement>('[data-search]').forEach((el) => {
      if (el === panel) return;
      const match = !q || (el.dataset.search ?? '').includes(q);
      el.style.display = match ? '' : 'none';
      if (match) any = true;
    });
    const titleMatch = (panel.dataset.search ?? '').includes(q);
    panel.style.display = !q || any || titleMatch ? '' : 'none';
  });
}

void boot();
