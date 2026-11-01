import { createHash } from "node:crypto";

const cache = new Map();

/** Admit chat models only and keep the provider's capability declarations. */
export function chatModels(body) {
  if (!Array.isArray(body?.data)) throw new Error("Mistral returned an invalid model listing");
  const models = new Map();
  for (const model of body.data) {
    if (typeof model?.id !== "string" || !model.id.trim() || model.capabilities?.completion_chat !== true) continue;
    models.set(model.id, {
      id: model.id,
      name: model.id,
      contextWindow: Number.isSafeInteger(model.max_context_length) && model.max_context_length > 0 ? model.max_context_length : 300000,
      vision: model.capabilities.vision === true,
      reasoning: model.capabilities.reasoning === true,
    });
  }
  if (!models.size) throw new Error("This Mistral account advertises no chat models");
  return [...models.values()];
}

/** Discover without logging or persisting the key; cache is scoped to its digest. */
export async function discoverModels(key, { baseURL = "https://api.mistral.ai/v1", force = false, ttlMs = 300000, signal } = {}) {
  const id = createHash("sha256").update(baseURL).update(key).digest("hex");
  const previous = cache.get(id);
  if (!force && previous && Date.now() - previous.at < ttlMs) return previous.models;
  let response;
  try { response = await fetch(`${baseURL}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  }); } catch { throw new Error("Mistral model listing connection failed"); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Mistral model listing failed (HTTP ${response.status})`);
  }
  let body;
  try { body = await response.json(); }
  catch { throw new Error("Mistral returned an invalid model listing"); }
  const models = chatModels(body);
  cache.set(id, { at: Date.now(), models });
  return models;
}
