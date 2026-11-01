import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("live smoke resolves native-only ZCode credentials and its actual endpoint", { timeout: 10000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-native-smoke-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/healthz") {
      assert.equal(req.headers.authorization, undefined);
      res.end(JSON.stringify({ service: "mistral-bridge", role: "zcode-daemon" })); return;
    }
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
    const first = requests.length === 1;
    const delta = first ? { reasoning_content: "synthetic", tool_calls: [{ index: 0, id: "fixture", type: "function", function: { name: "bridge_echo", arguments: JSON.stringify({ text: "中文测试😀" }) } }] }
      : { content: '```python\nprint("中文测试😀")\n```' };
    res.setHeader("content-type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: first ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const configDir = path.join(home, ".zcode", "v2"); fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "provider_config.json"), JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: "mistral-default", config: { access: { apiKey: "native-only-fixture" }, api: { baseUrl: base }, personalModelIds: ["native-model"] } }] } } }));
  const ownerDir = path.join(home, ".zcode", "mistral-proxy"); fs.mkdirSync(ownerDir);
  fs.writeFileSync(path.join(ownerDir, "providers.json"), JSON.stringify({ "mistral-default": [base] }));
  const env = { ...process.env, MISTRAL_BRIDGE_ENV: path.join(home, "missing.env") };
  for (const name of Object.keys(env)) if (/^MISTRAL_(API_KEY|MODELS)(_|$)/.test(name) || name === "MISTRAL_BRIDGE_URL") delete env[name];
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import os from 'node:os'; os.homedir = () => ${JSON.stringify(home)}; await import(${JSON.stringify(new URL("./live-smoke.mjs", import.meta.url).href)});`], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "", error = ""; child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error += chunk; });
  assert.equal((await once(child, "exit"))[0], 0, error);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.authorization === "Bearer native-only-fixture" && request.body.model === "native-model"));
  assert.ok(!output.includes("native-only-fixture"));
  assert.equal(JSON.parse(output).base, base);
});
