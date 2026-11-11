import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeCoworkAuth, publicProbeFailure, saveProbeEvidence } from "../scripts/probe-cowork-auth.mjs";
import { createCoworkTransport } from "../src/cowork/transport.js";

const now = Date.parse("2026-11-11T00:00:00Z");
const candidate = {
  origin: "https://cowork.synthetic.invalid", clientId: "11111111-1111-4111-8111-111111111111",
  resourceId: "22222222-2222-4222-8222-222222222222", scope: "22222222-2222-4222-8222-222222222222/access_as_user"
};
const identity = { tenantId: "33333333-3333-4333-8333-333333333333", objectId: "44444444-4444-4444-8444-444444444444" };
const record = {
  authority: "login.microsoftonline.com", clientId: candidate.clientId, tenantId: identity.tenantId,
  homeAccountId: "synthetic-account-id", username: "fixture@example.test", version: "1.0"
};
const catalog = [{ id: "exact-opus-fixture", display_name: "Claude Opus synthetic", provider: "anthropic" }];
const unverified = { connectorsDisabled: "unverified", completion: "unverified", eventCorrelation: "unverified", verifiedEfforts: [] };
const token = (overrides = {}) => `fixture.${Buffer.from(JSON.stringify({
  aud: candidate.resourceId, azp: candidate.clientId, scp: "access_as_user", tid: identity.tenantId,
  oid: identity.objectId, exp: Math.floor(now / 1000) + 3600, ...overrides
})).toString("base64url")}.not-a-real-signature`;

function fixture(overrides = {}) {
  const calls = { runtime: 0, acquisitions: [], requests: [], saves: [] };
  const dependencies = {
    checkRuntime: () => { calls.runtime++; }, now: () => now,
    acquire: async options => { calls.acquisitions.push(options); return { bearer: token(), authenticationRecord: record }; },
    fetchImpl: async (url, init) => { calls.requests.push({ url, init }); return Response.json({ models: catalog }); },
    save: async evidence => { calls.saves.push(evidence); }, ...overrides
  };
  return { calls, dependencies };
}

test("auth probe performs one interactive WAM acquisition and one fixed-origin GET before saving metadata", async () => {
  const { calls, dependencies } = fixture();
  const report = await probeCoworkAuth(candidate, dependencies);
  assert.equal(calls.runtime, 1);
  assert.equal(calls.acquisitions.length, 1);
  assert.deepEqual(calls.acquisitions[0], {
    profile: { clientId: candidate.clientId, resourceId: candidate.resourceId, scope: candidate.scope, authorityHost: "https://login.microsoftonline.com" },
    tenantId: "organizations", interactive: true, signal: undefined
  });
  assert.equal(calls.requests.length, 1);
  const { url, init } = calls.requests[0];
  assert.equal(url, `${candidate.origin}/v1/models`);
  assert.equal(init.method, "GET");
  assert.equal(init.body, undefined);
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.authorization, `Bearer ${token()}`);
  assert.equal(init.headers["x-tenant-id"], identity.tenantId);
  assert.equal(init.headers["x-user-id"], identity.objectId);
  assert.equal(init.headers["x-container-config"], undefined);
  assert.equal(init.headers.accept, "application/json");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(calls.saves.length, 1);
  assert.equal(report.ok, true);
  assert.equal(report.catalogAccepted, true);
  assert.equal(report.inferenceReady, false);
  assert.deepEqual(report.models, [{ upstreamId: catalog[0].id, displayName: catalog[0].display_name, provider: catalog[0].provider }]);
  assert.deepEqual(calls.saves[0].profile.capabilities, unverified);
  assert.deepEqual(calls.saves[0].profile.evidence, { source: "authorized-session", observedAt: new Date(now).toISOString() });
  assert.deepEqual(calls.saves[0].account.identity, identity);
  assert.equal(calls.saves[0].profile.tenantId, identity.tenantId);
  assert.equal(JSON.stringify({ report, saved: calls.saves }).includes(token()), false);
});

test("candidate credentials, capabilities and persistence paths cannot enter WAM or saved evidence", async () => {
  const imported = {
    ...candidate, authorityHost: "https://unrelated.invalid", bearer: "SYNTHETIC_DO_NOT_SAVE",
    accountFile: "SYNTHETIC_DO_NOT_SAVE", evidence: { source: "authorized-session", token: "SYNTHETIC_DO_NOT_SAVE" },
    capabilities: { connectorsDisabled: "verified", completion: "fr-plus-rl-ok", eventCorrelation: "verified", verifiedEfforts: ["max"] }
  };
  const before = structuredClone(imported);
  const { calls, dependencies } = fixture({
    acquire: async options => {
      calls.acquisitions.push(options);
      return { bearer: token(), refreshToken: "SYNTHETIC_DO_NOT_SAVE", authenticationRecord: { ...record, accessToken: "SYNTHETIC_DO_NOT_SAVE" } };
    },
    fetchImpl: async (url, init) => {
      calls.requests.push({ url, init });
      return Response.json({ models: catalog.map(model => ({ ...model, accessToken: "SYNTHETIC_DO_NOT_SAVE" })), token: "SYNTHETIC_DO_NOT_SAVE" });
    }
  });
  const report = await probeCoworkAuth(imported, dependencies);
  assert.deepEqual(imported, before, "Successful discovery must not mutate the supplied candidate");
  assert.equal(calls.acquisitions[0].profile.authorityHost, "https://login.microsoftonline.com");
  assert.equal(JSON.stringify({ acquisition: calls.acquisitions, saved: calls.saves, report }).includes("SYNTHETIC_DO_NOT_SAVE"), false);
  assert.deepEqual(calls.saves[0].profile.capabilities, unverified);
  const transport = createCoworkTransport({
    profile: calls.saves[0].profile, route: { upstreamId: catalog[0].id },
    auth: { getToken: () => assert.fail("Unverified probe evidence cannot authenticate inference") },
    fetchImpl: () => assert.fail("Unverified probe evidence cannot submit inference")
  });
  await assert.rejects(transport.execute({ prompt: "not allowed" }), { code: "PROTOCOL_UNVERIFIED" });
});

test("invalid candidate profiles and unsupported runtimes fail before WAM or network access", async () => {
  for (const patch of [
    { origin: "http://cowork.synthetic.invalid" }, { origin: "https://user:password@cowork.synthetic.invalid" },
    { origin: `${candidate.origin}/extra` }, { scope: "other-scope" }, { clientId: "invalid" }
  ]) {
    const { calls, dependencies } = fixture();
    await assert.rejects(probeCoworkAuth({ ...candidate, ...patch }, dependencies), { code: "INVALID_PROFILE" });
    assert.equal(calls.acquisitions.length, 0);
    assert.equal(calls.requests.length, 0);
    assert.equal(calls.saves.length, 0);
  }
  const { calls, dependencies } = fixture({ checkRuntime: () => { throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED_PLATFORM" }); } });
  await assert.rejects(probeCoworkAuth(candidate, dependencies), { code: "UNSUPPORTED_PLATFORM" });
  assert.equal(calls.acquisitions.length, 0);
  assert.equal(calls.requests.length, 0);
});

test("token audience, client, scope, expiry and resource identity are checked before the directory request", async () => {
  for (const patch of [
    { aud: candidate.clientId }, { azp: candidate.resourceId }, { azp: undefined, appid: candidate.resourceId },
    { scp: "access_as_user_extra" }, { exp: Math.floor(now / 1000) - 1 },
    { exp: Math.floor(now / 1000) + 30 }, { oid: "invalid" }, { tid: "invalid" }
  ]) {
    const { calls, dependencies } = fixture({ acquire: async options => { calls.acquisitions.push(options); return { bearer: token(patch), authenticationRecord: record }; } });
    await assert.rejects(probeCoworkAuth(candidate, dependencies), { code: "AUTH_INVALID_TOKEN" });
    assert.equal(calls.acquisitions.length, 1);
    assert.equal(calls.requests.length, 0);
    assert.equal(calls.saves.length, 0);
  }
  const { calls, dependencies } = fixture();
  await assert.rejects(probeCoworkAuth({ ...candidate, tenantId: candidate.clientId }, dependencies), { code: "ACCOUNT_CHANGED" });
  assert.equal(calls.requests.length, 0);
  assert.equal(calls.saves.length, 0);
});

test("account record mismatch is rejected without sending the otherwise valid token", async () => {
  const { calls, dependencies } = fixture({ acquire: async options => {
    calls.acquisitions.push(options);
    return { bearer: token(), authenticationRecord: { ...record, tenantId: candidate.clientId } };
  } });
  await assert.rejects(probeCoworkAuth(candidate, dependencies), { code: "AUTH_INVALID_RECORD" });
  assert.equal(calls.acquisitions.length, 1);
  assert.equal(calls.requests.length, 0);
  assert.equal(calls.saves.length, 0);
});

test("WAM rejections are not retried and never promote or persist a candidate", async () => {
  for (const code of ["AUTH_DENIED", "AUTH_REQUIRED", "AUTH_HELPER_FAILED"]) {
    const input = structuredClone(candidate);
    const { calls, dependencies } = fixture({ acquire: async options => {
      calls.acquisitions.push(options);
      throw Object.assign(new Error("AADSTS65002 synthetic private SDK message"), { code });
    } });
    await assert.rejects(probeCoworkAuth(input, dependencies), { code });
    assert.deepEqual(input, candidate);
    assert.equal(calls.acquisitions.length, 1);
    assert.equal(calls.requests.length, 0);
    assert.equal(calls.saves.length, 0);
  }
});

test("HTTP denial, throttling, redirect and server errors never retry or save evidence", async () => {
  for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "AUTH_DENIED"], [429, "UPSTREAM_REJECTED"], [302, "UPSTREAM_REJECTED"], [500, "UPSTREAM_REJECTED"]]) {
    let canceled = 0;
    const { calls, dependencies } = fixture({ fetchImpl: async (url, init) => {
      calls.requests.push({ url, init });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("synthetic private server body")); }, cancel() { canceled++; } }), { status });
    } });
    const failure = await probeCoworkAuth(candidate, dependencies).then(() => assert.fail("Probe must fail"), error => error);
    assert.equal(failure.code, code);
    assert.equal(calls.acquisitions.length, 1);
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.requests[0].init.redirect, "error");
    assert.equal(calls.saves.length, 0);
    assert.equal(canceled, 1);
    assert.equal(JSON.stringify(publicProbeFailure(failure)).includes("private"), false);
  }
});

test("network failures expose no fetch details and do not retry WAM or directory requests", async () => {
  const { calls, dependencies } = fixture({ fetchImpl: async (url, init) => {
    calls.requests.push({ url, init });
    throw new TypeError(`synthetic private connection detail ${token()}`);
  } });
  const failure = await probeCoworkAuth(candidate, dependencies).then(() => assert.fail("Probe must fail"), error => error);
  assert.equal(failure.code, "UPSTREAM_UNAVAILABLE");
  assert.equal(failure.message.includes("private"), false);
  assert.equal(calls.acquisitions.length, 1);
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.saves.length, 0);
});

test("malformed, empty and duplicate directories cannot produce authorized evidence", async () => {
  for (const [response, code] of [
    [() => new Response("not-json"), "PROTOCOL_CHANGED"],
    [() => new Response(new Uint8Array([0xff, 0xfe])), "PROTOCOL_CHANGED"],
    [() => Response.json({ data: catalog }), "PROTOCOL_CHANGED"],
    [() => Response.json({ models: [] }), "MODEL_UNAVAILABLE"],
    [() => Response.json({ models: [catalog[0], catalog[0]] }), "PROTOCOL_CHANGED"],
    [() => Response.json({ models: [{ ...catalog[0], id: "model;inject=other" }] }), "PROTOCOL_CHANGED"]
  ]) {
    const { calls, dependencies } = fixture({ fetchImpl: async (url, init) => { calls.requests.push({ url, init }); return response(); } });
    await assert.rejects(probeCoworkAuth(candidate, dependencies), { code });
    assert.equal(calls.acquisitions.length, 1);
    assert.equal(calls.requests.length, 1);
    assert.equal(calls.saves.length, 0);
  }
});

test("oversized directory responses are canceled at the bounded-read limit", async () => {
  let canceled = 0;
  const { calls, dependencies } = fixture({ fetchImpl: async (url, init) => {
    calls.requests.push({ url, init });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
      cancel() { canceled++; }
    }));
  } });
  await assert.rejects(probeCoworkAuth(candidate, dependencies), error => error.code === "PROTOCOL_CHANGED" && /size limit/.test(error.message));
  assert.equal(canceled, 1);
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.saves.length, 0);
});

test("cancellation before or immediately after WAM prevents directory access and persistence", async () => {
  for (const beforeAcquire of [true, false]) {
    const controller = new AbortController();
    if (beforeAcquire) controller.abort();
    const { calls, dependencies } = fixture({ signal: controller.signal, acquire: async options => {
      calls.acquisitions.push(options);
      controller.abort();
      return { bearer: token(), authenticationRecord: record };
    } });
    await assert.rejects(probeCoworkAuth(candidate, dependencies), { name: "AbortError" });
    assert.equal(calls.acquisitions.length, beforeAcquire ? 0 : 1);
    assert.equal(calls.requests.length, 0);
    assert.equal(calls.saves.length, 0);
  }
});

test("cancellation during a stalled directory body releases its reader and cannot save partial evidence", async () => {
  const controller = new AbortController();
  let canceled = 0;
  const { calls, dependencies } = fixture({ signal: controller.signal, fetchImpl: async (url, init) => {
    calls.requests.push({ url, init });
    return new Response(new ReadableStream({ cancel() { canceled++; } }));
  } });
  const pending = probeCoworkAuth(candidate, dependencies);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.saves.length, 0);
  controller.abort();
  await rejected;
  assert.equal(canceled, 1);
  assert.equal(calls.requests[0].init.signal.aborted, true);
  assert.equal(calls.saves.length, 0);
});

test("save failures never return success or repeat authentication and network work", async () => {
  const { calls, dependencies } = fixture({ save: async evidence => {
    calls.saves.push(evidence);
    throw new Error("synthetic private filesystem detail");
  } });
  const failure = await probeCoworkAuth(candidate, dependencies).then(() => assert.fail("Probe must not return success"), error => error);
  assert.equal(calls.acquisitions.length, 1);
  assert.equal(calls.requests.length, 1);
  assert.equal(calls.saves.length, 1);
  assert.deepEqual(publicProbeFailure(failure), { ok: false, code: "PROBE_FAILED", inferenceReady: false });
});

test("public failures contain only an allowed code, optional AADSTS number and false readiness", () => {
  const failure = Object.assign(new Error(`AADSTS65002 account=private-user bearer=${token()}`), {
    code: "AUTH_DENIED", details: { bearer: token() }, cause: new Error("private stack")
  });
  assert.deepEqual(publicProbeFailure(failure), { ok: false, code: "AUTH_DENIED", aadsts: "AADSTS65002", inferenceReady: false });
  assert.deepEqual(publicProbeFailure({ code: token(), message: "private server response" }), { ok: false, code: "PROBE_FAILED", inferenceReady: false });
  for (const name of ["AbortError", "TimeoutError"]) assert.deepEqual(publicProbeFailure(new DOMException("private cancellation reason", name)), { ok: false, code: "CANCELED_OR_TIMED_OUT", inferenceReady: false });
});

test("saving successful probe evidence creates a new private directory with no bearer and cannot overwrite it", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-auth-probe-save-"));
  const directory = path.join(parent, "evidence");
  const { calls, dependencies } = fixture({ save: evidence => { calls.saves.push(evidence); saveProbeEvidence(directory, evidence); } });
  try {
    const report = await probeCoworkAuth(candidate, dependencies);
    assert.equal(report.inferenceReady, false);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["account.json", "auth-evidence.json", "profile.json"]);
    const originals = Object.fromEntries(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name), "utf8")]));
    assert.equal(JSON.stringify(originals).includes(token()), false);
    assert.equal(Object.keys(JSON.parse(originals["account.json"])).includes("bearer"), false);
    assert.deepEqual(JSON.parse(originals["profile.json"]).capabilities, unverified);
    assert.equal(JSON.parse(originals["auth-evidence.json"]).inferenceReady, false);
    assert.throws(() => saveProbeEvidence(directory, calls.saves[0]), { code: "EEXIST" });
    for (const [name, content] of Object.entries(originals)) assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), content);
    if (process.platform !== "win32") assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  } finally {
    for (const name of ["account.json", "auth-evidence.json", "profile.json"]) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    if (fs.existsSync(directory)) fs.rmdirSync(directory);
    fs.rmdirSync(parent);
  }
});
