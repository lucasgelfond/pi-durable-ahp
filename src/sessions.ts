import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@earendil-works/chord/context";
import { type Conversation, type ConversationId, defineDoc, defineDocFamily, type Harness, type JsonObject } from "@earendil-works/pi-durable";
import type { StateAction, URI } from "@microsoft/agent-host-protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { chatState, DurableChat, type Entry } from "./chat.ts";
import { AcpChat, type AcpProvider, type Shown } from "./acp-chat.ts";
import { AhpHost, ROOT } from "./host.ts";

// pi-durable conversations as AHP sessions: ahp-session:/<id>, whose default chat (ahp-chat:/<id>) is the
// conversation, opened when a client first looks. A session's other chats (ahp-chat:/<id>/<key>: its subagents, say)
// are the caller's to list (`chats`), each with its own conversation's turns if it has one. A session is titled by
// the first message in it; its creator's _meta (createSession's) is kept with it. A session may instead be an ACP
// agent's (createSession's `provider`, one of `providers`): its chat is that agent's session (acp-chat.ts), in the
// session's working directory, and the catalogue keeps which agent and its session id.

const SESSION = "ahp-session:/";
const CHAT = "ahp-chat:/";
// AHP's statuses: idle, and working.
const IDLE = 1;
const WORKING = 8;
// AHP's flags on a session's status, beside its activity.
const IS_READ = 1 << 5;
const IS_ARCHIVED = 1 << 6;

// Which conversation each session is ("" for an ACP agent's), its title, when it was made, and its creator's _meta (as
// JSON); and for an ACP agent's session, which agent (`providers`), its session id there (`acp`), and its working
// directory (`dirs`, any session's that was given one; `work`, where its agent says it works, a workspace of its own
// say). Archived sessions (`archived`), and when a client last read each (`read`).
type SessionsDoc = {
  ids: Record<string, string>;
  titles: Record<string, string>;
  created: Record<string, string>;
  meta: Record<string, string>;
  providers: Record<string, string>;
  acp: Record<string, string>;
  dirs: Record<string, string>;
  work: Record<string, string>;
  archived: Record<string, string>;
  read: Record<string, string>;
};
const empty = (): SessionsDoc => ({ ids: {}, titles: {}, created: {}, meta: {}, providers: {}, acp: {}, dirs: {}, work: {}, archived: {}, read: {} });
const Sessions = defineDoc<SessionsDoc>({
  kind: "pi-durable-ahp.sessions",
  version: 1,
  scope: "session",
  initial: empty,
  checkpointWhen: () => true,
});
// An ACP agent's session's transcript: each finished turn as clients saw it, there when the agent isn't (a box asleep or
// gone), and the ids of the agent's messages in them, so what it replays isn't shown twice.
const Transcripts = defineDocFamily<{ turns: JsonObject[]; ids: string[] }, null>({
  kind: "pi-durable-ahp.transcript",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ turns: [], ids: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

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
  // What root's catalogue says of the agent (AHP's AgentInfo); without one, every session is one of `providers`'.
  agent?: { provider: string; displayName: string; description?: string; models?: unknown[] };
  // ACP agents a session can be instead (createSession's `provider`), each a process of its own per session.
  providers?: AcpProvider[];
  // A new session's conversation, in the working directory it was given if any; by default an ownerless one with the
  // Harness's default agent.
  create?(session: string, given: { workingDirectory?: string }): Promise<Conversation>;
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
  // Each conversation's entries as they're committed (not those it had when it was opened; `key`: one of a session's
  // other chats', undefined for the session's own), from the watch its chat runs anyway. With it, a session's chat is
  // opened as soon as its conversation is known, not only once a client looks, so none of its entries go unseen.
  committed?(session: string, entries: readonly Entry[], key?: string): void;
  // TODO: hooks for the caller's crons as AHP automations and its skills as AHP customizations (it keeps the stores).
  // TODO: subagent chats whose origin is the tool call that started them ({kind: "tool", chat, toolCallId}).
}

export function durableAhp(opts: DurableAhpOptions) {
  const ctx = opts.context;
  const named = opts.named ?? ((id: string) => id);
  const harness = () => opts.harness();
  const read = async (): Promise<SessionsDoc> => ({ ...empty(), ...((await harness().snapshot(Sessions, ctx)) ?? {}) });
  // A catalogue kept before it had a field gets it.
  const update = (change: (doc: SessionsDoc) => void) =>
    harness().commit(async (tx) => {
      const d = (await tx.doc(Sessions)) as SessionsDoc;
      for (const [k, v] of Object.entries(empty())) (d as Record<string, unknown>)[k] ??= v;
      change(d);
    }, ctx);
  // An ACP agent's session's agent; undefined for a pi-durable conversation's.
  const providerOf = (session: string, doc: SessionsDoc) => (doc.providers[session] ? opts.providers?.find((p) => p.id === doc.providers[session]) : undefined);
  const providerName = (session: string, doc: SessionsDoc) => doc.providers[session] ?? opts.agent?.provider ?? "";
  // Where a session works, and (when that's somewhere of its own) the project it was given.
  const dirsOf = (session: string, doc: SessionsDoc) => {
    const given = doc.dirs[session];
    const work = doc.work[session] ?? given;
    return {
      ...(work && { workingDirectories: [pathToFileURL(work).href] }),
      ...(given && work !== given && { project: { uri: pathToFileURL(given).href, displayName: basename(given) } }),
    };
  };
  // A session's status flags: archived, and read since it last changed.
  const flagsOf = (session: string, doc: SessionsDoc, modifiedAt: string) =>
    (doc.archived[session] ? IS_ARCHIVED : 0) | (doc.read[session] && doc.read[session] >= modifiedAt ? IS_READ : 0);
  const sessionOf = (uri: string) => (uri.startsWith(SESSION) ? uri.slice(SESSION.length) : uri.startsWith(CHAT) ? uri.slice(CHAT.length).split("/")[0] : undefined);
  const keyOf = (uri: string) => (uri.startsWith(CHAT) ? uri.slice(CHAT.length).split("/")[1] : undefined);
  const chatUri = (session: string, key?: string): URI => `${CHAT}${session}${key === undefined ? "" : `/${key}`}`;
  const titleOf = (session: string, doc: SessionsDoc) => opts.title?.(session) ?? doc.titles[session] ?? "New session";
  const metaOf = (session: string, doc: SessionsDoc) => {
    const agent = providerOf(session, doc)?.meta?.(session);
    const own = agent || opts.meta ? { ...agent, ...opts.meta?.(session) } : undefined;
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
      if (providerOf(session, doc)) throw new Error(`${session} is ${doc.providers[session]}'s session, not a conversation of this host's`);
      let handle = doc.ids[session] ? await harness().conversation(Number(doc.ids[session]) as unknown as ConversationId, ctx) : undefined;
      if (!handle) {
        const cwd = doc.dirs[session];
        handle = opts.create
          ? await opts.create(session, { ...(cwd && { workingDirectory: cwd }) })
          : await harness().createConversation({ ownership: { kind: "ownerless" }, ...(cwd && { agent: { cwd } }) }, ctx);
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
    // Its chat (and so its watch) open from now on, for `committed`.
    if (opts.committed) void found.then(() => openSession(session)).catch(quiet);
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
        provider: providerName(session, doc),
        ...dirsOf(session, doc),
        title: titleOf(session, doc),
        status: (own?.status ?? IDLE) | flagsOf(session, doc, own?.modifiedAt ?? made),
        createdAt: made,
        modifiedAt: own?.modifiedAt ?? made,
        defaultChat: chatUri(session),
        chats: [{ resource: chatUri(session), title: titleOf(session, doc), status: own?.status ?? IDLE, modifiedAt: own?.modifiedAt ?? made, origin: { kind: "user" } }, ...(opts.chats?.(session) ?? []).map((c) => summaryOf(session, c))],
        ...(meta && { _meta: meta }),
      };
    });
    return all.sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)));
  }

  const chats = new Map<URI, DurableChat | AcpChat>();
  // Each open session's other chats as last told, by key.
  const shown = new Map<string, Map<string, Chat>>();
  const statusChanged = (session: string, uri: URI) => (status: number) => {
    const at = new Date().toISOString();
    if (host.has(`${SESSION}${session}`)) host.dispatch(`${SESSION}${session}`, act({ type: "session/chatUpdated", chat: uri, changes: { status, modifiedAt: at } }));
    if (uri === chatUri(session)) void summaryChanged(session, { status, modifiedAt: at }).catch(quiet);
  };
  // A session's summary changed, to every client: CHANGES, its status (an activity, or as it was) with its flags.
  async function summaryChanged(session: string, changes: { status?: number; modifiedAt?: string; workingDirectories?: string[] } = {}) {
    const summary = (await catalogue()).find((s) => s.resource === `${SESSION}${session}`);
    if (!summary) return;
    const activity = changes.status ?? summary.status & ~(IS_READ | IS_ARCHIVED);
    const status = activity | flagsOf(session, await read(), changes.modifiedAt ?? summary.modifiedAt);
    host.notify(ROOT, "root/sessionSummaryChanged", { session: summary.resource, changes: { ...changes, status } });
  }

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
    const committed = opts.committed && ((entries: readonly Entry[]) => opts.committed!(session, entries, key));
    const chat = new DurableChat({ host, harness: harness(), conversation: handle, uri, ctx, onStatus: statusChanged(session, uri), named, send, input: opts.input, said: opts.said, committed });
    chats.set(uri, chat);
    await chat.open(title, meta);
  }
  const conversationOf = async (c: Chat) => (c.conversation === undefined ? undefined : await harness().conversation(c.conversation, ctx));

  // An ACP agent's session's chat: the agent's process, started when it's needed, and what it said before.
  async function openAgent(session: string, provider: AcpProvider, doc: SessionsDoc) {
    const uri = chatUri(session);
    if (chats.has(uri)) return;
    const transcript = await harness().snapshot(Transcripts, session, ctx);
    if (chats.has(uri)) return;
    const chat = new AcpChat({
      host,
      uri,
      key: session,
      provider,
      cwd: doc.dirs[session] ?? process.cwd(),
      session: doc.acp[session] || undefined,
      transcript: transcript && JSON.parse(JSON.stringify(transcript)),
      // An archived session's agent stays stopped until it's wanted.
      paused: Boolean(doc.archived[session]),
      onStatus: statusChanged(session, uri),
      onCwd: (cwd) => void worksIn(session, cwd).catch(quiet),
      onSession: (id) => update((d) => void (d.acp[session] = id)).then(() => {}),
      onTitle: (t) => void retitle(session, uri, t).catch(quiet),
      onTurn: (turn, ids) => void keep(session, turn, ids).catch(quiet),
    });
    chats.set(uri, chat);
    chat.open(titleOf(session, doc));
  }
  // Where a session's agent says it works (pi.ts: its workspace), once it says so: the session's working directory.
  async function worksIn(session: string, cwd: string) {
    const doc = await read();
    const before = doc.work[session] ?? doc.dirs[session];
    if (before === cwd) return;
    await update((d) => void (d.work[session] = cwd));
    const uri = `${SESSION}${session}`;
    const directory = pathToFileURL(cwd).href;
    if (host.has(uri))
      host.dispatch(uri, act(before ? { type: "session/workingDirectoryReplaced", directory: pathToFileURL(before).href, replacement: directory } : { type: "session/workingDirectorySet", directory }));
    await summaryChanged(session, { workingDirectories: [directory] });
  }
  // A client archived the session, or brought it back: its agent stops (an ACP agent's provider says how, kept to
  // resume: pi.ts stops its pi) or starts again.
  async function archived(session: string, isArchived: boolean) {
    await update((d) => (isArchived ? void (d.archived[session] = new Date().toISOString()) : void delete d.archived[session]));
    const chat = chats.get(chatUri(session));
    if (chat instanceof AcpChat) {
      if (isArchived) {
        chat.stop();
        const doc = await read();
        const [command, ...args] = chat.provider.stop?.(session, doc.dirs[session] ?? process.cwd()) ?? [];
        if (command) await new Promise((done) => spawn(command, args, { stdio: "ignore" }).once("exit", done).once("error", done));
      } else chat.resume();
    }
    await summaryChanged(session);
  }
  async function wasRead(session: string, isRead: boolean) {
    await update((d) => (isRead ? void (d.read[session] = new Date().toISOString()) : void delete d.read[session]));
    await summaryChanged(session);
  }
  const keep = (session: string, turn: Shown, ids: string[]) =>
    harness().commit(async (tx) => {
      const t = await tx.doc(Transcripts, session, null);
      const json: JsonObject = JSON.parse(JSON.stringify(turn));
      t.turns.push(json);
      t.ids.push(...ids);
    }, ctx);

  // Opened once, however many ask at once (a client subscribing as `committed` opens it).
  const opening = new Map<string, Promise<void>>();
  function openSession(session: string) {
    let open = opening.get(session);
    if (!open) {
      open = openNow(session);
      opening.set(session, open);
      void open.catch(() => {}).finally(() => opening.delete(session));
    }
    return open;
  }
  async function openNow(session: string) {
    const uri = `${SESSION}${session}`;
    if (host.has(uri)) return;
    const before = await read();
    const provider = providerOf(session, before);
    const handle = provider ? undefined : await conversation(session);
    const doc = await read();
    const title = titleOf(session, doc);
    const meta = metaOf(session, doc);
    host.create(uri, { provider: providerName(session, doc), ...dirsOf(session, doc), title, status: IDLE | flagsOf(session, doc, new Date(0).toISOString()), lifecycle: "ready", activeClients: [], chats: [], ...(meta && { _meta: meta }) });
    if (provider) await openAgent(session, provider, doc);
    else await openChat(session, chatUri(session), title, handle);
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
        const asked = params.provider === undefined || params.provider === opts.agent?.provider ? undefined : String(params.provider);
        const provider = asked === undefined ? undefined : opts.providers?.find((p) => p.id === asked);
        if (asked !== undefined && !provider) throw new Error(`no agent ${asked} here: ${[opts.agent?.provider, ...(opts.providers ?? []).map((p) => p.id)].filter(Boolean).join(", ")}`);
        if (!provider && !opts.agent) throw new Error(`pick an agent (provider): ${(opts.providers ?? []).map((p) => p.id).join(", ")}`);
        const dir = (params.workingDirectories as string[] | undefined)?.[0];
        const cwd = dir?.startsWith("file:") ? fileURLToPath(dir) : dir;
        await update((d) => {
          if (params._meta !== undefined) d.meta[session] = JSON.stringify(params._meta);
          if (cwd) d.dirs[session] = cwd;
          if (!provider || session in d.ids) return;
          d.ids[session] = "";
          d.providers[session] = provider.id;
          d.created[session] = new Date().toISOString();
        });
        if (!provider) await conversation(session);
        await openSession(session);
        const all = await catalogue();
        host.notify(ROOT, "root/sessionAdded", { summary: all.find((s) => s.resource === params.channel) });
      },
      async disposeSession(uri) {
        const session = sessionOf(uri);
        const doc = await read();
        if (!session || !(session in doc.ids)) throw new Error(`no session ${uri}`);
        const own = chats.get(chatUri(session));
        const provider = providerOf(session, doc);
        if (own instanceof AcpChat) own.stop();
        if (provider) {
          const [command, ...args] = provider.dispose?.(session, doc.dirs[session] ?? process.cwd()) ?? [];
          if (command) await new Promise((done) => spawn(command, args, { stdio: "ignore" }).once("exit", done).once("error", done));
          await harness().commit(async (tx) => void Object.assign(await tx.doc(Transcripts, session, null), { turns: [], ids: [] }), ctx);
        } else await (await conversation(session)).abort(ctx).catch(() => {});
        await update((d) => {
          for (const field of [d.ids, d.titles, d.created, d.meta, d.providers, d.acp, d.dirs, d.work, d.archived, d.read]) delete field[session];
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
        // An answer to a tool call waiting for one: the first is taken, any after it refused.
        if ((action.type as string) === "chat/toolCallConfirmed") {
          const chat = chats.get(channel);
          const a = action as unknown as { turnId: string; toolCallId: string; approved: boolean; selectedOptionId?: string };
          return chat instanceof AcpChat ? chat.answerable(a.turnId, a.toolCallId, a.approved, a.selectedOptionId) : "no tool call here waits for an answer";
        }
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
        const a = action as unknown as { type: string; turnId: string; message?: { text: string }; isArchived?: boolean; isRead?: boolean };
        if (a.type === "session/isArchivedChanged") void archived(session, Boolean(a.isArchived)).catch(quiet);
        if (a.type === "session/isReadChanged") void wasRead(session, Boolean(a.isRead)).catch(quiet);
        if (a.type === "chat/turnStarted") {
          const text = a.message?.text ?? "";
          if (key === undefined) void title(session, channel, text).catch(quiet);
          if (chat) void chat.started(a.turnId, text).catch((err) => chat.refused(a.turnId, (err as Error).message));
          // A chat without a conversation (yet): the caller's to pass on.
          else if (key !== undefined) void opts.send?.(session, key, text).catch(quiet);
        }
        // A message for while a turn runs (steering it, or queued for after it).
        if (a.type === "chat/pendingMessageSet") {
          const p = action as unknown as { kind: "steering" | "queued"; id: string; message?: { text: string } };
          const text = p.message?.text ?? "";
          if (chat) void chat.pending(p.kind, p.id, text).catch(quiet);
          else if (key !== undefined) void opts.send?.(session, key, text).catch(quiet);
        }
        if (a.type === "chat/turnCancelled") {
          if (key !== undefined && opts.cancel) void opts.cancel(session, key).catch(quiet);
          else void chat?.cancel().catch(quiet);
        }
        if (a.type === "chat/toolCallConfirmed" && chat instanceof AcpChat) {
          const c = action as unknown as { toolCallId: string; approved: boolean; selectedOptionId?: string };
          chat.answered(c.toolCallId, c.approved, c.selectedOptionId);
        }
      },
      methods: opts.methods,
    },
    opts.info,
  );
  host.create(ROOT, {
    agents: [
      ...(opts.agent ? [{ models: [], ...opts.agent }] : []),
      ...(opts.providers ?? []).map((p) => ({ provider: p.id, displayName: p.displayName, description: p.description ?? "", models: [] })),
    ],
  });

  // A session is titled by the first message in it, or as its agent names it.
  async function title(session: string, channel: URI, text: string) {
    const doc = await read();
    if (doc.titles[session] || opts.title?.(session) !== undefined) return;
    await retitle(session, channel, text.split("\n")[0].slice(0, 80));
  }
  async function retitle(session: string, channel: URI, t: string) {
    if (opts.title?.(session) !== undefined || (await read()).titles[session] === t) return;
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
    // Every ACP agent's process stopped, as the host closes.
    close() {
      for (const chat of chats.values()) if (chat instanceof AcpChat) chat.stop();
    },
    // A client on its WebSocket.
    accept: (ws: WebSocket) => host.accept(ws),
    // An HTTP server's upgrade to AHP (at whatever path it serves it on).
    upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => sockets.handleUpgrade(req, socket, head, (ws) => host.accept(ws)),
  };
}

const act = (action: object) => action as StateAction;
// Updates for clients that can wait for the next change (the Harness reopening, say).
const quiet = (err: unknown) => console.error(`pi-durable-ahp: ${(err as Error).message ?? err}`);
