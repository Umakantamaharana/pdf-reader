/**
 * annotationBar.ts — Contextual toolbar shown while annotation mode is active.
 *
 * Gives a visible way to pick the current tool, its color, and stroke width
 * (the color input binds to whichever settings path the active tool draws with),
 * plus undo / redo / export. Buttons dispatch command ids, so they stay in sync
 * with the keyboard.
 */

import { CommandRegistry } from '../core/commands';
import { AnnotationManager, AnnotTool } from '../viewer/annotations';
import { settings } from '../core/settings';
import { icon } from './icons';

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
  { tool: 'eraser', cmd: 'annot.eraser', ico: 'eraser', title: 'Eraser (e)' },
];

export class AnnotationBar {
  private registry: CommandRegistry;
  private annot: AnnotationManager;
  private el: HTMLDivElement;
  private buttons = new Map<AnnotTool, HTMLButtonElement>();
  private color: HTMLInputElement;
  private width: HTMLInputElement;

  constructor(registry: CommandRegistry, annot: AnnotationManager) {
    this.registry = registry;
    this.annot = annot;

    this.el = document.createElement('div');
    this.el.className = 'annot-bar';
    this.el.hidden = true;

    const tools = document.createElement('div');
    tools.className = 'annot-bar-tools';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'annot-tbtn';
      b.innerHTML = icon(t.ico);
      b.title = t.title;
      b.setAttribute('aria-label', t.title);
      b.addEventListener('click', () => this.registry.dispatch(t.cmd));
      this.buttons.set(t.tool, b);
      tools.appendChild(b);
    }

    this.color = document.createElement('input');
    this.color.type = 'color';
    this.color.title = 'Color';
    this.color.className = 'annot-color';
    this.color.addEventListener('input', () => {
      const path = this.annot.colorPathForTool();
      if (path) void settings.set(path, this.color.value);
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

    this.el.append(tools, sep(), this.color, this.width, sep(), actions);
    document.body.appendChild(this.el);

    this.annot.onToolChange((tool, active) => this.refresh(tool, active));
    settings.subscribe('annotation', () => this.syncInputs());
  }

  private refresh(tool: AnnotTool, active: boolean): void {
    this.el.hidden = !active;
    for (const [t, b] of this.buttons) b.classList.toggle('active', t === tool && active);
    this.syncInputs();
  }

  private syncInputs(): void {
    const path = this.annot.colorPathForTool();
    if (path) this.color.value = settings.get<string>(path);
    this.color.disabled = !path;
    this.width.value = String(settings.get<number>('annotation.penWidth'));
  }
}
