import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-model-selection-test-"));
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_GITHUB_TOKEN = "github-test-token";

const { chooseSetupModel, discoverModelsForRoute, formatModelChoices, rankModels, orderForPrompt, pickRecommended } = await import("../src/model-selection.js");
const { ensureApiKey } = await import("../src/config.js");
ensureApiKey();

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("discoverModelsForRoute filters models by Aerial route", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return Response.json({ data: [
      { id: "gpt-responses", supported_endpoints: ["/responses"] },
      { id: "claude-messages", supported_endpoints: ["/v1/messages"] },
      { id: "chat-only", supported_endpoints: ["/chat/completions"] }
    ] });
  };

  const responses = await discoverModelsForRoute("responses");
  const messages = await discoverModelsForRoute("messages");
  assert.deepEqual(responses.map((model) => model.id), ["gpt-responses"]);
  assert.deepEqual(messages.map((model) => model.id), ["claude-messages"]);
});

test("chooseSetupModel auto-selects fallback model when no stable gpt-N.M is available", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return Response.json({ data: [
      { id: "gpt-a", supported_endpoints: ["/responses"] },
      { id: "gpt-b", supported_endpoints: ["/responses"] }
    ] });
  };

  const selected = await chooseSetupModel({ target: "Codex", route: "responses", prompt: false });
  assert.equal(selected.model, "gpt-a");
  assert.equal(selected.source, "recommended_fallback");
  assert.match(formatModelChoices({
    target: "Codex",
    route: "responses",
    choices: selected.choices,
    selectedModel: selected.model,
    source: selected.source,
    recommended: selected.recommended
  }).join("\n"), /Available Codex models/);
});

test("rankModels promotes the highest gpt-N.M version while preserving order on ties", () => {
  const choices = [
    { id: "gpt-4.1", routes: ["responses"], notes: [] },
    { id: "gpt-5.4-mini", routes: ["responses"], notes: [] },
    { id: "gpt-5.5", routes: ["responses"], notes: [] },
    { id: "custom-non-gpt", routes: ["responses"], notes: [] }
  ];
  const ranked = rankModels(choices).map((c) => c.id);
  assert.deepEqual(ranked, ["gpt-5.5", "gpt-5.4-mini", "gpt-4.1", "custom-non-gpt"]);
});

test("chooseSetupModel recommends gpt-5.5 over gpt-4.1 when both expose the responses route", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return Response.json({ data: [
      { id: "gpt-4.1", supported_endpoints: ["/responses"] },
      { id: "gpt-5.4-mini", supported_endpoints: ["/responses"] },
      { id: "gpt-5.5", supported_endpoints: ["/responses"] }
    ] });
  };

  const selected = await chooseSetupModel({ target: "Codex", route: "responses", prompt: false });
  assert.equal(selected.model, "gpt-5.5");
  assert.equal(selected.recommended, "gpt-5.5");
  assert.equal(selected.source, "recommended_stable");
  assert.deepEqual(selected.choices.map((c) => c.id), ["gpt-5.5", "gpt-5.4-mini", "gpt-4.1"]);
});

test("stable gpt-N.M beats higher-versioned suffix variants in recommendation", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return Response.json({ data: [
      { id: "gpt-5.5-preview", supported_endpoints: ["/responses"] },
      { id: "gpt-4.1", supported_endpoints: ["/responses"] }
    ] });
  };
  const selected = await chooseSetupModel({ target: "Codex", route: "responses", prompt: false });
  assert.equal(selected.model, "gpt-4.1");
  assert.equal(selected.source, "recommended_stable");
});

test("suffix-only catalog falls back to highest version with recommended_fallback source", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return Response.json({ data: [
      { id: "gpt-5-codex", supported_endpoints: ["/responses"] },
      { id: "gpt-5.5-preview", supported_endpoints: ["/responses"] }
    ] });
  };
  const selected = await chooseSetupModel({ target: "Codex", route: "responses", prompt: false });
  assert.equal(selected.model, "gpt-5.5-preview");
  assert.equal(selected.source, "recommended_fallback");
});

test("chooseSetupModel never picks a model whose route does not match the client", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return Response.json({ data: [
      { id: "gpt-4.1", supported_endpoints: ["/responses"] },
      { id: "gpt-5.4-mini", supported_endpoints: ["/responses"] },
      { id: "gpt-5.5", supported_endpoints: ["/v1/messages"] }
    ] });
  };

  const selected = await chooseSetupModel({ target: "Codex", route: "responses", prompt: false });
  assert.equal(selected.model, "gpt-4.1", "responses-only stable pool must pick gpt-4.1 over suffixed gpt-5.4-mini");
  assert.equal(selected.recommended, "gpt-4.1");
  assert.equal(selected.source, "recommended_stable");
  assert.ok(!selected.choices.some((c) => c.id === "gpt-5.5"));
});

test("explicit --model overrides recommendation", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return Response.json({ data: [
      { id: "gpt-5.5", supported_endpoints: ["/responses"] }
    ] });
  };
  const selected = await chooseSetupModel({ target: "Codex", route: "responses", prompt: false, explicitModel: "gpt-4.1" });
  assert.equal(selected.model, "gpt-4.1");
  assert.equal(selected.source, "explicit");
});

test("orderForPrompt places recommended first even when not ranked[0]", () => {
  const ranked = [
    { id: "gpt-5.5-preview", routes: ["responses"], notes: [] },
    { id: "gpt-4.1", routes: ["responses"], notes: [] },
    { id: "gpt-3.5", routes: ["responses"], notes: [] }
  ];
  const { recommended } = pickRecommended(ranked);
  assert.equal(recommended, "gpt-4.1", "stable beats preview");
  const ordered = orderForPrompt(ranked, recommended).map((c) => c.id);
  assert.deepEqual(ordered, ["gpt-4.1", "gpt-5.5-preview", "gpt-3.5"], "recommended must be at index 0 so Enter selects it");
});

test("orderForPrompt is a no-op when recommended is already ranked[0]", () => {
  const ranked = [
    { id: "gpt-5.5", routes: ["responses"], notes: [] },
    { id: "gpt-4.1", routes: ["responses"], notes: [] }
  ];
  const ordered = orderForPrompt(ranked, "gpt-5.5").map((c) => c.id);
  assert.deepEqual(ordered, ["gpt-5.5", "gpt-4.1"]);
});

test("orderForPrompt is a no-op when recommended is missing from ranked", () => {
  const ranked = [
    { id: "gpt-5.5", routes: ["responses"], notes: [] }
  ];
  const ordered = orderForPrompt(ranked, undefined).map((c) => c.id);
  assert.deepEqual(ordered, ["gpt-5.5"]);
});


