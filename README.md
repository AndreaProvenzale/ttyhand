# ttyhand

Let an agent drive interactive terminal programs — REPLs, wizards, debuggers, TUIs — through a real PTY. A daemon owns the programs; an MCP server and a CLI are thin clients of it.

```sh
ttyhand spawn python3          # prints the id and the screen once it goes quiet
ttyhand send python3-1 '1+1' --keys Enter    # text is typed literally, then keys are pressed
ttyhand send python3-1 --keys Up,Enter        # rerun the last line
ttyhand read python3-1 --mode new_output --since 166
ttyhand kill python3-1
```

MCP (Claude Code): `claude mcp add ttyhand -- npx -y ttyhand mcp`

## Develop

```sh
pnpm install
pnpm build
pnpm test                       # builds, then drives python3, node and npm init over MCP and the CLI
```

The daemon listens on `$TTYHAND_HOME/daemon.sock` (default `$TMPDIR/ttyhand-<uid>`) and logs to `daemon.log` there. `ttyhand stop` restarts it on the next call — needed after a rebuild.
