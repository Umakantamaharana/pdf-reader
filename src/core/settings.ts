/**
 * settings.ts — Centralized, reactive settings engine.
 *
 * Responsibilities:
 *  - Load/persist AppSettings to chrome.storage (local by default; sync optional).
 *  - Deep-merge stored data over DEFAULT_SETTINGS so new fields back-fill on upgrade.
 *  - Run schema migrations when SCHEMA_VERSION bumps.
 *  - Notify subscribers (toolbar, viewer, options page) on any change,
 *    including cross-context changes via chrome.storage.onChanged.
 *  - Provide typed dot-path get/set, reset, and JSON import/export.
 *
 * Usage:
 *   await settings.init();
 *   const dark = settings.get('darkMode.enabled');
 *   await settings.set('darkMode.enabled', true);
 *   const off = settings.subscribe('darkMode', (val) => applyDarkMode(val));
 */

import { AppSettings, DEFAULT_PRESETS, DEFAULT_SETTINGS, SCHEMA_VERSION, SOFT_NIGHT } from './schema';

type Listener = (value: unknown, path: string, all: AppSettings) => void;
type Migration = (prev: any) => any;

const STORAGE_KEY = 'pdfreader.settings.v1';

/** Deep clone via structuredClone with a JSON fallback for old runtimes. */
function clone<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively merge `source` over `base`; arrays are replaced, not merged. */
function deepMerge<T>(base: T, source: Partial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(source)) return (source ?? base) as T;
  const out: any = clone(base);
  for (const key of Object.keys(source)) {
    const s = (source as any)[key];
    const b = (out as any)[key];
    out[key] = isPlainObject(s) && isPlainObject(b) ? deepMerge(b, s) : clone(s);
  }
  return out;
}

function getPath(obj: any, path: string): unknown {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function setPath(obj: any, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((acc, k) => (acc[k] ??= {}), obj);
  target[last] = value;
}

/**
 * Registered migrations keyed by the version they upgrade *from*.
 * Example for a future v2:
 *   migrations[1] = (s) => { s.tts.voice ??= 'af_bella'; return s; };
 */
const migrations: Record<number, Migration> = {
  // v1 → v2: the four colour presets were replaced by the single "Soft Night"
  // theme (brightness 1, contrast 0.6). Arrays aren't deep-merged, so the old
  // stored preset list must be swapped explicitly.
  1: (s) => {
    s.darkMode = {
      ...(s.darkMode ?? {}),
      presets: DEFAULT_PRESETS,
      activePresetId: SOFT_NIGHT.id,
      brightness: SOFT_NIGHT.brightness,
      contrast: SOFT_NIGHT.contrast,
    };
    return s;
  },
};

export class SettingsManager {
  private state: AppSettings = clone(DEFAULT_SETTINGS);
  private listeners = new Map<string, Set<Listener>>();
  private ready = false;
  private storageArea: chrome.storage.StorageArea = chrome.storage.local;

  /** Load from storage, migrate, merge defaults, and wire cross-context sync. */
  async init(): Promise<AppSettings> {
    const raw = await this.readRaw(chrome.storage.local, STORAGE_KEY);
    let loaded: any = raw;

    // If the user switched to sync storage, honor it after the first read.
    if (loaded?.meta?.storageMode === 'sync' && chrome.storage.sync) {
      this.storageArea = chrome.storage.sync;
      loaded = (await this.readRaw(chrome.storage.sync, STORAGE_KEY)) ?? loaded;
    }

    this.state = this.normalize(loaded);
    await this.persist(); // write back the merged/migrated shape
    this.ready = true;

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== this.areaName()) return;
      const change = changes[STORAGE_KEY];
      if (!change?.newValue) return;
      const next = this.normalize(change.newValue);
      this.diffAndState(next);
    });

    return this.state;
  }

  /** Merge defaults + run migrations on a possibly-stale stored object. */
  private normalize(loaded: any): AppSettings {
    if (!loaded) return clone(DEFAULT_SETTINGS);
    let working = clone(loaded);
    let version = working?.meta?.schemaVersion ?? 0;
    while (version < SCHEMA_VERSION && migrations[version]) {
      working = migrations[version](working);
      version += 1;
    }
    const merged = deepMerge(DEFAULT_SETTINGS, working);
    merged.meta.schemaVersion = SCHEMA_VERSION;
    return merged;
  }

  private areaName(): 'local' | 'sync' {
    return this.state.meta.storageMode;
  }

  private readRaw(area: chrome.storage.StorageArea, key: string): Promise<any> {
    return new Promise((resolve) => area.get(key, (r) => resolve(r?.[key])));
  }

  private persist(): Promise<void> {
    return new Promise((resolve) => this.storageArea.set({ [STORAGE_KEY]: this.state }, () => resolve()));
  }

  // ---- Public API -------------------------------------------------------

  get all(): AppSettings {
    return this.state;
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Read a value by dot-path. Returns the full object when path is empty. */
  get<T = unknown>(path: string): T {
    return (path ? getPath(this.state, path) : this.state) as T;
  }

  /** Write a value by dot-path, persist, and notify matching subscribers. */
  async set(path: string, value: unknown): Promise<void> {
    setPath(this.state, path, value);
    await this.persist();
    this.notify(path, value);
  }

  /** Apply several dot-path writes atomically (one persist, batched notifies). */
  async patch(entries: Record<string, unknown>): Promise<void> {
    for (const [p, v] of Object.entries(entries)) setPath(this.state, p, v);
    await this.persist();
    for (const [p, v] of Object.entries(entries)) this.notify(p, v);
  }

  /** Reset everything, or a single subtree by path, to defaults. */
  async reset(path?: string): Promise<void> {
    if (!path) {
      this.state = clone(DEFAULT_SETTINGS);
    } else {
      setPath(this.state, path, clone(getPath(DEFAULT_SETTINGS, path)));
    }
    await this.persist();
    this.notify(path ?? '', this.get(path ?? ''));
  }

  /** Move persistence between local and sync storage, copying current state. */
  async setStorageMode(mode: 'local' | 'sync'): Promise<void> {
    this.state.meta.storageMode = mode;
    this.storageArea = mode === 'sync' && chrome.storage.sync ? chrome.storage.sync : chrome.storage.local;
    await this.persist();
  }

  exportJSON(): string {
    return JSON.stringify(this.state, null, 2);
  }

  async importJSON(json: string): Promise<void> {
    const parsed = JSON.parse(json);
    this.state = this.normalize(parsed);
    await this.persist();
    this.notify('', this.state);
  }

  /**
   * Subscribe to a path. Fires when that path, an ancestor, or a descendant
   * changes (so subscribing to 'darkMode' catches 'darkMode.brightness').
   * Returns an unsubscribe function.
   */
  subscribe(path: string, fn: Listener): () => void {
    const set = this.listeners.get(path) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(path, set);
    return () => this.listeners.get(path)?.delete(fn);
  }

  // ---- Internal notification plumbing -----------------------------------

  private notify(changedPath: string, _value: unknown): void {
    for (const [subPath, fns] of this.listeners) {
      if (this.pathMatches(subPath, changedPath)) {
        const emitted = subPath ? getPath(this.state, subPath) : this.state;
        fns.forEach((fn) => fn(emitted, changedPath, this.state));
      }
    }
  }

  /** Match when one path is an ancestor/descendant of (or equal to) the other. */
  private pathMatches(sub: string, changed: string): boolean {
    if (!sub || !changed) return true;
    return sub === changed || sub.startsWith(changed + '.') || changed.startsWith(sub + '.');
  }

  /** Replace state from an external (cross-context) change and fan out notifies. */
  private diffAndState(next: AppSettings): void {
    const prev = this.state;
    this.state = next;
    // Coarse fan-out: notify each top-level section whose JSON differs.
    for (const key of Object.keys(next) as (keyof AppSettings)[]) {
      if (JSON.stringify((prev as any)[key]) !== JSON.stringify((next as any)[key])) {
        this.notify(key, (next as any)[key]);
      }
    }
  }
}

/** Shared singleton — import this everywhere. */
export const settings = new SettingsManager();
