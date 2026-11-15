import { defineDoc } from "@earendil-works/pi-durable";
import { WebSocketServer } from "ws";
import { chatState, DurableChat } from "./chat.js";
import { acpFront } from "./acp.js";
import { AhpHost, ROOT } from "./host.js";
// pi-durable conversations as AHP sessions: ahp-session:/<id>, whose default chat (ahp-chat:/<id>) is the
// conversation, opened when a client first looks. A session's other chats (ahp-chat:/<id>/<key>: its subagents, say)
// are the caller's to list (`chats`), each with its own conversation's turns if it has one. A session is titled by
// the first message in it; its creator's _meta (createSession's) is kept with it.
const SESSION = "ahp-session:/";
const CHAT = "ahp-chat:/";
// AHP's statuses: idle, and working.
const IDLE = 1;
const WORKING = 8;
// Which conversation each session is, its title, when it was made, and its creator's _meta (as JSON).
const Sessions = defineDoc({
    kind: "pi-durable-ahp.sessions",
    version: 1,
    scope: "session",
    initial: () => ({ ids: {}, titles: {}, created: {}, meta: {} }),
    checkpointWhen: () => true,
});
export function durableAhp(opts) {
    const ctx = opts.context;
    const named = opts.named ?? ((id) => id);
    const harness = () => opts.harness();
    const read = async () => ({ ids: {}, titles: {}, created: {}, meta: {}, ...((await harness().snapshot(Sessions, ctx)) ?? {}) });
    const update = (change) => harness().commit(async (tx) => change((await tx.doc(Sessions))), ctx);
    const sessionOf = (uri) => (uri.startsWith(SESSION) ? uri.slice(SESSION.length) : uri.startsWith(CHAT) ? uri.slice(CHAT.length).split("/")[0] : undefined);
    const keyOf = (uri) => (uri.startsWith(CHAT) ? uri.slice(CHAT.length).split("/")[1] : undefined);
    const chatUri = (session, key) => `${CHAT}${session}${key === undefined ? "" : `/${key}`}`;
    const titleOf = (session, doc) => opts.title?.(session) ?? doc.titles[session] ?? "New session";
    const metaOf = (session, doc) => {
        const own = opts.meta?.(session);
        const given = doc.meta[session] ? JSON.parse(doc.meta[session]) : undefined;
        if (!own && !given)
            return undefined;
        // Keyed objects merge one level deep, so a creator's {app: {source}} and the caller's {app: {model}} both stay.
        const merged = { ...given };
        for (const [k, v] of Object.entries(own ?? {}))
            merged[k] = v && typeof v === "object" && !Array.isArray(v) && merged[k] && typeof merged[k] === "object" ? { ...merged[k], ...v } : v;
        return merged;
    };
    const summaryOf = (session, c) => ({
        resource: chatUri(session, c.key),
        title: c.title,
        status: c.working ? WORKING : IDLE,
        modifiedAt: c.modifiedAt ?? new Date().toISOString(),
        origin: { kind: "user" },
        ...(c._meta && { _meta: c._meta }),
    });
    // Each session's conversation, as it's found or made.
    const conversations = new Map();
    function conversation(session) {
        let found = conversations.get(session);
        if (found)
            return found;
        found = (async () => {
            const doc = await read();
            let handle = doc.ids[session] ? await harness().conversation(Number(doc.ids[session]), ctx) : undefined;
            if (!handle) {
                handle = opts.create ? await opts.create(session) : await harness().createConversation({ ownership: { kind: "ownerless" } }, ctx);
                const id = String(handle.id);
                await update((d) => {
                    d.ids[session] = id;
                    d.created[session] = new Date().toISOString();
                });
                void catalogue().then((all) => host.notify(ROOT, "root/sessionAdded", { summary: all.find((s) => s.resource === `${SESSION}${session}`) }), quiet);
            }
            opts.opened?.(session, handle);
            return handle;
        })();
        conversations.set(session, found);
        found.catch(() => conversations.delete(session));
        return found;
    }
    // The catalogue: each session's summary, newest first.
    async function catalogue() {
        const doc = await read();
        const all = Object.keys(doc.ids).map((session) => {
            const own = host.get(chatUri(session));
            const made = doc.created[session] ?? new Date(0).toISOString();
            const meta = metaOf(session, doc);
            return {
                resource: `${SESSION}${session}`,
                provider: opts.agent.provider,
                title: titleOf(session, doc),
                status: own?.status ?? IDLE,
                createdAt: made,
                modifiedAt: own?.modifiedAt ?? made,
                defaultChat: chatUri(session),
                chats: [{ resource: chatUri(session), title: titleOf(session, doc), status: own?.status ?? IDLE, modifiedAt: own?.modifiedAt ?? made, origin: { kind: "user" } }, ...(opts.chats?.(session) ?? []).map((c) => summaryOf(session, c))],
                ...(meta && { _meta: meta }),
            };
        });
        return all.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
    }
    const chats = new Map();
    // Each open session's other chats as last told, by key.
    const shown = new Map();
    const statusChanged = (session, uri) => (status) => {
        const at = new Date().toISOString();
        if (host.has(`${SESSION}${session}`))
            host.dispatch(`${SESSION}${session}`, act({ type: "session/chatUpdated", chat: uri, changes: { status, modifiedAt: at } }));
        if (uri === chatUri(session))
            void catalogue().then(() => host.notify(ROOT, "root/sessionSummaryChanged", { session: `${SESSION}${session}`, changes: { status, modifiedAt: at } }), quiet);
    };
    // A chat's channel: a conversation's turns, or (a chat without one) only what it's called and its _meta.
    async function openChat(session, uri, title, handle, meta) {
        if (chats.has(uri))
            return;
        if (!handle) {
            if (!host.has(uri))
                host.create(uri, chatState(uri, title, meta));
            return;
        }
        const key = keyOf(uri);
        const send = key !== undefined && opts.send ? async (text, turnId) => {
            const refused = await opts.send(session, key, text);
            if (refused)
                chat.refused(turnId, refused);
        } : undefined;
        const chat = new DurableChat({ host, harness: harness(), conversation: handle, uri, ctx, onStatus: statusChanged(session, uri), named, send, input: opts.input, said: opts.said });
        chats.set(uri, chat);
        await chat.open(title, meta);
    }
    const conversationOf = async (c) => (c.conversation === undefined ? undefined : await harness().conversation(c.conversation, ctx));
    async function openSession(session) {
        const uri = `${SESSION}${session}`;
        if (host.has(uri))
            return;
        const handle = await conversation(session);
        const doc = await read();
        const title = titleOf(session, doc);
        const meta = metaOf(session, doc);
        host.create(uri, { provider: opts.agent.provider, title, status: IDLE, lifecycle: "ready", activeClients: [], chats: [], ...(meta && { _meta: meta }) });
        await openChat(session, chatUri(session), title, handle);
        host.dispatch(uri, act({ type: "session/chatAdded", summary: { resource: chatUri(session), title, status: IDLE, modifiedAt: new Date().toISOString(), origin: { kind: "user" } } }));
        host.dispatch(uri, act({ type: "session/defaultChatChanged", defaultChat: chatUri(session) }));
        const others = new Map((opts.chats?.(session) ?? []).map((c) => [c.key, c]));
        shown.set(session, others);
        for (const c of others.values())
            host.dispatch(uri, act({ type: "session/chatAdded", summary: summaryOf(session, c) }));
    }
    // The caller's chats or _meta for a session changed: its open state and the catalogue follow.
    async function changed(session) {
        const uri = `${SESSION}${session}`;
        const doc = await read();
        if (!(session in doc.ids))
            return;
        const meta = metaOf(session, doc);
        if (host.has(uri)) {
            const before = shown.get(session) ?? new Map();
            const now = new Map((opts.chats?.(session) ?? []).map((c) => [c.key, c]));
            for (const [key, c] of now) {
                const was = before.get(key);
                if (!was)
                    host.dispatch(uri, act({ type: "session/chatAdded", summary: summaryOf(session, c) }));
                else if (JSON.stringify(was) !== JSON.stringify(c)) {
                    const { resource, origin, ...changes } = summaryOf(session, c);
                    host.dispatch(uri, act({ type: "session/chatUpdated", chat: resource, changes }));
                }
                // A chat open without its conversation follows it once it has one.
                const open = chatUri(session, key);
                if (c.conversation !== undefined && host.has(open) && !chats.has(open))
                    await openChat(session, open, c.title, await conversationOf(c), c._meta);
            }
            for (const key of before.keys()) {
                if (now.has(key))
                    continue;
                const gone = chatUri(session, key);
                chats.delete(gone);
                host.delete(gone);
                host.dispatch(uri, act({ type: "session/chatRemoved", chat: gone }));
            }
            shown.set(session, now);
            host.dispatch(uri, act({ type: "session/metaChanged", _meta: meta }));
        }
        await catalogue();
        host.notify(ROOT, "root/sessionSummaryChanged", { session: uri, changes: { ...(meta && { _meta: meta }) } });
    }
    const host = new AhpHost({
        listSessions: () => catalogue(),
        async hydrate(uri) {
            const session = sessionOf(uri);
            if (!session || !(session in (await read()).ids))
                return false;
            const key = keyOf(uri);
            if (key === undefined) {
                await openSession(session);
                return host.has(uri);
            }
            const c = opts.chats?.(session).find((each) => each.key === key);
            if (!c)
                return false;
            await openChat(session, uri, c.title, await conversationOf(c), c._meta);
            return host.has(uri);
        },
        async createSession(params) {
            const session = sessionOf(String(params.channel));
            if (!session || keyOf(String(params.channel)) !== undefined)
                throw new Error("a session's channel is ahp-session:/<id>");
            if (params._meta !== undefined)
                await update((d) => void (d.meta[session] = JSON.stringify(params._meta)));
            await conversation(session);
            await openSession(session);
            const all = await catalogue();
            host.notify(ROOT, "root/sessionAdded", { summary: all.find((s) => s.resource === params.channel) });
        },
        async disposeSession(uri) {
            const session = sessionOf(uri);
            if (!session || !(session in (await read()).ids))
                throw new Error(`no session ${uri}`);
            await (await conversation(session)).abort(ctx).catch(() => { });
            await update((d) => {
                delete d.ids[session];
                delete d.titles[session];
                delete d.created[session];
                delete d.meta[session];
            });
            conversations.delete(session);
            for (const open of [...chats.keys()])
                if (sessionOf(open) === session)
                    (chats.delete(open), host.delete(open));
            host.delete(chatUri(session));
            host.delete(uri);
            shown.delete(session);
            await catalogue();
            host.notify(ROOT, "root/sessionRemoved", { session: uri });
        },
        async disposeChat(uri) {
            const session = sessionOf(uri);
            const key = keyOf(uri);
            if (!session || key === undefined)
                throw new Error("a session's own chat goes with the session (disposeSession)");
            if (!opts.dispose)
                throw new Error("this host's chats can't be deleted");
            await opts.dispose(session, key);
        },
        validate(channel, action) {
            if (action.type !== "chat/turnStarted")
                return undefined;
            const chat = chats.get(channel);
            if (chat?.running)
                return "a turn is running: steer it with a pending message, or cancel it first";
            if (!chat && keyOf(channel) !== undefined && !opts.send)
                return "this chat takes no messages";
            return undefined;
        },
        acted(channel, action) {
            const session = sessionOf(channel);
            const key = keyOf(channel);
            const chat = chats.get(channel);
            const a = action;
            if (a.type === "chat/turnStarted") {
                const text = a.message?.text ?? "";
                if (key === undefined)
                    void title(session, channel, text).catch(quiet);
                if (chat)
                    void chat.started(a.turnId, text).catch((err) => chat.refused(a.turnId, err.message));
                // A chat without a conversation (yet): the caller's to pass on.
                else if (key !== undefined)
                    void opts.send?.(session, key, text).catch(quiet);
            }
            // A message for while a turn runs (steering it, or queued for after it).
            if (a.type === "chat/pendingMessageSet") {
                const p = action;
                const text = p.message?.text ?? "";
                if (chat)
                    void chat.pending(p.kind, p.id, text).catch(quiet);
                else if (key !== undefined)
                    void opts.send?.(session, key, text).catch(quiet);
            }
            if (a.type === "chat/turnCancelled") {
                if (key !== undefined && opts.cancel)
                    void opts.cancel(session, key).catch(quiet);
                else
                    void chat?.cancel().catch(quiet);
            }
        },
        methods: opts.methods,
    }, opts.info);
    host.create(ROOT, { agents: [{ models: [], ...opts.agent }] });
    // A session is titled by the first message in it.
    async function title(session, channel, text) {
        const doc = await read();
        if (doc.titles[session] || opts.title?.(session) !== undefined)
            return;
        const t = text.split("\n")[0].slice(0, 80);
        await update((d) => void (d.titles[session] = t));
        host.dispatch(`${SESSION}${session}`, act({ type: "session/titleChanged", title: t }));
        host.dispatch(`${SESSION}${session}`, act({ type: "session/chatUpdated", chat: channel, changes: { title: t } }));
        await catalogue();
        host.notify(ROOT, "root/sessionSummaryChanged", { session: `${SESSION}${session}`, changes: { title: t } });
    }
    const sockets = new WebSocketServer({ noServer: true });
    return {
        host,
        // The Agent Client Protocol over the same sessions (acp.ts).
        acp: (acpOpts = {}) => acpFront(host, { info: opts.info, ...acpOpts }),
        conversation,
        catalogue,
        changed: (session) => changed(session).catch(quiet),
        // The Harness was opened again (after a storage failure): sessions and chats are found afresh when next asked for.
        reset() {
            conversations.clear();
            for (const uri of chats.keys())
                host.delete(uri);
            chats.clear();
            for (const session of shown.keys())
                (host.delete(chatUri(session)), host.delete(`${SESSION}${session}`));
            shown.clear();
        },
        // A client on its WebSocket.
        accept: (ws) => host.accept(ws),
        // An HTTP server's upgrade to AHP (at whatever path it serves it on).
        upgrade: (req, socket, head) => sockets.handleUpgrade(req, socket, head, (ws) => host.accept(ws)),
    };
}
const act = (action) => action;
// Updates for clients that can wait for the next change (the Harness reopening, say).
const quiet = (err) => console.error(`pi-durable-ahp: ${err.message ?? err}`);
