import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { describe, expect, test } from "vitest";
import { inputFrom } from "../src/index.ts";
import { client, ctx, follow, harness, model, serve, subagents, until } from "./support.ts";

// ACP over the same sessions as AHP (support.ts), with the SDK's own client, over Streamable HTTP and WebSocket: each
// ACP connection is one more client of the AHP host underneath, so several can share a session, with each other and
// with AHP clients.

type Updates = acp.SessionNotification[];
// An ACP client for the length of `op`: its session updates as they come.
function connect<T>(port: number, transport: "http" | "ws", op: (c: acp.ClientContext, updates: Updates, init: acp.InitializeResponse) => Promise<T>) {
  const updates: Updates = [];
  const stream = transport === "http" ? createHttpStream(`http://127.0.0.1:${port}/acp`) : createWebSocketStream(`ws://127.0.0.1:${port}/acp`);
  return acp
    .client({ name: "test" })
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
    .connectWith(stream, async (c) => {
      const init = await c.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      return op(c, updates, init);
    });
}
const of = (updates: Updates, sessionId: string, kind?: string) => updates.filter((u) => u.sessionId === sessionId && (!kind || u.update.sessionUpdate === kind)).map((u) => u.update as Record<string, unknown>);
const texts = (updates: Updates, sessionId: string, kind = "agent_message_chunk") => of(updates, sessionId, kind).map((u) => (u.content as { text?: string }).text);

for (const transport of ["http", "ws"] as const) {
  describe(`ACP over ${transport === "http" ? "Streamable HTTP" : "WebSocket"}`, () => {
    test("a prompt is a turn: its tool call with its kind and status, its answer, and why it stopped", async () => {
      const { port, close } = await serve();
      await connect(port, transport, async (c, updates, init) => {
        expect(init.agentCapabilities?.loadSession).toBe(true);
        const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
        const { stopReason } = await c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "remember the sky is blue" }] });
        expect(stopReason).toBe("end_turn");
        await until(() => texts(updates, sessionId).includes("saved"));
        const call = of(updates, sessionId, "tool_call")[0];
        expect(call).toMatchObject({ title: "remember", kind: "other", status: "pending" });
        expect(of(updates, sessionId, "tool_call_update").map((u) => u.status)).toEqual(["in_progress", "completed"]);
        // Its own prompt isn't echoed back to it.
        expect(of(updates, sessionId, "user_message_chunk")).toEqual([]);
      });
      close();
    });

    test("an edit shows as a diff on its file, an edit kind, at its location", async () => {
      const { port, close } = await serve();
      await connect(port, transport, async (c, updates) => {
        const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
        await c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "edit notes.txt" }] });
        expect(of(updates, sessionId, "tool_call")[0]).toMatchObject({ title: "edit", kind: "edit" });
        const ready = of(updates, sessionId, "tool_call_update").find((u) => u.status === "in_progress")!;
        expect(ready.locations).toEqual([{ path: "/work/notes.txt" }]);
        expect(ready.content).toEqual([{ type: "diff", path: "/work/notes.txt", oldText: "old line", newText: "new line" }]);
      });
      close();
    });

    test("cancelling a turn ends it as cancelled", async () => {
      const { port, close } = await serve();
      await connect(port, transport, async (c) => {
        const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
        const prompt = c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "slow and long" }] });
        await new Promise((r) => setTimeout(r, 150));
        await c.notify(acp.methods.agent.session.cancel, { sessionId });
        expect((await prompt).stopReason).toBe("cancelled");
      });
      close();
    });

    test("a prompt while a turn runs is queued: a turn of its own once that one has answered", async () => {
      const { port, url, close } = await serve();
      const watcher = await client(url);
      await connect(port, transport, async (c, updates) => {
        const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
        const watched = await follow(watcher.c, `ahp-chat:/${sessionId}`);
        const first = c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "slow first" }] });
        await new Promise((r) => setTimeout(r, 150));
        const second = c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "and then this" }] });
        expect([(await first).stopReason, (await second).stopReason]).toEqual(["end_turn", "end_turn"]);
        await until(() => texts(updates, sessionId).includes("echo: and then this"));
        // Two turns, the second the queued prompt's.
        await until(() => watched.state.turns.length === 2);
        expect(watched.state.turns.map((t) => t.message.text)).toEqual(["slow first", "and then this"]);
      });
      watcher.ws.close();
      close();
    });

    test("_session/steering puts a message into the turn under way, or asks for a prompt when there's none", async () => {
      const { port, ahp, close } = await serve();
      await connect(port, transport, async (c, updates) => {
        const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
        expect(await c.request("_session/steering", { sessionId, prompt: [{ type: "text", text: "nothing running" }] })).toEqual({ outcome: "promptRequired" });
        const first = c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "slow first" }] });
        await new Promise((r) => setTimeout(r, 150));
        expect(await c.request("_session/steering", { sessionId, prompt: [{ type: "text", text: "and steer here" }] })).toEqual({ outcome: "injected" });
        expect((await first).stopReason).toBe("end_turn");
        await until(() => texts(updates, sessionId).includes("echo: and steer here"));
        const context = await (await ahp.conversation(sessionId)).context(ctx);
        expect(context.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes("and steer here"))).toBe(true);
      });
      close();
    });
  });
}

test("two ACP clients and an AHP client share a session: each sees the others' turns", async () => {
  const { port, url, close } = await serve();
  const ahpClient = await client(url);
  await connect(port, "ws", async (a, fromA) => {
    const { sessionId } = await a.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
    const watched = await follow(ahpClient.c, `ahp-chat:/${sessionId}`);
    await connect(port, "http", async (b, fromB) => {
      await b.request(acp.methods.agent.session.resume, { sessionId, cwd: "/", mcpServers: [] });
      await a.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "hello from A" }] });
      // B sees A's message (as the user's) and the answer.
      await until(() => texts(fromB, sessionId).includes("echo: hello from A"));
      expect(texts(fromB, sessionId, "user_message_chunk")).toEqual(["hello from A"]);
      await b.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "and from B" }] });
      await until(() => texts(fromA, sessionId).includes("echo: and from B"));
      expect(texts(fromA, sessionId, "user_message_chunk")).toEqual(["and from B"]);
    });
    // The AHP client saw both turns.
    await until(() => watched.state.turns.length === 2);
    expect(watched.state.turns.map((t) => t.message.text)).toEqual(["hello from A", "and from B"]);
  });
  ahpClient.ws.close();
  close();
});

test("list shows sessions and their subagents; load replays a session's history; a subagent takes prompts", async () => {
  const { port, ahp, close } = await serve();
  await connect(port, "http", async (c) => {
    const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [], _meta: { test: { source: "zellij" } } });
    await c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "remember the sea is green" }] });
    // A subagent of the session, as an app would start one.
    const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
    subagents.set(sessionId, [{ key: "7", title: "a helper", conversation: child.id }]);
    await ahp.changed(sessionId);
    await (await child.submit({ type: "input", content: "help out", ...inputFrom("agent") }, ctx)).wait(ctx);

    const { sessions } = await c.request(acp.methods.agent.session.list, {});
    const mine = sessions.find((s) => s.sessionId === sessionId)!;
    expect(mine).toMatchObject({ title: "remember the sea is green", cwd: "/work", _meta: { test: { source: "zellij", subagents: 1 } } });
    expect(sessions.find((s) => s.sessionId === `${sessionId}/7`)).toMatchObject({ title: "a helper", _meta: { "pi-durable": { parent: sessionId } } });

    // A new connection loads the session: its history, as updates.
    await connect(port, "ws", async (d, updates) => {
      await d.request(acp.methods.agent.session.load, { sessionId, cwd: "/", mcpServers: [] });
      expect(texts(updates, sessionId, "user_message_chunk")).toEqual(["remember the sea is green"]);
      expect(of(updates, sessionId, "tool_call")[0]).toMatchObject({ title: "remember", status: "completed" });
      expect(texts(updates, sessionId)).toContain("saved");
      // The subagent's chat, loaded and prompted like any session.
      await d.request(acp.methods.agent.session.load, { sessionId: `${sessionId}/7`, cwd: "/", mcpServers: [] });
      expect(texts(updates, `${sessionId}/7`)).toContain("echo: help out");
      const { stopReason } = await d.request(acp.methods.agent.session.prompt, { sessionId: `${sessionId}/7`, prompt: [{ type: "text", text: "one more" }] });
      expect(stopReason).toBe("end_turn");
      await until(() => texts(updates, `${sessionId}/7`).includes("echo: one more"));
    });
  });
  close();
});

test("the host's own methods are ACP extension methods, and deleting a session removes it", async () => {
  const { port, close } = await serve({ methods: { "x-test/ping": async (p) => ({ pong: p }) } });
  await connect(port, "http", async (c) => {
    expect(await c.request("_test/ping", { a: 1 })).toEqual({ pong: { a: 1 } });
    await expect(c.request("_test/nothing", {})).rejects.toThrow();
    const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
    await c.request(acp.methods.agent.session.delete, { sessionId });
    const { sessions } = await c.request(acp.methods.agent.session.list, {});
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(false);
  });
  close();
});

test("over stdio, as an editor starts an agent: a session and a prompt", async () => {
  const { spawn } = await import("node:child_process");
  const { Readable, Writable } = await import("node:stream");
  const agent = spawn(process.execPath, [new URL("./stdio-agent.ts", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
  const updates: Updates = [];
  const stream = acp.ndJsonStream(Writable.toWeb(agent.stdin) as WritableStream<Uint8Array>, Readable.toWeb(agent.stdout) as ReadableStream<Uint8Array>);
  const stop = await acp
    .client({ name: "editor" })
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
    .connectWith(stream, async (c) => {
      await c.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
      const { stopReason } = await c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "over the pipe" }] });
      await until(() => texts(updates, sessionId).includes("echo: over the pipe"));
      return stopReason;
    });
  agent.kill();
  expect(stop).toBe("end_turn");
});

test("another client's turn ends with _session/turn_complete; a resource link is part of a prompt", async () => {
  const { port, close } = await serve();
  await connect(port, "ws", async (a) => {
    const { sessionId } = await a.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
    const ended: unknown[] = [];
    const updates: Updates = [];
    const stream = createWebSocketStream(`ws://127.0.0.1:${port}/acp`);
    await acp
      .client({ name: "watcher" })
      .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
      .onNotification("_session/turn_complete", (p) => p, ({ params }) => void ended.push(params))
      .connectWith(stream, async (b) => {
        await b.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        await b.request(acp.methods.agent.session.resume, { sessionId, cwd: "/", mcpServers: [] });
        await a.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [
            { type: "text", text: "look at" },
            { type: "resource_link", uri: "file:///work/notes.txt", name: "notes.txt" },
          ],
        });
        await until(() => ended.length === 1);
        expect(ended[0]).toMatchObject({ sessionId, stopReason: "end_turn" });
        expect(texts(updates, sessionId, "user_message_chunk")).toEqual(["look at\n[notes.txt](file:///work/notes.txt)"]);
      });
  });
  close();
});

test("a failed turn fails its prompt; closing a session answers its waiting prompts as cancelled", async () => {
  const { port, close } = await serve({ refuse: true });
  await connect(port, "http", async (c) => {
    // A subagent that refuses messages: the prompt fails with why.
    const { sessionId } = await c.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
    const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx);
    subagents.set(sessionId, [{ key: "1", title: "busy elsewhere", conversation: child.id }]);
    await expect(c.request(acp.methods.agent.session.prompt, { sessionId: `${sessionId}/1`, prompt: [{ type: "text", text: "hello" }] })).rejects.toThrow(/not taking messages/);
    // Closing while a prompt waits.
    const waiting = c.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "slow one" }] });
    await new Promise((r) => setTimeout(r, 100));
    await c.request(acp.methods.agent.session.close, { sessionId });
    expect((await waiting).stopReason).toBe("cancelled");
  });
  close();
});

test("loading a session mid-turn shows the turn under way", async () => {
  const { port, close } = await serve();
  await connect(port, "ws", async (a) => {
    const { sessionId } = await a.request(acp.methods.agent.session.new, { cwd: "/", mcpServers: [] });
    const running = a.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text: "slow and steady" }] });
    await new Promise((r) => setTimeout(r, 100));
    await connect(port, "http", async (b, updates) => {
      await b.request(acp.methods.agent.session.load, { sessionId, cwd: "/", mcpServers: [] });
      expect(texts(updates, sessionId, "user_message_chunk")).toEqual(["slow and steady"]);
    });
    await running;
  });
  close();
});
