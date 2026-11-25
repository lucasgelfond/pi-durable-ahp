import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, expect, onTestFinished, test } from "vitest";
import { piAgent } from "../src/index.ts";
import { client, follow, serve, until } from "./support.ts";

// pi's own TUI as a session (pi.ts, pi/acp.ts): a real pi, under dtach, with a faux model (pi-faux.ts: "echo: <prompt>",
// "use a tool" runs bash first, "wait" takes 5 s). Each test runs here and in a box: the same, but every script goes
// through a stand-in for ssh (its arguments joined into one command line, as ssh does), with its own files.

// Short, for the Unix sockets' paths.
const root = mkdtempSync("/tmp/pda-");
// pi's own folder, with this machine's fd and rg, so it downloads nothing.
const agentDir = join(root, "agent");
mkdirSync(join(agentDir, "bin"), { recursive: true });
for (const tool of existsSync(join(homedir(), ".pi/agent/bin")) ? readdirSync(join(homedir(), ".pi/agent/bin")) : []) symlinkSync(join(homedir(), ".pi/agent/bin", tool), join(agentDir, "bin", tool));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.JJ_USER = "Test";
process.env.JJ_EMAIL = "test@example.com";
const PI = ["pi", "-ne", "--no-mcp", "-ns", "-np", "-nc", "-e", new URL("./pi-faux.ts", import.meta.url).pathname, "--model", "faux/echo"];

// A command in a pseudo-terminal of a given size, its screen copied to stdout (Node has no pty of its own).
const TERMINAL = `
import fcntl, os, pty, struct, sys, termios
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
while True:
    try:
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    sys.stdout.buffer.write(data)
    sys.stdout.flush()
`;

const box = join(root, "box");
writeFileSync(box, '#!/bin/sh\nexec /bin/sh -c "$*"\n', { mode: 0o755 });
const places = [
  { place: "here", shell: undefined },
  { place: "in a box", shell: (script: string) => [box, script] },
];

type Part = { kind: string; content?: string; toolCall?: { toolName?: string; status?: string } };
type Turn = { id: string; message: { text: string; origin: { kind: string } }; responseParts: Part[]; state: string };
type Chat = { state: { turns: Turn[]; activeTurn?: { id: string } }; seen: { action: { type: string } }[] };
const said = (turn: Turn) => turn.responseParts.filter((p) => p.kind === "markdown").map((p) => p.content).join("");
const run = (cwd: string, command: string, ...args: string[]) => execFileSync(command, args, { cwd, encoding: "utf8" });

// Every host closed, and every pi the tests started ended.
const hosts: (() => void)[] = [];
afterAll(() => {
  hosts.forEach((close) => close());
  const pids = run(root, "find", ".", "-name", "*.pid").trim().split("\n").filter(Boolean);
  for (const file of pids) if (isRunning(Number(readFileSync(join(root, file), "utf8")))) process.kill(Number(readFileSync(join(root, file), "utf8")));
  rmSync(root, { recursive: true, force: true });
});

// A jj repo, a host whose "pi" agent keeps its files in `dir`, a client, and a pi session in the repo, followed.
test("a pi that moves to another session (/new in its terminal) is followed there, keeps each one it was on, and is started again on the last", async () => {
  const s = await session();
  const kept = join(s.dir, "run", `${s.id}.sessions`);
  s.prompt("in the first session");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  const typed = (text: string) => spawn("dtach", ["-p", s.files.tty], { stdio: ["pipe", "ignore", "ignore"] }).stdin.end(text);
  typed("/new\r");
  await until(() => existsSync(kept) && readFileSync(kept, "utf8").split("\n").filter(Boolean).length === 2, 15_000);
  const [first, second] = readFileSync(kept, "utf8").split("\n").filter(Boolean);
  expect(first).toBe(s.id);
  typed("in the second session\r");
  await until(() => s.chat.state.turns.some((t) => t.message.text === "in the second session" && t.state === "complete"), 30_000);

  const pid = Number(readFileSync(s.files.pid, "utf8"));
  s.c.c.dispatch(`ahp-session:/${s.id}`, { type: "session/isArchivedChanged", isArchived: true } as never);
  await until(() => !isRunning(pid), 10_000);
  s.c.c.dispatch(`ahp-session:/${s.id}`, { type: "session/isArchivedChanged", isArchived: false } as never);
  await until(() => existsSync(s.files.acp), 30_000);
  s.prompt("after reopening");
  await until(() => s.chat.state.turns.some((t) => t.message.text === "after reopening" && t.state === "complete"), 30_000);
  // Started again on the second: what's said now goes on there.
  const file = readFileSync(sessionFile(second), "utf8");
  expect([file.includes("in the second session"), file.includes("after reopening"), readFileSync(sessionFile(first), "utf8").includes("after reopening")]).toEqual([true, true, false]);
  s.c.ws.close();
}, 90_000);

async function session(shell?: (script: string) => string[], dir = mkdtempSync(join(root, "files-"))) {
  const repo = mkdtempSync(join(root, "repo-"));
  run(repo, "jj", "git", "init", "--quiet");
  writeFileSync(join(repo, "notes.txt"), "a note\n");
  run(repo, "jj", "commit", "--quiet", "-m", "notes");
  const pi = piAgent({ dir, pi: PI, shell });
  const host = await serve({ providers: [pi] });
  hosts.push(host.close);
  const c = await client(host.url);
  const id = randomUUID();
  await c.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(repo).href] } as never);
  const chat = (await follow(c.c, `ahp-chat:/${id}`)) as unknown as Chat;
  const files = { tty: join(dir, "run", `${id}.tty`), acp: join(dir, "run", `${id}.sock`), pid: join(dir, "run", `${id}.pid`), workspace: join(dir, "workspaces", id) };
  await until(() => existsSync(files.acp), 30_000);
  const prompt = (text: string) =>
    c.c.dispatch(`ahp-chat:/${id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text, origin: { kind: "user" } } } as never);
  return { id, c, chat, host, pi, repo, dir, files, prompt };
}

test.for(places)("a pi session $place: a client's prompt is pi's turn, its tool calls show, and it works in a jj workspace of its own", async ({ shell }) => {
  const s = await session(shell);
  s.prompt("hello pi");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  const [hello] = s.chat.state.turns;
  expect([hello.state, hello.message.text, said(hello)]).toEqual(["complete", "hello pi", "echo: hello pi"]);

  s.prompt("use a tool");
  await until(() => s.chat.state.turns.length === 2, 30_000);
  const tooled = s.chat.state.turns[1];
  const call = tooled.responseParts.find((p) => p.kind === "toolCall")?.toolCall;
  expect(call).toMatchObject({ toolName: 'bash {"command":"echo tooled"}', status: "completed" });
  expect(said(tooled)).toBe("echo: use a tool");

  const workspaces = run(s.repo, "jj", "workspace", "list");
  expect(workspaces).toContain(`${s.id}:`);
  expect(readFileSync(join(s.files.workspace, "notes.txt"), "utf8")).toBe("a note\n");
  // pi's session is the host's, in that workspace.
  const header = JSON.parse(readFileSync(sessionFile(s.id), "utf8").split("\n")[0]) as { id: string; cwd: string };
  expect([header.id, header.cwd.endsWith(`/workspaces/${s.id}`)]).toEqual([s.id, true]);
});

test.for(places)("the session's _meta says how to open pi's terminal $place (once pi is up), and opening it shows the same pi", async ({ shell }) => {
  const s = await session(shell);
  s.prompt("shown in the terminal");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  const { items } = await s.c.c.request("listSessions", { channel: "ahp-root://" });
  const attach = (items.find((i) => i.resource === `ahp-session:/${s.id}`)?._meta as { pi?: { attach?: string[] } } | undefined)?.pi?.attach;
  const script = `i=0; until [ -S '${s.files.acp}' ] || [ $i -ge 600 ]; do i=$((i+1)); sleep 0.05; done; exec dtach -a '${s.files.tty}' -r winch -z`;
  const expected = shell ? shell(script) : ["sh", "-c", script];
  expect(attach).toEqual(expected);

  // In a terminal of its own, 120 by 40, as a client's pane would be: pi redraws for it.
  const terminal = spawn("python3", ["-c", TERMINAL, ...attach!], { stdio: ["ignore", "pipe", "ignore"] });
  const screen: string[] = [];
  terminal.stdout.setEncoding("utf8").on("data", (d: string) => screen.push(d));
  await until(() => screen.join("").includes("echo: shown in the terminal"), 15_000);
  expect(screen.join("")).toContain(`workspaces/${s.id}`);
  terminal.kill();
});

// As TERMINAL, then the window made narrower (100 by 40) after 4 s, as a client's pane can be.
const RESIZED = TERMINAL.replace("while True:", "import threading, time\nthreading.Timer(4, lambda: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))).start()\nwhile True:");

test("pi's terminal is its regular TUI: an attached client gets no alternate screen it would miss, and a resize draws the transcript again at the new width", async () => {
  const s = await session(undefined);
  s.prompt("shown in the terminal");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  const { items } = await s.c.c.request("listSessions", { channel: "ahp-root://" });
  const attach = (items.find((i) => i.resource === `ahp-session:/${s.id}`)?._meta as { pi?: { attach?: string[] } } | undefined)?.pi?.attach;
  const terminal = spawn("python3", ["-c", RESIZED, ...attach!], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  terminal.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  await until(() => out.includes("echo: shown in the terminal"), 15_000);
  const before = out.length;
  await until(() => out.slice(before).includes("\x1b[3J") && out.slice(out.lastIndexOf("\x1b[3J")).includes("echo: shown in the terminal"), 15_000);
  terminal.kill();
  expect(out.includes("\x1b[?1049h")).toBe(false);
});

test.for(places)("what's typed in pi's own terminal $place is a turn in the chat, and pi keeps running when its terminal goes", async ({ shell }) => {
  const s = await session(shell);
  const other = await client(s.host.url);
  const watching = (await follow(other.c, `ahp-chat:/${s.id}`)) as unknown as Chat;
  const typed = spawn("dtach", ["-p", s.files.tty], { stdio: ["pipe", "ignore", "ignore"] });
  typed.stdin.end("typed in the terminal\r");
  await until(() => s.chat.state.turns.length === 1 && s.chat.state.activeTurn === undefined, 30_000);
  const [turn] = s.chat.state.turns;
  expect([turn.message.text, turn.message.origin.kind, said(turn), turn.state]).toEqual(["typed in the terminal", "user", "echo: typed in the terminal", "complete"]);
  // Every client sees it.
  await until(() => watching.state.turns.length === 1);
  expect(said(watching.state.turns[0])).toBe("echo: typed in the terminal");
  other.ws.close();

  // A client's prompt after it is a turn of its own.
  s.prompt("and from the app");
  await until(() => s.chat.state.turns.length === 2, 30_000);
  expect(said(s.chat.state.turns[1])).toBe("echo: and from the app");
});

test("cancelling stops pi's turn, and steering goes into the turn under way", async () => {
  const s = await session();
  const channel = `ahp-chat:/${s.id}`;
  s.prompt("wait for it");
  await until(() => s.chat.state.activeTurn !== undefined);
  await new Promise((r) => setTimeout(r, 500));
  s.c.c.dispatch(channel, { type: "chat/turnCancelled", turnId: s.chat.state.activeTurn!.id, duration: 0 } as never);
  await until(() => s.chat.state.turns.length === 1, 15_000);
  expect(s.chat.state.turns[0].state).toBe("cancelled");

  await new Promise((r) => setTimeout(r, 500));
  s.prompt("wait again");
  await until(() => s.chat.state.activeTurn !== undefined);
  await new Promise((r) => setTimeout(r, 500));
  s.c.c.dispatch(channel, { type: "chat/pendingMessageSet", kind: "steering", id: "steer-1", message: { text: "and steer here", origin: { kind: "user" } } } as never);
  await until(() => s.chat.state.turns.length === 2, 30_000);
  const steered = s.chat.state.turns[1];
  expect(said(steered)).toContain("echo: and steer here");
  expect(s.chat.seen.some((e) => e.action.type === "chat/pendingMessageRemoved")).toBe(true);
}, 60_000);

test.for(places)("the bridge dropping $place: the host connects again, and nothing is shown twice", async ({ shell }) => {
  const s = await session(shell);
  s.prompt("before the drop");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  const pid = Number(readFileSync(s.files.pid, "utf8"));

  const bridge = run(root, "pgrep", "-f", `nc -U ${s.files.acp}`).trim();
  run(root, "kill", ...bridge.split("\n"));
  await new Promise((r) => setTimeout(r, 2500));
  s.prompt("after the drop");
  await until(() => s.chat.state.turns.length === 2, 30_000);
  const texts = s.chat.state.turns.map((t) => t.message.text);
  expect(texts).toEqual(["before the drop", "after the drop"]);
  expect(said(s.chat.state.turns[1])).toBe("echo: after the drop");
  // The same pi all along.
  expect(Number(readFileSync(s.files.pid, "utf8"))).toBe(pid);
});

test.for(places)("pi itself ending $place: the next connection starts it again on the same session, and nothing is shown twice", async ({ shell }) => {
  const s = await session(shell);
  s.prompt("the first pi");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  const first = Number(readFileSync(s.files.pid, "utf8"));

  process.kill(first);
  await until(() => existsSync(s.files.pid) && Number(readFileSync(s.files.pid, "utf8")) !== first && existsSync(s.files.acp), 30_000);
  await new Promise((r) => setTimeout(r, 1000));
  s.prompt("the second pi");
  await until(() => s.chat.state.turns.length === 2, 30_000);
  expect(s.chat.state.turns.map((t) => t.message.text)).toEqual(["the first pi", "the second pi"]);
  // pi carried on in its session: one file, with both prompts.
  const file = readFileSync(sessionFile(s.id), "utf8");
  expect([file.includes("the first pi"), file.includes("the second pi")]).toEqual([true, true]);
});

test("a host started again shows the transcript at once, and what was typed in pi's terminal while it was gone; with the box gone, the transcript stays", async () => {
  const s = await session();
  s.prompt("said to the first host");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  s.c.ws.close();
  s.host.close();

  // While no host follows it, someone types into pi's terminal.
  const typed = spawn("dtach", ["-p", s.files.tty], { stdio: ["pipe", "ignore", "ignore"] });
  typed.stdin.end("use a tool, with no host\r");
  await until(() => readFileSync(sessionFile(s.id), "utf8").includes("echo: use a tool, with no host"), 30_000);

  const again = await serve({ providers: [s.pi] });
  hosts.push(again.close);
  const later = await client(again.url);
  const chat = (await follow(later.c, `ahp-chat:/${s.id}`)) as unknown as Chat;
  expect(chat.state.turns.map((t) => t.message.text)).toEqual(["said to the first host"]);
  await until(() => chat.state.turns.length === 2, 30_000);
  const texts = chat.state.turns.map((t) => [t.message.text, said(t)]);
  expect(texts).toEqual([
    ["said to the first host", "echo: said to the first host"],
    ["use a tool, with no host", "echo: use a tool, with no host"],
  ]);
  const call = chat.state.turns[1].responseParts.find((p) => p.kind === "toolCall")?.toolCall;
  expect(call).toMatchObject({ toolName: 'bash {"command":"echo tooled"}', status: "completed" });
  later.ws.close();
  again.close();

  // A box that's gone: its chat is the transcript, as it was.
  const gone = piAgent({ dir: s.dir, pi: PI, shell: () => ["false"] });
  const third = await serve({ providers: [gone] });
  hosts.push(third.close);
  const last = await client(third.url);
  const kept = (await follow(last.c, `ahp-chat:/${s.id}`)) as unknown as Chat;
  expect(kept.state.turns.map((t) => t.message.text)).toEqual(["said to the first host", "use a tool, with no host"]);
  last.ws.close();
}, 90_000);

test("after a crash (pi and its dtach killed outright, their files left, the pid since reused), the next host starts pi afresh on its session", async () => {
  const s = await session();
  s.prompt("before the crash");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  s.c.ws.close();
  s.host.close();
  const dtach = run(root, "pgrep", "-f", `dtach -n ${s.files.tty}`).trim();
  const crashed = Number(readFileSync(s.files.pid, "utf8"));
  run(root, "kill", "-9", dtach, String(crashed));
  await until(() => !isRunning(crashed));
  // What a reboot leaves: the sockets' files, and a pid file naming a process that's now something else (this one).
  writeFileSync(s.files.pid, String(process.pid));
  expect([existsSync(s.files.tty), existsSync(s.files.acp)]).toEqual([true, true]);

  const again = await serve({ providers: [s.pi] });
  hosts.push(again.close);
  const later = await client(again.url);
  const chat = (await follow(later.c, `ahp-chat:/${s.id}`)) as unknown as Chat;
  later.c.dispatch(`ahp-chat:/${s.id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: "after the crash", origin: { kind: "user" } } } as never);
  await until(() => chat.state.turns.length === 2, 30_000);
  expect(chat.state.turns.map((t) => [t.message.text, said(t)])).toEqual([
    ["before the crash", "echo: before the crash"],
    ["after the crash", "echo: after the crash"],
  ]);
  const restarted = Number(readFileSync(s.files.pid, "utf8"));
  expect([restarted === process.pid, isRunning(restarted)]).toEqual([false, true]);
  later.ws.close();
}, 60_000);

// The session's summary as the host lists it.
const listed = async (s: { c: { c: { request: (m: "listSessions", p: never) => Promise<{ items: { resource: string; status: number; workingDirectories?: string[]; project?: { uri: string; displayName: string } }[] }> } }; id: string }) =>
  (await s.c.c.request("listSessions", { channel: "ahp-root://" } as never)).items.find((i) => i.resource === `ahp-session:/${s.id}`)!;
const IS_READ = 1 << 5;
const IS_ARCHIVED = 1 << 6;

test.for(places)("$place: the session works in its own workspace (as pi says), and its project is the repo it was given", async ({ shell }) => {
  const s = await session(shell);
  await until(async () => (await listed(s)).workingDirectories?.[0]?.endsWith(`/workspaces/${s.id}`) ?? false);
  const summary = await listed(s);
  expect(summary.workingDirectories).toEqual([pathToFileURL(realpathSync(s.files.workspace)).href]);
  expect(summary.project).toEqual({ uri: pathToFileURL(s.repo).href, displayName: basename(s.repo) });
});

test("workspaces go where `workspaces` says ({project}: the repo the session was given), and deleting one removes it there", async () => {
  const repo = mkdtempSync(join(root, "repo-"));
  run(repo, "jj", "git", "init", "--quiet");
  const pi = piAgent({ dir: mkdtempSync(join(root, "files-")), pi: PI, workspaces: "{project}__workspaces" });
  const host = await serve({ providers: [pi] });
  hosts.push(host.close);
  const c = await client(host.url);
  const id = randomUUID();
  await c.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(repo).href] } as never);
  const workspace = `${repo}__workspaces/${id}`;
  await until(async () => (await listed({ c, id })).workingDirectories?.[0] === pathToFileURL(realpathSync(repo) + `__workspaces/${id}`).href, 30_000);
  expect(existsSync(workspace)).toBe(true);
  await c.c.request("disposeSession", { channel: `ahp-session:/${id}` } as never);
  expect(existsSync(workspace)).toBe(false);
  c.ws.close();
});

test("a jj workspace given as the working directory is used as it is: no workspace inside it", async () => {
  const repo = mkdtempSync(join(root, "repo-"));
  run(repo, "jj", "git", "init", "--quiet");
  const given = `${repo}-mine`;
  run(repo, "jj", "workspace", "add", "--quiet", "--name", "mine", given);
  const dir = mkdtempSync(join(root, "files-"));
  const host = await serve({ providers: [piAgent({ dir, pi: PI })] });
  hosts.push(host.close);
  const c = await client(host.url);
  const id = randomUUID();
  await c.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(given).href] } as never);
  const chat = (await follow(c.c, `ahp-chat:/${id}`)) as unknown as Chat;
  c.c.dispatch(`ahp-chat:/${id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: "in my workspace", origin: { kind: "user" } } } as never);
  await until(() => chat.state.turns.length === 1, 30_000);
  const header = JSON.parse(readFileSync(sessionFile(id), "utf8").split("\n")[0]) as { cwd: string };
  expect([header.cwd, existsSync(join(dir, "workspaces", id))]).toEqual([realpathSync(given), false]);
  expect(run(repo, "jj", "workspace", "list").split("\n").filter(Boolean)).toHaveLength(2);
  c.ws.close();
});

test("a session can start at a revision (_meta.pi.revision): on another session's change, that session first moves to a new change on top of it", async () => {
  const parent = await session();
  writeFileSync(join(parent.files.workspace, "parent.txt"), "the parent's work\n");
  run(parent.files.workspace, "jj", "describe", "--quiet", "-m", "parent");
  const change = run(parent.files.workspace, "jj", "log", "--no-graph", "-r", "@", "-T", "change_id");

  const id = randomUUID();
  await parent.c.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(parent.repo).href], _meta: { pi: { revision: change } } } as never);
  await follow(parent.c.c, `ahp-chat:/${id}`);
  await until(() => existsSync(join(parent.dir, "run", `${id}.sock`)), 30_000);
  const child = join(parent.dir, "workspaces", id);

  expect(readFileSync(join(child, "parent.txt"), "utf8")).toBe("the parent's work\n");
  const childParent = run(child, "jj", "log", "--no-graph", "-r", "@-", "-T", "change_id");
  expect(childParent).toBe(change);
  // The parent works on a new, empty change on top of its own: its snapshots no longer rewrite what the child is on.
  const parentNow = run(parent.files.workspace, "jj", "log", "--no-graph", "-r", "@", "-T", 'change_id ++ " " ++ empty ++ " " ++ parents.map(|p| p.change_id()).join(",")');
  expect(parentNow.split(" ").slice(1)).toEqual(["true", change]);
  expect(readFileSync(join(parent.files.workspace, "parent.txt"), "utf8")).toBe("the parent's work\n");
});

test("archiving (AHP's session/isArchivedChanged) stops pi and keeps the session, its file and workspace; a host started meanwhile leaves it stopped; bringing it back starts pi on the same session", async () => {
  const s = await session();
  s.prompt("before the archive");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  const first = Number(readFileSync(s.files.pid, "utf8"));
  s.c.c.dispatch(`ahp-session:/${s.id}`, { type: "session/isArchivedChanged", isArchived: true } as never);
  await until(() => !isRunning(first), 10_000);
  await until(async () => ((await listed(s)).status & IS_ARCHIVED) !== 0);
  expect([existsSync(s.files.workspace), s.chat.state.turns.length]).toEqual([true, 1]);

  // A host started while it's archived shows its transcript, and doesn't start its pi.
  s.c.ws.close();
  s.host.close();
  const again = await serve({ providers: [s.pi] });
  hosts.push(again.close);
  const later = await client(again.url);
  const chat = (await follow(later.c, `ahp-chat:/${s.id}`)) as unknown as Chat;
  const back = { c: later, id: s.id };
  expect(chat.state.turns.map((t) => t.message.text)).toEqual(["before the archive"]);
  await new Promise((r) => setTimeout(r, 2000));
  expect([existsSync(s.files.tty), ((await listed(back)).status & IS_ARCHIVED) !== 0]).toEqual([false, true]);

  later.c.dispatch(`ahp-session:/${s.id}`, { type: "session/isArchivedChanged", isArchived: false } as never);
  await until(() => existsSync(s.files.acp) && existsSync(s.files.tty), 30_000);
  await until(async () => ((await listed(back)).status & IS_ARCHIVED) === 0);
  later.c.dispatch(`ahp-chat:/${s.id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: "after the archive", origin: { kind: "user" } } } as never);
  await until(() => chat.state.turns.length === 2, 30_000);
  expect(said(chat.state.turns[1])).toBe("echo: after the archive");
  const file = readFileSync(sessionFile(s.id), "utf8");
  expect([file.includes("before the archive"), file.includes("after the archive")]).toEqual([true, true]);
  later.ws.close();
}, 90_000);

test("a prompt to an archived session starts its pi again", async () => {
  const s = await session();
  const first = Number(readFileSync(s.files.pid, "utf8"));
  s.c.c.dispatch(`ahp-session:/${s.id}`, { type: "session/isArchivedChanged", isArchived: true } as never);
  await until(() => !isRunning(first), 10_000);
  s.prompt("wake up");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  expect(said(s.chat.state.turns[0])).toBe("echo: wake up");
});

test("read (AHP's session/isReadChanged) is a flag on the session's status until it changes again", async () => {
  const s = await session();
  s.prompt("read me");
  await until(() => s.chat.state.turns.length === 1, 30_000);
  expect((await listed(s)).status & IS_READ).toBe(0);
  s.c.c.dispatch(`ahp-session:/${s.id}`, { type: "session/isReadChanged", isRead: true } as never);
  await until(async () => ((await listed(s)).status & IS_READ) !== 0);
  s.prompt("now unread");
  await until(() => s.chat.state.turns.length === 2, 30_000);
  await until(async () => ((await listed(s)).status & IS_READ) === 0);
});

test("a directory that is not a jj repo gets no workspaces folder beside it: pi works there as it is", async () => {
  const plain = mkdtempSync(join(root, "plain-"));
  const pi = piAgent({ dir: mkdtempSync(join(root, "files-")), pi: PI, workspaces: "{project}__workspaces" });
  const host = await serve({ providers: [pi] });
  hosts.push(host.close);
  const c = await client(host.url);
  const id = randomUUID();
  await c.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(plain).href] } as never);
  const chat = (await follow(c.c, `ahp-chat:/${id}`)) as unknown as Chat;
  c.c.dispatch(`ahp-chat:/${id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: "hello", origin: { kind: "user" } } } as never);
  await until(() => chat.state.turns.length === 1, 30_000);
  const answer = said(chat.state.turns[0]);
  const workspacesFolderMade = existsSync(`${plain}__workspaces`);
  expect([answer, workspacesFolderMade]).toEqual(["echo: hello", false]);
  c.ws.close();
});

test("outside a jj repo, the session's working directory is said once its pi is up, though it's the one given", async () => {
  // Its real path: pi says that one (the temporary folder's /var is a link).
  const plain = realpathSync(mkdtempSync(join(root, "plain-")));
  const host = await serve({ providers: [piAgent({ dir: mkdtempSync(join(root, "files-")), pi: PI })] });
  hosts.push(host.close);
  const c = await client(host.url);
  const catalogue = await c.c.subscribe("ahp-root://");
  const changes: { session: string; changes: { workingDirectories?: string[] } }[] = [];
  void (async () => {
    for await (const event of catalogue.subscription) {
      const e = event as { type: string; params?: (typeof changes)[number] };
      if (e.type === "sessionSummaryChanged" && e.params) changes.push(e.params);
    }
  })();
  const id = randomUUID();
  await c.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(plain).href] } as never);
  const said = () => changes.find((ch) => ch.session === `ahp-session:/${id}` && ch.changes.workingDirectories);
  await until(() => said() !== undefined, 30_000);
  expect(said()!.changes.workingDirectories).toEqual([pathToFileURL(plain).href]);
  c.ws.close();
});

test("a pi that can't start makes the session's status AHP's error, its reason the activity, as soon as it fails", async () => {
  const repo = mkdtempSync(join(root, "repo-"));
  run(repo, "jj", "git", "init", "--quiet");
  const failing = join(root, "failing-pi");
  writeFileSync(failing, '#!/bin/sh\necho "pi: no model configured" >&2\nexit 1\n', { mode: 0o755 });
  const host = await serve({ providers: [piAgent({ dir: mkdtempSync(join(root, "files-")), pi: [failing] })] });
  hosts.push(host.close);
  const c = await client(host.url);
  const catalogue = await c.c.subscribe("ahp-root://");
  const changes: { session: string; changes: { status?: number; activity?: string } }[] = [];
  void (async () => {
    for await (const event of catalogue.subscription) {
      const e = event as { type: string; params?: (typeof changes)[number] };
      if (e.type === "sessionSummaryChanged" && e.params) changes.push(e.params);
    }
  })();
  const id = randomUUID();
  const asked = Date.now();
  await c.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(repo).href] } as never);
  await until(() => changes.some((ch) => ch.session === `ahp-session:/${id}` && ((ch.changes.status ?? 0) & 2) !== 0), 30_000);
  const failedAfterMs = Date.now() - asked;
  const failure = changes.find((ch) => ch.session === `ahp-session:/${id}` && ((ch.changes.status ?? 0) & 2) !== 0)!;
  expect(failure.changes.activity).toBe("pi exited (1): pi: no model configured");
  // Its pi gives up at once: the session says so in seconds, not after the 30 s the socket is waited for.
  expect(failedAfterMs).toBeLessThan(10_000);
  c.ws.close();
});

test("`extensions` are loaded into every session's pi, beside its own", async () => {
  const extension = join(root, "marks.ts");
  writeFileSync(extension, 'import { writeFileSync } from "node:fs";\nexport default function () {\n  writeFileSync("marked by an extension", "");\n}\n');
  const repo = mkdtempSync(join(root, "repo-"));
  run(repo, "jj", "git", "init", "--quiet");
  const dir = mkdtempSync(join(root, "files-"));
  const host = await serve({ providers: [piAgent({ dir, pi: PI, extensions: [extension] })] });
  hosts.push(host.close);
  const c = await client(host.url);
  const id = randomUUID();
  await c.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(repo).href] } as never);
  const chat = (await follow(c.c, `ahp-chat:/${id}`)) as unknown as Chat;
  c.c.dispatch(`ahp-chat:/${id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: "hello", origin: { kind: "user" } } } as never);
  await until(() => chat.state.turns.length === 1, 30_000);
  const marked = existsSync(join(dir, "workspaces", id, "marked by an extension"));
  expect([said(chat.state.turns[0]), marked]).toEqual(["echo: hello", true]);
  c.ws.close();
});

test("a name pi gives its session (pi.setSessionName) is its title at once, while the turn goes on; a later first message leaves it", async () => {
  const extension = join(root, "names.ts");
  // As a title from a model would: named a moment into the turn (the faux model's "wait" takes 5 s).
  writeFileSync(extension, 'export default function (pi) {\n  pi.on("input", (event) => {\n    if (event.text.includes("name it")) setTimeout(() => pi.setSessionName("Named by pi"), 1000);\n  });\n}\n');
  const repo = mkdtempSync(join(root, "repo-"));
  run(repo, "jj", "git", "init", "--quiet");
  const host = await serve({ providers: [piAgent({ dir: mkdtempSync(join(root, "files-")), pi: PI, extensions: [extension] })] });
  hosts.push(host.close);
  const c = await client(host.url);
  const id = randomUUID();
  await c.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(repo).href] } as never);
  const chat = (await follow(c.c, `ahp-chat:/${id}`)) as unknown as Chat;
  const titled = async () => (await c.c.request("listSessions", { channel: "ahp-root://" })).items.find((s) => s.resource === `ahp-session:/${id}`)?.title;
  // "wait": the faux model takes 5 s, so the name has to come before the turn's end.
  c.c.dispatch(`ahp-chat:/${id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: "name it, then wait", origin: { kind: "user" } } } as never);
  await until(async () => (await titled()) === "Named by pi", 3_500);
  expect(chat.state.turns.length).toBe(0);
  await until(() => chat.state.turns.length === 1, 15_000);
  c.c.dispatch(`ahp-chat:/${id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: "another message", origin: { kind: "user" } } } as never);
  await until(() => chat.state.turns.length === 2, 15_000);
  expect(await titled()).toBe("Named by pi");
  c.ws.close();
}, 40_000);

test("deleting the session ends its pi and forgets its workspace", async () => {
  const s = await session();
  const pid = Number(readFileSync(s.files.pid, "utf8"));
  await s.c.c.request("disposeSession", { channel: `ahp-session:/${s.id}` } as never);
  await until(() => !isRunning(pid), 10_000);
  expect([existsSync(s.files.workspace), existsSync(s.files.tty), existsSync(s.files.pid)]).toEqual([false, false, false]);
  expect(run(s.repo, "jj", "workspace", "list")).not.toContain(s.id);
});

test("the local host bin: a pi session over AHP on its unix socket, its pi running on and its transcript kept across a restart", async () => {
  const dir = mkdtempSync(join(root, "host-"));
  writeFileSync(join(dir, "host.json"), JSON.stringify({ piCommand: PI, providers: [] }));
  const socket = join(dir, "host.sock");
  const start = async () => {
    const bin = spawn(process.execPath, [new URL("../src/bin.ts", import.meta.url).pathname, "--config", join(dir, "host.json"), "--socket", socket, "--db", join(dir, "host.db")], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      bin.stdout.on("data", (d: Buffer) => String(d).includes("listening on") && resolve());
      bin.once("exit", (code) => reject(new Error(`the host exited (${code})`)));
    });
    onTestFinished(() => void bin.kill("SIGTERM"));
    return bin;
  };
  const repo = mkdtempSync(join(root, "repo-"));
  run(repo, "jj", "git", "init", "--quiet");
  const firstBin = await start();
  const first = await client(`ws+unix://${socket}:/ahp`);
  const catalogue = await first.c.subscribe("ahp-root://");
  expect((catalogue.result.snapshot!.state as { agents: { provider: string }[] }).agents.map((a) => a.provider)).toEqual(["pi"]);
  const id = randomUUID();
  await first.c.request("createSession", { channel: `ahp-session:/${id}`, provider: "pi", workingDirectories: [pathToFileURL(repo).href] } as never);
  const chat = (await follow(first.c, `ahp-chat:/${id}`)) as unknown as Chat;
  first.c.dispatch(`ahp-chat:/${id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: "hello host", origin: { kind: "user" } } } as never);
  await until(() => chat.state.turns.length === 1, 30_000);
  const pid = Number(readFileSync(join(dir, "run", `${id}.pid`), "utf8"));
  first.ws.close();
  firstBin.kill("SIGTERM");
  await new Promise((r) => firstBin.once("exit", r));

  // The host is gone, its pi isn't.
  expect(isRunning(pid)).toBe(true);
  await start();
  const second = await client(`ws+unix://${socket}:/ahp`);
  const back = (await follow(second.c, `ahp-chat:/${id}`)) as unknown as Chat;
  expect(back.state.turns.map((t) => [t.message.text, said(t)])).toEqual([["hello host", "echo: hello host"]]);
  second.c.dispatch(`ahp-chat:/${id}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text: "hello again", origin: { kind: "user" } } } as never);
  await until(() => back.state.turns.length === 2, 30_000);
  expect(said(back.state.turns[1])).toBe("echo: hello again");
  expect(Number(readFileSync(join(dir, "run", `${id}.pid`), "utf8"))).toBe(pid);
  second.ws.close();
}, 90_000);

test("a dir too long for pi's socket is said so at once", () => {
  const pi = piAgent({ dir: `/tmp/${"x".repeat(80)}` });
  const session = randomUUID();
  expect(() => pi.connect!(session, "/tmp")).toThrow(`/tmp/${"x".repeat(80)}/run/${session}.sock is too long for a Unix socket`);
});

// pi's session file for a session (`--session-id`: the host's id is pi's).
function sessionFile(id: string) {
  const found = run(agentDir, "find", "sessions", "-name", `*_${id}.jsonl`).trim().split("\n");
  expect(found).toHaveLength(1);
  return join(agentDir, found[0]);
}

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
