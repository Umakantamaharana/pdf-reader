/**
 * toolbar.ts — Minimal, toggleable floating/docked toolbar.
 *
 * Every button just dispatches a command id, so the toolbar and keyboard stay
 * in perfect sync. It is the "main" face of the dock (ui/dock.ts): sub-toolbars
 * roll in over it and roll back out to it. Visibility and position come from
 * settings.ui and the distraction-free toggle; the readout shows only the page
 * (click it to jump to a page).
 */

import { CommandRegistry } from '../core/commands';
import { settings } from '../core/settings';
import { AppSettings } from '../core/schema';
import { ViewerState } from '../viewer/pdfViewer';
import { icon } from './icons';
import { dock } from './dock';

interface Btn {
  cmd: string;
  ico: string;
  title: string;
}

const BUTTONS: Btn[] = [
  { cmd: 'view.toggleSidebar', ico: 'panel-left', title: 'Sidebar (s)' },
  { cmd: 'nav.prevPage', ico: 'chevron-left', title: 'Previous page (←)' },
  { cmd: 'nav.nextPage', ico: 'chevron-right', title: 'Next page (→)' },
  { cmd: 'view.zoomOut', ico: 'zoom-out', title: 'Zoom out (Ctrl+−)' },
  { cmd: 'view.zoomIn', ico: 'zoom-in', title: 'Zoom in (Ctrl+=)' },
  { cmd: 'view.fitWidth', ico: 'move-horizontal', title: 'Fit width (Ctrl+2)' },
  { cmd: 'view.fitHeight', ico: 'move-vertical', title: 'Fit height (Ctrl+0)' },
  { cmd: 'view.cycleLayout', ico: 'columns', title: 'Cycle layout (l)' },
  { cmd: 'view.rotateCW', ico: 'rotate-cw', title: 'Rotate (r)' },
  { cmd: 'annot.toggleMode', ico: 'square-pen', title: 'Annotate (a)' },
  { cmd: 'dark.toggle', ico: 'moon', title: 'Dark mode (⇧D)' },
  { cmd: 'dark.panel', ico: 'sliders', title: 'Night mode toolbar (⇧Alt+D)' },
  { cmd: 'tts.playPause', ico: 'volume-2', title: 'Read aloud (Ctrl+Shift+U)' },
  { cmd: 'app.commandPalette', ico: 'command', title: 'Command palette (Ctrl+K)' },
  { cmd: 'app.settings', ico: 'settings', title: 'Settings (Ctrl+,)' },
];

/** Buttons that toggle something show an animated on/off state. */
const TOGGLE_STATE: Record<string, () => boolean> = {
  'view.toggleSidebar': () => settings.get<boolean>('viewing.sidebar.visible'),
  'dark.toggle': () => {
    const dm = settings.get<AppSettings['darkMode']>('darkMode');
    return dm.enabled && dm.mode !== 'off';
  },
  'annot.toggleMode': () => dock().isOpen('annot'),
  'dark.panel': () => dock().isOpen('display'),
  'tts.playPause': () => dock().isOpen('tts'),
};

const LAYOUT_ICON: Record<string, string> = {
  single: 'layout-single',
  'two-page': 'columns',
  continuous: 'layout-rows',
};

export class Toolbar {
  private registry: CommandRegistry;
  private el: HTMLDivElement;
  private status: HTMLButtonElement;
  private handle: HTMLButtonElement; // floating "show toolbar" tab when hidden
  private layoutBtn?: HTMLButtonElement; // reflects the current layout mode
  private toggles = new Map<string, HTMLButtonElement>();

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
      if (TOGGLE_STATE[b.cmd]) {
        btn.classList.add('is-toggle');
        this.toggles.set(b.cmd, btn);
      }
      group.appendChild(btn);
    }

    // Hide button (not a command — directly flips the visibility setting).
    const hideBtn = document.createElement('button');
    hideBtn.className = 'lumen-tbtn lumen-hide';
    hideBtn.innerHTML = icon('chevron-down');
    hideBtn.title = 'Hide toolbar (t to toggle)';
    hideBtn.addEventListener('click', () => settings.set('ui.toolbarVisible', false));
    group.appendChild(hideBtn);

    this.status = document.createElement('button');
    this.status.className = 'lumen-status';
    this.status.title = 'Go to page (Ctrl+G)';
    this.status.addEventListener('click', () => this.registry.dispatch('nav.gotoPage'));

    this.el.appendChild(group);
    this.el.appendChild(this.status);
    dock().register('main', this.el);
    // The reveal handle only makes sense while the main face is showing.
    dock().onChange(() => {
      this.applyUi(settings.get('ui'));
      this.refreshToggles();
    });
    settings.subscribe('viewing.sidebar', () => this.refreshToggles());
    settings.subscribe('darkMode', () => this.refreshToggles());

    // Reveal handle shown only while the toolbar is hidden.
    this.handle = document.createElement('button');
    this.handle.className = 'lumen-toolbar-handle';
    this.handle.innerHTML = icon('more-horizontal');
    this.handle.title = 'Show toolbar (t)';
    this.handle.addEventListener('click', () => settings.set('ui.toolbarVisible', true));
    document.body.appendChild(this.handle);

    this.applyUi(settings.get<AppSettings['ui']>('ui'));
    this.refreshToggles();
    settings.subscribe('ui', () => this.applyUi(settings.get('ui')));
  }

  applyUi(ui: AppSettings['ui']): void {
    const hidden = !ui.toolbarVisible || ui.distractionFree;
    // Animated hide (tips away) instead of display:none popping it out.
    this.el.classList.toggle('is-hidden', hidden);
    this.el.inert = hidden;
    dock().el.dataset.position = ui.toolbarPosition;
    this.el.dataset.density = ui.density;
    // Offer the reveal handle whenever the bar is hidden but not in full
    // distraction-free mode (which hides everything on purpose).
    const handleHidden = ui.distractionFree || ui.toolbarVisible || dock().top() !== 'main';
    this.handle.classList.toggle('is-hidden', handleHidden);
    this.handle.inert = handleHidden;
    document.body.classList.toggle('distraction-free', ui.distractionFree);
  }

  private shownLayout = '';

  /** Reflect on/off state on toggle buttons (CSS animates the change). */
  private refreshToggles(): void {
    for (const [cmd, btn] of this.toggles) {
      const on = TOGGLE_STATE[cmd]();
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  updateStatus(s: ViewerState): void {
    this.status.textContent = `${s.page} / ${s.pageCount}`;
    // Only touch the button when the layout actually changes: this runs on every
    // page/zoom change, and rewriting a hovered button's content + tooltip each
    // time made its tooltip flash on and off.
    if (this.layoutBtn && s.layout !== this.shownLayout) {
      this.shownLayout = s.layout;
      this.layoutBtn.innerHTML = icon(LAYOUT_ICON[s.layout] ?? 'columns');
      this.layoutBtn.dataset.tip = `Layout: ${s.layout} — click to cycle (l)`;
      this.layoutBtn.removeAttribute('title');
    }
  }
}
