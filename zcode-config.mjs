import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zcodeKeys, isBridgeProvider, adoptLegacyProviders } from "./zcode-source.mjs";
import { discoverModels } from "./catalog.mjs";
import { readOwnership, rememberProviders, restoreRemoved } from "./ownership.mjs";
const DEFAULT_MODELS = ["zai-glm-latest"];
const REASONING_LEVELS = ["low", "high", "max"];
const REASONING_MAP = '{"reasoning_effort": reasoningLevel}';

export function readConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    return {
      schemaVersion: 1,
      config: {
        providerOrder: [],
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    };
  }
  try { return JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch { throw new Error("Cannot read ZCode provider settings"); }
}

export function writeConfig(cfg, configPath) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, configPath);
}

function isManaged(rule, ownership) {
  return isBridgeProvider(rule, ownership)
    && String(rule.config?.access?.apiKey || "").startsWith("env:");
}

export async function syncZcode(args = {}, { base, configPath = path.join(os.homedir(), ".zcode", "v2", "provider_config.json"), ownershipFile, accounts, discover = discoverModels } = {}) {
  if (args.restore_removed === true) restoreRemoved(ownershipFile);
  await adoptLegacyProviders({ configPath, ownershipFile });
  const ownership = readOwnership(ownershipFile);
  let keys = (accounts ?? zcodeKeys({ configPath, ownershipFile })).map(entry => ({ ...entry }));
  const env = { file: "ZCode Models settings / .env" };
  // A fresh installation must expose the host's native key editor before a key exists.
  if (!keys.length && (!Object.keys(ownership).length || args.restore_removed === true)) keys = [{ name: "default", envVar: "ZCode Models settings", key: "", nativeKey: "", nativeName: "Mistral" }];

  const fallback = (Array.isArray(args?.models) ? args.models : [])
    .map(model => String(model).trim())
    .filter(Boolean);
  const catalogs = new Map(await Promise.all(keys.map(async entry => {
    if (!entry.key || entry.models?.length || fallback.length) return [entry.name, []];
    try { return [entry.name, await discover(entry.key)]; }
    catch (error) { entry.discoveryError = error.message; return [entry.name, []]; }
  })));
  const cfg = readConfig(configPath);
  for (const entry of keys) {
    if (entry.nativeId && cfg.config.providerConfigRules.providerRules.find(rule => rule.providerId === entry.nativeId)?.config?.access?.apiKey !== entry.nativeKey) {
      throw new Error("ZCode credentials changed during model discovery; retry synchronization");
    }
  }
  const original = JSON.stringify(cfg);
  const rules = cfg.config.providerConfigRules.providerRules;
  const modelRules = cfg.config.modelConfigRules.providerModelRules;
  const synced = [];
  const ids = new Set();

  // Preserve the old provider identity when its literal key matches this account.
  const targets = new Map(keys.map(entry => {
    const legacy = rules.find(rule => isBridgeProvider(rule, ownership) && entry.nativeId && rule.providerId === entry.nativeId)
      ?? rules.find(rule => isBridgeProvider(rule, ownership) && entry.key && rule.config?.access?.apiKey === entry.key)
      ?? rules.find(rule => isBridgeProvider(rule, ownership) && rule.config?.access?.apiKey === `env:${entry.name}`);
    return [entry.name, { id: legacy?.providerId ?? `mistral-${entry.name}`, name: legacy?.providerName ?? entry.nativeName ?? (entry.name === "default" ? "Vibe" : entry.name === "arbx" ? "Mistral" : `Mistral (${entry.name})`) }];
  }));
  const aliases = new Map();
  for (const rule of rules) {
    if (!isBridgeProvider(rule, ownership)) continue;
    const entry = keys.find(key => (key.key && key.key === rule.config?.access?.apiKey) || `env:${key.name}` === rule.config?.access?.apiKey || key.nativeId === rule.providerId);
    if (entry && rule.providerId !== targets.get(entry.name).id) aliases.set(rule.providerId, targets.get(entry.name).id);
  }
  cfg.config.providerConfigRules.providerRules = rules.filter(rule => !aliases.has(rule.providerId));
  cfg.config.providerOrder = [...new Set(cfg.config.providerOrder.map(id => aliases.get(id) ?? id))];
  for (const rule of cfg.config.modelConfigRules.manualProviderModelRules ?? []) {
    if (aliases.has(rule.providerId)) rule.providerId = aliases.get(rule.providerId);
  }
  const selection = cfg.config.defaultModelSelection;
  if (selection && aliases.has(selection.providerId)) selection.providerId = aliases.get(selection.providerId);
  rules.splice(0, rules.length, ...cfg.config.providerConfigRules.providerRules);

  for (const entry of keys) {
    const providerId = targets.get(entry.name).id;
    const existing = rules.find(rule => rule.providerId === providerId);
    if (existing && !isBridgeProvider(existing, ownership)) throw new Error("Refusing to overwrite a provider not managed by mistral-bridge");
    ids.add(providerId);
    const catalog = catalogs.get(entry.name);
    const previous = rules.find(rule => rule.providerId === providerId)?.config?.personalModelIds;
    const models = [...new Set(entry.models?.length ? entry.models : fallback.length ? fallback : catalog.length ? catalog.map(model => model.id) : previous?.length ? previous : DEFAULT_MODELS)];
    const providerName = targets.get(entry.name).name;

    const rule = {
      providerId,
      providerName,
      config: {
        group: "standard-personal",
        access: { type: "api-key", apiKey: !entry.importLegacy && typeof entry.nativeKey === "string" && !entry.nativeKey.startsWith("env:") ? entry.nativeKey : `env:${entry.name}` },
        api: { type: "openai-chat-completions", baseUrl: base },
        personalModelIds: models,
        modelOrder: models,
      },
    };
    const index = rules.findIndex(r => r.providerId === providerId);
    if (index >= 0) rules[index] = rule;
    else rules.push(rule);
    if (!cfg.config.providerOrder.includes(providerId)) cfg.config.providerOrder.push(providerId);

    for (const modelId of models) {
      const modelRule = {
        modelId,
        config: {
          enabled: true,
          properties: {
            contextWindow: catalog.find(model => model.id === modelId)?.contextWindow ?? 300000,
            // ZCode otherwise inherits supportsImage:false and omits images before the proxy.
            ...(catalog.length ? { inputFormat: { supportsImage: catalog.find(model => model.id === modelId)?.vision === true } } : modelId === "zai-glm-5-3-flash" ? { inputFormat: { supportsImage: true } } : {}),
          },
          optionSpecs: {
            ...(catalog.find(model => model.id === modelId)?.reasoning === false ? {} : { reasoningLevel: { values: REASONING_LEVELS, map: REASONING_MAP } }),
            maxOutputTokens: { max: Math.min(64000, catalog.find(model => model.id === modelId)?.contextWindow ?? 300000) },
          },
        },
        providerId,
      };
      const modelIndex = modelRules.findIndex(r => r.providerId === providerId && r.modelId === modelId);
      if (modelIndex >= 0 && entry.discoveryError && !entry.models?.length && !fallback.length) continue;
      if (modelIndex >= 0) modelRules[modelIndex] = modelRule;
      else modelRules.push(modelRule);
    }

    synced.push({ ...entry, providerId, providerName, models });
  }

  // Remove providers whose key was deleted from .env; leave everything else alone.
  const removed = [...aliases.keys(), ...rules.filter(rule => isManaged(rule, ownership) && !ids.has(rule.providerId)).map(rule => rule.providerId)];
  cfg.config.providerConfigRules.providerRules = rules.filter(rule => !removed.includes(rule.providerId));
  const remaining = new Set(cfg.config.providerConfigRules.providerRules.map(rule => rule.providerId));
  cfg.config.modelConfigRules.providerModelRules = modelRules.filter(
    rule => !(rule.providerId?.startsWith("mistral-") && !remaining.has(rule.providerId)),
  );
  cfg.config.providerOrder = cfg.config.providerOrder.filter(
    id => !id.startsWith("mistral-") || remaining.has(id),
  );

  // Providers created by older versions still hold a literal key. Keep them
  // reachable after the proxy moved to a different port.
  for (const rule of cfg.config.providerConfigRules.providerRules) {
    if (
      ids.has(rule.providerId)
      && /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(String(rule.config?.api?.baseUrl || ""))
    ) {
      rule.config.api.baseUrl = base;
    }
  }

  const advertised = new Map(synced.map(entry => [entry.providerId, new Set(entry.models)]));
  cfg.config.modelConfigRules.providerModelRules = cfg.config.modelConfigRules.providerModelRules.filter(rule => !advertised.has(rule.providerId) || advertised.get(rule.providerId).has(rule.modelId));
  const changed = JSON.stringify(cfg) !== original;
  if (changed) {
    rememberProviders([...ids].map(providerId => ({ providerId, base })), ownershipFile);
    writeConfig(cfg, configPath);
  }

  return {
    changed,
    discoveryFailed: keys.some(entry => entry.discoveryError),
    text: [
      `Synced ${synced.length} provider(s) from ${env.file}:`,
      ...synced.map(entry =>
        `- ${entry.providerName} (${entry.providerId}) <- ${entry.envVar}\n  models: ${entry.models.join(", ")}`,
      ),
      "",
      `Proxy: ${base}`,
      ...keys.filter(entry => entry.discoveryError).map(entry => `Model listing for ${entry.name}: ${entry.discoveryError}; retained previous models.`),
      ...(removed.length ? [`Removed (key no longer in .env): ${removed.join(", ")}`] : []),
      "",
      "Provider settings are saved. ZCode reloads the provider list automatically; reopen its model selector.",
    ].join("\n"),
  };
}
