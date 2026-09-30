import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Client, callerEnv } from './client.js';
import { KEY_NAMES } from './keys.js';
import { formatResult, type ListEntry, type Result } from './protocol.js';

const { version } = createRequire(import.meta.url)('../package.json');

const STATUS_HELP =
  'The result starts with a status line: waiting_input (quiet, most likely your turn), running (still busy — call wait), or exited with its code. The first line also gives the program id and the 1-based row and column of the cursor on the screen. Text in reverse video or on a coloured background, typically the selected item in a menu or list, is wrapped in «»; bold or coloured text is not marked.';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const screen = (r: Result) => text(formatResult(r));

export async function runMcp() {
  const client = new Client(true);
  const server = new McpServer({ name: 'ttyhand', version });
  const id = z.string().describe('Program id: the id=… value on the first line of spawn\'s result');
  const timeout_ms = z.number().int().min(0).optional().describe('Max time to wait for the program to go quiet (default 10000)');
  const cols = z.number().int().min(20).max(500);
  const rows = z.number().int().min(5).max(200);

  server.registerTool(
    'spawn',
    {
      description: `Start an interactive program (REPL, installer wizard, debugger, TUI) in a real terminal and return its screen once it goes quiet. The id in the first line of every result (id=…) is what the other tools take. ${STATUS_HELP}`,
      inputSchema: {
        cmd: z.string().describe('Executable, e.g. "python3"'),
        args: z.array(z.string()).optional().describe('Arguments, one per item'),
        cwd: z.string().optional().describe("Working directory (default: the server's)"),
        env: z.record(z.string(), z.string()).optional().describe('Extra environment variables'),
        cols: cols.optional().describe('Terminal width (default 100)'),
        rows: rows.optional().describe('Terminal height (default 30)'),
        name: z.string().optional().describe('Readable id to use instead of the generated one'),
        timeout_ms,
      },
    },
    async (p) => screen(await client.call('spawn', { ...p, cwd: p.cwd ?? process.cwd(), inherit_env: callerEnv() })),
  );

  server.registerTool(
    'send',
    {
      description: `Type into a program and return its screen once it goes quiet. text is typed literally, then keys are pressed: {"text": "1+1", "keys": ["Enter"]} runs a line, {"keys": ["Down", "Down", "Enter"]} picks from a menu, {"keys": ["Ctrl+C"]} interrupts. ${STATUS_HELP}`,
      inputSchema: {
        id,
        text: z.string().optional().describe('Typed exactly as given; press Enter and other special keys with keys'),
        keys: z.array(z.string()).optional().describe(`Keys pressed after text, in order, so {"text": "ihi", "keys": ["Esc", ":", "w", "q", "Enter"]} works: ${KEY_NAMES}`),
        wait: z.boolean().optional().describe('Wait for the program to go quiet before returning (default true)'),
        timeout_ms,
      },
    },
    async (p) => screen(await client.call('send', p)),
  );

  server.registerTool(
    'wait',
    {
      description: `Wait without typing, then return the screen: for when a result said running (an install, a build, a slow start). Returns once the program wants input again, or with until=exit once it exits. pattern returns as soon as the screen matches it instead, and the status line says pattern=matched or pattern=no_match. ${STATUS_HELP}`,
      inputSchema: {
        id,
        until: z.enum(['input', 'exit']).optional().describe('Default input'),
        pattern: z.string().optional().describe('JavaScript regex tested against the screen, ^ and $ per line, e.g. "Listening on|Error". Lines are right-trimmed, so leave out a prompt\'s trailing space: "\\(Pdb\\)$", not "\\(Pdb\\) $"'),
        timeout_ms: z.number().int().min(0).optional().describe('Max time to wait (default 30000)'),
      },
      annotations: { readOnlyHint: true },
    },
    async (p) => screen(await client.call('wait', p)),
  );

  server.registerTool(
    'resize',
    {
      description: `Resize the terminal and return the screen after the program redraws. Use it when a full-screen program wraps or cuts off lines; line-based programs do not re-wrap what they already printed. ${STATUS_HELP}`,
      inputSchema: { id, cols: cols.describe('Terminal width'), rows: rows.describe('Terminal height'), timeout_ms },
    },
    async (p) => screen(await client.call('resize', p)),
  );

  server.registerTool(
    'read',
    {
      description:
        'Return the current screen without typing anything; highlighted text is wrapped in «». mode=new_output returns plain text printed since an earlier result (pass its seq as since; \'(no new output)\' means nothing new); mode=scrollback returns the whole history, with wrapped lines joined.',
      inputSchema: {
        id,
        mode: z.enum(['screen', 'new_output', 'scrollback']).optional().describe('Default screen'),
        since: z.number().int().min(0).optional().describe('seq from an earlier result, for mode=new_output'),
      },
      annotations: { readOnlyHint: true },
    },
    async (p) => screen(await client.call('read', p)),
  );

  server.registerTool(
    'kill',
    {
      description: 'Stop a program (SIGTERM, then SIGKILL after 2 s) and return its final screen and exit code.',
      inputSchema: { id, signal: z.string().optional().describe('Default SIGTERM') },
      annotations: { destructiveHint: true },
    },
    async (p) => screen(await client.call('kill', p)),
  );

  server.registerTool(
    'list',
    {
      description: 'List the programs started through this connection.',
      annotations: { readOnlyHint: true },
    },
    async () => text(formatList(await client.call<ListEntry[]>('list'))),
  );

  await server.connect(new StdioServerTransport());
}

export function formatList(entries: ListEntry[]): string {
  if (!entries.length) return 'no programs running';
  return entries.map((e) => `${e.id}\t${e.state === 'exited' ? `exited code=${e.exitCode}` : e.state}\t${e.cmd}`).join('\n');
}
