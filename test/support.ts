import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { type ActionEnvelope, chatReducer, PROTOCOL_VERSION, type URI } from "@microsoft/agent-host-protocol";
import { AhpClient, type AhpTransport, type TransportFrame } from "@microsoft/agent-host-protocol/client";
import WebSocket from "ws";
import { type AcpProvider, type Chat, durableAhp } from "../src/index.ts";

// A Harness with a scripted model, served over AHP (/ahp) and ACP (/acp, Streamable HTTP and WebSocket) as an app
// would: "remember X" calls the remember tool, "edit FILE" the edit tool, "slow …" answers at length (a turn that
// takes a while), a tool's result is answered "saved", anything else is echoed.

export const ctx = BACKGROUND_CONTEXT;
export const remembered: string[] = [];
const faux = fauxProvider({ tokensPerSecond: 4000 });
const models = createModels();
models.setProvider(faux.provider);
const said = (content: unknown) => (typeof content === "string" ? content : (content as { type: string; text?: string }[]).map((c) => c.text ?? "").join(""));
faux.setResponses(
  Array.from({ length: 2000 }, () => (request: { messages: { role: string; content: unknown }[] }) => {
    const last = request.messages.findLast((m) => m.role !== "system")!;
    if (last.role === "toolResult") return fauxAssistantMessage("saved");
    const text = said(last.content);
    const fact = text.match(/^remember (.+)$/)?.[1];
    if (fact) return fauxAssistantMessage(fauxToolCall("remember", { fact }), { stopReason: "toolUse" });
    const file = text.match(/^edit (\S+)$/)?.[1];
    if (file) return fauxAssistantMessage(fauxToolCall("edit", { path: file, edits: [{ oldText: "old line", newText: "new line" }] }), { stopReason: "toolUse" });
    if (text.startsWith("slow")) return fauxAssistantMessage(`slowly: ${"and so on ".repeat(1500)}`);
    return fauxAssistantMessage(`echo: ${text}`);
  }),
);
const registry = createRegistry();
registry.install(
  defineExtension({
    name: "test-tools",
    tools: [
      defineTool({
        name: "remember",
        description: "Remember a fact.",
        parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
        execute: async (args) => (remembered.push(String((args as { fact: string }).fact)), { output: [{ type: "text", text: "remembered" }] }),
      }),
      defineTool({
        name: "edit",
        description: "Edit a file.",
        parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array" } }, required: ["path"] },
        execute: async () => ({ output: [{ type: "text", text: "edited" }] }),
      }),
    ],
  }),
);
export const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
export const model = { provider: "faux", modelId: "faux-1" };

// The app's subagents: each session's, as chats beside it.
export const subagents = new Map<string, Chat[]>();

// The scripted ACP agent (acp-agent.ts) as a provider, its sessions kept in `state`; `noLoad`: one that can't load them.
export const scripted = (state: string, opts: { id?: string; noLoad?: boolean } = {}): AcpProvider => ({
  id: opts.id ?? "scripted",
  displayName: "Scripted",
  command: process.execPath,
  args: [new URL("./acp-agent.ts", import.meta.url).pathname],
  env: { AGENT_STATE: state, ...(opts.noLoad && { NO_LOAD: "1" }) },
});

// `refuse`: subagents refuse what clients send them (as a task that has ended would). `providers`: ACP agents.
export function serve(opts: { methods?: Record<string, (params: Record<string, unknown>) => Promise<unknown>>; refuse?: boolean; providers?: AcpProvider[] } = {}) {
  const ahp = durableAhp({
    harness: () => harness,
    context: ctx,
    info: { name: "test", version: "0" },
    agent: { provider: "test", displayName: "Test" },
    create: (session) => harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, ctx).then((c) => (void session, c)),
    meta: (session) => ({ test: { subagents: (subagents.get(session) ?? []).length } }),
    chats: (session) => subagents.get(session) ?? [],
    ...(opts.refuse && { send: async () => "not taking messages" }),
    methods: opts.methods,
    providers: opts.providers,
  });
  const acp = ahp.acp({ cwd: "/work", contextWindow: 100_000 });
  const server = createServer((req, res) => (req.url?.startsWith("/acp") ? acp.http(req, res) : res.writeHead(404).end()));
  server.on("upgrade", (req, socket, head) => (req.url?.startsWith("/acp") ? acp.upgrade(req, socket, head) : ahp.upgrade(req, socket, head)));
  return new Promise<{ ahp: typeof ahp; url: string; port: number; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ ahp, url: `ws://127.0.0.1:${port}`, port, close: () => (ahp.close(), server.closeAllConnections(), server.close()) });
    }),
  );
}

// Microsoft's own AHP client, over a WebSocket.
class Socket implements AhpTransport {
  readonly #frames: TransportFrame[] = [];
  readonly #waiting: ((frame: TransportFrame | null) => void)[] = [];
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: WebSocket.RawData) => {
      const frame: TransportFrame = { kind: "text", text: String(data) };
      const w = this.#waiting.shift();
      if (w) w(frame);
      else this.#frames.push(frame);
    });
    ws.on("close", () => this.#waiting.splice(0).forEach((w) => w(null)));
  }
  send(message: unknown) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }
  recv() {
    const frame = this.#frames.shift();
    return frame ? Promise.resolve(frame) : new Promise<TransportFrame | null>((r) => this.#waiting.push(r));
  }
  close() {
    this.ws.close();
  }
}
export async function client(url: string, id = `client-${Math.random()}`) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  const c = new AhpClient(new Socket(ws));
  c.connect();
  await c.initialize({ clientId: id, protocolVersions: [PROTOCOL_VERSION], initialSubscriptions: ["ahp-root://"] });
  return { c, ws, id };
}
export type Turn = { id: string; message: { text: string; origin: { kind: string } }; responseParts: { kind: string; content?: string; toolCall?: { toolName?: string; confirmed?: string } }[]; state: string };
// A chat's state as a client keeps it: its snapshot, then each action through the protocol's own reducer.
export async function follow(c: AhpClient, uri: URI) {
  const { result, subscription } = await c.subscribe(uri);
  const chat = { state: result.snapshot!.state as never as { turns: Turn[]; steeringMessage?: unknown; queuedMessages?: unknown[] }, seen: [] as ActionEnvelope[] };
  void (async () => {
    for await (const event of subscription) {
      if (event.type !== "action") continue;
      chat.seen.push(event.params);
      chat.state = chatReducer(chat.state as never, event.params.action as never) as never;
    }
  })();
  return chat;
}
export const until = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};
export const completed = (chat: { seen: ActionEnvelope[] }, from = 0) => () => chat.seen.slice(from).some((e) => (e.action.type as string) === "chat/turnComplete");
