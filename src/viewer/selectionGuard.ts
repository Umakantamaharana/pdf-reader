/**
 * selectionGuard.ts — Keeps text selection on pdf.js text layers smooth.
 *
 * The text layer is a cloud of absolutely-positioned spans. When the pointer
 * drifts into a gap between spans (line ends, column gutters, empty margins)
 * Chrome resolves the selection focus to the end of the whole container, so
 * the highlight suddenly jumps to "the rest of the page" or a huge paragraph.
 *
 * This is the same guard pdf.js's own viewer uses (TextLayerBuilder):
 *  - every text layer gets an invisible `.endOfContent` block;
 *  - while selecting, the layer gets `.selecting`, which stretches that block
 *    over the page (CSS) so gaps hit it instead of "after the last span";
 *  - on every selectionchange the block is moved right after the span where
 *    the selection currently ends, so the focus can never leap past it;
 *  - on pointerup / blur / keyup it's put back and `.selecting` removed.
 */

const layers = new Map<HTMLElement, HTMLDivElement>();
let listening = false;

/** Attach (or re-attach after a re-render) the guard to a text layer div. */
export function guardTextLayer(layer: HTMLElement): void {
  let end = layers.get(layer);
  if (!end) {
    end = document.createElement('div');
    end.className = 'endOfContent';
    layers.set(layer, end);
    layer.addEventListener('mousedown', () => layer.classList.add('selecting'));
  }
  reset(end, layer);
  enableGlobalListener();
}

function reset(end: HTMLDivElement, layer: HTMLElement): void {
  layer.append(end);
  end.style.width = '';
  end.style.height = '';
  layer.classList.remove('selecting');
}

function enableGlobalListener(): void {
  if (listening) return;
  listening = true;
  let pointerDown = false;
  const resetAll = () => layers.forEach((end, layer) => layer.isConnected && reset(end, layer));

  document.addEventListener('pointerdown', () => { pointerDown = true; });
  document.addEventListener('pointerup', () => { pointerDown = false; resetAll(); });
  window.addEventListener('blur', () => { pointerDown = false; resetAll(); });
  document.addEventListener('keyup', () => { if (!pointerDown) resetAll(); });

  let prevRange: Range | null = null;
  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) {
      resetAll();
      return;
    }
    // Mark the layers the selection touches; release the rest.
    const active = new Set<HTMLElement>();
    for (let i = 0; i < sel.rangeCount; i++) {
      const r = sel.getRangeAt(i);
      for (const layer of layers.keys()) if (!active.has(layer) && layer.isConnected && r.intersectsNode(layer)) active.add(layer);
    }
    for (const [layer, end] of layers) {
      if (active.has(layer)) layer.classList.add('selecting');
      else if (layer.isConnected) reset(end, layer);
    }

    // Park the end-block right after the moving end of the selection.
    const range = sel.getRangeAt(0);
    const modifyStart =
      !!prevRange &&
      (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
    let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
    if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    const el = anchor as HTMLElement | null;
    const layer = el?.parentElement?.closest<HTMLElement>('.textLayer') ?? null;
    const end = layer ? layers.get(layer) : undefined;
    if (layer && end && el?.parentElement) {
      end.style.width = layer.style.width;
      end.style.height = layer.style.height;
      el.parentElement.insertBefore(end, modifyStart ? el : el.nextSibling);
    }
    prevRange = range.cloneRange();
  });
}
