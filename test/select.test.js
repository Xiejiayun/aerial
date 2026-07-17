import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { PassThrough, Writable } from "node:stream";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-select-test-"));
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_GITHUB_TOKEN = "github-test-token";
// Isolate HOME so currentModelFor/currentEffortFor cannot read the host's real
// ~/.codex or ~/.claude config — otherwise the selector's initial cursor would
// depend on the developer's machine state and the mechanics tests below would
// see an unpredictable starting row.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-select-home-"));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;

const {
  chooseSetupModel,
  discoverModelsForRoute,
  formatModelChoices,
  rankModels,
  orderForPrompt,
  pickRecommended,
  viewportStart,
  EFFORT_VALUES,
  CODEX_EFFORT_VALUES,
  DEFAULT_EFFORT,
  normalizeEffort,
  normalizeCodexEffort,
  normalizeEffortCandidates,
  normalizeCodexEffortCandidates,
  assertValidEffort,
  assertValidCodexEffort,
  resolveClaudeEffort,
  resolveCodexEffort,
  chooseSetupEffort,
  formatEffortSelection
} = await import("../src/cli/select.js");
const { ensureApiKey } = await import("../src/shared/config.js");
ensureApiKey();

const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

function fakeStreams(stdinText) {
  const inputStream = new PassThrough();
  inputStream.isTTY = true;
  inputStream.setRawMode = () => {};
  setImmediate(() => inputStream.write(stdinText));
  const chunks = [];
  const outputStream = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); }
  });
  outputStream.isTTY = true;
  return { inputStream, outputStream, getOutput: () => chunks.join("") };
}

// --- viewport scrolling ---

test("viewportStart returns 0 when the list fits within the window", () => {
  assert.equal(viewportStart(0, 4, 10), 0);
  assert.equal(viewportStart(3, 4, 10), 0);
});

test("viewportStart keeps the cursor centered in the middle of a long list", () => {
  assert.equal(viewportStart(10, 30, 10), 5);
});

test("viewportStart clamps to the top edge", () => {
  assert.equal(viewportStart(0, 30, 10), 0);
  assert.equal(viewportStart(2, 30, 10), 0);
});

test("viewportStart clamps to the bottom edge", () => {
  assert.equal(viewportStart(29, 30, 10), 20);
  assert.equal(viewportStart(28, 30, 10), 20);
});

// --- selector mechanics (driven through chooseSetupEffort, which uses select internally) ---

test("Enter selects the default-positioned row", async () => {
  const { inputStream, outputStream } = fakeStreams("\n");
  const result = await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  assert.equal(result.effort, "medium");
  assert.equal(result.source, "prompt");
  assert.equal(result.displayed, true);
});

test("down arrow moves the cursor then Enter selects", async () => {
  const { inputStream, outputStream } = fakeStreams("\x1b[B\n");
  const result = await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  assert.equal(result.effort, "high");
});

test("up arrow moves the cursor then Enter selects", async () => {
  const { inputStream, outputStream } = fakeStreams("\x1b[A\n");
  const result = await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  assert.equal(result.effort, "low");
});

test("up arrow wraps around from the top row", async () => {
  const { inputStream, outputStream } = fakeStreams("\x1b[A\x1b[A\n");
  const result = await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  assert.equal(result.effort, "minimal");
});

test("number key jumps to that 1-based row", async () => {
  const { inputStream, outputStream } = fakeStreams("3\n");
  const result = await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  assert.equal(result.effort, "medium");
});

test("default tag is rendered on the default row", async () => {
  const { inputStream, outputStream, getOutput } = fakeStreams("\n");
  await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  const text = getOutput();
  assert.match(text, /Choose Codex reasoning effort/);
  assert.match(text, /medium/);
  assert.match(text, /default/);
});

test("effort selector only offers efforts supported by the selected model", async () => {
  const { inputStream, outputStream, getOutput } = fakeStreams("\n");
  const result = await chooseSetupEffort({
    target: "Claude Code",
    model: "claude-opus-4.8",
    supportedEfforts: ["medium"],
    input: inputStream,
    output: outputStream
  });
  const text = getOutput();
  assert.equal(result.effort, "medium");
  assert.deepEqual(result.supportedEfforts, ["medium"]);
  assert.match(text, /medium/);
  assert.doesNotMatch(text, /\blow\b/);
  assert.doesNotMatch(text, /\bhigh\b/);
  assert.doesNotMatch(text, /\bxhigh\b/);
});

test("q cancels the effort selector instead of selecting the highlighted row", async () => {
  const { inputStream, outputStream } = fakeStreams("q");
  await assert.rejects(
    () => chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream }),
    /Codex setup cancelled\./
  );
});

test("effort selector marks the configured effort as current and starts on it", async () => {
  const { setupCodex } = await import("../src/setup/index.js");
  const codexFile = path.join(fakeHome, ".codex", "config.toml");
  setupCodex({ model: "gpt-5.5", effort: "high", authCommand: { command: "true", args: [] } });
  try {
    // Enter with no navigation must select the current effort, not the default.
    const enter = fakeStreams("\n");
    const picked = await chooseSetupEffort({ target: "Codex", input: enter.inputStream, output: enter.outputStream });
    assert.equal(picked.effort, "high");
    assert.match(enter.getOutput(), /current/);
  } finally {
    fs.rmSync(codexFile, { force: true });
  }
});

// --- effort selection ---

test("Claude and Codex effort values are separate and frozen", () => {
  assert.deepEqual([...EFFORT_VALUES], ["low", "medium", "high", "xhigh", "max", "ultracode"]);
  assert.deepEqual([...CODEX_EFFORT_VALUES], ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(DEFAULT_EFFORT, "medium");
  assert.throws(() => EFFORT_VALUES.push("max"));
  assert.throws(() => CODEX_EFFORT_VALUES.push("turbo"));
});

test("normalizeEffort accepts canonical values", () => {
  for (const value of ["low", "medium", "high", "xhigh", "max", "ultracode"]) {
    assert.equal(normalizeEffort(value), value);
    assert.equal(normalizeEffort(value.toUpperCase()), value);
    assert.equal(normalizeEffort(`  ${value}  `), value);
  }
});

test("normalizeCodexEffort preserves max and ultra and aliases none to minimal", () => {
  assert.equal(normalizeCodexEffort("max"), "max");
  assert.equal(normalizeCodexEffort("ULTRA"), "ultra");
  assert.equal(normalizeCodexEffort("minimal"), "minimal");
  assert.equal(normalizeCodexEffort("none"), "minimal");
  assert.equal(normalizeCodexEffort("turbo"), undefined);
});

test("normalizeEffort returns undefined for invalid input", () => {
  assert.equal(normalizeEffort("turbo"), undefined);
  assert.equal(normalizeEffort(""), undefined);
  assert.equal(normalizeEffort("   "), undefined);
  assert.equal(normalizeEffort(undefined), undefined);
  assert.equal(normalizeEffort(null), undefined);
});

test("normalizeEffortCandidates preserves the extended Claude effort order", () => {
  assert.deepEqual(normalizeEffortCandidates(["HIGH", "max", "medium", "ultracode", "turbo"]), ["medium", "high", "max", "ultracode"]);
  assert.deepEqual(normalizeEffortCandidates(undefined), []);
});

test("normalizeCodexEffortCandidates preserves Codex order and displays none as minimal", () => {
  assert.deepEqual(
    normalizeCodexEffortCandidates(["max", "none", "HIGH", "ultra", "turbo"]),
    ["minimal", "high", "max", "ultra"]
  );
  assert.deepEqual(normalizeCodexEffortCandidates(undefined), []);
});

test("assertValidEffort throws with allowed values listed", () => {
  assert.throws(() => assertValidEffort("turbo"), /Invalid --effort/);
  assert.throws(() => assertValidEffort("turbo"), /low, medium, high, xhigh/);
  assert.throws(() => assertValidEffort("turbo"), /max/);
});

test("assertValidEffort returns normalized for valid input including max", () => {
  assert.equal(assertValidEffort("medium"), "medium");
  assert.equal(assertValidEffort("MAX"), "max");
  assert.equal(assertValidEffort("ultracode"), "ultracode");
});

test("resolveClaudeEffort preserves supported max and safely falls back", () => {
  assert.equal(resolveClaudeEffort("max", ["low", "xhigh", "max"]).wireEffort, "max");
  assert.equal(resolveClaudeEffort("ultracode", ["xhigh", "max"]).wireEffort, "max");
  assert.equal(resolveClaudeEffort("max", ["medium"]).wireEffort, "medium");
  assert.equal(resolveClaudeEffort("max", []).wireEffort, "xhigh");
  assert.equal(resolveClaudeEffort("ultracode", []).wireEffort, "xhigh");
});

test("assertValidCodexEffort accepts the extended Codex vocabulary", () => {
  assert.equal(assertValidCodexEffort("none"), "minimal");
  assert.equal(assertValidCodexEffort("max"), "max");
  assert.equal(assertValidCodexEffort("ultra"), "ultra");
  assert.throws(() => assertValidCodexEffort("turbo"), /Invalid --effort/);
});

test("resolveCodexEffort preserves supported max and maps minimal to catalog none", () => {
  assert.deepEqual(resolveCodexEffort("max", ["low", "xhigh", "max"]), {
    requestedEffort: "max",
    resolvedEffort: "max",
    wireEffort: "max",
    reason: "exact"
  });
  assert.deepEqual(resolveCodexEffort("minimal", ["none", "low"]), {
    requestedEffort: "minimal",
    resolvedEffort: "minimal",
    wireEffort: "none",
    reason: "alias"
  });
});

test("resolveCodexEffort finds the nearest usable model effort", () => {
  assert.equal(resolveCodexEffort("ultra", ["low", "xhigh", "max"]).resolvedEffort, "max");
  assert.equal(resolveCodexEffort("max", ["low", "xhigh"]).resolvedEffort, "xhigh");
  assert.equal(resolveCodexEffort("minimal", ["low", "medium"]).resolvedEffort, "low");
  assert.equal(resolveCodexEffort("max", ["turbo", "high"]).resolvedEffort, "high");
});

test("resolveCodexEffort applies deterministic aliases without model metadata", () => {
  assert.equal(resolveCodexEffort("ultra", []).wireEffort, "max");
  assert.equal(resolveCodexEffort("minimal", []).wireEffort, "none");
  assert.equal(resolveCodexEffort("max", []).wireEffort, "max");
});

test("chooseSetupEffort respects explicit effort without prompting", async () => {
  const result = await chooseSetupEffort({ target: "Codex", explicitEffort: "high", prompt: true });
  assert.equal(result.effort, "high");
  assert.equal(result.source, "explicit");
  assert.equal(result.displayed, false);
});

test("chooseSetupEffort preserves explicit Codex max without model metadata", async () => {
  const result = await chooseSetupEffort({ target: "Codex", explicitEffort: "max", prompt: true });
  assert.equal(result.effort, "max");
  assert.equal(result.source, "explicit");
});

test("chooseSetupEffort downgrades explicit Codex max when the selected model only supports xhigh", async () => {
  const result = await chooseSetupEffort({
    target: "Codex",
    model: "gpt-max",
    supportedEfforts: ["xhigh"],
    explicitEffort: "max",
    prompt: true
  });
  assert.equal(result.effort, "xhigh");
});

test("chooseSetupEffort downgrades Codex ultra to model-supported max", async () => {
  const result = await chooseSetupEffort({
    target: "Codex",
    model: "gpt-5.6-sol",
    supportedEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    explicitEffort: "ultra",
    prompt: true
  });
  assert.equal(result.effort, "max");
});

test("chooseSetupEffort writes Codex minimal when the model advertises none", async () => {
  const result = await chooseSetupEffort({
    target: "Codex",
    model: "gpt-5.6-sol",
    supportedEfforts: ["none", "low"],
    explicitEffort: "minimal",
    prompt: true
  });
  assert.equal(result.effort, "minimal");
});

test("chooseSetupEffort resolves explicit Claude effort against the selected model", async () => {
  const result = await chooseSetupEffort({
    target: "Claude Code",
    model: "claude-opus-4.8",
    supportedEfforts: ["medium"],
    explicitEffort: "ultracode",
    prompt: true
  });
  assert.equal(result.effort, "medium");
  assert.deepEqual(result.supportedEfforts, ["medium"]);
});

test("chooseSetupEffort rejects invalid explicit effort", async () => {
  await assert.rejects(
    () => chooseSetupEffort({ target: "Codex", explicitEffort: "turbo", prompt: true }),
    /Invalid --effort/
  );
});

test("chooseSetupEffort returns default medium under non-TTY", async () => {
  const result = await chooseSetupEffort({ target: "Codex", prompt: false });
  assert.equal(result.effort, "medium");
  assert.equal(result.source, "default_non_tty");
  assert.equal(result.displayed, false);
});

test("chooseSetupEffort uses the first model-supported effort under non-TTY when medium is unavailable", async () => {
  const result = await chooseSetupEffort({
    target: "Claude Code",
    model: "claude-opus-4.8",
    supportedEfforts: ["high"],
    prompt: false
  });
  assert.equal(result.effort, "high");
  assert.equal(result.source, "default_non_tty");
  assert.deepEqual(result.supportedEfforts, ["high"]);
});

test("formatEffortSelection differentiates non-TTY default", () => {
  const explicit = formatEffortSelection({ target: "Codex", effort: "high", source: "explicit" });
  const prompt = formatEffortSelection({ target: "Codex", effort: "low", source: "prompt" });
  const nonTty = formatEffortSelection({ target: "Codex", effort: "medium", source: "default_non_tty" });
  assert.match(explicit, /Selected Codex effort: high/);
  assert.match(prompt, /Selected Codex effort: low/);
  assert.match(nonTty, /No interactive terminal/);
  assert.match(nonTty, /--effort <minimal\|low\|medium\|high\|xhigh\|max\|ultra>/);
});

test("formatEffortSelection keeps the full resolvable Claude effort vocabulary", () => {
  const nonTty = formatEffortSelection({
    target: "Claude Code",
    effort: "medium",
    source: "default_non_tty",
    supportedEfforts: ["medium", "xhigh"]
  });
  assert.match(nonTty, /--effort <low\|medium\|high\|xhigh\|max\|ultracode>/);
});

// --- model discovery / ranking / selection ---

test("discoverModelsForRoute filters models by Aerial route", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return Response.json({ data: [
      { id: "gpt-responses", supported_endpoints: ["/responses"], capabilities: { supports: { reasoning_effort: ["medium"] } } },
      { id: "claude-messages", supported_endpoints: ["/v1/messages"] },
      { id: "chat-only", supported_endpoints: ["/chat/completions"] }
    ] });
  };
  const responses = await discoverModelsForRoute("responses");
  const messages = await discoverModelsForRoute("messages");
  assert.deepEqual(responses.map((model) => model.id), ["gpt-responses"]);
  assert.deepEqual(responses[0].supportedEfforts, ["medium"]);
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

test("q cancels the model selector instead of selecting the recommended model", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    return Response.json({ data: [
      { id: "gpt-5.5", supported_endpoints: ["/responses"] }
    ] });
  };
  const { inputStream, outputStream } = fakeStreams("q");
  await assert.rejects(
    () => chooseSetupModel({ target: "Codex", route: "responses", prompt: true, input: inputStream, output: outputStream }),
    /Codex setup cancelled\./
  );
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
