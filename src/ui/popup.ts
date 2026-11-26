/** popup.ts — Browser-action popup: open a URL in the reader or jump to settings.
 *  Follows the reader's light/dark theme (dark while dark mode is on). */

import { settings } from '../core/settings';

void settings.init().then(() => {
  const dm = settings.get<any>('darkMode');
  document.body.classList.toggle('lumen-dark', !!dm?.enabled && dm?.mode !== 'off');
});

const urlInput = document.getElementById('url') as HTMLInputElement;

document.getElementById('open')!.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url) return;
  chrome.runtime.sendMessage({ type: 'open-in-reader', url }, () => window.close());
});

document.getElementById('settings')!.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') (document.getElementById('open') as HTMLButtonElement).click();
});
