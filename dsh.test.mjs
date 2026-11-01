import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { mountBridge, providerProfiles, resolveOptions } from "./dsh.mjs";
import { createProxy } from "./proxy.mjs";
import { resolveKey } from "./env.mjs";
import { ensureProxy } from "./ensure-proxy.mjs";

function envFixture(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-dsh-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, text);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}

function context(t) {
  const disposers = [];
  const ctx = { effect: async setup => { disposers.push(await setup()); } };
  ctx.dispose = async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  };
  t.after(ctx.dispose);
  return ctx;
}

test("DSH declares multiple accounts, model overrides, reasoning and vision without key material", () => {
  const routes = providerProfiles([
    { name: "default", key: "secret-default" },
    { name: "work", key: "secret-work", models: ["work-model", "zai-glm-5-3-flash", "work-model"] },
  ], "http://127.0.0.1:1234/v1", resolveOptions());
  assert.deepEqual(Object.keys(routes), ["mistral-default", "mistral-work"]);
  assert.equal(routes["mistral-work"].headers.Authorization, "Bearer env:work");
  assert.deepEqual(routes["mistral-work"].models.map(model => model.id), ["work-model", "zai-glm-5-3-flash"]);
  assert.deepEqual(routes["mistral-work"].models[1].input, ["text", "image"]);
  assert.deepEqual(routes["mistral-work"].models[0].reasoningEfforts, { low: "low", high: "high", max: "max" });
  assert.ok(!JSON.stringify(routes).includes("secret-"));
});

test("invalid DSH options and account collisions fail before startup", () => {
  for (const raw of [null, [], { typo: 1 }, { port: -1 }, { port: 65536 }, { models: [] }, { models: [null] }, { envFile: "" }, { idleMs: 2147483648 }, { contextWindow: 100 }, { reasoning: "off" }, { reasoningEfforts: {} }, { reasoningEfforts: { low: null } }, { reasoningEfforts: false }]) {
    assert.throws(() => resolveOptions(raw), /mistral-bridge:/);
  }
  assert.equal(resolveOptions({ reasoning: "off", reasoningEfforts: false }).reasoningEfforts, false);
  assert.equal(resolveOptions({ reasoning: "off", reasoningEfforts: { off: null, high: "high" } }).reasoning, "off");
  assert.throws(() => providerProfiles([{ name: "work" }, { name: "work" }], "http://localhost", resolveOptions()), /duplicate provider/);
});

test("DSH listener is ready before registration and closes on unload", async t => {
  const file = envFixture(t, "MISTRAL_API_KEY_DSH_LIFECYCLE=fixture-key\n");
  const ctx = context(t);
  let baseURL;
  await mountBridge(ctx, { envFile: file }, async (_ctx, routes) => {
    baseURL = routes["mistral-dsh-lifecycle"].baseURL;
    assert.equal((await fetch(baseURL.replace("/v1", "/healthz"))).status, 200);
    assert.equal((await (await fetch(baseURL.replace("/v1", "/healthz"))).json()).role, "dsh");
    await assert.rejects(ensureProxy({ port: Number(new URL(baseURL).port) }), /unknown or outdated/);
    assert.ok(!JSON.stringify(routes).includes("fixture-key"));
  });
  await ctx.dispose();
  await assert.rejects(fetch(baseURL.replace("/v1", "/healthz")));
});

test("a fresh DSH profile exposes the standard Models key editor without dotenv keys", async t => {
  const file = envFixture(t, "# no keys configured\n");
  const ctx = context(t);
  ctx.get = name => name === "settings" ? { describe: () => [] } : undefined;
  await mountBridge(ctx, { envFile: file }, (_ctx, routes) => {
    const route = routes["mistral-default"];
    assert.equal(route.displayName, "Mistral");
    assert.equal(route.apiKeyEnv, "MISTRAL_API_KEY");
    assert.match(route.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  });
});

test("DSH retains discovered capabilities on outages and isolates a rotated key", async t => {
  const file = envFixture(t, "MISTRAL_API_KEY_DSH_CATALOG=fixture-catalog\n");
  const ctx = context(t);
  const events = new Map();
  ctx.on = (name, fn) => events.set(name, fn);
  let refreshModels = 0, fail = false, applied = [];
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://api.mistral.ai/")) return nativeFetch(input, init);
    return new Response(fail ? "unavailable" : JSON.stringify({ data: [
      { id: "plain", max_context_length: 32000, capabilities: { completion_chat: true, reasoning: false } },
      { id: "vision", max_context_length: 100000, capabilities: { completion_chat: true, reasoning: true, vision: true } },
    ] }), { status: fail ? 503 : 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = nativeFetch; });
  const waitForUpdate = async count => {
    const deadline = Date.now() + 2000;
    while (applied.length < count) {
      assert.ok(Date.now() < deadline, "model refresh did not finish");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  await mountBridge(ctx, () => ({ envFile: file, refreshModels }), () => ({ update: routes => { applied.push(routes); } }));
  await waitForUpdate(1);
  const initial = applied[0]["mistral-dsh-catalog"].models;
  assert.deepEqual(initial.map(model => model.id), ["plain", "vision"]);
  fail = true; refreshModels++;
  events.get("loader/volatile-update")();
  await waitForUpdate(2);
  assert.deepEqual(applied[1]["mistral-dsh-catalog"].models, initial);
  fs.writeFileSync(file, "MISTRAL_API_KEY_DSH_CATALOG=rotated-fixture-catalog\n");
  refreshModels++;
  events.get("loader/volatile-update")();
  await waitForUpdate(3);
  assert.deepEqual(applied[2]["mistral-dsh-catalog"].models.map(model => model.id), ["zai-glm-latest"]);
  await ctx.dispose();
});

test("DSH ignores unrelated native routes with Mistral-like ids without resolving their keys", async t => {
  const file = envFixture(t, "# empty\n");
  const ctx = context(t);
  ctx.get = name => name === "settings" ? { describe: () => [{ ns: "llm-pi-ai", value: { providers: {
    "mistral-private": { baseURL: "https://private.invalid/v1", apiKeyEnv: "PRIVATE_GATEWAY_KEY" },
  } } }] } : name === "credentials" ? { resolve: () => assert.fail("unrelated credentials must never be resolved") } : undefined;
  await mountBridge(ctx, { envFile: file }, (_ctx, routes) => {
    assert.deepEqual(Object.keys(routes), ["mistral-default"]);
  });
});

test("legacy migration refuses a native credential that differs from the explicit Mistral import", async t => {
  const file = envFixture(t, "MISTRAL_API_KEY=declared-mistral-fixture\n");
  const ctx = context(t);
  const profile = providerProfiles([{ name: "default" }], "http://127.0.0.1:1/v1", resolveOptions())["mistral-default"];
  delete profile.headers;
  ctx.get = name => name === "settings" ? { describe: () => [{ ns: "llm-pi-ai", value: { providers: { "mistral-default": profile } } }] }
    : name === "credentials" ? { resolve: async () => ({ value: "private-unrelated-fixture" }) } : undefined;
  await mountBridge(ctx, { envFile: file }, (_ctx, _routes, ownership) => {
    assert.equal(ownership.ownsLegacy("mistral-default", profile), false);
    assert.ok(!JSON.stringify(_routes).includes("private-unrelated-fixture"));
  });
});

test("DSH preserves native model metadata when discovery fails after a cold restart", async t => {
  const file = envFixture(t, "# no legacy keys\n");
  const ctx = context(t);
  const profile = providerProfiles([{ name: "default", key: "cold-fixture", models: ["plain", "vision"] }], "http://127.0.0.1:12345/v1", resolveOptions())["mistral-default"];
  profile.models[0].reasoningEfforts = false;
  profile.models[0].contextWindow = 32000;
  profile.models[0].maxTokens = 8000;
  profile.models[1].input = ["text", "image"];
  ctx.get = name => name === "settings" ? { describe: () => [{ ns: "llm-pi-ai", value: { providers: { "mistral-default": profile } } }] }
    : name === "credentials" ? { resolve: async () => ({ value: "cold-fixture" }) } : undefined;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).startsWith("https://api.mistral.ai/")
    ? new Response("unavailable", { status: 503 }) : nativeFetch(input, init);
  t.after(() => { globalThis.fetch = nativeFetch; });
  let applied;
  const updated = new Promise(resolve => { applied = resolve; });
  await mountBridge(ctx, { envFile: file }, () => ({ update: routes => applied(routes) }));
  const routes = await updated;
  assert.deepEqual(routes["mistral-default"].models, profile.models);
  await ctx.dispose();
});

test("adapter startup failure leaves proxy cleanup registered", async t => {
  const ctx = context(t);
  const file = envFixture(t, "MISTRAL_API_KEY_DSH_FAILURE=fixture\n");
  let baseURL;
  await assert.rejects(mountBridge(ctx, { envFile: file }, (_ctx, routes) => {
    baseURL = routes["mistral-dsh-failure"].baseURL;
    throw new Error("registration failed");
  }), /registration failed/);
  await ctx.dispose();
  await assert.rejects(fetch(baseURL.replace("/v1", "/healthz")));
});

test("configured port conflicts never replace another listener", async t => {
  const foreign = http.createServer((_req, res) => res.end("foreign"));
  await new Promise(resolve => foreign.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const file = envFixture(t, "MISTRAL_API_KEY_DSH_PORT=fixture\n");
  await assert.rejects(mountBridge(context(t), { envFile: file, port: foreign.address().port }, () => assert.fail("must not register")), { code: "EADDRINUSE" });
  assert.equal(await (await fetch(`http://127.0.0.1:${foreign.address().port}`)).text(), "foreign");
});

test("automatic DSH ports fall back when the previous owned endpoint is occupied", async t => {
  const foreign = http.createServer((_req, res) => res.end("foreign"));
  await new Promise(resolve => foreign.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { foreign.close(resolve); foreign.closeAllConnections(); }));
  const previous = `http://127.0.0.1:${foreign.address().port}/v1`;
  const profile = providerProfiles([{ name: "default" }], previous, resolveOptions())["mistral-default"];
  const file = envFixture(t, "# native credentials\n");
  const ctx = context(t);
  ctx.get = name => name === "settings" ? { describe: () => [{ ns: "llm-pi-ai", value: { providers: { "mistral-default": profile } } }] } : undefined;
  let next;
  await mountBridge(ctx, { envFile: file }, (_ctx, routes) => { next = routes["mistral-default"].baseURL; });
  assert.notEqual(next, previous);
  assert.equal((await fetch(next.replace("/v1", "/healthz"))).status, 200);
  assert.equal(await (await fetch(previous.replace("/v1", "/healthz"))).text(), "foreign");
});

test("DSH env files stay isolated and credentials reload without mutating the environment", async t => {
  const first = envFixture(t, "MISTRAL_API_KEY_DSH_ISOLATION=one\n");
  const second = envFixture(t, "MISTRAL_API_KEY_DSH_ISOLATION=two\n");
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push(req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"data":[]}');
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const servers = [];
  for (const file of [first, second]) {
    const server = createProxy({ upstream: `http://127.0.0.1:${upstream.address().port}`, keyResolver: ref => resolveKey(ref, { file }), requireEnvKey: true });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    servers.push(`http://127.0.0.1:${server.address().port}/v1/models`);
  }
  const get = (url, key = "env:dsh-isolation") => fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal((await get(servers[0])).status, 200);
  assert.equal((await get(servers[1])).status, 200);
  fs.writeFileSync(first, "MISTRAL_API_KEY_DSH_ISOLATION=rotated-longer-key\n");
  assert.equal((await get(servers[0])).status, 200);
  assert.equal((await get(servers[1])).status, 200);
  for (const key of ["literal-key", "env:missing"]) assert.equal((await get(servers[0], key)).status, 401);
  assert.deepEqual(received, ["Bearer one", "Bearer two", "Bearer rotated-longer-key", "Bearer two"]);
  assert.equal(process.env.MISTRAL_API_KEY_DSH_ISOLATION, undefined);
});

test("DSH imports late dotenv into empty native credentials and adds accounts without replacing edits", async t => {
  const file = envFixture(t, "# empty\n");
  const ctx = context(t), events = new Map(), stored = new Map(), writes = [];
  let providers = {}, updates = 0;
  ctx.on = (name, callback) => events.set(name, callback);
  ctx.get = name => name === "settings" ? { describe: () => [{ ns: "llm-pi-ai", value: { providers } }] }
    : name === "credentials" ? {
      resolve: async ref => stored.has(ref) ? { value: stored.get(ref) } : undefined,
      set: async (ref, value) => { writes.push(ref); stored.set(ref, value); },
    } : undefined;
  await mountBridge(ctx, { envFile: file, autoDiscover: false }, (_ctx, routes) => {
    providers = routes;
    return { update: next => { providers = next; updates++; } };
  });
  const wait = async count => {
    const deadline = Date.now() + 2000;
    while (updates < count) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  await wait(1);
  fs.writeFileSync(file, "MISTRAL_API_KEY=late-default\nMISTRAL_API_KEY_WORK=late-work\n");
  events.get("loader/volatile-update")(); await wait(2);
  assert.equal(stored.get("MISTRAL_API_KEY"), "late-default");
  assert.equal(stored.get("MISTRAL_API_KEY_WORK"), "late-work");
  assert.deepEqual(Object.keys(providers), ["mistral-default", "mistral-work"]);
  stored.set("MISTRAL_API_KEY", "native-edit");
  events.get("credentials/reference-updated")(); await wait(3);
  assert.equal(stored.get("MISTRAL_API_KEY"), "native-edit");
  assert.deepEqual(writes, ["MISTRAL_API_KEY", "MISTRAL_API_KEY_WORK"]);
  stored.delete("MISTRAL_API_KEY");
  events.get("credentials/reference-updated")(); await wait(4);
  assert.equal(stored.has("MISTRAL_API_KEY"), false, "explicitly cleared credentials must not re-import during this session");
});
