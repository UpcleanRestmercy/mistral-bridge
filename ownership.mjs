import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OWNER_HEADER = "x-mistral-bridge";
export const OWNER_VALUE = "mistral-bridge/1 ";
export const ownershipPath = () => path.join(os.homedir(), ".zcode", "mistral-proxy", "providers.json");
export const loopbackBase = value => /^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(value ?? "");

export function readOwnership(file = ownershipPath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Cannot read Mistral bridge ownership records");
  }
}

export function rememberProviders(providers, file = ownershipPath()) {
  const data = readOwnership(file);
  for (const { providerId, base } of providers) {
    if (!providerId?.startsWith("mistral-") || !loopbackBase(base)) throw new Error("Invalid bridge ownership record");
    data[providerId] = [...new Set([...(data[providerId] ?? []), base])];
  }
  writeOwnership(data, file);
}

function writeOwnership(data, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function rememberRemoval(ids, file = ownershipPath()) {
  const data = readOwnership(file);
  data._removed = [...new Set([...(data._removed ?? []), ...ids])];
  writeOwnership(data, file);
}

export function restoreRemoved(file = ownershipPath()) {
  const data = readOwnership(file);
  delete data._removed;
  writeOwnership(data, file);
}

/** Legacy adoption probes only loopback health, without credentials or redirects. */
export async function isBridgeEndpoint(base) {
  if (!loopbackBase(base)) return false;
  try {
    const response = await fetch(base.replace(/\/v1$/, "/healthz"), { redirect: "error", signal: AbortSignal.timeout(800) });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const health = await response.json();
    return health?.service === "mistral-bridge" && /^[a-f0-9]{64}$/.test(health.coreSha256)
      && Number.isInteger(health.pid) && health.pid > 0;
  } catch { return false; }
}

export function hasOwnerHeader(profile) {
  return loopbackBase(profile?.baseURL) && Object.entries(profile?.headers ?? {})
    .some(([name, value]) => name.toLowerCase() === OWNER_HEADER && value === OWNER_VALUE + profile.baseURL);
}

/** Match the exact pre-marker bridge shape before consulting its credential. */
export function legacyProfileAccount(provider, profile, accounts) {
  const compat = profile?.compat;
  if (!loopbackBase(profile?.baseURL) || profile.api !== "openai-completions"
    || Object.keys(profile.headers ?? {}).length || profile.retryPolicy?.maxRetries !== 0
    || compat?.thinkingFormat !== "deepseek" || compat.supportsDeveloperRole !== false
    || compat.supportsStore !== false || compat.supportsStrictMode !== false) return undefined;
  return accounts.find(entry => provider === `mistral-${entry.name}` && profile.apiKeyEnv === entry.envVar);
}
