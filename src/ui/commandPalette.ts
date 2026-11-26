/**
 * commandPalette.ts — Ctrl/Cmd+K fuzzy launcher.
 *
 * Lists every available command (and its current keybinding) and runs the
 * selected one through the CommandRegistry. Fully keyboard-driven:
 *   ↑/↓ or Ctrl+J/K to move, Enter to run, Esc to close.
 */

import { setOpen } from './motion';
import { CommandRegistry, RegisteredCommand } from '../core/commands';
import { ShortcutManager } from '../core/shortcuts';
import { settings } from '../core/settings';

export class CommandPalette {
  private registry: CommandRegistry;
  private shortcuts: ShortcutManager;
  private overlay: HTMLDivElement;
  private input: HTMLInputElement;
  private listEl: HTMLUListElement;
  private results: RegisteredCommand[] = [];
  private active = 0;
  private open = false;

  constructor(registry: CommandRegistry, shortcuts: ShortcutManager) {
    this.registry = registry;
    this.shortcuts = shortcuts;

    this.overlay = document.createElement('div');
    this.overlay.className = 'cmdk-overlay';
    setOpen(this.overlay, false);
    this.overlay.innerHTML = `
      <div class="cmdk-panel" role="dialog" aria-label="Command palette">
        <input class="cmdk-input" type="text" placeholder="Type a command…" autocomplete="off" spellcheck="false" />
        <ul class="cmdk-list" role="listbox"></ul>
      </div>`;
    document.body.appendChild(this.overlay);

    this.input = this.overlay.querySelector('.cmdk-input')!;
    this.listEl = this.overlay.querySelector('.cmdk-list')!;

    this.input.addEventListener('input', () => this.refresh());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  toggle(): void {
    this.open ? this.close() : this.show();
  }

  show(): void {
    if (!settings.get<boolean>('commandPalette.enabled')) return;
    this.open = true;
    setOpen(this.overlay, true);
    this.input.value = '';
    this.active = 0;
    this.refresh(true);
    this.input.focus();
  }

  close(): void {
    this.open = false;
    setOpen(this.overlay, false);
    this.input.blur();
  }

  isOpen(): boolean {
    return this.open;
  }

  private refresh(initial = false): void {
    const q = this.input.value.trim().toLowerCase();
    const pool = this.registry.available();
    if (!q) {
      const recent = this.registry.recentCommands(settings.get<number>('commandPalette.recentCount'));
      this.results = initial && recent.length ? recent : pool;
    } else {
      const fuzzy = settings.get<boolean>('commandPalette.fuzzy');
      this.results = pool
        .map((c) => ({ c, score: this.score(q, `${c.category} ${c.title}`.toLowerCase(), fuzzy) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.c);
    }
    this.active = 0;
    this.render();
  }

  /** Substring match (weighted by position) or subsequence fuzzy match. */
  private score(q: string, text: string, fuzzy: boolean): number {
    const idx = text.indexOf(q);
    if (idx !== -1) return 100 - idx;
    if (!fuzzy) return 0;
    let ti = 0;
    for (const ch of q) {
      ti = text.indexOf(ch, ti);
      if (ti === -1) return 0;
      ti++;
    }
    return 10;
  }

  private render(): void {
    this.listEl.innerHTML = '';
    this.results.forEach((cmd, i) => {
      const li = document.createElement('li');
      li.className = 'cmdk-item' + (i === this.active ? ' active' : '');
      li.setAttribute('role', 'option');
      const binding = this.shortcuts.bindingFor(cmd.id);
      li.innerHTML = `
        <span class="cmdk-cat">${cmd.category}</span>
        <span class="cmdk-title">${cmd.title}</span>
        ${binding ? `<kbd class="cmdk-key">${formatBinding(binding)}</kbd>` : ''}`;
      li.addEventListener('mouseenter', () => {
        this.active = i;
        this.render();
      });
      li.addEventListener('click', () => this.runActive());
      this.listEl.appendChild(li);
    });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') return void this.close();
    if (e.key === 'Enter') return void this.runActive();
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'j');
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'k');
    if (down) {
      e.preventDefault();
      this.active = Math.min(this.results.length - 1, this.active + 1);
      this.render();
    } else if (up) {
      e.preventDefault();
      this.active = Math.max(0, this.active - 1);
      this.render();
    }
  }

  private runActive(): void {
    const cmd = this.results[this.active];
    if (!cmd) return;
    this.close();
    void this.registry.dispatch(cmd.id);
  }
}

function formatBinding(b: string): string {
  return b
    .split(' ')
    .map((chord) => chord.split('+').map((p) => p.toUpperCase()).join('+'))
    .join(' ');
}
