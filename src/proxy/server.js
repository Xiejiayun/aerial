import http from "node:http";
import { DEFAULT_HOST, DEFAULT_PORT } from "../shared/constants.js";
import { loadConfig, validateLocalAuth } from "../shared/config.js";
import { proxyChatCompletions, proxyMessages, proxyModels, proxyResponses, localCountTokens } from "./index.js";
import { readGitHubToken } from "../shared/auth.js";
import { logEvent } from "../shared/log.js";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function aerialLoginRequired() {
  return json(401, {
    error: {
      type: "authentication_error",
      message: "GitHub login required. Run aerial login.",
      aerial: { status: "login_required" }
    }
  });
}

async function modelsRouteOrUpstreamAuthFailed(fetchRequest) {
  if (!readGitHubToken()) return aerialLoginRequired();
  let response;
  try {
    response = await proxyModels(fetchRequest);
  } catch (err) {
    const status = err?.aerialUpstreamStatus;
    if (status === 401 || status === 403) {
      return json(status, {
        error: {
          type: "authentication_error",
          message: "GitHub login was rejected by Copilot. Run aerial login --force.",
          aerial: { status: "upstream_auth_failed", upstream_status: status }
        }
      });
    }
    throw err;
  }
  if (response.status === 401 || response.status === 403) {
    return json(response.status, {
      error: {
        type: "authentication_error",
        message: "GitHub login was rejected by Copilot. Run aerial login --force.",
        aerial: { status: "upstream_auth_failed", upstream_status: response.status }
      }
    });
  }
  return response;
}

function nodeRequestToFetch(req, body, signal) {
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: body.length ? body : undefined, duplex: "half", signal });
}

function nodeHeaderObject(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) out[key] = value.join(", ");
    else if (value !== undefined) out[key] = String(value);
  }
  return out;
}

function publicRoute(req) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  return (req.method === "GET" && url.pathname === "/health")
    || (req.method === "GET" && url.pathname === "/")
    || (req.method === "GET" && url.pathname === "/v1/models");
}

function bodyTooLarge(limit) {
  const err = new Error(`Request body too large. Limit is ${limit} bytes.`);
  err.statusCode = 413;
  return err;
}

function declaredContentLength(req) {
  const raw = Array.isArray(req.headers["content-length"]) ? req.headers["content-length"][0] : req.headers["content-length"];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const declared = declaredContentLength(req);
  if (declared !== undefined && declared > maxBytes) throw bodyTooLarge(maxBytes);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw bodyTooLarge(maxBytes);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function responseAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("Response closed");
  error.name = "AbortError";
  return error;
}

function waitForDrain(res, signal) {
  if (signal?.aborted || res.destroyed) return Promise.reject(responseAbortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onDrain = () => settle(resolve);
    const onClose = () => settle(reject, responseAbortError(signal));
    const onError = (error) => settle(reject, error);
    const onAbort = () => settle(reject, responseAbortError(signal));
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted || res.destroyed) onAbort();
  });
}

async function handle(fetchRequest, runtime = {}) {
  const url = new URL(fetchRequest.url);
  const config = runtime.config || loadConfig();
  if (fetchRequest.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, service: "aerial", host: runtime.host || config.host, port: runtime.port || config.port });
  }
  if (fetchRequest.method === "GET" && url.pathname === "/") {
    return Response.json({
      service: "aerial",
      ok: true,
      message: "Aerial is running. This is a local-only Copilot proxy; inference routes require the local Aerial API key.",
      endpoints: { health: "/health", models: "/v1/models" },
      next_steps: ["Open /health for an unauthenticated check", "Run `aerial status` for a full diagnostic"]
    });
  }
  if (fetchRequest.method === "GET" && url.pathname === "/v1/models") {
    return modelsRouteOrUpstreamAuthFailed(fetchRequest);
  }

  if (!runtime.localAuthValidated && !validateLocalAuth(Object.fromEntries(fetchRequest.headers), config)) {
    return json(401, { error: { type: "authentication_error", message: "Invalid or missing Aerial API key" } });
  }

  if (fetchRequest.method === "POST" && url.pathname === "/v1/responses") return proxyResponses(fetchRequest);
  if (fetchRequest.method === "POST" && url.pathname === "/v1/messages") return proxyMessages(fetchRequest);
  if (fetchRequest.method === "POST" && url.pathname === "/v1/messages/count_tokens") return localCountTokens(fetchRequest);
  if (fetchRequest.method === "POST" && url.pathname === "/v1/chat/completions") return proxyChatCompletions(fetchRequest);
  return json(404, { error: { type: "not_found", message: `No route for ${fetchRequest.method} ${url.pathname}` } });
}

async function writeNodeResponse(res, fetchResponse, signal) {
  res.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, key) => res.setHeader(key, value));
  if (!fetchResponse.body) {
    res.end();
    return;
  }
  const reader = fetchResponse.body.getReader();
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await waitForDrain(res, signal);
      }
    }
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => {});
  }
  if (!res.destroyed) res.end();
}

export function createServer(runtime = {}) {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      logEvent("request_start", { method: req.method, path: req.url });
      let localAuthValidated = false;
      let config;
      if (!publicRoute(req)) {
        config = loadConfig();
        if (!validateLocalAuth(nodeHeaderObject(req.headers), config)) {
          const fetchResponse = json(401, { error: { type: "authentication_error", message: "Invalid or missing Aerial API key" } });
          await writeNodeResponse(res, fetchResponse, controller.signal);
          logEvent("request_end", { method: req.method, path: req.url, status: fetchResponse.status, ms: Date.now() - started });
          return;
        }
        localAuthValidated = true;
      }
      const body = await readBody(req);
      const fetchRequest = nodeRequestToFetch(req, body, controller.signal);
      const fetchResponse = await handle(fetchRequest, { ...runtime, localAuthValidated, config });
      await writeNodeResponse(res, fetchResponse, controller.signal);
      logEvent("request_end", { method: req.method, path: req.url, status: fetchResponse.status, ms: Date.now() - started });
    } catch (error) {
      if (error.name === "AbortError" || res.destroyed || controller.signal.aborted) {
        logEvent("request_aborted", { method: req.method, path: req.url, ms: Date.now() - started });
        return;
      }
      const status = error.statusCode || (error.message?.includes("Missing GitHub token") ? 503 : 500);
      logEvent("request_end", { method: req.method, path: req.url, status, ms: Date.now() - started, error: error.message });
      if (res.headersSent || res.writableEnded) {
        if (!res.destroyed) res.destroy(error);
        return;
      }
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { type: status === 413 ? "request_entity_too_large" : "aerial_error", message: error.message } }));
    }
  });

  server.on("upgrade", (req, socket) => {
    logEvent("websocket_unsupported", { path: req.url });
    socket.end("HTTP/1.1 501 Not Implemented\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"error\":{\"type\":\"not_implemented\",\"message\":\"Aerial does not expose a client WebSocket. Use HTTP POST /v1/responses; the upstream ws:/responses path is an internal opt-in transport (AERIAL_RESPONSES_WEBSOCKET=on) and is never proxied to clients.\"}}");
  });

  return server;
}

export function startServer({ host, port } = {}) {
  const config = loadConfig();
  const bindHost = host || config.host || DEFAULT_HOST;
  const bindPort = Number(port || config.port || DEFAULT_PORT);
  const server = createServer({ host: bindHost, port: bindPort });
  server.listen(bindPort, bindHost, () => logEvent("server_start", { host: bindHost, port: bindPort }));
  return server;
}
