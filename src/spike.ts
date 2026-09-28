/**
 * M0 spike: spawn python3 in a PTY, feed every byte into a headless xterm,
 * print the rendered grid after IDLE_MS of silence, then send `1+1` and check for `2`.
 */
import pty from '@lydell/node-pty';
import xterm from '@xterm/headless';

const COLS = 100;
const ROWS = 30;
const IDLE_MS = 400;

const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
const child = pty.spawn('python3', [], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color', NO_COLOR: '1', PAGER: 'cat' },
});

let lastOutput = Date.now();
child.onData((data) => {
  lastOutput = Date.now();
  term.write(data);
});

function waitIdle(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      const now = Date.now();
      if (now - lastOutput >= IDLE_MS || now - start >= timeoutMs) {
        clearInterval(tick);
        // xterm parses writes asynchronously; flush before reading the buffer.
        term.write('', () => resolve());
      }
    }, 50);
  });
}

function screen(): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    lines.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

await waitIdle();
console.log('--- after spawn ---\n' + screen());

child.write('1+1\r');
await waitIdle();
const after = screen();
console.log('--- after 1+1 ---\n' + after);

const ok = after.split('\n').some((l) => l.trim() === '2');
console.log(ok ? '\nPASS: read 2 back from the grid' : '\nFAIL: no "2" line on screen');

child.kill();
process.exit(ok ? 0 : 1);
