import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { isSupportedCoworkModel, modelVerifiedEfforts, modelSupportedEfforts, selectCoworkEffort, validateProfile } from "../src/cowork/profile.js";
import { openCoworkSession, publicModels, selectCoworkModel } from "../src/cowork/index.js";
import { createCoworkTransport } from "../src/cowork/transport.js";

const profile = {
  version: 1, origin: "https://cowork.example.test", authorityHost: "https://login.microsoftonline.com",
  clientId: "11111111-1111-4111-8111-111111111111", resourceId: "22222222-2222-4222-8222-222222222222",
  scope: "22222222-2222-4222-8222-222222222222/access_as_user",
  evidence: { source: "authorized-session", observedAt: "2026-11-11T00:00:00Z" },
  capabilities: { connectorsDisabled: "verified", completion: "fr-plus-rl-ok", eventCorrelation: "verified", verifiedEfforts: ["medium", "high"] }
};
const identity = { tenantId: "33333333-3333-4333-8333-333333333333", objectId: "44444444-4444-4444-8444-444444444444" };
const routes = ["Opus", "Sonnet", "Fable"].map(name => ({ upstreamId: `${name.toLowerCase()}-fixture`, displayName: `Claude ${name}`, provider: "anthropic",
  supportedEfforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" }));
routes[0].upstreamId = "opus-5.5";

test("catalog discovery preserves the actual snake-case effort capabilities under normalized names", async () => {
  const transport = createCoworkTransport({ profile, auth: { getToken: async () => ({ bearer: "synthetic", identity }) }, fetchImpl: async () => Response.json({
    models: [{ id: "sonnet-fixture", display_name: "Claude Sonnet", provider: "anthropic",
      supported_effort_levels: ["low", "medium", "high", "max"], default_effort_level: "high" }]
  }) });
  assert.deepEqual(await transport.models(), [{ upstreamId: "sonnet-fixture", displayName: "Claude Sonnet", provider: "anthropic",
    supportedEfforts: ["low", "medium", "high", "max"], defaultEffort: "high" }]);
});

test("malformed catalog effort metadata fails instead of inventing support", async () => {
  for (const fields of [{ supported_effort_levels: "high" }, { supported_effort_levels: ["high;model=other"] },
    { supported_effort_levels: ["low"], default_effort_level: "high" }, { default_effort_level: "medium" }]) {
    const transport = createCoworkTransport({ profile, auth: { getToken: async () => ({ bearer: "synthetic", identity }) }, fetchImpl: async () => Response.json({
      models: [{ id: "sonnet-fixture", display_name: "Claude Sonnet", provider: "anthropic", ...fields }]
    }) });
    await assert.rejects(transport.models(), { code: "PROTOCOL_CHANGED" });
  }
});

test("only exact Anthropic or Claude provider entries can select Opus, Sonnet or Fable", () => {
  const catalog = publicModels(routes);
  for (const route of catalog) assert.strictEqual(selectCoworkModel(catalog, route.upstreamId), route);
  for (const provider of ["OpenAI", "unrelated", "NotAnthropic", "OpenAI Claude"]) {
    const spoofed = { ...catalog[0], provider, displayName: "Claude Opus" };
    assert.equal(isSupportedCoworkModel(spoofed), false);
    assert.throws(() => selectCoworkModel([spoofed], spoofed.publicId), { code: "MODEL_UNSUPPORTED" });
  }
  assert.equal(isSupportedCoworkModel({ upstreamId: "gpt-fixture", displayName: "GPT", provider: "openai" }), false);
  assert.throws(() => selectCoworkModel(catalog, "sonnet"), { code: "MODEL_UNAVAILABLE" });
  assert.throws(() => selectCoworkModel([...catalog, catalog[1]], catalog[1].publicId), { code: "MODEL_UNAVAILABLE" });
});

test("legacy effort evidence applies only to the observed Anthropic Opus 5.5 route", () => {
  assert.deepEqual(modelVerifiedEfforts(profile, routes[0]), ["medium", "high"]);
  assert.deepEqual(modelVerifiedEfforts(profile, { ...routes[0], upstreamId: "opus-new-version" }), []);
  assert.deepEqual(modelVerifiedEfforts(profile, { ...routes[0], provider: "claude" }), []);
  assert.deepEqual(modelVerifiedEfforts(profile, routes[1]), []);
  assert.deepEqual(modelVerifiedEfforts(profile, routes[2]), []);
  const scoped = { ...profile, capabilities: { ...profile.capabilities, verifiedModelEfforts: { "opus-5.5": [], "sonnet-fixture": ["low", "max"] } } };
  assert.deepEqual(modelVerifiedEfforts(scoped, routes[0]), []);
  assert.deepEqual(modelSupportedEfforts(scoped, routes[1]), ["low", "max"]);
  assert.deepEqual(modelSupportedEfforts(scoped, { ...routes[1], upstreamId: "sonnet-new" }), []);
  assert.deepEqual(modelSupportedEfforts(scoped, { ...routes[1], supportedEfforts: ["medium", "max"] }), ["max"]);
  assert.deepEqual(modelSupportedEfforts(profile, { ...routes[0], supportedEfforts: undefined }), []);
});

test("effort selection honors explicit and catalog defaults within the verified intersection, including max", () => {
  const scoped = { ...profile, capabilities: { ...profile.capabilities, verifiedModelEfforts: { "sonnet-fixture": ["low", "high", "max"] } } };
  const route = { ...routes[1], defaultEffort: "high" };
  assert.equal(selectCoworkEffort(scoped, route), "high");
  assert.equal(selectCoworkEffort(scoped, route, "low"), "low");
  assert.equal(selectCoworkEffort(scoped, route, "max"), "max");
  assert.equal(selectCoworkEffort(scoped, { ...route, supportedEfforts: ["max"], defaultEffort: "max" }), "max");
  for (const effort of ["medium", "ultra", "HIGH"]) assert.throws(() => selectCoworkEffort(scoped, route, effort), { code: "UNSUPPORTED_CAPABILITY" });
});

test("profile model capability maps reject malformed entries and are copied independently", () => {
  for (const verifiedModelEfforts of [null, [], { "bad;model=other": ["medium"] }, { model: "medium" }, { model: ["ultra"] }, { model: ["low", "low"] },
    JSON.parse('{"__proto__":["medium"]}'), Object.create({ inherited: ["medium"] })]) {
    assert.throws(() => validateProfile({ ...profile, capabilities: { ...profile.capabilities, verifiedModelEfforts } }), { code: "INVALID_PROFILE" });
  }
  for (const verifiedModelConversationReuse of [null, [], { "sonnet-fixture": false }, { "sonnet-fixture": "true" }]) {
    assert.throws(() => validateProfile({ ...profile, capabilities: { ...profile.capabilities, verifiedModelConversationReuse } }), { code: "INVALID_PROFILE" });
  }
  const source = { ...profile, capabilities: { ...profile.capabilities, verifiedModelEfforts: { "sonnet-fixture": ["max"] }, verifiedModelConversationReuse: { "opus-fixture": true } } };
  const copy = validateProfile(source);
  copy.capabilities.verifiedModelEfforts["sonnet-fixture"].push("high");
  assert.deepEqual(source.capabilities.verifiedModelEfforts["sonnet-fixture"], ["max"]);
});

test("transport refuses legacy or nonadvertised Sonnet effort before authentication", async () => {
  let acquisitions = 0;
  const auth = { getToken: async () => { acquisitions++; throw Object.assign(new Error("synthetic boundary"), { code: "AUTH_REQUIRED" }); } };
  for (const candidate of [profile, { ...profile, capabilities: { ...profile.capabilities, verifiedModelEfforts: { "sonnet-fixture": ["max"] } } }]) {
    const transport = createCoworkTransport({ profile: candidate, auth, route: { ...routes[1], supportedEfforts: ["medium"] } });
    await assert.rejects(transport.execute({ prompt: "synthetic", effort: "medium" }), { code: "UNSUPPORTED_CAPABILITY" });
  }
  assert.equal(acquisitions, 0);
});

test("sessions project exact model efforts, max, conversation proof and annotated catalog", async () => {
  const scoped = { ...profile, capabilities: { ...profile.capabilities, verifiedModelEfforts: { "sonnet-fixture": ["max"] }, verifiedModelConversationReuse: { "opus-fixture": true } } };
  let locked = false, gatewayOptions;
  const session = await openCoworkSession({ model: "sonnet-fixture", effort: "max", directory: path.join(os.tmpdir(), "synthetic-model-session") }, {
    checkRuntime: () => {}, acquireLock: () => { locked = true; return () => { locked = false; }; }, readProfile: () => scoped,
    authFactory: () => ({ getToken: async () => ({ identity }), close: async () => {} }),
    transportFactory: ({ route }) => route ? { execute: async () => {} } : { models: async () => routes },
    ensureDirectory: () => {}, gatewayFactory: options => { gatewayOptions = options; return { stats: {}, listen: async () => "http://127.0.0.1:12345", close: async () => {} }; }
  });
  assert.equal(session.capabilities.clientEffort, "max");
  assert.deepEqual(session.capabilities.supportedEfforts, ["max"]);
  assert.equal(gatewayOptions.capabilities.conversationReuseVerified, false);
  assert.equal(session.catalog[1].defaultEffort, "medium");
  assert.deepEqual(session.catalog[1].verifiedEfforts, ["max"]);
  assert.deepEqual(session.catalog[2].verifiedEfforts, []);
  assert.equal(locked, true);
  await session.close();
  assert.equal(locked, false);
});
