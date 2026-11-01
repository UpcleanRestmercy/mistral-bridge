// Sticky port selection: remember the last working port, fall back to the next
// free one, and never touch a port owned by another program.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT = 8791;
export const SCAN_LIMIT = 10;

function scanStart() {
  const value = Number(process.env.MISTRAL_BRIDGE_PORT_START);
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_PORT;
}

export function proxyBase(port) {
  return `http://127.0.0.1:${port}/v1`;
}

export function stateFile() {
  return process.env.MISTRAL_BRIDGE_STATE
    || path.join(os.homedir(), ".zcode", "mistral-proxy", "state.json");
}

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(value) {
  const file = stateFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } catch {
    // A read-only home directory must not break the proxy.
  }
}

export function explicitPort() {
  const raw = process.env.MISTRAL_BRIDGE_PORT;
  if (raw === undefined || raw === "") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MISTRAL_BRIDGE_PORT");
  return port;
}

export async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function isFree(port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

export async function candidatePorts() {
  const forced = explicitPort();
  if (forced !== null) return [forced];
  const candidates = [];
  const remembered = readState()?.port;
  if (Number.isInteger(remembered) && remembered > 0 && remembered <= 65535) candidates.push(remembered);
  const start = scanStart();
  for (let offset = 0; offset < SCAN_LIMIT; offset++) candidates.push(start + offset);
  candidates.push(await freePort());
  return [...new Set(candidates)];
}
