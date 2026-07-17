import { loadConfig } from "../shared/config.js";
import { logEvent } from "../shared/log.js";
import { normalizeCodexEffort, normalizeEffort, resolveClaudeEffort, resolveCodexEffort } from "../shared/effort.js";
import {
  canonicalClaudeFamily,
  findCompatibleModel as findCompatibleModelShared,
  supportedReasoningEfforts
} from "./model-catalog.js";
import { withDefaultAnthropicCache, withDefaultPromptCache } from "./cache-policy.js";

function openAIEffortRoute(model, effort, supportedEfforts) {
  if (effort === undefined) return undefined;
  const normalized = normalizeCodexEffort(effort);
  if (!normalized) return undefined;
  const requested = String(effort).trim().toLowerCase();
  const resolved = resolveCodexEffort(normalized, supportedEfforts);
  if (!resolved) return undefined;
  const hasSupportedEffortMetadata = Array.isArray(supportedEfforts)
    && supportedEfforts.some((value) => normalizeCodexEffort(value));
  if (!hasSupportedEffortMetadata && /^gpt-5-mini(?:-|$)/.test(model) && resolved.wireEffort === "xhigh") {
    return { effort: "high", reason: "model_compatibility" };
  }
  if (resolved.wireEffort === requested) return undefined;
  return { effort: resolved.wireEffort, reason: resolved.reason };
}

async function withSupportedOpenAIEffort(payload, loadModels) {
  const model = typeof payload?.model === "string" ? payload.model : "";
  const reasoningEffort = payload?.reasoning && typeof payload.reasoning === "object" ? payload.reasoning.effort : undefined;
  const flatEffort = payload?.reasoning_effort;
  const hasKnownEffort = normalizeCodexEffort(reasoningEffort) || normalizeCodexEffort(flatEffort);
  const models = hasKnownEffort && typeof loadModels === "function"
    ? await loadModels().catch(() => undefined)
    : undefined;
  const selectedModel = Array.isArray(models) ? models.find((entry) => entry?.id === model) : undefined;
  const supportedEfforts = selectedModel ? supportedReasoningEfforts(selectedModel) : undefined;
  const nextReasoningEffort = openAIEffortRoute(model, reasoningEffort, supportedEfforts);
  const nextFlatEffort = openAIEffortRoute(model, flatEffort, supportedEfforts);
  if (!nextReasoningEffort && !nextFlatEffort) return payload;

  const next = { ...payload };
  if (nextReasoningEffort) next.reasoning = { ...payload.reasoning, effort: nextReasoningEffort.effort };
  if (nextFlatEffort) next.reasoning_effort = nextFlatEffort.effort;
  logEvent("openai_effort_route", {
    model,
    effort: reasoningEffort ?? flatEffort,
    routedEffort: nextReasoningEffort?.effort ?? nextFlatEffort?.effort,
    reason: nextReasoningEffort?.reason ?? nextFlatEffort?.reason
  });
  return next;
}

export async function withOpenAIDefaults(payload, loadModels) {
  return withDefaultPromptCache(await withSupportedOpenAIEffort(payload, loadModels));
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function preferredModel(models, modelId) {
  if (!Array.isArray(models)) return undefined;
  return models.find((model) => model?.id === modelId);
}

function fallbackModelForFamily(models, family, preferredId, requestedEffort) {
  const exact = preferredModel(models, preferredId);
  if (exact) return exact;
  const base = preferredModel(models, family);
  if (base) return base;
  if (requestedEffort !== "ultracode") return undefined;
  return findCompatibleModelShared({
    models,
    family,
    route: "/v1/messages",
    adaptiveThinking: true,
    effort: "max"
  });
}

function withSupportedAnthropicEffort(payload, models) {
  const effort = payload?.output_config?.effort;
  if (effort === undefined) return payload;
  const model = typeof payload?.model === "string" ? payload.model : "";
  const family = canonicalClaudeFamily(model);
  const requestedEffort = normalizeEffort(effort);
  if (!requestedEffort) return payload;
  const selectedModel = preferredModel(models, model);
  let routed;
  if (family) {
    routed = findCompatibleModelShared({
      models,
      family,
      route: "/v1/messages",
      adaptiveThinking: true,
      effort: requestedEffort,
      preferredId: model
    });
  }
  const fallbackModel = family ? fallbackModelForFamily(models, family, model, requestedEffort) : selectedModel;
  const resolved = routed
    ? { requestedEffort, resolvedEffort: requestedEffort, wireEffort: requestedEffort, reason: "exact" }
    : resolveClaudeEffort(requestedEffort, supportedReasoningEfforts(fallbackModel));
  const routedEffort = resolved.wireEffort;
  if (!routed && family) {
    routed = findCompatibleModelShared({
        models,
        family,
        route: "/v1/messages",
        adaptiveThinking: true,
        effort: routedEffort,
        preferredId: model
      });
  }
  const nextModel = routed?.id || model;
  const inputEffort = String(effort).trim().toLowerCase();
  if (model === nextModel && inputEffort === routedEffort) return payload;
  logEvent("anthropic_effort_route", { model, effort, routedModel: nextModel, routedEffort, reason: resolved.reason });
  return { ...payload, model: nextModel, output_config: { ...payload.output_config, effort: routedEffort } };
}

function legacyThinkingEffort(thinking) {
  if (typeof thinking?.effort === "string" && thinking.effort.trim()) return thinking.effort.trim();
  const budget = Number(thinking?.budget_tokens);
  if (!Number.isFinite(budget) || budget <= 0) return "medium";
  if (budget <= 4096) return "low";
  if (budget <= 16000) return "medium";
  if (budget <= 64000) return "high";
  return "xhigh";
}

function isLegacyThinkingEnabled(thinking) {
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) return false;
  if (thinking.type === "enabled") return true;
  return Boolean(thinking.type && typeof thinking.type === "object" && thinking.type.enabled);
}

function withSupportedAnthropicThinking(payload) {
  if (!isLegacyThinkingEnabled(payload?.thinking)) return payload;
  const outputConfig = objectOrEmpty(payload?.output_config);
  const effort = outputConfig.effort ?? legacyThinkingEffort(payload.thinking);
  logEvent("anthropic_thinking_route", { model: payload.model, routedType: "adaptive", routedEffort: effort });
  return {
    ...payload,
    thinking: { type: "adaptive" },
    output_config: { ...outputConfig, effort }
  };
}

function shouldLoadAnthropicCatalog(payload) {
  const effort = payload?.output_config?.effort;
  const model = typeof payload?.model === "string" ? payload.model : "";
  return Boolean(model) && Boolean(normalizeEffort(effort));
}

function withDefaultAnthropicEffort(payload) {
  if (payload?.output_config?.effort !== undefined) return payload;
  if (payload?.thinking?.type === "adaptive") return payload;
  const model = typeof payload?.model === "string" ? payload.model : "";
  if (!canonicalClaudeFamily(model)) return payload;
  const config = loadConfig();
  const effort = config.defaultEffort || "medium";
  const outputConfig = objectOrEmpty(payload?.output_config);
  logEvent("anthropic_default_effort", { model, effort });
  return { ...payload, output_config: { ...outputConfig, effort } };
}

export async function withAnthropicDefaults(payload, loadModels) {
  const cached = withDefaultAnthropicCache(payload);
  const thinkingApplied = withSupportedAnthropicThinking(cached);
  const next = withDefaultAnthropicEffort(thinkingApplied);
  const models = shouldLoadAnthropicCatalog(next)
    ? await loadModels().catch(() => undefined)
    : undefined;
  return withSupportedAnthropicEffort(next, models);
}
