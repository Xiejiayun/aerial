import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { once } from "node:events";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-server-test-"));
process.env.AERIAL_API_KEY = "aerial_test_key";

const { createServer } = await import("../src/proxy/server.js");
const { _resetCopilotTokenCacheForTests } = await import("../src/shared/auth.js");
const { ensureApiKey } = await import("../src/shared/config.js");

test.beforeEach(() => {
  _resetCopilotTokenCacheForTests();
});

async function listenOnRandomPort(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function readSocketData(socket, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let data = "";
    const timer = setTimeout(() => reject(new Error("timed out waiting for response")), timeoutMs);
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      clearTimeout(timer);
      resolve(data);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test("server rejects websocket upgrade explicitly", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.write([
    "GET /v1/responses HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    ""
  ].join("\r\n"));

  let data = "";
  socket.on("data", (chunk) => { data += chunk.toString("utf8"); });
  await once(socket, "end");
  server.close();

  assert.match(data, /501 Not Implemented/);
  assert.match(data, /Aerial does not expose a client WebSocket/);
  assert.match(data, /HTTP POST \/v1\/responses/);
  assert.match(data, /internal opt-in transport/);
  assert.doesNotMatch(data, /WebSocket Responses is not implemented/);
});

test("GET / serves friendly status without requiring the Aerial API key", async () => {
  const server = createServer();
  const port = await listenOnRandomPort(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.service, "aerial");
    assert.equal(body.ok, true);
    assert.match(body.message, /Aerial is running/);
    assert.equal(body.endpoints.health, "/health");
    assert.ok(Array.isArray(body.next_steps) && body.next_steps.length > 0);
    for (const step of body.next_steps) {
      assert.doesNotMatch(step, /aerial_test_key/);
    }
    assert.doesNotMatch(JSON.stringify(body), /aerial_test_key/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("model routes under /v1 still require the Aerial API key after adding root route", async () => {
  const server = createServer();
  const port = await listenOnRandomPort(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.type, "authentication_error");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("protected routes reject missing auth before reading the request body", async () => {
  const server = createServer();
  const port = await listenOnRandomPort(server);
  const socket = net.createConnection({ host: "127.0.0.1", port });
  try {
    socket.write([
      "POST /v1/responses HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Content-Type: application/json",
      "Content-Length: 104857600",
      "",
      ""
    ].join("\r\n"));

    const data = await readSocketData(socket);
    assert.match(data, /401 Unauthorized/);
    assert.match(data, /Invalid or missing Aerial API key/);
  } finally {
    socket.destroy();
    server.close();
    await once(server, "close");
  }
});

test("protected routes reject oversized authenticated bodies", async () => {
  ensureApiKey();
  const server = createServer();
  const port = await listenOnRandomPort(server);
  const socket = net.createConnection({ host: "127.0.0.1", port });
  try {
    socket.write([
      "POST /v1/responses HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Authorization: Bearer aerial_test_key",
      "Content-Type: application/json",
      "Content-Length: 33554433",
      "",
      ""
    ].join("\r\n"));

    const data = await readSocketData(socket);
    assert.match(data, /413 Payload Too Large/);
    assert.match(data, /request_entity_too_large/);
  } finally {
    socket.destroy();
    server.close();
    await once(server, "close");
  }
});

test("GET /v1/models without GitHub login returns 401 login_required (no Aerial API key required)", async () => {
  delete process.env.AERIAL_GITHUB_TOKEN;
  const server = createServer();
  const port = await listenOnRandomPort(server);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 401);
    const headers = Object.fromEntries(res.headers.entries());
    assert.equal(headers["www-authenticate"], undefined, "must not trigger browser basic-auth prompt");
    assert.equal(headers["access-control-allow-origin"], undefined, "must not advertise open CORS");
    const body = await res.json();
    assert.equal(body.error.type, "authentication_error");
    assert.equal(body.error.aerial.status, "login_required");
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /aerial_test_key/);
    assert.doesNotMatch(serialized, /Bearer/);
    assert.doesNotMatch(serialized, /AERIAL_API_KEY/);
    assert.doesNotMatch(serialized, /\/Users\/|C:\\\\|\/home\//);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /v1/models with GitHub token but upstream 401 returns upstream_auth_failed", async () => {
  process.env.AERIAL_GITHUB_TOKEN = "github-test-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return originalFetch(url, init);
    if (target.includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  };
  const server = createServer();
  const port = await listenOnRandomPort(server);
  try {
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.aerial.status, "upstream_auth_failed");
    assert.equal(body.error.aerial.upstream_status, 401);
    assert.match(body.error.message, /aerial login --force/);
    const headers = Object.fromEntries(res.headers.entries());
    assert.equal(headers["www-authenticate"], undefined);
    assert.equal(headers["access-control-allow-origin"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AERIAL_GITHUB_TOKEN;
    server.close();
    await once(server, "close");
  }
});

test("GET /v1/models returns upstream_auth_failed when copilot_internal token exchange returns 401", async () => {
  process.env.AERIAL_GITHUB_TOKEN = "github-test-token-exchange";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return originalFetch(url, init);
    if (target.includes("copilot_internal")) {
      return new Response(JSON.stringify({ message: "token rejected" }), { status: 401, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };
  const server = createServer();
  const port = await listenOnRandomPort(server);
  try {
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 401, "must surface 401, not 500");
    const body = await res.json();
    assert.equal(body.error.type, "authentication_error");
    assert.equal(body.error.aerial.status, "upstream_auth_failed");
    assert.equal(body.error.aerial.upstream_status, 401);
    assert.match(body.error.message, /aerial login --force/);
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /token rejected/, "must not leak upstream body");
    assert.doesNotMatch(serialized, /github-test-token-exchange/, "must not leak github token");
    const headers = Object.fromEntries(res.headers.entries());
    assert.equal(headers["www-authenticate"], undefined);
    assert.equal(headers["access-control-allow-origin"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AERIAL_GITHUB_TOKEN;
    server.close();
    await once(server, "close");
  }
});

test("GET /v1/models returns upstream_auth_failed when copilot_internal token exchange returns 403", async () => {
  process.env.AERIAL_GITHUB_TOKEN = "github-test-token-403";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return originalFetch(url, init);
    if (target.includes("copilot_internal")) {
      return new Response(JSON.stringify({ message: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };
  const server = createServer();
  const port = await listenOnRandomPort(server);
  try {
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error.aerial.status, "upstream_auth_failed");
    assert.equal(body.error.aerial.upstream_status, 403);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.AERIAL_GITHUB_TOKEN;
    server.close();
    await once(server, "close");
  }
});
