import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-tool-replay-"));
const overrides = {
  AERIAL_CONFIG_DIR: directory,
  AERIAL_API_KEY: "aerial_test_tool_replay",
  AERIAL_GITHUB_TOKEN: "github-test-tool-replay",
  AERIAL_LOG_FILE: path.join(directory, "aerial.log"),
  AERIAL_UPSTREAM_PROXY: "",
  AERIAL_RESPONSES_WEBSOCKET: "off"
};
const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
Object.assign(process.env, overrides);

const { createServer } = await import("../src/proxy/server.js");
const { ensureApiKey } = await import("../src/shared/config.js");
const { _resetCopilotTokenCacheForTests } = await import("../src/shared/auth.js");
const { _resetForTests: resetLog } = await import("../src/shared/log.js");
const { createSseCacheObserver } = await import("../src/proxy/cache-telemetry.js");
const { proxyResponsesWebSocket } = await import("../src/proxy/responses-websocket.js");
const { createToolReplayCache } = await import("../src/proxy/tool-replay.js");
ensureApiKey();
const originalFetch = globalThis.fetch;

test.beforeEach(() => _resetCopilotTokenCacheForTests());
test.afterEach(() => { globalThis.fetch = originalFetch; });
test.after(() => {
  resetLog();
  _resetCopilotTokenCacheForTests();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture({ toolsInHistory = false } = {}) {
  const tool = {
    type: "namespace", name: "collaboration",
    tools: [{
      type: "function", name: "send_message",
      parameters: {
        type: "object",
        properties: { message: { type: "string", encrypted: true }, target: { type: "string" } },
        required: ["message", "target"]
      }
    }]
  };
  const call = {
    type: "function_call", call_id: `call_${crypto.randomUUID()}`, name: "send_message",
    namespace: "collaboration", status: "completed",
    arguments: JSON.stringify({ message: "synthetic encrypted payload", target: "test" })
  };
  const threadId = crypto.randomUUID();
  const client_metadata = { thread_id: threadId, session_id: threadId };
  const generate = {
    model: "tool-replay-test", stream: true, tools: toolsInHistory ? [] : [tool], client_metadata,
    input: [...(toolsInHistory ? [{ type: "additional_tools", tools: [tool] }] : []),
      { role: "user", content: "Send the test message." }]
  };
  const compact = {
    model: generate.model, stream: true, tools: [],
    client_metadata: {
      ...client_metadata,
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" })
    },
    input: [call, { type: "function_call_output", call_id: call.call_id, output: "sent" },
      { role: "user", content: "Summarize the conversation." }]
  };
  const outputEvents = [
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { output: [call] } }
  ];
  return { tool, call, generate, compact, outputEvents };
}

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function post(url, payload) {
  return originalFetch(`${url}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer aerial_test_tool_replay", "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000)
  });
}

test("HTTP proxy restores an encrypted call's additional_tools declaration for compaction without changing SSE", async () => {
  const { tool, generate, compact, outputEvents } = fixture({ toolsInHistory: true });
  const output = sse(outputEvents);
  const summary = sse([{ type: "response.completed", response: { output: [] } }]);
  const forwarded = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    assert.ok(String(url).endsWith("/responses"));
    forwarded.push(JSON.parse(Buffer.from(init.body).toString("utf8")));
    const bytes = Buffer.from(forwarded.length === 1 ? output : summary);
    return new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 13) controller.enqueue(bytes.subarray(offset, offset + 13));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream" } });
  };
  const server = createServer();
  try {
    const url = await listen(server);
    const first = await post(url, generate);
    assert.equal(first.status, 200);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), Buffer.from(output));
    const second = await post(url, compact);
    assert.equal(second.status, 200);
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), Buffer.from(summary));
    assert.equal(forwarded.length, 2);
    assert.deepEqual(forwarded[0].tools, []);
    assert.deepEqual(forwarded[0].input, generate.input);
    assert.equal(forwarded[0].tool_choice, undefined);
    assert.deepEqual(forwarded[1].tools, [tool]);
    assert.equal(forwarded[1].tool_choice, "none");
    assert.deepEqual(forwarded[1].input, compact.input);
    assert.doesNotMatch(fs.readFileSync(overrides.AERIAL_LOG_FILE, "utf8"), /synthetic encrypted payload|github-test-tool-replay|aerial_test_tool_replay/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("HTTP JSON responses do not populate the streaming replay cache", async () => {
  const { generate, compact, call } = fixture();
  generate.stream = false;
  const forwarded = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    assert.ok(String(url).endsWith("/responses"));
    forwarded.push(JSON.parse(Buffer.from(init.body).toString("utf8")));
    return forwarded.length === 1
      ? Response.json({ output: [call] })
      : new Response(sse([{ type: "response.completed", response: { output: [] } }]), { headers: { "content-type": "text/event-stream" } });
  };
  const server = createServer();
  try {
    const url = await listen(server);
    assert.deepEqual(await (await post(url, generate)).json(), { output: [call] });
    await (await post(url, compact)).text();
    assert.deepEqual(forwarded[1].tools, []);
    assert.equal(forwarded[1].tool_choice, undefined);
    assert.deepEqual(forwarded[1].input, compact.input);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

function websocketFrame(payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
  header[0] = 0x81;
  header[1] = bytes.length < 126 ? bytes.length : 126;
  if (bytes.length >= 126) header.writeUInt16BE(bytes.length, 2);
  return Buffer.concat([header, bytes]);
}

test("WebSocket output reaches the shared SSE replay observer", async () => {
  const { tool, generate, compact, outputEvents } = fixture();
  const cache = createToolReplayCache();
  const prepared = cache.prepare(generate);
  const sockets = new Set();
  const server = http.createServer();
  let receivedRequest;
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    const accept = crypto.createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        let length = pending[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2); offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2)); offset = 10;
        }
        const masked = Boolean(pending[1] & 128);
        const payloadOffset = offset + (masked ? 4 : 0);
        if (pending.length < payloadOffset + length) return;
        const opcode = pending[0] & 15;
        const bytes = Buffer.from(pending.subarray(payloadOffset, payloadOffset + length));
        if (masked) for (let i = 0; i < bytes.length; i++) bytes[i] ^= pending[offset + (i % 4)];
        pending = pending.subarray(payloadOffset + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode === 1) {
          receivedRequest = JSON.parse(bytes.toString("utf8"));
          socket.write(Buffer.concat(outputEvents.map(websocketFrame)));
        }
      }
    });
  });
  try {
    const url = (await listen(server)).replace("http:", "ws:");
    const upstream = await proxyResponsesWebSocket(prepared.payload, {}, { url, signal: AbortSignal.timeout(5000) });
    const response = new Response(upstream.body.pipeThrough(createSseCacheObserver("/responses", {}, {
      onResponsePayload: prepared.onResponsePayload
    })));
    assert.equal(await response.text(), sse(outputEvents));
    assert.equal(receivedRequest.type, "response.create");
    assert.deepEqual(receivedRequest.tools, [tool]);
    const restored = cache.prepare(compact).payload;
    assert.deepEqual(restored.tools, [tool]);
    assert.equal(restored.tool_choice, "none");
    assert.deepEqual(restored.input, compact.input);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
