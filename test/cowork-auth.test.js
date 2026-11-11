import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { authenticate, createAuthSession, runWamHelper, sanitizeAccountMetadata, tokenLease } from "../src/cowork/auth.js";
import { requireCoworkRuntime, validateProfile } from "../src/cowork/profile.js";

const profile = {
  version: 1, origin: "https://cowork.example.test", authorityHost: "https://login.microsoftonline.com",
  clientId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222",
  scope: "22222222-2222-4222-8222-222222222222/access_as_user",
  evidence: { source: "authorized-session", observedAt: "2026-11-11T00:00:00Z" }, capabilities: {}
};
const identity = { tenantId: "33333333-3333-4333-8333-333333333333", objectId: "44444444-4444-4444-8444-444444444444" };
const record = { authority: "login.microsoftonline.com", homeAccountId: "opaque-account-id", clientId: profile.clientId,
  tenantId: identity.tenantId, username: "fixture@example.test", version: "1.0" };
const account = { version: 1, clientId: profile.clientId, resourceId: profile.resourceId, identity, authenticationRecord: record };
const fakeToken = (overrides = {}, now = Date.now()) => `fixture.${Buffer.from(JSON.stringify({ aud: profile.resourceId,
  azp: profile.clientId, scp: "access_as_user", tid: identity.tenantId, oid: identity.objectId,
  exp: Math.floor(now / 1000) + 3600, ...overrides })).toString("base64url")}.not-a-real-signature`;

test("Cowork profile has no implicit origin or authentication identifiers", () => {
  assert.throws(() => validateProfile({ version: 1 }), { code: "INVALID_PROFILE" });
  for (const origin of ["http://cowork.example.test", "https://user:password@cowork.example.test", "https://cowork.example.test/path", "https://cowork.example.test?token=secret"]) {
    assert.throws(() => validateProfile({ ...profile, origin }), { code: "INVALID_PROFILE" });
  }
  assert.throws(() => createAuthSession({ profile: { ...profile, evidence: { ...profile.evidence, source: "reference-only" } } }), { code: "PROTOCOL_UNVERIFIED" });
  assert.throws(() => validateProfile(profile, { requireLive: true }), { code: "PROTOCOL_UNVERIFIED" });
  assert.throws(() => requireCoworkRuntime({ platform: "linux", nodeVersion: "24.1.0" }), { code: "UNSUPPORTED_PLATFORM" });
  assert.throws(() => requireCoworkRuntime({ platform: "win32", nodeVersion: "22.1.0" }), { code: "UNSUPPORTED_RUNTIME" });
});

test("WAM token validation checks resource, client, scope, expiry and resource identity", () => {
  assert.deepEqual(tokenLease(fakeToken(), profile).identity, identity);
  for (const patch of [{ aud: profile.clientId }, { azp: profile.resourceId }, { scp: "other" }, { exp: 1 }, { oid: "missing" }]) {
    assert.throws(() => tokenLease(fakeToken(patch), profile), { code: "AUTH_INVALID_TOKEN" });
  }
  assert.throws(() => tokenLease(fakeToken(), profile, { expectedIdentity: { ...identity, objectId: profile.clientId } }), { code: "ACCOUNT_CHANGED" });
  assert.throws(() => tokenLease("secret-broken-token", profile), (error) => error.code === "AUTH_INVALID_TOKEN" && !error.message.includes("secret"));
});

test("saved account metadata strips credentials and preserves actual resource identity", () => {
  const saved = sanitizeAccountMetadata({ ...account, accessToken: "secret", authenticationRecord: { ...record, refreshToken: "secret" } }, profile);
  assert.equal(JSON.stringify(saved).includes("secret"), false);
  assert.deepEqual(saved.identity, identity);
  assert.equal(saved.authenticationRecord.homeAccountId, "opaque-account-id");
  assert.throws(() => sanitizeAccountMetadata({ ...account, identity: { ...identity, tenantId: profile.clientId } }, profile), { code: "AUTH_INVALID_RECORD" });
});

test("silent sessions without a selected identity fail without invoking WAM", async () => {
  let acquisitions = 0;
  const session = createAuthSession({ profile, readAccount: async () => undefined, acquire: async () => { acquisitions++; } });
  await assert.rejects(session.getToken(), { code: "AUTH_REQUIRED" });
  assert.equal(acquisitions, 0);
  await session.close();
});

test("authentication explicitly enables interaction and returns no bearer", async () => {
  let options;
  let persisted;
  const result = await authenticate(profile, { interactive: true, readAccount: async () => { throw new Error("Explicit authentication must not depend on old account metadata."); },
    acquire: async (value) => { options = value; return { bearer: fakeToken(), authenticationRecord: record }; },
    writeAccount: async (_profile, value) => { persisted = value; }
  });
  assert.equal(options.interactive, true);
  assert.equal(options.authenticationRecord, undefined);
  assert.deepEqual(result.identity, identity);
  assert.equal(Object.hasOwn(result, "bearer"), false);
  assert.deepEqual(persisted.identity, identity);
});

test("concurrent requests share one silent WAM acquisition and refresh pins identity", async () => {
  let now = Date.now();
  let acquisitions = 0;
  let wrongAccount = false;
  const session = createAuthSession({ profile, now: () => now, readAccount: async () => account,
    acquire: async (options) => {
      acquisitions++;
      assert.equal(options.interactive, false);
      assert.deepEqual(options.authenticationRecord, record);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { bearer: fakeToken(wrongAccount ? { oid: profile.clientId } : {}, now), authenticationRecord: record };
    }, writeAccount: async () => {}
  });
  const [first, second] = await Promise.all([session.getToken(), session.getToken()]);
  assert.equal(first.bearer, second.bearer);
  assert.equal(acquisitions, 1);
  now += 3590_000;
  wrongAccount = true;
  await assert.rejects(session.getToken(), { code: "ACCOUNT_CHANGED" });
  assert.equal(acquisitions, 2);
  await session.close();
  await assert.rejects(session.getToken(), { name: "AbortError" });
});

test("canceling one caller does not cancel another caller's shared authentication", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const session = createAuthSession({ profile, readAccount: async () => account,
    acquire: async () => { await gate; return { bearer: fakeToken(), authenticationRecord: record }; }, writeAccount: async () => {}
  });
  const controller = new AbortController();
  const canceled = session.getToken({ signal: controller.signal });
  const continued = session.getToken();
  controller.abort();
  await assert.rejects(canceled, { name: "AbortError" });
  release();
  assert.deepEqual((await continued).identity, identity);
  await session.close();
});

test("WAM helper communicates through private IPC and is reaped before returning", async () => {
  let spawnOptions;
  let killed = false;
  const spawnChild = (_file, args, options) => {
    assert.deepEqual(args, []);
    spawnOptions = options;
    const child = new EventEmitter();
    child.pid = 123;
    child.send = () => queueMicrotask(() => child.emit("message", { type: "token", bearer: "private-token", authenticationRecord: record }));
    child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", 0)); };
    return child;
  };
  const result = await runWamHelper({ interactive: false }, { spawnChild, platform: "win32", nodeVersion: "24.1.0" });
  assert.equal(result.bearer, "private-token");
  assert.equal(killed, true);
  assert.equal(spawnOptions.windowsHide, true);
  assert.deepEqual(spawnOptions.stdio, ["ignore", "ignore", "ignore", "ipc"]);
});

test("WAM helper timeout kills the owned process without exposing diagnostics", async () => {
  let killed = false;
  const spawnChild = () => {
    const child = new EventEmitter();
    child.pid = 123;
    child.send = () => {};
    child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", 1)); };
    return child;
  };
  await assert.rejects(runWamHelper({ interactive: false }, { spawnChild, timeoutMs: 5, platform: "win32", nodeVersion: "24.1.0" }), { code: "AUTH_REQUIRED" });
  assert.equal(killed, true);
});

test("closing an auth session waits for its pending helper and prevents a late account write", async () => {
  let finishHelper;
  let signal;
  let writes = 0;
  const helperDone = new Promise((resolve) => { finishHelper = resolve; });
  const session = createAuthSession({ profile, readAccount: async () => account,
    acquire: async (options) => { signal = options.signal; await helperDone; return { bearer: fakeToken(), authenticationRecord: record }; },
    writeAccount: async () => { writes++; }
  });
  const tokenResult = session.getToken();
  const tokenAssertion = assert.rejects(tokenResult, { name: "AbortError" });
  await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = session.close();
  assert.equal(session.close(), closing);
  closing.then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  finishHelper();
  await closing;
  await tokenAssertion;
  assert.equal(writes, 0);
  assert.equal(closed, true);
});
