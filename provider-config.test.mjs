import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { CORE_SHA256, VERSION } from "./proxy.mjs";
import { credentialSourceId } from "./env.mjs";

test("sync_mistral creates env-backed providers and drops removed keys", { timeout: 20000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-config-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const envFile = path.join(home, ".env");
  fs.writeFileSync(envFile, [
    "MISTRAL_API_KEY=synthetic-default-key",
    "MISTRAL_API_KEY_WORK=synthetic-work-key",
    "MISTRAL_MODELS=zai-glm-5-3-flash,zai-glm-latest",
    "MISTRAL_MODELS_WORK=magistral-medium-latest",
    "",
  ].join("\n"));

  // Stand-in for a healthy proxy owned by this build.
  const server = http.createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ service: "mistral-bridge", role: "zcode-daemon", coreSha256: CORE_SHA256, sourceSha256: credentialSourceId({ home, env: { ...childEnv, MISTRAL_BRIDGE_ENV: envFile } }), version: VERSION, pid: process.pid }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));

  // Override homedir only inside this isolated child; never touch user credentials.
  const entry = new URL("./mcp-server.mjs", import.meta.url).href;
  // The child must see only the temporary .env, never the developer's keys.
  const childEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) {
    if (/^MISTRAL_(API_KEY|MODELS)(_|$)/.test(name)) delete childEnv[name];
  }
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import os from 'node:os'; os.homedir = () => ${JSON.stringify(home)}; await import(${JSON.stringify(entry)});`], {
    env: {
      ...childEnv,
      MISTRAL_BRIDGE_PORT: String(server.address().port),
      MISTRAL_BRIDGE_ENV: envFile,
      MISTRAL_BRIDGE_STATE: path.join(home, "state.json"),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });

  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  let nextId = 0;
  function rpc(method, params = {}) {
    const id = ++nextId;
    return new Promise(resolve => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  assert.equal((await rpc("initialize")).result.serverInfo.version, VERSION);

  // Startup auto-sync runs before stdin is read, so the config is ready here.
  const configPath = path.join(home, ".zcode", "v2", "provider_config.json");
  assert.ok(fs.existsSync(configPath), `auto-sync did not write the provider config\n${stderr}`);

  let config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let rules = config.config.providerConfigRules.providerRules;
  const byId = Object.fromEntries(rules.map(rule => [rule.providerId, rule]));
  assert.deepEqual(Object.keys(byId).sort(), ["mistral-default", "mistral-work"]);
  assert.equal(byId["mistral-default"].config.access.apiKey, "env:default");
  assert.equal(byId["mistral-work"].config.access.apiKey, "env:work");
  assert.equal(
    byId["mistral-default"].config.api.baseUrl,
    `http://127.0.0.1:${server.address().port}/v1`,
  );
  assert.deepEqual(byId["mistral-work"].config.personalModelIds, ["magistral-medium-latest"]);
  assert.ok(!JSON.stringify(config).includes("synthetic-default-key"), "literal key leaked into config");
  assert.ok(!JSON.stringify(config).includes("synthetic-work-key"), "literal key leaked into config");

  const modelRules = config.config.modelConfigRules.providerModelRules;
  const flash = modelRules.filter(rule => rule.providerId === "mistral-default" && rule.modelId === "zai-glm-5-3-flash");
  assert.equal(flash.length, 1);
  assert.equal(flash[0].config.properties.inputFormat.supportsImage, true);
  assert.equal(
    modelRules.find(rule => rule.providerId === "mistral-default" && rule.modelId === "zai-glm-latest")
      .config.properties.inputFormat?.supportsImage,
    undefined,
  );

  const listed = await rpc("tools/call", { name: "list_mistral", arguments: {} });
  const listedText = listed.result.content[0].text;
  assert.ok(listedText.includes("env:default (set)"));
  assert.ok(!listedText.includes("synthetic-default-key"));
  assert.ok(!listedText.includes("synthetic-work-key"));

  // Deleting a key from .env and syncing again must remove only that provider.
  const unrelated = { providerId: "other", modelId: "other", config: { properties: { contextWindow: 12345 } } };
  config.config.providerConfigRules.providerRules.push(unrelated);
  fs.writeFileSync(configPath, JSON.stringify(config));

  fs.writeFileSync(envFile, "MISTRAL_API_KEY=synthetic-default-key\nMISTRAL_MODELS=zai-glm-5-3-flash\n");
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(envFile, future, future);

  const second = await rpc("tools/call", { name: "sync_mistral", arguments: {} });
  assert.equal(second.result.isError, false, `${second.result.content?.[0]?.text}\n${stderr}`);

  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  rules = config.config.providerConfigRules.providerRules;
  assert.deepEqual(rules.map(rule => rule.providerId).sort(), ["mistral-default", "other"]);
  assert.deepEqual(rules.find(rule => rule.providerId === "other"), unrelated);
  assert.equal(
    config.config.modelConfigRules.providerModelRules.some(rule => rule.providerId === "mistral-work"),
    false,
  );
  assert.equal(config.config.providerOrder.includes("mistral-work"), false);

  // A tool carrying a foreign id must never mutate that provider or its rules.
  const beforeRemoval = fs.readFileSync(configPath, "utf8");
  const denied = await rpc("tools/call", { name: "remove_mistral", arguments: { provider_id: "other" } });
  assert.equal(denied.result.isError, true);
  assert.equal(fs.readFileSync(configPath, "utf8"), beforeRemoval);
  const removed = await rpc("tools/call", { name: "remove_mistral", arguments: { provider_id: "mistral-default" } });
  assert.equal(removed.result.isError, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).config.providerConfigRules.providerRules, [unrelated]);
  await new Promise(resolve => setTimeout(resolve, 2400));
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).config.providerConfigRules.providerRules, [unrelated], "legacy env must not re-import an explicitly removed account");
  const restore = await rpc("tools/call", { name: "sync_mistral", arguments: { restore_removed: true } });
  assert.equal(restore.result.isError, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath)).config.providerConfigRules.providerRules.map(rule => rule.providerId).sort(), ["mistral-default", "other"]);

  // Malformed private settings must not echo a JSON parser's source excerpt.
  fs.writeFileSync(configPath, '{"apiKey":"synthetic-private-key", broken');
  const malformed = await rpc("tools/call", { name: "list_mistral", arguments: {} });
  assert.equal(malformed.result.isError, true);
  assert.ok(!JSON.stringify(malformed).includes("synthetic-private-key"));

  child.stdin.end();
  assert.equal((await exited)[0], 0);
});

test("MCP retries a startup HTTP 503 automatically without credential edits or manual tools", { timeout: 15000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-recovery-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const envFile = path.join(home, ".env");
  fs.writeFileSync(envFile, "MISTRAL_API_KEY=recovery-fixture\n");
  const childEnv = { ...process.env, MISTRAL_BRIDGE_ENV: envFile, MISTRAL_BRIDGE_STATE: path.join(home, "state.json") };
  for (const name of Object.keys(childEnv)) if (/^MISTRAL_(API_KEY|MODELS)(_|$)/.test(name)) delete childEnv[name];
  delete childEnv.MISTRAL_BRIDGE_AUTO_SYNC;
  let discoveries = 0;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") {
      res.end(JSON.stringify({ service: "mistral-bridge", role: "zcode-daemon", coreSha256: CORE_SHA256, sourceSha256: credentialSourceId({ home, env: childEnv }), version: VERSION, pid: process.pid })); return;
    }
    assert.equal(req.headers.authorization, "Bearer recovery-fixture");
    if (++discoveries === 1) { res.writeHead(503); res.end('{}'); return; }
    res.end(JSON.stringify({ data: [{ id: "recovered-model", capabilities: { completion_chat: true } }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  childEnv.MISTRAL_BRIDGE_PORT = String(server.address().port);
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import os from 'node:os'; os.homedir = () => ${JSON.stringify(home)}; const fetchOriginal = globalThis.fetch; globalThis.fetch = (input, init) => fetchOriginal(typeof input === 'string' && input.startsWith('https://api.mistral.ai/') ? input.replace('https://api.mistral.ai', ${JSON.stringify(origin)}) : input, init); await import(${JSON.stringify(new URL("./mcp-server.mjs", import.meta.url).href)});`], { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  const config = path.join(home, ".zcode", "v2", "provider_config.json");
  const deadline = Date.now() + 10000;
  while (true) {
    assert.equal(child.exitCode, null, errors);
    if (fs.existsSync(config) && fs.readFileSync(config, "utf8").includes('recovered-model')) break;
    assert.ok(Date.now() < deadline, `automatic recovery did not happen: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(discoveries, 2);
  child.stdin.end(); await exited;
});
