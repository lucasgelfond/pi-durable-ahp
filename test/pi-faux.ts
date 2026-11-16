// A model for tests (pi's faux provider, "faux/echo"): it answers "echo: <prompt>"; asked to "use a tool", it first
// runs `bash echo tooled`; asked to "wait", it takes 5 s.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "echo" }] });
  const reply = async (context: { messages: { role: string; content: unknown }[] }, options?: { signal?: AbortSignal }) => {
    const said = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join(""));
    const at = context.messages.map((m) => m.role).lastIndexOf("user");
    const prompt = at >= 0 ? said(context.messages[at]) : "";
    const tooled = context.messages.slice(at).some((m) => m.role === "toolResult");
    if (prompt.includes("use a tool") && !tooled) return fauxAssistantMessage(fauxToolCall("bash", { command: "echo tooled" }), { stopReason: "toolUse" });
    if (prompt.includes("wait")) await new Promise((r) => (setTimeout(r, 5000), options?.signal?.addEventListener("abort", r)));
    return fauxAssistantMessage(`echo: ${prompt}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => reply));
  pi.registerProvider(faux.provider);
}
