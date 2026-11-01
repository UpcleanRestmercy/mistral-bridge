import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rewriteRequest, rewriteResponse, transformSse, createProxy, VERSION } from "./proxy.mjs";

const packet = (delta, finish_reason = null, index = 0) => ({ choices: [{ index, delta, finish_reason }] });
const frame = obj => `data: ${JSON.stringify(obj)}\n\n`;
const end = frame(packet({}, "stop")) + "data: [DONE]\n\n";
async function collect(parts) {
  let out = "";
  for await (const s of transformSse((async function* () { yield* parts; })())) out += s;
  return out;
}
const think = text => ({ type: "thinking", thinking: [{ type: "text", text }] });

test("separate thinking from exact Markdown, streaming and non-streaming", () => {
  const code = '```python\nprint("中文😀")\n```';
  for (const field of ["delta", "message"]) {
    const response = { choices: [{ [field]: { content: [think("推理"), { type: "text", text: code }] } }] };
    assert.deepEqual(rewriteResponse(response).choices[0][field], { content: code, reasoning_content: "推理" });
  }
});
test("history round trip retains reasoning, tool IDs, tool results, user text", () => {
  const body = { messages: [
    { role: "user", content: "<think>literal example</think>" },
    { role: "assistant", content: "正文", reasoning_content: "推理", tool_calls: [{ id: "call_1", function: { name: "echo", arguments: '{"x":"中文"}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "中文" },
  ] };
  const before = structuredClone(body);
  rewriteRequest(body);
  assert.deepEqual(body.messages[1].content, [think("推理"), { type: "text", text: "正文" }]);
  assert.ok(!("reasoning_content" in body.messages[1]));
  assert.deepEqual(body.messages[0], before.messages[0]);
  assert.deepEqual(body.messages[2], before.messages[2]);
  assert.deepEqual(body.messages[1].tool_calls, before.messages[1].tool_calls);
  assert.deepEqual(rewriteRequest(structuredClone(body)), body);
});
test("pi-ai's thinking switch is removed without losing effort or thinking history", () => {
  for (const type of ["enabled", "disabled"]) {
    const body = rewriteRequest({ thinking: { type }, reasoning_effort: "high", messages: [
      { role: "assistant", content: "answer", reasoning_content: "history reasoning" },
    ] });
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.messages[0].content[0].type, "thinking");
  }
});
test("UTF-8 and SSE survive every single-byte boundary", async () => {
  const s = frame(packet({ content: [think("思考😀"), { type: "text", text: "```js\n中文\n```" }] })) + end;
  const bytes = Buffer.from(s);
  const out = await collect([...bytes].map(b => Buffer.from([b])));
  assert.ok(!out.includes("�"));
  assert.ok(out.includes('"reasoning_content":"思考😀"'));
  assert.ok(out.endsWith("data: [DONE]\n\n"));
});
test("CRLF, comments, metadata and multiline data", async () => {
  const s = ': ping\r\n\r\nid: 3\r\ndata: {"choices":\r\ndata: [{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const out = await collect([...Buffer.from(s)].map(b => Buffer.from([b])));
  assert.ok(out.startsWith(": ping\n\n")); assert.ok(out.includes("id: 3\n")); assert.ok(out.includes('"content":"ok"'));
});
test("parallel tool fragments and usage are preserved", async () => {
  const tool = (index, id, name, args) => ({ index, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args } });
  const packets = [packet({ tool_calls: [tool(0, "a", "echo", '{"x":'), tool(1, "b", "sum", '{"n":')] }), packet({ tool_calls: [tool(1, null, null, '2}'), tool(0, null, null, '"中文"}')] }), packet({}, "tool_calls"), { choices: [], usage: { prompt_tokens: 7, completion_tokens: 8, total_tokens: 15 } }];
  const out = await collect([Buffer.from(packets.map(frame).join("") + "data: [DONE]\n\n")]);
  const decoded = out.split("\n\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
  assert.deepEqual(decoded, packets);
});
test("object tool arguments become JSON strings", () => {
  const r = rewriteResponse(packet({ tool_calls: [{ index: 0, id: "a", function: { name: "echo", arguments: { x: "中文" } } }] }));
  assert.equal(r.choices[0].delta.tool_calls[0].function.arguments, '{"x":"中文"}');
});
test("all choices are normalized", () => {
  const r = rewriteResponse({ choices: [0, 1].map(index => ({ index, delta: { content: [think(String(index))] } })) });
  assert.deepEqual(r.choices.map(c => c.delta.reasoning_content), ["0", "1"]);
});
test("content after DONE is not emitted", async () => {
  assert.equal(await collect([Buffer.from(end + frame(packet({ content: "unexpected" })))]), end);
});
for (const [name, stream, error] of [
  ["EOF without DONE", frame(packet({ content: "partial" })), /incomplete/],
  ["DONE without finish", frame(packet({ content: "partial" })) + "data: [DONE]\n\n", /missing_finish/],
  ["invalid JSON", "data: {broken}\n\n", /invalid_sse_json/],
  ["upstream error", frame({ error: { message: "private upstream detail" } }), /upstream_stream_error/],
  ["unknown content", frame(packet({ content: [{ type: "unknown" }] })), /unsupported_content/],
]) test(name, async () => { await assert.rejects(collect([Buffer.from(stream)]), error); });

async function fixture(t, handler, options = {}) {
  const up = http.createServer(handler);
  await new Promise(r => up.listen(0, "127.0.0.1", r));
  const logs = [];
  const bridge = createProxy({ upstream: `http://127.0.0.1:${up.address().port}`, log: m => logs.push(m), ...options });
  await new Promise(r => bridge.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await Promise.all([up, bridge].map(s => new Promise(r => { s.close(r); s.closeAllConnections(); })));
  });
  return { url: `http://127.0.0.1:${bridge.address().port}`, logs };
}
const post = url => fetch(url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: '{"stream":true,"messages":[]}' });
test("foreign Host and Origin are rejected before resolving credentials or forwarding", async t => {
  let resolved = 0, forwarded = 0;
  const { url } = await fixture(t, (_, res) => { forwarded++; res.end("{}"); }, {
    keyResolver: () => { resolved++; return "fixture-local-secret"; },
  });
  // Send literal HTTP so environment proxy policies cannot normalize Host.
  const request = (route, headers) => new Promise((resolve, reject) => {
    const address = new URL(url);
    const socket = net.connect({ host: "127.0.0.1", port: Number(address.port) }, () => {
      const fields = { host: address.host, connection: "close", authorization: "Bearer env:default", ...headers };
      socket.write(`GET ${route} HTTP/1.1\r\n${Object.entries(fields).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`);
    });
    let response = "";
    socket.on("data", chunk => { response += chunk; });
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1])));
    socket.on("error", reject);
  });
  for (const route of ["/healthz", "/v1/models"]) {
    for (const headers of [
      { host: "attacker.example" },
      { host: "127.0.0.1.attacker.example" },
      { host: "localhost:1" },
      { origin: "https://attacker.example" },
      { origin: "null" },
      { origin: "http://127.0.0.1:1" },
    ]) assert.equal(await request(route, headers), 403);
  }
  assert.equal(resolved, 0); assert.equal(forwarded, 0);
  assert.equal(await request("/v1/models", {}), 200);
  assert.equal(await request("/v1/models", { origin: url }), 200);
  assert.equal(resolved, 2); assert.equal(forwarded, 2);
});
test("HTTP errors retain status and body even for stream requests", async t => {
  for (const status of [400, 402, 404, 422, 429, 500]) {
    const payload = JSON.stringify({ error: { message: "fixture failure", code: "fixture" } });
    const { url } = await fixture(t, (_, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(payload); });
    const response = await post(url);
    assert.equal(response.status, status); assert.equal(await response.text(), payload);
  }
});
test("HTTP bridge transforms history and output; health reports version", async t => {
  let received;
  const { url, logs } = await fixture(t, async (req, res) => {
    let s = ""; for await (const b of req) s += b;
    received = JSON.parse(s);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frame(packet({ content: [think("secret reasoning"), { type: "text", text: "```js\n1\n```" }] })) + end);
  });
  const response = await fetch(url + "/v1/chat/completions", { method: "POST", body: JSON.stringify({ stream: true, messages: [{ role: "assistant", reasoning_content: "prior", content: "text" }] }) });
  assert.ok((await response.text()).includes('"reasoning_content":"secret reasoning"'));
  assert.deepEqual(received.messages[0].content, [think("prior"), { type: "text", text: "text" }]);
  assert.ok(!logs.join().includes("secret reasoning"));
  const health = await (await fetch(url + "/healthz")).json();
  assert.equal(health.version, VERSION); assert.equal(health.activeRequests, 0);
});
test("truncated tool stream breaks transport and is never retried", async t => {
  let requests = 0;
  const { url, logs } = await fixture(t, (_, res) => {
    requests++; res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame(packet({ tool_calls: [{ index: 0, id: "a", function: { name: "echo", arguments: '{"x":' } }] })));
    setTimeout(() => res.end(), 30);
  });
  const response = await post(url);
  await assert.rejects(response.text());
  assert.equal(requests, 1); assert.ok(logs.some(l => l.includes("upstream_stream_incomplete")));
});
test("client cancellation closes upstream", async t => {
  let resolveClosed;
  const closed = new Promise(r => { resolveClosed = r; });
  const { url } = await fixture(t, (_, res) => {
    res.on("close", resolveClosed);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame(packet({ content: "first" })));
  });
  const control = new AbortController();
  const response = await fetch(url + "/v1/chat/completions", { method: "POST", body: "{}", signal: control.signal });
  const reader = response.body.getReader(); await reader.read(); control.abort();
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("upstream not cancelled")), 1500); timer.unref(); })]);
});
test("idle upstream is explicitly failed", async t => {
  const { url, logs } = await fixture(t, () => {}, { idleMs: 50 });
  const response = await post(url);
  assert.equal(response.status, 502); assert.ok((await response.text()).includes("upstream_idle_timeout"));
  assert.ok(logs.some(l => l.includes("upstream_idle_timeout")));
});

function envFile(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-proxy-env-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, text);
  const previous = process.env.MISTRAL_BRIDGE_ENV;
  process.env.MISTRAL_BRIDGE_ENV = file;
  const saved = new Map();
  for (const name of Object.keys(process.env)) {
    if (/^MISTRAL_(API_KEY|MODELS)(_|$)/.test(name)) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  }
  t.after(() => {
    for (const [name, value] of saved) process.env[name] = value;
    if (previous === undefined) delete process.env.MISTRAL_BRIDGE_ENV;
    else process.env.MISTRAL_BRIDGE_ENV = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test("env: placeholders are resolved before the upstream request", async t => {
  envFile(t, "MISTRAL_API_KEY_WORK=real-secret-value\n");
  let authorization;
  const { url } = await fixture(t, (req, res) => {
    authorization = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const response = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer env:work" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(authorization, "Bearer real-secret-value");
});

test("a missing env key returns 401 without contacting upstream", async t => {
  envFile(t, "MISTRAL_API_KEY=only-default\n");
  let requests = 0;
  const { url, logs } = await fixture(t, (_, res) => { requests++; res.end("{}"); });
  const response = await fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer env:missing" },
    body: "{}",
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.code, "missing_env_key");
  assert.equal(requests, 0);
  assert.ok(logs.some(line => line.includes("missing_env_key")));
});

test("literal bearer tokens pass through unchanged", async t => {
  envFile(t, "MISTRAL_API_KEY=unused\n");
  let authorization;
  const { url } = await fixture(t, (req, res) => {
    authorization = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await fetch(url + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer literal-key" },
    body: "{}",
  });
  assert.equal(authorization, "Bearer literal-key");
});
