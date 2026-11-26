/**
 * commands.ts — Runtime command registry + dispatcher.
 *
 * COMMANDS (schema.ts) is the static catalog (id, title, keys). This registry
 * binds a live handler to each id. The ShortcutManager and Command Palette both
 * call `dispatch(id)`; neither knows the implementation. Handlers are registered
 * by the viewer during boot.
 */

import { COMMANDS, Command } from './schema';

export type CommandHandler = (ev?: Event) => void | Promise<void>;

export interface RegisteredCommand extends Command {
  handler?: CommandHandler;
  /** Optional live enabled-state check for palette greying / guard. */
  enabled?: () => boolean;
}

export class CommandRegistry {
  private map = new Map<string, RegisteredCommand>();
  private recent: string[] = [];
  private contextFlags = new Map<string, boolean>();

  constructor() {
    for (const cmd of COMMANDS) this.map.set(cmd.id, { ...cmd });
  }

  /** Attach (or replace) a handler for a command id. */
  register(id: string, handler: CommandHandler, enabled?: () => boolean): void {
    const cmd = this.map.get(id);
    if (!cmd) {
      console.warn(`[commands] registering unknown id "${id}" — add it to COMMANDS in schema.ts`);
      return;
    }
    cmd.handler = handler;
    cmd.enabled = enabled;
  }

  /** Bulk register from a map of id -> handler. */
  registerAll(handlers: Record<string, CommandHandler>): void {
    for (const [id, h] of Object.entries(handlers)) this.register(id, h);
  }

  get(id: string): RegisteredCommand | undefined {
    return this.map.get(id);
  }

  list(): RegisteredCommand[] {
    return [...this.map.values()];
  }

  /** Commands that currently have a handler and pass their enabled() check. */
  available(): RegisteredCommand[] {
    return this.list().filter((c) => c.handler && (!c.enabled || c.enabled()));
  }

  /** Set a boolean context flag used by `when` guards (e.g. "annotation.active"). */
  setContext(flag: string, value: boolean): void {
    this.contextFlags.set(flag, value);
  }

  /** Evaluate a simple `when` expression: a flag name, optionally negated ("!x"). */
  evalWhen(expr: string): boolean {
    const neg = expr.startsWith('!');
    const key = neg ? expr.slice(1) : expr;
    const val = this.contextFlags.get(key) ?? false;
    return neg ? !val : val;
  }

  /** Invoke a command by id. Returns false if missing/disabled/guarded out. */
  async dispatch(id: string, ev?: Event): Promise<boolean> {
    const cmd = this.map.get(id);
    if (!cmd?.handler) return false;
    if (cmd.when && !this.evalWhen(cmd.when)) return false;
    if (cmd.enabled && !cmd.enabled()) return false;
    this.pushRecent(id);
    await cmd.handler(ev);
    return true;
  }

  recentCommands(limit = 8): RegisteredCommand[] {
    return this.recent
      .slice(0, limit)
      .map((id) => this.map.get(id))
      .filter((c): c is RegisteredCommand => !!c);
  }

  private pushRecent(id: string): void {
    this.recent = [id, ...this.recent.filter((x) => x !== id)].slice(0, 20);
  }
}

export const commands = new CommandRegistry();
