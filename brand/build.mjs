/**
 * brand/build.mjs — Renders the sobelpdf logo SVGs into the PNGs the extension and the
 * Chrome Web Store need. Re-run after editing logo.svg / logo-small.svg:
 *
 *   node brand/build.mjs
 *
 * Uses sharp (already in node_modules via @huggingface/transformers).
 *   icons/icon16.png, icon32.png   ← logo-small.svg (simplified for tiny sizes)
 *   icons/icon48.png, icon128.png  ← logo.svg
 *   brand/wordmark.svg/.png, brand/wordmark-dark.png
 *   store/promo-440x280.png, store/marquee-1400x560.png
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (f) => readFileSync(join(here, f), 'utf8');
const inner = (svg) => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const FONT = "Inter, 'Segoe UI', system-ui, 'DejaVu Sans', sans-serif";

const mark = read('logo.svg');
const small = read('logo-small.svg');

async function png(svg, w, h, out) {
  await sharp(Buffer.from(svg), { density: 384 }).resize(w, h).png({ compressionLevel: 9 }).toFile(join(root, out));
  console.log('wrote', out);
}

// Mark placed inside a larger canvas (ids are prefixed so several copies can coexist).
const placed = (x, y, size, id = 'm') =>
  `<g transform="translate(${x} ${y}) scale(${size / 128})">${inner(mark).replaceAll('id="', `id="${id}-`).replaceAll('url(#', `url(#${id}-`)}</g>`;

function wordmark({ ink, muted }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 128" width="520" height="128">
  ${placed(0, 0, 128)}
  <text x="150" y="86" font-family="${FONT}" font-size="66" letter-spacing="-1.5">
    <tspan font-weight="700" fill="${ink}">sobel</tspan><tspan font-weight="400" fill="${muted}">pdf</tspan>
  </text>
</svg>`;
}

function promo(w, h) {
  const s = h / 280; // layout designed at 440×280
  const x0 = w * 0.065, mk = 110 * s, tx = x0 + mk + 22 * s;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#23262e"/><stop offset="1" stop-color="#0f1115"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.22" cy="0.5" r="0.45">
      <stop offset="0" stop-color="#ffcc2e" stop-opacity="0.14"/><stop offset="1" stop-color="#ffcc2e" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>
  ${placed(x0, (h - mk) / 2, mk)}
  <g font-family="${FONT}">
    <text x="${tx}" y="${h / 2 - 6 * s}" font-size="${44 * s}" letter-spacing="${-1 * s}">
      <tspan font-weight="700" fill="#ffffff">sobel</tspan><tspan font-weight="400" fill="#a9adb7">pdf</tspan>
    </text>
    <text x="${tx + 2 * s}" y="${h / 2 + 22 * s}" font-size="${13.5 * s}" fill="#c3c6cd">Read, annotate &amp; listen to PDFs.</text>
    <text x="${tx + 2 * s}" y="${h / 2 + 41 * s}" font-size="${13.5 * s}" fill="#c3c6cd">Private. Nothing leaves your device.</text>
    <rect x="${tx + 2 * s}" y="${h / 2 + 56 * s}" width="${48 * s}" height="${4.5 * s}" rx="${2.25 * s}" fill="#ffcc2e"/>
  </g>
</svg>`;
}

await png(small, 16, 16, 'icons/icon16.png');
await png(small, 32, 32, 'icons/icon32.png');
await png(mark, 48, 48, 'icons/icon48.png');
await png(mark, 128, 128, 'icons/icon128.png');

const wmLight = wordmark({ ink: '#16181d', muted: '#6b707b' });
writeFileSync(join(here, 'wordmark.svg'), wmLight);
await png(wmLight, 1040, 256, 'brand/wordmark.png');
await png(wordmark({ ink: '#ffffff', muted: '#a9adb7' }), 1040, 256, 'brand/wordmark-dark.png');

await png(promo(440, 280), 440, 280, 'store/promo-440x280.png');
await png(promo(1400, 560), 1400, 560, 'store/marquee-1400x560.png');
