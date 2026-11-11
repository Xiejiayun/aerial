import test from "node:test";
import assert from "node:assert/strict";
import { coworkError, validateProfile } from "../src/cowork/profile.js";
import { createCoworkTransport } from "../src/cowork/transport.js";

const profile = {
  version: 1, origin: "https://cowork.example.test", authorityHost: "https://login.microsoftonline.com",
  clientId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222",
  scope: "22222222-2222-4222-8222-222222222222/access_as_user",
  evidence: { source: "authorized-session", observedAt: "2026-11-11T00:00:00Z" },
  capabilities: { connectorsDisabled: "unverified", completion: "fr-plus-rl-ok", eventCorrelation: "verified", verifiedEfforts: ["medium"],
    verifiedModelEfforts: { "opus-exact": ["medium"] } }
};
const trial = { ...profile, localTrial: { allowUnverifiedCloudTools: true } };

test("Cowork local trials are opt-in and never promote isolation evidence", () => {
  for (const localTrial of [undefined, { allowUnverifiedCloudTools: false }]) {
    assert.throws(() => validateProfile({ ...profile, localTrial }, { requireLive: true }), { code: "PROTOCOL_UNVERIFIED" });
  }
  const before = structuredClone(trial);
  const accepted = validateProfile(trial, { requireLive: true });
  assert.equal(accepted.capabilities.connectorsDisabled, "unverified");
  assert.deepEqual(accepted.localTrial, { allowUnverifiedCloudTools: true });
  assert.deepEqual(trial, before);
});

test("Cowork local trial schema rejects implicit, malformed and unknown options", () => {
  const inherited = Object.assign(Object.create({ allowUnverifiedCloudTools: true }), { unrelated: true });
  for (const localTrial of [null, true, "true", [], {}, { allowUnverifiedCloudTools: "true" },
    { allowUnverifiedCloudTools: 1 }, { allowUnverifiedCloudTools: true, skipAuthentication: true }, inherited]) {
    assert.throws(() => validateProfile({ ...profile, localTrial }), { code: "INVALID_PROFILE" });
  }
});

test("Cowork local trial exempts isolation only, preserving evidence and profile validation", () => {
  for (const patch of [
    { evidence: { ...profile.evidence, source: "reference-only" } },
    { evidence: { ...profile.evidence, source: "synthetic-test" } },
    { capabilities: { ...profile.capabilities, completion: "unverified" } },
    { capabilities: { ...profile.capabilities, eventCorrelation: "unverified" } }
  ]) assert.throws(() => validateProfile({ ...trial, ...patch }, { requireLive: true }), { code: "PROTOCOL_UNVERIFIED" });
  for (const patch of [
    { scope: "unrelated/access_as_user" },
    { origin: "http://cowork.example.test" },
    { capabilities: { ...profile.capabilities, verifiedEfforts: ["unsupported"] } }
  ]) assert.throws(() => validateProfile({ ...trial, ...patch }, { requireLive: true }), { code: "INVALID_PROFILE" });
});

test("production transport observes the trial policy while preserving effort and auth boundaries", async () => {
  let acquisitions = 0, requests = 0;
  const auth = { getToken: async () => { acquisitions++; throw coworkError("AUTH_REQUIRED", "Synthetic auth boundary; no token request.", { statusCode: 401 }); } };
  const dependencies = { auth, route: { upstreamId: "opus-exact", displayName: "Claude Opus", provider: "anthropic", supportedEfforts: ["medium", "high"] }, fetchImpl: async () => { requests++; throw new Error("This test must never submit a request."); } };
  const strict = createCoworkTransport({ ...dependencies, profile });
  await assert.rejects(strict.execute({ prompt: "synthetic", effort: "medium" }), { code: "PROTOCOL_UNVERIFIED" });
  assert.equal(acquisitions, 0);
  const experimental = createCoworkTransport({ ...dependencies, profile: trial });
  await assert.rejects(experimental.execute({ prompt: "synthetic", effort: "high" }), { code: "UNSUPPORTED_CAPABILITY" });
  assert.equal(acquisitions, 0);
  await assert.rejects(experimental.execute({ prompt: "synthetic", effort: "medium" }), { code: "AUTH_REQUIRED" });
  assert.equal(acquisitions, 1);
  assert.equal(requests, 0);
  assert.equal(trial.capabilities.connectorsDisabled, "unverified");
});
