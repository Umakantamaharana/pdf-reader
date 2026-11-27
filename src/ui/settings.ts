/**
 * settings.ts — The extension's Options page (chrome://extensions → Options).
 *
 * A thin host for the shared settings UI (ui/settingsView.ts), which the
 * reader also shows as its left slide-in settings panel. Follows the reader's
 * light/dark theme.
 */

import { settings } from '../core/settings';
import { mountSettings } from './settingsView';
import './settings.css';

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
  mountSettings(document.querySelector<HTMLElement>('.settings-shell')!, { title: 'sobelpdf Settings' });
  // "/" focuses the search box on the full page.
  document.addEventListener('keydown', (e) => {
    const search = document.querySelector<HTMLInputElement>('.settings-search');
    if (e.key === '/' && search && document.activeElement !== search) { e.preventDefault(); search.focus(); }
  });
}

void boot();
