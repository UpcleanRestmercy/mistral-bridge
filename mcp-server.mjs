#!/usr/bin/env node
// Mistral provider configuration and MCP lifecycle.
// Read native Models credentials, with legacy .env references supported.

import { createAutoSync } from "./auto-sync.mjs";
import { VERSION } from "./proxy.mjs";
import { ensureProxy } from "./ensure-proxy.mjs";
import { zcodeKeys, isBridgeProvider } from "./zcode-source.mjs";
import { syncZcode, readConfig as readProviderConfig, writeConfig as writeProviderConfig } from "./zcode-config.mjs";
import { rememberRemoval } from "./ownership.mjs";
import { DEFAULT_PORT, proxyBase, readState } from "./port.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const CONFIG_PATH = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
const LOG_FILE = path.join(os.homedir(), ".zcode", "mistral-proxy", "proxy.log");

const rememberedPort = readState()?.port || DEFAULT_PORT;
let proxy = { port: rememberedPort, base: proxyBase(rememberedPort) };

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const st = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE) : null;
    if (st && st.size > 1_000_000) fs.writeFileSync(LOG_FILE, "");
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// --------------------------------------------------------- config tools ---

function readConfig() {
  return readProviderConfig(CONFIG_PATH);
}

function writeConfig(cfg) {
  writeProviderConfig(cfg, CONFIG_PATH);
}

let autoSync;
async function toolSyncMistral(args) {
  return (await autoSync.run({ force: true, args })).text;
}

function toolListMistral() {
  const cfg = readConfig();
  const rules = cfg.config.providerConfigRules.providerRules.filter(rule => isBridgeProvider(rule));
  if (!rules.length) {
    return "No Mistral providers configured. Run sync_mistral, then enter your API key in ZCode Models settings.";
  }
  const keys = new Map(zcodeKeys().map(entry => [entry.name, entry]));
  const modelRules = cfg.config.modelConfigRules.providerModelRules;
  return (
    "Configured Mistral providers:\n"
    + rules
      .map(rule => {
        const reference = String(rule.config?.access?.apiKey || "");
        const name = reference.startsWith("env:") ? reference.slice(4) : null;
        const models = modelRules
          .filter(model => model.providerId === rule.providerId)
          .map(model => model.modelId);
        const levels = modelRules.find(model => model.providerId === rule.providerId)?.config?.optionSpecs
          ?.reasoningLevel?.values;
        const keyState = name
          ? `env:${name} (${keys.has(name) ? "set" : "missing in .env"})`
          : "literal key (not managed by .env)";
        return (
          `- ${rule.providerName} (${rule.providerId})\n`
          + `  key: ${keyState}\n`
          + `  models: ${models.join(", ") || "(none)"}\n`
          + `  reasoning: ${(levels || []).join(" / ") || "(not configured)"}`
        );
      })
      .join("\n")
  );
}

function toolRemoveMistral(args) {
  const pid = String(args?.provider_id ?? "").trim();
  if (!pid) throw new Error("provider_id is required");
  const cfg = readConfig();
  const provider = cfg.config.providerConfigRules.providerRules.find(rule => rule.providerId === pid);
  if (provider && !isBridgeProvider(provider)) throw new Error("Refusing to remove a provider not managed by mistral-bridge");
  const account = zcodeKeys().find(entry => entry.nativeId === pid);
  const before = cfg.config.providerConfigRules.providerRules.length;
  cfg.config.providerConfigRules.providerRules = cfg.config.providerConfigRules.providerRules.filter(
    rule => rule.providerId !== pid,
  );
  cfg.config.modelConfigRules.providerModelRules =
    cfg.config.modelConfigRules.providerModelRules.filter(rule => rule.providerId !== pid);
  cfg.config.modelConfigRules.manualProviderModelRules =
    (cfg.config.modelConfigRules.manualProviderModelRules ?? []).filter(rule => rule.providerId !== pid);
  if (cfg.config.defaultModelSelection?.providerId === pid) delete cfg.config.defaultModelSelection;
  cfg.config.providerOrder = cfg.config.providerOrder.filter(id => id !== pid);
  const removed = before - cfg.config.providerConfigRules.providerRules.length;
  if (!removed) {
    return `No provider with providerId ${pid}. Run list_mistral to see available ids.`;
  }
  rememberRemoval([pid, ...(account ? [`mistral-${account.name}`] : [])]);
  writeConfig(cfg);
  return `Removed provider ${pid}. Reopen the model picker to refresh.`;
}

// ------------------------------------------------------------ MCP stdio ---

const TOOLS = [
  {
    name: "sync_mistral",
    description:
      "Synchronize Mistral providers and discover chat models using ZCode's native Models credentials or legacy MISTRAL_API_KEY environment variables. Creates a keyless Mistral provider on fresh installation. Never returns API keys. Reopen the model picker to refresh.",
    inputSchema: {
      type: "object",
      properties: {
        restore_removed: {
          type: "boolean",
          description: "Explicitly restore accounts previously removed with remove_mistral. Defaults to false.",
        },
        models: {
          type: "array",
          items: { type: "string" },
          description:
            "Fallback model IDs for keys without MISTRAL_MODELS / MISTRAL_MODELS_<NAME>. Defaults to ['zai-glm-latest'].",
        },
      },
    },
  },
  {
    name: "list_mistral",
    description:
      "List Mistral providers configured by mistral-bridge, their models and credential source; never returns key material.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "remove_mistral",
    description: "Remove a Mistral provider previously added by sync_mistral. Reopen the model picker to refresh.",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: { type: "string", description: "providerId as shown by list_mistral" },
      },
      required: ["provider_id"],
    },
  },
];

function dispatchTool(name, args) {
  switch (name) {
    case "sync_mistral":
      return toolSyncMistral(args);
    case "list_mistral":
      return toolListMistral();
    case "remove_mistral":
      return toolRemoveMistral(args);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0") return null;
  const reply = result => JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
  const replyError = (code, message) =>
    JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mistral-bridge", version: VERSION },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      try {
        const text = await dispatchTool(msg.params?.name, msg.params?.arguments);
        return reply({ content: [{ type: "text", text }], isError: false });
      } catch (e) {
        return reply({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
      }
    }
    default:
      if (msg.id === undefined || msg.id === null) return null; // notification
      if (String(msg.method).startsWith("notifications/")) return null;
      return replyError(-32601, `method not found: ${msg.method}`);
  }
}

async function main() {
  proxy = await ensureProxy({ log });
  autoSync = createAutoSync({
    signature: () => JSON.stringify(zcodeKeys()),
    sync: args => syncZcode(args, { base: proxy.base }),
  });
  if (process.env.MISTRAL_BRIDGE_AUTO_SYNC !== "0") {
    const refresh = async () => {
      try {
        const result = await autoSync.run();
        if (result) log(`auto-sync ${result.changed ? "updated" : "unchanged"}: ${result.text.split("\n")[0]}`);
      } catch (error) { log(`auto-sync failed: ${error.message}`); }
    };
    await refresh();
    const timer = setInterval(refresh, 2000);
    timer.unref();
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", async line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const out = await handleMessage(msg);
    if (out) process.stdout.write(out + "\n");
  });
  rl.on("close", () => process.exit(0));
  log(`mistral-bridge MCP server v${VERSION} started port=${proxy.port}`);
}

main().catch(e => {
  log(`fatal: ${e.message}`);
  process.exit(1);
});
