import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createCoworkService, coworkServiceConfiguration } from "../src/cowork/service.js";

const config = { cowork: { model: "cowork/claude-opus-test", profileDirectory: path.join(os.tmpdir(), "synthetic-cowork-service"), effort: "medium", displayName: "Opus test" } };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture() {
  let closed = 0;
  const session = { model: config.cowork.model, route: { upstreamId: "opus-test" },
    baseUrl: "http://127.0.0.1:12345", apiKey: "synthetic-private-gateway-key",
    capabilities: { clientEffort: "medium", supportedEfforts: ["medium"], cloudToolIsolation: "unverified", experimentalTrial: true },
    close: async () => { closed++; } };
  return { session, get closed() { return closed; } };
}
function request(body = { model: config.cowork.model, messages: [{ role: "user", content: "synthetic" }] }, options = {}) {
  return new Request(`http://127.0.0.1:18181${options.path || "/v1/messages"}`, {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...options.headers }, signal: options.signal
  });
}

test("persistent Cowork configuration is explicit, namespaced, and separate from GitHub defaults", async () => {
  let opened = 0;
  const service = createCoworkService({ openSession: async () => { opened++; } });
  assert.deepEqual(service.models({}), []);
  assert.deepEqual(await service.status({}), { provider: "cowork", configured: false, ready: false });
  const models = service.models(config);
  assert.equal(models[0].id, config.cowork.model);
  assert.equal(models[0].aerial.authentication, "unverified");
  assert.equal(opened, 0);
  assert.equal(coworkServiceConfiguration({ cowork: { ...config.cowork, effort: "max" } }).effort, "max");
  for (const change of [{ model: "opus" }, { model: "Cowork/opus" }, { profileDirectory: "relative" }, { effort: "ultra" }]) {
    assert.throws(() => coworkServiceConfiguration({ cowork: { ...config.cowork, ...change } }), { code: "COWORK_CONFIG_INVALID" });
  }
  await service.close();
});

test("authenticated catalog uses the active profile owner and reload switches only Cowork", async () => {
  let closed = 0, opened = 0;
  const service = createCoworkService({ openSession: async options => {
    opened++;
    return { ...fixture().session, model: options.model,
      catalog: [{ publicId: options.model, provider: "anthropic", supportedEfforts: [options.effort] }],
      capabilities: { clientEffort: options.effort, supportedEfforts: [options.effort] },
      close: async () => { closed++; } };
  } });
  assert.deepEqual(await service.catalog({}), { provider: "cowork", configured: false, models: [] });
  const catalog = await service.catalog(config);
  assert.equal(catalog.profileDirectory, config.cowork.profileDirectory);
  assert.equal(catalog.models[0].publicId, config.cowork.model);
  const updated = { cowork: { ...config.cowork, model: "cowork/claude-sonnet-test", effort: "max" } };
  const report = await service.reload(updated);
  assert.equal(report.model, updated.cowork.model); assert.equal(report.effort, "max");
  assert.equal(closed, 1); assert.equal(opened, 2);
  assert.equal((await service.status(updated)).model, updated.cowork.model);
  await service.close(); assert.equal(closed, 2);
});

test("reload cannot interrupt an unfinished streamed response", async () => {
  const f = fixture(); let stream;
  const service = createCoworkService({ openSession: async () => f.session,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })) });
  const response = await service.handle(request(), config);
  await assert.rejects(service.reload(config), { code: "COWORK_BUSY" });
  assert.equal(f.closed, 0);
  stream.close(); await response.text();
  await service.reload(config); assert.equal(f.closed, 1);
  await service.close();
});

test("shutdown during reload prevents a replacement session opening", async () => {
  const f = fixture(), gate = deferred(); let opened = 0;
  f.session.close = async () => gate.promise;
  const service = createCoworkService({ openSession: async () => { opened++; return f.session; } });
  await service.status(config);
  const reloading = service.reload(config);
  await new Promise(resolve => setImmediate(resolve));
  const closing = service.close();
  const rejected = assert.rejects(reloading, { code: "COWORK_SERVICE_CLOSED" });
  gate.resolve(); await Promise.all([closing, rejected]); assert.equal(opened, 1);
});

test("concurrent clients share one startup and one profile owner", async () => {
  const f = fixture(), gate = deferred();
  let opened = 0;
  const service = createCoworkService({ openSession: async options => {
    opened++; assert.equal(options.model, config.cowork.model); assert.equal(options.effort, "medium");
    assert.equal(options.directory, config.cowork.profileDirectory); await gate.promise; return f.session;
  } });
  const first = service.status(config), second = service.status(config);
  assert.equal(opened, 1);
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.equal(a.ready, true); assert.equal(a.cloudToolIsolation, "unverified");
  assert.equal(a.experimentalTrial, true); assert.equal(a.profileDirectory, config.cowork.profileDirectory);
  assert.equal(JSON.stringify(a).includes(f.session.apiKey), false);
  await service.close(); assert.equal(f.closed, 1);
});

test("failed startup can be retried without retaining a failed session", async () => {
  const f = fixture(); let opened = 0;
  const service = createCoworkService({ openSession: async () => { if (++opened === 1) throw new Error("synthetic auth failure"); return f.session; } });
  await assert.rejects(service.status(config), /synthetic auth failure/);
  assert.equal((await service.status(config)).ready, true); assert.equal(opened, 2);
  await service.close();
});

test("bridge preserves request semantics and replaces client credentials only for its private loopback hop", async () => {
  const f = fixture(); let calls = 0;
  const service = createCoworkService({ openSession: async () => f.session, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, "http://127.0.0.1:12345/v1/messages?beta=true");
    assert.equal(options.headers.get("authorization"), `Bearer ${f.session.apiKey}`);
    for (const key of ["x-api-key", "cookie", "host", "x-unrelated-secret"]) assert.equal(options.headers.has(key), false);
    assert.equal(options.headers.get("anthropic-beta"), "claude-code-20250219");
    assert.equal(options.headers.get("x-claude-code-session-id"), "synthetic-session");
    assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(new TextDecoder().decode(options.body)).model, config.cowork.model);
    return new Response("event: message_stop\ndata: {}\n\n", { headers: { "content-type": "text/event-stream", "x-cwg-usage-source": "estimated" } });
  } });
  const response = await service.handle(request(undefined, { path: "/v1/messages?beta=true", headers: {
    authorization: "Bearer synthetic-aerial-key", "x-api-key": "synthetic-aerial-key", cookie: "synthetic-cookie",
    "x-unrelated-secret": "synthetic-secret", "anthropic-beta": "claude-code-20250219", "x-claude-code-session-id": "synthetic-session"
  } }), config);
  assert.equal(response.status, 200); assert.equal(response.headers.get("x-cwg-usage-source"), "estimated");
  assert.match(await response.text(), /message_stop/); assert.equal(calls, 1);
  await service.close();
});

test("invalid requests, browser origins and token counting never open a Cowork session", async () => {
  let opened = 0;
  const service = createCoworkService({ openSession: async () => { opened++; throw new Error("unexpected startup"); } });
  for (const [req, status] of [
    [request(undefined, { headers: { origin: "https://example.test" } }), 403],
    [request({ model: "cowork/other" }), 400],
    [request(undefined, { path: "/v1/messages/count_tokens" }), 404],
    [request(undefined, { headers: { "content-type": "text/plain" } }), 400],
    [request({ model: config.cowork.model, extra: "a".repeat(4 * 1024 * 1024) }), 413]
  ]) assert.equal((await service.handle(req, config)).status, status);
  assert.equal(opened, 0); await service.close();
});

test("one aborted client does not cancel shared startup or another client", async () => {
  const f = fixture(), gate = deferred(), controller = new AbortController(); let lifetime;
  const service = createCoworkService({ openSession: async options => { lifetime = options.signal; await gate.promise; return f.session; } });
  const failed = service.handle(request(undefined, { signal: controller.signal }), config);
  await new Promise(resolve => setImmediate(resolve));
  const healthy = service.status(config);
  controller.abort(); assert.equal(lifetime.aborted, false); gate.resolve();
  await assert.rejects(failed, { name: "AbortError" }); assert.equal((await healthy).ready, true);
  await service.close(); assert.equal(lifetime.aborted, true);
});

test("shutdown during startup awaits resource cleanup and prevents new requests", async () => {
  const f = fixture(), gate = deferred(); let lifetime;
  const service = createCoworkService({ openSession: async options => { lifetime = options.signal; await gate.promise; return f.session; } });
  const starting = service.status(config);
  const rejected = assert.rejects(starting, { code: "COWORK_SERVICE_CLOSED" });
  const closing = service.close(); assert.strictEqual(service.close(), closing); assert.equal(lifetime.aborted, true);
  gate.resolve(); await Promise.all([closing, rejected]); assert.equal(f.closed, 1);
  await assert.rejects(service.status(config), { code: "COWORK_SERVICE_CLOSED" });
});

test("active configuration changes require restart rather than silently switching providers or profiles", async () => {
  const f = fixture(); const service = createCoworkService({ openSession: async () => f.session });
  await service.status(config);
  for (const change of [{ model: "cowork/another-opus" }, { profileDirectory: path.join(os.tmpdir(), "other-profile") }, { effort: "high" }]) {
    await assert.rejects(service.status({ cowork: { ...config.cowork, ...change } }), { code: "COWORK_RESTART_REQUIRED" });
  }
  assert.equal((await service.status(config)).ready, true); await service.close();
});

test("startup cleanup failures prevent shutdown from reporting a released profile", async () => {
  const f = fixture(), gate = deferred(), failure = new Error("synthetic lock cleanup failure");
  f.session.close = async () => { throw failure; };
  const service = createCoworkService({ openSession: async () => { await gate.promise; return f.session; } });
  const starting = service.status(config);
  const closing = service.close();
  const startupRejected = assert.rejects(starting, error => error === failure);
  const closeRejected = assert.rejects(closing, error => error === failure);
  gate.resolve();
  await Promise.all([startupRejected, closeRejected]);
  await assert.rejects(service.close(), error => error === failure);
});

test("lifecycle cleanup failure remains visible after startup has already failed", async () => {
  const failure = Object.assign(new Error("synthetic lifecycle cleanup failure"), { coworkCleanupFailed: true });
  let attempts = 0;
  const service = createCoworkService({ openSession: async () => { attempts++; throw failure; } });
  await assert.rejects(service.status(config), error => error === failure);
  await assert.rejects(service.status(config), error => error === failure);
  assert.equal(attempts, 1);
  await assert.rejects(service.close(), error => error === failure);
});
