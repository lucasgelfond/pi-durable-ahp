#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { piAgent } from "./pi.js";
import { durableAhp } from "./sessions.js";
// A host on this machine for a terminal's own agents: each session an ACP agent's (pi in its own TUI, Claude Code,
// Gemini CLI, …: the config's `providers`), or pi-durable's own coding agent if the config names a model (`pi`, its key from the
// environment as pi-ai finds it), the catalogue and pi's own sessions kept in SQLite. AHP at /ahp, on a unix socket only its
// user can open, and on 127.0.0.1 if asked for a port: nothing listens beyond this machine. An
// agent's process is started (npx fetching it, the first time) only once one of its sessions is used.
//
//   pi-durable-ahp [--config ~/.concourse/host.json] [--socket ~/.concourse/host.sock] [--db ~/.concourse/host.db] [--port N]
//
// The config, JSON: { "providers": [{ "id", "displayName", "command", "args"?, "env"? }], "pi"?: { "provider", "modelId" },
// "piCommand"?: ["pi", …], "piWorkspaces"?: "{project}__workspaces" }. pi in its own terminal ("pi") is always there; beside it the config's providers, or
// without them the agents below.
const home = join(homedir(), ".concourse");
const AGENTS = [
    { id: "claude", displayName: "Claude Code", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"] },
    { id: "gemini", displayName: "Gemini CLI", command: "npx", args: ["-y", "@google/gemini-cli@0.66.0", "--acp"] },
];
const { values: args } = parseArgs({
    options: {
        config: { type: "string", default: join(home, "host.json") },
        socket: { type: "string", default: join(home, "host.sock") },
        db: { type: "string", default: join(home, "host.db") },
        port: { type: "string" },
    },
});
const config = (existsSync(args.config) ? JSON.parse(readFileSync(args.config, "utf8")) : {});
// pi on PATH (or the config's piCommand), in a terminal of its own (pi.ts), its files beside the database, its
// workspaces beside the repo (or the config's piWorkspaces).
const tui = piAgent({ dir: dirname(args.db), pi: config.piCommand, workspaces: config.piWorkspaces ?? "{project}__workspaces" });
const ctx = BACKGROUND_CONTEXT;
mkdirSync(dirname(args.db), { recursive: true });
const registry = createRegistry();
registry.install(CodingTools);
const harness = await Harness.open(await openNodeSqliteStorage(args.db), {
    models: config.pi ? builtinModels() : createModels(),
    registry,
    settings: () => ({ extensions: [CodingTools] }),
    env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? homedir() }),
}, ctx);
harness.resume();
const pi = config.pi;
const ahp = durableAhp({
    harness: () => harness,
    context: ctx,
    info: { name: "pi-durable-ahp", version: "0" },
    ...(pi && {
        agent: { provider: "pi-durable", displayName: "pi (durable)", description: `${pi.provider}/${pi.modelId}` },
        create: (_session, { workingDirectory }) => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: pi, cwd: workingDirectory ?? homedir() } }, ctx),
    }),
    providers: [tui, ...(config.providers ?? AGENTS)],
});
const server = createServer((_req, res) => res.writeHead(404).end());
server.on("upgrade", (req, socket, head) => (new URL(req.url ?? "/", "http://host").pathname === "/ahp" ? ahp.upgrade(req, socket, head) : socket.destroy()));
server.requestTimeout = 0;
mkdirSync(dirname(args.socket), { recursive: true });
rmSync(args.socket, { force: true });
await new Promise((resolve) => server.listen(args.socket, resolve));
chmodSync(args.socket, 0o600);
const listening = [args.socket];
if (args.port) {
    const tcp = createServer(server.listeners("request")[0]);
    tcp.requestTimeout = 0;
    for (const l of server.listeners("upgrade"))
        tcp.on("upgrade", l);
    await new Promise((resolve) => tcp.listen(Number(args.port), "127.0.0.1", resolve));
    listening.push(`127.0.0.1:${tcp.address().port}`);
}
// The line a caller waits for.
console.log(`listening on ${listening.join(" and ")}`);
const stop = () => {
    ahp.close();
    rmSync(args.socket, { force: true });
    process.exit(0);
};
process.on("SIGINT", stop).on("SIGTERM", stop);
