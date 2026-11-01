import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listKeys, loadEnv, parseEnv, resolveKey } from "./env.mjs";

const MISTRAL_ENV_RE = /^MISTRAL_(API_KEY|MODELS)(_|$)/;

function clearMistralEnv() {
  const saved = new Map();
  for (const name of Object.keys(process.env)) {
    if (MISTRAL_ENV_RE.test(name)) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  }
  return () => {
    for (const [name, value] of saved) process.env[name] = value;
  };
}

function withEnvFile(text, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-env-test-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, text);
  const previous = process.env.MISTRAL_BRIDGE_ENV;
  process.env.MISTRAL_BRIDGE_ENV = file;
  const restore = clearMistralEnv();
  try {
    return run(file);
  } finally {
    restore();
    if (previous === undefined) delete process.env.MISTRAL_BRIDGE_ENV;
    else process.env.MISTRAL_BRIDGE_ENV = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("parses comments, export, quotes, multiline and inline comments", () => {
  const values = parseEnv([
    "# comment",
    "MISTRAL_API_KEY=plain-value",
    'export MISTRAL_API_KEY_WORK="quoted value"',
    "MISTRAL_API_KEY_PERSONAL='single # kept'",
    "MISTRAL_API_KEY_HASH=abc#def",
    "MISTRAL_API_KEY_TRAIL=abc # trailing comment",
    'MULTILINE="line1\\nline2"',
    "not a valid line",
    "",
  ].join("\n"));
  assert.equal(values.MISTRAL_API_KEY, "plain-value");
  assert.equal(values.MISTRAL_API_KEY_WORK, "quoted value");
  assert.equal(values.MISTRAL_API_KEY_PERSONAL, "single # kept");
  // Unquoted # starts a comment, matching node:util.parseEnv.
  assert.equal(values.MISTRAL_API_KEY_HASH, "abc");
  assert.equal(values.MISTRAL_API_KEY_TRAIL, "abc");
  assert.equal(values.MULTILINE, "line1\nline2");
});

test("lists multiple keys in stable order with model overrides", () => {
  const keys = listKeys(parseEnv([
    "MISTRAL_API_KEY=default-key",
    "MISTRAL_API_KEY_WORK=work-key",
    "MISTRAL_API_KEY_ALPHA=alpha-key",
    "MISTRAL_MODELS=base-model",
    "MISTRAL_MODELS_WORK=work-a, work-b",
  ].join("\n")));
  assert.deepEqual(keys.map(key => key.name), ["default", "alpha", "work"]);
  assert.deepEqual(keys.find(key => key.name === "work").models, ["work-a", "work-b"]);
  assert.deepEqual(keys.find(key => key.name === "default").models, ["base-model"]);
  assert.equal(keys.find(key => key.name === "alpha").envVar, "MISTRAL_API_KEY_ALPHA");
});

test("ignores empty values and unrelated variables", () => {
  const keys = listKeys(parseEnv([
    "MISTRAL_API_KEY=",
    "MISTRAL_API_KEY_WORK=",
    "OTHER=1",
    "MISTRAL_API_KEYS=comma,separated",
  ].join("\n")));
  assert.deepEqual(keys, []);
});

test("resolves env: references and rejects anything else", () => {
  withEnvFile("MISTRAL_API_KEY=one\nMISTRAL_API_KEY_WORK=two\n", file => {
    assert.equal(loadEnv().file, file);
    assert.equal(resolveKey("env:default"), "one");
    assert.equal(resolveKey("env:work"), "two");
    assert.equal(resolveKey("env:missing"), null);
    assert.equal(resolveKey("literal-key"), null);
    assert.equal(resolveKey("env:WORK"), "two");
  });
});

test("process environment overrides .env values", () => {
  withEnvFile("MISTRAL_API_KEY=from-file\nMISTRAL_API_KEY_WORK=file-work\n", () => {
    process.env.MISTRAL_API_KEY = "from-process";
    assert.equal(resolveKey("env:default"), "from-process");
    assert.equal(resolveKey("env:work"), "file-work");
  });
});

test("returns an empty environment when no file exists", () => {
  const previous = process.env.MISTRAL_BRIDGE_ENV;
  process.env.MISTRAL_BRIDGE_ENV = path.join(os.tmpdir(), "mistral-env-missing", ".env");
  const restore = clearMistralEnv();
  try {
    assert.deepEqual(loadEnv().values, {});
    assert.deepEqual(listKeys(), []);
    assert.equal(resolveKey("env:default"), null);
  } finally {
    restore();
    if (previous === undefined) delete process.env.MISTRAL_BRIDGE_ENV;
    else process.env.MISTRAL_BRIDGE_ENV = previous;
  }
});
