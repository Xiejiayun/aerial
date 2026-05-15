import http from "node:http";
import { DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";
import { loadConfig, validateLocalAuth } from "./config.js";
import { proxyChatCompletions, proxyMessages, proxyModels, proxyResponses, localCountTokens } from "./copilot.js";
import { logEvent } from "./log.js";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function nodeRequestToFetch(req, body, signal) {
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: body.length ? body : undefined, duplex: "half", signal });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function handle(fetchRequest, runtime = {}) {
  const url = new URL(fetchRequest.url);
  const config = loadConfig();
  if (fetchRequest.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, service: "aerial", host: runtime.host || config.host, port: runtime.port || config.port });
  }

  if (!validateLocalAuth(Object.fromEntries(fetchRequest.headers), config)) {
    return json(401, { error: { type: "authentication_error", message: "Invalid or missing Aerial API key" } });
  }

  if (fetchRequest.method === "GET" && url.pathname === "/v1/models") return proxyModels(fetchRequest);
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
        await new Promise((resolve) => res.once("drain", resolve));
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
      const body = await readBody(req);
      const fetchRequest = nodeRequestToFetch(req, body, controller.signal);
      const fetchResponse = await handle(fetchRequest, runtime);
      await writeNodeResponse(res, fetchResponse, controller.signal);
      logEvent("request_end", { method: req.method, path: req.url, status: fetchResponse.status, ms: Date.now() - started });
    } catch (error) {
      if (error.name === "AbortError" || res.destroyed) {
        logEvent("request_aborted", { method: req.method, path: req.url, ms: Date.now() - started });
        return;
      }
      logEvent("request_end", { method: req.method, path: req.url, status: 500, ms: Date.now() - started, error: error.message });
      res.statusCode = error.message?.includes("Missing GitHub token") ? 503 : 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { type: "aerial_error", message: error.message } }));
    }
  });

  server.on("upgrade", (req, socket) => {
    logEvent("websocket_unsupported", { path: req.url });
    socket.end("HTTP/1.1 501 Not Implemented\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n{\"error\":{\"type\":\"not_implemented\",\"message\":\"WebSocket Responses is not implemented in this Aerial build\"}}");
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
