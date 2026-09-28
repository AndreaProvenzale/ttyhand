# ttyhand

Lets an agent drive interactive terminal programs through a real PTY, over
MCP or a CLI. Read `README.md`, then the
[plan](https://claude.ai/artifact/WcrmiCV77dS5gGcJ34GRtd): goals, tool
surface, design decisions and milestones.

## You own this

ttyhand's main user is an agent, so the agent working in this repo is its
owner, user and tester in one.

- **Write for a model reading cold.** Tool names, descriptions, parameters
  and the result format are the product. If a first-time caller would get a
  call wrong from its description, the description is the bug.
- **Friction is a bug.** A retry, an extra round trip, a misleading status or
  a workaround you needed while using ttyhand gets fixed, or recorded as an
  open question in the plan.
- **Dogfood every change.** Tests prove the contract; driving a real program
  through the ttyhand MCP tools proves it is pleasant to use. Do both.
- **Decide, then report.** Within the plan's goals and non-goals, make API
  calls yourself and say what you chose and why. Ask before changing scope:
  a new verb, a non-goal, publishing.

## How we work

- **Simple beats clever.** The minimum that solves the problem. No option
  nobody asked for, no abstraction for single-use code.
- **Code speaks for itself.** Names carry the meaning; a comment is a
  one-liner explaining a why the code cannot.
- **Surgical diffs.** Every changed line traces to the task.
- **A tiny surface.** Six verbs, no tmux concepts. A new parameter earns its
  place with a failure you saw, not one you imagined.
- **Every call returns.** A timeout hands back the screen with
  `state=running`; nothing hangs the caller.
- **State what you checked, not what you believe.** A finding names the
  program, the call and the screen that showed it.
- **No dates in docs.** Git history owns time.
- **Docs follow the code.** A change to a tool or flag updates the MCP
  description, the CLI usage and `README.md` in the same change.

## Develop

```sh
pnpm install
pnpm test        # builds, then drives python3, node and npm init over MCP and the CLI
pnpm typecheck
```

Tests use their own `TTYHAND_HOME`, so they never touch your session's daemon.

After a rebuild your session still runs old code in two places: the daemon
(`node dist/cli.js stop` restarts it on the next call, killing every program
it owns) and the MCP frontend (the user reconnects it with `/mcp`). A change
to the socket protocol bumps `PROTOCOL_VERSION`; until reconnected, the old
frontend fails with a message saying so.
