import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  PROTOCOL_VERSION,
  homeDir,
  lockPath,
  socketPath,
  type HelloParams,
  type KillParams,
  type ListEntry,
  type ReadParams,
  type Request,
  type Response,
  type SendParams,
  type SpawnParams,
} from './protocol.js';
import { Session } from './session.js';

const MAX_SESSIONS = 32;
const REAP_MS = 30 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

const TERMINAL_ENV = { TERM: 'xterm-256color', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' };

interface Conn {
  socket: net.Socket;
  owner: boolean;
}

const sessions = new Map<string, Session>();
const counters = new Map<string, number>();
let server: net.Server;

const log = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

export async function runDaemon() {
  ensureHome();
  if (!acquireLock()) {
    log('another daemon holds the lock; exiting');
    return;
  }
  fs.rmSync(socketPath(), { force: true });
  server = net.createServer(onConnection);
  server.listen(socketPath(), () => {
    fs.chmodSync(socketPath(), 0o600);
    log(`listening on ${socketPath()} (pid ${process.pid})`);
  });
  setInterval(reap, 60_000).unref();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, shutdown);
}

function ensureHome() {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(dir);
  if (process.getuid && stat.uid !== process.getuid()) throw new Error(`${dir} is owned by another user`);
  fs.chmodSync(dir, 0o700);
}

function acquireLock(): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath(), String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(lockPath(), 'utf8'));
      // An empty lock means another daemon is mid-write.
      if (!pid || isAlive(pid)) return false;
      fs.rmSync(lockPath(), { force: true });
    }
  }
  return false;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function onConnection(socket: net.Socket) {
  const conn: Conn = { socket, owner: false };
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) void respond(conn, line);
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    for (const s of sessions.values()) {
      if (s.owner === conn) {
        sessions.delete(s.id);
        void s.kill('SIGTERM');
      }
    }
  });
}

async function respond(conn: Conn, line: string) {
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const res: Response = { id: req.id };
  try {
    res.result = await handle(conn, req.method, req.params ?? {});
  } catch (err) {
    res.error = { message: (err as Error).message };
  }
  if (!conn.socket.destroyed) conn.socket.write(JSON.stringify(res) + '\n');
}

async function handle(conn: Conn, method: string, params: any): Promise<unknown> {
  switch (method) {
    case 'hello': {
      const p = params as HelloParams;
      if (p.version < PROTOCOL_VERSION) {
        throw new Error(`this ttyhand client (protocol ${p.version}) is older than the daemon (${PROTOCOL_VERSION}); restart it (MCP: reconnect the server)`);
      }
      if (p.version > PROTOCOL_VERSION) {
        throw new Error(`the daemon (protocol ${PROTOCOL_VERSION}) is older than this client (${p.version}); run \`ttyhand stop\``);
      }
      conn.owner = p.owner;
      return { version: PROTOCOL_VERSION, pid: process.pid };
    }
    case 'spawn':
      return spawn(conn, params as SpawnParams);
    case 'send': {
      const p = params as SendParams;
      const s = get(p.id);
      return s.run(() => s.send(p.text, p.keys ?? [], p.wait ?? true, timeout(p.timeout_ms)));
    }
    case 'read': {
      const p = params as ReadParams;
      const s = get(p.id);
      s.lastUsedAt = Date.now();
      return s.snapshot(p.mode ?? 'screen', p.since);
    }
    case 'kill': {
      const p = params as KillParams;
      const s = get(p.id);
      const result = await s.run(() => s.kill(p.signal ?? 'SIGTERM'));
      sessions.delete(s.id);
      log(`killed ${s.id} (code ${s.exitCode})`);
      return result;
    }
    case 'list':
      return [...sessions.values()]
        .filter((s) => !conn.owner || s.owner === conn)
        .map((s): ListEntry => ({ id: s.id, cmd: [s.opts.cmd, ...s.opts.args].join(' '), state: s.exited ? 'exited' : 'running', exitCode: s.exitCode }));
    case 'stop':
      setImmediate(shutdown);
      return { stopping: true };
    default:
      throw new Error(`unknown method ${method}`);
  }
}

async function spawn(conn: Conn, p: SpawnParams) {
  if (!p.cmd) throw new Error('cmd is required');
  if (sessions.size >= MAX_SESSIONS) throw new Error(`too many programs (max ${MAX_SESSIONS}); kill one first`);
  const cols = p.cols ?? 100;
  const rows = p.rows ?? 30;
  const env: Record<string, string> = { ...(p.inherit_env ?? (process.env as Record<string, string>)), ...TERMINAL_ENV, COLUMNS: String(cols), LINES: String(rows), ...p.env };
  const cwd = p.cwd ?? process.cwd();
  if (!findExecutable(p.cmd, env.PATH ?? '', cwd)) throw new Error(`command not found: ${p.cmd}`);
  const id = newId(p.cmd, p.name);
  const session = new Session(id, { cmd: p.cmd, args: p.args ?? [], cwd, env, cols, rows }, conn.owner ? conn : undefined);
  sessions.set(id, session);
  log(`spawned ${id}: ${[p.cmd, ...(p.args ?? [])].join(' ')}`);
  return session.run(async () => session.snapshot('screen', undefined, await session.waitIdle(timeout(p.timeout_ms))));
}

function findExecutable(cmd: string, pathVar: string, cwd: string): boolean {
  const candidates = cmd.includes('/') ? [path.resolve(cwd, cmd)] : pathVar.split(path.delimiter).filter(Boolean).map((d) => path.join(d, cmd));
  return candidates.some((c) => {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return fs.statSync(c).isFile();
    } catch {
      return false;
    }
  });
}

function newId(cmd: string, name?: string): string {
  if (name) {
    if (!/^[\w.-]+$/.test(name)) throw new Error('name may only contain letters, digits, "_", "-" and "."');
    if (sessions.has(name)) throw new Error(`"${name}" is already running`);
    return name;
  }
  const base = path.basename(cmd).replace(/[^\w.-]/g, '') || 'prog';
  let n = counters.get(base) ?? 0;
  do n++;
  while (sessions.has(`${base}-${n}`));
  counters.set(base, n);
  return `${base}-${n}`;
}

function get(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error(`no program with id "${id}"; call list to see what is running`);
  return s;
}

const timeout = (ms?: number) => Math.min(Math.max(ms ?? DEFAULT_TIMEOUT_MS, 0), MAX_TIMEOUT_MS);

function reap() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (s.owner) continue;
    if (now - Math.max(s.lastUsedAt, s.lastOutputAt) > REAP_MS) {
      sessions.delete(s.id);
      log(`reaped idle ${s.id}`);
      void s.kill('SIGTERM');
    }
  }
}

function shutdown() {
  log('shutting down');
  for (const s of sessions.values()) if (!s.exited) s.pty.kill('SIGKILL');
  server?.close();
  fs.rmSync(socketPath(), { force: true });
  fs.rmSync(lockPath(), { force: true });
  process.exit(0);
}
