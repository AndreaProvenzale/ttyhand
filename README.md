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
ttyhand kill python3-1
```

Every result starts with a status line: `waiting_input` (your turn), `running` (still busy; call `wait`) or `exited code=N`. "Your turn" means the program has been quiet for 400 ms with the cursor after some text, or for 2 s on an empty line. On Linux the kernel also says whether the program is blocked reading the terminal or busy elsewhere, which settles silent pauses.

MCP (Claude Code): `claude mcp add ttyhand -- npx -y ttyhand mcp`

## Develop

```sh
pnpm install
pnpm build
pnpm test                       # builds, then drives python3, node and npm init over MCP and the CLI
```

The daemon listens on `$TTYHAND_HOME/daemon.sock` (default `$TMPDIR/ttyhand-<uid>`) and logs to `daemon.log` there. `ttyhand stop` restarts it on the next call — needed after a rebuild.
