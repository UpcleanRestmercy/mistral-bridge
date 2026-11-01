// Own the HTTP listener independently of MCP stdin and parent process lifetime.
import fs from "node:fs";
import path from "node:path";
import { startProxy, PROXY_PORT, CORE_SHA256 } from "./proxy.mjs";
import { log } from "./runtime-log.mjs";
import { resolveZcodeKey } from "./zcode-source.mjs";
const port = process.argv[2] === undefined ? PROXY_PORT : Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid daemon port");
// Passed explicitly because WMI-created processes do not inherit the caller's env.
if (process.argv[3]) process.env.MISTRAL_BRIDGE_ENV = process.argv[3];
// A failed/abandoned launch owns only this child. Never kill a PID learned
// from a listener: it may belong to an earlier daemon or a concurrent launcher.
const lease = process.argv[5];
let leaseTimer;
if (lease) {
  if (process.argv[4] !== CORE_SHA256) throw new Error("Daemon build differs from launcher");
  const check = () => {
    let state;
    try { state = JSON.parse(fs.readFileSync(lease, "utf8")); } catch {}
    if (state?.accepted) {
      clearInterval(leaseTimer);
      fs.rmSync(path.dirname(lease), { recursive: true, force: true });
    } else if (!state || Date.now() >= state.expires) {
      fs.rmSync(path.dirname(lease), { recursive: true, force: true });
      process.exit(1);
    }
  };
  leaseTimer = setInterval(check, 100);
  leaseTimer.unref();
  check();
}
try {
  const server = await startProxy({ port, log, keyResolver: resolveZcodeKey });
  if (!server && lease) fs.rmSync(path.dirname(lease), { recursive: true, force: true });
}
catch (error) { log(`daemon startup failed: ${error.message}`); process.exitCode = 1; }
