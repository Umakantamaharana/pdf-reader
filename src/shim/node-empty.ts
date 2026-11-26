/**
 * node-empty.ts — Browser stub for Node built-ins (`fs/promises`, `path`) that
 * kokoro-js imports but only uses on a dead server-side code path. Aliased in
 * vite.config.ts so the browser bundle resolves cleanly.
 */
const stub: any = {
  resolve: (...a: string[]) => a.join('/'),
  dirname: (p: string) => p,
  join: (...a: string[]) => a.join('/'),
};
export default stub;
