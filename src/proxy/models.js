import { copyResponseHeaders } from "./headers.js";

export function aerialSupportForModel(model) {
  const endpoints = Array.isArray(model.supported_endpoints) ? model.supported_endpoints : [];
  const routes = [];
  const notes = [];
  if (endpoints.includes("/responses")) routes.push("responses");
  if (endpoints.includes("ws:/responses")) routes.push("responses_websocket");
  if (endpoints.includes("/v1/messages")) routes.push("messages");
  if (endpoints.includes("/chat/completions")) routes.push("chat");
  if (model.capabilities?.type === "embeddings") notes.push("embeddings_not_implemented");
  if (routes.length === 0 && notes.length === 0) notes.push("no_supported_endpoint_advertised");
  return {
    supported: routes.length > 0,
    routes,
    notes
  };
}

export async function annotateModelsResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.includes("application/json")) return response;
  const payload = await response.json();
  if (!Array.isArray(payload.data)) return Response.json(payload, { status: response.status, headers: copyResponseHeaders(response) });
  return Response.json({
    ...payload,
    data: payload.data.map((model) => ({ ...model, aerial: aerialSupportForModel(model) }))
  }, { status: response.status, headers: copyResponseHeaders(response) });
}

export function aerialRoutes(model) {
  return Array.isArray(model?.aerial?.routes) ? model.aerial.routes : [];
}

export function modelsForRoute(models, route) {
  return models
    .filter((model) => typeof model?.id === "string" && aerialRoutes(model).includes(route))
    .map((model) => ({ id: model.id, routes: aerialRoutes(model), notes: model.aerial?.notes || [] }));
}

export function usageSummary(payload) {
  const usage = payload?.usage || payload?.response?.usage || {};
  return {
    input: usage.input_tokens ?? usage.prompt_tokens,
    output: usage.output_tokens ?? usage.completion_tokens,
    cached: usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
  };
}
