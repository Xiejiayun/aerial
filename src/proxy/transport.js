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
  request.signal.throwIfAborted();
  const nextPayload = await transform(payload);
  request.signal.throwIfAborted();
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: JSON.stringify(nextPayload),
    duplex: "half",
    signal: request.signal
  });
}

export async function proxyFetch(path, request, { extraHeaders = {}, bodyOverride } = {}) {
  const signal = request.signal;
  const token = await getCopilotToken({ signal });
  const body = bodyOverride ?? (request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer());
  const accept = request.headers.get("accept") || "application/json";
  const contentType = request.headers.get("content-type") || "application/json";
  const requestCache = cacheRequestFields(parseJsonBody(body, contentType));
  if (hasExplicitCacheRequest(requestCache)) logEvent("cache_request", { route: path, ...requestCache });
  let headers = upstreamHeaders(token, { accept, "content-type": contentType, ...extraHeaders });
  signal.throwIfAborted();
  let upstream = await upstreamFetch(`${COPILOT_API_ORIGIN}${path}`, { method: request.method, headers, body, signal });
  if (upstream.status === 401) {
    await upstream.body?.cancel().catch(() => {});
    const refreshed = await getCopilotToken({ force: true, signal });
    signal.throwIfAborted();
    headers = upstreamHeaders(refreshed, { accept, "content-type": contentType, ...extraHeaders });
    upstream = await upstreamFetch(`${COPILOT_API_ORIGIN}${path}`, { method: request.method, headers, body, signal });
  }
  if (path === "/models") {
    return new Response(upstream.body, { status: upstream.status, headers: copyResponseHeaders(upstream) });
  }
  return wrapResponseWithCacheObserver(upstream, path, requestCache, { requestId: headers["x-request-id"] });
}

export async function fetchModelsCatalogForCopilot({ signal } = {}) {
  const token = await getCopilotToken({ signal });
  return fetchModelsCatalogShared({
    signal,
    tokenFingerprint: tokenFingerprintOf(token),
    fetchImpl: async () => {
      const response = await upstreamFetch(`${COPILOT_API_ORIGIN}/models`, { method: "GET", headers: upstreamHeaders(token), signal });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const payload = await response.json().catch(() => ({}));
      return Array.isArray(payload?.data) ? payload.data : undefined;
    }
  });
}
