// .env loading that follows the oh-my-pi (can1357/oh-my-pi) convention:
//
//   1. Existing process environment wins.
//   2. Then .env files fill only unset keys, in order:
//        <cwd>/.env  ->  ~/.zcode/.env  ->  ~/.env
//   3. Files are parsed with node:util.parseEnv (quoted values, escaped
//      newlines, inline comments), keeping shell-identifier names only.
//
// MISTRAL_BRIDGE_ENV replaces the file list with one explicit path.
//
// Key naming:
//   MISTRAL_API_KEY          -> provider "mistral-default"
//   MISTRAL_API_KEY_WORK     -> provider "mistral-work"
//   MISTRAL_MODELS           -> default model list, comma separated
//   MISTRAL_MODELS_WORK      -> per-key override

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv as parseDotenv } from "node:util";
import { createHash } from "node:crypto";

export const KEY_VAR = "MISTRAL_API_KEY";
export const MODELS_VAR = "MISTRAL_MODELS";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

// Wraps node:util.parseEnv and drops names that cannot be exported to a shell.
export function parseEnv(text) {
  let parsed;
  try {
    parsed = parseDotenv(String(text));
  } catch {
    return {};
  }
  const values = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!ENV_NAME_RE.test(name)) continue;
    if (typeof value !== "string" || value.includes("\0")) continue;
    values[name] = value;
  }
  return values;
}

export function defaultEnvFiles() {
  return [
    path.join(process.cwd(), ".env"),
    path.join(os.homedir(), ".zcode", ".env"),
    path.join(os.homedir(), ".env"),
  ];
}

// Identify a daemon's credential source without publishing paths or key values.
// File contents are excluded because they are reloaded on each request.
export function credentialSourceId({ env = process.env, cwd = process.cwd(), home = os.homedir() } = {}) {
  const files = env.MISTRAL_BRIDGE_ENV ? [path.resolve(cwd, env.MISTRAL_BRIDGE_ENV)]
    : [path.join(cwd, ".env"), path.join(home, ".zcode", ".env"), path.join(home, ".env")];
  const overrides = Object.entries(env).filter(([name, value]) => isRelevant(name) && value)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify([home, files, overrides])).digest("hex");
}

const fileCache = new Map();

function readEnvFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.values;
  let values = {};
  try {
    values = parseEnv(fs.readFileSync(file, "utf8"));
  } catch {
    values = {};
  }
  fileCache.set(file, { mtimeMs: stat.mtimeMs, values });
  return values;
}

// Returns the file values only. Earlier files win, matching oh-my-pi.
export function loadEnv({ file } = {}) {
  const targets = file
    ? [path.resolve(file)]
    : process.env.MISTRAL_BRIDGE_ENV
      ? [path.resolve(process.env.MISTRAL_BRIDGE_ENV)]
      : defaultEnvFiles();
  const values = {};
  const files = [];
  for (const target of targets) {
    const parsed = readEnvFile(target);
    if (!parsed) continue;
    files.push(target);
    for (const [name, value] of Object.entries(parsed)) {
      if (values[name] === undefined) values[name] = value;
    }
  }
  return { file: files[0] ?? null, files, values };
}

function isRelevant(name) {
  return name === KEY_VAR
    || name.startsWith(`${KEY_VAR}_`)
    || name === MODELS_VAR
    || name.startsWith(`${MODELS_VAR}_`);
}

// Process environment overrides file values, as the standard requires.
export function effectiveValues(options) {
  const values = { ...loadEnv(options).values };
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || value === "" || !isRelevant(name)) continue;
    values[name] = value;
  }
  return values;
}

function modelsFor(name, values) {
  const specific = values[`${MODELS_VAR}_${name.toUpperCase().replace(/-/g, "_")}`];
  const raw = specific ?? values[MODELS_VAR];
  if (raw === undefined || !String(raw).trim()) return null;
  return String(raw).split(",").map(model => model.trim()).filter(Boolean);
}

// Returns keys in a stable order: "default" first, then alphabetical.
export function listKeys(values = effectiveValues()) {
  const keys = [];
  for (const [envVar, rawValue] of Object.entries(values)) {
    if (envVar !== KEY_VAR && !envVar.startsWith(`${KEY_VAR}_`)) continue;
    const name = envVar === KEY_VAR ? "default" : slug(envVar.slice(KEY_VAR.length + 1));
    if (!name) continue;
    const key = String(rawValue).trim();
    if (!key) continue;
    keys.push({ name, envVar, key, models: modelsFor(name, values) });
  }
  return keys.sort((a, b) =>
    a.name === "default" ? -1 : b.name === "default" ? 1 : a.name.localeCompare(b.name),
  );
}

// Resolves the "env:<name>" placeholder stored in ZCode's provider config.
export function resolveKey(reference, options) {
  if (typeof reference !== "string") return null;
  const match = /^env:([A-Za-z0-9._-]+)$/.exec(reference.trim());
  if (!match) return null;
  const name = slug(match[1]);
  return listKeys(effectiveValues(options)).find(entry => entry.name === name)?.key ?? null;
}
