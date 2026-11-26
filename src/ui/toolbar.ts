/**
 * toolbar.ts — Minimal, toggleable floating/docked toolbar.
 *
 * Every button just dispatches a command id, so the toolbar and keyboard stay
 * in perfect sync. Visibility and position are driven by settings.ui and the
 * distraction-free master toggle; a status readout shows page/zoom.
 */

import { CommandRegistry } from '../core/commands';
import { settings } from '../core/settings';
import { AppSettings } from '../core/schema';
import { ViewerState } from '../viewer/pdfViewer';
import { icon } from './icons';

interface Btn {
  cmd: string;
  ico: string;
  title: string;
}

const BUTTONS: Btn[] = [
  { cmd: 'view.toggleSidebar', ico: 'panel-left', title: 'Sidebar (s)' },
  { cmd: 'nav.prevPage', ico: 'chevron-left', title: 'Previous page (k)' },
  { cmd: 'nav.nextPage', ico: 'chevron-right', title: 'Next page (j)' },
  { cmd: 'view.zoomOut', ico: 'zoom-out', title: 'Zoom out' },
  { cmd: 'view.zoomIn', ico: 'zoom-in', title: 'Zoom in' },
  { cmd: 'view.fitWidth', ico: 'move-horizontal', title: 'Fit width (⇧W)' },
  { cmd: 'view.cycleLayout', ico: 'columns', title: 'Cycle layout (l)' },
  { cmd: 'view.rotateCW', ico: 'rotate-cw', title: 'Rotate (r)' },
  { cmd: 'annot.toggleMode', ico: 'square-pen', title: 'Annotate (a)' },
  { cmd: 'dark.toggle', ico: 'moon', title: 'Dark mode (⇧I)' },
  { cmd: 'dark.panel', ico: 'sliders', title: 'Display & colors (⇧D)' },
  { cmd: 'tts.playPause', ico: 'volume-2', title: 'Read aloud (space)' },
  { cmd: 'app.commandPalette', ico: 'command', title: 'Command palette (Ctrl+K)' },
  { cmd: 'app.settings', ico: 'settings', title: 'Settings (Ctrl+,)' },
];

const LAYOUT_ICON: Record<string, string> = {
  single: 'layout-single',
  'two-page': 'columns',
  continuous: 'layout-rows',
};

export class Toolbar {
  private registry: CommandRegistry;
  private el: HTMLDivElement;
  private status: HTMLSpanElement;
  private handle: HTMLButtonElement; // floating "show toolbar" tab when hidden
  private layoutBtn?: HTMLButtonElement; // reflects the current layout mode

  constructor(registry: CommandRegistry) {
    this.registry = registry;
    this.el = document.createElement('div');
    this.el.className = 'lumen-toolbar';

    const group = document.createElement('div');
    group.className = 'lumen-toolbar-buttons';
    for (const b of BUTTONS) {
      const btn = document.createElement('button');
      btn.className = 'lumen-tbtn';
      btn.innerHTML = icon(b.ico);
      btn.title = b.title;
      btn.setAttribute('aria-label', b.title);
      btn.addEventListener('click', () => this.registry.dispatch(b.cmd));
      if (b.cmd === 'view.cycleLayout') this.layoutBtn = btn;
      group.appendChild(btn);
    }

    // Hide button (not a command — directly flips the visibility setting).
    const hideBtn = document.createElement('button');
    hideBtn.className = 'lumen-tbtn lumen-hide';
    hideBtn.innerHTML = icon('chevron-down');
    hideBtn.title = 'Hide toolbar (t to toggle)';
    hideBtn.addEventListener('click', () => settings.set('ui.toolbarVisible', false));
    group.appendChild(hideBtn);

    this.status = document.createElement('span');
    this.status.className = 'lumen-status';

    this.el.appendChild(group);
    this.el.appendChild(this.status);
    document.body.appendChild(this.el);

    // Reveal handle shown only while the toolbar is hidden.
    this.handle = document.createElement('button');
    this.handle.className = 'lumen-toolbar-handle';
    this.handle.innerHTML = icon('more-horizontal');
    this.handle.title = 'Show toolbar (t)';
    this.handle.addEventListener('click', () => settings.set('ui.toolbarVisible', true));
    document.body.appendChild(this.handle);

    this.applyUi(settings.get<AppSettings['ui']>('ui'));
    settings.subscribe('ui', () => this.applyUi(settings.get('ui')));
  }

  applyUi(ui: AppSettings['ui']): void {
    const hidden = !ui.toolbarVisible || ui.distractionFree;
    this.el.hidden = hidden;
    this.el.dataset.position = ui.toolbarPosition;
    this.el.dataset.density = ui.density;
    // Offer the reveal handle whenever the bar is hidden but not in full
    // distraction-free mode (which hides everything on purpose).
    this.handle.hidden = ui.distractionFree || ui.toolbarVisible;
    document.body.classList.toggle('distraction-free', ui.distractionFree);
  }

  updateStatus(s: ViewerState): void {
    this.status.textContent = `${s.page} / ${s.pageCount}  ·  ${Math.round(s.scale * 100)}%  ·  ${s.layout}`;
    if (this.layoutBtn) {
      this.layoutBtn.innerHTML = icon(LAYOUT_ICON[s.layout] ?? 'columns');
      this.layoutBtn.title = `Layout: ${s.layout} — click to cycle (l)`;
    }
  }
}
