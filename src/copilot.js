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
  return proxyFetch("/models", upstreamRequest);
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
  return proxyFetch("/chat/completions", request);
}

export async function localCountTokens(request) {
  const payload = await request.json().catch(() => ({}));
  const serialized = JSON.stringify(payload.messages || payload.input || payload);
  return Response.json({ input_tokens: Math.ceil(serialized.length / 4) });
}
