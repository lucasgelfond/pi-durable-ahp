import type { ActionEnvelope } from "@microsoft/agent-host-protocol";
import { expect, test } from "vitest";
import { inputFrom } from "../src/index.ts";
import { client, completed, ctx, follow, harness, model, remembered, serve, subagents, until } from "./support.ts";

// AHP: sessions and their chats, driven by Microsoft's own client (support.ts).

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

test("a message while a turn runs steers it: pending until the conversation takes it in, then in its context", async () => {
  const { url, close } = await serve();
  const { c, ws } = await client(url);
  await c.request("createSession", { channel: "ahp-session:/four" } as never);
  const chat = await follow(c, "ahp-chat:/four");
  c.dispatch("ahp-chat:/four", { type: "chat/turnStarted", turnId: "t4", startedAt: new Date().toISOString(), message: { text: "slow down", origin: { kind: "user" } } } as never);
  await until(() => chat.seen.some((e) => (e.action.type as string) === "chat/turnStarted"));
  c.dispatch("ahp-chat:/four", { type: "chat/pendingMessageSet", kind: "steering", id: "steer-1", message: { text: "and mind the step", origin: { kind: "user" } } } as never);
  await until(() => chat.seen.some((e) => (e.action.type as string) === "chat/pendingMessageRemoved" && (e.action as { id?: string }).id === "steer-1"));
  await until(completed(chat));
  // One turn, which answered the steering message too.
  expect(chat.state.turns).toHaveLength(1);
  expect(chat.state.turns[0].responseParts.map((p) => p.content)).toContain("echo: and mind the step");
  ws.close();
  close();
});

test("a message queued while a turn runs waits for it, then is a turn of its own", async () => {
  const { url, close } = await serve();
  const { c, ws } = await client(url);
  await c.request("createSession", { channel: "ahp-session:/five" } as never);
  const chat = await follow(c, "ahp-chat:/five");
  c.dispatch("ahp-chat:/five", { type: "chat/turnStarted", turnId: "t5", startedAt: new Date().toISOString(), message: { text: "slow one", origin: { kind: "user" } } } as never);
  await until(() => chat.seen.some((e) => (e.action.type as string) === "chat/turnStarted"));
  c.dispatch("ahp-chat:/five", { type: "chat/pendingMessageSet", kind: "queued", id: "q-1", message: { text: "after that", origin: { kind: "user" } } } as never);
  await until(() => chat.state.turns.length === 2 && chat.state.turns[1].state === "complete");
  expect(chat.state.turns[1].message.text).toBe("after that");
  expect(chat.state.turns[1].responseParts.map((p) => p.content)).toContain("echo: after that");
  expect(chat.seen.some((e) => (e.action.type as string) === "chat/pendingMessageRemoved" && (e.action as { id?: string }).id === "q-1")).toBe(true);
  ws.close();
  close();
});

test("a conversation from before the catalogue is adopted as a session: listed with its title and _meta, its history in its chat", async () => {
  const { ahp, url, close } = await serve();
  const before = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
  await before.submit({ type: "input", content: "said before the catalogue" }, ctx);
  expect(await ahp.adopt("old", before.id, { title: "From before", created: "2026-11-01T00:00:00.000Z", meta: { test: { source: "phone" } } })).toBe(true);
  expect(await ahp.adopt("old", before.id)).toBe(false);
  const { c, ws } = await client(url);
  const { items } = await c.request("listSessions", { channel: "ahp-root://" });
  expect(items.find((s) => s.resource === "ahp-session:/old")).toMatchObject({ title: "From before", createdAt: "2026-11-01T00:00:00.000Z", _meta: { test: { source: "phone" } } });
  const chat = await follow(c, "ahp-chat:/old");
  await until(() => chat.state.turns.some((t) => t.message.text === "said before the catalogue"));
  ws.close();
  close();
});

