import crypto from "node:crypto";
import { COPILOT_API_ORIGIN, DEFAULT_ANTHROPIC_VERSION } from "./constants.js";
import { loadConfig } from "./config.js";
import { getCopilotToken } from "./auth.js";

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
  const headers = upstreamHeaders(token, { accept, "content-type": contentType, ...extraHeaders });
  let upstream = await fetch(`${COPILOT_API_ORIGIN}${path}`, { method: request.method, headers, body });
  if (upstream.status === 401) {
    const refreshed = await getCopilotToken({ force: true });
    upstream = await fetch(`${COPILOT_API_ORIGIN}${path}`, { method: request.method, headers: upstreamHeaders(refreshed, { accept, "content-type": contentType, ...extraHeaders }), body });
  }
  return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
}

export async function proxyModels(request) {
  const upstreamRequest = new Request(request.url, { method: "GET", headers: request.headers });
  return annotateModelsResponse(await proxyFetch("/models", upstreamRequest));
}

export async function proxyResponses(request) {
  return proxyFetch("/responses", request);
}

export async function proxyMessages(request) {
  const extraHeaders = {
    "anthropic-version": request.headers.get("anthropic-version") || DEFAULT_ANTHROPIC_VERSION
  };
  const beta = request.headers.get("anthropic-beta");
  if (beta) extraHeaders["anthropic-beta"] = beta;
  return proxyFetch("/v1/messages", request, { extraHeaders });
}

export async function proxyChatCompletions(request) {
  const upstreamRequest = await requestWithJsonBody(request, (payload) => {
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
