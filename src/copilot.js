import crypto from "node:crypto";
import { COPILOT_API_ORIGIN, DEFAULT_ANTHROPIC_VERSION } from "./constants.js";
import { loadConfig } from "./config.js";
import { getCopilotToken } from "./auth.js";
import { logEvent } from "./log.js";

function upstreamHeaders(token, extra = {}) {
  const config = loadConfig();
  return {
    authorization: `Bearer ${token}`,
    accept: extra.accept || "application/json",
    "content-type": extra["content-type"] || "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${config.versions.vscode}`,
    "editor-plugin-version": `copilot-chat/${config.versions.copilotChat}`,
    "user-agent": `GitHubCopilotChat/${config.versions.copilotChat}`,
    "x-github-api-version": "2025-10-01",
    "x-request-id": crypto.randomUUID(),
    ...extra
  };
}

function copyResponseHeaders(upstream) {
  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) headers.set("cache-control", cacheControl);
  return headers;
}

function aerialSupportForModel(model) {
  const endpoints = Array.isArray(model.supported_endpoints) ? model.supported_endpoints : [];
  const routes = [];
  const notes = [];
  if (endpoints.includes("/responses")) routes.push("responses");
  if (endpoints.includes("/v1/messages")) routes.push("messages");
  if (endpoints.includes("/chat/completions")) routes.push("chat");
  if (endpoints.includes("ws:/responses")) notes.push("websocket_responses_not_implemented");
  if (model.capabilities?.type === "embeddings") notes.push("embeddings_not_implemented");
  if (routes.length === 0 && notes.length === 0) notes.push("no_supported_endpoint_advertised");
  return {
    supported: routes.length > 0,
    routes,
    notes
  };
}

async function annotateModelsResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("application/json")) return response;
  const payload = await response.json();
  if (!Array.isArray(payload.data)) return Response.json(payload, { status: response.status, headers: response.headers });
  return Response.json({
    ...payload,
    data: payload.data.map((model) => ({ ...model, aerial: aerialSupportForModel(model) }))
  }, { status: response.status });
}

function configuredPromptCacheRetention(config = loadConfig()) {
  const value = config.promptCacheRetention;
  if (!value || value === "off") return undefined;
  if (!["in_memory", "24h"].includes(value)) return undefined;
  return value;
}

function stableCacheKeyPart(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function metadataCacheKey(metadata) {
  if (!metadata || typeof metadata !== "object") return undefined;
  for (const key of ["prompt_cache_key", "session_id", "conversation_id", "thread_id", "user_id"]) {
    const value = stableCacheKeyPart(metadata[key]);
    if (value) return value;
  }
  return undefined;
}

function configuredPromptCacheKey(payload, config = loadConfig()) {
  const value = config.promptCacheKey;
  if (!value || value === "off") return undefined;
  if (value !== "auto") return String(value);
  const basis = [
    stableCacheKeyPart(payload?.model),
    metadataCacheKey(payload?.metadata),
    stableCacheKeyPart(payload?.conversation_id),
    stableCacheKeyPart(payload?.thread_id),
    stableCacheKeyPart(process.cwd())
  ].filter(Boolean).join(":");
  if (!basis) return undefined;
  return "aerial:" + crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

function withDefaultPromptCache(payload) {
  const config = loadConfig();
  const retention = configuredPromptCacheRetention(config);
  const promptCacheKey = configuredPromptCacheKey(payload, config);
  const next = { ...payload };
  if (retention && next.prompt_cache_retention === undefined) next.prompt_cache_retention = retention;
  if (promptCacheKey && next.prompt_cache_key === undefined) next.prompt_cache_key = promptCacheKey;
  return next;
}

function openAIEffortRoute(model, effort) {
  if (effort === undefined) return undefined;
  if (/^gpt-5-mini(?:-|$)/.test(model) && ["xhigh", "max"].includes(effort)) return "high";
  if (effort === "max") return "xhigh";
  return undefined;
}

function withSupportedOpenAIEffort(payload) {
  const model = typeof payload?.model === "string" ? payload.model : "";
  const reasoningEffort = payload?.reasoning && typeof payload.reasoning === "object" ? payload.reasoning.effort : undefined;
  const nextReasoningEffort = openAIEffortRoute(model, reasoningEffort);
  const nextFlatEffort = openAIEffortRoute(model, payload?.reasoning_effort);
  if (!nextReasoningEffort && !nextFlatEffort) return payload;

  const next = { ...payload };
  if (nextReasoningEffort) next.reasoning = { ...payload.reasoning, effort: nextReasoningEffort };
  if (nextFlatEffort) next.reasoning_effort = nextFlatEffort;
  logEvent("openai_effort_route", {
    model,
    effort: reasoningEffort ?? payload?.reasoning_effort,
    routedEffort: nextReasoningEffort ?? nextFlatEffort
  });
  return next;
}

function withOpenAIDefaults(payload) {
  return withDefaultPromptCache(withSupportedOpenAIEffort(payload));
}

function addEphemeralCacheControl(value) {
  if (typeof value === "string") {
    return value.trim() ? { value: [{ type: "text", text: value, cache_control: { type: "ephemeral" } }], changed: true } : { value, changed: false };
  }
  if (!Array.isArray(value) || value.length === 0) return { value, changed: false };
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const item = value[i];
    if (item && typeof item === "object" && !Array.isArray(item) && item.cache_control === undefined) {
      const next = [...value];
      next[i] = { ...item, cache_control: { type: "ephemeral" } };
      return { value: next, changed: true };
    }
  }
  return { value, changed: false };
}

function withDefaultAnthropicCache(payload) {
  const retention = configuredPromptCacheRetention();
  if (!retention || countCacheControlBlocks(payload) > 0) return payload;
  const next = { ...payload };
  const system = addEphemeralCacheControl(next.system);
  if (system.changed) return { ...next, system: system.value };
  if (Array.isArray(next.tools) && next.tools.length > 0) {
    const tools = addEphemeralCacheControl(next.tools);
    if (tools.changed) return { ...next, tools: tools.value };
  }
  return next;
}

function withSupportedAnthropicEffort(payload) {
  const effort = payload?.output_config?.effort;
  if (effort === undefined) return payload;
  const model = typeof payload?.model === "string" ? payload.model : "";
  if (!/^claude-opus-4[.-]7(?:-|$)/.test(model)) return payload;
  const routes = {
    low: "claude-opus-4.7-1m-internal",
    medium: "claude-opus-4.7",
    high: "claude-opus-4.7-high",
    xhigh: "claude-opus-4.7-xhigh",
    max: "claude-opus-4.7-xhigh"
  };
  const nextModel = routes[effort];
  const nextEffort = effort === "max" ? "xhigh" : effort;
  if (!nextModel) return payload;
  if (model === nextModel && effort === nextEffort) return payload;
  logEvent("anthropic_effort_route", { model, effort, routedModel: nextModel, routedEffort: nextEffort });
  return { ...payload, model: nextModel, output_config: { ...payload.output_config, effort: nextEffort } };
}

function withAnthropicDefaults(payload) {
  return withSupportedAnthropicEffort(withDefaultAnthropicCache(payload));
}

function parseJsonBody(body, contentType) {
  if (!body || !contentType.includes("json")) return undefined;
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return undefined;
  }
}

function countCacheControlBlocks(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countCacheControlBlocks(item), 0);
  return Object.entries(value).reduce((total, [key, item]) => total + (key === "cache_control" ? 1 : 0) + countCacheControlBlocks(item), 0);
}

function cacheRequestFields(payload) {
  if (!payload || typeof payload !== "object") return {};
  const fields = {
    model: typeof payload.model === "string" ? payload.model : undefined,
    promptCacheRetention: payload.prompt_cache_retention,
    hasPromptCacheKey: payload.prompt_cache_key !== undefined,
    cacheControlBlocks: countCacheControlBlocks(payload)
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== false && value !== 0));
}

function hasExplicitCacheRequest(fields) {
  return fields.promptCacheRetention !== undefined || fields.hasPromptCacheKey === true || Number(fields.cacheControlBlocks || 0) > 0;
}

function sumCopilotCacheDetails(details, kind) {
  if (!Array.isArray(details)) return undefined;
  const total = details.reduce((sum, detail) => {
    const label = String(detail.type || detail.name || detail.kind || detail.cache || "");
    if (!label.includes(kind)) return sum;
    return sum + Number(detail.tokens || detail.count || detail.token_count || 0);
  }, 0);
  return total || undefined;
}

function usageFields(payload) {
  const usage = payload?.usage || payload?.response?.usage;
  if (!usage || typeof usage !== "object") return {};
  const copilotDetails = usage.copilot_usage?.token_details || payload?.copilot_usage?.token_details;
  const fields = {
    input: usage.input_tokens ?? usage.prompt_tokens,
    output: usage.output_tokens ?? usage.completion_tokens,
    cached: usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
    cacheCreation: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    copilotCacheRead: sumCopilotCacheDetails(copilotDetails, "cache_read"),
    copilotCacheWrite: sumCopilotCacheDetails(copilotDetails, "cache_write")
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function hasCacheUsage(fields) {
  return fields.cached !== undefined || fields.cacheCreation !== undefined || fields.cacheRead !== undefined || fields.copilotCacheRead !== undefined || fields.copilotCacheWrite !== undefined;
}

function sseJsonPayloads(text) {
  return text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

async function logCacheResult(route, requestCache, upstream) {
  const contentType = upstream.headers.get("content-type") || "";
  let usage = {};
  try {
    if (contentType.includes("text/event-stream")) {
      for (const payload of sseJsonPayloads(await upstream.text())) usage = { ...usage, ...usageFields(payload) };
    } else if (contentType.includes("json")) {
      usage = usageFields(await upstream.json());
    }
  } catch (error) {
    logEvent("cache_observe_error", { route, error: error.message });
    return;
  }
  if (hasExplicitCacheRequest(requestCache) || hasCacheUsage(usage)) {
    logEvent("cache_observe", { route, request: requestCache, usage });
  }
}

async function requestWithJsonBody(request, transform) {
  const payload = await request.json();
  const nextPayload = transform(payload);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(nextPayload),
    duplex: "half"
  });
}

async function proxyFetch(path, request, { extraHeaders = {} } = {}) {
  const token = await getCopilotToken();
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const accept = request.headers.get("accept") || "application/json";
  const contentType = request.headers.get("content-type") || "application/json";
  const requestCache = cacheRequestFields(parseJsonBody(body, contentType));
  if (hasExplicitCacheRequest(requestCache)) logEvent("cache_request", { route: path, ...requestCache });
  const headers = upstreamHeaders(token, { accept, "content-type": contentType, ...extraHeaders });
  let upstream = await fetch(`${COPILOT_API_ORIGIN}${path}`, { method: request.method, headers, body });
  if (upstream.status === 401) {
    const refreshed = await getCopilotToken({ force: true });
    upstream = await fetch(`${COPILOT_API_ORIGIN}${path}`, { method: request.method, headers: upstreamHeaders(refreshed, { accept, "content-type": contentType, ...extraHeaders }), body });
  }
  if (path !== "/models") void logCacheResult(path, requestCache, upstream.clone());
  return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
}

export async function proxyModels(request) {
  const upstreamRequest = new Request(request.url, { method: "GET", headers: request.headers });
  return annotateModelsResponse(await proxyFetch("/models", upstreamRequest));
}

export async function proxyResponses(request) {
  const upstreamRequest = await requestWithJsonBody(request, withOpenAIDefaults);
  return proxyFetch("/responses", upstreamRequest);
}

export async function proxyMessages(request) {
  const extraHeaders = {
    "anthropic-version": request.headers.get("anthropic-version") || DEFAULT_ANTHROPIC_VERSION
  };
  const beta = request.headers.get("anthropic-beta");
  if (beta) extraHeaders["anthropic-beta"] = beta;
  const upstreamRequest = await requestWithJsonBody(request, withAnthropicDefaults);
  return proxyFetch("/v1/messages", upstreamRequest, { extraHeaders });
}

export async function proxyChatCompletions(request) {
  const upstreamRequest = await requestWithJsonBody(request, (payload) => {
    payload = withOpenAIDefaults(payload);
    if (payload.max_tokens !== undefined && payload.max_completion_tokens === undefined) {
      const { max_tokens, ...rest } = payload;
      return { ...rest, max_completion_tokens: max_tokens };
    }
    return payload;
  });
  return proxyFetch("/chat/completions", upstreamRequest);
}

export async function localCountTokens(request) {
  const payload = await request.json().catch(() => ({}));
  const serialized = JSON.stringify(payload.messages || payload.input || payload);
  return Response.json({ input_tokens: Math.ceil(serialized.length / 4) });
}
