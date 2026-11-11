import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOperationStore } from "../src/cowork/operations.js";

const route = { publicId: "cowork/claude-test", upstreamId: "test-upstream" };
const body = { model: route.publicId, max_tokens: 100, messages: [{ role: "user", content: "synthetic private content" }] };
function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cowork-operations-"));
  return { directory, store: createOperationStore({ directory, route, ...options }) };
}
function submit(store, record) { store.phase(record, "SUBMITTING", { conversationId: "synthetic-conversation", messageId: "synthetic-message" }); store.phase(record, "ACCEPTED"); }

test("Cowork writes recovery metadata before submission and never writes prompt or result content", () => {
  const { directory, store } = fixture();
  const { record } = store.claim({ body });
  store.phase(record, "SUBMITTING");
  const persisted = fs.readFileSync(path.join(directory, "operations.json"), "utf8");
  assert.equal(JSON.parse(persisted).records[0].submitted, true);
  assert.equal(persisted.includes("synthetic private content"), false);
  assert.throws(() => store.phase(record, "SUBMITTING"), { code: "DUPLICATE_SUBMISSION" });
});

test("Cowork deduplicates semantic requests, including changes in stream and attribution", () => {
  const { store } = fixture();
  const { record } = store.claim({ body, sessionId: "session" });
  assert.throws(() => store.claim({ body: { ...body, stream: true, metadata: { trace: "new" } }, sessionId: "session" }), error => error.code === "OPERATION_IN_PROGRESS" && error.operationId === record.id);
  const other = store.claim({ body, sessionId: "other-session" });
  assert.notEqual(other.record.id, record.id);
  const changed = store.claim({ body: { ...body, messages: [...body.messages, { role: "user", content: "second" }] }, sessionId: "session" });
  assert.notEqual(changed.record.id, record.id);
});

test("Cowork rejects reused explicit keys for different requests", () => {
  const { store } = fixture();
  store.claim({ body, idempotencyKey: "same" });
  assert.throws(() => store.claim({ body: { ...body, max_tokens: 101 }, idempotencyKey: "same" }), { code: "IDEMPOTENCY_CONFLICT" });
});

test("Cowork reuses identical tool IDs only while the result cache exists", () => {
  let now = 100;
  const { directory, store } = fixture({ now: () => now, resultTtlMs: 10 });
  const { record } = store.claim({ body, idempotencyKey: "stable" });
  submit(store, record);
  const message = { id: "fixed-message", content: [{ type: "tool_use", id: "fixed-tool", name: "Read", input: { file_path: "private-path" } }] };
  store.succeed(record, message);
  assert.strictEqual(store.claim({ body, idempotencyKey: "stable" }).message, message);
  assert.equal(fs.readFileSync(path.join(directory, "operations.json"), "utf8").includes("private-path"), false);
  now += 11;
  assert.throws(() => store.claim({ body, idempotencyKey: "stable" }), { code: "RESULT_UNAVAILABLE" });
  const restarted = createOperationStore({ directory, route });
  assert.throws(() => restarted.claim({ body, idempotencyKey: "stable" }), { code: "RESULT_UNAVAILABLE" });
  restarted.release(record.id);
  assert.notEqual(restarted.claim({ body, idempotencyKey: "stable" }).record.id, record.id);
});

test("Cowork interrupted and unknown submissions survive restart without allowing a new POST", () => {
  const { directory, store } = fixture();
  const { record } = store.claim({ body });
  submit(store, record);
  const restarted = createOperationStore({ directory, route });
  assert.equal(restarted.list()[0].remoteState, "unknown");
  assert.throws(() => restarted.claim({ body }), { code: "SUBMISSION_UNKNOWN" });
});

test("Cowork allows retrying a failure before submission but blocks accepted failures", () => {
  const { store } = fixture();
  const first = store.claim({ body }).record;
  store.fail(first, { code: "AUTH_REQUIRED" });
  const second = store.claim({ body }).record;
  assert.notEqual(second.id, first.id);
  submit(store, second);
  store.fail(second, { code: "UPSTREAM_FAILED", remoteState: "failed" });
  assert.throws(() => store.claim({ body }), { code: "OPERATION_ALREADY_SUBMITTED" });
});

test("Cowork bounds result memory and operation metadata without losing retry protection", () => {
  const { store } = fixture({ maxResultBytes: 32, maxRecords: 2 });
  const first = store.claim({ body }).record;
  submit(store, first); store.succeed(first, { text: "x".repeat(64) });
  assert.throws(() => store.claim({ body }), { code: "RESULT_UNAVAILABLE" });
  store.claim({ body: { ...body, max_tokens: 2 } });
  assert.throws(() => store.claim({ body: { ...body, max_tokens: 3 } }), { code: "OPERATION_STORE_FULL" });
  store.release(first.id);
  assert.doesNotThrow(() => store.claim({ body: { ...body, max_tokens: 3 } }));
});

test("Cowork refuses corrupt metadata and fails before submission when storage is unavailable", () => {
  const { directory, store } = fixture();
  const file = path.join(directory, "operations.json");
  fs.mkdirSync(file);
  assert.throws(() => store.claim({ body }), { code: "OPERATION_STORE_FAILED" });
  assert.equal(store.list().length, 0);
  assert.throws(() => createOperationStore({ directory, route }), { code: "OPERATION_STORE_INVALID" });
});
