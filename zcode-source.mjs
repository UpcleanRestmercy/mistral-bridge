import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { effectiveValues, listKeys, slug } from "./env.mjs";
import { readOwnership, rememberProviders, isBridgeEndpoint, loopbackBase } from "./ownership.mjs";

export const providerConfigPath = () => path.join(os.homedir(), ".zcode", "v2", "provider_config.json");

export function isBridgeProvider(rule, ownership = readOwnership()) {
  return Boolean(rule?.providerId?.startsWith("mistral-"))
    && loopbackBase(rule.config?.api?.baseUrl)
    && ownership[rule.providerId]?.includes(rule.config.api.baseUrl) === true;
}

/** Read only bridge-owned native provider rows; unrelated API keys are never returned. */
function providerRows(file) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw new Error("Cannot read ZCode provider settings"); }
  return config.config?.providerConfigRules?.providerRules ?? [];
}

export function nativeProviders(file = providerConfigPath(), ownership = readOwnership()) {
  return providerRows(file).filter(rule => isBridgeProvider(rule, ownership));
}

export async function adoptLegacyProviders({ configPath = providerConfigPath(), ownershipFile } = {}) {
  const ownership = readOwnership(ownershipFile);
  const candidates = providerRows(configPath).filter(rule => rule.providerId?.startsWith("mistral-")
    && !isBridgeProvider(rule, ownership) && loopbackBase(rule.config?.api?.baseUrl));
  const endpoints = new Map();
  const legacy = listKeys(effectiveValues());
  for (const rule of candidates) {
    const base = rule.config.api.baseUrl;
    if (!endpoints.has(base)) endpoints.set(base, isBridgeEndpoint(base));
  }
  const adopted = [];
  for (const rule of candidates) {
    const value = rule.config?.access?.apiKey;
    const explicitLegacy = legacy.some(entry => entry.key === value || `env:${entry.name}` === value);
    if (explicitLegacy || await endpoints.get(rule.config.api.baseUrl)) adopted.push({ providerId: rule.providerId, base: rule.config.api.baseUrl });
  }
  if (adopted.length) rememberProviders(adopted, ownershipFile);
}

/** Prefer credentials edited in ZCode's existing Models settings over legacy dotenv. */
export function zcodeKeys({ configPath = providerConfigPath(), ownershipFile } = {}) {
  const ownership = readOwnership(ownershipFile);
  const removed = new Set(ownership._removed ?? []);
  const legacy = listKeys(effectiveValues()).filter(entry => !removed.has(`mistral-${entry.name}`));
  const rows = nativeProviders(configPath, ownership).filter(rule => !removed.has(rule.providerId));
  if (!rows.length) return legacy;
  const accounts = new Map();
  for (const rule of rows) {
    const value = rule.config?.access?.apiKey ?? "";
    const reference = /^env:(.+)$/.exec(value);
    const match = legacy.find(entry => entry.key === value || `env:${entry.name}` === value);
    if (reference && !match) continue;
    let name = match?.name ?? (reference ? slug(reference[1]) : rule.providerId === "mistral-vibe" ? "default" : slug(rule.providerId.slice(8)));
    const entry = { name, envVar: match?.envVar ?? "ZCode Models settings", key: reference ? match?.key ?? "" : value, models: match?.models ?? null, nativeId: rule.providerId, nativeName: rule.providerName, nativeKey: value };
    const previous = accounts.get(name);
    // Retain the first literal identity when duplicate keys exist. A native
    // edit still wins over an older env reference, even after rotating its key.
    if (!previous || (previous.nativeKey.startsWith("env:") && !reference)) accounts.set(name, entry);
    else if (!reference && !previous.nativeKey.startsWith("env:") && previous.key !== entry.key) {
      name = `${name}-${slug(rule.providerId)}`;
      accounts.set(name, { ...entry, name });
    }
  }
  for (const entry of legacy) {
    const native = accounts.get(entry.name);
    if (native) {
      // Keep nativeKey unchanged for the concurrent-edit guard in syncZcode.
      if (!native.key && native.nativeKey === "") Object.assign(native, {
        key: entry.key, envVar: entry.envVar, models: entry.models, importLegacy: true,
      });
    } else if (![...accounts.values()].some(account => account.key === entry.key)) {
      accounts.set(entry.name, entry);
    }
  }
  return [...accounts.values()];
}

/** Legacy references remain usable; native literal bearer keys pass through the proxy directly. */
export async function resolveZcodeKey(reference) {
  const match = /^env:([a-zA-Z0-9._-]+)$/.exec(reference ?? "");
  if (match) await adoptLegacyProviders();
  return match ? zcodeKeys().find(entry => entry.name === slug(match[1]))?.key ?? null : null;
}
