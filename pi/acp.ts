// A running pi TUI session as an ACP agent (agentclientprotocol.com), on a Unix socket (newline-delimited JSON-RPC,
// as ACP over stdio), so a host can follow and drive the same session someone is typing into.
//
//   pi -e <pi-durable-ahp>/pi/acp.ts        (the socket: $PI_ACP_SOCKET, else <tmpdir>/pi-acp-<uid>/<session id>.sock)
//
// Any number of clients may connect; each gets:
//
//   session/list        this one session (its id is pi's), _meta.pi.state "working" or "idle"
//   session/load        what the session has said and done, replayed from pi's session file (so across restarts too)
//   session/resume      accepted (every client follows the session)
//   session/prompt      a prompt typed in for the owner: run now, or after the current turn; answered when pi settles
//   _session/steering   a message for the turn under way (pi's steer)
//   session/cancel      stop the current turn (Escape)
//
// and session/update as it goes: user_message_chunk (what was asked, typed or sent), agent_message_chunk and
// agent_thought_chunk (each reply), tool_call / tool_call_update, and session_info_update as it starts and stops
// working. Each message's messageId is its role and timestamp, the same live and replayed.
import * as acp from "@agentclientprotocol/sdk";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";

type Part = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type Message = { role: string; content?: string | Part[]; timestamp?: number; toolCallId?: string; isError?: boolean };

const parts = (m: Message): Part[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content ?? []));
const text = (m: Message) => parts(m).flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("");
const idOf = (m: Message) => `${m.role}-${m.timestamp ?? 0}`;
const title = (name: string, args: unknown) => {
  const shown = JSON.stringify(args ?? {});
  return `${name} ${shown.length > 200 ? `${shown.slice(0, 200)}…` : shown}`;
};

// A message as the updates a client sees: what the user said, or the assistant's thinking, text and tool calls, or a
// tool's result.
function updates(m: Message): acp.SessionUpdate[] {
  const messageId = idOf(m);
  if (m.role === "user") return text(m) ? [{ sessionUpdate: "user_message_chunk", messageId, content: { type: "text", text: text(m) } }] : [];
  if (m.role === "toolResult") return [{ sessionUpdate: "tool_call_update", toolCallId: m.toolCallId!, status: m.isError ? "failed" : "completed" }];
  if (m.role !== "assistant") return [];
  return parts(m).flatMap((p): acp.SessionUpdate[] => {
    if (p.type === "thinking" && p.thinking) return [{ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: p.thinking } }];
    if (p.type === "text" && p.text) return [{ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: p.text } }];
    if (p.type === "toolCall") return [{ sessionUpdate: "tool_call", toolCallId: p.id!, title: title(p.name!, p.arguments), kind: "other", status: "in_progress", rawInput: p.arguments }];
    return [];
  });
}

export default function (pi: ExtensionAPI) {
  let server: Server | undefined;
  let path = "";
  let ctx: ExtensionContext | undefined;
  let sessionId = "";
  let working = false;
  // A client's session/cancel: the turn it stops ends "cancelled" (ACP's rule, whatever pi's last message says).
  let cancelled = false;
  let updatedAt = new Date().toISOString();
  const clients = new Set<acp.AgentContext>();
  // Prompts from clients, each answered when the run its message is in ends (one sent during a turn waits for its own).
  const prompts: { text: string; started: boolean; resolve: (stop: acp.StopReason) => void }[] = [];

  const info = (): acp.SessionInfo => ({
    sessionId,
    cwd: ctx?.cwd ?? process.cwd(),
    title: ctx?.sessionManager.getSessionName() ?? null,
    updatedAt,
    _meta: { pi: { state: working ? "working" : "idle", pid: process.pid } },
  });
  const send = (update: acp.SessionUpdate) => {
    updatedAt = new Date().toISOString();
    for (const client of clients) void client.notify(acp.methods.client.session.update, { sessionId, update }).catch(() => {});
  };
  const state = (now: boolean) => {
    working = now;
    const { title, updatedAt: at, _meta } = info();
    send({ sessionUpdate: "session_info_update", title, updatedAt: at, _meta });
  };
  const ours = (id: string) => {
    if (id !== sessionId) throw acp.RequestError.resourceNotFound(id);
  };

  const agent = acp
    .agent({ name: "pi" })
    .onConnect((connection) => {
      clients.add(connection.client);
      void connection.closed.finally(() => clients.delete(connection.client));
    })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "pi", version: "1" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, promptCapabilities: {}, _meta: { steering: { supported: true } } },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.list, () => ({ sessions: [info()] }))
    .onRequest(acp.methods.agent.session.new, () => {
      throw acp.RequestError.invalidParams(undefined, "this is one pi session; prompt it");
    })
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      ours(params.sessionId);
      const said = (ctx?.sessionManager.getBranch() ?? []).flatMap((e) => (e.type === "message" ? updates(e.message as Message) : []));
      for (const update of said) await client.notify(acp.methods.client.session.update, { sessionId, update });
      return {};
    })
    .onRequest(acp.methods.agent.session.resume, ({ params }) => (ours(params.sessionId), {}))
    .onRequest(acp.methods.agent.session.prompt, async ({ params }) => {
      ours(params.sessionId);
      const message = params.prompt.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim();
      if (!message) throw acp.RequestError.invalidParams(undefined, "a prompt with text, please");
      const done = new Promise<acp.StopReason>((resolve) => prompts.push({ text: message, started: false, resolve }));
      pi.sendUserMessage(message, ctx?.isIdle() === false ? { deliverAs: "followUp" } : undefined);
      return { stopReason: await done };
    })
    .onRequest("_session/steering", (raw) => raw as { sessionId: string; prompt: acp.ContentBlock[] }, ({ params }) => {
      ours(params.sessionId);
      const message = params.prompt.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim();
      if (!working || !message) return { outcome: "not-running" };
      pi.sendUserMessage(message, { deliverAs: "steer" });
      return { outcome: "injected" };
    })
    .onNotification(acp.methods.agent.session.cancel, () => {
      if (!working) return;
      cancelled = true;
      ctx?.abort();
    });

  // What pi does, as session updates: each message as it ends, and each tool call as it starts.
  pi.on("message_end", (event) => {
    const m = event.message as Message;
    for (const u of updates(m)) if (u.sessionUpdate !== "tool_call") send(u);
    const mine = m.role === "user" && prompts.find((p) => !p.started && p.text === text(m).trim());
    if (mine) mine.started = true;
  });
  pi.on("tool_execution_start", (event) => send({ sessionUpdate: "tool_call", toolCallId: event.toolCallId, title: title(event.toolName, event.args), kind: "other", status: "in_progress", rawInput: event.args }));
  pi.on("agent_start", () => state(true));
  // A name pi is given (/name, an extension's pi.setSessionName) is the session's title at once, not at the turn's end.
  pi.on("session_info_changed", () => state(working));
  pi.on("agent_end", (event) => {
    state(false);
    const aborted = cancelled || event.messages.some((m) => "stopReason" in m && m.stopReason === "aborted");
    cancelled = false;
    for (const p of prompts.filter((p) => p.started)) prompts.splice(prompts.indexOf(p), 1), p.resolve(aborted ? "cancelled" : "end_turn");
  });

  pi.on("session_start", (_event, c) => {
    ctx = c;
    sessionId = c.sessionManager.getSessionId();
    if (server) return;
    path = process.env.PI_ACP_SOCKET || join(tmpdir(), `pi-acp-${process.getuid?.() ?? "u"}`, `${sessionId}.sock`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    rmSync(path, { force: true });
    server = createServer((socket) => {
      socket.on("error", () => {});
      agent.connect(acp.ndJsonStream(Writable.toWeb(socket) as WritableStream<Uint8Array>, Readable.toWeb(socket) as ReadableStream<Uint8Array>));
    });
    server.on("error", (err) => console.error(`pi acp socket: ${err.message}`));
    server.listen(path);
  });
  pi.on("session_shutdown", () => {
    server?.close();
    server = undefined;
    if (path) rmSync(path, { force: true });
  });
}
