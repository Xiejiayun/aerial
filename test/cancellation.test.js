import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cancel-"));
process.env.AERIAL_GITHUB_TOKEN = "github-test-cancellation";
process.env.AERIAL_API_KEY = "aerial_test_cancellation";
delete process.env.AERIAL_UPSTREAM_PROXY;

const { createServer } = await import("../src/proxy/server.js");
const { getCopilotToken, _resetCopilotTokenCacheForTests } = await import("../src/shared/auth.js");
const { fetchModelsCatalogForCopilot } = await import("../src/proxy/transport.js");
const { clearModelCatalogCacheForTests } = await import("../src/proxy/model-catalog.js");
const { proxyResponses } = await import("../src/proxy/index.js");
const { proxyResponsesWebSocket } = await import("../src/proxy/responses-websocket.js");
const { ensureApiKey } = await import("../src/shared/config.js");
ensureApiKey();
const originalFetch = globalThis.fetch;
const tokenResponse = () => Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("cancellation did not finish within 3 seconds")), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(server, t) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test.beforeEach(() => { _resetCopilotTokenCacheForTests(); clearModelCatalogCacheForTests(); });
test.afterEach(() => { globalThis.fetch = originalFetch; _resetCopilotTokenCacheForTests(); });

for (const [route, payload, retry = false] of [
  ["/v1/responses", { model: "gpt-test", input: "hello" }],
  ["/v1/messages", { model: "claude-test", messages: [{ role: "user", content: "hello" }] }],
  ["/v1/chat/completions", { model: "gpt-test", messages: [{ role: "user", content: "hello" }] }],
  ["/v1/models", undefined],
  ["/v1/responses", { model: "gpt-test", input: "hello" }, true]
]) {
  test(`disconnect before ${route} response headers closes the real upstream socket${retry ? " on the 401 retry" : ""}`, async t => {
    const received = deferred();
    const closed = deferred();
    const upstreamUrl = await listen(http.createServer((req, res) => {
      req.resume();
      res.on("close", closed.resolve);
      received.resolve();
      // Deliberately leave the response headers pending.
    }), t);
    let inferenceCalls = 0;
    globalThis.fetch = (url, init) => {
      if (String(url).includes("copilot_internal")) return Promise.resolve(tokenResponse());
      inferenceCalls += 1;
      if (retry && inferenceCalls === 1) return Promise.resolve(new Response("expired", { status: 401 }));
      return originalFetch(upstreamUrl, init);
    };
    const localUrl = await listen(createServer(), t);
    const client = http.request(localUrl + route, {
      method: payload ? "POST" : "GET",
      headers: { authorization: "Bearer aerial_test_cancellation", "content-type": "application/json" }
    });
    client.on("error", () => {});
    t.after(() => client.destroy());
    client.end(payload ? JSON.stringify(payload) : undefined);
    await within(received.promise);
    client.destroy();
    await within(closed.promise);
    assert.equal(inferenceCalls, retry ? 2 : 1);
  });
}

test("one cancelled token waiter leaves another caller's refresh intact", async () => {
  const response = deferred();
  let upstreamSignal;
  let calls = 0;
  globalThis.fetch = (_url, { signal }) => {
    calls += 1;
    upstreamSignal = signal;
    signal.addEventListener("abort", () => response.reject(signal.reason), { once: true });
    return response.promise;
  };
  const first = new AbortController();
  const a = getCopilotToken({ signal: first.signal });
  const b = getCopilotToken();
  first.abort();
  await assert.rejects(within(a), { name: "AbortError" });
  assert.equal(upstreamSignal.aborted, false);
  response.resolve(tokenResponse());
  assert.equal(await within(b), "header.eyJleHAiOjk5OTk5OTk5OTl9.sig");
  assert.equal(calls, 1);
});

test("the last cancelled token waiter aborts refresh and the next caller can retry", async () => {
  let upstreamSignal;
  globalThis.fetch = (_url, { signal }) => {
    upstreamSignal = signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const controller = new AbortController();
  const pending = getCopilotToken({ signal: controller.signal });
  controller.abort();
  await assert.rejects(within(pending), { name: "AbortError" });
  assert.equal(upstreamSignal.aborted, true);
  globalThis.fetch = async () => tokenResponse();
  assert.ok(await within(getCopilotToken()));
});

test("cancelling a catalog request does not poison another request or its cache", async () => {
  const ready = deferred();
  const requests = [];
  globalThis.fetch = (url, { signal }) => {
    if (String(url).includes("copilot_internal")) return Promise.resolve(tokenResponse());
    const response = deferred();
    signal.addEventListener("abort", () => response.reject(signal.reason), { once: true });
    requests.push({ signal, response });
    if (requests.length === 2) ready.resolve();
    return response.promise;
  };
  const first = new AbortController();
  const second = new AbortController();
  const a = fetchModelsCatalogForCopilot({ signal: first.signal });
  const b = fetchModelsCatalogForCopilot({ signal: second.signal });
  await within(ready.promise);
  first.abort();
  await assert.rejects(within(a), { name: "AbortError" });
  assert.equal(requests[1].signal.aborted, false);
  requests[1].response.resolve(Response.json({ data: [{ id: "still-needed" }] }));
  assert.deepEqual(await within(b), [{ id: "still-needed" }]);
  assert.deepEqual(await fetchModelsCatalogForCopilot(), [{ id: "still-needed" }]);
  assert.equal(requests.length, 2);
});

test("cancellation during a 401 refresh prevents the inference retry", async () => {
  const refreshing = deferred();
  let tokenCalls = 0;
  let inferenceCalls = 0;
  let discardedBody = false;
  let refreshSignal;
  globalThis.fetch = (url, { signal }) => {
    if (String(url).includes("copilot_internal")) {
      if (++tokenCalls === 1) return Promise.resolve(tokenResponse());
      refreshSignal = signal;
      refreshing.resolve();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    inferenceCalls += 1;
    return Promise.resolve(new Response(new ReadableStream({ cancel() { discardedBody = true; } }), { status: 401 }));
  };
  const controller = new AbortController();
  const pending = proxyResponses(new Request("http://localhost/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "gpt-test", input: "hello" }), signal: controller.signal
  }));
  await within(refreshing.promise);
  controller.abort();
  await assert.rejects(within(pending), { name: "AbortError" });
  assert.equal(refreshSignal.aborted, true);
  assert.equal(inferenceCalls, 1);
  assert.equal(discardedBody, true);
});

test("cancellation during effort catalog lookup never falls through to inference", async () => {
  const querying = deferred();
  let inferenceCalls = 0;
  globalThis.fetch = (url, { signal }) => {
    if (String(url).includes("copilot_internal")) return Promise.resolve(tokenResponse());
    if (String(url).endsWith("/models")) {
      querying.resolve();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    inferenceCalls += 1;
    return Promise.resolve(Response.json({ ok: true }));
  };
  const controller = new AbortController();
  const pending = proxyResponses(new Request("http://localhost/v1/responses", {
    method: "POST", body: JSON.stringify({ model: "gpt-test", input: "hello", reasoning: { effort: "high" } }), signal: controller.signal
  }));
  await within(querying.promise);
  controller.abort();
  await assert.rejects(within(pending), { name: "AbortError" });
  assert.equal(inferenceCalls, 0);
});

async function websocketPeer(t, { accept = true } = {}) {
  const connected = deferred();
  const closed = deferred();
  const closeFrame = deferred();
  const sockets = new Set();
  t.after(() => { for (const socket of sockets) socket.destroy(); });
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("end", () => socket.end());
    socket.on("close", closed.resolve);
    if (accept) {
      const hash = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${hash}\r\n\r\n`);
    }
    let frames = Buffer.alloc(0);
    socket.on("data", chunk => {
      frames = Buffer.concat([frames, chunk]);
      while (frames.length >= 2) {
        let length = frames[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (frames.length < 4) return;
          length = frames.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (frames.length < 10) return;
          length = Number(frames.readBigUInt64BE(2));
          offset = 10;
        }
        if (frames[1] & 128) offset += 4;
        if (frames.length < offset + length) return;
        const opcode = frames[0] & 15;
        frames = frames.subarray(offset + length);
        if (opcode === 8) {
          closeFrame.resolve();
          socket.end(Buffer.from([0x88, 0]));
        }
      }
    });
    connected.resolve();
  });
  const url = (await listen(server, t)).replace("http:", "ws:");
  return { url, connected, closed, closeFrame };
}

test("cancellation aborts a real WebSocket handshake before response headers", async t => {
  const peer = await websocketPeer(t, { accept: false });
  const controller = new AbortController();
  const pending = proxyResponsesWebSocket({ input: "hello" }, {}, { signal: controller.signal, url: peer.url });
  await within(peer.connected.promise);
  controller.abort();
  await assert.rejects(within(pending), { name: "AbortError" });
  await within(peer.closed.promise);
});

for (const cancellation of ["signal", "body"]) {
  test(`WebSocket ${cancellation} cancellation closes the real peer`, async t => {
    const peer = await websocketPeer(t);
    const controller = new AbortController();
    const response = await within(proxyResponsesWebSocket({ input: "hello" }, {}, { signal: controller.signal, url: peer.url }));
    if (cancellation === "signal") {
      const reading = response.body.getReader().read();
      controller.abort();
      await assert.rejects(within(reading), { name: "AbortError" });
    } else {
      await response.body.cancel();
    }
    await within(peer.closeFrame.promise);
    await within(peer.closed.promise);
  });
}
