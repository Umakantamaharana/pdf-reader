/**
 * kokoroClient.ts — Main-thread handle to the Kokoro worker (kokoroWorker.ts).
 *
 * One client = one worker = one loaded model on one device. Terminating the
 * client frees its memory (incl. GPU buffers), which is how the controller
 * switches between GPU and CPU cleanly.
 */

export type KokoroDevice = 'webgpu' | 'wasm';

export interface KokoroAudio {
  audio: Float32Array;
  rate: number;
  gpuError: boolean;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (loaded: number, total: number) => void;
}

export class KokoroClient {
  readonly device: KokoroDevice;
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor(device: KokoroDevice) {
    this.device = device;
    this.worker = new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent) => {
      const { id, type } = e.data ?? {};
      const p = this.pending.get(id);
      if (!p) return;
      if (type === 'progress') return p.onProgress?.(e.data.loaded, e.data.total);
      this.pending.delete(id);
      if (type === 'error') p.reject(new Error(e.data.message));
      else p.resolve(e.data);
    };
    // A worker that fails to start (bad bundle, CSP…) rejects everything pending.
    this.worker.onerror = (e) => {
      const err = new Error(`Kokoro worker failed: ${e.message || 'unknown error'}`);
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
    };
  }

  private call(msg: Record<string, unknown>, onProgress?: Pending['onProgress']): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, ...msg });
    });
  }

  load(dtype: 'fp32' | 'q8', onProgress?: (loaded: number, total: number) => void): Promise<void> {
    return this.call({ type: 'load', device: this.device, dtype }, onProgress).then(() => undefined);
  }

  generate(text: string, opts: { voice: string; speed: number }): Promise<KokoroAudio> {
    return this.call({ type: 'generate', text, ...opts }).then((d) => ({ audio: d.audio, rate: d.rate, gpuError: !!d.gpuError }));
  }

  dispose(): void {
    this.worker.terminate();
    const err = new Error('disposed');
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
  }
}
