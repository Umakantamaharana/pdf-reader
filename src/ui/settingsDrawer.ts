/**
 * settingsDrawer.ts — Settings as a left slide-in panel inside the reader.
 *
 * Opening settings no longer leaves the document: the panel slides in from the
 * left over the page (with a soft scrim), hosts the shared settings UI
 * (ui/settingsView.ts) and applies changes live. Close with ×, Esc, a click on
 * the scrim, or the settings command again. Mounted lazily on first open.
 */

import { mountSettings } from './settingsView';
import { setOpen } from './motion';
import { icon } from './icons';

export class SettingsDrawer {
  private el: HTMLElement;
  private scrim: HTMLDivElement;
  private body: HTMLDivElement;
  private mounted = false;
  private open = false;
  private returnFocus: HTMLElement | null = null;

  constructor() {
    this.scrim = document.createElement('div');
    this.scrim.className = 'settings-scrim';
    this.scrim.addEventListener('click', () => this.close());

    this.el = document.createElement('aside');
    this.el.className = 'settings-drawer';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Settings');
    this.el.innerHTML = `
      <div class="sd-head">
        <span class="sd-title">${icon('settings')}<span>Settings</span></span>
        <button class="lumen-tbtn sd-close" title="Close settings (Esc)" aria-label="Close settings">${icon('x')}</button>
      </div>
      <div class="sd-body"></div>`;
    this.body = this.el.querySelector('.sd-body')!;
    this.el.querySelector('.sd-close')!.addEventListener('click', () => this.close());
    // Esc closes the panel even while its search box or a select has focus.
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.body.classList.contains('capturing-keys')) {
        e.stopPropagation();
        this.close();
      }
    });
    setOpen(this.el, false);
    setOpen(this.scrim, false);
    document.body.append(this.scrim, this.el);
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open ? this.close() : this.show();
  }

  show(): void {
    if (!this.mounted) {
      mountSettings(this.body);
      this.mounted = true;
    }
    this.open = true;
    this.returnFocus = document.activeElement as HTMLElement | null;
    setOpen(this.el, true);
    setOpen(this.scrim, true);
    // Focus the search box once the slide has started.
    setTimeout(() => this.body.querySelector<HTMLInputElement>('.settings-search')?.focus({ preventScroll: true }), 60);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    setOpen(this.el, false);
    setOpen(this.scrim, false);
    this.returnFocus?.focus?.({ preventScroll: true });
  }
}
