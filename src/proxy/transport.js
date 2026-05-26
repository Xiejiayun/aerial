import { COPILOT_API_ORIGIN } from "../shared/constants.js";
import { getCopilotToken } from "../shared/auth.js";
import { logEvent } from "../shared/log.js";
import { upstreamFetch } from "../upstream/fetch.js";
import { fetchModelsCatalog as fetchModelsCatalogShared, tokenFingerprintOf } from "./model-catalog.js";
import { copyResponseHeaders, upstreamHeaders } from "./headers.js";
import {
  cacheRequestFields,
  hasExplicitCacheRequest,
  parseJsonBody,
  wrapResponseWithCacheObserver
} from "./cache-telemetry.js";

export async function requestWithJsonBody(request, transform) {
  const payload = await request.json();
  const nextPayload = await transform(payload);
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(nextPayload),
    duplex: "half"
  });
}

export async function proxyFetch(path, request, { extraHeaders = {}, bodyOverride } = {}) {
  const token = await getCopilotToken();
  const body = bodyOverride ?? (request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer());
  const accept = request.headers.get("accept") || "application/json";
  const contentType = request.headers.get("content-type") || "application/json";
  const requestCache = cacheRequestFields(parseJsonBody(body, contentType));
  if (hasExplicitCacheRequest(requestCache)) logEvent("cache_request", { route: path, ...requestCache });
  const headers = upstreamHeaders(token, { accept, "content-type": contentType, ...extraHeaders });
  let upstream = await upstreamFetch(`${COPILOT_API_ORIGIN}${path}`, { method: request.method, headers, body });
  if (upstream.status === 401) {
    const refreshed = await getCopilotToken({ force: true });
    upstream = await upstreamFetch(`${COPILOT_API_ORIGIN}${path}`, { method: request.method, headers: upstreamHeaders(refreshed, { accept, "content-type": contentType, ...extraHeaders }), body });
  }
  if (path === "/models") {
    return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
  }
  return wrapResponseWithCacheObserver(upstream, path, requestCache);
}

export async function fetchModelsCatalogForCopilot() {
  const token = await getCopilotToken();
  return fetchModelsCatalogShared({
    tokenFingerprint: tokenFingerprintOf(token),
    fetchImpl: async () => {
      const response = await upstreamFetch(`${COPILOT_API_ORIGIN}/models`, { method: "GET", headers: upstreamHeaders(token) });
      if (!response.ok) return undefined;
      const payload = await response.json().catch(() => ({}));
      return Array.isArray(payload?.data) ? payload.data : undefined;
    }
  });
}
