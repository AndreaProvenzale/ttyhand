# ttyhand

Let an agent drive interactive terminal programs — REPLs, wizards, debuggers, TUIs — through a real PTY. A daemon owns the programs; an MCP server and a CLI are thin clients of it.

```sh
ttyhand spawn python3          # prints the id and the screen once it goes quiet
ttyhand send python3-1 '1+1' --keys Enter    # text is typed literally, then keys are pressed
ttyhand send python3-1 --keys Up,Enter        # rerun the last line
ttyhand wait python3-1                         # after a `running` result: block until it wants input again
ttyhand wait python3-1 --pattern 'Listening on' --timeout 60000
ttyhand resize python3-1 160 50
ttyhand read python3-1 --mode new_output --since 166
ttyhand attach python3-1                       # a human watches live, read-only; Ctrl+C detaches
ttyhand kill python3-1
```

Every result starts with a status line: `waiting_input` (your turn), `running` (still busy; call `wait`) or `exited code=N`. "Your turn" means the program has been quiet for 400 ms with the cursor after some text, or for 2 s on an empty line. On Linux the kernel also says whether the program is blocked reading the terminal or busy elsewhere, which settles silent pauses.

The screen comes back as plain text. Highlighted text, such as the selected item in a menu, a picker or htop's process list, is wrapped in `«»`.

MCP (Claude Code): `claude mcp add ttyhand -- npx -y ttyhand mcp`

## Sandboxes

MCP servers run outside Claude Code's sandbox, so ttyhand over MCP needs no setup. The CLI called from a sandboxed shell needs three things: a writable `TTYHAND_HOME`, its Unix socket and pseudo-terminals.

With [sandbox-runtime](https://github.com/anthropics/sandbox-runtime) (`srt`), allow all three and create the directory first, since the sandbox cannot:

```json
{
  "filesystem": { "denyRead": [], "allowWrite": ["/tmp/ttyhand"], "denyWrite": [] },
  "network": { "allowedDomains": [], "deniedDomains": [], "allowUnixSockets": ["/private/tmp/ttyhand/daemon.sock"] },
  "allowPty": true
}
```

```sh
mkdir -m 700 /tmp/ttyhand
TTYHAND_HOME=/tmp/ttyhand srt -c 'ttyhand spawn python3'
```

The socket is listed by its real path: `/tmp` is a link to `/private/tmp` on macOS. Linux ignores `allowUnixSockets` and `allowPty`; set `"allowAllUnixSockets": true` in `network` there.

Claude Code's sandbox blocks pseudo-terminals and has no setting to allow them, so a daemon started inside it cannot open a terminal. Use MCP, or start the daemon outside the sandbox (`TTYHAND_HOME=/tmp/ttyhand ttyhand list`) and allow its socket with `sandbox.network.allowUnixSockets`. That socket lets sandboxed commands start any program outside the sandbox, so it grants as much as `sandbox.excludedCommands` would.

## Develop

```sh
pnpm install
pnpm build
pnpm test                       # builds, then drives python3, node and npm init over MCP and the CLI
```

The daemon listens on `$TTYHAND_HOME/daemon.sock` (default `$TMPDIR/ttyhand-<uid>`) and logs to `daemon.log` there. `ttyhand stop` restarts it on the next call — needed after a rebuild.
