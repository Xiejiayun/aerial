import { DEFAULT_ANTHROPIC_VERSION } from "../shared/constants.js";
import { getCopilotToken } from "../shared/auth.js";
import { logEvent } from "../shared/log.js";
import { isResponsesWebSocketOptIn, proxyResponsesWebSocket, shouldUseResponsesWebSocket } from "./responses-websocket.js";
import { annotateModelsResponse } from "./models.js";
import { upstreamHeaders } from "./headers.js";
import { withAnthropicDefaults, withOpenAIDefaults } from "./effort-routing.js";
import {
  cacheRequestFields,
  createSseCacheObserver,
  hasExplicitCacheRequest,
  responseHasVision,
  responseInitiator
} from "./cache-telemetry.js";
import { fetchModelsCatalogForCopilot, proxyFetch, requestWithJsonBody } from "./transport.js";

function responseModelFromCatalog(modelId, models) {
  return models.find((model) => model.id === modelId);
}

export async function proxyModels(request) {
  const upstreamRequest = new Request(request.url, { method: "GET", headers: request.headers });
  return annotateModelsResponse(await proxyFetch("/models", upstreamRequest));
}

export async function proxyResponses(request) {
  const payload = await withOpenAIDefaults(await request.json(), fetchModelsCatalogForCopilot);
  const body = Buffer.from(JSON.stringify(payload));

  if (payload?.stream && isResponsesWebSocketOptIn()) {
    const models = await fetchModelsCatalogForCopilot().catch(() => undefined);
    const model = models ? responseModelFromCatalog(payload.model, models) : undefined;
    if (shouldUseResponsesWebSocket(payload, model)) {
      const requestCache = cacheRequestFields(payload);
      if (hasExplicitCacheRequest(requestCache)) logEvent("cache_request", { route: "/responses", ...requestCache });
      const token = await getCopilotToken();
      const initiator = responseInitiator(payload);
      const headers = upstreamHeaders(token, {
        accept: "text/event-stream",
        "content-type": request.headers.get("content-type") || "application/json",
        ...(responseHasVision(payload) ? { "copilot-vision-request": "true" } : {})
      });
      logEvent("responses_websocket", { model: payload.model });
      const response = await proxyResponsesWebSocket(payload, headers, { initiator });
      if (!response.body) return response;
      const observer = createSseCacheObserver("/responses", requestCache);
      return new Response(response.body.pipeThrough(observer), { status: response.status, headers: response.headers });
    }
    logEvent("responses_websocket_skip", {
      model: payload.model,
      reason: !model ? "model_unknown" : "model_no_ws_endpoint"
    });
  }

  const upstreamRequest = new Request(request.url, { method: request.method, headers: request.headers, body, duplex: "half" });
  return proxyFetch("/responses", upstreamRequest, { bodyOverride: body });
}

export async function proxyMessages(request) {
  const extraHeaders = {
    "anthropic-version": request.headers.get("anthropic-version") || DEFAULT_ANTHROPIC_VERSION
  };
  const beta = request.headers.get("anthropic-beta");
  if (beta) extraHeaders["anthropic-beta"] = beta;
  const upstreamRequest = await requestWithJsonBody(request, (payload) => withAnthropicDefaults(payload, fetchModelsCatalogForCopilot));
  return proxyFetch("/v1/messages", upstreamRequest, { extraHeaders });
}

export async function proxyChatCompletions(request) {
  const upstreamRequest = await requestWithJsonBody(request, async (payload) => {
    payload = await withOpenAIDefaults(payload, fetchModelsCatalogForCopilot);
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
