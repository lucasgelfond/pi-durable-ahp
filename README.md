# pi-durable-ahp

An [Agent Host Protocol](https://microsoft.github.io/agent-host-protocol) host for pi. Any AHP client (an app, a
terminal, VS Code's agent UI) sees and drives the same sessions, live, from wherever it connects. A session is one of:

- **a pi-durable conversation**, run in the host's own process;
- **pi's own TUI** (`piAgent`): a real pi, kept running under dtach in a jj workspace of its own, here or in a box
  reached over ssh. You can open its terminal (`_meta.pi.attach`) while clients follow the same session, and what's
  typed in either shows in both;
- **any ACP agent** (Claude Code, Gemini CLI, …), run as a process of its own.

The host keeps each session's transcript in pi-durable's storage, so a chat stays readable when its agent isn't
running (a box asleep or gone), and it reconnects to an agent that runs on its own whenever the connection drops.

## A host on this machine

```sh
npx pi-durable-ahp [--config ~/.concourse/host.json] [--socket ~/.concourse/host.sock] [--db ~/.concourse/host.db] [--port N]
```

AHP at `/ahp`, on a Unix socket only you can open (and on 127.0.0.1 with `--port`); nothing listens beyond this
machine, so reach it from elsewhere through something like Tailscale or ssh. It offers pi in its own terminal
(`"pi"`, needs `pi`, `dtach` and `jj`), Claude Code and Gemini CLI. The config, JSON:

```json
{ "providers": [{ "id": "…", "displayName": "…", "command": "…", "args": [] }], "pi": { "provider": "…", "modelId": "…" }, "piCommand": ["pi"], "piWorkspaces": "{project}__workspaces" }
```

`providers` replaces Claude Code and Gemini CLI; `pi` adds pi-durable's own coding agent with that model;
`piCommand` is how pi is started; `piWorkspaces` where each session's jj workspace goes (`{project}` is the
repo it was given; beside it, `<repo>__workspaces/<session>`, by default).

## As a library

```ts
import { durableAhp, piAgent } from "pi-durable-ahp";

const ahp = durableAhp({
  harness: () => harness, // a pi-durable Harness
  context,
  info: { name: "my-host", version: "1" },
  providers: [
    piAgent({ dir: "/home/me/.my-host" }), // pi in its own terminal, here
    piAgent({ id: "box", dir: "/home/cua/.pi-sessions", shell: (script) => ["ssh", "box", script] }), // in a box
  ],
});
server.on("upgrade", (req, socket, head) => ahp.upgrade(req, socket, head));
```

`durableAhp`'s options also take the caller's own chats beside a session (its subagents), _meta, methods
(`x-<name>/…`) and a hook for each committed entry; see `DurableAhpOptions` in `src/sessions.ts`.

pi's side is an extension, `pi/acp.ts`: `pi -e <this package>/pi/acp.ts` makes a running pi TUI an ACP agent on a Unix
socket (`$PI_ACP_SOCKET`), which `piAgent` starts for you.

## Tests

```sh
pnpm install && pnpm test
```

They run a real pi (with a scripted model) under dtach, here and through a stand-in for ssh, so they need `pi`,
`dtach` and `jj` on PATH.
