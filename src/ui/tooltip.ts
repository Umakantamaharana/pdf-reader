/**
 * tooltip.ts — One shared, styled tooltip for every button in the viewer.
 *
 * Native `title` tooltips flickered over the glass bars: they're drawn by the
 * OS, briefly flash while the backdrop-filter surface repaints, and restart
 * whenever a hovered button's content changes. This replaces them: on first
 * hover an element's `title` moves to `data-tip` (so the native one never
 * shows), and a single glass tooltip appears after a short delay, positioned
 * above (or below) the element, and hides on leave, press, scroll or key.
 */

/** First tooltip waits for a deliberate hover (OS-like), so merely passing
 *  over the toolbar never pops one up. */
const SHOW_DELAY_MS = 700;
/** Once a tooltip has been shown, neighbours show almost at once (no flicker
 *  of hide → long wait → show when sliding along the bar). */
const WARM_DELAY_MS = 60;
const WARM_WINDOW_MS = 500;

export function installTooltips(): void {
  const tip = document.createElement('div');
  tip.className = 'lumen-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);

  let target: HTMLElement | null = null;
  let timer: number | undefined;
  let lastShownAt = 0;

  const hide = () => {
    clearTimeout(timer);
    target = null;
    if (tip.classList.contains('show')) lastShownAt = performance.now();
    tip.classList.remove('show');
  };

  const show = () => {
    if (!target || !target.isConnected) return hide();
    // Skip if the pointer already left, or the bar is rolling away in the dock.
    if (!target.matches(':hover') || target.closest('.dock-face:not(.is-active)')) return hide();
    const text = target.dataset.tip;
    if (!text) return;
    tip.textContent = text;
    const r = target.getBoundingClientRect();
    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.classList.add('show');
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const left = Math.min(window.innerWidth - tw - 6, Math.max(6, r.left + r.width / 2 - tw / 2));
    const above = r.top - th - 8;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(above >= 6 ? above : r.bottom + 8)}px`;
  };

  document.addEventListener('pointerover', (e) => {
    const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title], [data-tip]');
    if (!el || el.closest('.textLayer')) return;
    if (el.hasAttribute('title')) {
      el.dataset.tip = el.getAttribute('title') || el.dataset.tip || '';
      el.removeAttribute('title');
    }
    if (el === target) return;
    const warm = tip.classList.contains('show') || performance.now() - lastShownAt < WARM_WINDOW_MS;
    hide();
    target = el;
    timer = window.setTimeout(show, warm ? WARM_DELAY_MS : SHOW_DELAY_MS);
  });
  document.addEventListener('pointerout', (e) => {
    if (!target) return;
    const to = e.relatedTarget as Node | null;
    if (to && target.contains(to)) return;
    hide();
  });
  for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) document.addEventListener(ev, hide, true);
  window.addEventListener('blur', hide);
}
