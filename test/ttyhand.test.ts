import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client as DaemonClient } from '../src/client.js';
import { encodeKey } from '../src/keys.js';
import { plainText } from '../src/session.js';

const CLI = path.resolve(import.meta.dirname, '../dist/cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tth-'));
const env = { ...process.env, TTYHAND_HOME: HOME } as Record<string, string>;

const clients: Client[] = [];
const cli = async (...args: string[]) => (await promisify(execFile)(CLI, args, { env })).stdout;

async function mcpClient() {
  const client = new Client({ name: 'ttyhand-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env }));
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!res.isError, res.content[0].text);
    return res.content[0].text;
  };
  return { client, call };
}

const idOf = (screen: string) => screen.match(/^\[(\S+)/)![1];
const which = (cmd: string) => (process.env.PATH ?? '').split(path.delimiter).some((d) => fs.existsSync(path.join(d, cmd)));

before(() => assert.ok(fs.existsSync(CLI), 'run `pnpm build` first'));
after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await cli('stop').catch(() => {});
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('plainText strips escapes and applies \\r and backspace', () => {
  assert.equal(plainText('\x1b[1mhi\x1b[0m\r\n'), 'hi\n');
  assert.equal(plainText('10%\r50%\r99%'), '99%');
  assert.equal(plainText('abx\x08c'), 'abc');
});

test('encodeKey follows application-cursor mode and modifiers', () => {
  assert.equal(encodeKey('Enter', false), '\r');
  assert.equal(encodeKey('up', false), '\x1b[A');
  assert.equal(encodeKey('Up', true), '\x1bOA');
  assert.equal(encodeKey('Ctrl+C', false), '\x03');
  assert.equal(encodeKey('Alt+X', false), '\x1bX');
  assert.equal(encodeKey('Alt+Left', false), '\x1b\x1b[D');
  assert.throws(() => encodeKey('Enterr', false), /unknown key "Enterr"/);
});

test('a daemon speaking another protocol is refused on every call, and stop still reaches it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tth-skew-'));
  let stopped = false;
  const daemon = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      for (const { id, method } of data.split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
        if (method === 'stop') stopped = true;
        socket.write(JSON.stringify(method === 'hello' ? { id, error: { message: 'protocol mismatch' } } : { id, result: [] }) + '\n');
        if (method === 'stop') socket.destroy();
      }
    });
  });
  await new Promise<void>((r) => daemon.listen(path.join(home, 'daemon.sock'), r));
  process.env.TTYHAND_HOME = home;
  const client = new DaemonClient(true);
  await assert.rejects(client.call('list'), /protocol mismatch/);
  await assert.rejects(client.call('list'), /protocol mismatch/);
  delete process.env.TTYHAND_HOME;
  await promisify(execFile)(CLI, ['stop'], { env: { ...env, TTYHAND_HOME: home } });
  assert.ok(stopped);
  daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('over MCP', () => {
  test('python REPL', async () => {
    const { client, call } = await mcpClient();
    const id = idOf(await call('spawn', { cmd: 'python3' }));
    const screen = await call('send', { id, text: '1+1', keys: ['Enter'] });
    assert.match(screen, /waiting_input/);
    assert.match(screen, /^2$/m);
    assert.match(await call('send', { id, text: 'print("a\\nb")', keys: ['Enter'] }), /^a\nb$/m);
    assert.match(await call('kill', { id }), /exited code=143/);
    await client.close();
  });

  test('node REPL', async () => {
    const { client, call } = await mcpClient();
    const id = idOf(await call('spawn', { cmd: 'node' }));
    assert.match(await call('send', { id, text: '[1,2,3].map(x => x*2)', keys: ['Enter'] }), /\[ 2, 4, 6 \]/);
    assert.match(await call('send', { id, text: '.exit', keys: ['Enter'] }), /exited code=0/);
    await client.close();
  });

  test('npm init wizard in one send', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tth-npm-'));
    const { client, call } = await mcpClient();
    const id = idOf(await call('spawn', { cmd: 'npm', args: ['init'], cwd }));
    const screen = await call('send', { id, text: 'demo-pkg', keys: Array(12).fill('Enter') });
    assert.match(screen, /exited code=0/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).name, 'demo-pkg');
    await client.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('a silent pause on an empty line is not taken for a prompt', async () => {
    const { client, call } = await mcpClient();
    const script = 'console.log("loading"); setTimeout(() => process.stdout.write("ready> "), 1000); process.stdin.resume()';
    assert.match(await call('spawn', { cmd: 'node', args: ['-e', script] }), /waiting_input[^\n]*\nloading\nready>/);
    await client.close();
  });

  test('wait after a running result, until exit, and for a pattern', async () => {
    const { client, call } = await mcpClient();
    const ticker = 'let i = 0; const t = setInterval(() => { process.stdout.write(`\\rstep ${++i}`); if (i === 15) { clearInterval(t); process.stdout.write("\\nname? "); } }, 100); process.stdin.resume()';
    const id = idOf(await call('spawn', { cmd: 'node', args: ['-e', ticker], timeout_ms: 300 }));
    assert.match(await call('wait', { id, pattern: 'step [5-9]' }), /running[^\n]* matched\]/);
    assert.match(await call('wait', { id }), /waiting_input[^\n]*\]\nstep 15\nname\? ?$/);
    assert.match(await call('wait', { id, pattern: 'never', timeout_ms: 200 }), /no_match/);
    await call('send', { id, keys: ['Ctrl+C'] });
    assert.match(await call('wait', { id, until: 'exit' }), /exited/);
    await client.close();
  });

  test('terminal queries get answered', async () => {
    const { client, call } = await mcpClient();
    const script = 'process.stdin.setRawMode(true); process.stdout.write("\\x1b[6n"); process.stdin.once("data", (d) => { console.log("reply", d.toString().slice(1)); process.exit(0) })';
    assert.match(await call('spawn', { cmd: 'node', args: ['-e', script] }), /reply \[\d+;\d+R/);
    await client.close();
  });

  test('highlights are marked, except the style most text is in', async () => {
    const { client, call } = await mcpClient();
    const script = 'process.stdout.write("one \\x1b[7mtwo\\x1b[0m three\\n\\x1b[47m box text here \\x1b[44mpick\\x1b[47m more box \\x1b[0m\\n"); process.stdin.resume()';
    assert.match(await call('spawn', { cmd: 'node', args: ['-e', script] }), /\]\none «two» three\n box text here «pick» more box$/);
    await client.close();
  });

  test('vim edit and :wq', { skip: !which('vim') && 'vim not installed' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tth-vim-'));
    const file = path.join(dir, 'notes.txt');
    const { client, call } = await mcpClient();
    const id = idOf(await call('spawn', { cmd: 'vim', args: ['-u', 'NONE', file] }));
    const screen = await call('send', { id, text: 'ihello\nworld', keys: ['Esc'] });
    assert.match(screen, /\]\nhello\nworld\n~\n/);
    assert.doesNotMatch(screen, / $/m);
    assert.match(await call('send', { id, text: ':wq', keys: ['Enter'] }), /exited code=0/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello\nworld\n');
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('resize reaches the program', async () => {
    const { client, call } = await mcpClient();
    const id = idOf(await call('spawn', { cmd: 'python3' }));
    await call('resize', { id, cols: 60, rows: 12 });
    assert.match(await call('send', { id, text: 'import shutil; shutil.get_terminal_size()', keys: ['Enter'] }), /columns=60, lines=12/);
    await call('kill', { id });
    await client.close();
  });

  test('programs die with their connection and stay private to it', async () => {
    const a = await mcpClient();
    const b = await mcpClient();
    const id = idOf(await a.call('spawn', { cmd: 'python3' }));
    assert.match(await a.call('list'), new RegExp(id));
    assert.doesNotMatch(await b.call('list'), new RegExp(id));
    assert.match(await cli('list'), new RegExp(id));
    await a.client.close();
    await b.client.close();
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(await cli('list'), new RegExp(id));
  });
});

describe('over the CLI', () => {
  test('python REPL, new_output and keys', async () => {
    const id = idOf(await cli('spawn', 'python3'));
    const first = await cli('send', id, 'print("a")', '--keys', 'Enter');
    const seq = first.match(/seq=(\d+)/)![1];
    await cli('send', id, 'print("b")', '--keys', 'Enter');
    assert.equal((await cli('read', id, '--mode', 'new_output', '--since', seq)).split('\n').slice(1, 3).join('\n'), 'print("b")\nb');
    assert.match(await cli('kill', id), /exited/);
  });

  test('attach mirrors a program live until Ctrl+C', async () => {
    const id = idOf(await cli('spawn', 'python3'));
    await cli('send', id, 'x = 41', '--keys', 'Enter');
    const viewer = idOf(await cli('spawn', process.execPath, CLI, 'attach', id));
    await cli('send', id, 'x + 1', '--keys', 'Enter');
    assert.match(await cli('wait', viewer, '--pattern', '^42$', '--timeout', '5000'), / matched\]\nattached to [^\n]*\n[^]*>>> x = 41\n>>> x \+ 1\n42\n>>>/);
    assert.match(await cli('send', viewer, '--keys', 'Ctrl+C'), /exited code=0[^]*\ndetached\n$/);
    await cli('kill', id);
  });

  test('spawn passes flags after the command through', async () => {
    const id = idOf(await cli('spawn', '--name', 'echoer', 'node', '-e', 'console.log(process.argv.slice(1).join(","))', '--', '--x', 'y'));
    assert.equal(id, 'echoer');
    assert.match(await cli('read', id), /--x,y/);
    await cli('kill', id);
  });
});
