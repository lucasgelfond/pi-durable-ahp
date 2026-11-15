import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable, Writable, type Duplex } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { type ActionEnvelope, PROTOCOL_VERSION } from "@microsoft/agent-host-protocol";
import { WebSocketServer } from "ws";
import { type AhpHost, ROOT } from "./host.ts";

// The Agent Client Protocol (agentclientprotocol.com) over the same sessions as AHP. An ACP session is one of the AHP
// host's chats: a session's own ("<session>"), or one of its other chats ("<session>/<key>", a subagent's, its parent in
// _meta["pi-durable"].parent). Each ACP connection is a client of the AHP host in this process, so a prompt is an AHP
// turn (a subagent's goes where the host sends it), a prompt while a turn runs steers it, and cancelling ends it. Over
// the SDK's own transports: Streamable HTTP, WebSocket, or stdio.

type Turn = { id: string; message: { text: string }; responseParts: Part[] };
type Part = { kind: string; id?: string; content?: string; error?: { message: string }; toolCall?: { toolCallId: string; toolName?: string; displayName?: string; toolInput?: string; success?: boolean; content?: { text?: string }[] } };
type Update = acp.SessionUpdate;

const CHAT = "ahp-chat:/";
const text = (t: string) => ({ type: "text" as const, text: t });
const input = (raw?: string) => {
  try {
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return raw;
  }
};
const toolContent = (content?: { text?: string }[]) => (content ?? []).map((c) => ({ type: "content" as const, content: text(c.text ?? "") }));

// pi's tools as ACP shows them, after pi-acp (github.com/svkozak/pi-acp, MIT): its kind, the file it touches, and an
// edit's changes as diffs (pi's edit takes { path, edits: [{ oldText, newText }] }, or a single oldText/newText).
const KINDS: Record<string, acp.ToolKind> = { read: "read", write: "edit", edit: "edit", bash: "execute", grep: "search", find: "search", ls: "search" };
const kindOf = (name?: string) => KINDS[name ?? ""] ?? "other";
function shown(name: string | undefined, args: unknown, cwd: string) {
  const a = (args ?? {}) as { path?: unknown; file_path?: unknown; oldText?: unknown; newText?: unknown; edits?: unknown; content?: unknown };
  const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : undefined;
  const absolute = path && (path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`);
  let edits = typeof a.edits === "string" ? input(a.edits) : a.edits;
  if (!Array.isArray(edits)) edits = [];
  const pairs = [...(typeof a.oldText === "string" && typeof a.newText === "string" ? [{ oldText: a.oldText, newText: a.newText }] : []), ...(edits as { oldText?: unknown; newText?: unknown }[]).filter((e) => typeof e?.oldText === "string" && typeof e?.newText === "string")] as { oldText: string; newText: string }[];
  const diffs =
    absolute && name === "edit"
      ? pairs.map((e) => ({ type: "diff" as const, path: absolute, oldText: e.oldText, newText: e.newText }))
      : absolute && name === "write" && typeof a.content === "string"
        ? [{ type: "diff" as const, path: absolute, oldText: null, newText: a.content }]
        : [];
  return { kind: kindOf(name), ...(absolute && { locations: [{ path: absolute }] }), diffs };
}

// A turn as ACP updates: what was asked, then what was said and done.
function replay(turn: Turn, cwd: string): Update[] {
  return [{ sessionUpdate: "user_message_chunk", content: text(turn.message.text), messageId: turn.id }, ...turn.responseParts.flatMap((p) => parted(p, cwd))];
}
function parted(p: Part, cwd: string): Update[] {
  if (p.kind === "markdown" && p.content) return [{ sessionUpdate: "agent_message_chunk", content: text(p.content), ...(p.id && { messageId: p.id }) }];
  if (p.kind === "reasoning" && p.content) return [{ sessionUpdate: "agent_thought_chunk", content: text(p.content) }];
  if (p.kind === "error") return [{ sessionUpdate: "agent_message_chunk", content: text(p.error?.message ?? "error") }];
  if (p.kind === "toolCall" && p.toolCall) {
    const t = p.toolCall;
    const { kind, locations, diffs } = shown(t.toolName, input(t.toolInput), cwd);
    return [{ sessionUpdate: "tool_call", toolCallId: t.toolCallId, title: t.displayName ?? t.toolName ?? "tool", kind, ...(locations && { locations }), status: t.success === false ? "failed" : "completed", rawInput: input(t.toolInput), content: [...diffs, ...toolContent(t.content)] }];
  }
  return [];
}

export function acpFront(
  host: AhpHost,
  opts: {
    info: { name: string; version: string };
    // The working directory sessions report (ACP requires one).
    cwd?: string;
    // The model's context window, for usage updates.
    contextWindow?: number;
  },
) {
  const cwd = opts.cwd ?? "/";

  // One agent per ACP connection, holding what that connection follows.
  function createAgent() {
    let client: acp.AgentContext | undefined;
    // Each followed session: the turn under way, the turns this connection started, and the prompts waiting on them.
    const followed = new Map<string, { turn?: string; own: Set<string>; waiting: Map<string, ((stop: acp.StopReason) => void)[]>; tools: Map<string, string> }>();
    const notify = (sessionId: string, update: Update) => void client?.notify(acp.methods.client.session.update, { sessionId, update }).catch(() => {});
    let seq = 0;
    const clientId = `acp-${randomUUID()}`;
    const ahp = host.local(({ method, params }) => {
      if (method !== "action") return;
      const e = params as unknown as ActionEnvelope;
      if (!e.channel.startsWith(CHAT)) return;
      const sessionId = e.channel.slice(CHAT.length);
      const f = followed.get(sessionId);
      if (!f) return;
      const a = e.action as unknown as { type: string; turnId?: string; message?: { text: string }; part?: Part; toolCallId?: string; toolName?: string; displayName?: string; toolInput?: string; result?: { success: boolean; content?: { text?: string }[] }; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } };
      // A turn this connection asked for that the host refused (one already running, say).
      if (e.rejectionReason) {
        if (e.origin?.clientId === clientId && a.turnId) finish(f, a.turnId, "refusal");
        return;
      }
      const ends: Record<string, acp.StopReason> = { "chat/turnComplete": "end_turn", "chat/turnCancelled": "cancelled", "chat/error": "end_turn" };
      if (a.type === "chat/turnStarted") {
        f.turn = a.turnId;
        if (!f.own.has(a.turnId!)) notify(sessionId, { sessionUpdate: "user_message_chunk", content: text(a.message?.text ?? ""), messageId: a.turnId });
      } else if (a.type === "chat/responsePart" && a.part) for (const u of parted(a.part, cwd)) notify(sessionId, u);
      else if (a.type === "chat/toolCallStart") {
        f.tools.set(a.toolCallId!, a.toolName ?? "");
        notify(sessionId, { sessionUpdate: "tool_call", toolCallId: a.toolCallId!, title: a.displayName ?? a.toolName ?? "tool", kind: kindOf(a.toolName), status: "pending" });
      } else if (a.type === "chat/toolCallReady") {
        const { locations, diffs } = shown(f.tools.get(a.toolCallId!), input(a.toolInput), cwd);
        notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: a.toolCallId!, status: "in_progress", rawInput: input(a.toolInput), ...(locations && { locations }), ...(diffs.length && { content: diffs }) });
      }
      else if (a.type === "chat/toolCallComplete")
        notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: a.toolCallId!, status: a.result?.success === false ? "failed" : "completed", content: toolContent(a.result?.content) });
      else if (a.type === "chat/usage" && a.usage && opts.contextWindow)
        notify(sessionId, { sessionUpdate: "usage_update", used: a.usage.inputTokens + (a.usage.cacheReadTokens ?? 0) + a.usage.outputTokens, size: opts.contextWindow });
      else if (a.type in ends && a.turnId) finish(f, a.turnId, ends[a.type]);
    });
    const ready = ahp.request("initialize", { clientId, protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: [] });
    const dispatch = (sessionId: string, action: object) => ahp.request("dispatchAction", { channel: `${CHAT}${sessionId}`, action, clientSeq: ++seq });

    function finish(f: NonNullable<ReturnType<typeof followed.get>>, turnId: string, stop: acp.StopReason) {
      if (f.turn === turnId) f.turn = undefined;
      f.own.delete(turnId);
      // The prompts waiting on it (its own, and any that steered it); a refused one only answers its own.
      for (const [id, resolves] of [...f.waiting]) if (id === turnId || stop !== "refusal") (f.waiting.delete(id), resolves.forEach((resolve) => resolve(stop)));
    }
    // A session's chat, followed from now on: its state as it is.
    async function follow(sessionId: string) {
      await ready;
      const { snapshot } = await ahp.request<{ snapshot?: { state: { turns: Turn[]; activeTurn?: { id: string } } } }>("subscribe", { channel: `${CHAT}${sessionId}` }).catch(() => {
        throw acp.RequestError.resourceNotFound(sessionId);
      });
      if (!followed.has(sessionId)) followed.set(sessionId, { turn: snapshot?.state.activeTurn?.id, own: new Set(), waiting: new Map(), tools: new Map() });
      return snapshot?.state;
    }
    const sessionsOf = async () => {
      await ready;
      const { items } = await ahp.request<{ items: { resource: string; title: string; modifiedAt: string; _meta?: Record<string, unknown>; chats?: { resource: string; title: string; modifiedAt: string; _meta?: Record<string, unknown> }[] }[] }>("listSessions", { channel: ROOT });
      return items.flatMap((s) => {
        const session = s.resource.slice("ahp-session:/".length);
        const own: acp.SessionInfo = { sessionId: session, cwd, title: s.title, updatedAt: s.modifiedAt, ...(s._meta && { _meta: s._meta }) };
        const others = (s.chats ?? []).filter((c) => c.resource !== `${CHAT}${session}`).map((c): acp.SessionInfo => ({ sessionId: c.resource.slice(CHAT.length), cwd, title: c.title, updatedAt: c.modifiedAt, _meta: { ...c._meta, "pi-durable": { parent: session } } }));
        return [own, ...others];
      });
    };

    return acp
      .agent({ name: opts.info.name })
      .onConnect((connection) => {
        client = connection.client;
        void connection.closed.finally(() => ahp.close());
      })
      .onRequest(acp.methods.agent.initialize, () => ({
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: opts.info,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} }, promptCapabilities: {} },
        authMethods: [],
      }))
      .onRequest(acp.methods.agent.session.list, async () => ({ sessions: await sessionsOf() }))
      .onRequest(acp.methods.agent.session.new, async ({ params, client: c }) => {
        client = c;
        const sessionId = randomUUID();
        await ready;
        await ahp.request("createSession", { channel: `ahp-session:/${sessionId}`, ...(params._meta && { _meta: params._meta }) });
        await follow(sessionId);
        return { sessionId };
      })
      // Its history replayed, then followed.
      .onRequest(acp.methods.agent.session.load, async ({ params, client: c }) => {
        client = c;
        const state = await follow(params.sessionId);
        for (const turn of state?.turns ?? []) for (const update of replay(turn, cwd)) await c.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
        return {};
      })
      .onRequest(acp.methods.agent.session.resume, async ({ params, client: c }) => ((client = c), await follow(params.sessionId), {}))
      .onRequest(acp.methods.agent.session.close, async ({ params }) => {
        followed.delete(params.sessionId);
        await ahp.request("unsubscribe", { channel: `${CHAT}${params.sessionId}` });
        return {};
      })
      .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
        followed.delete(params.sessionId);
        if (params.sessionId.includes("/")) await ahp.request("disposeChat", { channel: `${CHAT}${params.sessionId}` });
        else await ahp.request("disposeSession", { channel: `ahp-session:/${params.sessionId}` });
        return {};
      })
      // A turn, answered once it ends; while one runs, the prompt steers it and is answered with it.
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client: c }) => {
        client = c;
        const said = params.prompt.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
        if (!said) throw acp.RequestError.invalidParams(undefined, "a prompt with text, please");
        await follow(params.sessionId);
        const f = followed.get(params.sessionId)!;
        const message = { text: said, origin: { kind: "user" } };
        if (f.turn) {
          const running = f.turn;
          const done = new Promise<acp.StopReason>((resolve) => f.waiting.set(running, [...(f.waiting.get(running) ?? []), resolve]));
          await dispatch(params.sessionId, { type: "chat/pendingMessageSet", kind: "steering", id: randomUUID(), message });
          return { stopReason: await done };
        }
        const turnId = randomUUID();
        f.own.add(turnId);
        const done = new Promise<acp.StopReason>((resolve) => f.waiting.set(turnId, [resolve]));
        await dispatch(params.sessionId, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message });
        return { stopReason: await done };
      })
      .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
        const turnId = followed.get(params.sessionId)?.turn;
        if (turnId) await dispatch(params.sessionId, { type: "chat/turnCancelled", turnId, duration: 0 });
      })
      // The host's own methods: ACP's _<name> is AHP's x-<name>.
      .onRequest("*", async ({ method, params }) => {
        if (!method.startsWith("_")) throw acp.RequestError.methodNotFound(method);
        await ready;
        return ahp.request(`x-${method.slice(1)}`, (params ?? {}) as object);
      });
  }

  const server = new AcpServer({ createAgent });
  const sockets = new WebSocketServer({ noServer: true });
  return {
    // Streamable HTTP, at whatever path it's served on.
    http: createNodeHttpHandler(server) as (req: IncomingMessage, res: ServerResponse) => void,
    // A WebSocket upgrade.
    upgrade: createNodeWebSocketUpgradeHandler(server, sockets) as (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
    // This process's stdin and stdout, for an editor that starts it.
    stdio: () => createAgent().connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>)),
  };
}
