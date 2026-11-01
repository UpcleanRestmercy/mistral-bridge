import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { chatModels, discoverModels } from "./catalog.mjs";
import { syncZcode } from "./zcode-config.mjs";
import { nativeProviders } from "./zcode-source.mjs";
import { rememberProviders } from "./ownership.mjs";

test("catalog admits chat models and keeps reasoning, vision and context declarations", () => {
  const models = chatModels({ data: [
    { id: "embed", capabilities: { completion_chat: false } },
    { id: "chat", max_context_length: 1048576, capabilities: { completion_chat: true, vision: true, reasoning: true } },
    { id: "plain", capabilities: { completion_chat: true, reasoning: false } },
  ] });
  assert.deepEqual(models.map(model => model.id), ["chat", "plain"]);
  assert.equal(models[0].contextWindow, 1048576);
  assert.equal(models[0].vision, true);
  assert.equal(models[1].reasoning, false);
  assert.throws(() => chatModels({ data: [] }), /no chat models/);
});

test("model discovery is credential-scoped and never returns the key in HTTP failures", async t => {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push(req.headers.authorization);
    if (req.headers.authorization === "Bearer denied-fixture") { res.writeHead(401); res.end("denied-fixture"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: req.headers.authorization.endsWith("one") ? "one" : "two", capabilities: { completion_chat: true } }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const options = { baseURL: `http://127.0.0.1:${server.address().port}` };
  assert.equal((await discoverModels("one", options))[0].id, "one");
  await discoverModels("one", options);
  assert.equal((await discoverModels("two", options))[0].id, "two");
  assert.equal(received.length, 2);
  await assert.rejects(discoverModels("denied-fixture", options), error => error.message.includes("401") && !error.message.includes("denied-fixture"));
});

test("ZCode merges verified duplicates into old Vibe/Mistral identities and preserves unrelated accounts", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-migrate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "providers.json");
  const provider = (providerId, providerName, apiKey) => ({ providerId, providerName, config: { access: { apiKey }, api: { baseUrl: "http://127.0.0.1:8791/v1" } } });
  const unrelated = provider("mistral-other", "Unrelated", "different-fixture");
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, config: {
    providerOrder: ["mistral-vibe", "mistral-arBx", "mistral-default", "mistral-arbx", "mistral-other"],
    providerConfigRules: { providerRules: [provider("mistral-vibe", "Vibe", "one"), provider("mistral-arBx", "Mistral", "two"), provider("mistral-default", "Mistral", "env:default"), provider("mistral-arbx", "Mistral (arbx)", "env:arbx"), unrelated] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [{ providerId: "mistral-default", modelId: "custom" }] },
    defaultModelSelection: { providerId: "mistral-arbx", modelId: "model" },
  } }));
  const accounts = [{ name: "default", key: "one", envVar: "MISTRAL_API_KEY" }, { name: "arbx", key: "two", envVar: "MISTRAL_API_KEY_ARBX" }];
  const ownershipFile = path.join(dir, "ownership.json");
  rememberProviders(["mistral-vibe", "mistral-arBx", "mistral-default", "mistral-arbx"].map(providerId => ({ providerId, base: "http://127.0.0.1:8791/v1" })), ownershipFile);
  const options = { configPath: file, ownershipFile, base: "http://127.0.0.1:8792/v1", accounts, discover: async () => [{ id: "chat", contextWindow: 1048576, vision: true, reasoning: true }, { id: "plain", contextWindow: 32000, vision: false, reasoning: false }] };
  await syncZcode({}, options);
  const { config } = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(config.providerConfigRules.providerRules.map(rule => [rule.providerId, rule.providerName]), [["mistral-vibe", "Vibe"], ["mistral-arBx", "Mistral"], ["mistral-other", "Unrelated"]]);
  assert.equal(config.defaultModelSelection.providerId, "mistral-arBx");
  assert.equal(config.modelConfigRules.manualProviderModelRules[0].providerId, "mistral-vibe");
  assert.equal(config.providerConfigRules.providerRules[0].config.access.apiKey, "env:default");
  assert.deepEqual(config.providerConfigRules.providerRules[0].config.personalModelIds, ["chat", "plain"]);
  assert.equal(config.modelConfigRules.providerModelRules.find(rule => rule.modelId === "plain").config.optionSpecs.reasoningLevel, undefined);
  assert.deepEqual(config.providerConfigRules.providerRules[2], unrelated);
  assert.equal((await syncZcode({}, options)).changed, false);
  const beforeOutage = JSON.parse(fs.readFileSync(file)).config.modelConfigRules.providerModelRules;
  await syncZcode({}, { ...options, discover: async () => { throw new Error("synthetic discovery outage"); } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).config.modelConfigRules.providerModelRules, beforeOutage);
});

test("ZCode reads existing provider credentials only for bridge routes", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-options-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  const owned = { providerId: "mistral-vibe", config: { api: { baseUrl: "http://127.0.0.1:8791/v1" }, access: { apiKey: "fixture" } } };
  fs.writeFileSync(file, JSON.stringify({ config: { providerConfigRules: { providerRules: [owned, { providerId: "other", config: { access: { apiKey: "wrong" } } }] } } }));
  assert.deepEqual(nativeProviders(file, { "mistral-vibe": ["http://127.0.0.1:8791/v1"] }), [owned]);
  assert.deepEqual(nativeProviders(file, {}), []);
});

test("a fresh ZCode install creates a native key editor without dotenv or discovery", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-fresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, "providers.json");
  const options = { configPath, ownershipFile: path.join(dir, "ownership.json"), base: "http://127.0.0.1:12345/v1", accounts: [], discover: () => assert.fail("must not contact upstream without a key") };
  await syncZcode({}, options);
  const rules = JSON.parse(fs.readFileSync(configPath)).config.providerConfigRules.providerRules;
  assert.equal(rules.length, 1);
  assert.equal(rules[0].providerId, "mistral-default");
  assert.equal(rules[0].providerName, "Mistral");
  assert.deepEqual(rules[0].config.access, { type: "api-key", apiKey: "" });
  assert.equal(rules[0].config.api.baseUrl, "http://127.0.0.1:12345/v1");
  fs.writeFileSync(configPath, JSON.stringify({ config: { providerOrder: [], providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }));
  await syncZcode({}, options);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).config.providerConfigRules.providerRules, [], "an explicitly removed last provider must stay removed");
});

test("default ZCode source never discovers or rewrites an unrelated local gateway", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-ownership-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gateway = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined);
    res.end('{"service":"private-gateway"}');
  });
  await new Promise(resolve => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); }));
  const configPath = path.join(dir, "providers.json");
  const unrelated = { providerId: "mistral-private", providerName: "Private", config: { api: { baseUrl: `http://127.0.0.1:${gateway.address().port}/v1` }, access: { apiKey: "private-gateway-fixture" }, personalModelIds: ["private-model"], extraOption: true } };
  fs.writeFileSync(configPath, JSON.stringify({ config: { providerOrder: [unrelated.providerId], providerConfigRules: { providerRules: [unrelated] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] } } }));
  const previous = process.env.MISTRAL_BRIDGE_ENV;
  const envFile = path.join(dir, ".env"); fs.writeFileSync(envFile, "# empty\n");
  process.env.MISTRAL_BRIDGE_ENV = envFile;
  const saved = new Map(Object.entries(process.env).filter(([name]) => /^MISTRAL_(API_KEY|MODELS)(_|$)/.test(name)));
  for (const name of saved.keys()) delete process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env.MISTRAL_BRIDGE_ENV; else process.env.MISTRAL_BRIDGE_ENV = previous;
    for (const [name, value] of saved) process.env[name] = value;
  });
  await syncZcode({}, { configPath, ownershipFile: path.join(dir, "ownership.json"), base: "http://127.0.0.1:12345/v1", discover: () => assert.fail("foreign key must never reach discovery") });
  const rules = JSON.parse(fs.readFileSync(configPath)).config.providerConfigRules.providerRules;
  assert.deepEqual(rules.find(rule => rule.providerId === unrelated.providerId), unrelated);
  assert.equal(rules.length, 2);

  // The default native reader must retain the first literal identity too,
  // without relying on an injected account list or a legacy env reference.
  const base = "http://127.0.0.1:12345/v1";
  const old = { providerId: "mistral-vibe", providerName: "Vibe", config: { api: { baseUrl: base }, access: { apiKey: "duplicate-native-fixture" } } };
  const clone = { ...structuredClone(old), providerId: "mistral-default", providerName: "New clone" };
  fs.writeFileSync(configPath, JSON.stringify({ config: { providerOrder: [old.providerId, clone.providerId], providerConfigRules: { providerRules: [old, clone] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: { providerId: clone.providerId, modelId: "chat" } } }));
  const ownershipFile = path.join(dir, "ownership.json");
  rememberProviders([old, clone].map(row => ({ providerId: row.providerId, base })), ownershipFile);
  await syncZcode({}, { configPath, ownershipFile, base, discover: async () => [{ id: "chat", contextWindow: 32000, reasoning: false, vision: false }] });
  const result = JSON.parse(fs.readFileSync(configPath)).config;
  assert.deepEqual(result.providerConfigRules.providerRules.map(rule => [rule.providerId, rule.providerName]), [["mistral-vibe", "Vibe"]]);
  assert.equal(result.defaultModelSelection.providerId, "mistral-vibe");
});

test("ZCode imports dotenv after an empty native install, preserves native edits and removed accounts", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-late-import-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env"); fs.writeFileSync(file, "# empty\n");
  const saved = new Map(Object.entries(process.env).filter(([name]) => /^MISTRAL_(API_KEY|MODELS)(_|$)/.test(name) || name === "MISTRAL_BRIDGE_ENV"));
  for (const name of saved.keys()) delete process.env[name];
  process.env.MISTRAL_BRIDGE_ENV = file;
  t.after(() => { delete process.env.MISTRAL_BRIDGE_ENV; for (const [name, value] of saved) process.env[name] = value; });
  const options = { configPath: path.join(dir, "config.json"), ownershipFile: path.join(dir, "ownership.json"), base: "http://127.0.0.1:12345/v1", discover: async key => [{ id: `${key}-model`, contextWindow: 32000 }] };
  await syncZcode({}, options);
  fs.writeFileSync(file, "MISTRAL_API_KEY=default-fixture\nMISTRAL_API_KEY_WORK=work-fixture\n");
  await syncZcode({}, options);
  let cfg = JSON.parse(fs.readFileSync(options.configPath));
  let rows = cfg.config.providerConfigRules.providerRules;
  assert.deepEqual(rows.map(row => row.providerId), ["mistral-default", "mistral-work"]);
  assert.equal(rows[0].config.access.apiKey, "env:default");
  assert.deepEqual(rows[0].config.personalModelIds, ["default-fixture-model"]);
  rows[0].config.access.apiKey = "native-edited-fixture";
  fs.writeFileSync(options.configPath, JSON.stringify(cfg));
  await syncZcode({}, options);
  cfg = JSON.parse(fs.readFileSync(options.configPath));
  rows = cfg.config.providerConfigRules.providerRules;
  assert.equal(rows[0].config.access.apiKey, "native-edited-fixture");
  assert.deepEqual(rows[0].config.personalModelIds, ["native-edited-fixture-model"]);
  const { rememberRemoval } = await import("./ownership.mjs");
  rememberRemoval(["mistral-work"], options.ownershipFile);
  cfg.config.providerConfigRules.providerRules = rows.filter(row => row.providerId !== "mistral-work");
  fs.writeFileSync(options.configPath, JSON.stringify(cfg));
  await syncZcode({}, options);
  assert.deepEqual(JSON.parse(fs.readFileSync(options.configPath)).config.providerConfigRules.providerRules.map(row => row.providerId), ["mistral-default"]);
});
