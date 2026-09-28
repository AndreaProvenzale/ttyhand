import pty, { type IPty } from '@lydell/node-pty';
import xterm from '@xterm/headless';
import type { ReadMode, Result, State } from './protocol.js';

const IDLE_MS = 400;
const POLL_MS = 50;
const LOG_CAP = 1_000_000;
const KILL_GRACE_MS = 2000;
const SCROLLBACK = 5000;

export interface SessionOptions {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One spawned program: its PTY, a headless emulator fed every byte, and a raw output log. */
export class Session {
  readonly term: xterm.Terminal;
  readonly pty: IPty;
  seq = 0;
  lastOutputAt = Date.now();
  lastUsedAt = Date.now();
  exitCode?: number;
  private log = '';
  private logStart = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly id: string, readonly opts: SessionOptions, readonly owner?: object) {
    this.term = new xterm.Terminal({ cols: opts.cols, rows: opts.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.pty = pty.spawn(opts.cmd, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    this.pty.onData((data) => this.onOutput(data));
    this.pty.onExit(({ exitCode, signal }) => {
      this.exitCode = signal ? 128 + signal : exitCode;
    });
  }

  get exited() {
    return this.exitCode !== undefined;
  }

  /** Serialises calls per program so input never interleaves. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.lastUsedAt = Date.now();
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }

  async send(text: string, wait: boolean, timeoutMs: number): Promise<Result> {
    if (this.exited) throw new Error(`${this.id} has exited (code ${this.exitCode}); nothing was sent`);
    const sentAt = Date.now();
    this.pty.write(text);
    const state = wait ? await this.waitIdle(timeoutMs, sentAt) : 'running';
    return this.snapshot('screen', undefined, state);
  }

  async waitIdle(timeoutMs: number, since = Date.now()): Promise<State> {
    const start = Date.now();
    for (;;) {
      const now = Date.now();
      // Output can trail the exit event; give it a moment to land.
      if (this.exited && now - this.lastOutputAt >= POLL_MS) return 'exited';
      if (now - Math.max(this.lastOutputAt, since) >= IDLE_MS) return 'waiting_input';
      if (now - start >= timeoutMs) return 'running';
      await sleep(POLL_MS);
    }
  }

  async kill(signal: string): Promise<Result> {
    if (!this.exited) {
      this.pty.kill(signal);
      await this.waitExit(KILL_GRACE_MS);
      if (!this.exited) {
        this.pty.kill('SIGKILL');
        await this.waitExit(KILL_GRACE_MS);
      }
    }
    return this.snapshot('screen');
  }

  async snapshot(mode: ReadMode, since?: number, state = this.currentState()): Promise<Result> {
    await new Promise<void>((resolve) => this.term.write('', resolve));
    const buf = this.term.buffer.active;
    let text: string;
    let truncated = false;
    if (mode === 'new_output') {
      const from = since ?? this.logStart;
      truncated = from < this.logStart;
      text = plainText(this.log.slice(Math.max(from - this.logStart, 0)));
    } else {
      const first = mode === 'screen' ? buf.viewportY : 0;
      const last = mode === 'screen' ? buf.viewportY + this.term.rows : buf.length;
      const lines: string[] = [];
      for (let y = first; y < last; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
      text = dropTrailingBlanks(lines).join('\n');
    }
    return {
      id: this.id,
      text,
      seq: this.seq,
      cursor: { row: buf.cursorY, col: buf.cursorX },
      state: this.exited ? 'exited' : state,
      exitCode: this.exitCode,
      ...(truncated && { truncated }),
    };
  }

  private currentState(): State {
    if (this.exited) return 'exited';
    return Date.now() - this.lastOutputAt >= IDLE_MS ? 'waiting_input' : 'running';
  }

  private onOutput(data: string) {
    this.lastOutputAt = Date.now();
    this.term.write(data);
    this.seq += data.length;
    this.log += data;
    if (this.log.length > LOG_CAP) {
      const drop = this.log.length - LOG_CAP;
      this.log = this.log.slice(drop);
      this.logStart += drop;
    }
  }

  private async waitExit(timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!this.exited && Date.now() < deadline) await sleep(POLL_MS);
  }
}

function dropTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === '') end--;
  return lines.slice(0, end);
}

// CSI, OSC, DCS/SOS/PM/APC strings, then any other two-byte escape.
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[ -/]*[0-~]/g;

/** Raw PTY bytes to readable text: strips escapes, applies \r overwrites and backspaces. */
export function plainText(raw: string): string {
  const lines = raw.replace(ESCAPES, '').replace(/\r+\n/g, '\n').split('\n');
  return lines
    .map((line) => {
      let out = '';
      for (const part of line.split('\r')) out = part + out.slice(part.length);
      let prev;
      do {
        prev = out;
        out = out.replace(/[^\x08]\x08/g, '');
      } while (out !== prev);
      return out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
    })
    .join('\n');
}
