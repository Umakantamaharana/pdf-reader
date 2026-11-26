/**
 * annotationBar.ts — Contextual toolbar shown while annotation mode is active.
 *
 * Gives a visible way to pick the current tool, its color, and stroke width
 * (the color input binds to whichever settings path the active tool draws with),
 * plus undo / redo / export and a close (×) button that leaves annotation mode.
 * Buttons dispatch command ids, so they stay in sync with the keyboard.
 */

import { CommandRegistry } from '../core/commands';
import { AnnotationManager, AnnotTool } from '../viewer/annotations';
import { settings } from '../core/settings';
import { icon } from './icons';
import { dock } from './dock';
import { dismiss } from './motion';
import { ColorPicker, HIGHLIGHTERS, INK_DARK, INK_LIGHT } from './colorPicker';
import { FONT_STACKS } from '../viewer/annotations';
import type { FontFamily } from '../core/schema';

/** Size step: 1 pt for small text, 2 pt above 20, 4 pt above 40. */
function stepFor(size: number): number {
  return size >= 40 ? 4 : size >= 20 ? 2 : 1;
}

function isDark(): boolean {
  const dm = settings.get<any>('darkMode');
  return !!dm?.enabled && dm?.mode !== 'off';
}

interface ToolBtn { tool: AnnotTool; cmd: string; ico: string; title: string }

const TOOLS: ToolBtn[] = [
  { tool: 'highlight', cmd: 'annot.highlight', ico: 'highlighter', title: 'Highlight (h)' },
  { tool: 'underline', cmd: 'annot.underline', ico: 'underline', title: 'Underline (⇧U)' },
  { tool: 'strike', cmd: 'annot.strike', ico: 'strikethrough', title: 'Strikethrough (⇧S)' },
  { tool: 'pen', cmd: 'annot.pen', ico: 'pen', title: 'Pen (p)' },
  { tool: 'rectangle', cmd: 'annot.rectangle', ico: 'square', title: 'Box (⇧O)' },
  { tool: 'ellipse', cmd: 'annot.ellipse', ico: 'circle', title: 'Circle (⇧C)' },
  { tool: 'arrow', cmd: 'annot.arrow', ico: 'arrow-up-right', title: 'Arrow (⇧A)' },
  { tool: 'note', cmd: 'annot.note', ico: 'message-square', title: 'Sticky note (n)' },
  { tool: 'textbox', cmd: 'annot.textbox', ico: 'type', title: 'Text box (⇧T)' },
  { tool: 'stamp', cmd: 'annot.stamp', ico: 'image', title: 'Image / signature (⇧M)' },
  { tool: 'eraser', cmd: 'annot.eraser', ico: 'eraser', title: 'Eraser (e) — double-click to erase all' },
];

export class AnnotationBar {
  private registry: CommandRegistry;
  private annot: AnnotationManager;
  private el: HTMLDivElement;
  private buttons = new Map<AnnotTool, HTMLButtonElement>();
  private color: ColorPicker;
  private width: HTMLInputElement;
  private fontBox: HTMLDivElement;

  constructor(registry: CommandRegistry, annot: AnnotationManager) {
    this.registry = registry;
    this.annot = annot;

    this.el = document.createElement('div');
    this.el.className = 'annot-bar';

    const tools = document.createElement('div');
    tools.className = 'annot-bar-tools';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'annot-tbtn';
      b.innerHTML = icon(t.ico);
      b.title = t.title;
      b.setAttribute('aria-label', t.title);
      b.addEventListener('click', () => this.registry.dispatch(t.cmd));
      if (t.tool === 'eraser') b.addEventListener('dblclick', () => this.registry.dispatch('annot.clearAll'));
      this.buttons.set(t.tool, b);
      tools.appendChild(b);
    }

    // Palette popover: theme-aware presets + hue/shade sliders.
    this.color = new ColorPicker({
      get: () => {
        const path = this.annot.colorPathForTool();
        return path ? settings.get<string>(path) : null;
      },
      set: (c) => {
        const path = this.annot.colorPathForTool();
        if (path) void settings.set(path, c);
      },
      presets: () => {
        const tool = this.annot.getTool();
        if (tool === 'highlight' || tool === 'note') return HIGHLIGHTERS;
        return isDark() ? INK_DARK : INK_LIGHT;
      },
    });

    this.width = document.createElement('input');
    this.width.type = 'range';
    this.width.min = '1';
    this.width.max = '12';
    this.width.step = '1';
    this.width.title = 'Stroke width';
    this.width.className = 'annot-width';
    this.width.value = String(settings.get<number>('annotation.penWidth'));
    this.width.addEventListener('input', () => void settings.set('annotation.penWidth', Number(this.width.value)));

    // Font controls for text boxes & sticky notes (shown instead of stroke width).
    this.fontBox = document.createElement('div');
    this.fontBox.className = 'annot-font';
    this.fontBox.innerHTML = `
      <select class="annot-font-family" title="Font" aria-label="Font">
        <option value="sans" style="font-family:${FONT_STACKS.sans}">Sans</option>
        <option value="serif" style="font-family:${FONT_STACKS.serif}">Serif</option>
        <option value="mono" style="font-family:${FONT_STACKS.mono}">Mono</option>
        <option value="hand" style="font-family:${FONT_STACKS.hand}">Handwriting</option>
      </select>
      <div class="annot-font-size" role="group" aria-label="Font size">
        <button class="annot-tbtn fs-down" title="Smaller text" aria-label="Smaller text">${icon('minus')}</button>
        <input class="fs-value" type="number" min="6" max="72" step="1" title="Font size (pt)" aria-label="Font size in points" />
        <button class="annot-tbtn fs-up" title="Bigger text" aria-label="Bigger text">${icon('plus')}</button>
      </div>`;
    const fam = this.fontBox.querySelector<HTMLSelectElement>('.annot-font-family')!;
    const size = this.fontBox.querySelector<HTMLInputElement>('.fs-value')!;
    fam.addEventListener('change', () => void this.annot.setTextStyle({ family: fam.value as FontFamily }));
    size.addEventListener('change', () => void this.annot.setTextStyle({ size: Number(size.value) }));
    // Keep the text box focused while stepping the size (mousedown would blur it).
    for (const [sel, d] of [['.fs-down', -1], ['.fs-up', 1]] as const) {
      const b = this.fontBox.querySelector<HTMLButtonElement>(sel)!;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => void this.annot.setTextStyle({ size: this.annot.currentTextStyle().size + d * stepFor(this.annot.currentTextStyle().size) }));
    }
    this.annot.onTextStyleChange(() => this.syncInputs());

    const sep = () => { const s = document.createElement('span'); s.className = 'annot-sep'; return s; };
    const actions = document.createElement('div');
    actions.className = 'annot-bar-actions';
    for (const [cmd, ico, title] of [
      ['annot.undo', 'undo', 'Undo (Ctrl+Z)'],
      ['annot.redo', 'redo', 'Redo (Ctrl+Shift+Z)'],
      ['annot.export', 'download', 'Export PDF (Ctrl+S)'],
    ] as const) {
      const b = document.createElement('button');
      b.className = 'annot-tbtn';
      b.innerHTML = icon(ico);
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', () => this.registry.dispatch(cmd));
      actions.appendChild(b);
    }

    const close = document.createElement('button');
    close.className = 'annot-tbtn annot-close';
    close.innerHTML = icon('x');
    close.title = 'Close annotation tools (Esc)';
    close.setAttribute('aria-label', 'Close annotation tools');
    // The bar is only visible while annotation mode is on, so toggling = exit.
    close.addEventListener('click', () => { if (this.annot.isActive()) this.registry.dispatch('annot.toggleMode'); });

    // Erase menu: this page / what's in view / everything (each undoable).
    const trash = document.createElement('button');
    trash.className = 'annot-tbtn';
    trash.innerHTML = icon('trash');
    trash.title = 'Erase annotations…';
    trash.setAttribute('aria-label', 'Erase annotations');
    trash.setAttribute('aria-haspopup', 'menu');
    trash.addEventListener('click', () => this.toggleEraseMenu(trash));
    actions.insertBefore(trash, actions.lastElementChild); // before Export

    this.el.append(tools, sep(), this.color.el, this.width, this.fontBox, sep(), actions, sep(), close);
    dock().register('annot', this.el);

    this.annot.onToolChange((tool, active) => this.refresh(tool, active));
    settings.subscribe('annotation', () => this.syncInputs());
    // Colours are per theme: re-read when dark mode flips.
    settings.subscribe('darkMode', () => this.syncInputs());
  }

  private menu: HTMLDivElement | null = null;

  private toggleEraseMenu(anchor: HTMLElement): void {
    if (this.menu) return this.closeMenu();
    const m = document.createElement('div');
    m.className = 'menu-pop';
    m.setAttribute('role', 'menu');
    const items: Array<[string, string, string]> = [
      ['annot.clearView', 'Erase what’s in view', ''],
      ['annot.clearPage', 'Erase on this page', 'Shift+Del'],
      ['annot.clearAll', 'Erase everything', 'Ctrl+Shift+Del'],
    ];
    m.innerHTML = items
      .map(([cmd, label, key]) => `<button role="menuitem" data-cmd="${cmd}" class="menu-item${cmd === 'annot.clearAll' ? ' danger' : ''}"><span>${label}</span>${key ? `<kbd>${key}</kbd>` : ''}</button>`)
      .join('') + `<div class="menu-note">Ctrl+Z brings them back</div>`;
    m.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((b) =>
      b.addEventListener('click', () => {
        this.closeMenu();
        void this.registry.dispatch(b.dataset.cmd!);
      }),
    );
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    const left = Math.min(window.innerWidth - m.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - m.offsetWidth / 2));
    const top = r.top - m.offsetHeight - 10;
    m.style.left = `${Math.round(left)}px`;
    m.style.top = `${Math.round(top >= 8 ? top : r.bottom + 10)}px`;
    this.menu = m;
    setTimeout(() => document.addEventListener('pointerdown', this.onOutside, true));
  }

  private closeMenu(): void {
    document.removeEventListener('pointerdown', this.onOutside, true);
    dismiss(this.menu);
    this.menu = null;
  }

  private onOutside = (e: PointerEvent) => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
  };

  private refresh(tool: AnnotTool, active: boolean): void {
    if (!active) {
      this.closeMenu();
      this.color.close();
    }
    // Rolls in over the main toolbar while annotating, back out when done.
    if (active) dock().open('annot');
    else dock().close('annot');
    for (const [t, b] of this.buttons) b.classList.toggle('active', t === tool && active);
    this.syncInputs();
  }

  private syncInputs(): void {
    this.color.refresh();
    // Show the control that fits the tool: font for text tools, width for strokes.
    const tool = this.annot.getTool();
    const isText = tool === 'textbox' || tool === 'note';
    const isStroke = tool === 'pen' || tool === 'rectangle' || tool === 'ellipse' || tool === 'arrow';
    this.fontBox.hidden = !isText;
    this.width.hidden = !isStroke;
    const st = this.annot.currentTextStyle();
    const fam = this.fontBox.querySelector<HTMLSelectElement>('.annot-font-family')!;
    const size = this.fontBox.querySelector<HTMLInputElement>('.fs-value')!;
    fam.value = st.family;
    fam.style.fontFamily = FONT_STACKS[st.family];
    if (document.activeElement !== size) size.value = String(st.size);
    this.width.value = String(settings.get<number>('annotation.penWidth'));
  }
}
