/**
 * displayPanel.ts — Popover for dark-mode & color controls.
 *
 * Exposes the full color engine in the viewer (not just the Settings page):
 * enable, mode, preset chooser, live background/foreground color pickers that
 * edit the active preset, and brightness/contrast sliders. Everything writes to
 * settings.darkMode, which the DarkModeEngine applies live.
 */

import { settings } from '../core/settings';
import { AppSettings, ColorPreset } from '../core/schema';

export class DisplayPanel {
  private el: HTMLDivElement;
  private open = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'display-panel';
    this.el.hidden = true;
    document.body.appendChild(this.el);
    this.render();
    settings.subscribe('darkMode', () => { if (this.open) this.render(); });
    document.addEventListener('mousedown', (e) => {
      if (this.open && !this.el.contains(e.target as Node)) this.close();
    });
  }

  toggle(): void {
    this.open ? this.close() : this.show();
  }
  show(): void {
    this.open = true;
    this.el.hidden = false;
    this.render();
  }
  close(): void {
    this.open = false;
    this.el.hidden = true;
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
    this.el.innerHTML = `
      <div class="dp-head">
        <strong>Display</strong>
        <label class="dp-switch"><input type="checkbox" id="dp-enabled" ${dm.enabled ? 'checked' : ''}/> Dark mode</label>
      </div>
      <label class="dp-row">Mode
        <select id="dp-mode">
          <option value="smart-invert" ${dm.mode === 'smart-invert' ? 'selected' : ''}>Smart invert</option>
          <option value="custom-colors" ${dm.mode === 'custom-colors' ? 'selected' : ''}>Custom colors</option>
          <option value="off" ${dm.mode === 'off' ? 'selected' : ''}>Off</option>
        </select>
      </label>
      <div class="dp-presets" id="dp-presets">
        ${dm.presets.map((p) => `<button class="dp-preset ${p.id === dm.activePresetId ? 'active' : ''}" data-id="${p.id}" style="background:${p.background};color:${p.foreground}" title="${p.name}">A</button>`).join('')}
      </div>
      <label class="dp-row">Background <input type="color" id="dp-bg" value="${preset.background}"/></label>
      <label class="dp-row">Text <input type="color" id="dp-fg" value="${preset.foreground}"/></label>
      <label class="dp-row">Brightness <input type="range" id="dp-bright" min="0.5" max="1.5" step="0.05" value="${dm.brightness}"/><output>${dm.brightness}</output></label>
      <label class="dp-row">Contrast <input type="range" id="dp-contrast" min="0.5" max="1.5" step="0.05" value="${dm.contrast}"/><output>${dm.contrast}</output></label>
      <label class="dp-row"><input type="checkbox" id="dp-img" ${dm.smartImageProtection ? 'checked' : ''}/> Protect images</label>
    `;

    this.q('#dp-enabled').addEventListener('change', (e) => settings.set('darkMode.enabled', (e.target as HTMLInputElement).checked));
    this.q('#dp-mode').addEventListener('change', (e) => settings.patch({ 'darkMode.mode': (e.target as HTMLSelectElement).value, 'darkMode.enabled': true }));
    this.q('#dp-presets').querySelectorAll<HTMLButtonElement>('.dp-preset').forEach((b) =>
      b.addEventListener('click', () => settings.patch({ 'darkMode.activePresetId': b.dataset.id!, 'darkMode.enabled': true })),
    );
    this.q('#dp-bg').addEventListener('input', (e) => this.updatePresetColor('background', (e.target as HTMLInputElement).value));
    this.q('#dp-fg').addEventListener('input', (e) => this.updatePresetColor('foreground', (e.target as HTMLInputElement).value));
    this.q('#dp-bright').addEventListener('input', (e) => settings.set('darkMode.brightness', Number((e.target as HTMLInputElement).value)));
    this.q('#dp-contrast').addEventListener('input', (e) => settings.set('darkMode.contrast', Number((e.target as HTMLInputElement).value)));
    this.q('#dp-img').addEventListener('change', (e) => settings.set('darkMode.smartImageProtection', (e.target as HTMLInputElement).checked));
  }

  private q(sel: string): HTMLElement {
    return this.el.querySelector(sel) as HTMLElement;
  }
}
