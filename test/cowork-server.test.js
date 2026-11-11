import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { hashApiKey } from "../src/shared/crypto.js";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cowork-server-"));
delete process.env.AERIAL_GITHUB_TOKEN;
const { createServer } = await import("../src/proxy/server.js");
const { _resetCopilotTokenCacheForTests } = await import("../src/shared/auth.js");
const { CoworkError } = await import("../src/cowork/protocol.js");

const key = "synthetic-local-api-key";
const model = "cowork/claude-opus-synthetic";
const config = {
  apiKeyHash: hashApiKey(key),
  cowork: { model, profileDirectory: path.join(process.env.AERIAL_CONFIG_DIR, "private-profile"), effort: "medium" }
};
const configuredModel = { id: model, supported_endpoints: ["/v1/messages"], aerial: { routes: ["messages"] } };
const authorization = { authorization: `Bearer ${key}` };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, overrides = {}) {
  const calls = { models: 0, handle: 0, status: 0, close: 0 };
  const service = {
    models: async received => { assert.equal(received, config); calls.models++; return [configuredModel]; },
    handle: async (request, received) => {
      assert.equal(received, config);
      calls.handle++;
      return Response.json({ path: new URL(request.url).pathname, body: await request.json() }, { headers: { "x-synthetic-provider": "cowork" } });
    },
    status: async received => { assert.equal(received, config); calls.status++; return { provider: "cowork", configured: true, ready: true, model, effort: "medium" }; },
    close: async () => { calls.close++; },
    ...overrides
  };
  const server = createServer({ config, coworkService: service });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return { calls, service, server, baseUrl };
}

function post(baseUrl, route, body, headers = authorization, signal) {
  return fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
}

test.beforeEach(() => {
  delete process.env.AERIAL_GITHUB_TOKEN;
  _resetCopilotTokenCacheForTests();
});

test("Claude HEAD warmup is empty and anonymous without exposing other routes", async t => {
  const { baseUrl, calls } = await fixture(t);
  const response = await fetch(`${baseUrl}/api/hello`, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "0");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
  const browser = await fetch(`${baseUrl}/api/hello`, { method: "HEAD", headers: { origin: "https://untrusted.example" } });
  assert.equal(browser.status, 403);
  const differentMethod = await fetch(`${baseUrl}/api/hello`);
  assert.equal(differentMethod.status, 401);
  await differentMethod.body.cancel();
  const differentRoute = await fetch(`${baseUrl}/_aerial/cowork/status`, { method: "HEAD" });
  assert.equal(differentRoute.status, 401);
  assert.deepEqual(calls, { models: 0, handle: 0, status: 0, close: 0 });
});

test("Cowork inference and management reject missing local authentication before service access", async t => {
  const { baseUrl, calls } = await fixture(t);
  for (const route of ["/v1/messages", "/v1/messages/count_tokens", "/_aerial/cowork/close", "/_aerial/cowork/reload"]) {
    const response = await post(baseUrl, route, { model }, {});
    assert.equal(response.status, 401);
    await response.body.cancel();
  }
  for (const route of ["status", "catalog"]) {
    const response = await fetch(`${baseUrl}/_aerial/cowork/${route}`);
    assert.equal(response.status, 401);
    await response.body.cancel();
  }
  assert.deepEqual(calls, { models: 0, handle: 0, status: 0, close: 0 });
});

test("Cowork rejects browser Origin even with a valid local API key", async t => {
  const { baseUrl, calls } = await fixture(t);
  const headers = { ...authorization, origin: "https://untrusted.example" };
  for (const route of ["/v1/messages", "/v1/messages/count_tokens", "/v1/responses", "/_aerial/cowork/close", "/_aerial/cowork/reload"]) {
    const response = await post(baseUrl, route, { model }, headers);
    assert.equal(response.status, 403);
    await response.body.cancel();
  }
  for (const route of ["status", "catalog"]) {
    const response = await fetch(`${baseUrl}/_aerial/cowork/${route}`, { headers });
    assert.equal(response.status, 403);
    await response.body.cancel();
  }
  assert.deepEqual(calls, { models: 0, handle: 0, status: 0, close: 0 });
});

test("Cowork messages and token counts use the injected service with the original body", async t => {
  const { baseUrl, calls } = await fixture(t);
  const body = { model, messages: [{ role: "user", content: "synthetic request" }], output_config: { effort: "medium" } };
  for (const route of ["/v1/messages", "/v1/messages/count_tokens"]) {
    const response = await post(baseUrl, route, body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-synthetic-provider"), "cowork");
    assert.deepEqual(await response.json(), { path: route, body });
  }
  assert.equal(calls.handle, 2);
});

test("Cowork namespaced models cannot fall through to GitHub endpoints", async t => {
  const { baseUrl, calls } = await fixture(t);
  const originalFetch = globalThis.fetch;
  let remoteRequests = 0;
  globalThis.fetch = (url, init) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, init);
    remoteRequests++;
    throw new Error("Unexpected upstream request");
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const route of ["/v1/responses", "/v1/chat/completions", "/unsupported"]) {
    const response = await post(baseUrl, route, { model });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /Cowork models support only/);
  }
  const bomResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", ...authorization }, body: `\uFEFF${JSON.stringify({ model })}`
  });
  assert.equal(bomResponse.status, 400);
  assert.match((await bomResponse.json()).error.message, /Cowork models support only/);
  assert.equal(calls.handle, 0);
  assert.equal(remoteRequests, 0);
});

test("unprefixed GitHub token counts retain their original local route", async t => {
  const { baseUrl, calls } = await fixture(t);
  const response = await post(baseUrl, "/v1/messages/count_tokens", { model: "claude-opus-github", messages: [{ role: "user", content: "synthetic" }] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-aerial-token-count"), "estimate");
  assert.equal(typeof (await response.json()).input_tokens, "number");
  assert.equal(calls.handle, 0);
});

test("configured Cowork models remain public and explicitly unverified without GitHub login", async t => {
  const { baseUrl, calls } = await fixture(t);
  const response = await fetch(`${baseUrl}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, model);
  assert.equal(body.data[0].aerial.provider, "cowork");
  assert.equal(body.data[0].aerial.authentication, "unverified");
  assert.deepEqual(body.aerial.providers, { github: { status: "login_required" }, cowork: { status: "configured", authentication: "unverified" } });
  assert.doesNotMatch(JSON.stringify(body), /private-profile|synthetic-local-api-key/);
  assert.equal(calls.status, 0);
  assert.equal(calls.handle, 0);
});

function mockGitHub(t, catalog) {
  process.env.AERIAL_GITHUB_TOKEN = "synthetic-github-token";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return originalFetch(url, init);
    if (target.includes("copilot_internal")) return Promise.resolve(Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" }));
    return Promise.resolve().then(() => catalog(target, init));
  };
  t.after(() => { globalThis.fetch = originalFetch; delete process.env.AERIAL_GITHUB_TOKEN; });
}

test("unprefixed Messages and Responses models retain GitHub routing with Cowork configured", async t => {
  const upstreamRequests = [];
  mockGitHub(t, (target, init) => {
    if (target.endsWith("/models")) return Response.json({ data: [] });
    const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
    upstreamRequests.push({ target, body });
    return Response.json({ provider: "github", model: body.model });
  });
  const { baseUrl, calls } = await fixture(t);
  for (const [route, selectedModel] of [["/v1/messages", "github-messages-model"], ["/v1/responses", "github-responses-model"]]) {
    const response = await post(baseUrl, route, { model: selectedModel, messages: [{ role: "user", content: "synthetic" }], input: "synthetic" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { provider: "github", model: selectedModel });
  }
  assert.equal(upstreamRequests.length, 2);
  assert.equal(upstreamRequests[0].target.endsWith("/v1/messages"), true);
  assert.equal(upstreamRequests[1].target.endsWith("/responses"), true);
  assert.equal(calls.handle, 0);
});

test("model catalog combines GitHub and configured Cowork entries with provider metadata", async t => {
  mockGitHub(t, () => Response.json({ object: "list", data: [{ id: "github-model", supported_endpoints: ["/responses"] }] }));
  const { baseUrl } = await fixture(t);
  const response = await fetch(`${baseUrl}/v1/models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map(entry => entry.id), ["github-model", model]);
  assert.equal(body.data[0].aerial.provider, "github");
  assert.deepEqual(body.data[0].aerial.routes, ["responses"]);
  assert.equal(body.aerial.providers.github.status, "available");
  assert.equal(body.aerial.providers.cowork.authentication, "unverified");
});

for (const [failure, expected] of [[401, "upstream_auth_failed"], [403, "upstream_access_denied"], [503, "unavailable"], ["network", "unavailable"], ["invalid-json", "unavailable"]]) {
  test(`configured Cowork discovery survives GitHub catalog failure ${failure}`, async t => {
    mockGitHub(t, () => {
      if (failure === "network") throw new Error("synthetic-private-upstream-detail");
      if (failure === "invalid-json") return new Response("synthetic-private-upstream-detail", { headers: { "content-type": "application/json" } });
      return Response.json({ error: "synthetic-private-upstream-detail" }, { status: failure });
    });
    const { baseUrl, calls } = await fixture(t);
    const response = await fetch(`${baseUrl}/v1/models`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.map(entry => entry.id), [model]);
    assert.equal(body.aerial.providers.github.status, expected);
    assert.doesNotMatch(JSON.stringify(body), /synthetic-private-upstream-detail/);
    assert.equal(calls.status, 0);
    assert.equal(calls.handle, 0);
  });
}

test("authenticated Cowork status and close leave the main HTTP server running", async t => {
  const { baseUrl, calls } = await fixture(t);
  const status = await fetch(`${baseUrl}/_aerial/cowork/status`, { headers: authorization });
  assert.deepEqual(await status.json(), { provider: "cowork", configured: true, ready: true, model, effort: "medium" });
  const closed = await post(baseUrl, "/_aerial/cowork/close", {});
  assert.deepEqual(await closed.json(), { ok: true, provider: "cowork", closed: true });
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  await health.body.cancel();
  assert.equal(calls.status, 1);
  assert.equal(calls.close, 1);
});

test("authenticated catalog and Cowork reload leave GitHub and the HTTP listener available", async t => {
  let catalogCalls = 0, reloadCalls = 0;
  const { baseUrl } = await fixture(t, {
    catalog: async received => { assert.equal(received, config); catalogCalls++; return { provider: "cowork", models: [configuredModel] }; },
    reload: async received => { assert.equal(received, config); reloadCalls++; return { provider: "cowork", ready: true }; }
  });
  const catalog = await fetch(`${baseUrl}/_aerial/cowork/catalog`, { headers: authorization });
  assert.deepEqual((await catalog.json()).models, [configuredModel]);
  const reloaded = await post(baseUrl, "/_aerial/cowork/reload", {});
  assert.equal((await reloaded.json()).ready, true);
  const response = await post(baseUrl, "/v1/messages/count_tokens", { model: "github-model", messages: [{ role: "user", content: "synthetic" }] });
  assert.equal(response.status, 200); await response.body.cancel();
  assert.equal(catalogCalls, 1); assert.equal(reloadCalls, 1);
});

test("Cowork status preserves actionable error codes and the provider HTTP status", async t => {
  const { baseUrl } = await fixture(t, {
    status: async () => { throw new CoworkError("COWORK_RESTART_REQUIRED", "Restart Aerial to apply the selected Cowork configuration.", 503); }
  });
  const response = await fetch(`${baseUrl}/_aerial/cowork/status`, { headers: authorization });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, "COWORK_RESTART_REQUIRED");
  assert.match(body.error.message, /Restart Aerial/);
});

test("client disconnection aborts the Cowork service request", async t => {
  const entered = deferred(), aborted = deferred();
  const { baseUrl } = await fixture(t, {
    handle: async request => {
      entered.resolve();
      await new Promise(resolve => request.signal.addEventListener("abort", resolve, { once: true }));
      aborted.resolve();
      request.signal.throwIfAborted();
    }
  });
  const controller = new AbortController();
  const response = post(baseUrl, "/v1/messages", { model }, authorization, controller.signal);
  const rejected = assert.rejects(response, { name: "AbortError" });
  await entered.promise;
  controller.abort();
  await rejected;
  await aborted.promise;
});

test("server close waits for Cowork cleanup and rejects requests during shutdown", async t => {
  const closing = deferred(), released = deferred();
  let cleanupFinished = false;
  const { server, baseUrl, calls } = await fixture(t, {
    close: async () => { closing.resolve(); await released.promise; cleanupFinished = true; }
  });
  let closed = false;
  server.once("close", () => { assert.equal(cleanupFinished, true); closed = true; });
  const completed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await closing.promise;
  assert.equal(closed, false);
  const response = await post(baseUrl, "/v1/messages", { model });
  assert.equal(response.status, 503);
  await response.body.cancel();
  assert.equal(calls.handle, 0);
  released.resolve();
  await completed;
  assert.equal(closed, true);
});

test("server close reports Cowork cleanup failure while still closing its listener", async t => {
  const failure = Object.assign(new Error("synthetic cleanup failure"), { code: "COWORK_CLOSE_FAILED" });
  const server = createServer({ config, coworkService: { models: () => [], close: async () => { throw failure; } } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const error = await new Promise(resolve => server.close(resolve));
  assert.equal(error, failure);
  assert.equal(server.listening, false);
});
