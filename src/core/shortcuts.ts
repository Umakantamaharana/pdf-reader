/**
 * shortcuts.ts — Global keyboard engine (chords + Vim-style sequences).
 *
 * Features:
 *  - Normalizes KeyboardEvent into a canonical chord string ("ctrl+shift+k").
 *  - Multi-key Vim sequences ("g g", "z z") resolved via a timed buffer.
 *  - Leader-key sequences ("<leader> t ...") when shortcuts.leaderKey is set.
 *  - Bindings come from COMMANDS defaultKeys, overridden per-command by
 *    settings.shortcuts.keymap. Rebinding is live — call rebuild() after a change.
 *  - A binding may list alternatives separated by "|" ("ctrl+= | ctrl+plus").
 *  - On macOS every ctrl chord is also bound with ⌘ (meta), as Mac apps expect.
 *  - Shifted symbols are matched by the character they produce: "?" not
 *    "shift+/", and "+" is spelled "plus" (it would clash with the separator).
 *  - Conflict detection: detectConflicts() reports chords bound to >1 command.
 *  - Context guards: skips input/textarea/contenteditable unless configured, and
 *    honors each command's optional `when` guard via a pluggable context resolver.
 *
 * It does not know *what* commands do — it only maps keys to command ids and
 * invokes a dispatch callback. Wire that to your CommandRegistry.
 */

import { COMMANDS, Command } from './schema';
import { settings } from './settings';

export type Dispatch = (commandId: string, ev: KeyboardEvent) => void;
export type ContextResolver = (whenExpr: string) => boolean;

export interface Conflict {
  binding: string;
  commandIds: string[];
}

/** Keys we never want to treat as part of a chord's "main" key. */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

/** Normalize a KeyboardEvent to a canonical chord, e.g. "ctrl+shift+k". */
export function eventToChord(ev: KeyboardEvent): string {
  const parts: string[] = [];
  if (ev.ctrlKey) parts.push('ctrl');
  if (ev.altKey) parts.push('alt');
  if (ev.shiftKey) parts.push('shift');
  if (ev.metaKey) parts.push('meta');

  let key = ev.key;
  if (MODIFIER_KEYS.has(key)) return parts.join('+'); // modifier-only, incomplete chord

  // Canonicalize named keys and single chars.
  const named: Record<string, string> = {
    ' ': 'space',
    ArrowRight: 'right',
    ArrowLeft: 'left',
    ArrowUp: 'up',
    ArrowDown: 'down',
    Escape: 'esc',
    Enter: 'enter',
    Tab: 'tab',
    Backspace: 'backspace',
    Delete: 'del',
  };
  if (key === '+') key = 'plus';
  // Shift is already "spent" on symbols: Shift+/ arrives as "?". Dropping it
  // makes a "?" binding match (it never did before), letters keep shift.
  const isSymbol = key.length === 1 && key !== ' ' && key.toLowerCase() === key.toUpperCase() && !/[0-9]/.test(key);
  if (isSymbol || key === 'plus') {
    const i = parts.indexOf('shift');
    if (i >= 0) parts.splice(i, 1);
  }
  key = named[key] ?? key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Split a stored binding into its alternatives ("a | b" → ["a", "b"]). */
export function splitAlternatives(binding: string): string[] {
  return binding.split('|').map((b) => b.trim()).filter(Boolean);
}

/** True if the event target is an editable field we should normally ignore. */
function isEditableTarget(ev: KeyboardEvent): boolean {
  const el = ev.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export class ShortcutManager {
  private dispatch: Dispatch;
  private resolveContext: ContextResolver;

  /** binding string -> command id. Rebuilt from settings + COMMANDS. */
  private bindings = new Map<string, string>();
  /** command id -> Command (for `when` guards). */
  private commandsById = new Map<string, Command>();

  private sequenceBuffer: string[] = [];
  private sequenceTimer: number | null = null;
  private attached = false;
  private boundHandler = (ev: KeyboardEvent) => this.onKeyDown(ev);

  constructor(dispatch: Dispatch, resolveContext: ContextResolver = () => true) {
    this.dispatch = dispatch;
    this.resolveContext = resolveContext;
    COMMANDS.forEach((c) => this.commandsById.set(c.id, c));
    this.rebuild();
  }

  /** Recompute the binding table from COMMANDS + settings keymap overrides. */
  rebuild(): void {
    this.bindings.clear();
    const overrides = settings.get<Record<string, string>>('shortcuts.keymap') ?? {};
    for (const cmd of COMMANDS) {
      const binding = overrides[cmd.id] ?? cmd.defaultKeys;
      if (!binding) continue;
      for (const alt of this.expand(binding)) if (!this.bindings.has(alt)) this.bindings.set(alt, cmd.id);
    }
  }

  /** Canonical forms of every alternative in a binding (+ ⌘ twins on macOS). */
  private expand(binding: string): string[] {
    const out: string[] = [];
    for (const alt of splitAlternatives(binding)) {
      const c = this.canonicalizeBinding(alt);
      out.push(c);
      if (IS_MAC && /(^|[ +])ctrl\+/.test(c)) out.push(this.canonicalizeBinding(c.replace(/(^|[ +])ctrl\+/g, '$1meta+')));
    }
    return out;
  }

  /** Normalize a stored binding ("G G", "Ctrl+K") to canonical form. */
  private canonicalizeBinding(binding: string): string {
    return binding
      .trim()
      .split(/\s+/)
      .map((chord) =>
        chord
          .toLowerCase()
          .split('+')
          .map((p) => p.trim())
          .filter(Boolean)
          // keep modifier order stable: ctrl, alt, shift, meta, then key
          .sort((a, b) => this.modRank(a) - this.modRank(b))
          .join('+'),
      )
      .join(' ');
  }

  private modRank(token: string): number {
    const order = ['ctrl', 'alt', 'shift', 'meta'];
    const idx = order.indexOf(token);
    return idx === -1 ? 99 : idx;
  }

  attach(target: Window | HTMLElement = window): void {
    if (this.attached) return;
    target.addEventListener('keydown', this.boundHandler as EventListener, true);
    this.attached = true;
    this._target = target;
  }
  private _target: Window | HTMLElement = window;

  detach(): void {
    if (!this.attached) return;
    this._target.removeEventListener('keydown', this.boundHandler as EventListener, true);
    this.attached = false;
    this.clearSequence();
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (!settings.get<boolean>('shortcuts.enabled')) return;
    // The keymap editor is recording a new binding: let it have every key.
    if (document.body.classList.contains('capturing-keys')) return;

    const chord = eventToChord(ev);
    if (!chord || MODIFIER_KEYS.has(ev.key)) return; // wait for a complete chord

    const ignoreInInputs = settings.get<boolean>('shortcuts.ignoreWhenTypingInInputs');
    if (ignoreInInputs && isEditableTarget(ev)) {
      // Still allow Escape to blur and explicit ctrl/meta chords through.
      if (chord !== 'esc' && !ev.ctrlKey && !ev.metaKey) return;
    }

    const vimEnabled = settings.get<boolean>('shortcuts.vimEnabled');
    const leaderKey = settings.get<string>('shortcuts.leaderKey');

    // Leader handling: a bare leader key opens a sequence.
    if (vimEnabled && leaderKey && chord === leaderKey.toLowerCase() && this.sequenceBuffer.length === 0) {
      this.pushSequence('<leader>');
      ev.preventDefault();
      return;
    }

    // Try to extend an in-flight sequence first.
    if (this.sequenceBuffer.length > 0) {
      const candidate = [...this.sequenceBuffer, chord].join(' ');
      if (this.tryResolve(candidate, ev)) return;
      // Is the candidate still a viable prefix of some binding?
      if (this.isPrefix(candidate)) {
        this.pushSequence(chord);
        ev.preventDefault();
        return;
      }
      this.clearSequence();
      // fall through to treat this chord as a fresh start
    }

    // Single-chord resolve.
    if (this.tryResolve(chord, ev)) return;

    // Begin a new multi-key sequence if this chord is a prefix of one.
    if (vimEnabled && this.isPrefix(chord)) {
      this.pushSequence(chord);
      ev.preventDefault();
    }
  }

  /** If `binding` maps to a command and its guard passes, dispatch it. */
  private tryResolve(binding: string, ev: KeyboardEvent): boolean {
    const id = this.bindings.get(binding);
    if (!id) return false;
    const cmd = this.commandsById.get(id);
    if (cmd?.when && !this.resolveContext(cmd.when)) return false;
    ev.preventDefault();
    this.clearSequence();
    this.dispatch(id, ev);
    return true;
  }

  /** True if `partial` is a strict prefix of at least one multi-chord binding. */
  private isPrefix(partial: string): boolean {
    for (const binding of this.bindings.keys()) {
      if (binding !== partial && binding.startsWith(partial + ' ')) return true;
    }
    return false;
  }

  private pushSequence(chord: string): void {
    this.sequenceBuffer.push(chord);
    if (this.sequenceTimer !== null) clearTimeout(this.sequenceTimer);
    const timeout = settings.get<number>('shortcuts.sequenceTimeoutMs') ?? 700;
    this.sequenceTimer = window.setTimeout(() => this.clearSequence(), timeout);
  }

  private clearSequence(): void {
    this.sequenceBuffer = [];
    if (this.sequenceTimer !== null) {
      clearTimeout(this.sequenceTimer);
      this.sequenceTimer = null;
    }
  }

  // ---- Introspection / editing helpers (used by the Settings keymap UI) --

  /** Primary (first) effective binding for a command id, if any. */
  bindingFor(commandId: string): string | undefined {
    return this.bindingsFor(commandId)[0];
  }

  /** Every effective binding for a command id, in declaration order. */
  bindingsFor(commandId: string): string[] {
    const out: string[] = [];
    for (const [binding, id] of this.bindings) if (id === commandId) out.push(binding);
    return out;
  }

  /** Report every binding assigned to more than one command. */
  detectConflicts(): Conflict[] {
    const byBinding = new Map<string, string[]>();
    const overrides = settings.get<Record<string, string>>('shortcuts.keymap') ?? {};
    for (const cmd of COMMANDS) {
      const raw = overrides[cmd.id] ?? cmd.defaultKeys;
      if (!raw) continue;
      for (const b of this.expand(raw)) (byBinding.get(b) ?? byBinding.set(b, []).get(b)!).push(cmd.id);
    }
    return [...byBinding.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([binding, commandIds]) => ({ binding, commandIds }));
  }

  /**
   * Validate+persist a rebind. Returns the conflicting command id if the new
   * binding is already taken (caller decides whether to override).
   */
  async rebind(commandId: string, newBinding: string, force = false): Promise<{ ok: boolean; conflictWith?: string }> {
    const canonical = splitAlternatives(newBinding).map((b) => this.canonicalizeBinding(b)).join(' | ');
    const existing = this.expand(canonical).map((b) => this.bindings.get(b)).find((id) => id && id !== commandId);
    if (existing && existing !== commandId && !force) {
      return { ok: false, conflictWith: existing };
    }
    const keymap = { ...(settings.get<Record<string, string>>('shortcuts.keymap') ?? {}) };
    keymap[commandId] = canonical;
    await settings.set('shortcuts.keymap', keymap);
    this.rebuild();
    return { ok: true };
  }

  /** Clear a command's override, reverting to its default binding. */
  async resetBinding(commandId: string): Promise<void> {
    const keymap = { ...(settings.get<Record<string, string>>('shortcuts.keymap') ?? {}) };
    delete keymap[commandId];
    await settings.set('shortcuts.keymap', keymap);
    this.rebuild();
  }
}
