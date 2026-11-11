import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { acquireProfileLock, configureCowork, inspectCowork, openCoworkSession, publicModels, selectCoworkModel, listCoworkOperations, releaseCoworkOperation, CLAUDE_BETAS } from "../src/cowork/index.js";
import { createOperationStore } from "../src/cowork/operations.js";

const profile = {
  version: 1, origin: "https://cowork.example.test", authorityHost: "https://login.microsoftonline.com",
  clientId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222",
  scope: "22222222-2222-4222-8222-222222222222/access_as_user", tenantId: "organizations",
  evidence: { source: "authorized-session", observedAt: "2026-11-11T00:00:00Z" },
  capabilities: { connectorsDisabled: "verified", completion: "fr-plus-rl-ok", eventCorrelation: "verified", verifiedEfforts: ["high", "low"],
    verifiedModelEfforts: { "opus-exact": ["high", "low"] } }
};
const identity = { tenantId: "33333333-3333-4333-8333-333333333333", objectId: "44444444-4444-4444-8444-444444444444" };
const catalog = [
  { upstreamId: "opus-exact", displayName: "Claude Opus synthetic", provider: "Anthropic" },
  { upstreamId: "other-opus", displayName: "Claude Opus other", provider: "Anthropic" },
  { upstreamId: "fable", displayName: "Claude Fable", provider: "Anthropic" }
].map(model => ({ ...model, supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" }));
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cowork-lifecycle-"));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

function injected(options = {}) {
  const calls = [];
  let gatewayOptions;
  let locked = false;
  const auth = { getToken: async ({ signal } = {}) => { calls.push("token"); return { bearer: "synthetic-not-a-token", identity: options.identity || identity }; }, close: () => { calls.push("auth-close"); } };
  const gateway = { stats: { requests: 0 }, listen: async port => { assert.equal(port, 0); calls.push("listen"); return "http://127.0.0.1:12345"; }, close: async () => { calls.push("gateway-close"); } };
  const execute = async () => { throw new Error("Lifecycle tests must not invoke inference."); };
  const dependencies = {
    checkRuntime: () => { calls.push("runtime"); },
    readProfile: () => { calls.push("profile"); return structuredClone(options.profile || profile); },
    acquireLock: () => { assert.equal(locked, false); locked = true; calls.push("lock"); return () => { assert.equal(locked, true); locked = false; calls.push("release"); }; },
    authFactory: value => { assert.deepEqual(value.profile, options.profile || profile); calls.push("auth"); return auth; },
    transportFactory: ({ auth: actual, route }) => {
      assert.equal(actual, auth);
      calls.push(route ? `transport:${route.upstreamId}` : "catalog-transport");
      return route ? { execute } : { models: async () => { calls.push("models"); return options.catalog || catalog; } };
    },
    ensureDirectory: directory => { calls.push("private-directory"); assert.equal(path.isAbsolute(directory), true); },
    gatewayFactory: value => { calls.push("gateway"); gatewayOptions = value; return gateway; }
  };
  return { calls, auth, gateway, dependencies, execute, get gatewayOptions() { return gatewayOptions; }, get locked() { return locked; } };
}

test("Cowork configuration persists only the protocol allowlist and removes imported credentials", () => {
  const directory = temp(), source = path.join(temp(), "import.json");
  fs.writeFileSync(source, JSON.stringify({ ...profile, bearer: "DO_NOT_PERSIST", accountFile: "C:\\unrelated\\account.json",
    evidence: { ...profile.evidence, headers: { authorization: "DO_NOT_PERSIST" } },
    capabilities: { ...profile.capabilities, token: "DO_NOT_PERSIST" } }));
  const result = configureCowork({ file: source, directory });
  assert.equal(result.inferenceReady, true);
  const raw = fs.readFileSync(result.profileFile, "utf8");
  assert.equal(raw.includes("DO_NOT_PERSIST"), false);
  assert.equal(raw.includes("unrelated"), false);
  assert.deepEqual(JSON.parse(raw), profile);
  assert.equal(fs.existsSync(path.join(directory, "profile.lock")), false);
});

test("Cowork configuration rejects changed origin/client/resource and preserves old state and lock usability", () => {
  const directory = temp(), source = path.join(temp(), "import.json");
  fs.writeFileSync(source, JSON.stringify(profile));
  const { profileFile } = configureCowork({ file: source, directory });
  const original = fs.readFileSync(profileFile, "utf8");
  for (const change of [{ origin: "https://different.example.test" }, { clientId: "55555555-5555-4555-8555-555555555555" }, { resourceId: "66666666-6666-4666-8666-666666666666", scope: "66666666-6666-4666-8666-666666666666/access_as_user" }]) {
    fs.writeFileSync(source, JSON.stringify({ ...profile, ...change }));
    assert.throws(() => configureCowork({ file: source, directory }), { code: "PROFILE_CHANGED" });
    assert.equal(fs.readFileSync(profileFile, "utf8"), original);
    assert.equal(fs.existsSync(path.join(directory, "profile.lock")), false);
  }
  fs.writeFileSync(profileFile, "malformed");
  fs.writeFileSync(source, JSON.stringify(profile));
  assert.throws(() => configureCowork({ file: source, directory }), { code: "PROFILE_REQUIRED" });
  assert.equal(fs.existsSync(path.join(directory, "profile.lock")), false);
});

test("Cowork refuses reference-only configuration without creating a profile", () => {
  const directory = temp(), source = path.join(temp(), "import.json");
  fs.writeFileSync(source, JSON.stringify({ ...profile, evidence: { ...profile.evidence, source: "reference-only" } }));
  assert.throws(() => configureCowork({ file: source, directory }), { code: "PROTOCOL_UNVERIFIED" });
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("Cowork profile lock rejects competing and stale owners and only removes its own nonce", () => {
  const directory = temp();
  const file = path.join(directory, "profile.lock");
  const release = acquireProfileLock(directory);
  const original = fs.readFileSync(file, "utf8");
  assert.throws(() => acquireProfileLock(directory), { code: "PROFILE_IN_USE" });
  assert.equal(fs.readFileSync(file, "utf8"), original);
  release(); release();
  assert.equal(fs.existsSync(file), false);
  const foreign = { pid: 2147483647, nonce: "foreign", startedAt: "2000-01-01T00:00:00Z" };
  fs.writeFileSync(file, JSON.stringify(foreign));
  assert.throws(() => acquireProfileLock(directory), { code: "PROFILE_IN_USE" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), foreign);
  fs.unlinkSync(file);
  const releaseReplacement = acquireProfileLock(directory);
  fs.writeFileSync(file, JSON.stringify(foreign));
  assert.throws(releaseReplacement, { code: "PROFILE_LOCK_CHANGED" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), foreign);
});

test("Cowork selects only an exact uniquely available Anthropic route or its public alias without fallback", () => {
  const models = publicModels(catalog);
  assert.strictEqual(selectCoworkModel(models, catalog[0].upstreamId), models[0]);
  assert.strictEqual(selectCoworkModel(models, models[0].publicId), models[0]);
  assert.match(models[0].publicId, /^cowork\/claude-opus-synthetic-[a-f0-9]{8}$/);
  assert.deepEqual(publicModels(catalog), models);
  for (const selected of [undefined, "opus", "missing"]) assert.throws(() => selectCoworkModel(models, selected), { code: selected ? "MODEL_UNAVAILABLE" : "MODEL_REQUIRED" });
  assert.strictEqual(selectCoworkModel(models, "fable"), models[2]);
  assert.throws(() => selectCoworkModel([...models, models[0]], models[0].publicId), { code: "MODEL_UNAVAILABLE" });
  assert.throws(() => selectCoworkModel([{ publicId: "cowork/opus", upstreamId: "x", displayName: "Opus", provider: "unrelated" }], "x"), { code: "MODEL_UNSUPPORTED" });
});

test("Cowork opens raw upstream selections as public routes with verified effort and identity-specific storage", async () => {
  const fixture = injected();
  const directory = temp();
  const session = await openCoworkSession({ model: catalog[0].upstreamId, directory }, fixture.dependencies);
  assert.equal(session.model, publicModels(catalog)[0].publicId);
  assert.equal(session.route.upstreamId, catalog[0].upstreamId);
  assert.equal(session.baseUrl, "http://127.0.0.1:12345");
  assert.ok(session.apiKey.length >= 32);
  assert.strictEqual(fixture.gatewayOptions.execute, fixture.execute);
  assert.deepEqual(fixture.gatewayOptions.capabilities.allowedBetas, [...CLAUDE_BETAS]);
  assert.equal(fixture.gatewayOptions.capabilities.clientEffort, "high");
  assert.equal(fixture.gatewayOptions.capabilities.thinkingMode, "disabled");
  assert.equal(fixture.gatewayOptions.capabilities.cloudToolIsolation, "verified");
  assert.equal(fixture.gatewayOptions.capabilities.experimentalTrial, false);
  assert.equal(fixture.gatewayOptions.operationDirectory, path.join(directory, "operations", createHash("sha256").update(JSON.stringify(identity)).digest("hex")));
  assert.equal(fixture.locked, true);
  await session.close();
  assert.deepEqual(fixture.calls.slice(-3), ["gateway-close", "auth-close", "release"]);
  assert.equal(fixture.locked, false);
  const other = injected({ identity: { ...identity, objectId: "55555555-5555-4555-8555-555555555555" } });
  const second = await openCoworkSession({ model: session.model, directory }, other.dependencies);
  assert.notEqual(other.gatewayOptions.operationDirectory, fixture.gatewayOptions.operationDirectory);
  await second.close();
});

test("Cowork sessions apply an explicitly selected verified effort and reject unverified levels", async () => {
  const fixture = injected();
  const session = await openCoworkSession({ model: "opus-exact", effort: "high", directory: temp() }, fixture.dependencies);
  assert.equal(session.capabilities.clientEffort, "high");
  await session.close();
  for (const effort of ["medium", "max", "ultra"]) {
    const invalid = injected();
    await assert.rejects(openCoworkSession({ model: "opus-exact", effort, directory: temp() }, invalid.dependencies), { code: "UNSUPPORTED_CAPABILITY" });
    assert.equal(invalid.locked, false);
    assert.equal(invalid.calls.includes("gateway"), false);
  }
});

test("Cowork cleanup releases the profile after auth, catalog, model, effort, token, directory and listen failures", async () => {
  for (const stage of ["auth", "catalog", "model", "effort", "token", "directory", "gateway", "listen"]) {
    const fixture = injected(stage === "effort" ? { profile: { ...profile, capabilities: { ...profile.capabilities, verifiedEfforts: [], verifiedModelEfforts: {} } } } : {});
    const failure = new Error(`synthetic ${stage} failure`);
    if (stage === "auth") fixture.dependencies.authFactory = () => { throw failure; };
    if (stage === "catalog") fixture.dependencies.transportFactory = () => ({ models: async () => { throw failure; } });
    if (stage === "token") fixture.auth.getToken = async () => { throw Object.assign(failure, { code: "ACCOUNT_CHANGED" }); };
    if (stage === "directory") fixture.dependencies.ensureDirectory = () => { throw failure; };
    if (stage === "gateway") fixture.dependencies.gatewayFactory = () => { throw failure; };
    if (stage === "listen") fixture.gateway.listen = async () => { throw failure; };
    await assert.rejects(openCoworkSession({ model: stage === "model" ? "missing" : "opus-exact", directory: temp() }, fixture.dependencies));
    assert.equal(fixture.locked, false, `${stage} leaked the profile lock`);
    assert.equal(fixture.calls.filter(call => call === "release").length, 1);
    if (stage !== "auth") assert.ok(fixture.calls.includes("auth-close"), `${stage} leaked auth`);
    if (stage === "listen") assert.ok(fixture.calls.includes("gateway-close"));
  }
});

test("Cowork reads and validates the profile only while holding its exclusive lock", async () => {
  const fixture = injected();
  fixture.dependencies.readProfile = () => {
    assert.equal(fixture.locked, true, "Profile read preceded exclusive lock acquisition");
    return structuredClone(profile);
  };
  const session = await openCoworkSession({ model: "opus-exact", directory: temp() }, fixture.dependencies);
  await session.close();
});

test("Cowork concurrent close callers wait for the same complete cleanup", async () => {
  const fixture = injected();
  const blocked = deferred();
  fixture.gateway.close = async () => { fixture.calls.push("gateway-close"); await blocked.promise; };
  const session = await openCoworkSession({ model: "opus-exact", directory: temp() }, fixture.dependencies);
  const first = session.close();
  let secondFinished = false;
  const second = session.close().then(() => { secondFinished = true; });
  await new Promise(resolve => setImmediate(resolve));
  const finishedPrematurely = secondFinished;
  blocked.resolve();
  await Promise.all([first, second]);
  assert.equal(finishedPrematurely, false, "Second close returned before cleanup completed");
  assert.equal(fixture.calls.filter(call => call === "release").length, 1);
});

test("Cowork cancellation during silent auth cannot create or return a gateway", async () => {
  const fixture = injected(), controller = new AbortController();
  fixture.auth.getToken = async () => { controller.abort(new Error("synthetic cancellation")); return { identity, bearer: "synthetic" }; };
  let session;
  try {
    await assert.rejects(async () => { session = await openCoworkSession({ model: "opus-exact", directory: temp(), signal: controller.signal }, fixture.dependencies); }, /synthetic cancellation/);
  } finally { await session?.close(); }
  assert.equal(fixture.calls.includes("gateway"), false);
  assert.equal(fixture.locked, false);
});

test("Cowork waits for asynchronous auth cleanup before releasing profile ownership", async () => {
  const fixture = injected(), blocked = deferred();
  fixture.auth.close = async () => { fixture.calls.push("auth-close-start"); await blocked.promise; fixture.calls.push("auth-close-finish"); };
  const session = await openCoworkSession({ model: "opus-exact", directory: temp() }, fixture.dependencies);
  const closing = session.close();
  await new Promise(resolve => setImmediate(resolve));
  const releasedPrematurely = !fixture.locked;
  blocked.resolve(); await closing;
  assert.equal(releasedPrematurely, false, "Profile lock released while old authentication was still active");
  assert.deepEqual(fixture.calls.slice(-3), ["auth-close-start", "auth-close-finish", "release"]);
});

test("Cowork pre-aborted startup does not acquire a lock and invalid profiles release their lock", async () => {
  const canceled = injected(), controller = new AbortController();
  controller.abort(new Error("synthetic pre-cancel"));
  await assert.rejects(openCoworkSession({ model: "opus-exact", signal: controller.signal }, canceled.dependencies), /synthetic pre-cancel/);
  assert.equal(canceled.calls.includes("lock"), false);
  const invalid = injected({ profile: { ...profile, capabilities: {} } });
  await assert.rejects(openCoworkSession({ model: "opus-exact" }, invalid.dependencies), { code: "PROTOCOL_UNVERIFIED" });
  assert.equal(invalid.locked, false);
  assert.equal(invalid.calls.includes("auth"), false);
});

test("Cowork treats identity casing as the same storage namespace", async () => {
  const lower = { tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", objectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const upper = { objectId: lower.objectId.toUpperCase(), tenantId: lower.tenantId.toUpperCase() };
  const first = injected({ identity: lower }), second = injected({ identity: upper });
  const directory = temp();
  await (await openCoworkSession({ model: "opus-exact", directory }, first.dependencies)).close();
  await (await openCoworkSession({ model: "opus-exact", directory }, second.dependencies)).close();
  assert.equal(first.gatewayOptions.operationDirectory, second.gatewayOptions.operationDirectory);
});

test("Cowork operations listing and explicit release keep unknown attempts isolated and preserve the profile lock", () => {
  const directory = temp();
  const operationDirectory = path.join(directory, "operations", "a".repeat(64));
  const route = publicModels(catalog)[0];
  const store = createOperationStore({ directory: operationDirectory, route });
  const body = { model: route.publicId, max_tokens: 32, messages: [{ role: "user", content: "synthetic private text" }] };
  const { record } = store.claim({ body });
  store.phase(record, "SUBMITTING");
  const records = listCoworkOperations({ directory });
  assert.equal(records.length, 1);
  assert.equal(records[0].phase, "UNKNOWN");
  assert.equal(records[0].remoteState, "unknown");
  assert.equal(JSON.stringify(records).includes("synthetic private text"), false);
  assert.equal(fs.existsSync(path.join(directory, "profile.lock")), false);
  assert.deepEqual(releaseCoworkOperation({ id: record.id, directory }), { ok: true, id: record.id });
  assert.ok(JSON.parse(fs.readFileSync(path.join(operationDirectory, "operations.json"), "utf8")).records[0].releasedAt);
  assert.throws(() => releaseCoworkOperation({ id: "../../not-an-operation", directory }), { code: "INVALID_REQUEST" });
  const release = acquireProfileLock(directory);
  try { assert.throws(() => listCoworkOperations({ directory }), { code: "PROFILE_IN_USE" }); }
  finally { release(); }
});

test("Cowork configuration reports missing verified client effort as not inference-ready", () => {
  const directory = temp(), source = path.join(temp(), "import.json");
  fs.writeFileSync(source, JSON.stringify({ ...profile, capabilities: { ...profile.capabilities, verifiedEfforts: [], verifiedModelEfforts: {} } }));
  assert.equal(configureCowork({ file: source, directory }).inferenceReady, false);
  assert.equal(fs.existsSync(path.join(directory, "profile.lock")), false);
});

test("Cowork configuration requires explicit trial selection and ordinary imports restore strict policy", () => {
  const directory = temp(), source = path.join(temp(), "import.json");
  const unverified = { ...profile, capabilities: { ...profile.capabilities, connectorsDisabled: "unverified" },
    localTrial: { allowUnverifiedCloudTools: true } };
  fs.writeFileSync(source, JSON.stringify(unverified));
  const strict = configureCowork({ file: source, directory });
  assert.equal(strict.inferenceReady, false);
  assert.equal(strict.cloudToolIsolation, "unverified");
  assert.equal(strict.experimentalTrial, false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(strict.profileFile, "utf8")), "localTrial"), false);
  assert.throws(() => configureCowork({ file: source, directory, allowUnverifiedCloudTools: "true" }), { code: "INVALID_PROFILE" });

  const experimental = configureCowork({ file: source, directory, allowUnverifiedCloudTools: true });
  assert.equal(experimental.inferenceReady, true);
  assert.equal(experimental.cloudToolIsolation, "unverified");
  assert.equal(experimental.experimentalTrial, true);
  const saved = JSON.parse(fs.readFileSync(experimental.profileFile, "utf8"));
  assert.deepEqual(saved.localTrial, { allowUnverifiedCloudTools: true });
  assert.deepEqual(saved.capabilities, unverified.capabilities);
  assert.deepEqual(saved.evidence, unverified.evidence);

  const restored = configureCowork({ file: experimental.profileFile, directory });
  assert.equal(restored.inferenceReady, false);
  assert.equal(restored.experimentalTrial, false);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(restored.profileFile, "utf8")), "localTrial"), false);
  assert.equal(fs.existsSync(path.join(directory, "profile.lock")), false);
});

test("Cowork experimental sessions expose unverified isolation and retain client-effort requirements", async () => {
  const unverified = { ...profile, capabilities: { ...profile.capabilities, connectorsDisabled: "unverified" } };
  const strict = injected({ profile: unverified });
  await assert.rejects(openCoworkSession({ model: "opus-exact", directory: temp() }, strict.dependencies), { code: "PROTOCOL_UNVERIFIED" });
  assert.equal(strict.calls.includes("auth"), false);
  const trial = { ...unverified, localTrial: { allowUnverifiedCloudTools: true } };
  const experimental = injected({ profile: trial });
  const session = await openCoworkSession({ model: "opus-exact", directory: temp() }, experimental.dependencies);
  try {
    assert.equal(session.capabilities.cloudToolIsolation, "unverified");
    assert.equal(session.capabilities.experimentalTrial, true);
    assert.equal(session.capabilities.clientEffort, "high");
    assert.equal(trial.capabilities.connectorsDisabled, "unverified");
  } finally { await session.close(); }
  for (const verifiedEfforts of [[]]) {
    const unsupported = injected({ profile: { ...trial, capabilities: { ...trial.capabilities, verifiedEfforts, verifiedModelEfforts: {} } } });
    await assert.rejects(openCoworkSession({ model: "opus-exact", directory: temp() }, unsupported.dependencies), { code: "UNSUPPORTED_CAPABILITY" });
    assert.equal(unsupported.calls.includes("gateway"), false);
    assert.equal(unsupported.locked, false);
  }
});

test("Cowork doctor distinguishes strict, experimental, and unready profiles without promoting evidence", async () => {
  const unverified = { ...profile, capabilities: { ...profile.capabilities, connectorsDisabled: "unverified" } };
  const trial = { ...unverified, localTrial: { allowUnverifiedCloudTools: true } };
  for (const [candidate, expectedStatus, expectedReady, experimentalTrial, cloudToolIsolation] of [
    [profile, "ready", true, false, "verified"],
    [unverified, "protocol_unverified", false, false, "unverified"],
    [trial, "ready_experimental", true, true, "unverified"],
    [{ ...trial, capabilities: { ...trial.capabilities, completion: "unverified" } }, "protocol_unverified", false, true, "unverified"],
    [{ ...trial, capabilities: { ...trial.capabilities, verifiedEfforts: [], verifiedModelEfforts: {} } }, "protocol_unverified", false, true, "unverified"],
    [{ ...profile, localTrial: { allowUnverifiedCloudTools: true } }, "ready", true, false, "verified"]
  ]) {
    const before = structuredClone(candidate), fixture = injected({ profile: candidate });
    const report = await inspectCowork({ directory: temp() }, fixture.dependencies);
    assert.equal(report.status, expectedStatus);
    assert.equal(report.ok, expectedReady);
    assert.equal(report.inferenceReady, expectedReady);
    assert.equal(report.experimentalTrial, experimentalTrial);
    assert.equal(report.cloudToolIsolation, cloudToolIsolation);
    assert.equal(report.authentication, "verified");
    assert.equal(report.catalog, "verified");
    assert.deepEqual(candidate, before);
    assert.equal(fixture.locked, false);
    assert.deepEqual(fixture.calls.slice(-2), ["auth-close", "release"]);
    assert.equal(fixture.calls.includes("gateway"), false);
  }
});
