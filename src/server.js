import http from "node:http";
import { DEFAULT_HOST, DEFAULT_PORT } from "./constants.js";
import { loadConfig, validateLocalAuth } from "./config.js";
import { proxyChatCompletions, proxyMessages, proxyModels, proxyResponses, localCountTokens } from "./copilot.js";
import { logEvent } from "./log.js";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function nodeRequestToFetch(req, body) {
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: body.length ? body : undefined, duplex: "half" });
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

async function writeNodeResponse(res, fetchResponse) {
  res.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, key) => res.setHeader(key, value));
  if (!fetchResponse.body) {
    res.end();
    return;
  }
  const reader = fetchResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

export function createServer(runtime = {}) {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      logEvent("request_start", { method: req.method, path: req.url });
      const body = await readBody(req);
      const fetchRequest = nodeRequestToFetch(req, body);
      const fetchResponse = await handle(fetchRequest, runtime);
      await writeNodeResponse(res, fetchResponse);
      logEvent("request_end", { method: req.method, path: req.url, status: fetchResponse.status, ms: Date.now() - started });
    } catch (error) {
      logEvent("request_end", { method: req.method, path: req.url, status: 500, ms: Date.now() - started, error: error.message });
      res.statusCode = error.message?.includes("Missing GitHub token") ? 503 : 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { type: "aerial_error", message: error.message } }));
    }
  });
}

export function startServer({ host, port } = {}) {
  const config = loadConfig();
  const bindHost = host || config.host || DEFAULT_HOST;
  const bindPort = Number(port || config.port || DEFAULT_PORT);
  const server = createServer({ host: bindHost, port: bindPort });
  server.listen(bindPort, bindHost, () => logEvent("server_start", { host: bindHost, port: bindPort }));
  return server;
}
