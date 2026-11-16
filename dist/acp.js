import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { createNodeHttpHandler, createNodeWebSocketUpgradeHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { PROTOCOL_VERSION } from "@microsoft/agent-host-protocol";
import { WebSocketServer } from "ws";
import { ROOT } from "./host.js";
const CHAT = "ahp-chat:/";
const SESSION = "ahp-session:/";
const text = (t) => ({ type: "text", text: t });
const input = (raw) => {
    try {
        return raw === undefined ? undefined : JSON.parse(raw);
    }
    catch {
        return raw;
    }
};
const toolContent = (content) => (content ?? []).map((c) => ({ type: "content", content: text(c.text ?? "") }));
// pi's tools as ACP shows them, after pi-acp (github.com/svkozak/pi-acp, MIT): its kind, the file it touches, and an
// edit's changes as diffs (pi's edit takes { path, edits: [{ oldText, newText }] }, or a single oldText/newText).
const KINDS = { read: "read", write: "edit", edit: "edit", bash: "execute", grep: "search", find: "search", ls: "search" };
const kindOf = (name) => KINDS[name ?? ""] ?? "other";
function shown(name, args, cwd) {
    const a = (args ?? {});
    const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : undefined;
    const absolute = path && (path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`);
    let edits = typeof a.edits === "string" ? input(a.edits) : a.edits;
    if (!Array.isArray(edits))
        edits = [];
    const pairs = [...(typeof a.oldText === "string" && typeof a.newText === "string" ? [{ oldText: a.oldText, newText: a.newText }] : []), ...edits.filter((e) => typeof e?.oldText === "string" && typeof e?.newText === "string")];
    const diffs = absolute && name === "edit"
        ? pairs.map((e) => ({ type: "diff", path: absolute, oldText: e.oldText, newText: e.newText }))
        : absolute && name === "write" && typeof a.content === "string"
            ? [{ type: "diff", path: absolute, oldText: null, newText: a.content }]
            : [];
    return { kind: kindOf(name), ...(absolute && { locations: [{ path: absolute }] }), diffs };
}
// A turn as ACP updates: what was asked, then what was said and done.
function replay(turn, cwd) {
    return [{ sessionUpdate: "user_message_chunk", content: text(turn.message.text), messageId: turn.id }, ...turn.responseParts.flatMap((p) => parted(p, cwd))];
}
function parted(p, cwd) {
    if (p.kind === "markdown" && p.content)
        return [{ sessionUpdate: "agent_message_chunk", content: text(p.content), ...(p.id && { messageId: p.id }) }];
    if (p.kind === "reasoning" && p.content)
        return [{ sessionUpdate: "agent_thought_chunk", content: text(p.content) }];
    if (p.kind === "error")
        return [{ sessionUpdate: "agent_message_chunk", content: text(p.error?.message ?? "error") }];
    if (p.kind === "toolCall" && p.toolCall) {
        const t = p.toolCall;
        const seen = t._meta?.acp;
        const { kind, locations, diffs } = shown(t.toolName, input(t.toolInput), cwd);
        return [
            {
                sessionUpdate: "tool_call",
                toolCallId: t.toolCallId,
                title: t.displayName ?? t.toolName ?? "tool",
                kind: seen?.kind ?? kind,
                ...((seen?.locations ?? locations) && { locations: seen?.locations ?? locations }),
                status: t.success === false ? "failed" : "completed",
                rawInput: input(t.toolInput),
                content: seen?.content ?? [...diffs, ...toolContent(t.content)],
            },
        ];
    }
    return [];
}
// A message as text, whichever way AHP gives it.
const plain = (m) => (typeof m === "string" ? m : (m?.markdown ?? ""));
// AHP's two kinds of answer, as ACP's options, for a tool call that came without the agent's own.
const ANSWERS = [
    { optionId: "approve", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Reject", kind: "reject_once" },
];
export function acpFront(host, opts) {
    const cwd = opts.cwd ?? "/";
    // One agent per ACP connection, holding what that connection follows.
    function createAgent() {
        let client;
        // Each followed session: the turn under way, the turns this connection started and the prompts waiting on them,
        // its queued prompts (until the host makes each a turn), its steering messages, and its tool calls' names.
        // And the tool calls it's asking this connection's client about.
        const followed = new Map();
        const extension = (method, params) => void client?.notify(method, params).catch(() => { });
        const notify = (sessionId, update) => void client?.notify(acp.methods.client.session.update, { sessionId, update }).catch(() => { });
        let seq = 0;
        const clientId = `acp-${randomUUID()}`;
        const ahp = host.local(({ method, params }) => {
            if (method !== "action")
                return;
            const e = params;
            const a = e.action;
            // A session's or one of its chats' new title.
            if (e.channel.startsWith(SESSION)) {
                const session = e.channel.slice(SESSION.length);
                if (a.type === "session/titleChanged" && followed.has(session))
                    notify(session, { sessionUpdate: "session_info_update", title: a.title, updatedAt: new Date().toISOString() });
                const chat = a.type === "session/chatUpdated" && a.chat?.startsWith(CHAT) ? a.chat.slice(CHAT.length) : undefined;
                if (chat && chat !== session && followed.has(chat) && a.changes?.title)
                    notify(chat, { sessionUpdate: "session_info_update", title: a.changes.title, updatedAt: a.changes.modifiedAt ?? new Date().toISOString() });
                return;
            }
            if (!e.channel.startsWith(CHAT))
                return;
            const sessionId = e.channel.slice(CHAT.length);
            const f = followed.get(sessionId);
            if (!f)
                return;
            // An action this connection sent that the host refused (a turn while one runs, say): the prompt fails with why.
            if (e.rejectionReason) {
                if (e.origin?.clientId === clientId && a.type === "chat/turnStarted" && a.turnId)
                    fail(f, a.turnId, e.rejectionReason);
                return;
            }
            if (a.type === "chat/turnStarted") {
                f.turn = a.turnId;
                // A queued prompt of this connection's, now its own turn.
                if (f.next)
                    (f.own.add(a.turnId), f.waiting.set(a.turnId, f.next), (f.next = undefined));
                else if (!f.own.has(a.turnId))
                    notify(sessionId, { sessionUpdate: "user_message_chunk", content: text(a.message?.text ?? ""), messageId: a.turnId });
            }
            else if (a.type === "chat/pendingMessageRemoved" && a.id) {
                const q = f.queued.get(a.id);
                if (q)
                    (f.queued.delete(a.id), (f.next = q));
                f.steers.delete(a.id);
            }
            else if (a.type === "chat/pendingMessageSet" && a.kind === "steering" && !f.steers.has(a.id ?? "")) {
                // Another client's steering message: shown as the user's, since the turn keeps no record of it.
                notify(sessionId, { sessionUpdate: "user_message_chunk", content: text(a.message?.text ?? "") });
            }
            else if (a.type === "chat/responsePart" && a.part)
                for (const u of parted(a.part, cwd))
                    notify(sessionId, u);
            else if (a.type === "chat/delta" && a.content)
                notify(sessionId, { sessionUpdate: "agent_message_chunk", content: text(a.content) });
            else if (a.type === "chat/reasoning" && a.content)
                notify(sessionId, { sessionUpdate: "agent_thought_chunk", content: text(a.content) });
            else if (a.type === "chat/toolCallStart") {
                const seen = a._meta?.acp;
                f.tools.set(a.toolCallId, a.toolName ?? "");
                notify(sessionId, { sessionUpdate: "tool_call", toolCallId: a.toolCallId, title: a.displayName ?? a.toolName ?? "tool", kind: seen?.kind ?? kindOf(a.toolName), status: "pending", ...(seen?.locations && { locations: seen.locations }) });
            }
            else if (a.type === "chat/toolCallReady") {
                const seen = a._meta?.acp;
                const own = shown(f.tools.get(a.toolCallId), input(a.toolInput), cwd);
                const locations = seen?.locations ?? own.locations;
                const content = seen?.content ?? own.diffs;
                // Waiting for a client's yes: this client is asked too.
                if (!a.confirmed)
                    void ask(f, sessionId, a.turnId, a.toolCallId, a);
                else
                    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: a.toolCallId, status: "in_progress", rawInput: input(a.toolInput), ...(locations && { locations }), ...(content.length && { content }) });
            }
            else if (a.type === "chat/toolCallConfirmed") {
                // Answered (here or by another client): this client's question is off.
                f.asks.get(a.toolCallId)?.abort();
                if (a.approved)
                    notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: a.toolCallId, status: "in_progress" });
            }
            else if (a.type === "chat/toolCallComplete") {
                const seen = a._meta?.acp;
                notify(sessionId, { sessionUpdate: "tool_call_update", toolCallId: a.toolCallId, status: a.result?.success === false ? "failed" : "completed", content: seen?.content ?? toolContent(a.result?.content) });
            }
            else if (a.type === "chat/usage" && a.usage?._meta?.acp)
                notify(sessionId, { sessionUpdate: "usage_update", used: a.usage._meta.acp.used, size: a.usage._meta.acp.size });
            else if (a.type === "chat/usage" && a.usage && opts.contextWindow)
                notify(sessionId, { sessionUpdate: "usage_update", used: a.usage.inputTokens + (a.usage.cacheReadTokens ?? 0) + a.usage.outputTokens, size: opts.contextWindow });
            else if (a.type === "chat/turnComplete" && a.turnId)
                finish(f, sessionId, a.turnId, "end_turn");
            else if (a.type === "chat/turnCancelled" && a.turnId)
                finish(f, sessionId, a.turnId, "cancelled");
            else if (a.type === "chat/error" && a.turnId) {
                const why = a.part?.error?.message ?? "the turn failed";
                if (f.waiting.has(a.turnId))
                    fail(f, a.turnId, why);
                else
                    finish(f, sessionId, a.turnId, "end_turn", why);
            }
        });
        const ready = ahp.request("initialize", { clientId, protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: [] });
        const dispatch = (sessionId, action) => ahp.request("dispatchAction", { channel: `${CHAT}${sessionId}`, action, clientSeq: ++seq });
        // A turn ended: the prompt waiting on it answered, or (another client's turn) the end told as an extension.
        function finish(f, sessionId, turnId, stop, error) {
            if (f.turn === turnId)
                f.turn = undefined;
            const mine = f.own.delete(turnId);
            const w = f.waiting.get(turnId);
            f.waiting.delete(turnId);
            if (w)
                w.resolve(stop);
            if (!mine)
                extension("_session/turn_complete", { sessionId, turnId, stopReason: stop, ...(error && { error }) });
        }
        // A turn of this connection's that failed (or was refused): its prompt fails, as ACP has a failed prompt.
        function fail(f, turnId, why) {
            if (f.turn === turnId)
                f.turn = undefined;
            f.own.delete(turnId);
            const w = f.waiting.get(turnId);
            f.waiting.delete(turnId);
            w?.reject(acp.RequestError.internalError(undefined, why));
        }
        // A tool call waiting for a yes, asked of this connection's client; its answer is the session's unless another
        // client's came first (the host refuses a second), and the question is withdrawn once anyone answers.
        async function ask(f, sessionId, turnId, toolCallId, a) {
            if (!client || f.asks.has(toolCallId))
                return;
            const seen = a._meta?.acp;
            const options = seen?.options ?? (a.options ? a.options.map((o) => ({ optionId: o.id, name: o.label, kind: o.kind === "approve" ? "allow_once" : "reject_once" })) : ANSWERS);
            const own = shown(f.tools.get(toolCallId), input(a.toolInput), cwd);
            const abort = new AbortController();
            f.asks.set(toolCallId, abort);
            try {
                const { outcome } = await client.request(acp.methods.client.session.requestPermission, {
                    sessionId,
                    toolCall: { toolCallId, title: plain(a.invocationMessage) || a.toolName || "tool", kind: seen?.kind ?? own.kind, status: "pending", rawInput: input(a.toolInput), ...((seen?.locations ?? own.locations) && { locations: seen?.locations ?? own.locations }), ...((seen?.content ?? own.diffs).length && { content: seen?.content ?? own.diffs }) },
                    options,
                }, { cancellationSignal: abort.signal });
                if (abort.signal.aborted || outcome.outcome !== "selected")
                    return;
                const chosen = options.find((o) => o.optionId === outcome.optionId);
                if (!chosen)
                    return;
                const approved = chosen.kind.startsWith("allow");
                const picked = seen?.options || a.options ? { selectedOptionId: chosen.optionId } : {};
                await dispatch(sessionId, approved ? { type: "chat/toolCallConfirmed", turnId, toolCallId, approved: true, confirmed: "user-action", ...picked } : { type: "chat/toolCallConfirmed", turnId, toolCallId, approved: false, reason: "denied", ...picked });
            }
            catch {
                // The client went, or the question was withdrawn.
            }
            finally {
                f.asks.delete(toolCallId);
            }
        }
        // What a prompt says: its text, and its links (every agent takes resource links) and embedded text as text.
        const said = (prompt) => prompt
            .flatMap((b) => b.type === "text"
            ? [b.text]
            : b.type === "resource_link"
                ? [`[${b.title ?? b.name}](${b.uri})`]
                : b.type === "resource" && "text" in b.resource
                    ? [`${b.resource.uri}:\n${b.resource.text}`]
                    : [])
            .join("\n")
            .trim();
        // A session's chat, followed from now on: its state as it is.
        async function follow(sessionId) {
            await ready;
            const { snapshot } = await ahp.request("subscribe", { channel: `${CHAT}${sessionId}` }).catch(() => {
                throw acp.RequestError.resourceNotFound(sessionId);
            });
            // Its session's too, for titles.
            await ahp.request("subscribe", { channel: `${SESSION}${sessionId.split("/")[0]}` }).catch(() => { });
            if (!followed.has(sessionId))
                followed.set(sessionId, { turn: snapshot?.state.activeTurn?.id, own: new Set(), waiting: new Map(), queued: new Map(), steers: new Set(), tools: new Map(), asks: new Map() });
            return snapshot?.state;
        }
        const sessionsOf = async () => {
            await ready;
            const { items } = await ahp.request("listSessions", { channel: ROOT });
            return items.flatMap((s) => {
                const session = s.resource.slice("ahp-session:/".length);
                const own = { sessionId: session, cwd, title: s.title, updatedAt: s.modifiedAt, ...(s._meta && { _meta: s._meta }) };
                const others = (s.chats ?? []).filter((c) => c.resource !== `${CHAT}${session}`).map((c) => ({ sessionId: c.resource.slice(CHAT.length), cwd, title: c.title, updatedAt: c.modifiedAt, _meta: { ...c._meta, "pi-durable": { parent: session } } }));
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
            // TODO: subagents as ACP's Subagents RFD has them (subagent_update, for clients that ask).
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
                for (const update of replay(turn, cwd))
                    await c.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update });
            return {};
        })
            .onRequest(acp.methods.agent.session.resume, async ({ params, client: c }) => ((client = c), await follow(params.sessionId), {}))
            // Closed for this connection (other clients may still be on it): its prompts there are answered as cancelled.
            .onRequest(acp.methods.agent.session.close, async ({ params }) => {
            const f = followed.get(params.sessionId);
            for (const w of [...(f?.waiting.values() ?? []), ...(f?.queued.values() ?? []), ...(f?.next ? [f.next] : [])])
                w.resolve("cancelled");
            followed.delete(params.sessionId);
            await ahp.request("unsubscribe", { channel: `${CHAT}${params.sessionId}` });
            return {};
        })
            .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
            followed.delete(params.sessionId);
            if (params.sessionId.includes("/"))
                await ahp.request("disposeChat", { channel: `${CHAT}${params.sessionId}` });
            else
                await ahp.request("disposeSession", { channel: `ahp-session:/${params.sessionId}` });
            return {};
        })
            // A turn, answered once it ends. One sent while a turn runs is queued (pending until that turn has answered),
            // then is a turn of its own, answered when that one ends.
            .onRequest(acp.methods.agent.session.prompt, async ({ params, client: c }) => {
            client = c;
            const text = said(params.prompt);
            if (!text)
                throw acp.RequestError.invalidParams(undefined, "a prompt with text, please");
            await follow(params.sessionId);
            const f = followed.get(params.sessionId);
            const message = { text, origin: { kind: "user" } };
            if (f.turn) {
                const id = randomUUID();
                const done = new Promise((resolve, reject) => f.queued.set(id, { resolve, reject }));
                await dispatch(params.sessionId, { type: "chat/pendingMessageSet", kind: "queued", id, message });
                return { stopReason: await done };
            }
            const turnId = randomUUID();
            f.own.add(turnId);
            const done = new Promise((resolve, reject) => f.waiting.set(turnId, { resolve, reject }));
            await dispatch(params.sessionId, { type: "chat/turnStarted", turnId, startedAt: new Date().toISOString(), message });
            return { stopReason: await done };
        })
            // A message for the turn under way, taken in at its next step (claude-agent-acp's and codex-acp's extension).
            .onRequest("_session/steering", (raw) => raw, async ({ params: p, client: c }) => {
            client = c;
            const text = said(p.prompt ?? []);
            await follow(p.sessionId);
            const f = followed.get(p.sessionId);
            if (!f.turn)
                return { outcome: "promptRequired" };
            const id = randomUUID();
            f.steers.add(id);
            await dispatch(p.sessionId, { type: "chat/pendingMessageSet", kind: "steering", id, message: { text, origin: { kind: "user" } } });
            return { outcome: "injected" };
        })
            .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
            const turnId = followed.get(params.sessionId)?.turn;
            if (turnId)
                await dispatch(params.sessionId, { type: "chat/turnCancelled", turnId, duration: 0 });
        })
            // The host's own methods: ACP's _<name> is AHP's x-<name>.
            .onRequest("*", async ({ method, params }) => {
            if (!method.startsWith("_"))
                throw acp.RequestError.methodNotFound(method);
            await ready;
            return ahp.request(`x-${method.slice(1)}`, (params ?? {}));
        });
    }
    const server = new AcpServer({ createAgent });
    const sockets = new WebSocketServer({ noServer: true });
    return {
        // Streamable HTTP, at whatever path it's served on.
        http: createNodeHttpHandler(server),
        // A WebSocket upgrade.
        upgrade: createNodeWebSocketUpgradeHandler(server, sockets),
        // This process's stdin and stdout, for an editor that starts it.
        stdio: () => createAgent().connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))),
    };
}
