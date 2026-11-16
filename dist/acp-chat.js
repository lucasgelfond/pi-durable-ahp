import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { chatState } from "./chat.js";
const act = (action) => action;
const now = () => new Date().toISOString();
const textOf = (c) => (c?.type === "text" ? (c.text ?? "") : "");
const json = (v) => (v === undefined ? undefined : JSON.stringify(v));
const approves = (o) => o.kind.startsWith("allow");
// A tool call's content as AHP text: what it said, and each file it changed.
const shownContent = (content) => (content ?? []).flatMap((c) => {
    const item = c;
    if (item.type === "content" && textOf(item.content))
        return [{ type: "text", text: textOf(item.content) }];
    if (item.type === "diff" && item.path)
        return [{ type: "text", text: `Edited ${item.path}` }];
    return [];
});
export class AcpChat {
    host;
    uri;
    provider;
    cwd;
    onStatus;
    onSession;
    onTitle;
    #session;
    #agent;
    #child;
    #stderr = "";
    #turn;
    // What session/load replays, while it does; and whether the chat has shown it (once a process).
    #loading;
    #lastWasUser = false;
    #shown = false;
    #asked = new Map();
    // Clients' messages for after the turn under way: queued ones, and steering for an agent that can't take it.
    #queue = [];
    constructor(opts) {
        this.host = opts.host;
        this.uri = opts.uri;
        this.provider = opts.provider;
        this.cwd = opts.cwd;
        this.#session = opts.session;
        this.onStatus = opts.onStatus;
        this.onSession = opts.onSession;
        this.onTitle = opts.onTitle;
    }
    get running() {
        return this.#turn !== undefined;
    }
    // The chat's channel, at once; a session the agent had before is loaded behind it, its turns put ahead of any since.
    open(title, meta) {
        if (!this.host.has(this.uri))
            this.host.create(this.uri, chatState(this.uri, title, meta));
        if (this.#session)
            void this.#connect().catch((err) => this.#notice(err.message));
    }
    #dispatch(action) {
        this.host.dispatch(this.uri, act(action));
    }
    // Something the chat should say outside any turn: a turn of its own, from the host.
    #notice(text) {
        this.#dispatch({ type: "chat/turnsLoaded", turns: [{ id: `notice-${Date.now()}`, message: { text, origin: { kind: "systemNotification" } }, responseParts: [], state: "complete" }] });
    }
    // The agent's process and its session, started once (again after it exits).
    #connect() {
        this.#agent ??= (async () => {
            const name = this.provider.displayName;
            const child = spawn(this.provider.command, this.provider.args ?? [], { cwd: this.cwd, env: { ...process.env, ...this.provider.env }, stdio: ["pipe", "pipe", "pipe"] });
            this.#child = child;
            child.stderr.setEncoding("utf8").on("data", (d) => (this.#stderr = (this.#stderr + d).slice(-2000)));
            const why = () => (this.#stderr.trim() ? `: ${this.#stderr.trim().split("\n").at(-1)}` : "");
            const ended = new Promise((_, reject) => {
                child.once("error", (err) => reject(new Error(`${name} didn't start: ${err.message}`)));
                child.once("exit", (code, signal) => reject(new Error(`${name} exited (${signal ?? code})${why()}`)));
            });
            ended.catch(() => { });
            child.once("exit", () => this.#gone(child));
            const race = (p) => Promise.race([p, ended]);
            const { agent } = acp
                .client({ name: "pi-durable-acp-ahp" })
                .onNotification(acp.methods.client.session.update, ({ params }) => this.#update(params))
                .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.#ask(params))
                .connect(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
            const init = await race(agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} }));
            const steering = Boolean(init.agentCapabilities?._meta?.steering?.supported);
            const before = this.#session;
            if (before && init.agentCapabilities?.loadSession) {
                this.#loading = [];
                const loaded = await race(agent.request(acp.methods.agent.session.load, { sessionId: before, cwd: this.cwd, mcpServers: [] })).then(() => true, () => false);
                const turns = this.#loading;
                this.#loading = undefined;
                if (loaded) {
                    if (!this.#shown && turns.length)
                        this.#dispatch({ type: "chat/turnsLoaded", turns });
                    this.#shown = true;
                    return { agent, sessionId: before, steering };
                }
            }
            const { sessionId } = await race(agent.request(acp.methods.agent.session.new, { cwd: this.cwd, mcpServers: [] }));
            this.#session = sessionId;
            await this.onSession?.(sessionId);
            if (before && !this.#shown)
                this.#notice(`${name} couldn't load what was said here before, so it starts afresh.`);
            this.#shown = true;
            return { agent, sessionId, steering };
        })().catch((err) => {
            this.#agent = undefined;
            this.#child?.kill();
            throw err;
        });
        return this.#agent;
    }
    // The agent's process ended: anything waiting on it is answered, and the next use starts it again.
    #gone(child) {
        if (this.#child !== child)
            return;
        this.#child = undefined;
        this.#agent = undefined;
        for (const a of this.#asked.values())
            a.answer({ outcome: { outcome: "cancelled" } });
        this.#asked.clear();
        if (this.#turn)
            this.#end(this.#turn.id, "error", `${this.provider.displayName} exited${this.#stderr.trim() ? `: ${this.#stderr.trim().split("\n").at(-1)}` : ""}`);
    }
    // What session/load replays: each message the user sent starts a turn, and what came after it is its answer.
    #replayed(u) {
        const turns = this.#loading;
        if (u.sessionUpdate === "user_message_chunk") {
            const last = turns.at(-1);
            if (last && this.#lastWasUser)
                last.message.text += textOf(u.content);
            else
                turns.push({ id: `${this.#session}:${turns.length}`, message: { text: textOf(u.content), origin: { kind: "user" } }, responseParts: [], state: "complete" });
            this.#lastWasUser = true;
            return;
        }
        this.#lastWasUser = false;
        const turn = turns.at(-1);
        if (!turn)
            return;
        const parts = turn.responseParts;
        if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
            const kind = u.sessionUpdate === "agent_message_chunk" ? "markdown" : "reasoning";
            const last = parts.at(-1);
            if (last?.kind === kind)
                last.content = String(last.content) + textOf(u.content);
            else
                parts.push({ kind, id: `${turn.id}:${parts.length}`, content: textOf(u.content) });
        }
        if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
            let part = parts.find((p) => p.toolCall?.toolCallId === u.toolCallId)?.toolCall;
            if (!part)
                parts.push({ kind: "toolCall", toolCall: (part = { toolCallId: u.toolCallId, toolName: u.title ?? u.toolCallId, displayName: u.title ?? u.toolCallId, invocationMessage: u.title ?? u.toolCallId, pastTenseMessage: u.title ?? u.toolCallId, status: "completed", confirmed: "not-needed", success: true, _meta: { acp: {} } }) });
            const seen = part._meta.acp;
            for (const k of ["kind", "locations", "content"])
                if (u[k] != null)
                    seen[k] = u[k];
            if (u.title)
                Object.assign(part, { toolName: u.title, displayName: u.title, invocationMessage: u.title, pastTenseMessage: u.title });
            if (u.rawInput !== undefined)
                part.toolInput = json(u.rawInput);
            if (u.status === "failed")
                part.success = false;
            if (u.content)
                part.content = shownContent(u.content);
        }
    }
    #update(n) {
        if (this.#session && n.sessionId !== this.#session)
            return;
        const u = n.update;
        if (this.#loading)
            return this.#replayed(u);
        if (u.sessionUpdate === "session_info_update" && u.title)
            return this.onTitle?.(u.title);
        const turn = this.#turn;
        if (!turn || turn.cancelled)
            return;
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
    #text(turn, kind, content) {
        if (!content)
            return;
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
    #call(turn, id, u) {
        turn.part = turn.thought = undefined;
        let c = turn.calls.get(id);
        const fresh = !c;
        if (!c)
            turn.calls.set(id, (c = { title: u.title ?? id, ready: false, done: false }));
        if (u.title)
            c.title = u.title;
        if (u.kind)
            c.kind = u.kind;
        if (u.locations)
            c.locations = u.locations;
        if (u.content)
            c.content = u.content;
        if (u.rawInput !== undefined)
            c.rawInput = u.rawInput;
        const _meta = { acp: { kind: c.kind, locations: c.locations, content: c.content, ...(c.options && { options: c.options }) } };
        const base = { turnId: turn.id, toolCallId: id, _meta };
        if (fresh)
            this.#dispatch({ type: "chat/toolCallStart", ...base, toolName: c.title, displayName: c.title });
        const status = u.status ?? undefined;
        const done = status === "completed" || status === "failed";
        if (!c.ready && !this.#asked.has(id) && (status === "in_progress" || done || c.rawInput !== undefined)) {
            c.ready = true;
            this.#dispatch({ type: "chat/toolCallReady", ...base, invocationMessage: c.title, toolInput: json(c.rawInput), confirmed: "not-needed" });
        }
        else if (c.ready && !done && u.content)
            this.#dispatch({ type: "chat/toolCallContentChanged", ...base, content: shownContent(c.content) });
        if (done && !c.done) {
            c.done = true;
            this.#dispatch({ type: "chat/toolCallComplete", ...base, result: { success: status === "completed", pastTenseMessage: c.title, content: shownContent(c.content), ...(status === "failed" && { error: { message: `${c.title} failed` } }) } });
        }
    }
    // The agent asks to use a tool: a tool call waiting for a client's confirmation, with the agent's options.
    #ask(p) {
        const turn = this.#turn;
        if (!turn || turn.cancelled)
            return Promise.resolve({ outcome: { outcome: "cancelled" } });
        const id = p.toolCall.toolCallId;
        return new Promise((answer) => {
            this.#asked.set(id, { turnId: turn.id, options: p.options, answer });
            this.#call(turn, id, p.toolCall);
            const c = turn.calls.get(id);
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
    answerable(turnId, toolCallId, approved, optionId) {
        const a = this.#asked.get(toolCallId);
        if (!a || a.turnId !== turnId)
            return "that tool call isn't waiting for an answer (another client may have answered it)";
        if (optionId === undefined)
            return a.options.some((o) => approves(o) === approved) ? undefined : `pick one of: ${a.options.map((o) => o.optionId).join(", ")}`;
        const o = a.options.find((each) => each.optionId === optionId);
        if (!o)
            return `no option ${optionId}`;
        return approves(o) === approved ? undefined : `option ${optionId} doesn't ${approved ? "approve" : "deny"}`;
    }
    // A client's answer (answerable already): the agent hears the option it chose.
    answered(toolCallId, approved, optionId) {
        const a = this.#asked.get(toolCallId);
        if (!a)
            return;
        this.#asked.delete(toolCallId);
        const o = optionId === undefined ? a.options.find((each) => approves(each) === approved) : a.options.find((each) => each.optionId === optionId);
        const c = this.#turn?.calls.get(toolCallId);
        if (c && approved)
            c.ready = true;
        a.answer(o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } });
    }
    // A client started a turn (its action is committed already): the agent's prompt, answered when the agent stops.
    async started(turnId, text) {
        this.#turn = { id: turnId, started: Date.now(), calls: new Map() };
        this.onStatus?.(8);
        try {
            const { agent, sessionId } = await this.#connect();
            if (this.#turn?.id !== turnId || this.#turn.cancelled)
                return this.#end(turnId, "cancelled");
            const { stopReason } = await agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
            this.#end(turnId, stopReason === "cancelled" ? "cancelled" : "complete");
        }
        catch (err) {
            this.#end(turnId, "error", err.message);
        }
    }
    #end(turnId, how, why) {
        const turn = this.#turn;
        if (turn?.id !== turnId)
            return;
        this.#turn = undefined;
        for (const a of this.#asked.values())
            a.answer({ outcome: { outcome: "cancelled" } });
        this.#asked.clear();
        const duration = Date.now() - turn.started;
        // A turn a client cancelled is over already in the chat.
        if (!turn.cancelled) {
            if (how === "complete")
                this.#dispatch({ type: "chat/turnComplete", turnId, duration });
            else if (how === "cancelled")
                this.#dispatch({ type: "chat/turnCancelled", turnId, duration });
            else
                this.#dispatch({ type: "chat/error", turnId, duration, part: { kind: "error", error: { errorType: "acp", message: why ?? "the agent failed" } } });
        }
        this.onStatus?.(1);
        const next = this.#queue.shift();
        if (next)
            this.#take(next);
    }
    // A client's message waiting for its turn, now a turn of its own.
    #take(p) {
        this.#dispatch({ type: "chat/pendingMessageRemoved", kind: p.kind, id: p.id });
        this.#dispatch({ type: "chat/turnStarted", turnId: p.id, startedAt: now(), message: { text: p.text, origin: { kind: "user" } } });
        void this.started(p.id, p.text);
    }
    // A client's message for while a turn runs: steering goes to the agent at once if it takes it (_session/steering),
    // otherwise it waits, as a queued one does, for the turn to end and starts one of its own.
    async pending(kind, id, text) {
        const p = { kind, id, text };
        if (!this.#turn)
            return this.#take(p);
        if (kind === "steering") {
            const { agent, sessionId, steering } = await this.#connect();
            if (steering) {
                const done = await agent.request("_session/steering", { sessionId, prompt: [{ type: "text", text }] }).catch(() => undefined);
                if (done?.outcome === "injected")
                    return this.#dispatch({ type: "chat/pendingMessageRemoved", kind, id });
            }
        }
        if (this.#turn)
            this.#queue.push(p);
        else
            this.#take(p);
    }
    refused(turnId, why) {
        this.#end(turnId, "error", why);
    }
    // A client cancelled the turn (its action is committed already): the agent is told, and what it was asking is off.
    async cancel() {
        const turn = this.#turn;
        if (!turn)
            return;
        turn.cancelled = true;
        for (const a of this.#asked.values())
            a.answer({ outcome: { outcome: "cancelled" } });
        this.#asked.clear();
        const agent = await this.#agent?.catch(() => undefined);
        if (agent)
            await agent.agent.notify(acp.methods.agent.session.cancel, { sessionId: agent.sessionId }).catch(() => { });
    }
    // The agent's process stopped (the session deleted, or the host closing).
    stop() {
        const child = this.#child;
        this.#child = undefined;
        this.#agent = undefined;
        child?.kill();
    }
}
