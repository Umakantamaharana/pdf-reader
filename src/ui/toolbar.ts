/**
 * toolbar.ts — The main toolbar (the "main" face of the dock, ui/dock.ts).
 *
 * Every button dispatches a command id, so toolbar and keyboard stay in sync.
 * Items are grouped; all groups except page navigation and the ⋯ menu are
 * optional (`ui.toolbarItems`), so each user decides how big the bar is. The
 * ⋯ menu shows/hides items, moves the bar (bottom / left) and hides it.
 * Night mode's on/off button and its settings button sit together in one pill
 * so it's clear the second one belongs to night mode. Toggle buttons show an
 * animated on/off state; the fit button flips between fit width and fit page
 * (like Edge) and shows the mode it will switch to.
 */

import { CommandRegistry } from '../core/commands';
import { settings } from '../core/settings';
import { AppSettings, ToolbarItems } from '../core/schema';
import { ViewerState } from '../viewer/pdfViewer';
import { icon } from './icons';
import { dock } from './dock';
import { dismiss } from './motion';

interface Btn {
  cmd: string;
  ico: string;
  title: string;
}

/** A toolbar group: an optional item (key) or an always-shown one (null). */
interface Group {
  key: keyof ToolbarItems | null;
  label: string;
  buttons: Btn[];
  /** Render the buttons as one joined pill (e.g. night mode + its settings). */
  pill?: boolean;
}

const GROUPS: Group[] = [
  { key: 'sidebar', label: 'Sidebar', buttons: [{ cmd: 'view.toggleSidebar', ico: 'panel-left', title: 'Sidebar (s)' }] },
  {
    key: null,
    label: 'Pages',
    buttons: [
      { cmd: 'nav.prevPage', ico: 'chevron-left', title: 'Previous page (←)' },
      { cmd: 'nav.nextPage', ico: 'chevron-right', title: 'Next page (→)' },
    ],
  },
  {
    key: 'zoom',
    label: 'Zoom',
    buttons: [
      { cmd: 'view.zoomOut', ico: 'zoom-out', title: 'Zoom out (Ctrl+−)' },
      { cmd: 'view.zoomIn', ico: 'zoom-in', title: 'Zoom in (Ctrl+=)' },
    ],
  },
  { key: 'fit', label: 'Fit width / page', buttons: [{ cmd: 'view.toggleFit', ico: 'fit-page', title: 'Fit page' }] },
  { key: 'layout', label: 'Layout', buttons: [{ cmd: 'view.cycleLayout', ico: 'layout-rows', title: 'Cycle layout (l)' }] },
  { key: 'rotate', label: 'Rotate', buttons: [{ cmd: 'view.rotateCW', ico: 'rotate-cw', title: 'Rotate (Ctrl+])' }] },
  { key: 'annotate', label: 'Annotate', buttons: [{ cmd: 'annot.toggleMode', ico: 'square-pen', title: 'Annotate (a)' }] },
  {
    key: 'night',
    label: 'Night mode',
    pill: true,
    buttons: [
      { cmd: 'dark.toggle', ico: 'moon', title: 'Night mode (Shift+D)' },
      { cmd: 'dark.panel', ico: 'sliders', title: 'Night mode settings (Alt+Shift+D)' },
    ],
  },
  { key: 'read', label: 'Read aloud', buttons: [{ cmd: 'tts.playPause', ico: 'volume-2', title: 'Read aloud (Ctrl+Shift+U)' }] },
  { key: 'find', label: 'Find', buttons: [{ cmd: 'search.open', ico: 'search', title: 'Find (Ctrl+F)' }] },
  { key: 'save', label: 'Save', buttons: [{ cmd: 'annot.export', ico: 'save', title: 'Save a copy with annotations (Ctrl+S)' }] },
  { key: 'fullscreen', label: 'Full screen', buttons: [{ cmd: 'view.presentation', ico: 'maximize', title: 'Full screen (F5)' }] },
  { key: 'palette', label: 'Command palette', buttons: [{ cmd: 'app.commandPalette', ico: 'command', title: 'Command palette (Ctrl+K)' }] },
  { key: 'settings', label: 'Settings', buttons: [{ cmd: 'app.settings', ico: 'settings', title: 'Settings (Ctrl+,)' }] },
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
  'view.presentation': () => !!document.fullscreenElement,
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
  private buttons = new Map<string, HTMLButtonElement>();
  private groups = new Map<keyof ToolbarItems, HTMLElement>();
  private toggles = new Map<string, HTMLButtonElement>();
  private moreBtn: HTMLButtonElement;
  private menu: HTMLDivElement | null = null;

  constructor(registry: CommandRegistry) {
    this.registry = registry;
    this.el = document.createElement('div');
    this.el.className = 'lumen-toolbar';

    const bar = document.createElement('div');
    bar.className = 'lumen-toolbar-buttons';
    this.status = document.createElement('button');

    for (const g of GROUPS) {
      const wrap = document.createElement('div');
      wrap.className = g.pill ? 'tb-group tb-pill' : 'tb-group';
      if (g.pill) wrap.setAttribute('role', 'group');
      if (g.pill) wrap.setAttribute('aria-label', g.label);
      for (const b of g.buttons) wrap.appendChild(this.makeButton(b));
      // The page readout sits between previous and next.
      if (g.key === null) {
        this.status.className = 'lumen-status';
        this.status.title = 'Go to page (Ctrl+G)';
        this.status.addEventListener('click', () => this.registry.dispatch('nav.gotoPage'));
        wrap.insertBefore(this.status, wrap.lastElementChild);
      }
      if (g.key) this.groups.set(g.key, wrap);
      bar.appendChild(wrap);
    }

    // ⋯ menu: customise items, move the bar, hide it.
    this.moreBtn = document.createElement('button');
    this.moreBtn.className = 'lumen-tbtn tb-more';
    this.moreBtn.title = 'Customise toolbar';
    this.moreBtn.setAttribute('aria-label', 'Customise toolbar');
    this.moreBtn.setAttribute('aria-haspopup', 'menu');
    this.moreBtn.addEventListener('click', () => (this.menu ? this.closeMenu() : this.openMenu()));
    const moreWrap = document.createElement('div');
    moreWrap.className = 'tb-group';
    moreWrap.appendChild(this.moreBtn);
    bar.appendChild(moreWrap);

    this.el.appendChild(bar);
    dock().register('main', this.el);
    dock().onChange(() => {
      this.applyUi(settings.get('ui'));
      this.refreshToggles();
    });
    settings.subscribe('viewing.sidebar', () => this.refreshToggles());
    settings.subscribe('darkMode', () => this.refreshToggles());
    document.addEventListener('fullscreenchange', () => this.refreshToggles());

    // Reveal handle shown only while the toolbar is hidden.
    this.handle = document.createElement('button');
    this.handle.className = 'lumen-toolbar-handle';
    this.handle.title = 'Show toolbar (t)';
    this.handle.addEventListener('click', () => settings.set('ui.toolbarVisible', true));
    document.body.appendChild(this.handle);

    this.applyUi(settings.get<AppSettings['ui']>('ui'));
    this.refreshToggles();
    settings.subscribe('ui', () => this.applyUi(settings.get('ui')));
  }

  private makeButton(b: Btn): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'lumen-tbtn';
    btn.innerHTML = icon(b.ico);
    btn.title = b.title;
    btn.setAttribute('aria-label', b.title);
    btn.addEventListener('click', () => this.registry.dispatch(b.cmd));
    if (TOGGLE_STATE[b.cmd]) {
      btn.classList.add('is-toggle');
      this.toggles.set(b.cmd, btn);
    }
    this.buttons.set(b.cmd, btn);
    return btn;
  }

  applyUi(ui: AppSettings['ui']): void {
    const hidden = !ui.toolbarVisible || ui.distractionFree;
    // Animated hide (tips away) instead of display:none popping it out.
    if (this.el.classList.contains('is-hidden') !== hidden) dock().pulse();
    this.el.classList.toggle('is-hidden', hidden);
    this.el.inert = hidden;
    const pos = ui.toolbarPosition === 'left' ? 'left' : 'bottom';
    dock().el.dataset.position = pos;
    document.body.dataset.toolbar = pos;
    this.el.dataset.density = ui.density;
    for (const [key, el] of this.groups) el.hidden = ui.toolbarItems?.[key] === false;
    this.moreBtn.innerHTML = icon(pos === 'left' ? 'more-vertical' : 'more-horizontal');
    this.handle.innerHTML = icon(pos === 'left' ? 'more-vertical' : 'more-horizontal');
    // Offer the reveal handle whenever the bar is hidden but not in full
    // distraction-free mode (which hides everything on purpose).
    const handleHidden = ui.distractionFree || ui.toolbarVisible || dock().top() !== 'main';
    this.handle.classList.toggle('is-hidden', handleHidden);
    this.handle.inert = handleHidden;
    document.body.classList.toggle('distraction-free', ui.distractionFree);
    if (this.menu) this.renderMenu();
  }

  // ---- ⋯ menu --------------------------------------------------------------

  private openMenu(): void {
    this.menu = document.createElement('div');
    this.menu.className = 'menu-pop tb-menu';
    this.menu.setAttribute('role', 'menu');
    document.body.appendChild(this.menu);
    this.renderMenu();
    setTimeout(() => {
      document.addEventListener('pointerdown', this.onOutside, true);
      document.addEventListener('keydown', this.onKey, true);
    });
  }

  private renderMenu(): void {
    const m = this.menu;
    if (!m) return;
    const ui = settings.get<AppSettings['ui']>('ui');
    const items = GROUPS.filter((g) => g.key);
    m.innerHTML = `
      <div class="menu-title">Show in toolbar</div>
      ${items
        .map(
          (g) => `<label class="menu-check" role="menuitemcheckbox" aria-checked="${ui.toolbarItems[g.key!] !== false}">
            <input type="checkbox" data-key="${g.key}" ${ui.toolbarItems[g.key!] !== false ? 'checked' : ''}/>
            <span class="menu-ico">${icon(g.buttons[0].ico)}</span><span>${g.label}</span></label>`,
        )
        .join('')}
      <div class="menu-sep"></div>
      <div class="menu-title">Position</div>
      <div class="menu-seg" role="radiogroup" aria-label="Toolbar position">
        <button data-pos="bottom" class="${ui.toolbarPosition !== 'left' ? 'is-on' : ''}" role="radio" aria-checked="${ui.toolbarPosition !== 'left'}">Bottom</button>
        <button data-pos="left" class="${ui.toolbarPosition === 'left' ? 'is-on' : ''}" role="radio" aria-checked="${ui.toolbarPosition === 'left'}">Left</button>
      </div>
      <div class="menu-sep"></div>
      <button class="menu-item" data-act="hide"><span>Hide toolbar</span><kbd>T</kbd></button>
      <button class="menu-item" data-act="settings"><span>All settings</span><kbd>Ctrl+,</kbd></button>`;
    m.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((cb) =>
      cb.addEventListener('change', () => void settings.set(`ui.toolbarItems.${cb.dataset.key}`, cb.checked)),
    );
    m.querySelectorAll<HTMLButtonElement>('[data-pos]').forEach((b) =>
      b.addEventListener('click', () => void settings.set('ui.toolbarPosition', b.dataset.pos)),
    );
    m.querySelector('[data-act="hide"]')!.addEventListener('click', () => {
      this.closeMenu();
      void settings.set('ui.toolbarVisible', false);
    });
    m.querySelector('[data-act="settings"]')!.addEventListener('click', () => {
      this.closeMenu();
      void this.registry.dispatch('app.settings');
    });
    this.placeMenu();
  }

  /** Above the ⋯ button (bottom bar) or beside it (left bar), kept on screen. */
  private placeMenu(): void {
    const m = this.menu;
    if (!m) return;
    const r = this.moreBtn.getBoundingClientRect();
    const left = settings.get<string>('ui.toolbarPosition') === 'left';
    let x: number, y: number;
    if (left) {
      x = r.right + 12;
      y = r.top + r.height / 2 - m.offsetHeight / 2;
    } else {
      x = r.left + r.width / 2 - m.offsetWidth / 2;
      y = r.top - m.offsetHeight - 12;
    }
    m.style.left = `${Math.round(Math.min(window.innerWidth - m.offsetWidth - 8, Math.max(8, x)))}px`;
    m.style.top = `${Math.round(Math.min(window.innerHeight - m.offsetHeight - 8, Math.max(8, y)))}px`;
    m.style.transformOrigin = left ? 'left center' : 'bottom center';
  }

  private closeMenu(): void {
    document.removeEventListener('pointerdown', this.onOutside, true);
    document.removeEventListener('keydown', this.onKey, true);
    dismiss(this.menu);
    this.menu = null;
  }

  private onOutside = (e: PointerEvent) => {
    const t = e.target as Node;
    if (this.menu?.contains(t) || this.moreBtn.contains(t)) return;
    this.closeMenu();
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      this.closeMenu();
    }
  };

  // ---- state ------------------------------------------------------------------

  /** Reflect on/off state on toggle buttons (CSS animates the change). */
  private refreshToggles(): void {
    for (const [cmd, btn] of this.toggles) {
      const on = TOGGLE_STATE[cmd]();
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    const fs = this.buttons.get('view.presentation');
    if (fs) {
      const on = !!document.fullscreenElement;
      if (fs.dataset.state !== String(on)) {
        fs.dataset.state = String(on);
        fs.innerHTML = icon(on ? 'minimize' : 'maximize');
        fs.dataset.tip = on ? 'Exit full screen (F5 / Esc)' : 'Full screen (F5)';
        fs.removeAttribute('title');
      }
    }
  }

  private shown = { layout: '', fit: '' };

  updateStatus(s: ViewerState): void {
    this.status.textContent = `${s.page} / ${s.pageCount}`;
    // Only touch buttons when their state actually changes: this runs on every
    // page/zoom change, and rewriting a hovered button's content restarts its
    // tooltip.
    const layoutBtn = this.buttons.get('view.cycleLayout');
    if (layoutBtn && s.layout !== this.shown.layout) {
      this.shown.layout = s.layout;
      layoutBtn.innerHTML = icon(LAYOUT_ICON[s.layout] ?? 'columns');
      layoutBtn.dataset.tip = `Layout: ${s.layout} — click to cycle (l)`;
      layoutBtn.removeAttribute('title');
    }
    // Fit toggle shows what a click will do: in fit-width it offers fit page.
    const fitBtn = this.buttons.get('view.toggleFit');
    const fitKey = s.fit === 'width' ? 'width' : 'other';
    if (fitBtn && fitKey !== this.shown.fit) {
      this.shown.fit = fitKey;
      fitBtn.innerHTML = icon(fitKey === 'width' ? 'fit-page' : 'fit-width');
      fitBtn.dataset.tip = fitKey === 'width' ? 'Fit page (Ctrl+3)' : 'Fit width (Ctrl+2)';
      fitBtn.setAttribute('aria-label', fitBtn.dataset.tip);
      fitBtn.removeAttribute('title');
    }
  }
}
