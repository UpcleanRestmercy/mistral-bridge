// Requires the host DSH peers. All provider traffic is redirected to a local fixture.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { BlockAssembler, createUserMessage, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import * as Bridge from "./dsh.mjs";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { LocalCredentialProvider } from "@deepseek-ai/dsh-credentials-local";
import { boot, initProfile, readProfilePatches } from "@deepseek-ai/dsh-app-boot";
import ConfigEditor from "@deepseek-ai/dsh-config-editor";
import Settings from "@deepseek-ai/dsh-settings";

test("real DSH registry coexists with pi-ai, streams thinking/tools, replays history and unloads", { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-dsh-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, "MISTRAL_API_KEY_DSH_INTEGRATION=fixture-key\nMISTRAL_MODELS_DSH_INTEGRATION=fixture-model\n");
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const bytes of req) body += bytes;
    requests.push({ headers: req.headers, body: JSON.parse(body) });
    if ("thinking" in requests.at(-1).body) {
      res.writeHead(422, { "content-type": "application/json" });
      res.end('{"error":{"message":"Extra inputs are not permitted: thinking"}}');
      return;
    }
    if (requests.length === 3) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
      return;
    }
    const first = requests.length === 1;
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(chunk({ role: "assistant", content: [{ type: "thinking", thinking: [{ type: "text", text: "推理😀" }] }] })
      + (first ? chunk({ tool_calls: [{ index: 0, id: "call_demo", type: "function", function: { name: "echo", arguments: '{"value":"中文"}' } }] })
        : chunk({ content: [{ type: "text", text: "```js\n中文😀\n```" }] }))
      + chunk({}, first ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => nativeFetch(typeof input === "string" && input.startsWith("https://api.mistral.ai/")
    ? input.replace("https://api.mistral.ai", `http://127.0.0.1:${upstream.address().port}`) : input, init);
  t.after(() => { globalThis.fetch = nativeFetch; });
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(PiAi, { providers: {} });
  const before = ctx.llm.listProviders().map(provider => provider.id);
  const fiber = ctx.plugin(Bridge, { envFile: file });
  await fiber.await();
  const provider = "mistral-dsh-integration";
  assert.ok(ctx.llm.listProviders().some(route => route.id === provider), JSON.stringify(ctx.llm.listProviders()));
  assert.deepEqual((await ctx.llm.listModels(provider)).map(model => model.id), ["fixture-model"]);
  const info = await ctx.llm.resolveModelInfo(provider, "fixture-model");
  assert.ok(JSON.stringify(info).includes("high"));
  assert.deepEqual(info.reasoning.efforts.map(level => level.id), ["low", "high", "max"]);
  await assert.rejects(ctx.llm.resolveCallConfig({ provider, model: "fixture-model", reasoningEffort: "off" }));
  const user = createUserMessage({ content: [{ type: "text", text: "fixture only" }] });
  const tools = [{ name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }];
  const run = async messages => {
    const assembler = new BlockAssembler();
    for await (const chunk of ctx.llm.stream({ provider, model: "fixture-model", messages, tools, reasoningEffort: "high" })) assembler.push(chunk);
    // DSH may deliver provider failures as a typed finish chunk.
    if (assembler.finish.kind === "error") throw new Error(assembler.finish.failure.message);
    return assembler.message({ provider, model: "fixture-model", replayState: assembler.replayState });
  };
  const first = await run([user]);
  assert.ok(JSON.stringify(first).includes("推理😀"));
  const call = first.content.find(block => block.type === "tool-call");
  assert.ok(call, JSON.stringify(first));
  const result = createToolResultMessage({ callId: call.id, content: [{ type: "text", text: "中文" }], isError: false });
  const second = await run([user, first, result]);
  assert.ok(JSON.stringify(second).includes("```js\\n中文😀\\n```"));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.authorization, "Bearer fixture-key");
  assert.equal(requests[0].body.reasoning_effort, "high");
  assert.equal(requests[0].body.thinking, undefined);
  assert.equal(requests[1].body.messages.find(message => message.role === "assistant").content[0].type, "thinking");
  assert.ok(requests[1].body.messages.some(message => message.role === "tool"));
  fs.writeFileSync(file, "# removed account\n");
  await assert.rejects(run([user]));
  assert.equal(requests.length, 2, "missing key must never reach the upstream");
  fs.writeFileSync(file, "MISTRAL_API_KEY_DSH_INTEGRATION=rotated-fixture-key\n");
  await assert.rejects(run([user]));
  assert.equal(requests.length, 3, "a truncated response must not be retried");
  assert.equal(requests[2].headers.authorization, "Bearer rotated-fixture-key");
  await fiber.dispose();
  assert.deepEqual(ctx.llm.listProviders().map(route => route.id), before);
});

test("native DSH setup, live key rotation, legacy cold upgrade and restart without dotenv", { timeout: 15000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-default-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, "# fresh installation, no keys\n");
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "think", capabilities: { completion_chat: true, reasoning: true } }, { id: "plain", capabilities: { completion_chat: true, reasoning: false } }] }));
      return;
    }
    for await (const _bytes of req) { /* consume the synthetic request */ }
    requests.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => nativeFetch(typeof input === "string" && input.startsWith("https://api.mistral.ai/")
    ? input.replace("https://api.mistral.ai", `http://127.0.0.1:${upstream.address().port}`) : input, init);
  t.after(() => { globalThis.fetch = nativeFetch; });
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(LocalCredentialProvider, { path: path.join(dir, "credentials.yaml"), watch: false });
  await ctx.plugin(Loader);
  ctx.loader.builtins.pi = PiAi;
  const id = await ctx.loader.create({ id: "llm-pi-ai", name: "cordis:pi", config: { providers: {} } });
  const entry = ctx.loader.resolve(id);
  await entry.fiber.await();
  let revision = 0;
  // The same Loader updates as Settings.mutate, without requiring a full application profile.
  ctx.provide("settings", {
    configure: () => () => {},
    describe: () => [{ ns: "llm-pi-ai", value: entry.options.config, revision }],
    mutate: async (ns, ops, expected) => {
      assert.equal(ns, "llm-pi-ai"); assert.equal(expected, revision);
      const next = structuredClone(entry.options.config);
      for (const op of ops) next.providers[op.path[1]] = op.value;
      await entry.update({ config: next });
      await entry.fiber.await();
      revision++;
    },
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("native route did not register")), 10000);
    ctx.on("llm/adapters-updated", () => {
      if (ctx.llm.listProviders().some(route => route.id === "mistral-default")) { clearTimeout(timer); resolve(); }
    });
  });
  const fiber = ctx.plugin(Bridge, { envFile: file });
  await fiber.await(); await ready;
  assert.ok(ctx.llm.listConfigurableProviders().some(route => route.provider === "mistral-default" && route.settingsNs === "llm-pi-ai"));
  assert.deepEqual(await ctx.llm.listModels("mistral-default"), []);
  // This is the credential-service write performed by the existing Models API-key field.
  await ctx.credentials.set("MISTRAL_API_KEY", "fixture-native");
  const deadline = Date.now() + 3000;
  while ((await ctx.llm.listModels("mistral-default")).length !== 2) {
    assert.ok(Date.now() < deadline, "models did not refresh after the first key was saved");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual((await ctx.llm.listModels("mistral-default")).map(model => model.id), ["think", "plain"]);
  assert.ok(!JSON.stringify(entry.options.config).includes("fixture-native"));
  const run = async model => {
    const assembler = new BlockAssembler();
    for await (const chunk of ctx.llm.stream({ provider: "mistral-default", model, messages: [] })) assembler.push(chunk);
    assert.equal(assembler.finish.kind, "stop");
  };
  await run("plain");
  await ctx.credentials.set("MISTRAL_API_KEY", "rotated-native");
  await run("think");
  assert.deepEqual(requests, ["Bearer fixture-native", "Bearer rotated-native"]);
  await fiber.dispose();

  // Upgrade the actual pre-marker native layout after its ephemeral listener
  // has stopped. This is the existing-installation path missed by fresh setup.
  const legacy = structuredClone(entry.options.config.providers["mistral-default"]);
  delete legacy.headers;
  const staleBase = legacy.baseURL;
  await assert.rejects(nativeFetch(staleBase.replace("/v1", "/healthz")));
  await ctx.settings.mutate("llm-pi-ai", [{ op: "set", path: ["providers", "mistral-default"], value: legacy }], revision);
  fs.writeFileSync(file, "MISTRAL_API_KEY=rotated-native\n");
  const waitForNativeEndpoint = async () => {
    const deadline = Date.now() + 3000;
    while (true) {
      const profile = entry.options.config.providers["mistral-default"];
      if (profile.headers?.["x-mistral-bridge"] === `mistral-bridge/1 ${profile.baseURL}`) {
        try {
          if ((await nativeFetch(profile.baseURL.replace("/v1", "/healthz"))).ok) return;
        } catch {}
      }
      assert.ok(Date.now() < deadline, "legacy route did not migrate from its dead endpoint");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const upgraded = ctx.plugin(Bridge, { envFile: file });
  await upgraded.await(); await waitForNativeEndpoint();
  assert.equal(entry.options.config.providers["mistral-default"].baseURL, staleBase, "cold upgrade should reuse the existing free bridge port");
  assert.equal(entry.options.config.providers["mistral-default"].displayName, legacy.displayName);
  await run("plain");
  assert.equal(requests.at(-1), "Bearer rotated-native");
  await upgraded.dispose();

  // Migration is one-time: subsequent cold boots use native credentials and
  // the persisted marker, without needing any legacy dotenv keys.
  fs.writeFileSync(file, "# no dotenv needed after migration\n");
  const restarted = ctx.plugin(Bridge, { envFile: file });
  await restarted.await(); await waitForNativeEndpoint();
  assert.equal(entry.options.config.providers["mistral-default"].baseURL, staleBase, "native restarts should retain the same available endpoint");
  await run("think");
  assert.equal(requests.at(-1), "Bearer rotated-native");
  await restarted.dispose();
});

test("real Settings and ConfigEditor persist a live native endpoint through profile reconciliation", { timeout: 15000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-real-settings-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "profiles", "test");
  initProfile(dir, []);
  fs.writeFileSync(path.join(dir, "cordis.yml"), "[]\n");
  fs.writeFileSync(path.join(home, "package.json"), '{"name":"fixture-installation"}\n');
  const envFile = path.join(home, ".env");
  fs.writeFileSync(envFile, "MISTRAL_API_KEY=fixture-real-settings\nMISTRAL_MODELS=fixture-model\n");
  const credentialFile = path.join(home, "credentials.yaml");
  fs.writeFileSync(credentialFile, 'version: 1\nrefs:\n  MISTRAL_API_KEY: fixture-real-settings\n', { mode: 0o600 });
  const legacy = Bridge.providerProfiles([{ name: "default", models: ["fixture-model"] }], "http://127.0.0.1:1/v1", Bridge.resolveOptions())["mistral-default"];
  delete legacy.headers;
  fs.writeFileSync(path.join(dir, "cordis.patch.yml"), JSON.stringify([{ insert: [
    { id: "llm", name: "cordis:llm" },
    { id: "llm-pi-ai", name: "cordis:pi", config: { providers: { "mistral-default": legacy } } },
    { id: "config-editor", name: "cordis:editor" },
    { id: "settings", name: "cordis:settings" },
    { id: "credentials-local", name: "cordis:credentials", config: { path: credentialFile, watch: false } },
    { id: "mistral-bridge", name: "cordis:bridge", config: { envFile } },
  ] }]));
  const profile = { name: "test", startedBundles: [], dir, patchPath: path.join(dir, "cordis.patch.yml"), installAnchor: path.join(home, "package.json"), cwd: home, home, overlays: [] };
  const ctx = await boot("dsh", path.join(dir, "cordis.yml"), readProfilePatches("dsh", profile), ctx => {
    ctx.provide("profileContext", profile);
    ctx.provide("appReady", { onReady: listener => { listener(); return () => {}; } });
    Object.assign(ctx.loader.builtins, { llm: LlmRuntime, pi: PiAi, editor: ConfigEditor, settings: Settings, credentials: LocalCredentialProvider, bridge: Bridge });
  });
  t.after(() => ctx.fiber.dispose());
  assert.ok(ctx.settings, JSON.stringify([...ctx.loader.entries()].map(entry => ({ id: entry.options.id, name: entry.options.name, state: entry.fiber?.state }))));
  const current = () => ctx.settings.describe().find(section => section.ns === "llm-pi-ai");
  const deadline = Date.now() + 5000;
  let base;
  while (true) {
    const value = current()?.value.providers?.["mistral-default"];
    if (value?.baseURL !== legacy.baseURL && value?.headers?.["x-mistral-bridge"] === `mistral-bridge/1 ${value.baseURL}`) { base = value.baseURL; break; }
    assert.ok(Date.now() < deadline, "real settings did not apply the native endpoint");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await fetch(base.replace("/v1", "/healthz"))).status, 200);
  await ctx.settings.mutate("llm-pi-ai", [{ op: "set", path: ["providers", "mistral-default", "displayName"], value: "Vibe" }], current().revision);
  const saved = current().value.providers["mistral-default"];
  assert.equal((await fetch(saved.baseURL.replace("/v1", "/healthz"))).status, 200);
  const bridgeEntry = [...ctx.loader.entries()].find(entry => entry.options.id === "mistral-bridge");
  await bridgeEntry.update({ config: { envFile, refreshModels: 1 } });
  await ctx.loader.await();
  assert.equal(current().value.providers["mistral-default"].baseURL, saved.baseURL);
  assert.equal((await fetch(saved.baseURL.replace("/v1", "/healthz"))).status, 200, "bridge reload must retain the endpoint used by the native adapter");
});
