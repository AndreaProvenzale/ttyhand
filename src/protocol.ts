import os from 'node:os';
import path from 'node:path';

export const PROTOCOL_VERSION = 1;

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
export interface SendParams { id: string; text: string; wait?: boolean; timeout_ms?: number }
export interface ReadParams { id: string; mode?: ReadMode; since?: number }
export interface KillParams { id: string; signal?: string }
export interface HelloParams { version: number; owner: boolean }

export interface ListEntry { id: string; cmd: string; state: State; exitCode?: number }

export interface Request { id: number; method: string; params?: unknown }
export interface Response { id: number; result?: unknown; error?: { message: string } }

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
  const extra = r.truncated ? ' truncated' : '';
  return `[${r.id} ${status} seq=${r.seq} cursor=${r.cursor.row},${r.cursor.col}${extra}]\n${r.text}`;
}
