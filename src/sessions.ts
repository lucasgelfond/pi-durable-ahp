import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "@earendil-works/chord/context";
import { type Conversation, type ConversationId, defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { StateAction, URI } from "@microsoft/agent-host-protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { chatState, DurableChat } from "./chat.ts";
import { AhpHost, ROOT } from "./host.ts";

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
const Sessions = defineDoc<{ ids: Record<string, string>; titles: Record<string, string>; created: Record<string, string>; meta: Record<string, string> }>({
  kind: "pi-durable-ahp.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ ids: {}, titles: {}, created: {}, meta: {} }),
  checkpointWhen: () => true,
});
type SessionsDoc = { ids: Record<string, string>; titles: Record<string, string>; created: Record<string, string>; meta: Record<string, string> };

// A chat of a session besides its own: its key in the session, and its conversation if it has one.
export interface Chat {
  key: string;
  title: string;
  working?: boolean;
  modifiedAt?: string;
  conversation?: ConversationId;
  _meta?: Record<string, unknown>;
}

export interface DurableAhpOptions {
  harness: () => Harness;
  context: Context;
  info: { name: string; version: string };
  // What root's catalogue says of the agent (AHP's AgentInfo).
  agent: { provider: string; displayName: string; description?: string; models?: unknown[] };
  // A new session's conversation; by default an ownerless one with the Harness's default agent.
  create?(session: string): Promise<Conversation>;
  // Each session's conversation once it's known (made or found), e.g. to follow it.
  opened?(session: string, conversation: Conversation): void;
  // A session's own title, for one that keeps it; others are named by their first message ("New session" till then).
  title?(session: string): string | undefined;
  // _meta of the caller's own for a session, over what its creator gave it.
  meta?(session: string): Record<string, unknown> | undefined;
  // A session's other chats (its subagents, say).
  chats?(session: string): Chat[];
  // A client's message in one of those chats: undefined once it's on its way to the chat's conversation, else why
  // not (its turn ends with that). By default it's the conversation's input.
  send?(session: string, key: string, text: string): Promise<string | undefined>;
  // A client stopping a turn in one of those chats (default: the conversation's run is aborted), or deleting it.
  cancel?(session: string, key: string): Promise<void>;
  dispose?(session: string, key: string): Promise<void>;
  // A model's name for clients, from the id a conversation knows it by.
  named?(modelId: string): string;
  // A client's message as a conversation's input (a time stamp added, say), and an input as a chat shows it.
  input?(text: string): string;
  said?(text: string): string;
  // Methods of the caller's own (x-<name>/…).
  methods?: Record<string, (params: Record<string, unknown>, clientId: string) => Promise<unknown>>;
}

export function durableAhp(opts: DurableAhpOptions) {
  const ctx = opts.context;
  const named = opts.named ?? ((id: string) => id);
  const harness = () => opts.harness();
  const read = async (): Promise<SessionsDoc> => ({ ids: {}, titles: {}, created: {}, meta: {}, ...((await harness().snapshot(Sessions, ctx)) ?? {}) });
  const update = (change: (doc: SessionsDoc) => void) => harness().commit(async (tx) => change((await tx.doc(Sessions)) as SessionsDoc), ctx);
  const sessionOf = (uri: string) => (uri.startsWith(SESSION) ? uri.slice(SESSION.length) : uri.startsWith(CHAT) ? uri.slice(CHAT.length).split("/")[0] : undefined);
  const keyOf = (uri: string) => (uri.startsWith(CHAT) ? uri.slice(CHAT.length).split("/")[1] : undefined);
  const chatUri = (session: string, key?: string): URI => `${CHAT}${session}${key === undefined ? "" : `/${key}`}`;
  const titleOf = (session: string, doc: SessionsDoc) => opts.title?.(session) ?? doc.titles[session] ?? "New session";
  const metaOf = (session: string, doc: SessionsDoc) => {
    const own = opts.meta?.(session);
    const given = doc.meta[session] ? (JSON.parse(doc.meta[session]) as Record<string, unknown>) : undefined;
    if (!own && !given) return undefined;
    // Keyed objects merge one level deep, so a creator's {app: {source}} and the caller's {app: {model}} both stay.
    const merged: Record<string, unknown> = { ...given };
    for (const [k, v] of Object.entries(own ?? {}))
      merged[k] = v && typeof v === "object" && !Array.isArray(v) && merged[k] && typeof merged[k] === "object" ? { ...(merged[k] as object), ...v } : v;
    return merged;
  };
  const summaryOf = (session: string, c: Chat) => ({
    resource: chatUri(session, c.key),
    title: c.title,
    status: c.working ? WORKING : IDLE,
    modifiedAt: c.modifiedAt ?? new Date().toISOString(),
    origin: { kind: "user" },
    ...(c._meta && { _meta: c._meta }),
  });

  // Each session's conversation, as it's found or made.
  const conversations = new Map<string, Promise<Conversation>>();
  function conversation(session: string) {
    let found = conversations.get(session);
    if (found) return found;
    found = (async () => {
      const doc = await read();
      let handle = doc.ids[session] ? await harness().conversation(Number(doc.ids[session]) as unknown as ConversationId, ctx) : undefined;
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
      const own = host.get<{ status: number; modifiedAt: string }>(chatUri(session));
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

  const chats = new Map<URI, DurableChat>();
  // Each open session's other chats as last told, by key.
  const shown = new Map<string, Map<string, Chat>>();
  const statusChanged = (session: string, uri: URI) => (status: number) => {
    const at = new Date().toISOString();
    if (host.has(`${SESSION}${session}`)) host.dispatch(`${SESSION}${session}`, act({ type: "session/chatUpdated", chat: uri, changes: { status, modifiedAt: at } }));
    if (uri === chatUri(session)) void catalogue().then(() => host.notify(ROOT, "root/sessionSummaryChanged", { session: `${SESSION}${session}`, changes: { status, modifiedAt: at } }), quiet);
  };

  // A chat's channel: a conversation's turns, or (a chat without one) only what it's called and its _meta.
  async function openChat(session: string, uri: URI, title: string, handle?: Conversation, meta?: Record<string, unknown>) {
    if (chats.has(uri)) return;
    if (!handle) {
      if (!host.has(uri)) host.create(uri, chatState(uri, title, meta));
      return;
    }
    const key = keyOf(uri);
    const send = key !== undefined && opts.send ? async (text: string, turnId: string) => {
      const refused = await opts.send!(session, key, text);
      if (refused) chat.refused(turnId, refused);
    } : undefined;
    const chat = new DurableChat({ host, harness: harness(), conversation: handle, uri, ctx, onStatus: statusChanged(session, uri), named, send, input: opts.input, said: opts.said });
    chats.set(uri, chat);
    await chat.open(title, meta);
  }
  const conversationOf = async (c: Chat) => (c.conversation === undefined ? undefined : await harness().conversation(c.conversation, ctx));

  async function openSession(session: string) {
    const uri = `${SESSION}${session}`;
    if (host.has(uri)) return;
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
    for (const c of others.values()) host.dispatch(uri, act({ type: "session/chatAdded", summary: summaryOf(session, c) }));
  }

  // The caller's chats or _meta for a session changed: its open state and the catalogue follow.
  async function changed(session: string) {
    const uri = `${SESSION}${session}`;
    const doc = await read();
    if (!(session in doc.ids)) return;
    const meta = metaOf(session, doc);
    if (host.has(uri)) {
      const before = shown.get(session) ?? new Map<string, Chat>();
      const now = new Map((opts.chats?.(session) ?? []).map((c) => [c.key, c]));
      for (const [key, c] of now) {
        const was = before.get(key);
        if (!was) host.dispatch(uri, act({ type: "session/chatAdded", summary: summaryOf(session, c) }));
        else if (JSON.stringify(was) !== JSON.stringify(c)) {
          const { resource, origin, ...changes } = summaryOf(session, c);
          host.dispatch(uri, act({ type: "session/chatUpdated", chat: resource, changes }));
        }
        // A chat open without its conversation follows it once it has one.
        const open = chatUri(session, key);
        if (c.conversation !== undefined && host.has(open) && !chats.has(open)) await openChat(session, open, c.title, await conversationOf(c), c._meta);
      }
      for (const key of before.keys()) {
        if (now.has(key)) continue;
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

  const host: AhpHost = new AhpHost(
    {
      listSessions: () => catalogue(),
      async hydrate(uri) {
        const session = sessionOf(uri);
        if (!session || !(session in (await read()).ids)) return false;
        const key = keyOf(uri);
        if (key === undefined) {
          await openSession(session);
          return host.has(uri);
        }
        const c = opts.chats?.(session).find((each) => each.key === key);
        if (!c) return false;
        await openChat(session, uri, c.title, await conversationOf(c), c._meta);
        return host.has(uri);
      },
      async createSession(params) {
        const session = sessionOf(String(params.channel));
        if (!session || keyOf(String(params.channel)) !== undefined) throw new Error("a session's channel is ahp-session:/<id>");
        if (params._meta !== undefined) await update((d) => void (d.meta[session] = JSON.stringify(params._meta)));
        await conversation(session);
        await openSession(session);
        const all = await catalogue();
        host.notify(ROOT, "root/sessionAdded", { summary: all.find((s) => s.resource === params.channel) });
      },
      async disposeSession(uri) {
        const session = sessionOf(uri);
        if (!session || !(session in (await read()).ids)) throw new Error(`no session ${uri}`);
        await (await conversation(session)).abort(ctx).catch(() => {});
        await update((d) => {
          delete d.ids[session];
          delete d.titles[session];
          delete d.created[session];
          delete d.meta[session];
        });
        conversations.delete(session);
        for (const open of [...chats.keys()]) if (sessionOf(open) === session) (chats.delete(open), host.delete(open));
        host.delete(chatUri(session));
        host.delete(uri);
        shown.delete(session);
        await catalogue();
        host.notify(ROOT, "root/sessionRemoved", { session: uri });
      },
      async disposeChat(uri) {
        const session = sessionOf(uri);
        const key = keyOf(uri);
        if (!session || key === undefined) throw new Error("a session's own chat goes with the session (disposeSession)");
        if (!opts.dispose) throw new Error("this host's chats can't be deleted");
        await opts.dispose(session, key);
      },
      validate(channel, action) {
        if ((action.type as string) !== "chat/turnStarted") return undefined;
        const chat = chats.get(channel);
        if (chat?.running) return "a turn is running: steer it with a pending message, or cancel it first";
        if (!chat && keyOf(channel) !== undefined && !opts.send) return "this chat takes no messages";
        return undefined;
      },
      acted(channel, action) {
        const session = sessionOf(channel)!;
        const key = keyOf(channel);
        const chat = chats.get(channel);
        const a = action as unknown as { type: string; turnId: string; message?: { text: string } };
        if (a.type === "chat/turnStarted") {
          const text = a.message?.text ?? "";
          if (key === undefined) void title(session, channel, text).catch(quiet);
          if (chat) void chat.started(a.turnId, text).catch((err) => chat.refused(a.turnId, (err as Error).message));
          // A chat without a conversation (yet): the caller's to pass on.
          else if (key !== undefined) void opts.send?.(session, key, text).catch(quiet);
        }
        if (a.type === "chat/turnCancelled") {
          if (key !== undefined && opts.cancel) void opts.cancel(session, key).catch(quiet);
          else void chat?.cancel().catch(quiet);
        }
      },
      methods: opts.methods,
    },
    opts.info,
  );
  host.create(ROOT, { agents: [{ models: [], ...opts.agent }] });

  // A session is titled by the first message in it.
  async function title(session: string, channel: URI, text: string) {
    const doc = await read();
    if (doc.titles[session] || opts.title?.(session) !== undefined) return;
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
    conversation,
    catalogue,
    changed: (session: string) => changed(session).catch(quiet),
    // A client on its WebSocket.
    accept: (ws: WebSocket) => host.accept(ws),
    // An HTTP server's upgrade to AHP (at whatever path it serves it on).
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => sockets.handleUpgrade(req, socket, head, (ws) => host.accept(ws)),
  };
}

const act = (action: object) => action as StateAction;
// Updates for clients that can wait for the next change (the Harness reopening, say).
const quiet = (err: unknown) => console.error(`pi-durable-ahp: ${(err as Error).message ?? err}`);
