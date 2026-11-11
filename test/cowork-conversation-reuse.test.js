import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createOperationStore } from "../src/cowork/operations.js";
import { createCoworkGateway } from "../src/cowork/gateway.js";
import { createCoworkTransport, COWORK_CONVERSATION_PROBES } from "../src/cowork/transport.js";
import { verifyCoworkConversationReuse, parseConversationVerificationArguments } from "../scripts/verify-cowork-conversation.mjs";

const route = { publicId: "cowork/claude-opus-fixture", upstreamId: "exact-opus-fixture", displayName: "Claude Opus fixture", provider: "anthropic", supportedEfforts: ["medium"], defaultEffort: "medium" };
const body = value => ({ model: route.publicId, max_tokens: 100, messages: [{ role: "user", content: value }] });
const key = "aerial-conversation-test-" + "x".repeat(32);
const profile = { version: 1, origin: "https://cowork.example.test", authorityHost: "https://login.microsoftonline.com",
  clientId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222",
  scope: "22222222-2222-4222-8222-222222222222/access_as_user",
  evidence: { source: "authorized-session", observedAt: "2026-11-11T00:00:00Z" },
  capabilities: { connectorsDisabled: "verified", completion: "fr-plus-rl-ok", eventCorrelation: "verified", verifiedEfforts: ["medium"], verifiedModelEfforts: { "exact-opus-fixture": ["medium"] } } };
const identity = { tenantId: "33333333-3333-4333-8333-333333333333", objectId: "44444444-4444-4444-8444-444444444444" };
const auth = { getToken: async () => ({ bearer: "synthetic", identity }), close: async () => {} };
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cowork-reuse-"));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function finish(store, record) { const result = store.phase(record, "SUBMITTING"); store.succeed(record, { content: [] }); return result; }
function fakeTransport({ stale = false, wrongNonce = false, calls = [] } = {}) {
  let controller;
  return async (_url, init) => {
    if (init.method !== "POST") return new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } });
    const request = JSON.parse(init.body); calls.push(request);
    const probe = COWORK_CONVERSATION_PROBES.find(item => request.content[0].text.startsWith(item.prompt));
    const responsePrefix = /exact first line: (AERIAL_COWORK_RESPONSE_[a-f0-9-]+)/.exec(request.content[0].text)?.[1];
    const text = `${responsePrefix ? `${wrongNonce ? "AERIAL_COWORK_RESPONSE_old" : responsePrefix}\n` : ""}${probe?.expected || "done"}`;
    const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(Buffer.from((stale ? "" : frame("q", { mid: request.messageId }))
      + frame("fr", { content: text, mid: "assistant-id", conversationId: request.conversationId })
      + frame("rl", { st: "ok", mid: request.messageId })));
    controller.close();
    return Response.json({ status: "accepted", conversationId: request.conversationId, messageId: request.messageId }, { status: 202 });
  };
}

test("conversation mapping survives restart, hashes session selectors and isolates route and profile owners", () => {
  const root = directory();
  let store = createOperationStore({ directory: root, route, conversationReuse: true });
  const first = store.claim({ body: body("one"), sessionId: "private-session-selector" }).record;
  assert.equal(finish(store, first).newConversation, true);
  const second = store.claim({ body: body("two"), sessionId: "private-session-selector" }).record;
  assert.equal(second.conversationKey, first.conversationKey);
  assert.notEqual(second.messageId, first.messageId);
  assert.equal(finish(store, second).newConversation, false);
  store = createOperationStore({ directory: root, route, conversationReuse: true });
  const resumed = store.claim({ body: body("three"), sessionId: "private-session-selector" }).record;
  assert.equal(resumed.conversationKey, first.conversationKey);
  assert.equal(finish(store, resumed).newConversation, false);
  const otherSession = store.claim({ body: body("four"), sessionId: "another-session" }).record;
  assert.notEqual(otherSession.conversationKey, first.conversationKey);
  finish(store, otherSession);
  const switched = createOperationStore({ directory: root, route: { ...route, upstreamId: "sonnet-fixture" }, conversationReuse: true });
  assert.notEqual(switched.claim({ body: body("five"), sessionId: "private-session-selector" }).record.conversationKey, first.conversationKey);
  const otherOwner = createOperationStore({ directory: directory(), route, conversationReuse: true });
  assert.notEqual(otherOwner.claim({ body: body("one"), sessionId: "private-session-selector" }).record.conversationKey, first.conversationKey);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "operations.json"), "utf8"), /private-session-selector|another-session/);
});

test("unknown operations quarantine changed and queued requests across restart; explicit release rotates conversation", () => {
  const root = directory();
  let store = createOperationStore({ directory: root, route, conversationReuse: true });
  const first = store.claim({ body: body("one"), sessionId: "session" }).record;
  const queued = store.claim({ body: body("two"), sessionId: "session" }).record;
  store.phase(first, "SUBMITTING"); store.fail(first, { code: "SUBMISSION_UNKNOWN" });
  assert.throws(() => store.ready(queued), { code: "SUBMISSION_UNKNOWN" });
  assert.throws(() => store.claim({ body: body("three"), sessionId: "session" }), { code: "SUBMISSION_UNKNOWN" });
  store.fail(queued, { code: "SUBMISSION_UNKNOWN" });
  store = createOperationStore({ directory: root, route, conversationReuse: true });
  assert.throws(() => store.claim({ body: body("four"), sessionId: "session" }), { code: "SUBMISSION_UNKNOWN" });
  store.release(first.id);
  const fresh = store.claim({ body: body("five"), sessionId: "session" }).record;
  assert.notEqual(fresh.conversationKey, first.conversationKey);
  assert.equal(finish(store, fresh).newConversation, true);
});

test("unverified routes and absent session IDs never reuse a conversation", () => {
  for (const options of [{ conversationReuse: false, sessionId: "session" }, { conversationReuse: true, sessionId: "" }]) {
    const store = createOperationStore({ directory: directory(), route, conversationReuse: options.conversationReuse });
    for (const value of ["one", "two"]) {
      const record = store.claim({ body: body(value), sessionId: options.sessionId }).record;
      assert.equal(record.conversationKey, undefined); assert.equal(finish(store, record).newConversation, true);
    }
  }
});

test("released operations allow bounded conversation metadata to be reclaimed", () => {
  const root = directory(), store = createOperationStore({ directory: root, route, conversationReuse: true, maxRecords: 2 });
  const first = store.claim({ body: body("one"), sessionId: "first" }).record; finish(store, first);
  const second = store.claim({ body: body("two"), sessionId: "second" }).record; finish(store, second);
  store.release(first.id);
  const third = store.claim({ body: body("three"), sessionId: "third" }).record; finish(store, third);
  const saved = JSON.parse(fs.readFileSync(path.join(root, "operations.json"), "utf8"));
  assert.equal(saved.conversations.length, 2);
  assert.equal(saved.conversations.some(item => item.key === first.conversationKey), false);
  assert.equal(saved.conversations.some(item => item.key === second.conversationKey), true);
});

test("gateway serializes one session without blocking another and counts only newly submitted conversations", async t => {
  const firstStarted = deferred(), releaseFirst = deferred(), otherStarted = deferred();
  const calls = [];
  const root = directory();
  const options = { key, route, capabilities: { conversationReuseVerified: true }, operationDirectory: root,
    execute: async context => {
      calls.push(context); await context.onPhase("SUBMITTING");
      if (calls.length === 1) { firstStarted.resolve(); await releaseFirst.promise; }
      else if (calls.length === 2) otherStarted.resolve();
      return { text: "done", completionEvidence: "synthetic" };
    } };
  const gateway = createCoworkGateway(options), base = await gateway.listen();
  t.after(async () => { releaseFirst.resolve(); await gateway.close(); });
  const request = (text, sessionId, url = base) => fetch(`${url}/v1/messages`, { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ ...body(text), metadata: { user_id: JSON.stringify({ session_id: sessionId, account_id: "private-account" }) } }) });
  const one = request("one", "session-a"); await firstStarted.promise;
  const two = request("two", "session-a");
  const other = request("other", "session-b"); await otherStarted.promise;
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].conversationKey, calls[1].conversationKey);
  assert.equal((await other).status, 200);
  releaseFirst.resolve(); assert.equal((await one).status, 200); assert.equal((await two).status, 200);
  assert.equal(calls[0].conversationKey, calls[2].conversationKey);
  assert.equal(gateway.stats.conversations, 2); assert.equal(gateway.stats.upstreamTurns, 3);
  await gateway.close();
  const resumed = createCoworkGateway(options), resumedBase = await resumed.listen(); t.after(() => resumed.close());
  assert.equal((await request("resumed", "session-a", resumedBase)).status, 200);
  assert.equal(calls[3].conversationKey, calls[0].conversationKey);
  assert.equal(resumed.stats.conversations, 0);
});

test("gateway never submits a queued turn after its conversation becomes unknown", async t => {
  const started = deferred(), fail = deferred(); let calls = 0;
  const gateway = createCoworkGateway({ key, route, capabilities: { conversationReuseVerified: true }, operationDirectory: directory(),
    execute: async ({ onPhase }) => { calls++; await onPhase("SUBMITTING"); started.resolve(); await fail.promise; throw new Error("synthetic disconnect"); } });
  const base = await gateway.listen(); t.after(async () => { fail.resolve(); await gateway.close(); });
  const request = text => fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "x-claude-code-session-id": "same" }, body: JSON.stringify(body(text)) });
  const first = request("one"); await started.promise; const queued = request("two");
  fail.resolve(); assert.equal((await first).status, 502);
  assert.equal((await queued).status, 409); assert.equal((await request("three")).status, 409);
  assert.equal(calls, 1);
});

test("transport reuses verified UUIDs with fresh message IDs and rejects unverified or stale completion", async () => {
  const conversationKey = randomUUID(), calls = [];
  const verified = { ...profile, capabilities: { ...profile.capabilities, verifiedModelConversationReuse: { [route.upstreamId]: true } } };
  const transport = createCoworkTransport({ profile: verified, route, auth, fetchImpl: fakeTransport({ calls }) });
  const first = await transport.execute({ prompt: "one", conversationKey }); await transport.execute({ prompt: "two", conversationKey });
  assert.equal(first.text, "done"); assert.equal(first.responseNonceVerified, true);
  assert.equal(calls[0].conversationId, calls[1].conversationId);
  assert.equal(calls[0].conversationId, `${identity.tenantId}:${identity.objectId}:${conversationKey}`);
  assert.notEqual(calls[0].messageId, calls[1].messageId);
  await assert.rejects(createCoworkTransport({ profile, route, auth, fetchImpl: fakeTransport() }).execute({ prompt: "one", conversationKey }), { code: "UNSUPPORTED_CAPABILITY" });
  await assert.rejects(transport.execute({ prompt: "one", conversationKey: "session-from-client" }), { code: "UNSUPPORTED_CAPABILITY" });
  const before = calls.length;
  await assert.rejects(transport.execute({ prompt: "x".repeat(4 * 1024 * 1024), conversationKey }), { code: "INVALID_REQUEST", submitted: false });
  assert.equal(calls.length, before);
  await assert.rejects(createCoworkTransport({ profile: verified, route, auth, fetchImpl: fakeTransport({ stale: true }) }).execute({ prompt: "one", conversationKey }), { code: "PROTOCOL_CHANGED", submitted: true });
  await assert.rejects(createCoworkTransport({ profile: verified, route, auth, fetchImpl: fakeTransport({ wrongNonce: true }) }).execute({ prompt: "one", conversationKey }), { code: "PROTOCOL_CHANGED", submitted: true });
});

function verifierFixture(extra = {}) {
  const root = directory(), calls = [], writes = [], lifecycle = [];
  const deps = { checkRuntime() {}, acquireLock() { lifecycle.push("lock"); return () => lifecycle.push("release"); },
    readProfile: () => profile, authFactory: () => ({ ...auth, close: async () => { lifecycle.push("auth-close"); } }),
    ensureDirectory: value => { fs.mkdirSync(value, { recursive: true }); return value; },
    transportFactory: ({ profile: value, auth: session, route: selected }) => selected
      ? createCoworkTransport({ profile: value, auth: session, route: selected, fetchImpl: fakeTransport({ calls, ...extra }) })
      : { models: async () => [route] },
    writeJson(file, value) { writes.push({ file, value }); lifecycle.push(path.basename(file) === "profile.json" ? "profile-write" : "evidence-write"); fs.writeFileSync(file, JSON.stringify(value)); }
  };
  return { root, calls, writes, lifecycle, deps };
}

test("fixed two-turn verification records sanitized model-specific evidence only after correlated success", async () => {
  const fixture = verifierFixture();
  const result = await verifyCoworkConversationReuse({ model: route.upstreamId, directory: fixture.root }, fixture.deps);
  assert.equal(result.ok, true); assert.equal(result.capabilityRecorded, true); assert.equal(result.nonceVerified, true);
  assert.equal(fixture.calls.length, 2); assert.equal(fixture.calls[0].conversationId, fixture.calls[1].conversationId);
  assert.notEqual(fixture.calls[0].messageId, fixture.calls[1].messageId);
  for (const [index, call] of fixture.calls.entries()) {
    assert.ok(call.content[0].text.startsWith(COWORK_CONVERSATION_PROBES[index].prompt));
    assert.ok(call.content[0].text.includes(`AERIAL_COWORK_RESPONSE_${call.messageId}`));
  }
  assert.deepEqual(fixture.lifecycle, ["lock", "auth-close", "evidence-write", "profile-write", "release"]);
  assert.deepEqual(fixture.writes[1].value.capabilities.verifiedModelConversationReuse, { [route.upstreamId]: true });
  assert.equal(fixture.writes[0].value.nonceVerified, true); assert.equal(fixture.writes[0].value.version, 2);
  assert.doesNotMatch(JSON.stringify(fixture.writes), new RegExp(identity.tenantId));
  assert.equal(profile.capabilities.verifiedModelConversationReuse, undefined);
});

test("failed reuse verification never promotes capability or automatically repeats an unknown turn", async () => {
  const fixture = verifierFixture({ stale: true });
  const options = { model: route.upstreamId, directory: fixture.root };
  const first = await verifyCoworkConversationReuse(options, fixture.deps);
  assert.equal(first.ok, false); assert.equal(first.code, "PROTOCOL_CHANGED"); assert.equal(first.capabilityRecorded, false);
  assert.ok(first.observations.some(item => item.kind === "fr"));
  assert.doesNotMatch(JSON.stringify(first.observations), /33333333|synthetic|COWORK_REUSE/);
  const second = await verifyCoworkConversationReuse(options, fixture.deps);
  assert.equal(second.code, "SUBMISSION_UNKNOWN"); assert.equal(fixture.calls.length, 1); assert.equal(fixture.writes.length, 0);
});

test("verification helper validates CLI arguments without contacting M365", () => {
  assert.deepEqual(parseConversationVerificationArguments(["--model", route.publicId, "--effort", "medium"]), { model: route.publicId, effort: "medium" });
  assert.deepEqual(parseConversationVerificationArguments(["--help"]), { help: true });
  for (const args of [[], ["--model"], ["--model", "x", "--model", "y"], ["--unknown", "x"], ["--help", "--model", "x"]]) {
    assert.throws(() => parseConversationVerificationArguments(args), { code: "INVALID_REQUEST" });
  }
});
