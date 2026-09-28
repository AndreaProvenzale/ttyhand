import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { PROTOCOL_VERSION, homeDir, logPath, socketPath, type Response } from './protocol.js';

const START_TIMEOUT_MS = 5000;

/** Socket client of the daemon; starts the daemon on first use. */
export class Client {
  private socket?: net.Socket;
  private connecting?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  /** `owner` connections own what they spawn: the daemon kills it when they disconnect. */
  constructor(private owner: boolean) {}

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (!this.socket || this.socket.destroyed) {
      this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
      await this.connecting;
    }
    return this.request<T>(method, params);
  }

  close() {
    this.socket?.end();
  }

  private async connect() {
    const socket = await connectOrStart();
    this.socket = socket;
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const res: Response = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        const p = this.pending.get(res.id);
        this.pending.delete(res.id);
        if (res.error) p?.reject(new Error(res.error.message));
        else p?.resolve(res.result);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('lost connection to the ttyhand daemon'));
      this.pending.clear();
    });
    await this.request('hello', { version: PROTOCOL_VERSION, owner: this.owner });
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
}

export function callerEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
}

function connectOnce(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath());
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function connectOrStart(): Promise<net.Socket> {
  try {
    return await connectOnce();
  } catch {}
  startDaemon();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      return await connectOnce();
    } catch {}
  }
  throw new Error(`could not start the ttyhand daemon; see ${logPath()}`);
}

function startDaemon() {
  fs.mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const out = fs.openSync(logPath(), 'a', 0o600);
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);
}
