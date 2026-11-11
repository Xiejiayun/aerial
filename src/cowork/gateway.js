import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { CoworkError, prepareRequest, decodeCompletion, completionMessage, messageStart, messageEvents, errorBody } from "./protocol.js";
import { createOperationStore } from "./operations.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CAPABILITY_HEADERS = {
  "cache-control": "no-store",
  "x-cwg-mode": "cowork-emulated",
  "x-cwg-tools": "prompt-emulated",
  "x-cwg-streaming": "buffered-completion",
  "x-cwg-usage-source": "estimated",
  "x-should-retry": "false"
};

function abortError(signal) { return signal.reason instanceof Error ? signal.reason : new CoworkError("LOCAL_CANCELLED", "Local request ended; the remote task may still be running.", 499); }

function withSignal(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function writeChunk(res, chunk, timeoutMs = 30_000, signal) {
  signal?.throwIfAborted();
  if (res.destroyed || res.writableEnded) throw new CoworkError("LOCAL_CANCELLED", "Local response is closed.", 499);
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer); res.off("drain", drained); res.off("close", closed); res.off("error", failed); signal?.removeEventListener("abort", aborted);
      error ? reject(error) : resolve();
    };
    const drained = () => finish();
    const closed = () => finish(new CoworkError("LOCAL_CANCELLED", "Local response closed during delivery.", 499));
    const failed = () => finish(new CoworkError("LOCAL_DELIVERY_FAILED", "Local response delivery failed.", 502));
    const aborted = () => finish(abortError(signal));
    const timer = setTimeout(() => { finish(new CoworkError("LOCAL_DELIVERY_TIMEOUT", "The local client stopped consuming the response.", 504)); res.destroy(); }, timeoutMs);
    res.once("drain", drained); res.once("close", closed); res.once("error", failed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (res.destroyed) closed();
    else if (signal?.aborted) aborted();
  });
}

function eventFrame(event) { return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`; }
function json(res, status, value, headers = {}) {
  res.writeHead(status, { ...CAPABILITY_HEADERS, ...headers, "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function readJson(req, signal) {
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new CoworkError("INVALID_REQUEST", "Use application/json.");
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) throw new CoworkError("INVALID_REQUEST", "Request exceeds the 4 MiB limit.", 413);
  const chunks = [];
  let bytes = 0;
  const read = async () => {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) throw new CoworkError("INVALID_REQUEST", "Request exceeds the 4 MiB limit.", 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new CoworkError("INVALID_REQUEST", "Request must contain valid UTF-8 JSON."); }
  };
  return withSignal(read(), signal);
}

function requestScope(req, body) {
  const header = req.headers["x-claude-code-session-id"];
  if (typeof header === "string" && header.length > 0 && header.length <= 256) return header;
  // Claude's attribution metadata can contain a session selector. Never put its
  // device/account identifiers into the prompt or operation records.
  try {
    const metadata = JSON.parse(body.metadata?.user_id);
    if (typeof metadata.session_id === "string" && metadata.session_id.length > 0 && metadata.session_id.length <= 256) return metadata.session_id;
  } catch { /* Attribution metadata is otherwise ignored. */ }
  return "";
}

export function createCoworkGateway({ key, route, capabilities = {}, execute, operationDirectory, log = () => {}, timeoutMs = 900_000, heartbeatMs = 8000, maxActive = 2, maxQueued = 8 } = {}) {
  if (typeof key !== "string" || key.length < 24) throw new Error("A random local Cowork key is required.");
  if (!route?.publicId || !route?.upstreamId || typeof execute !== "function") throw new Error("A verified Cowork route and execute function are required.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_423_647) throw new Error("Invalid Cowork timeout.");
  if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 32 || !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > 128
    || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 2_147_423_647) throw new Error("Invalid Cowork concurrency or heartbeat limits.");
  const store = createOperationStore({ directory: operationDirectory, route, conversationReuse: capabilities.conversationReuseVerified === true });
  const controllers = new Set();
  const queued = [];
  const activeConversations = new Set();
  let active = 0;
  let outstandingRequests = 0;
  const closeWaiters = [];
  let closing = false;
  const stats = { requests: 0, upstreamTurns: 0, toolCalls: 0, toolResults: 0, errors: 0, reused: 0, conversations: 0 };
  const safeLog = value => { try { log(value); } catch { /* Logging must not alter task submission or delivery. */ } };
  const authenticate = req => {
    const matches = value => {
      const actual = Buffer.from(typeof value === "string" ? value : "");
      const expected = Buffer.from(key);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    };
    return matches(req.headers["x-api-key"]) || matches(/^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1]);
  };

  const takeSlot = async (signal, conversationKey) => {
    if (signal.aborted) throw abortError(signal);
    if (active < maxActive && !activeConversations.has(conversationKey)) {
      active++; if (conversationKey) activeConversations.add(conversationKey); return;
    }
    if (queued.length >= maxQueued) throw new CoworkError("QUEUE_FULL", "Cowork request queue is full.", 429);
    await new Promise((resolve, reject) => {
      const waiter = { signal, conversationKey, resolve: () => {
        signal.removeEventListener("abort", abort); active++;
        if (conversationKey) activeConversations.add(conversationKey); resolve();
      } };
      const abort = () => { const index = queued.indexOf(waiter); if (index >= 0) queued.splice(index, 1); reject(abortError(signal)); };
      queued.push(waiter); signal.addEventListener("abort", abort, { once: true });
    });
  };
  const releaseSlot = conversationKey => {
    active--; if (conversationKey) activeConversations.delete(conversationKey);
    // A blocked conversation must not consume global slots or prevent another
    // Claude session from making progress. Same-conversation order stays FIFO.
    while (active < maxActive) {
      const index = queued.findIndex(waiter => !activeConversations.has(waiter.conversationKey));
      if (index < 0) break;
      queued.splice(index, 1)[0].resolve();
    }
  };

  const server = http.createServer(async (req, res) => {
    outstandingRequests++;
    let controller, timer, ping, record, acquired = false, pendingPing;
    let remoteCompleted = false, endpoint = "unsupported", requestedEffort, requestedThinking;
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (["/api/hello", "/v1/messages", "/v1/messages/count_tokens", "/v1/models", "/health", "/healthz", "/readyz", "/_gateway/capabilities"].includes(url.pathname)) endpoint = url.pathname;
      if (req.headers.origin !== undefined) throw new CoworkError("LOCAL_ORIGIN_DENIED", "This gateway accepts local CLI clients only.", 403);
      if (req.method === "HEAD" && url.pathname === "/api/hello") { res.writeHead(200, { "content-length": "0", "cache-control": "no-store" }); res.end(); return; }
      if (!authenticate(req)) throw new CoworkError("LOCAL_AUTH_REQUIRED", "A valid local Cowork gateway key is required.", 401);
      if (closing) throw new CoworkError("GATEWAY_CLOSING", "Cowork gateway is closing.", 503);
      if (req.method === "GET" && ["/health", "/healthz", "/readyz"].includes(url.pathname)) {
        json(res, 200, { ok: true, service: "aerial-cowork", status: url.pathname === "/readyz" ? "configured" : "alive", publicModel: route.publicId, upstreamModel: route.upstreamId }); return;
      }
      if (req.method === "GET" && url.pathname === "/_gateway/capabilities") {
        json(res, 200, { mode: "cowork-emulated", tools: "prompt-emulated", streaming: "buffered-completion", usage: "estimated", cache: "no-guarantee", max_tokens: "soft-budget", remoteCancellation: false, ...capabilities }); return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        json(res, 200, { data: [{ id: route.publicId, type: "model", display_name: route.displayName || route.publicId }], has_more: false, first_id: route.publicId, last_id: route.publicId }); return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/messages") throw new CoworkError("NOT_FOUND", "Unknown or unsupported Cowork endpoint.", 404);
      for (const [name, value] of url.searchParams) if (name !== "beta" || value !== "true") throw new CoworkError("UNSUPPORTED_CAPABILITY", "Unsupported Messages query parameter.");
      controller = new AbortController(); controllers.add(controller);
      const disconnect = () => { if (!res.writableFinished) controller.abort(new CoworkError("LOCAL_CANCELLED", "Local client disconnected; remote status may be unknown.", 499)); };
      res.once("close", disconnect);
      timer = setTimeout(() => controller.abort(new CoworkError("LOCAL_TIMEOUT", "Cowork total deadline exceeded; remote status may be unknown.", 504)), timeoutMs);
      const body = await readJson(req, controller.signal);
      if (["low", "medium", "high", "xhigh", "max"].includes(body?.output_config?.effort)) requestedEffort = body.output_config.effort;
      if (["adaptive", "disabled", "enabled"].includes(body?.thinking?.type)) requestedThinking = body.thinking.type;
      const prepared = prepareRequest(body, { route, capabilities, beta: req.headers["anthropic-beta"] });
      controller.signal.throwIfAborted();
      const idempotencyKey = req.headers["idempotency-key"] || "";
      if (typeof idempotencyKey !== "string" || idempotencyKey.length > 256) throw new CoworkError("INVALID_REQUEST", "Invalid Idempotency-Key.");
      const claimed = store.claim({ body, sessionId: requestScope(req, body), idempotencyKey });
      record = claimed.record; stats.requests++;
      res.setHeader("x-cwg-operation-id", record.id);
      safeLog({ event: "cowork_request", operationId: record.id, model: route.publicId, reused: claimed.reused, stream: Boolean(body.stream) });
      let message = claimed.message;
      if (claimed.reused) stats.reused++;
      else {
        await takeSlot(controller.signal, record.conversationKey); acquired = true;
        store.ready(record);
        stats.toolResults += body.messages.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(block => block.type === "tool_result").length;
      }
      if (body.stream) {
        res.writeHead(200, { ...CAPABILITY_HEADERS, "content-type": "text/event-stream; charset=utf-8" });
        await writeChunk(res, eventFrame(messageStart(record.messageId, prepared)), 30_000, controller.signal);
        ping = setInterval(() => {
          if (pendingPing || controller.signal.aborted || res.destroyed) return;
          pendingPing = writeChunk(res, eventFrame({ type: "ping" }), 30_000, controller.signal).catch(error => controller.abort(error)).finally(() => { pendingPing = undefined; });
        }, heartbeatMs);
      }
      if (!message) {
        const upstream = await withSignal(Promise.resolve().then(() => execute({
          prompt: prepared.prompt, effort: prepared.effort, signal: controller.signal, operationId: record.id,
          ...(record.conversationKey ? { conversationKey: record.conversationKey } : {}),
          onPhase: async (phase, ids) => {
            controller.signal.throwIfAborted();
            const transition = store.phase(record, phase, ids);
            if (phase === "SUBMITTING") { stats.upstreamTurns++; if (transition.newConversation) stats.conversations++; }
            safeLog({ event: "cowork_phase", operationId: record.id, phase });
          }
        })), controller.signal);
        controller.signal.throwIfAborted();
        if (typeof upstream?.completionEvidence !== "string" || !upstream.completionEvidence || upstream.completionEvidence.length > 128) throw new CoworkError("PROTOCOL_CHANGED", "Cowork transport returned no verified completion evidence.", 502);
        remoteCompleted = true;
        const result = decodeCompletion(upstream.text, prepared);
        message = completionMessage(result, prepared, record.messageId);
        store.succeed(record, message);
        stats.toolCalls += result.content.filter(block => block.type === "tool_use").length;
      }
      clearInterval(ping);
      if (pendingPing) await pendingPing;
      controller.signal.throwIfAborted();
      store.delivery(record, "WRITING");
      if (body.stream) {
        for (const event of messageEvents(message)) await writeChunk(res, eventFrame(event), 30_000, controller.signal);
        res.end();
      } else json(res, 200, message);
      // This only describes the local socket, not client acknowledgement.
      await new Promise((resolve, reject) => {
        if (res.writableFinished) { resolve(); return; }
        const cleanup = () => { res.off("finish", finished); res.off("close", closed); };
        const finished = () => { cleanup(); resolve(); };
        const closed = () => { cleanup(); reject(new CoworkError("LOCAL_CANCELLED", "Local delivery was interrupted.", 499)); };
        res.once("finish", finished); res.once("close", closed);
      });
      store.delivery(record, "LOCALLY_WRITTEN");
    } catch (caught) {
      clearInterval(ping);
      const error = controller?.signal.aborted ? abortError(controller.signal) : caught;
      stats.errors++;
      if (record) {
        if (remoteCompleted && !error.remoteState) error.remoteState = "succeeded";
        try { store.fail(record, error); if (res.headersSent || res.destroyed) store.delivery(record, "INTERRUPTED"); }
        catch { safeLog({ event: "cowork_operation_store_failed", operationId: record.id }); }
      }
      const body = errorBody(error, record?.id || error.operationId);
      // Only fixed capability names and effort values enter diagnostics; never
      // log arbitrary field names, beta headers, prompts or tool arguments.
      const unsupportedCapability = error instanceof CoworkError && error.code === "UNSUPPORTED_CAPABILITY"
        ? ["output_config.effort", "output_config.format", "thinking", "tool.strict", "tools.input_schema.format"].find(field => error.message === `Unsupported Cowork capability: ${field}.`)
          || (error.message.startsWith("Unsupported Cowork capability: anthropic-beta ") ? "anthropic-beta" : "other")
        : undefined;
      const unsupportedBeta = unsupportedCapability === "anthropic-beta"
        ? ["fallback-credit-2026-06-01"].find(beta => error.message === `Unsupported Cowork capability: anthropic-beta ${beta}.`)
        : undefined;
      safeLog({ event: "cowork_error", operationId: record?.id || error.operationId, code: body.error.code,
        remoteState: record?.remoteState, endpoint, unsupportedCapability,
        ...(unsupportedBeta ? { unsupportedBeta } : {}), ...(requestedEffort ? { requestedEffort } : {}),
        ...(requestedThinking ? { requestedThinking } : {}) });
      if (!res.destroyed && !res.writableEnded) {
        try {
          if (res.headersSent) { await writeChunk(res, eventFrame(body), 1000); res.end(); }
          else json(res, error.status || error.statusCode || 502, body, error.operationId ? { "x-cwg-operation-id": error.operationId } : {});
        } catch { res.destroy(); }
      }
    } finally {
      clearTimeout(timer); clearInterval(ping);
      if (controller) { controller.abort(new CoworkError("LOCAL_CANCELLED", "Local request finished.", 499)); controllers.delete(controller); }
      if (acquired) releaseSlot(record.conversationKey);
      outstandingRequests--;
      if (!outstandingRequests) for (const resolve of closeWaiters.splice(0)) resolve();
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 32;
  server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); else socket.destroy(); });
  return {
    server, stats,
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        const failed = error => { server.off("listening", ready); reject(error); };
        const ready = () => { server.off("error", failed); resolve(); };
        server.once("error", failed); server.once("listening", ready); server.listen(port, "127.0.0.1");
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      closing = true;
      for (const controller of controllers) controller.abort(new CoworkError("LOCAL_CANCELLED", "Cowork gateway is closing; remote tasks may still be running.", 499));
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (outstandingRequests) await new Promise(resolve => closeWaiters.push(resolve));
    }
  };
}
