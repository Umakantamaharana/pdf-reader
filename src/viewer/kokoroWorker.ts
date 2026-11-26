/// <reference lib="webworker" />
/**
 * kokoroWorker.ts — Runs the Kokoro neural voice off the main thread.
 *
 * On the CPU (WASM) a sentence takes a noticeable moment to synthesise; doing
 * that on the page's thread froze scrolling and clicks while reading. Here it
 * runs in a dedicated module worker (bundled by Vite → allowed by the MV3
 * `worker-src 'self'` CSP), on either WebGPU or WASM. Protocol (postMessage):
 *
 *   → { id, type: 'load', device: 'webgpu' | 'wasm', dtype }
 *   ← { id, type: 'progress', loaded, total } …  then { id, type: 'done' }
 *   → { id, type: 'generate', text, voice, speed }
 *   ← { id, type: 'done', audio: Float32Array, rate, gpuError }
 *   ← { id, type: 'error', message }
 *
 * `gpuError` reports WebGPU device errors (e.g. out of memory) seen since load,
 * so the main thread can fall back to the CPU.
 */

import ortWasmUrl from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const ctx = self as unknown as DedicatedWorkerGlobalScope;

let tts: any = null;
let gpuError = false;

async function configureOrt(): Promise<void> {
  const tf: any = await import('@huggingface/transformers');
  const wasm = tf?.env?.backends?.onnx?.wasm;
  if (wasm) {
    wasm.numThreads = 1; // no SharedArrayBuffer (page isn't cross-origin isolated)
    wasm.proxy = false; // we already are the worker
    // transformers.js points ORT at a CDN; serve the bundled WASM instead (MV3 CSP).
    wasm.wasmPaths = { wasm: new URL(ortWasmUrl, ctx.location.href).href };
  }
}

async function watchGpu(): Promise<void> {
  try {
    const tf: any = await import('@huggingface/transformers');
    const device: any = tf?.env?.backends?.onnx?.webgpu?.device;
    if (!device) return;
    device.addEventListener('uncapturederror', () => { gpuError = true; });
    void device.lost?.then(() => { gpuError = true; });
  } catch { /* best-effort */ }
}

ctx.onmessage = async (e: MessageEvent) => {
  const { id, type } = e.data ?? {};
  try {
    if (type === 'load') {
      await configureOrt();
      const { KokoroTTS } = await import('kokoro-js');
      tts = await KokoroTTS.from_pretrained(MODEL, {
        dtype: e.data.dtype,
        device: e.data.device,
        progress_callback: (p: any) => {
          if (p?.status === 'progress' && p.total) ctx.postMessage({ id, type: 'progress', loaded: p.loaded, total: p.total });
        },
      });
      gpuError = false;
      if (e.data.device === 'webgpu') await watchGpu();
      ctx.postMessage({ id, type: 'done' });
    } else if (type === 'generate') {
      if (!tts) throw new Error('model not loaded');
      const raw = await tts.generate(e.data.text, { voice: e.data.voice, speed: e.data.speed });
      const audio: Float32Array = raw.audio ?? raw.data;
      ctx.postMessage({ id, type: 'done', audio, rate: raw.sampling_rate ?? 24000, gpuError }, [audio.buffer]);
    }
  } catch (err: any) {
    ctx.postMessage({ id, type: 'error', message: String(err?.message ?? err) });
  }
};
