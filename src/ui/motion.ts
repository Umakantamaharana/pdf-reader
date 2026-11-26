/**
 * motion.ts — Shared enter/leave helpers so every popover animates the same.
 *
 * Panels appear with a short fade + lift (CSS `@keyframes lumen-pop-in`) and
 * leave the same way in reverse: `dismiss()` adds `.is-leaving`, waits for the
 * exit animation, then removes the element. Long-lived panels that toggle
 * (command palette) use `setOpen()`, which flips `.is-open` + `inert` and lets
 * CSS transitions do the rest. Timings live in viewer.css (--motion-*).
 */

/** Animate an element out, then remove it. Safe to call twice. */
export function dismiss(el: Element | null | undefined, fallbackMs = 260): void {
  if (!el || !(el instanceof HTMLElement) || el.classList.contains('is-leaving')) return;
  el.classList.add('is-leaving');
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.remove();
  };
  el.addEventListener('animationend', finish, { once: true });
  window.setTimeout(finish, fallbackMs); // reduced-motion / no animation
}

/** Toggle a persistent panel open/closed via `.is-open` (CSS animates). */
export function setOpen(el: HTMLElement, open: boolean): void {
  el.classList.toggle('is-open', open);
  el.inert = !open;
  el.setAttribute('aria-hidden', String(!open));
}
