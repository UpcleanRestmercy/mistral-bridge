// Standalone launcher: loads the same core files as the installed MCP plugin.
// Set MISTRAL_BRIDGE_PLUGIN_ID to pin a specific installed plugin id.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const home = path.join(os.homedir(), ".zcode");
const registryPath = path.join(home, "cli", "plugins", "installed_plugins.json");
const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
const plugins = registry.plugins || [];
const wanted = process.env.MISTRAL_BRIDGE_PLUGIN_ID;
const plugin = wanted
  ? plugins.find(entry => entry.id === wanted)
  : plugins.find(entry => entry.id?.split("@")[0] === "mistral-bridge");
if (!plugin) throw new Error("mistral-bridge is not installed");

const { ensureProxy } = await import(pathToFileURL(path.join(plugin.installPath, "ensure-proxy.mjs")).href);
const logFile = path.join(home, "mistral-proxy", "proxy.log");
function log(message) {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1_000_000) fs.renameSync(logFile, logFile + ".1");
    fs.appendFileSync(logFile, new Date().toISOString() + " " + message + "\n");
  } catch {}
}
try {
  await ensureProxy({ log });
} catch (error) {
  log(error.message);
  process.exitCode = 1;
}
