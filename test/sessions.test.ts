import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { type ActionEnvelope, chatReducer, PROTOCOL_VERSION, type URI } from "@microsoft/agent-host-protocol";
import { AhpClient, type AhpTransport, type TransportFrame } from "@microsoft/agent-host-protocol/client";
import { expect, test } from "vitest";
import WebSocket from "ws";
import { type Chat, durableAhp, inputFrom } from "../src/index.ts";

// A Harness with a scripted model: "remember X" calls the remember tool, a tool's result is answered "saved",
// anything else is echoed. Driven by Microsoft's own AHP client, over a WebSocket.

const ctx = BACKGROUND_CONTEXT;
const remembered: string[] = [];
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const said = (content: unknown) => (typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((c) => c.text ?? "").join(""));
faux.setResponses(
  Array.from({ length: 200 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
    const last = request.messages.findLast((m) => m.role !== "system")!;
    if (last.role === "toolResult") return fauxAssistantMessage("saved");
    const text = said(last.content);
    const fact = text.match(/^remember (.+)$/)?.[1];
    if (fact) return fauxAssistantMessage(fauxToolCall("remember", { fact }), { stopReason: "toolUse" });
    return fauxAssistantMessage(`echo: ${text}`);
  }),
);
const registry = createRegistry();
registry.install(
  defineExtension({
    name: "memory",
    tools: [
      defineTool({
        name: "remember",
        description: "Remember a fact.",
        parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
        execute: async (args) => (remembered.push(String((args as { fact: string }).fact)), { output: [{ type: "text", text: "remembered" }] }),
      }),
    ],
  }),
);
const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
const model = { provider: "faux", modelId: "faux-1" };

// The app's subagents: each session's, as chats beside it.
const subagents = new Map<string, Chat[]>();

function serve() {
  const ahp = durableAhp({
    harness: () => harness,
    context: ctx,
    info: { name: "test", version: "0" },
    agent: { provider: "test", displayName: "Test" },
    create: (session) => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx).then((c) => (void session, c)),
    meta: (session) => ({ test: { subagents: (subagents.get(session) ?? []).length } }),
    chats: (session) => subagents.get(session) ?? [],
  });
  const server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", ahp.upgrade);
  return new Promise<{ ahp: typeof ahp; url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ ahp, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })),
  );
}

class Socket implements AhpTransport {
  readonly #frames: TransportFrame[] = [];
  readonly #waiting: ((frame: TransportFrame | null) => void)[] = [];
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: WebSocket.RawData) => {
      const frame: TransportFrame = { kind: "text", text: String(data) };
      const w = this.#waiting.shift();
      if (w) w(frame);
      else this.#frames.push(frame);
    });
    ws.on("close", () => this.#waiting.splice(0).forEach((w) => w(null)));
  }
  send(message: unknown) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }
  recv() {
    const frame = this.#frames.shift();
    return frame ? Promise.resolve(frame) : new Promise<TransportFrame | null>((r) => this.#waiting.push(r));
  }
  close() {
    this.ws.close();
  }
}
async function client(url: string, id = `client-${Math.random()}`) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  const c = new AhpClient(new Socket(ws));
  c.connect();
  await c.initialize({ clientId: id, protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: ["ahp-root://"] });
  return { c, ws, id };
}
type Turn = { message: { text: string; origin: { kind: string } }; responseParts: { kind: string; content?: string; toolCall?: { toolName?: string; confirmed?: string } }[]; state: string };
async function follow(c: AhpClient, uri: URI) {
  const { result, subscription } = await c.subscribe(uri);
  const chat = { state: result.snapshot!.state as never as { turns: Turn[] }, seen: [] as ActionEnvelope[] };
  void (async () => {
    for await (const event of subscription) {
      if (event.type !== "action") continue;
      chat.seen.push(event.params);
      chat.state = chatReducer(chat.state as never, event.params.action as never) as never;
    }
  })();
  return chat;
}
const until = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const completed = (chat: { seen: ActionEnvelope[] }, from = 0) => () => chat.seen.slice(from).some((e) => (e.action.type as string) === "chat/turnComplete");

test("a session's turns go to its conversation and come back as the chat's actions; history shows after a restart", async () => {
  const { url, close } = await serve();
  const { c, ws } = await client(url);
  await c.request("createSession", { channel: "ahp-session:/one", _meta: { test: { source: "phone" } } } as never);
  const chat = await follow(c, "ahp-chat:/one");
  c.dispatch("ahp-chat:/one", { type: "chat/turnStarted", turnId: "t1", startedAt: new Date().toISOString(), message: { text: "remember the sky is blue", origin: { kind: "user" } } } as never);
  await until(completed(chat));

  const turn = chat.state.turns.at(-1)!;
  expect(turn.state).toBe("complete");
  expect(turn.responseParts.find((p) => p.kind === "toolCall")?.toolCall?.toolName).toBe("remember");
  expect(turn.responseParts.map((p) => p.content)).toContain("saved");
  expect(remembered).toContain("the sky is blue");
  // Titled by its first message, with what its creator said and what the app adds.
  const { items } = await c.request("listSessions", { channel: "ahp-root://" });
  expect(items.find((s) => s.resource === "ahp-session:/one")).toMatchObject({ title: "remember the sky is blue", _meta: { test: { source: "phone", subagents: 0 } } });
  ws.close();
  close();

  // A host started again over the same Harness shows the conversation so far, tool call and all.
  const again = await serve();
  const later = await client(again.url);
  const history = await follow(later.c, "ahp-chat:/one");
  expect(history.state.turns[0].message.text).toBe("remember the sky is blue");
  expect(history.state.turns[0].responseParts.find((p) => p.kind === "toolCall")?.toolCall).toMatchObject({ toolName: "remember", confirmed: "not-needed" });
  later.ws.close();
  again.close();
});

test("a session's subagents are chats beside it, with their own conversations' turns", async () => {
  const { ahp, url, close } = await serve();
  const { c, ws } = await client(url);
  await c.request("createSession", { channel: "ahp-session:/two" } as never);
  const { result, subscription } = await c.subscribe("ahp-session:/two");
  const session = { chats: (result.snapshot!.state as { chats: { resource: string }[] }).chats.map((x) => x.resource) };
  void (async () => {
    for await (const event of subscription) {
      const a = event.type === "action" ? (event.params.action as { type: string; summary?: { resource: string } }) : undefined;
      if (a?.type === "session/chatAdded") session.chats.push(a.summary!.resource);
    }
  })();

  // The app starts a subagent: a conversation of its own, its task from the agent, and lists it.
  const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
  subagents.set("two", [{ key: "1", title: "the subtask", conversation: child.id, working: true }]);
  await ahp.changed("two");
  await until(() => session.chats.includes("ahp-chat:/two/1"));
  const sub = await follow(c, "ahp-chat:/two/1");
  await (await child.submit({ type: "input", content: "do the subtask", ...inputFrom("agent") }, ctx)).wait(ctx);
  await until(completed(sub));
  expect(sub.state.turns[0].message).toMatchObject({ text: "do the subtask", origin: { kind: "agent" } });
  expect(sub.state.turns[0].responseParts.map((p) => p.content)).toContain("echo: do the subtask");

  // What a client says there goes to the subagent's conversation.
  const before = sub.seen.length;
  c.dispatch("ahp-chat:/two/1", { type: "chat/turnStarted", turnId: "t2", startedAt: new Date().toISOString(), message: { text: "and one more thing", origin: { kind: "user" } } } as never);
  await until(completed(sub, before));
  expect(sub.state.turns.at(-1)!.responseParts.map((p) => p.content)).toContain("echo: and one more thing");

  // Gone from the app's list, gone from the session.
  subagents.set("two", []);
  await ahp.changed("two");
  const { items } = await c.request("listSessions", { channel: "ahp-root://" });
  expect((items.find((s) => s.resource === "ahp-session:/two") as { chats: { resource: string }[] }).chats.map((x) => x.resource)).toEqual(["ahp-chat:/two"]);
  ws.close();
  close();
});

test("a client that drops and comes back gets the actions it missed", async () => {
  const { ahp, url, close } = await serve();
  const first = await client(url, "phone");
  await first.c.request("createSession", { channel: "ahp-session:/three" } as never);
  const chat = await follow(first.c, "ahp-chat:/three");
  first.c.dispatch("ahp-chat:/three", { type: "chat/turnStarted", turnId: "t3", startedAt: new Date().toISOString(), message: { text: "hello", origin: { kind: "user" } } } as never);
  await until(completed(chat));
  const lastSeen = chat.seen.at(-1)!.serverSeq;
  first.ws.close();

  // Said elsewhere while it was away.
  await (await (await ahp.conversation("three")).submit({ type: "input", content: "while you were away", ...inputFrom("systemNotification") }, ctx)).wait(ctx);
  const back = await client(url, "phone");
  const resumed = await back.c.reconnect({ clientId: "phone", lastSeenServerSeq: lastSeen, subscriptions: ["ahp-chat:/three"] });
  expect(resumed.type).toBe("replay");
  const started = (resumed as { actions: ActionEnvelope[] }).actions.find((e) => (e.action.type as string) === "chat/turnStarted")?.action as { message?: { text: string; origin: { kind: string } } };
  expect(started.message).toMatchObject({ text: "while you were away", origin: { kind: "systemNotification" } });
  back.ws.close();
  close();
});
