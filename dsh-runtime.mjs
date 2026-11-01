// Use the public adapter class without mounting a second generic settings/catalog plugin.
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveImageAttachmentAccess, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { hasOwnerHeader, isBridgeEndpoint } from "./ownership.mjs";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Register only the bridge's routes; Cordis withdraws them when this plugin unloads. */
export function register(ctx, routes, ownership) {
  if (ctx.get("profileContext") || ctx.get("settings")) return nativeManager(ctx, ownership);
  const api = openAICompletionsApi();
  const buildProfiles = routes => new Map(Object.entries(routes).map(([provider, route]) => {
    const models = route.models.map(({ reasoningEfforts, ...model }) => ({
      ...model,
      provider,
      api: route.api,
      baseUrl: route.baseURL,
      compat: route.compat,
      reasoning: reasoningEfforts !== false,
      ...(reasoningEfforts === false ? {} : {
        thinkingLevelMap: Object.fromEntries(LEVELS.flatMap(level => {
          const wire = reasoningEfforts[level];
          return wire === null && level === "off" ? [] : [[level, wire ?? null]];
        })),
      }),
      // No price is claimed for account-specific Mistral plans.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    return [provider, {
      ...route,
      provider,
      requestImagePixelBudget: 2048 * 2048,
      requestImageMaxBytes: 1024 * 1024,
      modelErrors: new Map(),
      configuredMaxTokens: new Map(models.map(model => [model.id, model.maxTokens])),
      retryPolicy: resolveRetryPolicy(route.retryPolicy, "mistral-bridge"),
      piProvider: {
        id: provider,
        name: route.displayName,
        baseUrl: route.baseURL,
        auth: { apiKey: {
          name: "mistral-bridge",
          resolve: ({ credential }) => Promise.resolve({
            auth: credential?.key === undefined ? {} : { apiKey: credential.key },
            source: "mistral-bridge",
          }),
        } },
        getModels: () => models,
        stream: (model, context, options) => api.stream(model, context, options),
        streamSimple: (model, context, options) => api.streamSimple(model, context, options),
      },
    }];
  }));
  let profiles = buildProfiles(routes);
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: {
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async () => { throw new Error("mistral-bridge: credentials are managed in .env"); },
        delete: async () => { throw new Error("mistral-bridge: credentials are managed in .env"); },
      },
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
    // Only the local proxy sees the actual key. This also avoids ambient key discovery.
    resolveApiKey: provider => Promise.resolve(`env:${provider.slice("mistral-".length)}`),
    resolveAttachments: () => ctx.get("attachments"),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get("fs")?.processPathFromHostPath(hostPath), ref,
    ),
  });
  let registration = profiles.size ? ctx.llm.registerAdapter([...profiles.keys()], adapter) : null;
  return {
    update(routes) {
      const next = buildProfiles(routes);
      const previous = profiles;
      profiles = next;
      try {
        if (registration) registration.replace([...next.keys()]);
        else if (next.size) registration = ctx.llm.registerAdapter([...next.keys()], adapter);
      } catch (error) { profiles = previous; throw error; }
    },
  };
}

/** Use the host's existing Models editor and credential store. */
function nativeManager(ctx, ownership) {
  return {
    async update(routes) {
      const settings = ctx.get("settings");
      const namespace = settings?.describe().find(section => section.ns === "llm-pi-ai");
      if (!namespace) return false;
      const current = namespace.value.providers ?? {};
      const ops = [];
      for (const [provider, route] of Object.entries(routes)) {
        if (current[provider] && !hasOwnerHeader(current[provider]) && !ownership?.ownsLegacy(provider, current[provider]) && !await isBridgeEndpoint(current[provider].baseURL)) {
          throw new Error("Refusing to overwrite a provider not managed by mistral-bridge");
        }
        const { headers, ...profile } = route;
        profile.headers = Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"));
        const next = { ...current[provider], ...profile, apiKeyEnv: route.apiKeyEnv };
        // Each model advertises its own efforts; a route-wide default would reject non-reasoning models.
        delete next.reasoning;
        if (JSON.stringify(next) !== JSON.stringify(current[provider])) ops.push({ op: "set", path: ["providers", provider], value: next });
      }
      if (ops.length) await settings.mutate("llm-pi-ai", ops, namespace.revision);
      return true;
    },
  };
}
