/** popup.ts — Browser-action popup: open a URL in the reader or jump to settings. */

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
