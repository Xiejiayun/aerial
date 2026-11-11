import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCoworkGateway } from "../src/cowork/gateway.js";
import { CoworkError } from "../src/cowork/protocol.js";

const key = "aerial-cowork-synthetic-key-" + "x".repeat(32);
const route = { publicId: "cowork/claude-opus-test", upstreamId: "synthetic-test-route", displayName: "Synthetic test route" };
const capabilities = { supportedEfforts: ["low"], allowedBetas: ["claude-code-20250219"] };
const body = { model: route.publicId, max_tokens: 128, messages: [{ role: "user", content: "hello" }] };
const tool = { name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false } };
const envelope = (calls = [], text = "done") => JSON.stringify({ version: 1, text, tool_calls: calls });
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function submitted({ onPhase }) { await onPhase("SUBMITTING", { conversationId: "synthetic", messageId: "message" }); await onPhase("ACCEPTED"); }
async function fixture(t, options = {}) {
  const directory = options.operationDirectory || fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cowork-http-"));
  const gateway = createCoworkGateway({ key, route, capabilities, operationDirectory: directory, execute: async context => { await submitted(context); return { text: "你好😀", completionEvidence: "synthetic-final-and-ok" }; }, ...options });
  const base = await gateway.listen();
  t.after(() => gateway.close());
  return { gateway, base, directory, request: (payload = body, headers = {}, endpoint = "/v1/messages") => fetch(base + endpoint, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, ...headers }, body: JSON.stringify(payload) }) };
}
function events(text) {
  return text.split(/\r?\n\r?\n/).filter(Boolean).map(frame => JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5) || "null")).filter(Boolean);
}

test("Cowork HTTP uses local authentication, mixed-key compatibility, Origin rejection and unsupported count_tokens", async t => {
  const { base, request } = await fixture(t);
  assert.equal((await fetch(base + "/api/hello", { method: "HEAD" })).status, 200);
  assert.equal((await fetch(base + "/v1/models")).status, 401);
  const models = await fetch(base + "/v1/models", { headers: { authorization: `Bearer ${key}`, "x-api-key": "stale" } });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).data[0].id, route.publicId);
  assert.equal((await request(body, { origin: "https://example.invalid" })).status, 403);
  assert.equal((await request(body, {}, "/v1/messages/count_tokens")).status, 404);
  const response = await request(body, { authorization: `Bearer ${key}`, "x-api-key": "stale" }, "/v1/messages?beta=true");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-cwg-usage-source"), "estimated");
  assert.equal(response.headers.get("x-should-retry"), "false");
  assert.equal((await response.json()).content[0].text, "你好😀");
});

test("Cowork validates client capabilities and malformed JSON without submitting upstream", async t => {
  const { base, gateway, request } = await fixture(t);
  for (const [payload, headers] of [[{ ...body, thinking: { type: "adaptive" } }, {}], [body, { "anthropic-beta": "unknown" }], [{ ...body, tools: [{ name: "Remote", input_schema: { type: "object", properties: { value: { $ref: "https://example.invalid/schema" } } } }] }, {}]]) {
    assert.equal((await request(payload, headers)).status, 400);
  }
  const malformed = await fetch(base + "/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  assert.equal(gateway.stats.upstreamTurns, 0);
});

test("Cowork failure diagnostics identify client beta negotiation without logging request secrets", async t => {
  const logged = [];
  const { gateway, request } = await fixture(t, { log: event => logged.push(event) });
  const secret = "private-prompt-and-credential-2026-11-11";
  const payload = { ...body, messages: [{ role: "user", content: secret }], output_config: { effort: "low" }, thinking: { type: "adaptive" } };
  assert.equal((await request(payload, { "anthropic-beta": "fallback-credit-2026-06-01" })).status, 400);
  assert.deepEqual(logged[0], {
    event: "cowork_error", operationId: undefined, code: "UNSUPPORTED_CAPABILITY", remoteState: undefined,
    endpoint: "/v1/messages", unsupportedCapability: "anthropic-beta", unsupportedBeta: "fallback-credit-2026-06-01", requestedEffort: "low", requestedThinking: "adaptive"
  });
  assert.equal((await request({ ...payload, thinking: { type: secret } }, { "anthropic-beta": secret })).status, 400);
  assert.equal(logged[1].unsupportedBeta, undefined);
  assert.equal(logged[1].requestedThinking, undefined);
  assert.doesNotMatch(JSON.stringify(logged), /private-prompt-and-credential/);
  assert.equal(gateway.stats.errors, 2);
  assert.equal(gateway.stats.upstreamTurns, 0);
});

test("Cowork streams UTF-8 text and complete validated tool JSON with honest usage", async t => {
  const { request } = await fixture(t, { execute: async context => {
    await submitted(context);
    return { text: envelope([{ name: "Read", input: { file_path: "你好😀.txt" } }], "读取"), completionEvidence: "synthetic-final-and-ok" };
  } });
  const response = await request({ ...body, tools: [tool], stream: true });
  const received = events(await response.text());
  assert.equal(received[0].type, "message_start");
  assert.equal(received.at(-1).type, "message_stop");
  assert.equal(received.find(event => event.delta?.type === "input_json_delta").delta.partial_json, '{"file_path":"你好😀.txt"}');
  assert.equal(received.find(event => event.type === "message_delta").delta.stop_reason, "tool_use");
  assert.ok(received[0].message.usage.input_tokens > 10);
});

test("Cowork heartbeats precede completion and late invalid tools end with error, never successful stop", async t => {
  const done = deferred();
  const { request } = await fixture(t, { heartbeatMs: 10, execute: async context => { await submitted(context); await done.promise; return { text: envelope([{ name: "Read", input: { file_path: 123 } }]), completionEvidence: "synthetic-final-and-ok" }; } });
  const response = await request({ ...body, tools: [tool], stream: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: ping")) text += decoder.decode((await reader.read()).value, { stream: true });
  done.resolve();
  while (true) { const result = await reader.read(); if (result.done) break; text += decoder.decode(result.value, { stream: true }); }
  const received = events(text);
  assert.equal(received.at(-1).type, "error");
  assert.equal(received.at(-1).error.code, "UPSTREAM_OUTPUT_INVALID");
  assert.equal(received.some(event => ["content_block_start", "message_stop"].includes(event.type)), false);
});

test("Cowork deduplicates an in-flight turn and reuses a completed tool proposal without another POST", async t => {
  const started = deferred(), done = deferred();
  const { gateway, request } = await fixture(t, { execute: async context => {
    await submitted(context); started.resolve(); await done.promise;
    return { text: envelope([{ name: "Read", input: { file_path: "x" } }]), completionEvidence: "synthetic-final-and-ok" };
  } });
  const payload = { ...body, tools: [tool] };
  const first = request(payload);
  await started.promise;
  const duplicate = await request(payload);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, "OPERATION_IN_PROGRESS");
  done.resolve();
  const original = await (await first).json();
  const repeated = await (await request(payload)).json();
  assert.deepEqual(repeated, original);
  assert.equal(gateway.stats.upstreamTurns, 1);
});

test("Cowork requires completion evidence and never retries upstream errors", async t => {
  const { gateway, request } = await fixture(t, { execute: async context => { await submitted(context); return { text: "not enough" }; } });
  const response = await request();
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "PROTOCOL_CHANGED");
  assert.equal((await request()).status, 409);
  assert.equal(gateway.stats.upstreamTurns, 1);
});

test("Cowork deadline aborts transport and keeps unknown submission retry protection", async t => {
  let signal;
  const { gateway, request, directory } = await fixture(t, { timeoutMs: 100, execute: async context => {
    await submitted(context); signal = context.signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  const response = await request({ ...body, stream: true });
  const received = events(await response.text());
  assert.equal(received.at(-1).error.code, "LOCAL_TIMEOUT");
  assert.equal(signal.aborted, true);
  assert.equal((await request()).status, 409);
  assert.equal(gateway.stats.upstreamTurns, 1);
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "operations.json"), "utf8"));
  assert.equal(metadata.records[0].remoteState, "unknown");
});

test("Cowork client disconnect aborts the local transport without claiming remote cancellation", async t => {
  const started = deferred(), stopped = deferred();
  const { base, directory } = await fixture(t, { execute: async context => {
    await submitted(context); started.resolve();
    return new Promise((_, reject) => context.signal.addEventListener("abort", () => { stopped.resolve(); reject(context.signal.reason); }, { once: true }));
  } });
  const client = http.request(base + "/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" } });
  client.on("error", () => {}); client.end(JSON.stringify(body));
  await started.promise; client.destroy(); await stopped.promise;
  await new Promise(resolve => setImmediate(resolve));
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "operations.json"), "utf8"));
  assert.equal(metadata.records[0].phase, "UNKNOWN");
  assert.equal(metadata.records[0].remoteState, "unknown");
});

test("Cowork total deadline includes the bounded queue and prevents queued submission", async t => {
  const { gateway, request } = await fixture(t, { timeoutMs: 100, maxActive: 1, maxQueued: 1, execute: async context => {
    await submitted(context);
    return new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }));
  } });
  const responses = await Promise.all([request(), request({ ...body, max_tokens: 129 }), request({ ...body, max_tokens: 130 })]);
  assert.ok(responses.some(response => response.status === 429));
  assert.ok(responses.some(response => response.status === 504));
  // The queued request may acquire the slot a few ms before its own deadline;
  // it must still never reset that deadline or exceed the configured concurrency.
  assert.ok(gateway.stats.upstreamTurns <= 2);
});

test("Cowork error mapping does not serialize raw upstream errors or tokens", async t => {
  const { request } = await fixture(t, { execute: async context => { await submitted(context); throw new Error("secret-bearer-and-prompt"); } });
  const text = await (await request()).text();
  assert.equal(text.includes("secret-bearer-and-prompt"), false);
  assert.match(text, /UPSTREAM_FAILED/);
});

test("Cowork shutdown drains blocked local delivery while preserving the completed remote result", async t => {
  const { base, gateway, directory } = await fixture(t, { execute: async context => {
    await submitted(context);
    return { text: "x".repeat(4 * 1024 * 1024 - 1), completionEvidence: "synthetic-final-and-ok" };
  } });
  const client = http.request(base + "/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" } });
  client.on("error", () => {});
  const response = new Promise(resolve => client.once("response", incoming => { incoming.pause(); resolve(incoming); }));
  client.end(JSON.stringify({ ...body, stream: true }));
  const incoming = await response;
  await gateway.close();
  incoming.destroy(); client.destroy();
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, "operations.json"), "utf8"));
  assert.equal(metadata.records[0].phase, "SUCCEEDED");
  assert.equal(metadata.records[0].remoteState, "succeeded");
  assert.ok(["INTERRUPTED", "LOCALLY_WRITTEN"].includes(metadata.records[0].delivery));
});
