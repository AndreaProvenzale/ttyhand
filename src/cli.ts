#!/usr/bin/env node
import { Client, callerEnv, stopDaemon } from './client.js';
import { runDaemon } from './daemon.js';
import { KEY_NAMES } from './keys.js';
import { formatList, runMcp } from './mcp.js';
import { formatResult, type ListEntry, type Result } from './protocol.js';

const USAGE = `Usage: ttyhand <command>

  spawn [--name N] [--cwd DIR] [--cols N] [--rows N] [--timeout MS] <cmd> [args...]
  send <id> [text] [--keys K1,K2] [--no-wait] [--timeout MS]
             text is typed literally, then keys are pressed: send py-1 '1+1' --keys Enter
  wait <id> [--until input|exit] [--pattern REGEX] [--timeout MS]
             after a running result; --pattern returns once the screen matches
  resize <id> <cols> <rows> [--timeout MS]
  read <id> [--mode screen|new_output|scrollback] [--since SEQ]
  kill <id> [--signal SIG]
  list
  mcp        run the stdio MCP server
  daemon     run the daemon in the foreground
  stop       stop the daemon and every program it owns

Keys: ${KEY_NAMES}`;

type Flags = Record<string, string | true>;
const BOOLEAN_FLAGS = new Set(['no-wait', 'help']);

/** Flags anywhere, or only before the first positional when `stopAtPositional` (so spawn passes args through). */
function parse(argv: string[], stopAtPositional = false): { flags: Flags; pos: string[] } {
  const flags: Flags = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [key, value] = a.slice(2).split(/=(.*)/s);
      if (value !== undefined) flags[key] = value;
      else if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
      else if (i + 1 < argv.length) flags[key] = argv[++i];
      else throw new Error(`--${key} needs a value`);
      continue;
    }
    if (stopAtPositional) {
      pos.push(...argv.slice(i));
      break;
    }
    pos.push(a);
  }
  return { flags, pos };
}

function num(flags: Flags, key: string): number | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${key} must be a non-negative integer`);
  return n;
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function need(pos: string[], count: number, usage: string) {
  if (pos.length < count) throw new Error(`usage: ttyhand ${usage}`);
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb === 'daemon') return runDaemon();
  if (verb === 'mcp') return runMcp();
  if (!verb || verb === 'help' || verb === '--help') {
    console.log(USAGE);
    return;
  }

  const client = new Client(false);
  const print = (r: Result) => console.log(formatResult(r));
  try {
    switch (verb) {
      case 'spawn': {
        const { flags, pos } = parse(rest, true);
        need(pos, 1, 'spawn [flags] <cmd> [args...]');
        print(
          await client.call('spawn', {
            cmd: pos[0],
            args: pos.slice(1),
            cwd: str(flags, 'cwd') ?? process.cwd(),
            inherit_env: callerEnv(),
            name: str(flags, 'name'),
            cols: num(flags, 'cols'),
            rows: num(flags, 'rows'),
            timeout_ms: num(flags, 'timeout'),
          }),
        );
        break;
      }
      case 'send': {
        const { flags, pos } = parse(rest);
        need(pos, 1, 'send <id> [text] [--keys K1,K2]');
        const keys = str(flags, 'keys')?.split(',');
        print(await client.call('send', { id: pos[0], text: pos[1], keys, wait: !flags['no-wait'], timeout_ms: num(flags, 'timeout') }));
        break;
      }
      case 'wait': {
        const { flags, pos } = parse(rest);
        need(pos, 1, 'wait <id> [--until input|exit] [--pattern REGEX]');
        print(await client.call('wait', { id: pos[0], until: str(flags, 'until'), pattern: str(flags, 'pattern'), timeout_ms: num(flags, 'timeout') }));
        break;
      }
      case 'resize': {
        const { flags, pos } = parse(rest);
        need(pos, 3, 'resize <id> <cols> <rows>');
        print(await client.call('resize', { id: pos[0], cols: Number(pos[1]), rows: Number(pos[2]), timeout_ms: num(flags, 'timeout') }));
        break;
      }
      case 'read': {
        const { flags, pos } = parse(rest);
        need(pos, 1, 'read <id>');
        print(await client.call('read', { id: pos[0], mode: str(flags, 'mode'), since: num(flags, 'since') }));
        break;
      }
      case 'kill': {
        const { flags, pos } = parse(rest);
        need(pos, 1, 'kill <id>');
        print(await client.call('kill', { id: pos[0], signal: str(flags, 'signal') }));
        break;
      }
      case 'list':
        console.log(formatList(await client.call<ListEntry[]>('list')));
        break;
      case 'stop':
        if (!(await stopDaemon())) console.log('no daemon running');
        break;
      default:
        throw new Error(`unknown command "${verb}"\n\n${USAGE}`);
    }
  } finally {
    client.close();
  }
}

main().catch((err: Error) => {
  console.error(`ttyhand: ${err.message}`);
  process.exit(1);
});
