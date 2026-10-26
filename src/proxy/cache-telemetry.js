import { logEvent } from "../shared/log.js";
import { copyResponseHeaders } from "./headers.js";
import { countCacheControlBlocks } from "./cache-policy.js";

const SSE_FRAME_BOUNDARY = /\r?\n\r?\n/;

export function parseJsonBody(body, contentType) {
  if (!body || !contentType.includes("json")) return undefined;
  try {
    return JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return undefined;
  }
}

export function cacheRequestFields(payload) {
  if (!payload || typeof payload !== "object") return {};
  const fields = {
    model: typeof payload.model === "string" ? payload.model : undefined,
    promptCacheRetention: payload.prompt_cache_retention,
    hasPromptCacheKey: payload.prompt_cache_key !== undefined,
    cacheControlBlocks: countCacheControlBlocks(payload)
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== false));
}

function responseItems(payload) {
  return Array.isArray(payload?.input) ? payload.input : [];
}

export function responseHasVision(payload) {
  const visit = (value) => {
    if (Array.isArray(value)) return value.some(visit);
    if (!value || typeof value !== "object") return false;
    if (value.type === "input_image") return true;
    return Array.isArray(value.content) && value.content.some(visit);
  };
  return responseItems(payload).some(visit);
}

export function responseInitiator(payload) {
  const last = responseItems(payload).at(-1);
  if (!last) return "user";
  if (!last.role) return "agent";
  return String(last.role).toLowerCase() === "assistant" ? "agent" : "user";
}

export function hasExplicitCacheRequest(fields) {
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
  const data = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /, ""))
    .join("\n");
  try {
    return [JSON.parse(data)];
  } catch {
    return [];
  }
}

function diagnosticText(value, limit = 256) {
  return typeof value === "string" ? value.slice(0, limit) : undefined;
}

function observeResponseFailure(payload, frame, route, requestCache, requestContext) {
  const eventType = payload?.type || frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
  if (eventType !== "response.failed" && eventType !== "error") return;
  const error = payload?.response?.error || payload?.error || payload;
  logEvent("upstream_response_failed", {
    route,
    eventType,
    model: diagnosticText(requestCache.model),
    requestId: diagnosticText(requestContext.requestId),
    upstreamRequestId: diagnosticText(requestContext.upstreamRequestId),
    responseId: diagnosticText(payload?.response?.id),
    errorCode: diagnosticText(error?.code),
    errorType: diagnosticText(error?.type),
    message: diagnosticText(error?.message, 2048)
  });
}

function shouldEmitCacheObserve(requestCache, usage) {
  return hasExplicitCacheRequest(requestCache) || hasCacheUsage(usage);
}

export function createSseCacheObserver(route, requestCache, requestContext = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  let usage = {};
  let logged = false;

  const consumeFrame = (frame) => {
    for (const payload of sseJsonPayloads(frame)) {
      const fields = usageFields(payload);
      if (Object.keys(fields).length) usage = { ...usage, ...fields };
      observeResponseFailure(payload, frame, route, requestCache, requestContext);
      requestContext.onResponsePayload?.(payload);
    }
  };

  const consume = () => {
    let match;
    while ((match = SSE_FRAME_BOUNDARY.exec(buffer)) !== null) {
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      consumeFrame(frame);
    }
  };

  const emit = () => {
    if (logged) return;
    logged = true;
    if (shouldEmitCacheObserve(requestCache, usage)) {
      logEvent("cache_observe", { route, request: requestCache, usage });
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      try {
        buffer += decoder.decode(chunk, { stream: true });
        consume();
      } catch (error) {
        logEvent("cache_observe_error", { route, error: error.message });
      }
      controller.enqueue(chunk);
    },
    flush() {
      try {
        buffer += decoder.decode();
        consume();
        if (buffer) consumeFrame(buffer);
      } catch (error) {
        logEvent("cache_observe_error", { route, error: error.message });
      }
      emit();
    }
  });
}

async function logJsonCacheUsage(route, requestCache, clone) {
  try {
    const payload = await clone.json();
    const usage = usageFields(payload);
    if (shouldEmitCacheObserve(requestCache, usage)) {
      logEvent("cache_observe", { route, request: requestCache, usage });
    }
  } catch (error) {
    logEvent("cache_observe_error", { route, error: error.message });
  }
}

export function wrapResponseWithCacheObserver(upstream, route, requestCache, requestContext = {}) {
  const headers = copyResponseHeaders(upstream);
  const contentType = upstream.headers.get("content-type") || "";
  if (!upstream.body) return new Response(upstream.body, { status: upstream.status, headers });
  if (contentType.includes("text/event-stream")) {
    const observer = createSseCacheObserver(route, requestCache, {
      requestId: requestContext.requestId,
      upstreamRequestId: upstream.headers.get("x-request-id") || upstream.headers.get("x-github-request-id"),
      onResponsePayload: requestContext.onResponsePayload
    });
    return new Response(upstream.body.pipeThrough(observer), { status: upstream.status, headers });
  }
  if (contentType.includes("json")) {
    void logJsonCacheUsage(route, requestCache, upstream.clone());
    return new Response(upstream.body, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
