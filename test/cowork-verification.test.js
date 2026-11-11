import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyCoworkRoute, configureCowork } from "../src/cowork/index.js";
import { coworkError } from "../src/cowork/profile.js";
import { writePrivateJson } from "../src/cowork/private-files.js";

const profile = {
  version: 1, origin: "https://cowork.example.test", authorityHost: "https://login.microsoftonline.com",
  clientId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222",
  scope: "22222222-2222-4222-8222-222222222222/access_as_user",
  evidence: { source: "authorized-session", observedAt: "2026-11-11T00:00:00Z" },
  capabilities: { connectorsDisabled: "unverified", completion: "fr-plus-rl-ok", eventCorrelation: "verified", verifiedEfforts: ["medium"],
    verifiedModelConversationReuse: { "opus-fixture": true } },
  localTrial: { allowUnverifiedCloudTools: true }
};
const identity = { tenantId: "33333333-3333-4333-8333-333333333333", objectId: "44444444-4444-4444-8444-444444444444" };
const catalog = [{ upstreamId: "sonnet-fixture", displayName: "Claude Sonnet", provider: "anthropic", supportedEfforts: ["low", "medium", "high", "max"], defaultEffort: "medium" }];

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-route-verification-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profileFile = path.join(directory, "profile.json");
  fs.writeFileSync(profileFile, JSON.stringify(options.profile || profile));
  const before = fs.readFileSync(profileFile, "utf8");
  let locked = false, calls = 0, closed = 0;
  const dependencies = {
    checkRuntime: () => {},
    acquireLock: () => {
      if (locked) throw coworkError("PROFILE_IN_USE", "Synthetic profile is already locked.");
      locked = true;
      return () => { locked = false; };
    },
    authFactory: () => ({ getToken: async () => ({ bearer: "synthetic-private-token", identity }),
      close: async () => { closed++; if (options.closeError) throw options.closeError; } }),
    ensureDirectory: target => { fs.mkdirSync(target, { recursive: true }); return target; },
    transportFactory: ({ route }) => !route ? { models: async () => options.catalog || catalog } : {
      investigateText: async invocation => {
        calls++;
        assert.equal(locked, true);
        assert.equal(invocation.prompt, undefined, "Only the transport's fixed diagnostic prompt may be used");
        await invocation.onPhase("SUBSCRIBING");
        await invocation.onPhase("SUBMITTING", { conversationId: "synthetic-private-conversation", messageId: "synthetic-private-message" });
        if (options.error) throw options.error;
        await options.gate;
        await invocation.onPhase("ACCEPTED");
        await invocation.onPhase("RESULT_RECEIVED");
        return { expectedTextMatched: true, requestedEffort: invocation.effort, completionEvidence: "fr-plus-rl-ok",
          correlationEvidence: "request-mid", submissionEvidence: { httpStatus: 202 },
          conversationId: "synthetic-private-conversation", messageId: "synthetic-private-message", bearer: "synthetic-private-token",
          ...options.result };
      }
    }
  };
  return { directory, profileFile, before, dependencies, get locked() { return locked; }, get calls() { return calls; }, get closed() { return closed; },
    evidenceFiles: () => fs.readdirSync(directory).filter(name => name.startsWith("route-verification-")) };
}

test("successful route verification records only the selected model-effort and sanitized private evidence", async t => {
  const f = fixture(t);
  const report = await verifyCoworkRoute({ model: "sonnet-fixture", effort: "max", directory: f.directory }, f.dependencies);
  assert.equal(report.ok, true);
  assert.equal(report.accepted, true);
  assert.equal(report.expectedTextMatched, true);
  assert.equal(report.capabilityRecorded, true);
  assert.equal(report.upstreamModel, "sonnet-fixture");
  assert.equal(report.effort, "max");
  assert.equal(path.isAbsolute(report.evidenceFile), true);
  const saved = JSON.parse(fs.readFileSync(f.profileFile, "utf8"));
  assert.deepEqual(saved.capabilities.verifiedModelEfforts, { "sonnet-fixture": ["max"] });
  assert.deepEqual(saved.capabilities.verifiedEfforts, profile.capabilities.verifiedEfforts);
  assert.deepEqual(saved.capabilities.verifiedModelConversationReuse, profile.capabilities.verifiedModelConversationReuse);
  assert.equal(saved.capabilities.connectorsDisabled, "unverified");
  assert.deepEqual(saved.localTrial, profile.localTrial);
  const evidence = fs.readFileSync(report.evidenceFile, "utf8");
  assert.doesNotMatch(evidence, /synthetic-private|conversationId|messageId|tenantId|objectId|account|bearer/);
  assert.doesNotMatch(fs.readFileSync(f.profileFile, "utf8"), /synthetic-private/);
  assert.equal(JSON.parse(evidence).accepted, true);
  assert.equal(f.calls, 1);
  assert.equal(f.closed, 1);
  assert.equal(f.locked, false);
});

test("verification preserves other model effort records and persists them through configure", async t => {
  const f = fixture(t, { profile: { ...profile, capabilities: { ...profile.capabilities, verifiedModelEfforts: { "fable-fixture": ["medium"], "sonnet-fixture": ["low"] } } } });
  const result = await verifyCoworkRoute({ model: "sonnet-fixture", effort: "high", directory: f.directory }, f.dependencies);
  assert.equal(result.ok, true);
  const configured = configureCowork({ file: f.profileFile, directory: f.directory, allowUnverifiedCloudTools: true });
  assert.equal(configured.inferenceReady, true);
  const saved = JSON.parse(fs.readFileSync(f.profileFile, "utf8"));
  assert.deepEqual(saved.capabilities.verifiedModelEfforts, { "fable-fixture": ["medium"], "sonnet-fixture": ["low", "high"] });
  assert.deepEqual(saved.capabilities.verifiedModelConversationReuse, { "opus-fixture": true });
});

test("unadvertised efforts and misleading model providers cannot submit verification", async t => {
  for (const options of [{ effort: "xhigh" }, { effort: "medium", catalog: [{ ...catalog[0], provider: "OpenAI", displayName: "Claude Sonnet" }] },
    { effort: "medium", catalog: [{ ...catalog[0], supportedEfforts: undefined }] }]) {
    const f = fixture(t, options);
    const result = await verifyCoworkRoute({ model: "sonnet-fixture", effort: options.effort, directory: f.directory }, f.dependencies);
    assert.equal(result.ok, false);
    assert.equal(f.calls, 0);
    assert.equal(fs.readFileSync(f.profileFile, "utf8"), f.before);
    assert.deepEqual(f.evidenceFiles(), []);
    assert.equal(f.locked, false);
  }
});

test("text, completion, acceptance and correlation must all pass before capability commit", async t => {
  for (const result of [{ expectedTextMatched: false }, { requestedEffort: "low" }, { completionEvidence: "unknown" },
    { correlationEvidence: "missing" }, { submissionEvidence: { httpStatus: 200 } }]) {
    const f = fixture(t, { result });
    const report = await verifyCoworkRoute({ model: "sonnet-fixture", effort: "high", directory: f.directory }, f.dependencies);
    assert.equal(report.ok, false);
    assert.equal(report.accepted, false);
    assert.equal(report.code, "ROUTE_VERIFICATION_FAILED");
    assert.equal(f.calls, 1);
    assert.equal(fs.readFileSync(f.profileFile, "utf8"), f.before);
    assert.deepEqual(f.evidenceFiles(), []);
  }
});

test("unknown verification submissions are not retried on a repeated call", async t => {
  const f = fixture(t, { error: coworkError("SUBMISSION_UNKNOWN", "Synthetic unknown submission.", { submitted: true }) });
  const first = await verifyCoworkRoute({ model: "sonnet-fixture", effort: "medium", directory: f.directory }, f.dependencies);
  const second = await verifyCoworkRoute({ model: "sonnet-fixture", effort: "medium", directory: f.directory }, f.dependencies);
  assert.equal(first.code, "SUBMISSION_UNKNOWN");
  assert.equal(second.code, "SUBMISSION_UNKNOWN");
  assert.equal(second.operationId, first.operationId);
  assert.equal(f.calls, 1);
  assert.equal(fs.readFileSync(f.profileFile, "utf8"), f.before);
  assert.deepEqual(f.evidenceFiles(), []);
});

test("completed or reused verification operations never submit the fixed request again", async t => {
  const f = fixture(t);
  const first = await verifyCoworkRoute({ model: "sonnet-fixture", effort: "high", directory: f.directory }, f.dependencies);
  assert.equal(first.accepted, true);
  const committed = fs.readFileSync(f.profileFile, "utf8");
  const second = await verifyCoworkRoute({ model: "sonnet-fixture", effort: "high", directory: f.directory }, f.dependencies);
  assert.equal(second.ok, false);
  assert.equal(second.code, "RESULT_UNAVAILABLE");
  assert.equal(f.calls, 1);
  assert.equal(fs.readFileSync(f.profileFile, "utf8"), committed);
  assert.equal(f.evidenceFiles().length, 1);

  const cached = fixture(t);
  cached.dependencies.operationStoreFactory = () => ({ claim: () => ({ reused: true, record: { id: "synthetic-completed-operation" }, message: { accepted: true } }) });
  const reused = await verifyCoworkRoute({ model: "sonnet-fixture", effort: "high", directory: cached.directory }, cached.dependencies);
  assert.equal(reused.code, "ROUTE_ALREADY_VERIFIED");
  assert.equal(reused.operationId, "synthetic-completed-operation");
  assert.equal(cached.calls, 0);
  assert.equal(fs.readFileSync(cached.profileFile, "utf8"), cached.before);
});

test("authentication cleanup and profile persistence failures leave capabilities unchanged", async t => {
  for (const stage of ["auth-close", "evidence", "profile"]) {
    const f = fixture(t, stage === "auth-close" ? { closeError: new Error("Synthetic cleanup failure.") } : {});
    if (stage !== "auth-close") f.dependencies.writeJson = (file, value) => {
      if (stage === "evidence" || path.basename(file) === "profile.json") throw new Error("Synthetic persistence failure.");
      return writePrivateJson(file, value);
    };
    const report = await verifyCoworkRoute({ model: "sonnet-fixture", effort: "high", directory: f.directory }, f.dependencies);
    assert.equal(report.ok, false);
    assert.equal(report.capabilityRecorded, false);
    assert.equal(fs.readFileSync(f.profileFile, "utf8"), f.before);
    assert.deepEqual(f.evidenceFiles(), []);
    assert.equal(f.closed, 1);
    assert.equal(f.locked, false);
  }
});

test("verification holds the profile lock until its fixed request and commit finish", async t => {
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const f = fixture(t, { gate });
  const verifying = verifyCoworkRoute({ model: "sonnet-fixture", effort: "medium", directory: f.directory }, f.dependencies);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.locked, true);
  await assert.rejects(verifyCoworkRoute({ model: "sonnet-fixture", effort: "high", directory: f.directory }, f.dependencies), { code: "PROFILE_IN_USE" });
  releaseGate();
  assert.equal((await verifying).ok, true);
  assert.equal(f.locked, false);
});

test("verification requires explicit model and effort before touching profile or authentication", async () => {
  const dependencies = { checkRuntime: () => { throw new Error("Should not reach runtime"); } };
  for (const options of [{ model: "sonnet-fixture" }, { effort: "medium" }, { model: "sonnet-fixture", effort: "ultra" }]) {
    await assert.rejects(verifyCoworkRoute(options, dependencies), error => ["INVALID_REQUEST", "UNSUPPORTED_CAPABILITY"].includes(error.code));
  }
});
