import test from "node:test";
import assert from "node:assert/strict";

const {
  fetchModelsCatalog,
  clearModelCatalogCacheForTests,
  canonicalClaudeFamily,
  findCompatibleModel,
  tokenFingerprintOf
} = await import("../src/model-catalog.js");

function makeModel(id, { route = "/v1/messages", adaptive = true, efforts = ["low", "medium", "high", "xhigh"] } = {}) {
  return {
    id,
    supported_endpoints: [route],
    capabilities: { supports: { adaptive_thinking: adaptive, reasoning_effort: efforts } }
  };
}

test.afterEach(() => clearModelCatalogCacheForTests());

test("canonicalClaudeFamily recognizes Opus 4.7 and its hyphen alias", () => {
  assert.equal(canonicalClaudeFamily("claude-opus-4.7"), "claude-opus-4.7");
  assert.equal(canonicalClaudeFamily("claude-opus-4-7"), "claude-opus-4.7");
  assert.equal(canonicalClaudeFamily("claude-opus-4.7-1m-internal"), "claude-opus-4.7");
  assert.equal(canonicalClaudeFamily("claude-sonnet-4.6"), undefined);
  assert.equal(canonicalClaudeFamily("gpt-5"), undefined);
  assert.equal(canonicalClaudeFamily(null), undefined);
});

test("findCompatibleModel filters by family", () => {
  const models = [makeModel("claude-sonnet-4.6"), makeModel("claude-opus-4.7-x")];
  const r = findCompatibleModel({ models, family: "claude-opus-4.7", route: "/v1/messages", adaptiveThinking: true, effort: "high" });
  assert.equal(r.id, "claude-opus-4.7-x");
});

test("findCompatibleModel filters by /v1/messages route requirement", () => {
  const models = [makeModel("claude-opus-4.7-a", { route: "/responses" }), makeModel("claude-opus-4.7-b")];
  const r = findCompatibleModel({ models, family: "claude-opus-4.7", route: "/v1/messages", adaptiveThinking: true, effort: "high" });
  assert.equal(r.id, "claude-opus-4.7-b");
});

test("findCompatibleModel filters by adaptive thinking support", () => {
  const models = [makeModel("claude-opus-4.7-no", { adaptive: false }), makeModel("claude-opus-4.7-yes")];
  const r = findCompatibleModel({ models, family: "claude-opus-4.7", route: "/v1/messages", adaptiveThinking: true, effort: "high" });
  assert.equal(r.id, "claude-opus-4.7-yes");
});

test("findCompatibleModel filters by requested effort", () => {
  const models = [makeModel("claude-opus-4.7-lm", { efforts: ["low", "medium"] }), makeModel("claude-opus-4.7-full")];
  const r = findCompatibleModel({ models, family: "claude-opus-4.7", route: "/v1/messages", adaptiveThinking: true, effort: "xhigh" });
  assert.equal(r.id, "claude-opus-4.7-full");
});

test("findCompatibleModel preserves preferredId when compatible", () => {
  const models = [makeModel("claude-opus-4.7-a"), makeModel("claude-opus-4.7-b")];
  const r = findCompatibleModel({ models, family: "claude-opus-4.7", route: "/v1/messages", adaptiveThinking: true, effort: "high", preferredId: "claude-opus-4.7-b" });
  assert.equal(r.id, "claude-opus-4.7-b");
});

test("findCompatibleModel falls back to first compatible when preferred not compatible", () => {
  const models = [makeModel("claude-opus-4.7-a"), makeModel("claude-opus-4.7-preferred", { efforts: ["medium"] })];
  const r = findCompatibleModel({ models, family: "claude-opus-4.7", route: "/v1/messages", adaptiveThinking: true, effort: "xhigh", preferredId: "claude-opus-4.7-preferred" });
  assert.equal(r.id, "claude-opus-4.7-a");
});

test("findCompatibleModel returns undefined when no model matches", () => {
  const models = [makeModel("claude-opus-4.7", { efforts: ["medium"] })];
  const r = findCompatibleModel({ models, family: "claude-opus-4.7", route: "/v1/messages", adaptiveThinking: true, effort: "xhigh" });
  assert.equal(r, undefined);
});

test("fetchModelsCatalog caches successful result for 30s window within a fingerprint", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return [makeModel("claude-opus-4.7")];
  };
  const a = await fetchModelsCatalog({ fetchImpl, tokenFingerprint: "fpA" });
  const b = await fetchModelsCatalog({ fetchImpl, tokenFingerprint: "fpA" });
  assert.equal(calls, 1, "second call within TTL must reuse cache");
  assert.equal(a[0].id, "claude-opus-4.7");
  assert.equal(b[0].id, "claude-opus-4.7");
});

test("fetchModelsCatalog uses separate cache entries per token fingerprint", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return [makeModel(`claude-opus-4.7-${calls}`)];
  };
  await fetchModelsCatalog({ fetchImpl, tokenFingerprint: "fpA" });
  await fetchModelsCatalog({ fetchImpl, tokenFingerprint: "fpB" });
  assert.equal(calls, 2, "different fingerprints must not share cache entry");
});

test("fetchModelsCatalog does not cache failure (undefined)", async () => {
  let calls = 0;
  let returnValue;
  const fetchImpl = async () => {
    calls += 1;
    return returnValue;
  };
  returnValue = undefined;
  assert.equal(await fetchModelsCatalog({ fetchImpl, tokenFingerprint: "fpC" }), undefined);
  returnValue = [makeModel("claude-opus-4.7")];
  const second = await fetchModelsCatalog({ fetchImpl, tokenFingerprint: "fpC" });
  assert.equal(calls, 2, "failure must not poison cache; retry must hit upstream again");
  assert.equal(second[0].id, "claude-opus-4.7");
});

test("tokenFingerprintOf is deterministic, length 16, and never echoes raw token", () => {
  const a = tokenFingerprintOf("github-test-token-aaa");
  const b = tokenFingerprintOf("github-test-token-aaa");
  const c = tokenFingerprintOf("github-test-token-bbb");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
  assert.ok(!a.includes("github-test-token"), "fingerprint must not contain raw token substring");
});

test("tokenFingerprintOf returns stable anonymous slot for empty/non-string inputs", () => {
  assert.equal(tokenFingerprintOf(""), "anonymous");
  assert.equal(tokenFingerprintOf(undefined), "anonymous");
  assert.equal(tokenFingerprintOf(null), "anonymous");
});

test("fetchModelsCatalog without fetchImpl returns undefined and does not cache", async () => {
  const r = await fetchModelsCatalog({ tokenFingerprint: "fpD" });
  assert.equal(r, undefined);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return [{ id: "claude-opus-4.7", supported_endpoints: ["/v1/messages"], capabilities: { supports: { adaptive_thinking: true, reasoning_effort: ["high"] } } }];
  };
  const second = await fetchModelsCatalog({ fetchImpl, tokenFingerprint: "fpD" });
  assert.equal(calls, 1, "earlier no-op call must not have written a cache entry that masks the real fetch");
  assert.equal(second[0].id, "claude-opus-4.7");
});
