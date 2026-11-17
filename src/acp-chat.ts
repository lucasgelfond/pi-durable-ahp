import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { StateAction, URI } from "@microsoft/agent-host-protocol";
import { chatState } from "./chat.ts";
import type { AhpHost } from "./host.ts";

// An ACP agent's session as an AHP chat (a session backed by an agent like Claude Code, pi or Gemini CLI instead of a
// pi-durable conversation): the agent is a process of its own, started when the chat is first needed and talked to
// over stdio with the ACP SDK's client. Its session/update notifications become the chat's actions, a client's turn its
// session/prompt, a client's cancel session/cancel, and its permission requests tool calls waiting for a client's
// confirmation (the first answer wins). Its session id is the caller's to keep (`onSession`): a process started later
// loads it (session/load replays what was said), or, for an agent that can't, starts afresh and says so. How updates
// map follows ahp-acp-gateway (github.com/formulahendry/ahp-acp-gateway, MIT). ACP's own view of each tool call (its
// kind, locations, content and diffs, and permission options) rides in the tool call's _meta.acp, for a client to see
// it as the agent said it.
//
// An agent that runs on its own (`follow`: pi in a terminal, pi.ts) is connected to from the start and again whenever
// its connection drops; a turn someone starts there (in its terminal) is the chat's too, ending when the agent says it's
// idle. Each finished turn goes to `onTurn` with its messages' ids (the caller keeps them: the chat's transcript, there
// when the agent isn't), and what session/load replays is only what the chat hasn't shown.

export interface AcpProvider {
  id: string;
  displayName: string;
  description?: string;
  // The agent's process, run in the session's working directory...
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // ...or the command line that reaches the session's agent wherever it runs (pi.ts: its pi, started if need be).
  connect?(session: string, cwd: string): string[];
  follow?: boolean;
  // The session's _meta of the agent's own (pi.ts: how to open its terminal).
  meta?(session: string): Record<string, unknown>;
  // The command lines that stop the session's agent, keeping it to resume (the session archived), and that end it and
  // what it made (the session deleted).
  stop?(session: string, cwd: string): string[];
  dispose?(session: string, cwd: string): string[];
}

// A finished turn as clients have it, and the ids of the agent's messages in it.
export type Shown = { id: string; message: { text: string; origin: { kind: string } }; responseParts: Record<string, unknown>[]; state: string };
export type Transcript = { turns: Shown[]; ids: string[] };

type Call = { title: string; kind?: string; locations?: unknown[]; content?: unknown[]; rawInput?: unknown; options?: acp.PermissionOption[]; ready: boolean; done: boolean };
type Turn = { id: string; started: number; part?: string; thought?: string; calls: Map<string, Call>; cancelled?: boolean; theirs?: boolean; ids: string[] };
type Asked = { turnId: string; options: acp.PermissionOption[]; answer: (response: acp.RequestPermissionResponse) => void };
// How long after its connection goes an agent that runs on its own is connected to again: doubling while it fails.
const RECONNECT_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

const act = (action: object) => action as StateAction;
const now = () => new Date().toISOString();
const textOf = (c?: { type: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : "");
const json = (v: unknown) => (v === undefined ? undefined : JSON.stringify(v));
// The id of the agent's message an update is part of, if it gives one; added to a turn's once.
const messageIdOf = (u: acp.SessionUpdate) => ("messageId" in u ? (u.messageId ?? undefined) : undefined);
const noted = (ids: string[], id?: string) => void (id && !ids.includes(id) && ids.push(id));
const approves = (o: acp.PermissionOption) => o.kind.startsWith("allow");
// A tool call's content as AHP text: what it said, and each file it changed.
const shownContent = (content?: unknown[]) =>
  (content ?? []).flatMap((c) => {
    const item = c as { type: string; content?: { type: string; text?: string }; path?: string };
    if (item.type === "content" && textOf(item.content)) return [{ type: "text", text: textOf(item.content) }];
    if (item.type === "diff" && item.path) return [{ type: "text", text: `Edited ${item.path}` }];
    return [];
  });

export class AcpChat {
  readonly host: AhpHost;
  readonly uri: URI;
  readonly provider: AcpProvider;
  readonly cwd: string;
  readonly onStatus?: (status: number) => void;
  readonly onSession?: (sessionId: string) => Promise<void>;
  readonly onTitle?: (title: string) => void;
  readonly onTurn?: (turn: Shown, ids: string[]) => void;
  readonly onCwd?: (cwd: string) => void;
  // The host's session this chat is.
  readonly key: string;
  #session?: string;
  #agent?: Promise<{ agent: acp.ClientContext; sessionId: string; steering: boolean }>;
  #child?: ChildProcess;
  #stderr = "";
  #turn?: Turn;
  #stopped = false;
  #retry = RECONNECT_MS;
  // Whether the chat has said the agent couldn't load its session.
  #forgot = false;
  // What session/load replays, while it does, and the ids of the agent's messages the chat has shown.
  #loading?: (Shown & { ids: string[] })[];
  #lastWasUser = false;
  readonly #seen: Set<string>;
  readonly #transcript: Shown[];
  readonly #asked = new Map<string, Asked>();
  // Clients' messages for after the turn under way: queued ones, and steering for an agent that can't take it.
  readonly #queue: { kind: "steering" | "queued"; id: string; text: string }[] = [];

  constructor(opts: {
    host: AhpHost;
    uri: URI;
    key: string;
    provider: AcpProvider;
    cwd: string;
    session?: string;
    transcript?: Transcript;
    paused?: boolean;
    onStatus?: (status: number) => void;
    onSession?: (sessionId: string) => Promise<void>;
    onTitle?: (title: string) => void;
    onTurn?: (turn: Shown, ids: string[]) => void;
    onCwd?: (cwd: string) => void;
  }) {
    this.host = opts.host;
    this.uri = opts.uri;
    this.key = opts.key;
    this.provider = opts.provider;
    this.cwd = opts.cwd;
    this.#session = opts.session;
    this.#transcript = opts.transcript?.turns ?? [];
    this.#seen = new Set(opts.transcript?.ids);
    this.onStatus = opts.onStatus;
    this.onSession = opts.onSession;
    this.onTitle = opts.onTitle;
    this.onTurn = opts.onTurn;
    this.onCwd = opts.onCwd;
    this.#stopped = Boolean(opts.paused);
  }

  get running() {
    return this.#turn !== undefined;
  }

  // The chat's channel, at once, with what it said before; then the agent (an agent that runs on its own, at once; a
  // session the agent had before, loaded behind it).
  open(title: string, meta?: Record<string, unknown>) {
    if (!this.host.has(this.uri)) {
      this.host.create(this.uri, chatState(this.uri, title, meta));
      if (this.#transcript.length) this.#dispatch({ type: "chat/turnsLoaded", turns: this.#transcript });
    }
    if (!this.#stopped && (this.#session || this.provider.follow)) void this.#connect().catch((err: Error) => this.#failed(err));
  }

  // A connection that failed, said in the chat, unless it was stopped on purpose.
  #failed(err: Error) {
    if (!this.#stopped) this.#notice(err.message);
  }

  #dispatch(action: object) {
    this.host.dispatch(this.uri, act(action));
  }

  // Something the chat should say outside any turn: a turn of its own, from the host.
  #notice(text: string) {
    this.#dispatch({ type: "chat/turnsLoaded", turns: [{ id: `notice-${Date.now()}`, message: { text, origin: { kind: "systemNotification" } }, responseParts: [], state: "complete" }] });
  }

  // The agent's process and its session, started once (again after it exits).
  #connect() {
    this.#agent ??= (async () => {
      const name = this.provider.displayName;
      const [command, ...args] = this.provider.connect?.(this.key, this.cwd) ?? [this.provider.command!, ...(this.provider.args ?? [])];
      const child = spawn(command, args, { ...(!this.provider.connect && { cwd: this.cwd }), env: { ...process.env, ...this.provider.env }, stdio: ["pipe", "pipe", "pipe"] });
      this.#child = child;
      child.stderr!.setEncoding("utf8").on("data", (d: string) => (this.#stderr = (this.#stderr + d).slice(-2000)));
      const why = () => (this.#stderr.trim() ? `: ${this.#stderr.trim().split("\n").at(-1)}` : "");
      const ended = new Promise<never>((_, reject) => {
        child.once("error", (err) => reject(new Error(`${name} didn't start: ${err.message}`)));
        child.once("exit", (code, signal) => reject(new Error(`${name} exited (${signal ?? code})${why()}`)));
      });
      ended.catch(() => {});
      child.once("exit", () => this.#gone(child));
      const race = <T>(p: Promise<T>) => Promise.race([p, ended]);
      const { agent } = acp
        .client({ name: "pi-durable-ahp" })
        .onNotification(acp.methods.client.session.update, ({ params }) => this.#update(params))
        .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.#ask(params))
        .connect(acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>));
      const init = await race(agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }));
      const steering = Boolean((init.agentCapabilities?._meta as { steering?: { supported?: boolean } } | undefined)?.steering?.supported);
      // An agent that is one running session: that one, and where it works.
      if (this.provider.follow) {
        const [running] = (await race(agent.request(acp.methods.agent.session.list, {}))).sessions;
        this.#session ??= running?.sessionId;
        if (running?.cwd) this.onCwd?.(running.cwd);
      }
      const before = this.#session;
      if (before && init.agentCapabilities?.loadSession) {
        this.#loading = [];
        const loaded = await race(agent.request(acp.methods.agent.session.load, { sessionId: before, cwd: this.cwd, mcpServers: [] })).then(
          () => true,
          () => false,
        );
        // Turns the chat hasn't shown: by their messages' ids, or (an agent that gives none) all of them, once.
        const fresh = !this.#transcript.length;
        const turns = this.#loading.filter((t) => (t.ids.length ? !t.ids.some((id) => this.#seen.has(id)) : fresh));
        this.#loading = undefined;
        if (loaded) {
          const shown = turns.map(({ ids: _, ...t }) => t);
          // A chat showing nothing yet loads them all; one showing turns gets them after those.
          if (fresh || this.host.get<{ activeTurn?: unknown }>(this.uri)?.activeTurn) {
            if (shown.length) this.#dispatch({ type: "chat/turnsLoaded", turns: shown });
          } else shown.forEach((t) => this.#after(t));
          turns.forEach((t, i) => this.#kept(shown[i], t.ids));
          this.#retry = RECONNECT_MS;
          return { agent, sessionId: before, steering };
        }
      }
      const { sessionId } = await race(agent.request(acp.methods.agent.session.new, { cwd: this.cwd, mcpServers: [] }));
      this.#session = sessionId;
      await this.onSession?.(sessionId);
      if (before && !this.#forgot) {
        this.#forgot = true;
        this.#notice(`${name} couldn't load what was said here before, so it starts afresh.`);
      }
      this.#retry = RECONNECT_MS;
      return { agent, sessionId, steering };
    })().catch((err: unknown) => {
      this.#agent = undefined;
      this.#child?.kill();
      this.#again();
      throw err;
    });
    return this.#agent;
  }

  // An agent that runs on its own is connected to again after its connection goes.
  #again() {
    if (!this.provider.follow || this.#stopped) return;
    const wait = this.#retry;
    this.#retry = Math.min(wait * 2, RECONNECT_MAX_MS);
    setTimeout(() => {
      if (!this.#agent && !this.#stopped) void this.#connect().catch((err: Error) => console.error(`pi-durable-ahp: ${this.provider.displayName}: ${err.message}`));
    }, wait).unref();
  }

  // The agent's process ended: anything waiting on it is answered, and the next use starts it again.
  #gone(child: ChildProcess) {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#agent = undefined;
    for (const a of this.#asked.values()) a.answer({ outcome: { outcome: "cancelled" } });
    this.#asked.clear();
    if (this.#turn) this.#end(this.#turn.id, "error", `${this.provider.displayName} exited${this.#stderr.trim() ? `: ${this.#stderr.trim().split("\n").at(-1)}` : ""}`);
    this.#again();
  }

  // A finished turn the chat hasn't shown, after the turns it shows: as that turn's own actions (turnsLoaded would put it
  // before them).
  #after(t: Shown) {
    const turnId = t.id;
    this.#dispatch({ type: "chat/turnStarted", turnId, startedAt: now(), message: t.message });
    for (const part of t.responseParts) {
      const call = part.toolCall as { toolCallId: string; toolName: string; displayName: string; invocationMessage: string; pastTenseMessage: string; toolInput?: string; success: boolean; content?: unknown[]; _meta?: unknown } | undefined;
      if (!call) {
        this.#dispatch({ type: "chat/responsePart", turnId, part });
        continue;
      }
      const base = { turnId, toolCallId: call.toolCallId, _meta: call._meta };
      this.#dispatch({ type: "chat/toolCallStart", ...base, toolName: call.toolName, displayName: call.displayName });
      this.#dispatch({ type: "chat/toolCallReady", ...base, invocationMessage: call.invocationMessage, toolInput: call.toolInput, confirmed: "not-needed" });
      this.#dispatch({ type: "chat/toolCallComplete", ...base, result: { success: call.success, pastTenseMessage: call.pastTenseMessage, content: call.content ?? [] } });
    }
    this.#dispatch({ type: "chat/turnComplete", turnId, duration: 0 });
  }

  // A finished turn, and the ids of its messages: shown, and the caller's to keep.
  #kept(turn: Shown, ids: string[]) {
    for (const id of ids) this.#seen.add(id);
    this.#transcript.push(turn);
    this.onTurn?.(turn, ids);
  }

  // What session/load replays: each message the user sent starts a turn, and what came after it is its answer.
  #replayed(u: acp.SessionUpdate) {
    const turns = this.#loading!;
    const id = messageIdOf(u);
    if (u.sessionUpdate === "user_message_chunk") {
      const last = turns.at(-1);
      if (last && this.#lastWasUser) last.message.text += textOf(u.content);
      else turns.push({ id: id ?? `${this.#session}:${turns.length}`, message: { text: textOf(u.content), origin: { kind: "user" } }, responseParts: [], state: "complete", ids: [] });
      noted(turns.at(-1)!.ids, id);
      this.#lastWasUser = true;
      return;
    }
    this.#lastWasUser = false;
    const turn = turns.at(-1);
    if (!turn) return;
    noted(turn.ids, id);
    const parts = turn.responseParts;
    if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
      const kind = u.sessionUpdate === "agent_message_chunk" ? "markdown" : "reasoning";
      const last = parts.at(-1);
      if (last?.kind === kind) last.content = String(last.content) + textOf(u.content);
      else parts.push({ kind, id: `${turn.id}:${parts.length}`, content: textOf(u.content) });
    }
    if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      let part = parts.find((p) => (p.toolCall as { toolCallId?: string } | undefined)?.toolCallId === u.toolCallId)?.toolCall as Record<string, unknown> | undefined;
      if (!part) parts.push({ kind: "toolCall", toolCall: (part = { toolCallId: u.toolCallId, toolName: u.title ?? u.toolCallId, displayName: u.title ?? u.toolCallId, invocationMessage: u.title ?? u.toolCallId, pastTenseMessage: u.title ?? u.toolCallId, status: "completed", confirmed: "not-needed", success: true, _meta: { acp: {} } }) });
      const seen = (part._meta as { acp: Record<string, unknown> }).acp;
      for (const k of ["kind", "locations", "content"] as const) if (u[k] != null) seen[k] = u[k];
      if (u.title) Object.assign(part, { toolName: u.title, displayName: u.title, invocationMessage: u.title, pastTenseMessage: u.title });
      if (u.rawInput !== undefined) part.toolInput = json(u.rawInput);
      if (u.status === "failed") part.success = false;
      if (u.content) part.content = shownContent(u.content);
    }
  }

  #update(n: acp.SessionNotification) {
    if (this.#session && n.sessionId !== this.#session) return;
    const u = n.update;
    if (this.#loading) return this.#replayed(u);
    if (u.sessionUpdate === "session_info_update") {
      if (u.title) this.onTitle?.(u.title);
      // The agent is idle again: a turn started in its terminal is over.
      if (this.#turn?.theirs && (u._meta as { pi?: { state?: string } } | undefined)?.pi?.state === "idle") this.#end(this.#turn.id, "complete");
      return;
    }
    const id = messageIdOf(u);
    // Someone typed into the agent's own terminal: a turn of theirs.
    if (!this.#turn && this.provider.follow && u.sessionUpdate === "user_message_chunk" && !(id && this.#seen.has(id))) this.#theirs(id ?? `turn-${Date.now()}`, textOf(u.content));
    const turn = this.#turn;
    if (!turn || turn.cancelled) return;
    noted(turn.ids, id);
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        return this.#text(turn, "markdown", textOf(u.content));
      case "agent_thought_chunk":
        return this.#text(turn, "reasoning", textOf(u.content));
      case "plan":
        return this.#text(turn, "markdown", `\n\n**Plan**\n${u.entries.map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`).join("\n")}\n\n`);
      case "tool_call":
      case "tool_call_update":
        return this.#call(turn, u.toolCallId, u);
      case "usage_update":
        return this.#dispatch({ type: "chat/usage", turnId: turn.id, usage: { inputTokens: u.used, outputTokens: 0, _meta: { acp: { used: u.used, size: u.size, ...(u.cost && { cost: u.cost }) } } } });
    }
  }

  // Streamed text, into the part of its kind under way (a new one after anything else).
  #text(turn: Turn, kind: "markdown" | "reasoning", content: string) {
    if (!content) return;
    const key = kind === "markdown" ? "part" : "thought";
    turn[kind === "markdown" ? "thought" : "part"] = undefined;
    if (!turn[key]) {
      turn[key] = `${turn.id}:${Math.random().toString(36).slice(2)}`;
      this.#dispatch({ type: "chat/responsePart", turnId: turn.id, part: { kind, id: turn[key], content: "" } });
    }
    this.#dispatch({ type: kind === "markdown" ? "chat/delta" : "chat/reasoning", turnId: turn.id, partId: turn[key], content });
  }

  // A tool call as the agent tells it: started, its input ready (or waiting for a client's yes), its content as it
  // comes, and done.
  #call(turn: Turn, id: string, u: Partial<acp.ToolCallUpdate> & { status?: string | null }) {
    turn.part = turn.thought = undefined;
    let c = turn.calls.get(id);
    const fresh = !c;
    if (!c) turn.calls.set(id, (c = { title: u.title ?? id, ready: false, done: false }));
    if (u.title) c.title = u.title;
    if (u.kind) c.kind = u.kind;
    if (u.locations) c.locations = u.locations;
    if (u.content) c.content = u.content;
    if (u.rawInput !== undefined) c.rawInput = u.rawInput;
    const _meta = { acp: { kind: c.kind, locations: c.locations, content: c.content, ...(c.options && { options: c.options }) } };
    const base = { turnId: turn.id, toolCallId: id, _meta };
    if (fresh) this.#dispatch({ type: "chat/toolCallStart", ...base, toolName: c.title, displayName: c.title });
    const status = u.status ?? undefined;
    const done = status === "completed" || status === "failed";
    if (!c.ready && !this.#asked.has(id) && (status === "in_progress" || done || c.rawInput !== undefined)) {
      c.ready = true;
      this.#dispatch({ type: "chat/toolCallReady", ...base, invocationMessage: c.title, toolInput: json(c.rawInput), confirmed: "not-needed" });
    } else if (c.ready && !done && u.content) this.#dispatch({ type: "chat/toolCallContentChanged", ...base, content: shownContent(c.content) });
    if (done && !c.done) {
      c.done = true;
      this.#dispatch({ type: "chat/toolCallComplete", ...base, result: { success: status === "completed", pastTenseMessage: c.title, content: shownContent(c.content), ...(status === "failed" && { error: { message: `${c.title} failed` } }) } });
    }
  }

  // The agent asks to use a tool: a tool call waiting for a client's confirmation, with the agent's options.
  #ask(p: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const turn = this.#turn;
    if (!turn || turn.cancelled) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const id = p.toolCall.toolCallId;
    return new Promise((answer) => {
      this.#asked.set(id, { turnId: turn.id, options: p.options, answer });
      this.#call(turn, id, p.toolCall);
      const c = turn.calls.get(id)!;
      c.options = p.options;
      c.ready = false;
      this.#dispatch({
        type: "chat/toolCallReady",
        turnId: turn.id,
        toolCallId: id,
        invocationMessage: c.title,
        confirmationTitle: c.title,
        toolInput: json(c.rawInput),
        options: p.options.map((o) => ({ id: o.optionId, label: o.name, kind: approves(o) ? "approve" : "deny", group: approves(o) ? 0 : 1 })),
        _meta: { acp: { kind: c.kind, locations: c.locations, content: c.content, options: p.options } },
      });
    });
  }

  // Why a client's answer to a tool call can't be taken (another client answered first, say), or undefined.
  answerable(turnId: string, toolCallId: string, approved: boolean, optionId?: string) {
    const a = this.#asked.get(toolCallId);
    if (!a || a.turnId !== turnId) return "that tool call isn't waiting for an answer (another client may have answered it)";
    if (optionId === undefined) return a.options.some((o) => approves(o) === approved) ? undefined : `pick one of: ${a.options.map((o) => o.optionId).join(", ")}`;
    const o = a.options.find((each) => each.optionId === optionId);
    if (!o) return `no option ${optionId}`;
    return approves(o) === approved ? undefined : `option ${optionId} doesn't ${approved ? "approve" : "deny"}`;
  }

  // A client's answer (answerable already): the agent hears the option it chose.
  answered(toolCallId: string, approved: boolean, optionId?: string) {
    const a = this.#asked.get(toolCallId);
    if (!a) return;
    this.#asked.delete(toolCallId);
    const o = optionId === undefined ? a.options.find((each) => approves(each) === approved) : a.options.find((each) => each.optionId === optionId);
    const c = this.#turn?.calls.get(toolCallId);
    if (c && approved) c.ready = true;
    a.answer(o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } });
  }

  // A turn started in the agent's own terminal, shown as if a client had started it.
  #theirs(turnId: string, text: string) {
    this.#turn = { id: turnId, started: Date.now(), calls: new Map(), theirs: true, ids: [] };
    this.#dispatch({ type: "chat/turnStarted", turnId, startedAt: now(), message: { text, origin: { kind: "user" } } });
    this.onStatus?.(8);
  }

  // A client started a turn (its action is committed already): the agent's prompt, answered when the agent stops. An
  // agent stopped (its session archived) starts again for it.
  async started(turnId: string, text: string) {
    this.#stopped = false;
    this.#turn = { id: turnId, started: Date.now(), calls: new Map(), ids: [] };
    this.onStatus?.(8);
    try {
      const { agent, sessionId } = await this.#connect();
      if (this.#turn?.id !== turnId || this.#turn.cancelled) return this.#end(turnId, "cancelled");
      const { stopReason } = await agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
      this.#end(turnId, stopReason === "cancelled" ? "cancelled" : "complete");
    } catch (err) {
      this.#end(turnId, "error", (err as Error).message);
    }
  }

  #end(turnId: string, how: "complete" | "cancelled" | "error", why?: string) {
    const turn = this.#turn;
    if (turn?.id !== turnId) return;
    this.#turn = undefined;
    for (const a of this.#asked.values()) a.answer({ outcome: { outcome: "cancelled" } });
    this.#asked.clear();
    const duration = Date.now() - turn.started;
    // A turn a client cancelled is over already in the chat.
    if (!turn.cancelled) {
      if (how === "complete") this.#dispatch({ type: "chat/turnComplete", turnId, duration });
      else if (how === "cancelled") this.#dispatch({ type: "chat/turnCancelled", turnId, duration });
      else this.#dispatch({ type: "chat/error", turnId, duration, part: { kind: "error", error: { errorType: "acp", message: why ?? "the agent failed" } } });
    }
    const shown = this.host.get<{ turns: Shown[] }>(this.uri)?.turns.find((t) => t.id === turnId);
    if (shown) this.#kept(shown, turn.ids);
    this.onStatus?.(1);
    const next = this.#queue.shift();
    if (next) this.#take(next);
  }

  // A client's message waiting for its turn, now a turn of its own.
  #take(p: { kind: "steering" | "queued"; id: string; text: string }) {
    this.#dispatch({ type: "chat/pendingMessageRemoved", kind: p.kind, id: p.id });
    this.#dispatch({ type: "chat/turnStarted", turnId: p.id, startedAt: now(), message: { text: p.text, origin: { kind: "user" } } });
    void this.started(p.id, p.text);
  }

  // A client's message for while a turn runs: steering goes to the agent at once if it takes it (_session/steering),
  // otherwise it waits, as a queued one does, for the turn to end and starts one of its own.
  async pending(kind: "steering" | "queued", id: string, text: string) {
    const p = { kind, id, text };
    if (!this.#turn) return this.#take(p);
    if (kind === "steering") {
      const { agent, sessionId, steering } = await this.#connect();
      if (steering) {
        const done = await agent.request<{ outcome?: string }>("_session/steering", { sessionId, prompt: [{ type: "text", text }] }).catch(() => undefined);
        if (done?.outcome === "injected") return this.#dispatch({ type: "chat/pendingMessageRemoved", kind, id });
      }
    }
    if (this.#turn) this.#queue.push(p);
    else this.#take(p);
  }

  refused(turnId: string, why: string) {
    this.#end(turnId, "error", why);
  }

  // A client cancelled the turn (its action is committed already): the agent is told, and what it was asking is off.
  async cancel() {
    const turn = this.#turn;
    if (!turn) return;
    turn.cancelled = true;
    for (const a of this.#asked.values()) a.answer({ outcome: { outcome: "cancelled" } });
    this.#asked.clear();
    const agent = await this.#agent?.catch(() => undefined);
    if (agent) await agent.agent.notify(acp.methods.agent.session.cancel, { sessionId: agent.sessionId }).catch(() => {});
  }

  // Connected to again after `stop` (the session brought back from the archive).
  resume() {
    this.#stopped = false;
    this.#retry = RECONNECT_MS;
    if (this.provider.follow && !this.#agent) void this.#connect().catch((err: Error) => this.#failed(err));
  }

  // The connection to the agent stopped (the session archived or deleted, or the host closing).
  stop() {
    this.#stopped = true;
    const child = this.#child;
    this.#child = undefined;
    this.#agent = undefined;
    child?.kill();
  }
}
