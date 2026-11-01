// DSH owns this listener and pi-ai adapter for the plugin's lifetime.
// No ZCode configuration, shared daemon, or process environment is modified.
import fs from "node:fs";
import path from "node:path";
import { effectiveValues, listKeys, resolveKey } from "./env.mjs";
import { createProxy } from "./proxy.mjs";
import { discoverModels } from "./catalog.mjs";
import { OWNER_HEADER, OWNER_VALUE, hasOwnerHeader, isBridgeEndpoint, legacyProfileAccount } from "./ownership.mjs";

export const name = "mistral-bridge";
export const inject = ["llm"];

/** Validate plugin options before opening a listener or registering providers. */
export function resolveOptions(raw = {}) {
  const allowed = new Set(["envFile", "port", "models", "contextWindow", "maxTokens", "reasoning", "reasoningEfforts", "visionModels", "idleMs", "autoDiscover", "refreshModels"]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("mistral-bridge: config must be an object");
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`mistral-bridge: unknown config field ${key}`);
  }
  const options = {
    port: 0,
    models: ["zai-glm-latest"],
    contextWindow: 300000,
    maxTokens: 64000,
    reasoning: "high",
    reasoningEfforts: { low: "low", high: "high", max: "max" },
    visionModels: ["zai-glm-5-3-flash"],
    idleMs: 180000,
    autoDiscover: true,
    refreshModels: 0,
    ...raw,
  };
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("mistral-bridge: port must be 0..65535");
  for (const field of ["contextWindow", "maxTokens", "idleMs"]) {
    if (!Number.isSafeInteger(options[field]) || options[field] <= 0) throw new Error(`mistral-bridge: ${field} must be a positive integer`);
  }
  if (options.idleMs > 2147483647) throw new Error("mistral-bridge: idleMs exceeds the Node timer limit");
  if (options.maxTokens > options.contextWindow) throw new Error("mistral-bridge: maxTokens must not exceed contextWindow");
  for (const field of ["models", "visionModels"]) {
    if (!Array.isArray(options[field]) || options[field].some(value => typeof value !== "string" || !value.trim())) throw new Error(`mistral-bridge: ${field} must contain non-empty model IDs`);
    options[field] = [...new Set(options[field].map(value => value.trim()))];
  }
  if (!options.models.length) throw new Error("mistral-bridge: models must not be empty");
  if (typeof options.reasoning !== "string") throw new Error("mistral-bridge: reasoning must be a level name");
  if (options.reasoningEfforts !== false) {
    const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    if (!options.reasoningEfforts || typeof options.reasoningEfforts !== "object" || Array.isArray(options.reasoningEfforts)) throw new Error("mistral-bridge: reasoningEfforts must be a level map or false");
    const entries = Object.entries(options.reasoningEfforts);
    const invalid = entries.some(([level, wire]) => {
      if (!levels.has(level)) return true;
      if (level === "off" && wire === null) return false;
      return typeof wire !== "string" || !wire.trim();
    });
    if (invalid || !entries.some(([level]) => level !== "off")) throw new Error("mistral-bridge: invalid reasoningEfforts level map");
    if (!Object.hasOwn(options.reasoningEfforts, options.reasoning)) throw new Error("mistral-bridge: reasoning must be offered by reasoningEfforts");
  } else if (options.reasoning !== "off") {
    throw new Error('mistral-bridge: set reasoning to "off" when reasoningEfforts is false');
  }
  if (options.envFile !== undefined) {
    if (typeof options.envFile !== "string" || !options.envFile.trim()) throw new Error("mistral-bridge: envFile must be a non-empty path");
    options.envFile = path.resolve(options.envFile);
    fs.accessSync(options.envFile, fs.constants.R_OK);
  }
  return options;
}

/** Build secret-free DSH pi-ai routes from the discovered account/model names. */
export function providerProfiles(keys, baseURL, options) {
  const providers = Object.create(null);
  for (const entry of keys) {
    const provider = `mistral-${entry.name}`;
    if (Object.hasOwn(providers, provider)) throw new Error(`mistral-bridge: duplicate provider ${provider}; rename the .env variables`);
    providers[provider] = {
      displayName: entry.displayName || (entry.name === "default" ? "Vibe" : entry.name === "arbx" ? "Mistral" : `Mistral (${entry.name})`),
      api: "openai-completions",
      baseURL,
      headers: { Authorization: `Bearer env:${entry.name}`, [OWNER_HEADER]: OWNER_VALUE + baseURL },
      apiKeyEnv: entry.envVar || (entry.name === "default" ? "MISTRAL_API_KEY" : `MISTRAL_API_KEY_${entry.name.replaceAll("-", "_").toUpperCase()}`),
      reasoning: options.reasoning,
      streamIdleTimeoutMs: options.idleMs,
      maxRequestImageBytes: 8 * 1024 * 1024,
      retryPolicy: { mode: "normal", maxRetries: 0 },
      compat: {
        thinkingFormat: "deepseek",
        supportsReasoningEffort: true,
        requiresReasoningContentOnAssistantMessages: true,
        supportsDeveloperRole: false,
        supportsStore: false,
        supportsStrictMode: false,
        maxTokensField: "max_tokens",
      },
      models: entry.retainedModels ?? [...new Set(entry.models?.length ? entry.models : options.models)].map(id => ({
        id,
        name: id,
        contextWindow: entry.catalog?.find(model => model.id === id)?.contextWindow ?? options.contextWindow,
        maxTokens: Math.min(options.maxTokens, entry.catalog?.find(model => model.id === id)?.contextWindow ?? options.contextWindow),
        input: (entry.catalog?.find(model => model.id === id)?.vision ?? options.visionModels.includes(id)) ? ["text", "image"] : ["text"],
        reasoningEfforts: entry.catalog?.find(model => model.id === id)?.reasoning === false ? false : options.reasoningEfforts,
      })),
    };
  }
  return providers;
}

/** Mount the proxy and adapter with Cordis effects; partial startup also unwinds. */
export async function mountBridge(ctx, raw, register) {
  const readOptions = () => resolveOptions(typeof raw === "function" ? raw() : raw);
  const options = readOptions();
  const envOptions = options.envFile === undefined ? {} : { file: options.envFile };
  const imported = new Set();
  const legacyOwnership = new Map();
  const ownedEndpoints = new Set();
  const accounts = async () => {
    const env = listKeys(effectiveValues(envOptions));
    const credentials = ctx.get?.("credentials");
    const namespace = ctx.get?.("settings")?.describe().find(section => section.ns === "llm-pi-ai");
    const native = [];
    for (const [id, profile] of Object.entries(namespace?.value.providers ?? {})) {
      if (!id.startsWith("mistral-")) continue;
      let owned = hasOwnerHeader(profile);
      if (!owned) {
        const legacy = legacyProfileAccount(id, profile, env);
        if (legacy && (await credentials?.resolve(legacy.envVar))?.value === legacy.key) {
          // Explicit Mistral env intent plus the same native credential proves
          // this old account even after its former listener has stopped.
          legacyOwnership.set(id, JSON.stringify(profile));
          owned = true;
        }
      }
      if (owned || await isBridgeEndpoint(profile.baseURL)) {
        ownedEndpoints.add(profile.baseURL);
        native.push([id, profile]);
      }
    }
    const entries = await Promise.all(native.map(async ([id, profile]) => {
      const name = id.slice(8);
      const ref = profile.apiKeyEnv || (name === "default" ? "MISTRAL_API_KEY" : `MISTRAL_API_KEY_${name.replaceAll("-", "_").toUpperCase()}`);
      const legacy = env.find(entry => entry.name === name);
      let stored = await credentials?.resolve(ref);
      if (credentials && !imported.has(ref)) {
        if (!stored?.value && legacy?.key) { await credentials.set(ref, legacy.key); stored = await credentials.resolve(ref); }
        // An empty editor is not a completed import: dotenv may arrive later.
        if (stored?.value) imported.add(ref);
      }
      return { name, envVar: ref, displayName: profile.displayName, key: credentials ? stored?.value || "" : legacy?.key || "", models: legacy?.models, previousModels: Array.isArray(profile.models) ? profile.models : undefined };
    }));
    for (const entry of env) {
      if (entries.some(native => native.name === entry.name)) continue;
      let stored = await credentials?.resolve(entry.envVar);
      if (credentials && !stored?.value && !imported.has(entry.envVar)) {
        await credentials.set(entry.envVar, entry.key);
        stored = await credentials.resolve(entry.envVar);
      }
      if (stored?.value) imported.add(entry.envVar);
      entries.push({ ...entry, key: credentials ? stored?.value || "" : entry.key });
    }
    if (!entries.length && (ctx.get?.("settings") || ctx.get?.("profileContext"))) {
      return [{ name: "default", displayName: "Mistral", envVar: "MISTRAL_API_KEY", key: "", models: null }];
    }
    return entries;
  };
  const keys = await accounts();
  // Check collisions before acquiring resources.
  providerProfiles(keys, "http://127.0.0.1:0/v1", options);
  const server = createProxy({
    role: "dsh",
    idleMs: options.idleMs,
    keyResolver: async reference => (await accounts()).find(account => `env:${account.name}` === reference)?.key || null,
    requireEnvKey: !(ctx.get?.("settings") || ctx.get?.("profileContext")),
  });
  await ctx.effect(async () => {
    const preferred = options.port ? [options.port] : [...new Set([...ownedEndpoints]
      .map(base => Number(new URL(base).port)).filter(port => Number.isInteger(port) && port > 0 && port <= 65535)), 0];
    for (const port of preferred) {
      try {
        await new Promise((resolve, reject) => {
          const fail = error => { server.off("listening", ready); reject(error); };
          const ready = () => { server.off("error", fail); resolve(); };
          server.once("error", fail); server.once("listening", ready);
          server.listen(port, "127.0.0.1");
        });
        break;
      } catch (error) {
        if (options.port || port === 0 || !["EADDRINUSE", "EACCES"].includes(error.code)) throw error;
      }
    }
    return () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  });
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const manager = await register(ctx, providerProfiles(keys, baseURL, options), {
    ownsLegacy: (id, profile) => legacyOwnership.get(id) === JSON.stringify(profile),
  });
  if (!manager?.update) return;
  let disposed = false, syncing = false, pending = false;
  const catalogs = new Map();
  let lastSignature, lastDiscoveryAt = 0, lastRefresh = options.refreshModels;
  const abort = new AbortController();
  const refresh = async () => {
    pending = true;
    if (syncing || disposed) return;
    syncing = true;
    try {
      while (pending && !disposed) {
        pending = false;
        const current = readOptions();
        const entries = await accounts();
        for (const name of catalogs.keys()) {
          if (!entries.some(entry => entry.name === name)) catalogs.delete(name);
        }
        const signature = JSON.stringify([entries, current]);
        if (signature === lastSignature && Date.now() - lastDiscoveryAt < 300000) continue;
        const force = current.refreshModels !== lastRefresh;
        for (const entry of entries) {
          if (!entry.key || entry.models?.length || !current.autoDiscover) continue;
          try {
            entry.catalog = await discoverModels(entry.key, { force, signal: abort.signal });
            catalogs.set(entry.name, { key: entry.key, models: entry.catalog });
          } catch (error) {
            const previous = catalogs.get(entry.name);
            if (previous?.key === entry.key) entry.catalog = previous.models;
            else {
              catalogs.delete(entry.name);
              // Metadata retained by the native host survives process restarts.
              // It neither authorizes a key nor reuses a previous credential.
              if (entry.previousModels?.length) entry.retainedModels = entry.previousModels;
            }
            if (!disposed) ctx.logger?.warn(`mistral-bridge: model discovery for ${entry.name}: ${error.message}`);
          }
          if (entry.catalog) entry.models = entry.catalog.map(model => model.id);
        }
        const applied = !disposed && await manager.update(providerProfiles(entries, baseURL, current));
        lastSignature = applied === false ? undefined : signature;
        lastDiscoveryAt = Date.now();
        lastRefresh = current.refreshModels;
      }
    } finally { syncing = false; }
  };
  ctx.effect(() => {
    const timer = setInterval(() => { void refresh().catch(() => ctx.logger?.error("mistral-bridge: model refresh failed")); }, 3000);
    timer.unref();
    return () => { disposed = true; clearInterval(timer); abort.abort(); };
  });
  ctx.on?.("loader/volatile-update", () => { void refresh().catch(() => ctx.logger?.error("mistral-bridge: model refresh failed")); });
  ctx.on?.("credentials/reference-updated", () => { lastSignature = undefined; void refresh().catch(() => ctx.logger?.error("mistral-bridge: model refresh failed")); });
  void refresh().catch(() => ctx.logger?.error("mistral-bridge: model refresh failed"));
}

/** Load the host's pi-ai adapter only when the DSH entry point is enabled. */
export async function apply(ctx, config) {
  const { register } = await import("./dsh-runtime.mjs");
  await mountBridge(ctx, config, register);
}
