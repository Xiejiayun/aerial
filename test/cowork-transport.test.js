import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { COWORK_INVESTIGATION_PROMPT, createCoworkTransport } from "../src/cowork/transport.js";

const profile = {
  version: 1, origin: "https://cowork.example.test", authorityHost: "https://login.microsoftonline.com",
  clientId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222",
  scope: "22222222-2222-4222-8222-222222222222/access_as_user",
  evidence: { source: "authorized-session", observedAt: "2026-11-11T00:00:00Z" },
  capabilities: { connectorsDisabled: "verified", completion: "fr-plus-rl-ok", eventCorrelation: "verified", verifiedEfforts: ["medium"] }
};
const identity = { tenantId: "33333333-3333-4333-8333-333333333333", objectId: "44444444-4444-4444-8444-444444444444" };
const auth = { getToken: async () => ({ bearer: "synthetic-token", expiresAt: Date.now() + 3600_000, identity }) };
const route = { upstreamId: "exact-opus-fixture", publicId: "cowork/claude-opus-fixture" };
const stream = () => new Response('event: fr\ndata: {"content":"done"}\n\nevent: rl\ndata: {"st":"ok"}\n\n', { headers: { "content-type": "text/event-stream" } });

test("read-only directory discovery does not require live gates or submit inference", async () => {
  const requests = [];
  const transport = createCoworkTransport({ profile: { ...profile, capabilities: {} }, auth, fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return Response.json({ models: [{ id: route.upstreamId, display_name: "Opus fixture", provider: "anthropic" }] });
  } });
  assert.deepEqual(await transport.models(), [{ upstreamId: route.upstreamId, displayName: "Opus fixture", provider: "anthropic" }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${profile.origin}/v1/models`);
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.headers["x-container-config"], undefined);
  await assert.rejects(transport.execute({ prompt: "hello" }), { code: "PROTOCOL_UNVERIFIED" });
});

test("directory discovery rejects malformed, duplicate and unauthorized model lists", async () => {
  for (const response of [Response.json({ data: [] }), Response.json({ models: [{ id: "bad;model=other", display_name: "Bad", provider: "unknown" }] }),
    Response.json({ models: [{ id: "dup", display_name: "A", provider: "a" }, { id: "dup", display_name: "B", provider: "b" }] })]) {
    const transport = createCoworkTransport({ profile, auth, fetchImpl: async () => response });
    await assert.rejects(transport.models(), { code: "PROTOCOL_CHANGED" });
  }
  await assert.rejects(createCoworkTransport({ profile, auth, fetchImpl: async () => new Response(null, { status: 403 }) }).models(), { code: "AUTH_DENIED" });
});

test("Cowork subscribes before one POST, records submission first and pins exact model", async () => {
  const seen = [];
  let body;
  const transport = createCoworkTransport({ profile, auth, route, fetchImpl: async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["x-container-config"], `model=${route.upstreamId};reasoningEffort=medium`);
    if (url.includes("/v1/subscribe?")) { seen.push("subscribe"); return stream(); }
    assert.equal(url, `${profile.origin}/v1/messages`);
    seen.push("post");
    body = JSON.parse(init.body);
    return Response.json({ status: "accepted", conversationId: body.conversationId, messageId: body.messageId }, { status: 202 });
  } });
  const result = await transport.execute({ prompt: "synthetic", effort: "medium", operationId: "operation-1", onPhase: async (phase) => { seen.push(phase); } });
  assert.deepEqual(seen, ["SUBSCRIBING", "subscribe", "SUBMITTING", "post", "ACCEPTED", "RESULT_RECEIVED"]);
  assert.deepEqual(body.connectorsConfig, { connectors: [], include_defaults: false, packages: [] });
  assert.equal(body.queue, true);
  assert.equal(result.text, "done");
  assert.equal(result.completionEvidence, "fr-plus-rl-ok");
  assert.equal(Object.hasOwn(result, "observedActualModel"), false);
});

test("failed operation persistence prevents the inference POST", async () => {
  let posts = 0;
  const transport = createCoworkTransport({ profile, auth, route, fetchImpl: async (_url, init) => {
    if (init.method === "POST") posts++;
    return stream();
  } });
  await assert.rejects(transport.execute({ prompt: "synthetic", onPhase: async (phase) => { if (phase === "SUBMITTING") throw new Error("disk write failed"); } }));
  assert.equal(posts, 0);
});

test("a lost POST response is unknown and is never retried", async () => {
  let posts = 0;
  let canceled = false;
  const transport = createCoworkTransport({ profile, auth, route, fetchImpl: async (_url, init) => {
    if (init.method !== "POST") return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-type": "text/event-stream" } });
    posts++;
    throw new TypeError("secret upstream connection detail");
  } });
  await assert.rejects(transport.execute({ prompt: "synthetic" }), (error) => error.code === "SUBMISSION_UNKNOWN" && error.submitted && !error.message.includes("secret"));
  assert.equal(posts, 1);
  assert.equal(canceled, true);
});

test("invalid acceptance and final-only EOF remain unknown after a single POST", async () => {
  for (const invalidAcceptance of [true, false]) {
    let posts = 0;
    const transport = createCoworkTransport({ profile, auth, route, fetchImpl: async (_url, init) => {
      if (init.method !== "POST") return new Response('event: fr\ndata: {"content":"candidate"}\n\n', { headers: { "content-type": "text/event-stream" } });
      posts++;
      return Response.json({ status: invalidAcceptance ? "new-status" : "accepted" }, { status: 202 });
    } });
    await assert.rejects(transport.execute({ prompt: "synthetic" }), { code: "SUBMISSION_UNKNOWN", submitted: true });
    assert.equal(posts, 1);
  }
});

test("unverified effort and container-header injection fail before contacting Cowork", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return stream(); };
  await assert.rejects(createCoworkTransport({ profile, auth, route, fetchImpl }).execute({ prompt: "synthetic", effort: "max" }), { code: "UNSUPPORTED_CAPABILITY" });
  await assert.rejects(createCoworkTransport({ profile, auth, route: { upstreamId: "opus;model=other" }, fetchImpl }).execute({ prompt: "synthetic" }), { code: "MODEL_UNAVAILABLE" });
  assert.equal(calls, 0);
});

test("remote rejection does not trigger an automatic token refresh or POST retry", async () => {
  let posts = 0;
  let tokenRequests = 0;
  const transport = createCoworkTransport({ profile, auth: { getToken: async () => { tokenRequests++; return auth.getToken(); } }, route,
    fetchImpl: async (_url, init) => {
      if (init.method !== "POST") return stream();
      posts++;
      return new Response(null, { status: 401 });
    }
  });
  await assert.rejects(transport.execute({ prompt: "synthetic" }), { code: "AUTH_REQUIRED", submitted: true });
  assert.equal(posts, 1);
  assert.equal(tokenRequests, 1);
});

test("Cowork adapter completes through a real local HTTP and independent SSE subscription", async (t) => {
  let subscription;
  let posts = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/v1/subscribe?")) {
      subscription = res;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": subscription ready\n\n");
      return;
    }
    if (req.url === "/v1/messages" && req.method === "POST") {
      posts++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "accepted", conversationId: body.conversationId, messageId: body.messageId }));
      subscription.write(`event: fr\ndata: ${JSON.stringify({ content: "http-stream-complete", conversationId: body.conversationId })}\n\n`);
      subscription.write('event: rl\ndata: {"st":"ok"}\n\n');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const transport = createCoworkTransport({ profile, auth, route, fetchImpl: (url, init) => {
    const parsed = new URL(url);
    return fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, init);
  } });
  const result = await transport.execute({ prompt: "synthetic-only", signal: AbortSignal.timeout(3000) });
  assert.equal(result.text, "http-stream-complete");
  assert.equal(posts, 1);
});

test("P0 investigation uses one fixed text request without enabling general inference", async () => {
  let submitted;
  const observations = [];
  const unverified = { ...profile, capabilities: {} };
  const transport = createCoworkTransport({ profile: unverified, auth, route, fetchImpl: async (_url, init) => {
    if (init.method !== "POST") return new Response('event: fr\ndata: {"content":"COWORK_PROTOCOL_TEXT_OK"}\n\nevent: rl\ndata: {"st":"ok"}\n\n', { headers: { "content-type": "text/event-stream" } });
    submitted = JSON.parse(init.body);
    return Response.json({ status: "accepted", extra: "sensitive-value-must-not-leak" }, { status: 202 });
  } });
  const result = await transport.investigateText({ prompt: "Ignored arbitrary client input", onEvent: async (event) => observations.push(event) });
  assert.equal(submitted.content[0].text, COWORK_INVESTIGATION_PROMPT);
  assert.equal(result.expectedTextMatched, true);
  assert.equal(result.investigation, true);
  assert.equal(Object.hasOwn(result, "text"), false);
  assert.equal(JSON.stringify(observations).includes("sensitive-value"), false);
  assert.deepEqual(observations.find((event) => event.kind === "submission_body").fieldTypes, { status: "string", extra: "string" });
  assert.deepEqual(unverified.capabilities, {});
  await assert.rejects(transport.execute({ prompt: "ordinary user request" }), { code: "PROTOCOL_UNVERIFIED" });
});

test("P0 records response status and field types before rejecting unknown acceptance", async () => {
  const observations = [];
  let posts = 0;
  const transport = createCoworkTransport({ profile: { ...profile, capabilities: {} }, auth, route, fetchImpl: async (_url, init) => {
    if (init.method !== "POST") return stream();
    posts++;
    return Response.json({ unexpected: "private server detail" }, { status: 200 });
  } });
  await assert.rejects(transport.investigateText({ onEvent: async (event) => observations.push(event) }), { code: "SUBMISSION_UNKNOWN", submitted: true });
  assert.equal(posts, 1);
  assert.deepEqual(observations, [{ kind: "submission_response", httpStatus: 200 }, { kind: "submission_body", httpStatus: 200, fieldTypes: { unexpected: "string" } }]);
});
