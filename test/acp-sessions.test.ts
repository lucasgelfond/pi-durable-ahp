import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { expect, test } from "vitest";
import { client, follow, scripted, serve, until } from "./support.ts";

// Sessions backed by an ACP agent (the scripted one, acp-agent.ts, a process of its own per session), driven by
// Microsoft's AHP client: a turn streams, an edit is a tool call with its diff, a permission is asked of every client
// and the first answer wins, cancelling and steering reach the agent, a restarted host loads the agent's session again,
// and the local host bin serves it all on a unix socket.

const state = () => join(mkdtempSync(join(tmpdir(), "acp-agent-")), "sessions.json");
// The sessions' working directory.
const work = pathToFileURL(mkdtempSync(join(tmpdir(), "work-"))).href;
type ToolCall = { toolCallId: string; toolName?: string; status?: string; options?: { id: string; kind: string }[]; content?: { text?: string }[]; _meta?: { acp?: { kind?: string; content?: { type: string; path?: string; newText?: string }[] } } };
type Part = { kind: string; content?: string; toolCall?: ToolCall };
type Shown = { turns: { id: string; message: { text: string; origin?: { kind: string } }; responseParts: Part[]; state: string }[]; activeTurn?: { responseParts: Part[] } };
const said = (parts: Part[], kind = "markdown") => parts.filter((p) => p.kind === kind).map((p) => p.content).join("");
const turnOf = (c: { c: AhpClient }, session: string, text: string) =>
  c.c.dispatch(`ahp-chat:/${session}`, { type: "chat/turnStarted", turnId: randomUUID(), startedAt: new Date().toISOString(), message: { text, origin: { kind: "user" } } } as never);
async function agentSession(c: { c: AhpClient }, provider = "scripted") {
  const session = randomUUID();
  await c.c.request("createSession", { channel: `ahp-session:/${session}`, provider, workingDirectories: [work] } as never);
  return session;
}

test("an ACP agent's session: its turn streams, an edit is a tool call with its diff, thinking and a plan show, and it's listed as that agent's", async () => {
  const { url, close } = await serve({ providers: [scripted(state())] });
  const watcher = await client(url);
  const session = await agentSession(watcher);
  const { items } = await watcher.c.request("listSessions", { channel: "ahp-root://" });
  expect(items.find((s) => s.resource === `ahp-session:/${session}`)).toMatchObject({ provider: "scripted", workingDirectories: [work] });
  const chat = (await follow(watcher.c, `ahp-chat:/${session}`)) as unknown as { state: Shown; seen: { action: { type: string; usage?: { _meta?: unknown } } }[] };

  turnOf(watcher, session, "edit notes.txt");
  await until(() => chat.state.turns.length === 1);
  const edit = chat.state.turns[0];
  expect([edit.state, edit.responseParts.find((p) => p.kind === "error")]).toEqual(["complete", undefined]);
  const call = edit.responseParts.find((p) => p.kind === "toolCall")!.toolCall!;
  expect(call).toMatchObject({ toolName: "Edit notes.txt", status: "completed" });
  expect(call._meta?.acp?.kind).toBe("edit");
  expect(call._meta?.acp?.content).toEqual([{ type: "diff", path: "/work/notes.txt", oldText: "old line", newText: "new line" }]);
  expect(said(edit.responseParts)).toBe("edited");
  expect(chat.seen.some((e) => e.action.type === "chat/usage" && JSON.stringify(e.action.usage?._meta).includes("1234"))).toBe(true);

  turnOf(watcher, session, "think hard");
  await until(() => chat.state.turns.length === 2);
  expect(said(chat.state.turns[1].responseParts, "reasoning")).toBe("let me see");
  expect(said(chat.state.turns[1].responseParts)).toBe("thought about hard");
  turnOf(watcher, session, "plan the rest");
  await until(() => chat.state.turns.length === 3);
  expect(said(chat.state.turns[2].responseParts)).toContain("- [x] look\n- [ ] the rest");
  // Titled by the first message, as any session.
  const listed = (await watcher.c.request("listSessions", { channel: "ahp-root://" })).items.find((s) => s.resource === `ahp-session:/${session}`);
  expect(listed?.title).toBe("edit notes.txt");
  watcher.ws.close();
  close();
});

test("an agent's permission request is a tool call waiting for confirmation: the first client's answer is the agent's, a second is refused", async () => {
  const { url, close } = await serve({ providers: [scripted(state())] });
  const a = await client(url);
  const b = await client(url);
  const session = await agentSession(a);
  const chatA = (await follow(a.c, `ahp-chat:/${session}`)) as unknown as { state: Shown };
  const chatB = (await follow(b.c, `ahp-chat:/${session}`)) as unknown as { state: Shown; seen: { action: { type: string }; rejectionReason?: string }[] };
  const waiting = () => chatB.state.activeTurn?.responseParts.find((p) => p.toolCall?.status === "pending-confirmation")?.toolCall;

  turnOf(a, session, "ask notes.txt");
  await until(() => waiting() !== undefined);
  const asked = waiting()!;
  expect(asked.options?.map((o) => [o.id, o.kind])).toEqual([["yes", "approve"], ["always", "approve"], ["no", "deny"]]);
  const turnId = (chatB.state as unknown as { activeTurn: { id: string } }).activeTurn.id;
  a.c.dispatch(`ahp-chat:/${session}`, { type: "chat/toolCallConfirmed", turnId, toolCallId: asked.toolCallId, approved: true, confirmed: "user-action", selectedOptionId: "always" } as never);
  b.c.dispatch(`ahp-chat:/${session}`, { type: "chat/toolCallConfirmed", turnId, toolCallId: asked.toolCallId, approved: false, reason: "denied", selectedOptionId: "no" } as never);
  await until(() => chatA.state.turns.length === 1);
  expect(said(chatA.state.turns[0].responseParts)).toBe("edited, as always");
  expect(chatA.state.turns[0].responseParts.find((p) => p.kind === "toolCall")?.toolCall?.status).toBe("completed");

  // A no: the agent hears it.
  turnOf(a, session, "ask other.txt");
  await until(() => waiting() !== undefined);
  const again = waiting()!;
  const second = (chatB.state as unknown as { activeTurn: { id: string } }).activeTurn.id;
  b.c.dispatch(`ahp-chat:/${session}`, { type: "chat/toolCallConfirmed", turnId: second, toolCallId: again.toolCallId, approved: false, reason: "denied", selectedOptionId: "no" } as never);
  await until(() => chatA.state.turns.length === 2);
  expect(said(chatA.state.turns[1].responseParts)).toBe("not allowed (no)");
  a.ws.close();
  b.ws.close();
  close();
});

test("cancelling reaches the agent; steering goes into the turn under way; a queued message is a turn of its own after it", async () => {
  const { url, close } = await serve({ providers: [scripted(state())] });
  const c = await client(url);
  const session = await agentSession(c);
  const chat = (await follow(c.c, `ahp-chat:/${session}`)) as unknown as { state: Shown; seen: { action: { type: string } }[] };
  const channel = `ahp-chat:/${session}`;
  const active = () => (chat.state as unknown as { activeTurn?: { id: string } }).activeTurn?.id;

  turnOf(c, session, "slow one");
  await until(() => active() !== undefined);
  await new Promise((r) => setTimeout(r, 150));
  c.c.dispatch(channel, { type: "chat/turnCancelled", turnId: active()!, duration: 0 } as never);
  await until(() => chat.state.turns.length === 1);
  expect(chat.state.turns[0].state).toBe("cancelled");

  // The agent is free again once it has stopped.
  await new Promise((r) => setTimeout(r, 300));
  turnOf(c, session, "slow two");
  await until(() => active() !== undefined);
  await new Promise((r) => setTimeout(r, 150));
  c.c.dispatch(channel, { type: "chat/pendingMessageSet", kind: "steering", id: "steer-1", message: { text: "and steer here", origin: { kind: "user" } } } as never);
  c.c.dispatch(channel, { type: "chat/pendingMessageSet", kind: "queued", id: "after-1", message: { text: "then this", origin: { kind: "user" } } } as never);
  await until(() => chat.state.turns.length === 3, 20_000);
  expect(said(chat.state.turns[1].responseParts)).toContain("steered: and steer here");
  expect(chat.state.turns[2].message.text).toBe("then this");
  expect(said(chat.state.turns[2].responseParts)).toBe("echo: then this");
  expect(chat.seen.filter((e) => e.action.type === "chat/pendingMessageRemoved")).toHaveLength(2);
  c.ws.close();
  close();
});

test("a host started again loads the agent's session (session/load), its history in the chat; an agent that can't load starts afresh and says so", async () => {
  const file = state();
  const providers = [scripted(file), scripted(file, { id: "forgetful", noLoad: true })];
  const first = await serve({ providers });
  const c = await client(first.url);
  const session = await agentSession(c);
  const forgetful = await agentSession(c, "forgetful");
  for (const s of [session, forgetful]) {
    const chat = (await follow(c.c, `ahp-chat:/${s}`)) as unknown as { state: Shown };
    turnOf(c, s, `hello ${s.slice(0, 4)}`);
    await until(() => chat.state.turns.length === 1);
  }
  c.ws.close();
  first.close();

  const again = await serve({ providers });
  const later = await client(again.url);
  const chat = (await follow(later.c, `ahp-chat:/${session}`)) as unknown as { state: Shown };
  await until(() => chat.state.turns.length === 1);
  expect(chat.state.turns[0].message.text).toBe(`hello ${session.slice(0, 4)}`);
  expect(said(chat.state.turns[0].responseParts)).toBe(`echo: hello ${session.slice(0, 4)}`);
  // It carries on in the same session of the agent's.
  turnOf(later, session, "and again");
  await until(() => chat.state.turns.length === 2);
  expect(said(chat.state.turns[1].responseParts)).toBe("echo: and again");

  const fresh = (await follow(later.c, `ahp-chat:/${forgetful}`)) as unknown as { state: Shown };
  turnOf(later, forgetful, "still there?");
  await until(() => fresh.state.turns.length === 2);
  expect(fresh.state.turns[0].message).toMatchObject({ origin: { kind: "systemNotification" } });
  expect(fresh.state.turns[0].message.text).toContain("starts afresh");
  later.ws.close();
  again.close();
});

test("the local host bin: an ACP agent's session over AHP on its unix socket, kept across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-"));
  writeFileSync(join(dir, "host.json"), JSON.stringify({ providers: [scripted(join(dir, "agent.json"))] }));
  const socket = join(dir, "host.sock");
  const start = async () => {
    const bin = spawn(process.execPath, [new URL("../src/bin.ts", import.meta.url).pathname, "--config", join(dir, "host.json"), "--socket", socket, "--db", join(dir, "host.db")], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      bin.stdout.on("data", (d: Buffer) => String(d).includes("listening on") && resolve());
      bin.once("exit", (code) => reject(new Error(`the host exited (${code})`)));
    });
    return bin;
  };
  let bin = await start();
  const first = await client(`ws+unix://${socket}:/ahp`);
  const root = await first.c.subscribe("ahp-root://");
  expect((root.result.snapshot!.state as { agents: { provider: string }[] }).agents.map((a) => a.provider)).toEqual(["scripted"]);
  const session = await agentSession(first);
  const chat = (await follow(first.c, `ahp-chat:/${session}`)) as unknown as { state: Shown };
  turnOf(first, session, "edit notes.txt");
  await until(() => chat.state.turns.length === 1);
  expect(said(chat.state.turns[0].responseParts)).toBe("edited");
  first.ws.close();
  bin.kill("SIGTERM");
  await new Promise((r) => bin.once("exit", r));

  bin = await start();
  const second = await client(`ws+unix://${socket}:/ahp`);
  const { items } = await second.c.request("listSessions", { channel: "ahp-root://" });
  expect(items.find((s) => s.resource === `ahp-session:/${session}`)?.title).toBe("edit notes.txt");
  const back = (await follow(second.c, `ahp-chat:/${session}`)) as unknown as { state: Shown };
  await until(() => back.state.turns.length === 1);
  expect(back.state.turns[0].message.text).toBe("edit notes.txt");
  second.ws.close();
  bin.kill("SIGTERM");
  await new Promise((r) => bin.once("exit", r));
}, 60_000);
