// Optional offline integration with an installed Pi runtime, without API keys.
// node scripts/test-pi-native.mjs /path/to/node_modules/@earendil-works/pi-coding-agent
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import extension from "../pi-extension.mjs";
import { MAX_REQUEST_BODY_BYTES } from "../request-budget.mjs";

if (!process.argv[2]) throw new Error("Pass the installed pi-coding-agent package directory");
const root = path.resolve(process.argv[2]);
const fromPi = relative => import(pathToFileURL(path.join(root, relative)).href);
const { loadExtensions, loadExtensionFromFactory, createExtensionRuntime } = await fromPi("dist/core/extensions/loader.js");
const { ExtensionRunner } = await fromPi("dist/core/extensions/runner.js");
const { createEventBus } = await fromPi("dist/core/event-bus.js");
const { stream } = await fromPi("../pi-ai/dist/api/mistral-conversations.js");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-native-pi-"));
const requests = [];
const upstream = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  requests.push({ bytes: raw.length, payload: JSON.parse(raw.toString("utf8")) });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
try {
  execFileSync(process.execPath, [fileURLToPath(new URL("./install-pi.mjs", import.meta.url)), "--agent-dir", temporary], { stdio: "pipe" });
  const installed = path.join(temporary, "extensions", "mistral-request-budget", "index.ts");
  const loaded = await loadExtensions([installed], temporary);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].handlers.has("before_provider_request"));

  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const model = { id: "fixture", name: "fixture", provider: "mistral", api: "mistral-conversations", baseUrl: `http://127.0.0.1:${upstream.address().port}`, input: ["text", "image"], reasoning: false, contextWindow: 300000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const notices = [], errors = [];
  let controller;
  const ctx = { model, abort: () => controller.abort(), ui: { notify: (...args) => notices.push(args) } };
  const inline = await loadExtensionFromFactory(api => extension(api, { archiveDir: path.join(temporary, "archive") }), temporary, createEventBus(), createExtensionRuntime());
  const runner = { extensions: [inline], createContext: () => ctx, emitError: error => errors.push(error) };
  const run = async content => {
    controller = new AbortController();
    let terminal;
    for await (const event of stream(model, { messages: [{ role: "user", content, timestamp: Date.now() }] }, {
      apiKey: "offline-fixture-only", signal: controller.signal,
      onPayload: payload => ExtensionRunner.prototype.emitBeforeProviderRequest.call(runner, payload),
    })) if (event.type === "done" || event.type === "error") terminal = event;
    return terminal;
  };
  const images = Array.from({ length: 25 }, (_, index) => ({ type: "image", mimeType: "image/png", data: Buffer.alloc(320000, index).toString("base64") }));
  assert.equal((await run(images)).type, "done");
  assert.equal(requests.length, 1);
  assert.ok(requests[0].bytes < MAX_REQUEST_BODY_BYTES);
  assert.equal(requests[0].payload.messages.flatMap(message => message.content).filter(block => block.type === "image_url").length, 9);
  assert.equal(fs.readdirSync(path.join(temporary, "archive")).length, 16);
  assert.equal(errors.length, 0);

  const failure = await run([{ type: "text", text: "x".repeat(MAX_REQUEST_BODY_BYTES) }]);
  assert.equal(failure.type, "error");
  assert.equal(failure.reason, "aborted");
  assert.equal(controller.signal.aborted, true);
  assert.equal(requests.length, 1, "swallowed extension exception must not let an oversized request reach HTTP");
  assert.equal(errors.length, 1);
  assert.match(notices.at(-1)[0], /body too large/);
  console.log(`Pi ${JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version}: standalone extension loads; 25 screenshots -> 9 retained, 16 archived; native wire body ${requests[0].bytes} bytes; oversized text aborted before HTTP. Offline only.`);
} finally {
  await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  fs.rmSync(temporary, { recursive: true, force: true });
}
