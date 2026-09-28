const FIXED: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  'shift+tab': '\x1b[Z',
  esc: '\x1b',
  escape: '\x1b',
  backspace: '\x7f',
  space: ' ',
  insert: '\x1b[2~',
  delete: '\x1b[3~',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
};
const CURSOR: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' };

export const KEY_NAMES =
  'Enter, Tab, Shift+Tab, Esc, Backspace, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown, Insert, Delete, F1-F12, Ctrl+<letter>, Alt+<key>';

/** A named key to the bytes a terminal sends; arrows and Home/End follow application-cursor mode (vim, less). */
export function encodeKey(name: string, appCursor: boolean): string {
  const key = name.trim().toLowerCase();
  if (key in FIXED) return FIXED[key];
  if (key in CURSOR) return (appCursor ? '\x1bO' : '\x1b[') + CURSOR[key];
  const ctrl = key.match(/^ctrl\+([a-z@[\\\]^_])$/);
  if (ctrl) return String.fromCharCode(ctrl[1].toUpperCase().charCodeAt(0) & 0x1f);
  const alt = name.trim().match(/^alt\+(.+)$/i);
  if (alt) return '\x1b' + (alt[1].length === 1 ? alt[1] : encodeKey(alt[1], appCursor));
  throw new Error(`unknown key "${name}"; known keys: ${KEY_NAMES}`);
}
