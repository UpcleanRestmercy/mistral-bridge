import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extension, { prepareMistralRequest } from "./pi-extension.mjs";
import { MAX_REQUEST_BODY_BYTES } from "./request-budget.mjs";

function setup(t) {
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-pi-budget-"));
  t.after(() => fs.rmSync(archiveDir, { recursive: true, force: true }));
  return { archiveDir };
}
const image = index => ({ type: "image_url", imageUrl: `data:image/png;base64,${Buffer.alloc(320000, index).toString("base64")}` });
test("native Pi budgets real base64 bytes, archives oldest screenshots and preserves history/tools", t => {
  const options = setup(t);
  const payload = { model: "fixture", messages: [
    { role: "system", content: "system 中文😀" },
    { role: "user", content: Array.from({ length: 25 }, (_, index) => image(index)) },
    { role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "reason" }] }], toolCalls: [{ id: "call", function: { name: "echo", arguments: "{}" } }] },
    { role: "tool", toolCallId: "call", content: "result" },
  ], tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }] };
  const before = JSON.stringify(payload);
  const result = prepareMistralRequest(payload, options);
  assert.equal(result.archived.length, 16);
  assert.ok(result.imageBytes <= 4 * 1024 * 1024);
  assert.ok(result.bodyBytes < MAX_REQUEST_BODY_BYTES);
  assert.equal(JSON.stringify(payload), before);
  assert.deepEqual(result.payload.messages[1].content.at(-1), payload.messages[1].content.at(-1));
  assert.deepEqual(result.payload.messages.slice(2), payload.messages.slice(2));
  assert.deepEqual(result.payload.tools, payload.tools);
  assert.deepEqual(fs.readFileSync(result.archived[0]), Buffer.alloc(320000));
  assert.ok(result.payload.messages[1].content[0].text.includes(JSON.stringify(result.archived[0])));
  assert.deepEqual(prepareMistralRequest(payload, options).archived, result.archived, "replay reuses content-addressed originals");
});
test("Pi archives the oldest images beyond Mistral's 20-image request limit", t => {
  const options = setup(t);
  const tiny = index => ({ type: "image_url", imageUrl: `data:image/png;base64,${Buffer.from([index]).toString("base64")}` });
  const payload = { model: "fixture", messages: [{ role: "user", content: Array.from({ length: 23 }, (_, index) => tiny(index)) }] };
  const result = prepareMistralRequest(payload, options);
  assert.equal(result.archived.length, 3);
  const kept = result.payload.messages[0].content.filter(block => block.type === "image_url");
  assert.equal(kept.length, 20);
  assert.deepEqual(kept, payload.messages[0].content.slice(3));
  assert.match(result.payload.messages[0].content[0].text, /request limits/);
});
test("Pi counts UTF-8 text and schemas even if images fit their separate budget", t => {
  const payload = { messages: [{ role: "user", content: [image(0), image(1), { type: "text", text: "中文😀".repeat(380000) }] }], tools: [{ description: "x".repeat(4000000) }] };
  const result = prepareMistralRequest(payload, setup(t));
  assert.equal(result.archived.length, 1, "full-body pressure offloads before the image target is reached");
  assert.ok(result.bodyBytes < MAX_REQUEST_BODY_BYTES - 65536);
  assert.deepEqual(result.payload.messages[0].content.at(-2), image(1));
});
test("Pi leaves small payloads unchanged and refuses text-only or newest-image overflow", t => {
  const options = setup(t);
  const small = { messages: [{ role: "user", content: [image(0)] }] };
  assert.deepEqual(prepareMistralRequest(small, options).payload, small);
  assert.equal(fs.readdirSync(options.archiveDir).length, 0);
  for (const content of ["x".repeat(MAX_REQUEST_BODY_BYTES), [{ type: "image_url", imageUrl: "data:image/png;base64," + "A".repeat(MAX_REQUEST_BODY_BYTES) }]]) {
    assert.throws(() => prepareMistralRequest({ messages: [{ role: "user", content }] }, options), /Request cancelled before sending/);
  }
});
test("Pi hook only handles native Mistral and explicitly aborts instead of relying on a swallowed exception", t => {
  let hook, aborted = 0;
  const notices = [];
  extension({ on: (event, handler) => { assert.equal(event, "before_provider_request"); hook = handler; } }, setup(t));
  const ctx = { model: { provider: "mistral", api: "mistral-conversations" }, abort: () => { aborted++; }, ui: { notify: (...args) => notices.push(args) } };
  const huge = { messages: [{ role: "user", content: "x".repeat(MAX_REQUEST_BODY_BYTES) }] };
  for (const model of [{ provider: "anthropic", api: "anthropic-messages" }, { provider: "mistral", api: "openai-completions" }]) {
    assert.equal(hook({ payload: huge }, { ...ctx, model }), undefined);
  }
  assert.equal(aborted, 0);
  assert.throws(() => hook({ payload: huge }, ctx), /body too large/);
  assert.equal(aborted, 1);
  assert.equal(notices.at(-1)[1], "error");
});
