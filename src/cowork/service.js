import path from "node:path";
import { openCoworkSession } from "./index.js";
import { CoworkError, errorBody } from "./protocol.js";
import { logEvent } from "../shared/log.js";

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function coworkServiceConfiguration(config) {
  const value = config?.cowork;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)
    || typeof value.model !== "string" || !/^cowork\/[a-z0-9._-]{1,180}$/.test(value.model)
    || typeof value.profileDirectory !== "string" || !path.isAbsolute(value.profileDirectory)
    || !EFFORTS.has(value.effort)
    || (value.displayName !== undefined && (typeof value.displayName !== "string" || value.displayName.length > 256))) {
    throw new CoworkError("COWORK_CONFIG_INVALID", "Invalid Cowork service configuration. Run aerial setup claude --provider cowork --model <id>.", 503);
  }
  return { model: value.model, profileDirectory: path.resolve(value.profileDirectory), effort: value.effort,
    ...(value.displayName ? { displayName: value.displayName } : {}) };
}

function failure(error) {
  return Response.json(errorBody(error), {
    status: error.status || error.statusCode || 502,
    headers: { "cache-control": "no-store", "x-should-retry": "false" }
  });
}

// One service owns one profile writer and reuses its silent WAM refresh. A
// client's cancellation must not cancel another client's shared startup.
export function createCoworkService({ openSession = openCoworkSession, fetchImpl = globalThis.fetch, log = logEvent } = {}) {
  let lifetime = new AbortController();
  let session, pending, selectedSignature, closing, reloading, cleanupFailure, closed = false, inFlight = 0;
  const serviceClosed = () => new CoworkError("COWORK_SERVICE_CLOSED", "Cowork service is shutting down. Restart Aerial before sending another Cowork request.", 503);

  async function getSession(config, duringReload = false) {
    const selected = coworkServiceConfiguration(config);
    if (!selected) throw new CoworkError("COWORK_NOT_CONFIGURED", "Run aerial setup claude --provider cowork --model <id> to configure Cowork on this proxy.", 503);
    if (closed) throw serviceClosed();
    if (reloading && !duringReload) throw new CoworkError("COWORK_RELOADING", "Cowork configuration is being updated. Retry after setup finishes.", 503);
    if (cleanupFailure) throw cleanupFailure;
    const signature = JSON.stringify([selected.model, selected.profileDirectory, selected.effort]);
    if (selectedSignature && signature !== selectedSignature) {
      throw new CoworkError("COWORK_RESTART_REQUIRED", "Cowork configuration changed. Restart the Aerial service to apply it.", 503);
    }
    if (session) return { session, selected };
    if (!pending) {
      selectedSignature = signature;
      pending = (async () => {
        const opened = await openSession({ model: selected.model, effort: selected.effort,
          directory: selected.profileDirectory, signal: lifetime.signal,
          log: event => { const { event: name, ...fields } = event; log(name, fields); } });
        try {
          if (closed) throw serviceClosed();
          const base = new URL(opened.baseUrl);
          if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port
            || base.username || base.password || base.pathname !== "/" || base.search || base.hash
            || opened.model !== selected.model || opened.capabilities?.clientEffort !== selected.effort) {
            throw new CoworkError("COWORK_SESSION_MISMATCH", "Cowork opened a different route or effort than the configured service.", 503);
          }
          session = opened;
          return opened;
        } catch (error) {
          try { await opened.close(); }
          catch (closeError) { cleanupFailure = closeError; throw closeError; }
          throw error;
        }
      })().catch(error => {
        if (error.coworkCleanupFailed) cleanupFailure = error;
        selectedSignature = undefined;
        throw error;
      }).finally(() => { pending = undefined; });
    }
    return { session: await pending, selected };
  }

  const report = (active, selected) => ({ provider: "cowork", configured: true, ready: true, model: active.model,
    upstreamModel: active.route.upstreamId, profileDirectory: selected.profileDirectory,
    effort: active.capabilities.clientEffort, supportedEfforts: active.capabilities.supportedEfforts,
    cloudToolIsolation: active.capabilities.cloudToolIsolation, experimentalTrial: active.capabilities.experimentalTrial,
    conversationReuseVerified: active.capabilities.conversationReuseVerified === true,
    stats: Object.fromEntries(["requests", "upstreamTurns", "toolCalls", "toolResults", "errors", "reused", "conversations"]
      .map(key => [key, active.stats?.[key] || 0])) });

  return {
    models(config) {
      const selected = coworkServiceConfiguration(config);
      if (!selected) return [];
      return [{ id: selected.model, object: "model", type: "model", display_name: selected.displayName || selected.model,
        owned_by: "cowork", supported_endpoints: ["/v1/messages"],
        aerial: { provider: "cowork", supported: true, routes: ["messages"], authentication: "unverified",
          notes: ["configured_route", "prompt_emulated_tools", "estimated_usage"] } }];
    },
    async status(config) {
      if (!coworkServiceConfiguration(config)) return { provider: "cowork", configured: false, ready: false };
      const { session: active, selected } = await getSession(config);
      return report(active, selected);
    },
    async catalog(config) {
      if (!coworkServiceConfiguration(config)) return { provider: "cowork", configured: false, models: [] };
      const { session: active, selected } = await getSession(config);
      return { provider: "cowork", configured: true, profileDirectory: selected.profileDirectory, models: active.catalog || [] };
    },
    reload(config) {
      coworkServiceConfiguration(config);
      if (closed) return Promise.reject(serviceClosed());
      if (reloading || pending || inFlight) return Promise.reject(new CoworkError("COWORK_BUSY", "Cowork has an active request. Let it finish before changing model or effort.", 409));
      if (cleanupFailure) return Promise.reject(cleanupFailure);
      reloading = Promise.resolve().then(async () => {
        try { await session?.close(); }
        catch (error) { cleanupFailure = error; throw error; }
        session = undefined; selectedSignature = undefined;
        lifetime.abort();
        lifetime = new AbortController();
        if (closed) throw serviceClosed();
        if (!coworkServiceConfiguration(config)) return { provider: "cowork", configured: false, ready: false };
        const opened = await getSession(config, true);
        return report(opened.session, opened.selected);
      }).finally(() => { reloading = undefined; });
      return reloading;
    },
    async handle(request, config) {
      let held = false;
      const release = () => { if (held) { held = false; inFlight--; } };
      try {
        if (request.headers.has("origin")) throw new CoworkError("LOCAL_ORIGIN_DENIED", "Cowork accepts local CLI clients only.", 403);
        const selected = coworkServiceConfiguration(config);
        if (!selected) throw new CoworkError("COWORK_NOT_CONFIGURED", "Configure the Cowork provider before using its models.", 503);
        const url = new URL(request.url);
        if (request.method !== "POST" || !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) {
          throw new CoworkError("UNSUPPORTED_CAPABILITY", "Cowork supports the Messages route only.", 400);
        }
        if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
          throw new CoworkError("INVALID_REQUEST", "Use application/json.", 400);
        }
        const bytes = await request.arrayBuffer();
        if (bytes.byteLength > MAX_BODY_BYTES) throw new CoworkError("INVALID_REQUEST", "Cowork requests are limited to 4 MiB.", 413);
        let body;
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new CoworkError("INVALID_REQUEST", "Request must contain valid UTF-8 JSON.", 400); }
        if (body?.model !== selected.model) throw new CoworkError("MODEL_UNAVAILABLE", "The requested Cowork model is not configured; no fallback was used.", 400);
        if (url.pathname === "/v1/messages/count_tokens") {
          throw new CoworkError("NOT_FOUND", "Cowork does not provide authoritative token counting.", 404);
        }
        request.signal.throwIfAborted();
        if (reloading) throw new CoworkError("COWORK_RELOADING", "Cowork configuration is being updated. Retry after setup finishes.", 503);
        inFlight++; held = true;
        const { session: active } = await getSession(config);
        request.signal.throwIfAborted();
        const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${active.apiKey}` });
        for (const name of ["anthropic-version", "anthropic-beta", "idempotency-key", "x-claude-code-session-id", "user-agent"]) {
          if (request.headers.has(name)) headers.set(name, request.headers.get(name));
        }
        // Aerial credentials/cookies never cross this boundary. Only the private
        // gateway's in-memory key can authenticate this loopback hop.
        const response = await fetchImpl(`${active.baseUrl}${url.pathname}${url.search}`, {
          method: "POST", headers, body: bytes, signal: request.signal, redirect: "error"
        });
        if (!response.body) { release(); return response; }
        // Keep the session busy until the streamed response is consumed or
        // canceled, not merely until its HTTP headers arrive.
        const reader = response.body.getReader();
        const bodyStream = new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read();
              if (done) { release(); controller.close(); }
              else controller.enqueue(value);
            } catch (error) { release(); controller.error(error); }
          },
          async cancel(reason) { try { await reader.cancel(reason); } finally { release(); } }
        });
        return new Response(bodyStream, { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) {
        release();
        if (request.signal.aborted) throw error;
        return failure(error);
      }
    },
    close() {
      if (!closing) {
        closed = true;
        lifetime.abort(serviceClosed());
        closing = (async () => {
          try { await reloading; }
          catch (error) { if (cleanupFailure) throw error; }
          try { await pending; }
          catch (error) {
            if (cleanupFailure || (error !== lifetime.signal.reason && error.code !== "COWORK_SERVICE_CLOSED")) throw error;
          }
          if (cleanupFailure) throw cleanupFailure;
          await session?.close();
          session = undefined;
        })();
      }
      return closing;
    }
  };
}
