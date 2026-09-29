import os from 'node:os';
import path from 'node:path';

export const PROTOCOL_VERSION = 4;
export const SANDBOX_HELP = 'a sandbox may be blocking it; see "Sandboxes" in the ttyhand README';

export type State = 'waiting_input' | 'running' | 'exited';
export type ReadMode = 'screen' | 'new_output' | 'scrollback';

export interface Result {
  id: string;
  text: string;
  seq: number;
  cursor: { row: number; col: number };
  state: State;
  exitCode?: number;
  truncated?: boolean;
  /** Set when the call waited for a pattern. */
  matched?: boolean;
}

export interface SpawnParams {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** The caller's environment; `env` is applied on top of it and the terminal defaults. */
  inherit_env?: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
  timeout_ms?: number;
}
export interface SendParams { id: string; text?: string; keys?: string[]; wait?: boolean; timeout_ms?: number }
export interface ReadParams { id: string; mode?: ReadMode; since?: number }
export interface WaitParams { id: string; until?: 'input' | 'exit'; pattern?: string; timeout_ms?: number }
export interface ResizeParams { id: string; cols: number; rows: number; timeout_ms?: number }
export interface KillParams { id: string; signal?: string }
export interface AttachParams { id: string }
/** Reply to attach; then the daemon streams `{id, event}` lines under the same request id. */
export interface AttachResult { cols: number; rows: number; picture: string; exitCode?: number }
/** `lost` is set by the client, not the daemon: the connection dropped. */
export interface AttachEvent { data?: string; exit?: number; lost?: true }
export interface HelloParams { version: number; owner: boolean }

export interface ListEntry { id: string; cmd: string; state: State; exitCode?: number }

export interface Request { id: number; method: string; params?: unknown }
export interface Response { id: number; result?: unknown; error?: { message: string }; event?: AttachEvent }

export function homeDir(): string {
  if (process.env.TTYHAND_HOME) return process.env.TTYHAND_HOME;
  const uid = process.getuid?.() ?? 'user';
  return path.join(process.env.XDG_RUNTIME_DIR ?? os.tmpdir(), `ttyhand-${uid}`);
}

export const socketPath = () => path.join(homeDir(), 'daemon.sock');
export const lockPath = () => path.join(homeDir(), 'daemon.lock');
export const logPath = () => path.join(homeDir(), 'daemon.log');

/** Same text for MCP and CLI: one status line, then the screen. */
export function formatResult(r: Result): string {
  const status = r.state === 'exited' ? `exited code=${r.exitCode ?? '?'}` : r.state;
  const extra = (r.truncated ? ' truncated' : '') + (r.matched === undefined ? '' : r.matched ? ' pattern=matched' : ' pattern=no_match');
  return `[id=${r.id} ${status} seq=${r.seq} cursor=row ${r.cursor.row + 1},col ${r.cursor.col + 1}${extra}]\n${r.text}`;
}
