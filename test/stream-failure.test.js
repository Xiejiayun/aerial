import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { wrapResponseWithCacheObserver } from "../src/proxy/cache-telemetry.js";

async function observe(source, { chunks = [Buffer.from(source)], context = {} } = {}) {
  const logs = [];
  const originalError = console.error;
  console.error = (line) => logs.push(JSON.parse(line));
  try {
    const upstream = new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream", "x-request-id": "upstream-request" } });
    const response = wrapResponseWithCacheObserver(upstream, "/responses", { model: "test-model" }, context);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(source));
    return logs;
  } finally {
    console.error = originalError;
  }
}

test("failed Responses events log details and request IDs without changing the stream", async () => {
  const payload = {
    type: "response.failed",
    response: {
      id: "resp-failed",
      error: { code: "context_length_exceeded", type: "invalid_request_error", message: "Context too long" },
      input: "private input",
      output: [{ text: "private output" }]
    }
  };
  const logs = await observe(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`, { context: { requestId: "aerial-request" } });
  const failure = logs.find((entry) => entry.event === "upstream_response_failed");
  assert.ok(failure);
  assert.equal(failure.eventType, "response.failed");
  assert.equal(failure.model, "test-model");
  assert.equal(failure.requestId, "aerial-request");
  assert.equal(failure.upstreamRequestId, "upstream-request");
  assert.equal(failure.responseId, "resp-failed");
  assert.equal(failure.errorCode, "context_length_exceeded");
  assert.equal(failure.errorType, "invalid_request_error");
  assert.equal(failure.message, "Context too long");
  assert.doesNotMatch(JSON.stringify(logs), /private input|private output/);
});

test("failure observation handles split UTF-8, CRLF and multiline SSE data", async () => {
  const source = 'event: response.failed\r\ndata: {"response":\r\ndata: {"error":{"code":"server_error","message":"压缩失败"}}}\r\n\r\n';
  const chunks = Array.from(Buffer.from(source), (byte) => Buffer.from([byte]));
  const logs = await observe(source, { chunks });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, "压缩失败");
  assert.equal(logs[0].errorCode, "server_error");
});

test("top-level and nested error events are observed without cache hints", async () => {
  for (const payload of [
    { type: "error", code: "rate_limit_exceeded", message: "Try later" },
    { type: "error", error: { code: "rate_limit_exceeded", message: "Try later" } }
  ]) {
    const logs = await observe(`data: ${JSON.stringify(payload)}\n\n`);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].event, "upstream_response_failed");
    assert.equal(logs[0].errorCode, "rate_limit_exceeded");
    assert.equal(logs[0].message, "Try later");
  }
});

test("a final failure frame without a delimiter is still diagnosed", async () => {
  const logs = await observe('data: {"type":"response.failed","response":{"error":{"message":"Failed"}}}');
  assert.equal(logs[0].message, "Failed");
});

test("failure messages are bounded and credentials are redacted", async () => {
  const secret = `gho_${"a".repeat(30)}`;
  const payload = { type: "error", error: { message: `Bearer ${secret} ${"x".repeat(5000)}`, output: "private conversation" } };
  const logs = await observe(`data: ${JSON.stringify(payload)}\n\n`);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].message.length <= 2048);
  assert.match(logs[0].message, /\[redacted\]/);
  assert.doesNotMatch(JSON.stringify(logs), /gho_|private conversation/);
});

test("non-string error objects are not serialized into diagnostic fields", async () => {
  const payload = { type: "error", error: { message: { input: "private input" }, code: { secret: "private code" } } };
  const logs = await observe(`data: ${JSON.stringify(payload)}\n\n`);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, undefined);
  assert.equal(logs[0].errorCode, undefined);
  assert.doesNotMatch(JSON.stringify(logs), /private input|private code/);
});

test("successful and malformed frames preserve cache telemetry without reporting failures", async () => {
  const logs = await observe('data: malformed\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2,"input_tokens_details":{"cached_tokens":5}}}}\n\ndata: [DONE]\n\n');
  assert.equal(logs.some((entry) => entry.event === "upstream_response_failed"), false);
  assert.deepEqual(logs.find((entry) => entry.event === "cache_observe").usage, { input: 10, output: 2, cached: 5 });
});

test("real HTTP proxy logs the effective retry request ID and preserves a failed SSE response", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-failure-http-"));
  const overrides = {
    AERIAL_CONFIG_DIR: directory,
    AERIAL_API_KEY: "aerial_test_failure",
    AERIAL_GITHUB_TOKEN: "github-test-failure",
    AERIAL_LOG_FILE: path.join(directory, "aerial.log"),
    AERIAL_UPSTREAM_PROXY: ""
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const originalFetch = globalThis.fetch;
  const { createServer } = await import("../src/proxy/server.js");
  const { _resetForTests } = await import("../src/shared/log.js");
  const { _resetCopilotTokenCacheForTests } = await import("../src/shared/auth.js");
  const { ensureApiKey } = await import("../src/shared/config.js");
  ensureApiKey();
  _resetCopilotTokenCacheForTests();
  _resetForTests();
  const source = 'event: response.failed\ndata: {"type":"response.failed","response":{"id":"resp-http","error":{"code":"server_error","message":"Compaction failed"},"output":"private output"}}\n\n';
  const attempts = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    assert.ok(String(url).endsWith("/responses"));
    attempts.push(init.headers["x-request-id"]);
    if (attempts.length === 1) return Response.json({ error: "expired" }, { status: 401 });
    return new Response(source, { headers: { "content-type": "text/event-stream", "x-request-id": "http-upstream" } });
  };
  const server = createServer();
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer aerial_test_failure", "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", stream: true, input: "private input" }),
      signal: AbortSignal.timeout(5000)
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), "http-upstream");
    assert.equal(await response.text(), source);
    const contents = fs.readFileSync(overrides.AERIAL_LOG_FILE, "utf8");
    const failure = contents.trim().split("\n").map((line) => JSON.parse(line)).find((entry) => entry.event === "upstream_response_failed");
    assert.ok(failure);
    assert.equal(attempts.length, 2);
    assert.equal(failure.requestId, attempts[1]);
    assert.equal(failure.upstreamRequestId, "http-upstream");
    assert.equal(failure.model, "test-model");
    assert.equal(failure.errorCode, "server_error");
    assert.doesNotMatch(contents, /private input|private output|github-test-failure|aerial_test_failure/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    _resetForTests();
    _resetCopilotTokenCacheForTests();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
