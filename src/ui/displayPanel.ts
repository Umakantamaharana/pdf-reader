/**
 * displayPanel.ts — The night-mode toolbar (a dock face, see ui/dock.ts).
 *
 * Opened from the toolbar's sliders button (or Shift+Alt+D), it rolls in over
 * the main toolbar as a single row of controls: dark-mode switch, mode,
 * the built-in "Soft Night" theme chip (click to restore brightness 1 /
 * contrast 0.6), brightness and contrast sliders, image protection, and — in
 * custom-colors mode only — background/text pickers. × rolls back.
 * Everything writes to settings.darkMode, which the DarkModeEngine applies live.
 */

import { settings } from '../core/settings';
import { AppSettings, ColorPreset } from '../core/schema';
import { applyPreset } from '../viewer/darkmode';
import { dock } from './dock';
import { icon } from './icons';

export class DisplayPanel {
  private el: HTMLDivElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'display-bar';
    dock().register('display', this.el);
    this.render();
    settings.subscribe('darkMode', () => {
      // Don't rebuild under a slider being dragged — it would drop the drag.
      const a = document.activeElement as HTMLInputElement | null;
      if (a && this.el.contains(a) && a.type === 'range') {
        const out = a.parentElement?.querySelector('output');
        if (out) out.textContent = a.value;
        return;
      }
      this.render();
    });
  }

  toggle(): void {
    dock().toggle('display');
  }
  show(): void {
    this.render();
    dock().open('display');
  }
  close(): void {
    dock().close('display');
  }

  private dm(): AppSettings['darkMode'] {
    return settings.get('darkMode');
  }
  private activePreset(): ColorPreset {
    const dm = this.dm();
    return dm.presets.find((p) => p.id === dm.activePresetId) ?? dm.presets[0];
  }

  private async updatePresetColor(which: 'background' | 'foreground', value: string) {
    const dm = this.dm();
    const presets = dm.presets.map((p) => (p.id === dm.activePresetId ? { ...p, [which]: value } : p));
    await settings.patch({ 'darkMode.presets': presets, 'darkMode.enabled': true });
  }

  private render(): void {
    const dm = this.dm();
    const preset = this.activePreset();
    const themes = dm.presets
      .map((p) => {
        const matches =
          p.id === dm.activePresetId &&
          (p.brightness == null || p.brightness === dm.brightness) &&
          (p.contrast == null || p.contrast === dm.contrast);
        const detail = p.brightness != null ? `Brightness ${p.brightness} · Contrast ${p.contrast}` : p.name;
        return `<button class="db-theme ${matches ? 'active' : ''}" data-id="${p.id}" title="${p.name} — ${detail}${matches ? '' : ' (click to restore)'}">
          <span class="db-swatch" style="background:${p.background};color:${p.foreground}">A</span>${p.name}</button>`;
      })
      .join('');

    this.el.innerHTML = `
      <label class="db-switch" title="Dark mode (Shift+D)">
        <input type="checkbox" id="db-enabled" ${dm.enabled ? 'checked' : ''}/>
        <span class="db-switch-track"></span>${icon('moon')}
      </label>
      <select id="db-mode" class="db-select" title="Mode">
        <option value="smart-invert" ${dm.mode === 'smart-invert' ? 'selected' : ''}>Smart invert</option>
        <option value="custom-colors" ${dm.mode === 'custom-colors' ? 'selected' : ''}>Custom colors</option>
        <option value="off" ${dm.mode === 'off' ? 'selected' : ''}>Off</option>
      </select>
      ${themes}
      <span class="db-sep"></span>
      <label class="db-slider" title="Brightness (Alt+] / Alt+[)">${icon('sun')}
        <input type="range" id="db-bright" min="0.5" max="1.5" step="0.05" value="${dm.brightness}"/><output>${dm.brightness}</output>
      </label>
      <label class="db-slider" title="Contrast">${icon('contrast')}
        <input type="range" id="db-contrast" min="0.5" max="1.5" step="0.05" value="${dm.contrast}"/><output>${dm.contrast}</output>
      </label>
      <label class="db-check" title="Keep photos looking normal under smart invert">
        <input type="checkbox" id="db-img" ${dm.smartImageProtection ? 'checked' : ''}/>${icon('image')}
      </label>
      ${dm.mode === 'custom-colors' ? `
      <span class="db-sep"></span>
      <label class="db-color" title="Background"><input type="color" id="db-bg" value="${preset.background}"/></label>
      <label class="db-color" title="Text"><input type="color" id="db-fg" value="${preset.foreground}"/></label>` : ''}
      <span class="db-sep"></span>
      <button class="annot-tbtn db-close" title="Close night mode toolbar (Esc)" aria-label="Close night mode toolbar">${icon('x')}</button>
    `;

    const val = (e: Event) => (e.target as HTMLInputElement).value;
    this.q('#db-enabled').addEventListener('change', (e) => settings.set('darkMode.enabled', (e.target as HTMLInputElement).checked));
    this.q('#db-mode').addEventListener('change', (e) => settings.patch({ 'darkMode.mode': val(e), 'darkMode.enabled': true }));
    this.el.querySelectorAll<HTMLButtonElement>('.db-theme').forEach((b) =>
      b.addEventListener('click', () => {
        const p = this.dm().presets.find((x) => x.id === b.dataset.id);
        if (p) void applyPreset(p);
      }),
    );
    this.el.querySelector('#db-bg')?.addEventListener('input', (e) => this.updatePresetColor('background', val(e)));
    this.el.querySelector('#db-fg')?.addEventListener('input', (e) => this.updatePresetColor('foreground', val(e)));
    this.q('#db-bright').addEventListener('input', (e) => settings.set('darkMode.brightness', Number(val(e))));
    this.q('#db-contrast').addEventListener('input', (e) => settings.set('darkMode.contrast', Number(val(e))));
    this.el.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((r) =>
      r.addEventListener('change', () => { r.blur(); this.render(); }),
    );
    this.q('#db-img').addEventListener('change', (e) => settings.set('darkMode.smartImageProtection', (e.target as HTMLInputElement).checked));
    this.q('.db-close').addEventListener('click', () => this.close());
  }

  private q(sel: string): HTMLElement {
    return this.el.querySelector(sel) as HTMLElement;
  }
}
