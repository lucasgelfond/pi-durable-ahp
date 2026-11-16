import { changesetReducer, chatReducer, PROTOCOL_VERSION, rootReducer, sessionReducer, terminalReducer, } from "@microsoft/agent-host-protocol";
// An Agent Host Protocol host (microsoft.github.io/agent-host-protocol): each channel's state, changed only by the
// protocol's own reducers; each committed action numbered (serverSeq), sent to the channel's subscribers, and kept a
// while, so a client that reconnects gets what it missed instead of starting over. What the channels mean is the
// caller's: `handlers` answer the commands and act on clients' actions, and add methods of their own (x-<name>/…).
// The protocol's enums are TypeScript const enums, which erasable TypeScript can't import: values are written out.
export const ROOT = "ahp-root://";
const REPLAY = 5000;
const reducerOf = (uri) => (uri === ROOT
    ? rootReducer
    : uri.startsWith("ahp-session:")
        ? sessionReducer
        : uri.startsWith("ahp-chat:")
            ? chatReducer
            : uri.startsWith("ahp-terminal:")
                ? terminalReducer
                : uri.startsWith("ahp-changeset:")
                    ? changesetReducer
                    : undefined);
export class AhpHost {
    #states = new Map();
    // Numbered from the clock, so numbers keep rising across restarts and a client never mistakes a new host's actions
    // for ones it saw.
    #seq = Date.now();
    #log = [];
    #clients = new Set();
    #known = new Set();
    #handlers;
    #info;
    constructor(handlers, info) {
        this.#handlers = handlers;
        this.#info = info;
    }
    get(uri) {
        return this.#states.get(uri);
    }
    has(uri) {
        return this.#states.has(uri);
    }
    create(uri, state) {
        this.#states.set(uri, state);
    }
    delete(uri) {
        this.#states.delete(uri);
        for (const c of this.#clients)
            c.subscriptions.delete(uri);
    }
    // An action of the host's own: applied, numbered, kept and sent.
    dispatch(channel, action, origin) {
        const state = this.#states.get(channel);
        const reduce = reducerOf(channel);
        if (!state || !reduce)
            return;
        this.#states.set(channel, reduce(state, action));
        const envelope = { channel, action, serverSeq: ++this.#seq, origin };
        this.#log.push(envelope);
        if (this.#log.length > REPLAY)
            this.#log.splice(0, this.#log.length - REPLAY);
        this.#send(channel, { jsonrpc: "2.0", method: "action", params: envelope });
    }
    // A notification (root/sessionAdded, …) to every client subscribed to `channel`.
    notify(channel, method, params) {
        this.#send(channel, { jsonrpc: "2.0", method, params: { channel, ...params } });
    }
    #send(channel, message) {
        const text = JSON.stringify(message);
        for (const c of this.#clients)
            if (c.subscriptions.has(channel) && c.socket.readyState === 1)
                c.socket.send(text);
    }
    #snapshot(uri) {
        const state = this.#states.get(uri);
        return state ? { resource: uri, state, fromSeq: this.#seq } : undefined;
    }
    async #channel(uri) {
        if (!this.#states.has(uri))
            await this.#handlers.hydrate?.(uri).catch(() => false);
        return this.#states.has(uri);
    }
    accept(socket) {
        const client = { socket, subscriptions: new Set() };
        this.#clients.add(client);
        socket.on("close", () => this.#clients.delete(client));
        socket.on("message", (data) => {
            let message;
            try {
                message = JSON.parse(String(data));
            }
            catch {
                return;
            }
            if (message.method === undefined)
                return;
            const reply = (body) => socket.readyState === 1 && socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body }));
            this.#handle(client, message.method, message.params ?? {}).then((result) => message.id !== undefined && reply({ result: result ?? null }), (err) => message.id !== undefined && reply({ error: { code: err.code ?? -32603, message: err.message } }));
        });
    }
    async #handle(client, method, params) {
        const clientId = client.id ?? "";
        switch (method) {
            case "initialize": {
                client.id = String(params.clientId);
                this.#known.add(client.id);
                const snapshots = [];
                for (const uri of params.initialSubscriptions ?? []) {
                    if (!(await this.#channel(uri)))
                        continue;
                    client.subscriptions.add(uri);
                    snapshots.push(this.#snapshot(uri));
                }
                return { protocolVersion: PROTOCOL_VERSION, serverSeq: this.#seq, serverInfo: this.#info, snapshots };
            }
            // TODO: AHP PR #494 changes reconnect; follow it once it lands.
            case "reconnect": {
                client.id = String(params.clientId);
                const known = this.#known.has(client.id);
                this.#known.add(client.id);
                client.subscriptions.clear();
                const missing = [];
                for (const uri of params.subscriptions ?? []) {
                    if (await this.#channel(uri))
                        client.subscriptions.add(uri);
                    else
                        missing.push(uri);
                }
                const last = Number(params.lastSeenServerSeq ?? 0);
                const oldest = this.#log[0]?.serverSeq ?? this.#seq + 1;
                if (known && last >= oldest - 1 && last <= this.#seq)
                    return { type: "replay", actions: this.#log.filter((e) => e.serverSeq > last && client.subscriptions.has(e.channel)), missing };
                return { type: "snapshot", snapshots: [...client.subscriptions].map((uri) => this.#snapshot(uri)) };
            }
            case "ping":
                return null;
            case "subscribe": {
                const uri = String(params.channel);
                if (!(await this.#channel(uri)))
                    throw Object.assign(new Error(`no channel ${uri}`), { code: -32004 });
                client.subscriptions.add(uri);
                return { snapshot: this.#snapshot(uri) };
            }
            case "unsubscribe":
                client.subscriptions.delete(String(params.channel));
                return null;
            case "listSessions":
                return { items: await this.#handlers.listSessions() };
            case "createSession":
                return void (await this.#handlers.createSession?.(params, clientId));
            case "disposeSession":
                return void (await this.#handlers.disposeSession?.(String(params.channel)));
            case "createChat":
                return void (await this.#handlers.createChat?.(params, clientId));
            // TODO: disposeChat isn't a standard AHP command; move to the spec's way of deleting a chat once there is one.
            case "disposeChat":
                return void (await this.#handlers.disposeChat?.(String(params.channel)));
            case "dispatchAction": {
                const channel = String(params.channel);
                const action = params.action;
                const origin = { clientId, clientSeq: Number(params.clientSeq) };
                await this.#channel(channel);
                const refused = this.#states.has(channel) ? this.#handlers.validate?.(channel, action, clientId) : "no such channel";
                if (refused) {
                    const envelope = { channel, action, serverSeq: this.#seq, origin, rejectionReason: refused };
                    client.socket.send(JSON.stringify({ jsonrpc: "2.0", method: "action", params: envelope }));
                    return null;
                }
                this.dispatch(channel, action, origin);
                this.#handlers.acted?.(channel, action, clientId);
                return null;
            }
            default: {
                const own = this.#handlers.methods?.[method];
                if (!own)
                    throw Object.assign(new Error(`no method ${method}`), { code: -32601 });
                return own(params, clientId);
            }
        }
    }
}
