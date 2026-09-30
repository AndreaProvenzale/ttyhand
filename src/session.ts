import fs from 'node:fs';
import pty, { type IPty } from '@lydell/node-pty';
import { SerializeAddon } from '@xterm/addon-serialize';
import xterm from '@xterm/headless';
import { encodeKey } from './keys.js';
import type { AttachEvent, ReadMode, Result, State } from './protocol.js';

const IDLE_MS = 400;
// Quiet with the cursor on an empty line is as often a pause mid-work (loading, sleeping) as a prompt.
const BARE_LINE_IDLE_MS = 2000;
const POLL_MS = 50;
const KEY_GAP_MS = 100;
// Vim and readline wait this long to tell a lone Esc from the start of a sequence.
const ESC_MS = 1000;
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
  lastInputAt = 0;
  lastUsedAt = Date.now();
  exitCode?: number;
  private escHeldUntil = 0;
  private log = '';
  private logStart = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private serializer = new SerializeAddon();
  private watchers = new Set<(event: AttachEvent) => void>();

  constructor(readonly id: string, readonly opts: SessionOptions, readonly owner?: object) {
    this.term = new xterm.Terminal({ cols: opts.cols, rows: opts.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    // The addon's typings name @xterm/xterm's Terminal; the headless one has the same API.
    this.term.loadAddon(this.serializer as unknown as xterm.ITerminalAddon);
    this.pty = pty.spawn(opts.cmd, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    this.pty.onData((data) => this.onOutput(data));
    // Replies to terminal queries (cursor position, device attributes); fzf stalls until it gets one.
    this.term.onData((data) => this.pty.write(data));
    this.pty.onExit(({ exitCode, signal }) => {
      this.exitCode = signal ? 128 + signal : exitCode;
      for (const watch of this.watchers) watch({ exit: this.exitCode });
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

  /** Types `text` literally, then presses `keys`. */
  async send(text: string | undefined, keys: string[], wait: boolean, timeoutMs: number): Promise<Result> {
    if (this.exited) throw new Error(`${this.id} has exited (code ${this.exitCode}); nothing was sent`);
    if (text === undefined && !keys.length) throw new Error('nothing to send: pass text, keys or both');
    for (const key of keys) encodeKey(key, false);
    const deadline = Date.now() + timeoutMs;
    if (text) await this.write(text);
    for (const [i, key] of keys.entries()) {
      // Line-at-a-time readers (npm init, inquirer) drop input that arrives before they ask again.
      if (text || i > 0) await this.settle(deadline);
      if (this.exited) break;
      await this.flush();
      await this.write(encodeKey(key, this.term.modes.applicationCursorKeysMode));
    }
    const state = wait ? await this.waitIdle(Math.max(deadline - Date.now(), 0), this.lastInputAt) : 'running';
    return this.snapshot('screen', undefined, state);
  }

  /** Polls until the program is waiting for input or has exited; `since` ignores quiet from before that time. */
  async waitIdle(timeoutMs: number, since = this.lastInputAt): Promise<State> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = this.currentState(since);
      if (state !== 'running' || Date.now() >= deadline) return state;
      await sleep(POLL_MS);
    }
  }

  /** Waits until the program asks for input (or exits), or with `pattern`, until the screen matches it. */
  async wait(until: 'input' | 'exit', pattern: RegExp | undefined, timeoutMs: number): Promise<Result> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = this.currentState(this.lastInputAt);
      const screen = await this.snapshot('screen', undefined, state);
      if (pattern) {
        if (pattern.test(screen.text)) return { ...screen, matched: true };
        if (state === 'exited' || Date.now() >= deadline) return { ...screen, matched: false };
      } else if (state === 'exited' || (until === 'input' && state === 'waiting_input') || Date.now() >= deadline) {
        return screen;
      }
      await sleep(POLL_MS);
    }
  }

  async resize(cols: number, rows: number, timeoutMs: number): Promise<Result> {
    if (this.exited) throw new Error(`${this.id} has exited (code ${this.exitCode})`);
    this.term.resize(cols, rows);
    this.pty.resize(cols, rows);
    this.lastInputAt = Date.now();
    return this.snapshot('screen', undefined, await this.waitIdle(timeoutMs));
  }

  /** The screen as escape sequences that redraw it, modes included, for a human's terminal. */
  async picture(): Promise<string> {
    await this.flush();
    return this.serializer.serialize({ scrollback: 0 });
  }

  /** Streams raw output, then the exit code, to `fn` until the returned function is called. */
  watch(fn: (event: AttachEvent) => void): () => void {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  private async write(data: string) {
    // Input that follows a lone Esc too soon reads as Alt+key or an escape sequence.
    const hold = this.escHeldUntil - Date.now();
    if (hold > 0) await sleep(hold);
    this.pty.write(data);
    const esc = data.endsWith('\x1b');
    // A lone Esc takes effect once the program stops waiting for the rest of a sequence.
    this.lastInputAt = Date.now() + (esc ? ESC_MS : 0);
    this.escHeldUntil = esc ? this.lastInputAt + KEY_GAP_MS : 0;
  }

  private async settle(deadline: number) {
    while (Date.now() - Math.max(this.lastOutputAt, this.lastInputAt) < KEY_GAP_MS && Date.now() < deadline) await sleep(10);
  }

  private flush() {
    return new Promise<void>((resolve) => this.term.write('', resolve));
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
    await this.flush();
    const buf = this.term.buffer.active;
    let text: string;
    let truncated = false;
    if (mode === 'new_output') {
      if (since !== undefined && since > this.seq) throw new Error(`since=${since} is past ${this.id}'s output (seq=${this.seq}); pass the seq of an earlier ${this.id} result`);
      const from = since ?? this.logStart;
      truncated = from < this.logStart;
      text = plainText(this.log.slice(Math.max(from - this.logStart, 0))) || '(no new output)';
    } else {
      const first = mode === 'screen' ? buf.viewportY : 0;
      const last = mode === 'screen' ? buf.viewportY + this.term.rows : buf.length;
      text = dropTrailingBlanks(renderLines(buf, first, last, mode === 'scrollback')).join('\n');
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

  private currentState(since = 0): State {
    const now = Date.now();
    // Output can trail the exit event; give it a moment to land.
    if (this.exited) return now - this.lastOutputAt >= POLL_MS ? 'exited' : 'running';
    const quiet = now - Math.max(this.lastOutputAt, since);
    if (quiet < IDLE_MS) return 'running';
    const tty = ttyActivity(this.pty.pid);
    if (tty) return tty === 'reading' ? 'waiting_input' : 'running';
    return quiet >= BARE_LINE_IDLE_MS || this.cursorAfterText() ? 'waiting_input' : 'running';
  }

  /** Prompts leave the cursor after some text; full-screen programs put it anywhere. */
  private cursorAfterText() {
    const buf = this.term.buffer.active;
    return buf.type === 'alternate' || buf.cursorX > 0 || !!buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true);
  }

  private onOutput(data: string) {
    this.lastOutputAt = Date.now();
    this.term.write(data);
    for (const watch of this.watchers) watch({ data });
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

const TTY_READ = new Set(['n_tty_read', 'wait_woken']);
const SLEEPING = new Set(['hrtimer_nanosleep', 'do_nanosleep']);

/**
 * Linux only: whether the terminal's foreground process group is blocked reading the terminal ("reading"),
 * running or sleeping ("busy"), or neither for sure (undefined: polling, e.g. readline, libuv or curses).
 */
export function ttyActivity(pid: number): 'reading' | 'busy' | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const tpgid = statFields(pid)?.[5];
    if (!tpgid) return undefined;
    let busy = false;
    for (const p of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(p)) continue;
      const stat = statFields(Number(p));
      if (stat?.[2] !== tpgid) continue;
      for (const tid of fs.readdirSync(`/proc/${p}/task`)) {
        const read = blockedRead(`/proc/${p}`, `/proc/${p}/task/${tid}`);
        if (read === 'terminal') return 'reading';
        // Background threads often block on sockets; only the main thread's says the program is busy.
        busy ||= read === 'other' && tid === p;
      }
      busy ||= stat[0] === 'R' || stat[0] === 'D' || SLEEPING.has(readProc(`/proc/${p}/wchan`));
    }
    return busy ? 'busy' : undefined;
  } catch {
    return undefined;
  }
}

/** What a thread blocked in wait_woken reads (sockets block there too), judged by the syscall's first argument. */
function blockedRead(proc: string, task: string): 'terminal' | 'other' | undefined {
  if (!TTY_READ.has(readProc(`${task}/wchan`))) return undefined;
  const fd = Number(readProc(`${task}/syscall`).split(' ')[1]);
  try {
    return /^\/dev\/(pts\/|tty)/.test(fs.readlinkSync(`${proc}/fd/${fd}`)) ? 'terminal' : 'other';
  } catch {
    return undefined;
  }
}

/** Fields of /proc/<pid>/stat after the command name: state, ppid, pgrp, session, tty_nr, tpgid, ... */
function statFields(pid: number): string[] | undefined {
  const stat = readProc(`/proc/${pid}/stat`);
  return stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ') : undefined;
}

function readProc(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Reverse video or a background, as a key; '' for plain cells. */
function highlightStyle(cell: xterm.IBufferCell): string {
  if (cell.isInverse()) return 'inverse';
  return cell.isBgDefault() ? '' : `${cell.getBgColorMode()}:${cell.getBgColor()}`;
}

/**
 * Buffer lines as right-trimmed text, with highlighted runs wrapped in «»: reverse video or a background, unless it
 * is the style most of the text is in (a dialog's box). That is how menus, pickers and lists show the selection.
 */
function renderLines(buf: xterm.IBuffer, first: number, last: number, joinWrapped: boolean): string[] {
  const cell = buf.getNullCell();
  const rows: { chars: string[]; styles: string[] }[] = [];
  const textCells = new Map<string, number>();
  for (let y = first; y < last; y++) {
    const line = buf.getLine(y);
    const joined = joinWrapped && !!line?.isWrapped && rows.length > 0;
    const row = joined ? rows[rows.length - 1] : { chars: [] as string[], styles: [] as string[] };
    // A wide character that did not fit leaves an empty cell before the wrap.
    if (joined && row.chars.at(-1) === '') {
      row.chars.pop();
      row.styles.pop();
    }
    for (let x = 0; line && x < line.length; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      const style = highlightStyle(cell);
      const chars = cell.getChars();
      row.chars.push(chars);
      row.styles.push(style);
      // Only text counts: a backdrop of blank cells often shares its colour with the selection.
      if (chars.trim()) textCells.set(style, (textCells.get(style) ?? 0) + 1);
    }
    if (!joined) rows.push(row);
  }
  const base = [...textCells].reduce((a, b) => (b[1] > a[1] ? b : a), ['', 0])[0];
  const marked = (style: string) => style !== '' && style !== base;
  return rows.map(({ chars, styles }) => {
    let out = '';
    for (let x = 0; x < chars.length; ) {
      if (!marked(styles[x])) {
        out += chars[x++] || ' ';
        continue;
      }
      let end = x;
      while (end < chars.length && marked(styles[end])) end++;
      const run = chars.slice(x, end).map((c) => c || ' ').join('');
      const text = run.trim();
      out += text ? run.replace(text, `«${text}»`) : run;
      x = end;
    }
    // Full-screen programs clear lines by writing spaces.
    return out.trimEnd();
  });
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
