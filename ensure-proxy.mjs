import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CORE_SHA256 } from "./proxy.mjs";
import { credentialSourceId } from "./env.mjs";
import {
  candidatePorts,
  explicitPort,
  isFree,
  proxyBase,
  readState,
  writeState,
} from "./port.mjs";

async function probe(port) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(800) });
  } catch {
    return { kind: "none" };
  }
  let value;
  try {
    value = await response.json();
  } catch {
    return { kind: "foreign" };
  }
  if (!response.ok || value?.service !== "mistral-bridge" || value.role !== "zcode-daemon") return { kind: "foreign" };
  if (value.coreSha256 !== CORE_SHA256 || value.sourceSha256 !== credentialSourceId()) return { kind: "outdated", value };
  return { kind: "ours", value };
}

// Capture the launch sources when this module loads. An in-place upgrade after
// this point cannot make the child load a different build from the parent.
const sourceNames = ["proxy.mjs", "env.mjs", "zcode-source.mjs", "ownership.mjs", "daemon.mjs", "port.mjs", "runtime-log.mjs"];
const sources = new Map(sourceNames.map(name => [name, fs.readFileSync(new URL(name, import.meta.url))]));
const capturedHash = createHash("sha256");
for (const name of sourceNames.slice(0, 5)) capturedHash.update(sources.get(name));
const snapshotMatches = capturedHash.digest("hex") === CORE_SHA256;

async function spawnDaemon(port) {
  if (!snapshotMatches) throw new Error("Bridge files changed while loading; reload the plugin before starting a proxy");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-daemon-"));
  const lease = path.join(directory, "startup.json");
  fs.writeFileSync(lease, JSON.stringify({ expires: Date.now() + 30000 }), { mode: 0o600 });
  for (const [name, bytes] of sources) fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
  const entry = path.join(directory, "daemon.mjs");
  const ticket = {
    accept() {
      if (!fs.existsSync(lease)) return;
      const next = `${lease}.tmp`;
      fs.writeFileSync(next, '{"accepted":true}', { mode: 0o600 });
      fs.renameSync(next, lease);
    },
    cancel() { fs.rmSync(directory, { recursive: true, force: true }); },
  };
  try {
    // WMI-created processes do not inherit this process's environment, so an
    // explicit .env path must travel as an argument.
    const args = [entry, String(port), process.env.MISTRAL_BRIDGE_ENV ? path.resolve(process.env.MISTRAL_BRIDGE_ENV) : "", CORE_SHA256, lease];
    if (process.platform === "win32") {
      if (Object.entries(process.env).some(([name, value]) => /^MISTRAL_(API_KEY|MODELS)(_|$)/.test(name) && value)) {
        throw new Error("Windows detached proxies cannot inherit process Mistral key/model overrides; use native Models settings or MISTRAL_BRIDGE_ENV instead");
      }
      // detached:true alone does not escape Windows job objects or taskkill /T.
      // WMI creates a same-user process outside the short-lived MCP process tree.
      const command = `"${process.execPath}" ${args.map(arg => `"${arg}"`).join(" ")}`;
      const script = `$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}; $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='${command.replaceAll("'", "''")}'; CurrentDirectory='${process.cwd().replaceAll("'", "''")}'; ProcessStartupInformation=$startup}; if ($r.ReturnValue -ne 0) { throw 'Mistral daemon startup failed' }`;
      await promisify(execFile)(
        path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 15_000 },
      );
      return ticket;
    }
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return ticket;
  } catch (error) { ticket.cancel(); throw error; }
}

async function launchReady(port) {
  const ticket = await spawnDaemon(port);
  try {
    const ready = await waitReady(port);
    if (!ready) { ticket.cancel(); return null; }
    ticket.accept();
    return ready;
  } catch (error) { ticket.cancel(); throw error; }
}

async function waitReady(port, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await probe(port);
    if (found.kind === "ours") return found.value;
    await delay(100);
  }
  return null;
}

function remember(port, health) {
  writeState({
    port,
    version: health.version,
    coreSha256: health.coreSha256,
    updatedAt: new Date().toISOString(),
  });
}

function result(port, health) {
  return { ...health, port, base: proxyBase(port) };
}

export async function ensureProxy({ port, log = () => {} } = {}) {
  const forced = port ?? explicitPort();

  // Explicit ports stay strict: a foreign listener is an error, never replaced.
  if (forced !== null) {
    const found = await probe(forced);
    if (found.kind === "ours") {
      log(`using independent proxy version=${found.value.version} pid=${found.value.pid} port=${forced}`);
      remember(forced, found.value);
      return result(forced, found.value);
    }
    if (found.kind !== "none") {
      throw new Error(`Port ${forced} is owned by an unknown or outdated proxy; restart the standalone Mistral bridge`);
    }
    const ready = await launchReady(forced);
    if (!ready) throw new Error(`Independent Mistral proxy did not become ready on port ${forced}`);
    log(`independent proxy ready version=${ready.version} pid=${ready.pid} port=${forced}`);
    remember(forced, ready);
    return result(forced, ready);
  }

  // Sticky automatic mode: remembered port, then the default range, then an
  // OS-assigned port. Ports owned by other programs are skipped, not replaced.
  const remembered = readState()?.port;
  for (const candidate of await candidatePorts()) {
    const found = await probe(candidate);
    if (found.kind === "ours") {
      log(`using independent proxy version=${found.value.version} pid=${found.value.pid} port=${candidate}`);
      remember(candidate, found.value);
      return result(candidate, found.value);
    }
    if (found.kind !== "none") continue;
    if (!(await isFree(candidate))) continue;
    const ready = await launchReady(candidate);
    if (!ready) continue;
    log(`independent proxy ready version=${ready.version} pid=${ready.pid} port=${candidate}`);
    if (remembered !== candidate) log(`proxy port changed ${remembered ?? "-"} -> ${candidate}`);
    remember(candidate, ready);
    return result(candidate, ready);
  }
  throw new Error("Could not find a free port for the Mistral bridge proxy");
}
