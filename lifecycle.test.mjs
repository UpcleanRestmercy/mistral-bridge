import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ensureProxy } from "./ensure-proxy.mjs";
import { CORE_SHA256, VERSION, createProxy } from "./proxy.mjs";
import { credentialSourceId } from "./env.mjs";

async function sparePort() {
  const s = http.createServer(); await new Promise(r => s.listen(0, "127.0.0.1", r));
  const port = s.address().port; await new Promise(r => s.close(r)); return port;
}
function launchMcp(port, stateFile) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./mcp-server.mjs", import.meta.url))], {
    env: { ...process.env, MISTRAL_BRIDGE_PORT: String(port), MISTRAL_BRIDGE_AUTO_SYNC: "0", MISTRAL_BRIDGE_STATE: stateFile }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  const initialized = new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", b => { text += b; if (text.includes("\n")) { try { resolve(JSON.parse(text.split("\n")[0])); } catch (e) { reject(e); } } });
    child.once("error", reject);
    child.once("exit", () => { if (!text) reject(new Error("MCP exited before initialization")); });
  });
  return { child, initialized };
}
async function health(port) {
  return (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) })).json();
}

test("MCP graceful exit, peer restart and forced process-tree kill preserve daemon", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-lifecycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, "state.json");
  const port = await sparePort(); let daemonPid;
  const children = [];
  t.after(() => {
    for (const c of children) if (c.exitCode === null) c.kill();
    if (daemonPid) { try { process.kill(daemonPid); } catch {} }
  });
  const first = launchMcp(port, state); children.push(first.child);
  assert.equal((await first.initialized).result.serverInfo.version, VERSION);
  const initial = await health(port); daemonPid = initial.pid;
  assert.equal(initial.coreSha256, CORE_SHA256); assert.notEqual(daemonPid, first.child.pid);
  const exited = once(first.child, "exit"); first.child.stdin.end(); await exited;
  await delay(100);
  assert.equal((await health(port)).pid, daemonPid, "MCP EOF must not stop the proxy");
  const second = launchMcp(port, state); children.push(second.child);
  assert.equal((await second.initialized).result.serverInfo.version, VERSION);
  assert.equal((await health(port)).pid, daemonPid, "peer must reuse existing daemon");
  const secondExit = once(second.child, "exit");
  if (process.platform === "win32") {
    await promisify(execFile)("taskkill.exe", ["/PID", String(second.child.pid), "/T", "/F"], { windowsHide: true });
  } else second.child.kill("SIGKILL");
  await secondExit; await delay(100);
  assert.equal((await health(port)).pid, daemonPid, "proxy must survive killing the MCP process tree");
  assert.equal((await health(port)).activeRequests, 0);
});

test("unknown port owner is rejected without replacement", async t => {
  const server = http.createServer((_, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"service":"other"}'); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  await assert.rejects(ensureProxy({ port: server.address().port }), /unknown or outdated/);
  assert.equal((await health(server.address().port)).service, "other");
});

test("same-build daemons with a different credential source are never reused", async t => {
  const previous = process.env.MISTRAL_BRIDGE_ENV;
  t.after(() => {
    if (previous === undefined) delete process.env.MISTRAL_BRIDGE_ENV;
    else process.env.MISTRAL_BRIDGE_ENV = previous;
  });
  process.env.MISTRAL_BRIDGE_ENV = path.join(os.tmpdir(), "mistral-source-one.env");
  const firstSource = credentialSourceId();
  const server = createProxy({ role: "zcode-daemon" });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  assert.equal((await health(port)).sourceSha256, firstSource);
  process.env.MISTRAL_BRIDGE_ENV = path.join(os.tmpdir(), "mistral-source-two.env");
  assert.notEqual(credentialSourceId(), firstSource);
  await assert.rejects(ensureProxy({ port }), /unknown or outdated/);
  assert.equal((await health(port)).sourceSha256, firstSource);
});

test("automatic mode skips an occupied port and remembers a free one", { timeout: 30000 }, async t => {
  const occupied = http.createServer((_, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("not the bridge"); });
  await new Promise(r => occupied.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => { occupied.close(r); occupied.closeAllConnections(); }));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-port-test-"));
  const state = path.join(dir, "state.json");
  fs.writeFileSync(state, JSON.stringify({ port: occupied.address().port }));

  const scanStart = await sparePort();
  const previous = {
    state: process.env.MISTRAL_BRIDGE_STATE,
    port: process.env.MISTRAL_BRIDGE_PORT,
    start: process.env.MISTRAL_BRIDGE_PORT_START,
  };
  process.env.MISTRAL_BRIDGE_STATE = state;
  delete process.env.MISTRAL_BRIDGE_PORT;
  process.env.MISTRAL_BRIDGE_PORT_START = String(scanStart);
  t.after(() => {
    for (const [name, value] of [
      ["MISTRAL_BRIDGE_STATE", previous.state],
      ["MISTRAL_BRIDGE_PORT", previous.port],
      ["MISTRAL_BRIDGE_PORT_START", previous.start],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const info = await ensureProxy({});
  t.after(() => { try { process.kill(info.pid); } catch {} });

  assert.notEqual(info.port, occupied.address().port);
  assert.equal(info.base, `http://127.0.0.1:${info.port}/v1`);
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).port, info.port);
  assert.equal((await health(info.port)).pid, info.pid);
});

test("launcher uses its captured build when source files change after import", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-upgrade-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of fs.readdirSync(new URL(".", import.meta.url)).filter(name => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))) {
    fs.copyFileSync(new URL(name, import.meta.url), path.join(dir, name));
  }
  const { pathToFileURL } = await import("node:url");
  const launcher = await import(pathToFileURL(path.join(dir, "ensure-proxy.mjs")));
  fs.appendFileSync(path.join(dir, "proxy.mjs"), "\n// upgrade happened after parent import\n");
  const saved = process.env.MISTRAL_BRIDGE_STATE;
  process.env.MISTRAL_BRIDGE_STATE = path.join(dir, "state.json");
  t.after(() => { if (saved === undefined) delete process.env.MISTRAL_BRIDGE_STATE; else process.env.MISTRAL_BRIDGE_STATE = saved; });
  const ready = await launcher.ensureProxy({ port: await sparePort() });
  t.after(() => { try { process.kill(ready.pid); } catch {} });
  assert.equal(ready.coreSha256, CORE_SHA256);
  await delay(200);
  assert.equal((await health(ready.port)).pid, ready.pid);
});

test("a failed readiness attempt cancels only its new daemon", { timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-failed-launch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of fs.readdirSync(new URL(".", import.meta.url)).filter(name => name.endsWith(".mjs") && !name.endsWith(".test.mjs"))) {
    fs.copyFileSync(new URL(name, import.meta.url), path.join(dir, name));
  }
  const file = path.join(dir, "ensure-proxy.mjs");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("attempts = 30", "attempts = 0"));
  const { pathToFileURL } = await import("node:url");
  const launcher = await import(pathToFileURL(file));
  const port = await sparePort();
  await assert.rejects(launcher.ensureProxy({ port }), /did not become ready/);
  await delay(1000);
  const { isFree } = await import("./port.mjs");
  assert.equal(await isFree(port), true, "failed startup must not leave a listener");
});
