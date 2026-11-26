/**
 * offscreen.ts — Placeholder for the on-device TTS host (TTS step).
 *
 * This document exists so the Offscreen lifecycle and messaging contract are in
 * place now. In the TTS step it will lazy-load kokoro-js (WebGPU, with WASM
 * fallback), synthesize audio for queued sentences, stream playback, and post
 * word/sentence boundary events back to the viewer for live highlighting.
 */

type TtsMessage =
  | { type: 'tts:init'; engine: 'kokoro' | 'piper' | 'native'; voice: string }
  | { type: 'tts:speak'; text: string; speed: number }
  | { type: 'tts:stop' };

chrome.runtime.onMessage.addListener((msg: TtsMessage, _sender, sendResponse) => {
  switch (msg.type) {
    case 'tts:init':
      // TODO(tts-step): await KokoroTTS.from_pretrained(...) with device detection.
      sendResponse({ ok: true, ready: false, note: 'offscreen stub' });
      break;
    case 'tts:speak':
    case 'tts:stop':
      sendResponse({ ok: true });
      break;
  }
  return true;
});
