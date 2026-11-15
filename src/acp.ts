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
// _meta["pi-durable"].parent). Each ACP connection is a client of the AHP host in this process ("a mutex over ACP", as
// AHP's own guide has it), so several can share a session: a prompt is an AHP turn (a subagent's goes where the host
// sends it), one sent while a turn runs is queued as a turn of its own (as Claude Code and Gemini CLI do), steering
// goes through `_session/steering` (the extension claude-agent-acp and codex-acp ship), and cancelling ends the turn.
// A turn another client started ends with `_session/turn_complete`, since a v1 client otherwise learns of a turn's end
// only from its own prompt. Over the SDK's own transports: Streamable HTTP, WebSocket, or stdio.

type Turn = { id: string; message: { text: string }; responseParts: Part[] };
type Part = { kind: string; id?: string; content?: string; error?: { message: string }; toolCall?: { toolCallId: string; toolName?: string; displayName?: string; toolInput?: string; success?: boolean; content?: { text?: string }[] } };
type Update = acp.SessionUpdate;

const CHAT = "ahp-chat:/";
const SESSION = "ahp-session:/";
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
    type Waiter = { resolve: (stop: acp.StopReason) => void; reject: (err: Error) => void };
    // Each followed session: the turn under way, the turns this connection started and the prompts waiting on them,
    // its queued prompts (until the host makes each a turn), its steering messages, and its tool calls' names.
    const followed = new Map<string, { turn?: string; own: Set<string>; waiting: Map<string, Waiter>; queued: Map<string, Waiter>; next?: Waiter; steers: Set<string>; tools: Map<string, string> }>();
    const extension = (method: string, params: object) => void client?.notify(method, params).catch(() => {});
    const notify = (sessionId: string, update: Update) => void client?.notify(acp.methods.client.session.update, { sessionId, update }).catch(() => {});
    let seq = 0;
    const clientId = `acp-${randomUUID()}`;
    const ahp = host.local(({ method, params }) => {
      if (method !== "action") return;
      const e = params as unknown as ActionEnvelope;
      const a = e.action as unknown as { type: string; turnId?: string; kind?: string; id?: string; title?: string; chat?: string; changes?: { title?: string; modifiedAt?: string }; message?: { text: string }; part?: Part; toolCallId?: string; toolName?: string; displayName?: string; toolInput?: string; result?: { success: boolean; content?: { text?: string }[] }; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } };
      // A session's or one of its chats' new title.
      if (e.channel.startsWith(SESSION)) {
        const session = e.channel.slice(SESSION.length);
        if (a.type === "session/titleChanged" && followed.has(session)) notify(session, { sessionUpdate: "session_info_update", title: a.title, updatedAt: new Date().toISOString() });
        const chat = a.type === "session/chatUpdated" && a.chat?.startsWith(CHAT) ? a.chat.slice(CHAT.length) : undefined;
        if (chat && chat !== session && followed.has(chat) && a.changes?.title) notify(chat, { sessionUpdate: "session_info_update", title: a.changes.title, updatedAt: a.changes.modifiedAt ?? new Date().toISOString() });
        return;
      }
      if (!e.channel.startsWith(CHAT)) return;
      const sessionId = e.channel.slice(CHAT.length);
      const f = followed.get(sessionId);
      if (!f) return;
      // An action this connection sent that the host refused (a turn while one runs, say): the prompt fails with why.
      if (e.rejectionReason) {
        if (e.origin?.clientId === clientId && a.turnId) fail(f, a.turnId, e.rejectionReason);
        return;
      }
      if (a.type === "chat/turnStarted") {
        f.turn = a.turnId;
        // A queued prompt of this connection's, now its own turn.
        if (f.next) (f.own.add(a.turnId!), f.waiting.set(a.turnId!, f.next), (f.next = undefined));
        else if (!f.own.has(a.turnId!)) notify(sessionId, { sessionUpdate: "user_message_chunk", content: text(a.message?.text ?? ""), messageId: a.turnId });
      } else if (a.type === "chat/pendingMessageRemoved" && a.id) {
        const q = f.queued.get(a.id);
        if (q) (f.queued.delete(a.id), (f.next = q));
        f.steers.delete(a.id);
      } else if (a.type === "chat/pendingMessageSet" && a.kind === "steering" && !f.steers.has(a.id ?? "")) {
        // Another client's steering message: shown as the user's, since the turn keeps no record of it.
        notify(sessionId, { sessionUpdate: "user_message_chunk", content: text(a.message?.text ?? "") });
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
      else if (a.type === "chat/turnComplete" && a.turnId) finish(f, sessionId, a.turnId, "end_turn");
      else if (a.type === "chat/turnCancelled" && a.turnId) finish(f, sessionId, a.turnId, "cancelled");
      else if (a.type === "chat/error" && a.turnId) {
        const why = (a as { part?: { error?: { message?: string } } }).part?.error?.message ?? "the turn failed";
        if (f.waiting.has(a.turnId)) fail(f, a.turnId, why);
        else finish(f, sessionId, a.turnId, "end_turn", why);
      }
    });
    const ready = ahp.request("initialize", { clientId, protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: [] });
    const dispatch = (sessionId: string, action: object) => ahp.request("dispatchAction", { channel: `${CHAT}${sessionId}`, action, clientSeq: ++seq });

    type Followed = NonNullable<ReturnType<typeof followed.get>>;
    // A turn ended: the prompt waiting on it answered, or (another client's turn) the end told as an extension.
    function finish(f: Followed, sessionId: string, turnId: string, stop: acp.StopReason, error?: string) {
      if (f.turn === turnId) f.turn = undefined;
      const mine = f.own.delete(turnId);
      const w = f.waiting.get(turnId);
      f.waiting.delete(turnId);
      if (w) w.resolve(stop);
      if (!mine) extension("_session/turn_complete", { sessionId, turnId, stopReason: stop, ...(error && { error }) });
    }
    // A turn of this connection's that failed (or was refused): its prompt fails, as ACP has a failed prompt.
    function fail(f: Followed, turnId: string, why: string) {
      if (f.turn === turnId) f.turn = undefined;
      f.own.delete(turnId);
      const w = f.waiting.get(turnId);
      f.waiting.delete(turnId);
      w?.reject(acp.RequestError.internalError(undefined, why));
    }
    // What a prompt says: its text, and its links (every agent takes resource links) and embedded text as text.
    const said = (prompt: acp.ContentBlock[]) =>
      prompt
        .flatMap((b) =>
          b.type === "text"
            ? [b.text]
            : b.type === "resource_link"
              ? [`[${b.title ?? b.name}](${b.uri})`]
              : b.type === "resource" && "text" in b.resource
                ? [`${b.resource.uri}:\n${b.resource.text}`]
                : [],
        )
        .join("\n")
        .trim();
    // A session's chat, followed from now on: its state as it is.
    async function follow(sessionId: string) {
      await ready;
      const { snapshot } = await ahp.request<{ snapshot?: { state: { turns: Turn[]; activeTurn?: Turn } } }>("subscribe", { channel: `${CHAT}${sessionId}` }).catch(() => {
        throw acp.RequestError.resourceNotFound(sessionId);
      });
      // Its session's too, for titles.
      await ahp.request("subscribe", { channel: `${SESSION}${sessionId.split("/")[0]}` }).catch(() => {});
      if (!followed.has(sessionId)) followed.set(sessionId, { turn: snapshot?.state.activeTurn?.id, own: new Set(), waiting: new Map(), queued: new Map(), steers: new Set(), tools: new Map() });
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
        // TODO: permission prompts (session/request_permission, bridged to AHP's tool calls waiting for confirmation;
        // the first answer wins), and subagents as ACP's Subagents RFD has them (subagent_update, for clients that ask).
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
          promptCapabilities: { embeddedContext: true },
          _meta: { steering: { supported: true } },
        },
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
        // The turns so far, and one under way as far as it's got.
        for (const turn of [...(state?.turns ?? []), ...(state?.activeTurn ? [state.activeTurn] : [])])
          for (const update of replay(turn, cwd)) await c.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
        return {};
      })
      .onRequest(acp.methods.agent.session.resume, async ({ params, client: c }) => ((client = c), await follow(params.sessionId), {}))
      // Closed for this connection (other clients may still be on it): its prompts there are answered as cancelled.
      .onRequest(acp.methods.agent.session.close, async ({ params }) => {
        const f = followed.get(params.sessionId);
        for (const w of [...(f?.waiting.values() ?? []), ...(f?.queued.values() ?? []), ...(f?.next ? [f.next] : [])]) w.resolve("cancelled");
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
      // A turn, answered once it ends. One sent while a turn runs is queued (pending until that turn has answered),
      // then is a turn of its own, answered when that one ends.
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client: c }) => {
        client = c;
        const text = said(params.prompt);
        if (!text) throw acp.RequestError.invalidParams(undefined, "a prompt with text, please");
        await follow(params.sessionId);
        const f = followed.get(params.sessionId)!;
        const message = { text, origin: { kind: "user" } };
        if (f.turn) {
          const id = randomUUID();
          const done = new Promise<acp.StopReason>((resolve, reject) => f.queued.set(id, { resolve, reject }));
          await dispatch(params.sessionId, { type: "chat/pendingMessageSet", kind: "queued", id, message });
          return { stopReason: await done };
        }
        const turnId = randomUUID();
        f.own.add(turnId);
        const done = new Promise<acp.StopReason>((resolve, reject) => f.waiting.set(turnId, { resolve, reject }));
        await dispatch(params.sessionId, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message });
        return { stopReason: await done };
      })
      // A message for the turn under way, taken in at its next step (claude-agent-acp's and codex-acp's extension).
      .onRequest("_session/steering", (raw) => raw as { sessionId: string; prompt: acp.ContentBlock[] }, async ({ params: p, client: c }) => {
        client = c;
        const text = said(p.prompt ?? []);
        await follow(p.sessionId);
        const f = followed.get(p.sessionId)!;
        if (!f.turn) return { outcome: "promptRequired" };
        const id = randomUUID();
        f.steers.add(id);
        await dispatch(p.sessionId, { type: "chat/pendingMessageSet", kind: "steering", id, message: { text, origin: { kind: "user" } } });
        return { outcome: "injected" };
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
