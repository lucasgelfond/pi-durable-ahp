// A scripted ACP agent on stdin and stdout, as Claude Code's or pi's adapter would be started (acp-sessions.test.ts):
// "edit FILE" edits a file (a diff), "ask FILE" asks permission first, "think …" thinks aloud, "plan …" makes a plan,
// "slow …" answers at length (a turn to cancel or steer), anything else is echoed. Its sessions are kept in
// AGENT_STATE, so a new process loads one (session/load replays it); NO_LOAD=1 makes an agent that can't.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const file = process.env.AGENT_STATE!;
const canLoad = process.env.NO_LOAD !== "1";
type Said = { role: "user" | "agent"; text: string };
const sessions: Record<string, Said[]> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const save = () => writeFileSync(file, JSON.stringify(sessions));
const text = (t: string) => ({ type: "text" as const, text: t });
const cancelled = new Set<string>();
const steered = new Map<string, string[]>();
let n = 0;

acp
  .agent({ name: "scripted" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: { name: "scripted", version: "0" },
    agentCapabilities: { loadSession: canLoad, _meta: { steering: { supported: true } } },
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, () => {
    const sessionId = `s-${process.pid}-${++n}`;
    sessions[sessionId] = [];
    save();
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    const said = sessions[params.sessionId];
    if (!said) throw acp.RequestError.resourceNotFound(params.sessionId);
    for (const s of said)
      await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: s.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: text(s.text) } });
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => void cancelled.add(params.sessionId))
  .onRequest("_session/steering", (raw) => raw as { sessionId: string; prompt: acp.ContentBlock[] }, ({ params }) => {
    const list = steered.get(params.sessionId);
    if (!list) return { outcome: "promptRequired" };
    list.push(params.prompt.map((b) => (b.type === "text" ? b.text : "")).join(""));
    return { outcome: "injected" };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const sessionId = params.sessionId;
    const asked = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    const update = (u: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId, update: u });
    const said = (sessions[sessionId] ??= []);
    said.push({ role: "user", text: asked });
    cancelled.delete(sessionId);
    steered.set(sessionId, []);
    let answer = `echo: ${asked}`;
    try {
      const edit = asked.match(/^(edit|ask) (\S+)$/);
      if (edit) {
        const path = `/work/${edit[2]}`;
        const call = `call-${++n}`;
        await update({ sessionUpdate: "tool_call", toolCallId: call, title: `Edit ${edit[2]}`, kind: "edit", status: "pending", locations: [{ path }], rawInput: { path } });
        if (edit[1] === "ask") {
          const { outcome } = await client.request(acp.methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId: call, title: `Edit ${edit[2]}`, kind: "edit" },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              { optionId: "always", name: "Always allow", kind: "allow_always" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          });
          const allowed = outcome.outcome === "selected" && outcome.optionId !== "no";
          if (!allowed) {
            await update({ sessionUpdate: "tool_call_update", toolCallId: call, status: "failed", content: [{ type: "content", content: text("not allowed") }] });
            answer = `not allowed (${outcome.outcome === "selected" ? outcome.optionId : "cancelled"})`;
            if (outcome.outcome === "cancelled") return { stopReason: "cancelled" };
            await update({ sessionUpdate: "agent_message_chunk", content: text(answer) });
            return { stopReason: "end_turn" };
          }
          answer = `edited, as ${outcome.optionId}`;
        } else answer = "edited";
        await update({ sessionUpdate: "tool_call_update", toolCallId: call, status: "in_progress" });
        await update({ sessionUpdate: "tool_call_update", toolCallId: call, status: "completed", content: [{ type: "diff", path, oldText: "old line", newText: "new line" }] });
      } else if (asked.startsWith("think ")) {
        await update({ sessionUpdate: "agent_thought_chunk", content: text("let me see") });
        answer = `thought about ${asked.slice(6)}`;
      } else if (asked.startsWith("plan ")) {
        await update({ sessionUpdate: "plan", entries: [{ content: "look", priority: "high", status: "completed" }, { content: asked.slice(5), priority: "medium", status: "pending" }] });
        answer = "planned";
      } else if (asked.startsWith("slow")) {
        for (let i = 0; i < 40; i++) {
          if (cancelled.has(sessionId)) return { stopReason: "cancelled" };
          await update({ sessionUpdate: "agent_message_chunk", content: text("and so on ") });
          await new Promise((r) => setTimeout(r, 25));
        }
        const more = steered.get(sessionId) ?? [];
        answer = more.length ? `steered: ${more.join(", ")}` : "done slowly";
      }
      await update({ sessionUpdate: "agent_message_chunk", content: text(answer) });
      await update({ sessionUpdate: "usage_update", used: 1234, size: 100_000 });
      return { stopReason: "end_turn" };
    } finally {
      steered.delete(sessionId);
      said.push({ role: "agent", text: answer });
      save();
    }
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
