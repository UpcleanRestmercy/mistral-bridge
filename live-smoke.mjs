// Opt-in paid ZCode smoke test using native Models keys or legacy dotenv.
// Sends synthetic prompts only; no generated tools are executed.
import assert from "node:assert/strict";
import { zcodeKeys, nativeProviders } from "./zcode-source.mjs";
import { DEFAULT_PORT, readState } from "./port.mjs";
import { loopbackBase } from "./ownership.mjs";

if (process.argv.includes("--help")) {
  console.log("Usage: node live-smoke.mjs [account-name] [model]\nZCode only: reads native Models settings first, then legacy dotenv. Requires a running ZCode daemon. Sends paid synthetic generation requests. For DSH, verify generation in its native Models UI; this script cannot read the DSH credential service.");
  process.exit(0);
}
const name = process.argv[2] || "default";
const entry = zcodeKeys().find(item => item.name === name);
if (!entry?.key) throw new Error("No key for this ZCode account. Enter it in Models settings or import legacy dotenv. DSH native credentials are not accessible to this script; use its Models UI.");
const provider = nativeProviders().find(row => row.providerId === entry.nativeId);
const model = process.argv[3] || entry.models?.[0] || provider?.config?.personalModelIds?.[0] || "zai-glm-latest";
const port = readState()?.port || DEFAULT_PORT;
const base = process.env.MISTRAL_BRIDGE_URL || provider?.config?.api?.baseUrl || `http://127.0.0.1:${port}/v1`;
if (!loopbackBase(base)) throw new Error("Smoke test requires a local bridge /v1 endpoint");
const health = await fetch(base.replace(/\/v1\/?$/, "/healthz"), { redirect: "error", signal: AbortSignal.timeout(2000) });
const identity = await health.json();
if (!health.ok || identity.service !== "mistral-bridge" || identity.role !== "zcode-daemon") throw new Error("Smoke test requires a running ZCode daemon, not a DSH or foreign listener");

async function call(messages, extra = {}) {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(120000),
    headers: { "content-type": "application/json", authorization: `Bearer ${entry.key}` },
    body: JSON.stringify({ model, stream: true, reasoning_effort: "high", max_tokens: 1800, messages, ...extra }),
  });
  if (!response.ok) {
    await response.body.cancel();
    throw new Error(`Upstream HTTP ${response.status}`);
  }
  const result = { role: "assistant", content: "", reasoning_content: "", tool_calls: [] };
  const decoder = new TextDecoder();
  let buffer = "", done = false, finish;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let at;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const event = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data === "[DONE]") { done = true; continue; }
      if (!data) continue;
      const obj = JSON.parse(data);
      if (obj.error) throw new Error("Bridge stream error");
      const choice = obj.choices?.[0];
      if (!choice) continue;
      finish = choice.finish_reason ?? finish;
      const delta = choice.delta || {};
      assert.ok(!Array.isArray(delta.content));
      result.content += delta.content || "";
      result.reasoning_content += delta.reasoning_content || "";
      for (const tool of delta.tool_calls || []) {
        const index = tool.index ?? result.tool_calls.length;
        const target = result.tool_calls[index] ||= { type: "function", id: tool.id, function: { name: "", arguments: "" } };
        if (tool.id) target.id = tool.id;
        if (tool.function?.name) target.function.name = tool.function.name;
        target.function.arguments += tool.function?.arguments || "";
      }
    }
  }
  assert.ok(done, "Missing DONE");
  assert.ok(finish && finish !== "length", "Incomplete completion");
  assert.ok(!result.content.includes("<think"), "Literal think tag leaked into content");
  assert.ok(!result.content.includes("\uFFFD"), "Invalid UTF-8 replacement character");
  return { message: result, finish };
}

const messages = [{
  role: "user",
  content: "This is a bridge acceptance test. Call bridge_echo exactly once with text 中文测试😀. After the tool result, reply briefly with a fenced python code block that prints that exact text. Do not access files or use other tools.",
}];
const first = await call(messages, {
  tools: [{
    type: "function",
    function: {
      name: "bridge_echo",
      description: "Echo synthetic acceptance text",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  }],
  tool_choice: { type: "function", function: { name: "bridge_echo" } },
});
assert.equal(first.finish, "tool_calls");
assert.equal(first.message.tool_calls.length, 1);
const tool = first.message.tool_calls[0];
assert.equal(tool.function.name, "bridge_echo");
assert.ok(tool.id);
assert.equal(JSON.parse(tool.function.arguments).text, "中文测试😀");

messages.push(first.message, { role: "tool", tool_call_id: tool.id, name: tool.function.name, content: "中文测试😀" });
const second = await call(messages);
assert.ok(second.message.content.includes("```python\n"), "Missing standalone code fence");
assert.ok(second.message.content.includes("中文测试😀"));
assert.ok(first.message.reasoning_content.length + second.message.reasoning_content.length > 0, "No reasoning returned");

console.log(JSON.stringify({
  account: name,
  model,
  base,
  toolCall: "PASS",
  chineseArguments: "PASS",
  historyRoundTrip: "PASS",
  reasoningField: "PASS",
  markdownCode: "PASS",
  normalStreamCompletion: "PASS",
  reasoningCharacters: [first.message.reasoning_content.length, second.message.reasoning_content.length],
  finish: [first.finish, second.finish],
}));
