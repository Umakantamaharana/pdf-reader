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
 * With `tts.skipNonProse` (default) chart labels, number tables, running
 * headers/footers and page numbers are skipped — see readingText.ts.
 *
 * ONNX Runtime's WASM is served from the extension bundle: transformers.js
 * otherwise points onnxruntime at a jsDelivr CDN, and the MV3 CSP blocks that
 * remote script, so every Kokoro session failed and reading silently fell back
 * to the browser voice.
 *
 * Playback and highlighting run in the viewer page; the neural model itself
 * runs in a dedicated worker (kokoroWorker.ts) so the page never freezes.
 */

import { PDFViewer } from './pdfViewer';
import { settings } from '../core/settings';
import { icon } from '../ui/icons';
import { dock } from '../ui/dock';
import { buildReadingText, cleanForSpeech, BREAK } from './readingText';
import { KokoroClient, KokoroDevice } from './kokoroClient';

/**
 * `start`/`end` are offsets in the page's joined item text (for highlighting);
 * `text` is the cleaned spoken text, and `map[k]` maps spoken char k back to a
 * joined-text offset (word highlighting from boundary events).
 */
interface Sentence { page: number; start: number; end: number; text: string; map: number[] }

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

  /** The loaded voice model (runs in a worker on GPU or CPU), or null. */
  private kokoro: KokoroClient | null = null;
  private kokoroLoading: Promise<KokoroClient | null> | null = null;
  private audio = new Audio();
  /** Speed the current Kokoro clip was synthesised at (playbackRate is relative to it). */
  private clipSpeed = 1;
  /** Look-ahead buffer: clips synthesised ahead of playback, keyed voice|speed|text. */
  private buffer = new Map<string, Promise<Blob>>();
  /** After a GPU failure this session, stay on the CPU even if Settings say GPU. */
  private forceCpu = false;

  // UI
  private bar!: HTMLDivElement;
  private statusEl!: HTMLSpanElement;
  private playBtn!: HTMLButtonElement;

  constructor(pdf: PDFViewer, toast: (m: string) => void = () => {}) {
    this.pdf = pdf;
    this.toast = toast;
    this.buildBar();
    if (settings.get<boolean>('tts.preloadModelOnStart')) void this.ensureKokoro();
    // Switching CPU/GPU in Settings reloads the model on the new device.
    settings.subscribe('tts.device', () => {
      this.forceCpu = false;
      this.resetModel();
      if (this.state !== 'idle' && settings.get<string>('tts.engine') !== 'native') void this.ensureKokoro();
    });
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

  /** Stop reading; the control bar stays open (use close() to dismiss it). */
  stop(): void {
    this.playToken++;
    this.audio.pause();
    speechSynthesis.cancel();
    this.buffer.clear();
    this.state = 'idle';
    this.clearHighlight();
    this.setPlayIcon();
  }

  /** Stop reading and hide the control bar. */
  close(): void {
    this.stop();
    dock().close('tts'); // roll back to the main toolbar
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
    this.audio.playbackRate = v / this.clipSpeed; // immediate effect for the Kokoro clip in flight
    this.buffer.clear(); // queued clips were synthesised at the old speed
    this.updateStatus();
  }

  // ---- Playback loop ----------------------------------------------------

  private async start(fromPage?: number, fromIndex?: number): Promise<void> {
    this.playToken++;
    const token = this.playToken;
    this.audio.pause();
    speechSynthesis.cancel();
    dock().open('tts');

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
        await this.speak(s, token, i);
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
  private speak(s: Sentence, token: number, index: number): Promise<void> {
    const engine = settings.get<string>('tts.engine');
    const useKokoro = engine !== 'native' && this.kokoro;
    if (useKokoro) return this.speakKokoro(s, token, index);
    // native (also the fallback while the model is still downloading)
    return this.speakNative(s, token);
  }

  private kokoroVoice(): string {
    const v = settings.get<string>('tts.voice');
    return KOKORO_VOICES.some(([id]) => id === v) ? v : 'af_bella';
  }

  private bufferKey(text: string): string {
    return `${this.kokoroVoice()}|${settings.get<number>('tts.speed')}|${text}`;
  }

  /** Synthesise a sentence, reusing a clip from the look-ahead buffer if ready. */
  private synth(text: string): Promise<Blob> {
    const key = this.bufferKey(text);
    const ready = this.buffer.get(key);
    if (ready) {
      this.buffer.delete(key);
      return ready;
    }
    return this.generateAudio(text, this.kokoroVoice(), settings.get<number>('tts.speed'));
  }

  /** How many sentences to prepare ahead (Settings → Read-aloud buffer). */
  private lookahead(): number {
    const v = settings.get<string>('tts.lookahead');
    return v === 'off' ? 0 : Math.max(0, Math.min(8, Number(v) || 2));
  }

  /**
   * Keep the next N sentences synthesised ahead of playback, one at a time
   * (never competing with the clip being made now). Stops when playback is
   * superseded (seek / stop) or the buffer is full.
   */
  private fillRunning = false;
  private async fillBuffer(fromIndex: number, token: number): Promise<void> {
    if (this.fillRunning) return;
    this.fillRunning = true;
    try {
      const n = this.lookahead();
      for (let i = fromIndex + 1; i <= fromIndex + n && token === this.playToken && this.kokoro; i++) {
        await this.ensureIndex(i);
        const s = this.sentences[i];
        if (!s) break;
        const key = this.bufferKey(s.text);
        if (this.buffer.has(key)) continue;
        const p = this.generateAudio(s.text, this.kokoroVoice(), settings.get<number>('tts.speed'));
        p.catch(() => this.buffer.delete(key)); // a failed clip is just made on demand later
        this.buffer.set(key, p);
        // Bound memory: drop the oldest entries beyond a small cap.
        while (this.buffer.size > n + 2) this.buffer.delete(this.buffer.keys().next().value as string);
        await p.catch(() => {});
      }
    } finally {
      this.fillRunning = false;
    }
  }

  /**
   * Synthesise `text` to a WAV blob, robustly:
   *  - long sentences are split at clause boundaries (≤ ~220 chars per call)
   *    and the audio concatenated, which keeps GPU memory per call small;
   *  - if the GPU runs out of memory / its device errors (seen as
   *    VK_ERROR_OUT_OF_DEVICE_MEMORY + cascading "Invalid Buffer" errors) or
   *    it returns NaN/silent audio, the model is reloaded on the CPU and the
   *    text is retried.
   */
  private async generateAudio(text: string, voice: string, speed: number): Promise<Blob> {
    const kokoro = this.kokoro;
    if (!kokoro) throw new Error('voice model not loaded');
    try {
      const parts: Float32Array[] = [];
      let rate = 24000;
      for (const chunk of chunkText(text, 220)) {
        const out = await kokoro.generate(chunk, { voice, speed });
        rate = out.rate;
        if (out.gpuError || !audioLooksValid(out.audio)) throw new Error('GPU produced invalid audio');
        parts.push(out.audio);
      }
      return new Blob([encodeWav(concatAudio(parts), rate)], { type: 'audio/wav' });
    } catch (err) {
      if (kokoro.device !== 'webgpu') throw err;
      console.warn('Kokoro on GPU failed; switching to CPU', err);
      await this.fallBackToCpu();
      if (!this.kokoro) throw err;
      return this.generateAudio(text, voice, speed);
    }
  }

  private fallingBack: Promise<void> | null = null;

  /** Drop the GPU model (frees its memory) and load the CPU one — once. */
  private fallBackToCpu(): Promise<void> {
    if (this.fallingBack) return this.fallingBack;
    this.fallingBack = (async () => {
      this.forceCpu = true;
      this.resetModel();
      // On "Auto", remember it: this GPU can't hold the model.
      if (settings.get<string>('tts.device') === 'auto') await settings.set('tts.preferWebGPU', false);
      this.toast('Graphics memory too low for the neural voice — using CPU (change in Settings)');
      await this.ensureKokoro();
    })().finally(() => { this.fallingBack = null; });
    return this.fallingBack;
  }

  /** Unload the model (terminates its worker) and forget queued clips. */
  private resetModel(): void {
    this.kokoro?.dispose();
    this.kokoro = null;
    this.kokoroLoading = null;
    this.buffer.clear();
  }

  private async speakKokoro(s: Sentence, token: number, index: number): Promise<void> {
    const speed = settings.get<number>('tts.speed');
    const blob = await this.synth(s.text);
    if (token !== this.playToken) throw new Error('cancelled');
    // Prepare the next sentences while this one plays.
    void this.fillBuffer(index, token);
    const url = URL.createObjectURL(blob);
    return new Promise<void>((resolve, reject) => {
      this.audio.src = url;
      this.clipSpeed = speed;
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

  /** Which devices to try, in order, from Settings → Voice runs on. */
  private devicePlan(): KokoroDevice[] {
    const pref = settings.get<string>('tts.device');
    const hasGpu = 'gpu' in navigator;
    if (this.forceCpu || pref === 'cpu' || !hasGpu) return ['wasm'];
    if (pref === 'gpu') return ['webgpu', 'wasm'];
    // auto: GPU unless it failed before on this machine.
    return settings.get<boolean>('tts.preferWebGPU') ? ['webgpu', 'wasm'] : ['wasm'];
  }

  private ensureKokoro(): Promise<KokoroClient | null> {
    if (this.kokoro) return Promise.resolve(this.kokoro);
    if (this.kokoroLoading) return this.kokoroLoading;
    this.kokoroLoading = (async () => {
      let lastErr: unknown;
      for (const device of this.devicePlan()) {
        let client: KokoroClient | null = null;
        try {
          client = new KokoroClient(device);
          this.setStatus(`Loading voice… (${device === 'webgpu' ? 'GPU' : 'CPU'})`);
          await client.load(device === 'webgpu' ? 'fp32' : 'q8', (loaded, total) =>
            this.setStatus(`Downloading voice ${Math.round((loaded / total) * 100)}%`),
          );
          this.kokoro = client;
          this.toast(`Neural voice ready (${device === 'webgpu' ? 'GPU' : 'CPU'})`);
          this.populateVoices();
          this.updateStatus();
          return client;
        } catch (err) {
          lastErr = err;
          client?.dispose();
          console.warn(`Kokoro failed to load on ${device}, trying next`, err);
        }
      }
      console.warn('Kokoro unavailable, using the browser voice', lastErr);
      this.toast('Using browser voice (neural voice unavailable — see console)');
      this.setStatus('Browser voice');
      this.kokoroLoading = null;
      return null;
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
    const skip = settings.get<boolean>('tts.skipNonProse');
    const geom = await this.pdf.getPageTextItems(page);
    const regions = skip ? await this.pdf.getImageRegions(page).catch(() => []) : [];
    let reading = buildReadingText(geom, regions, skip);
    // Clean mode rewrites symbols/abbreviations and drops citations, URLs,
    // inline maths… before splitting, keeping the highlight map intact.
    if (settings.get<string>('tts.readingMode') !== 'verbatim') reading = cleanForSpeech(reading);
    const { text, map } = reading;
    for (const [rs, re] of splitSentences(text)) {
      // Trim without changing lengths inside the sentence (keeps `map` exact).
      let a = rs;
      let b = re;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (a >= b) continue;
      const spoken = text.slice(a, b).replace(/\s/g, ' ');
      if (!/[\p{L}\p{N}]/u.test(spoken)) continue; // lone punctuation / bullets
      const smap = map.slice(a, b);
      this.sentences.push({ page, start: smap[0], end: smap[smap.length - 1] + 1, text: spoken, map: smap });
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
    const last = s.map.length - 1;
    const wl = len || wordLenAt(s.text, charIndex);
    const start = s.map[Math.min(charIndex, last)];
    const end = s.map[Math.min(charIndex + wl - 1, last)] + 1;
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
    this.bar.innerHTML = `
      <button class="tts-btn" data-act="prev" title="Previous sentence (Ctrl+←)" aria-label="Previous sentence">${icon('skip-back')}</button>
      <button class="tts-btn tts-play" data-act="play" title="Play/Pause (Ctrl+Shift+U)" aria-label="Play or pause">${icon('play')}</button>
      <button class="tts-btn" data-act="next" title="Next sentence (Ctrl+→)" aria-label="Next sentence">${icon('skip-forward')}</button>
      <button class="tts-btn" data-act="stop" title="Stop" aria-label="Stop">${icon('stop-circle')}</button>
      <button class="tts-btn" data-act="slower" title="Slower ([)" aria-label="Slower">${icon('minus')}</button>
      <button class="tts-btn" data-act="faster" title="Faster (])" aria-label="Faster">${icon('plus')}</button>
      <select class="tts-engine" title="Engine">
        <option value="kokoro">Kokoro (neural)</option>
        <option value="native">Browser voice</option>
      </select>
      <select class="tts-voice" title="Voice"></select>
      <span class="tts-status"></span>
      <button class="tts-btn tts-close" data-act="close" title="Close read-aloud (Esc)" aria-label="Close read-aloud">${icon('x')}</button>`;
    dock().register('tts', this.bar);
    this.statusEl = this.bar.querySelector('.tts-status')!;
    this.playBtn = this.bar.querySelector('.tts-play')!;

    this.bar.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'play') void this.playPause();
        else if (a === 'next') this.nextSentence();
        else if (a === 'prev') this.prevSentence();
        else if (a === 'stop') this.stop();
        else if (a === 'close') this.close();
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
  // Terminal punctuation followed by whitespace, or a forced break after a heading.
  const re = new RegExp(`[.!?…]+[\\s)"'”’]*\\s|${BREAK}`, 'g');
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

/** Split long text at clause boundaries into chunks of at most ~`max` chars. */
function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' – '));
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** Real speech: finite samples and not (near-)silence. A broken GPU run yields NaN or zeros. */
function audioLooksValid(data: Float32Array | undefined): boolean {
  if (!data || data.length === 0) return false;
  let peak = 0;
  const step = Math.max(1, Math.floor(data.length / 4000));
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (!Number.isFinite(v)) return false;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  return peak > 1e-3;
}

function concatAudio(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0];
  const gap = 2400; // 0.1 s of silence between chunks at 24 kHz
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * (parts.length - 1);
  const out = new Float32Array(total);
  let off = 0;
  parts.forEach((p, i) => {
    out.set(p, off);
    off += p.length + (i < parts.length - 1 ? gap : 0);
  });
  return out;
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
