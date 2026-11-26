/**
 * tts.ts — Read-aloud engine with live highlighting.
 *
 * Engines:
 *  - Kokoro-82M via kokoro-js (WebGPU, WASM fallback), lazy-loaded on first use.
 *  - Native window.speechSynthesis — always-available fallback, used while the
 *    Kokoro model downloads, when the user selects it, or if Kokoro fails to load.
 *
 * Highlighting uses the CSS Custom Highlight API over the text layer (same
 * approach as search): the current sentence is tinted, and with the native
 * engine individual words are highlighted via boundary events. Text is read
 * from the current page to the end of the document, built lazily page by page.
 *
 * Runs in the viewer page (not the offscreen doc) so synthesis timing and page
 * highlighting stay in sync; the offscreen scaffold remains for future
 * background reading.
 */

import { PDFViewer } from './pdfViewer';
import { settings } from '../core/settings';
import { icon } from '../ui/icons';

interface Sentence { page: number; start: number; end: number; text: string }

const HL_SENT = 'lumen-tts';
const HL_WORD = 'lumen-tts-word';
const supportsHL = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (globalThis as any).Highlight === 'function';

// A small, high-quality subset of Kokoro's voices for the picker.
const KOKORO_VOICES = [
  ['af_bella', 'Bella (US F) 🔥'], ['af_heart', 'Heart (US F) ❤️'], ['af_nicole', 'Nicole (US F) 🎧'],
  ['am_michael', 'Michael (US M)'], ['am_fenrir', 'Fenrir (US M)'], ['bf_emma', 'Emma (UK F)'], ['bm_george', 'George (UK M)'],
] as const;

export class TtsController {
  private pdf: PDFViewer;
  private toast: (m: string) => void;

  private sentences: Sentence[] = [];
  private builtPage = 0;
  private index = 0;
  private state: 'idle' | 'loading' | 'playing' | 'paused' = 'idle';
  private playToken = 0;

  private kokoro: any = null;
  private kokoroLoading: Promise<any> | null = null;
  private audio = new Audio();

  // UI
  private bar!: HTMLDivElement;
  private statusEl!: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;

  constructor(pdf: PDFViewer, toast: (m: string) => void = () => {}) {
    this.pdf = pdf;
    this.toast = toast;
    this.buildBar();
    if (settings.get<boolean>('tts.preloadModelOnStart')) void this.ensureKokoro();
  }

  // ---- Command entry points --------------------------------------------

  async playPause(): Promise<void> {
    if (this.state === 'playing') return this.pause();
    if (this.state === 'paused') return this.resume();
    await this.start(this.pdf.state.page);
  }

  async readFromCursor(): Promise<void> {
    const sel = window.getSelection();
    const node = sel && !sel.isCollapsed ? sel.anchorNode : null;
    const pageEl = (node?.parentElement as HTMLElement)?.closest?.('.pdf-page') as HTMLElement | null;
    await this.start(pageEl ? Number(pageEl.dataset.page) : this.pdf.state.page);
  }

  stop(): void {
    this.playToken++;
    this.audio.pause();
    speechSynthesis.cancel();
    this.state = 'idle';
    this.clearHighlight();
    this.bar.hidden = true;
  }

  nextSentence(): void {
    if (this.state === 'idle') return;
    void this.start(undefined, Math.min(this.index + 1, this.sentences.length - 1));
  }
  prevSentence(): void {
    if (this.state === 'idle') return;
    void this.start(undefined, Math.max(0, this.index - 1));
  }

  async speedUp(): Promise<void> {
    await this.nudgeSpeed(0.1);
  }
  async speedDown(): Promise<void> {
    await this.nudgeSpeed(-0.1);
  }
  private async nudgeSpeed(d: number): Promise<void> {
    const v = Math.min(2, Math.max(0.5, Math.round((settings.get<number>('tts.speed') + d) * 10) / 10));
    await settings.set('tts.speed', v);
    this.audio.playbackRate = v; // immediate effect for the Kokoro clip in flight
    this.updateStatus();
  }

  // ---- Playback loop ----------------------------------------------------

  private async start(fromPage?: number, fromIndex?: number): Promise<void> {
    this.playToken++;
    const token = this.playToken;
    this.audio.pause();
    speechSynthesis.cancel();
    this.bar.hidden = false;

    if (fromIndex != null) {
      this.index = fromIndex;
    } else if (fromPage != null) {
      await this.ensureBuilt(fromPage);
      this.index = this.sentences.findIndex((s) => s.page >= fromPage);
      if (this.index < 0) this.index = 0;
    }

    // Kick off Kokoro loading in the background if that engine is selected.
    if (settings.get<string>('tts.engine') !== 'native') void this.ensureKokoro();

    this.state = 'playing';
    this.setPlayIcon();

    for (let i = this.index; token === this.playToken; i++) {
      await this.ensureIndex(i);
      const s = this.sentences[i];
      if (!s) break; // end of document
      this.index = i;
      this.updateStatus();
      await this.pdf.ensurePageRendered(s.page);
      if (token !== this.playToken) return;
      this.highlightSentence(s);
      try {
        await this.speak(s, token);
      } catch {
        /* cancelled */
        return;
      }
    }
    if (token === this.playToken) {
      this.state = 'idle';
      this.clearHighlight();
      this.setPlayIcon();
      this.toast('Finished reading');
    }
  }

  private pause(): void {
    this.state = 'paused';
    if (this.usingNative()) speechSynthesis.pause();
    else this.audio.pause();
    this.setPlayIcon();
  }
  private resume(): void {
    this.state = 'playing';
    if (this.usingNative()) speechSynthesis.resume();
    else void this.audio.play();
    this.setPlayIcon();
  }

  /** Speak one sentence, resolving when done; rejects if the token is superseded. */
  private speak(s: Sentence, token: number): Promise<void> {
    const engine = settings.get<string>('tts.engine');
    const useKokoro = engine !== 'native' && this.kokoro;
    if (useKokoro) return this.speakKokoro(s, token);
    // native (also the fallback while the model is still downloading)
    return this.speakNative(s, token);
  }

  private async speakKokoro(s: Sentence, token: number): Promise<void> {
    const voice = settings.get<string>('tts.voice') || 'af_bella';
    const speed = settings.get<number>('tts.speed');
    const raw = await this.kokoro.generate(s.text, { voice, speed });
    if (token !== this.playToken) throw new Error('cancelled');
    const url = URL.createObjectURL(await rawToBlob(raw));
    return new Promise<void>((resolve, reject) => {
      this.audio.src = url;
      this.audio.playbackRate = 1;
      const done = () => { URL.revokeObjectURL(url); cleanup(); token === this.playToken ? resolve() : reject(new Error('cancelled')); };
      const fail = () => { URL.revokeObjectURL(url); cleanup(); reject(new Error('cancelled')); };
      const cleanup = () => { this.audio.onended = null; this.audio.onerror = null; };
      this.audio.onended = done;
      this.audio.onerror = fail;
      void this.audio.play().catch(fail);
    });
  }

  private speakNative(s: Sentence, token: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(s.text);
      u.rate = settings.get<number>('tts.speed');
      u.pitch = settings.get<number>('tts.pitch');
      const voiceName = settings.get<string>('tts.voice');
      const match = speechSynthesis.getVoices().find((v) => v.name === voiceName);
      if (match) u.voice = match;
      if (settings.get<string>('tts.highlightGranularity') === 'word') {
        u.onboundary = (e) => {
          if (e.name === 'word' || e.charIndex != null) this.highlightWord(s, e.charIndex, e.charLength || 0);
        };
      }
      u.onend = () => (token === this.playToken ? resolve() : reject(new Error('cancelled')));
      u.onerror = () => reject(new Error('cancelled'));
      speechSynthesis.speak(u);
    });
  }

  private usingNative(): boolean {
    return settings.get<string>('tts.engine') === 'native' || !this.kokoro;
  }

  // ---- Kokoro loading ---------------------------------------------------

  private ensureKokoro(): Promise<any> {
    if (this.kokoro) return Promise.resolve(this.kokoro);
    if (this.kokoroLoading) return this.kokoroLoading;
    this.state = this.state === 'idle' ? 'loading' : this.state;
    this.kokoroLoading = (async () => {
      try {
        const { KokoroTTS } = await import('kokoro-js');
        // MV3 forbids blob: workers, so run onnxruntime on the main thread
        // (no proxy worker, single-threaded WASM). WebGPU is unaffected.
        try {
          const tf: any = await import('@huggingface/transformers');
          const wasm = tf?.env?.backends?.onnx?.wasm;
          if (wasm) { wasm.numThreads = 1; wasm.proxy = false; }
        } catch { /* best-effort */ }

        // Try the preferred device first, then fall back a level at a time.
        // WebGPU frequently downloads the weights fine but then fails to build
        // the inference session (no adapter in the extension context), which
        // previously dropped straight to the browser voice — the reported bug.
        const wantGpu = settings.get<boolean>('tts.preferWebGPU') && 'gpu' in navigator;
        const attempts: Array<{ device: 'webgpu' | 'wasm'; dtype: 'fp32' | 'q8' }> = wantGpu
          ? [{ device: 'webgpu', dtype: 'fp32' }, { device: 'wasm', dtype: 'q8' }]
          : [{ device: 'wasm', dtype: 'q8' }];

        let lastErr: unknown;
        for (const { device, dtype } of attempts) {
          try {
            this.setStatus(`Loading voice model… (${device})`);
            this.kokoro = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
              dtype,
              device,
              progress_callback: (p: any) => {
                if (p?.status === 'progress' && p.total) this.setStatus(`Downloading model ${Math.round((p.loaded / p.total) * 100)}%`);
              },
            });
            this.toast(`Neural voice ready (${device})`);
            this.populateVoices();
            this.updateStatus();
            return this.kokoro;
          } catch (err) {
            lastErr = err;
            console.warn(`Kokoro load failed on ${device}, trying next`, err);
          }
        }
        throw lastErr ?? new Error('Kokoro unavailable');
      } catch (err) {
        console.warn('Kokoro load failed, using native voice', err);
        this.toast('Using browser voice (neural model unavailable)');
        this.kokoroLoading = null;
        return null;
      }
    })();
    return this.kokoroLoading;
  }

  // ---- Sentence building ------------------------------------------------

  private async ensureIndex(i: number): Promise<void> {
    while (this.sentences.length <= i && this.builtPage < this.pdf.state.pageCount) {
      await this.buildPage(this.builtPage + 1);
    }
  }
  private async ensureBuilt(page: number): Promise<void> {
    while (this.builtPage < page) await this.buildPage(this.builtPage + 1);
  }

  private async buildPage(page: number): Promise<void> {
    this.builtPage = page;
    const items = await this.pdf.getPageItems(page);
    const text = items.join('');
    for (const [start, end] of splitSentences(text)) {
      const t = text.slice(start, end).trim();
      if (t) this.sentences.push({ page, start, end, text: t });
    }
  }

  // ---- Highlighting -----------------------------------------------------

  private highlightSentence(s: Sentence): void {
    if (!supportsHL) return;
    const layer = this.pdf.getTextLayer(s.page);
    if (!layer) return;
    const range = rangeFor(layer.items, layer.divs, s.start, s.end);
    const hl = new (globalThis as any).Highlight();
    if (range) hl.add(range);
    CSS.highlights.set(HL_SENT, hl);
    CSS.highlights.delete(HL_WORD);
    const loc = locate(layer.items, s.start, false);
    (loc && layer.divs[loc.item])?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  private highlightWord(s: Sentence, charIndex: number, len: number): void {
    if (!supportsHL) return;
    const layer = this.pdf.getTextLayer(s.page);
    if (!layer) return;
    const start = s.start + charIndex;
    const end = s.start + charIndex + (len || wordLenAt(s.text, charIndex));
    const range = rangeFor(layer.items, layer.divs, start, end);
    const hl = new (globalThis as any).Highlight();
    if (range) hl.add(range);
    CSS.highlights.set(HL_WORD, hl);
  }

  private clearHighlight(): void {
    if (!supportsHL) return;
    CSS.highlights.delete(HL_SENT);
    CSS.highlights.delete(HL_WORD);
  }

  // ---- UI ---------------------------------------------------------------

  private buildBar(): void {
    this.bar = document.createElement('div');
    this.bar.className = 'tts-bar';
    this.bar.hidden = true;
    this.bar.innerHTML = `
      <button class="tts-btn" data-act="prev" title="Previous sentence (Ctrl+←)" aria-label="Previous sentence">${icon('skip-back')}</button>
      <button class="tts-btn tts-play" data-act="play" title="Play/Pause (Space)" aria-label="Play or pause">${icon('play')}</button>
      <button class="tts-btn" data-act="next" title="Next sentence (Ctrl+→)" aria-label="Next sentence">${icon('skip-forward')}</button>
      <button class="tts-btn" data-act="stop" title="Stop (Shift+Space)" aria-label="Stop">${icon('stop-circle')}</button>
      <button class="tts-btn" data-act="slower" title="Slower ([)" aria-label="Slower">${icon('minus')}</button>
      <button class="tts-btn" data-act="faster" title="Faster (])" aria-label="Faster">${icon('plus')}</button>
      <select class="tts-engine" title="Engine">
        <option value="kokoro">Kokoro (neural)</option>
        <option value="native">Browser voice</option>
      </select>
      <select class="tts-voice" title="Voice"></select>
      <span class="tts-status"></span>`;
    document.body.appendChild(this.bar);
    this.statusEl = this.bar.querySelector('.tts-status')!;
    this.playBtn = this.bar.querySelector('.tts-play')!;

    this.bar.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'play') void this.playPause();
        else if (a === 'next') this.nextSentence();
        else if (a === 'prev') this.prevSentence();
        else if (a === 'stop') this.stop();
        else if (a === 'faster') void this.speedUp();
        else if (a === 'slower') void this.speedDown();
      }),
    );

    const engineSel = this.bar.querySelector('.tts-engine') as HTMLSelectElement;
    engineSel.value = settings.get<string>('tts.engine') === 'native' ? 'native' : 'kokoro';
    engineSel.addEventListener('change', async () => {
      await settings.set('tts.engine', engineSel.value);
      this.populateVoices();
      if (engineSel.value !== 'native') void this.ensureKokoro();
    });

    const voiceSel = this.bar.querySelector('.tts-voice') as HTMLSelectElement;
    voiceSel.addEventListener('change', () => settings.set('tts.voice', voiceSel.value));
    this.populateVoices();
    speechSynthesis?.addEventListener?.('voiceschanged', () => this.populateVoices());
  }

  private populateVoices(): void {
    const voiceSel = this.bar.querySelector('.tts-voice') as HTMLSelectElement;
    if (!voiceSel) return;
    const native = settings.get<string>('tts.engine') === 'native';
    const list: [string, string][] = native
      ? speechSynthesis.getVoices().map((v) => [v.name, `${v.name} (${v.lang})`])
      : (KOKORO_VOICES as readonly (readonly [string, string])[]).map((v) => [v[0], v[1]]);
    const current = settings.get<string>('tts.voice');
    voiceSel.innerHTML = list.map(([val, label]) => `<option value="${val}" ${val === current ? 'selected' : ''}>${label}</option>`).join('');
    if (!native && !KOKORO_VOICES.some(([v]) => v === current)) voiceSel.value = 'af_bella';
  }

  private setPlayIcon(): void {
    this.playBtn.innerHTML = this.state === 'playing' ? icon('pause') : icon('play');
  }
  private setStatus(msg: string): void {
    this.statusEl.textContent = msg;
  }
  private updateStatus(): void {
    const total = this.sentences.length;
    this.setStatus(`${this.index + 1}${total ? '/' + total : ''}  ·  ${settings.get<number>('tts.speed')}×`);
  }
}

// ---- helpers ------------------------------------------------------------

/** Split text into [start,end) sentence ranges on terminal punctuation. */
function splitSentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  const re = /[.!?…]+[\s)"']*\s/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    out.push([start, end]);
    start = end;
  }
  if (start < text.length) out.push([start, text.length]);
  return out;
}

function wordLenAt(text: string, i: number): number {
  const m = /\S+/.exec(text.slice(i));
  return m ? m[0].length : 1;
}

function locate(items: string[], pos: number, isEnd: boolean): { item: number; local: number } | null {
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const len = items[i].length;
    const within = isEnd ? pos <= acc + len && pos > acc : pos >= acc && pos < acc + len;
    if (within) return { item: i, local: pos - acc };
    acc += len;
  }
  if (isEnd && pos === acc && items.length) return { item: items.length - 1, local: items[items.length - 1].length };
  return null;
}

function rangeFor(items: string[], divs: HTMLElement[], start: number, end: number): Range | null {
  const s = locate(items, start, false);
  const e = locate(items, end, true);
  if (!s || !e) return null;
  const sn = divs[s.item]?.firstChild;
  const en = divs[e.item]?.firstChild;
  if (!sn || !en) return null;
  try {
    const r = document.createRange();
    r.setStart(sn, Math.min(s.local, (sn as Text).length));
    r.setEnd(en, Math.min(e.local, (en as Text).length));
    return r;
  } catch {
    return null;
  }
}

/** Convert a kokoro-js RawAudio to a WAV Blob (with a manual-encode fallback). */
async function rawToBlob(raw: any): Promise<Blob> {
  if (typeof raw?.toBlob === 'function') {
    try { return await raw.toBlob(); } catch { /* fall through */ }
  }
  const data: Float32Array = raw.audio ?? raw.data;
  const sr: number = raw.sampling_rate ?? 24000;
  return new Blob([encodeWav(data, sr)], { type: 'audio/wav' });
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const w = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  w(36, 'data'); view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}
