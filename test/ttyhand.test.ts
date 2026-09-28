import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { encodeKey } from '../src/keys.js';
import { plainText } from '../src/session.js';

const CLI = path.resolve(import.meta.dirname, '../dist/cli.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tth-'));
const env = { ...process.env, TTYHAND_HOME: HOME } as Record<string, string>;

const cli = async (...args: string[]) => (await promisify(execFile)(CLI, args, { env })).stdout;

async function mcpClient() {
  const client = new Client({ name: 'ttyhand-test', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    assert.ok(!res.isError, res.content[0].text);
    return res.content[0].text;
  };
  return { client, call };
}

const idOf = (screen: string) => screen.match(/^\[(\S+)/)![1];

before(() => assert.ok(fs.existsSync(CLI), 'run `pnpm build` first'));
after(async () => {
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

  test('spawn passes flags after the command through', async () => {
    const id = idOf(await cli('spawn', '--name', 'echoer', 'node', '-e', 'console.log(process.argv.slice(1).join(","))', '--', '--x', 'y'));
    assert.equal(id, 'echoer');
    assert.match(await cli('read', id), /--x,y/);
    await cli('kill', id);
  });
});
