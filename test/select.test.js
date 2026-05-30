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
  DEFAULT_EFFORT,
  normalizeEffort,
  assertValidEffort,
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
  assert.equal(result.effort, "xhigh");
});

test("number key jumps to that 1-based row", async () => {
  const { inputStream, outputStream } = fakeStreams("3\n");
  const result = await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  assert.equal(result.effort, "high");
});

test("default tag is rendered on the default row", async () => {
  const { inputStream, outputStream, getOutput } = fakeStreams("\n");
  await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  const text = getOutput();
  assert.match(text, /Choose Codex reasoning effort/);
  assert.match(text, /medium/);
  assert.match(text, /default/);
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

test("EFFORT_VALUES and DEFAULT_EFFORT exposed and frozen", () => {
  assert.deepEqual([...EFFORT_VALUES], ["low", "medium", "high", "xhigh"]);
  assert.equal(DEFAULT_EFFORT, "medium");
  assert.throws(() => EFFORT_VALUES.push("max"));
});

test("normalizeEffort accepts canonical values", () => {
  for (const value of ["low", "medium", "high", "xhigh"]) {
    assert.equal(normalizeEffort(value), value);
    assert.equal(normalizeEffort(value.toUpperCase()), value);
    assert.equal(normalizeEffort(`  ${value}  `), value);
  }
});

test("normalizeEffort aliases 'max' to 'xhigh'", () => {
  assert.equal(normalizeEffort("max"), "xhigh");
  assert.equal(normalizeEffort("MAX"), "xhigh");
});

test("normalizeEffort returns undefined for invalid input", () => {
  assert.equal(normalizeEffort("turbo"), undefined);
  assert.equal(normalizeEffort(""), undefined);
  assert.equal(normalizeEffort("   "), undefined);
  assert.equal(normalizeEffort(undefined), undefined);
  assert.equal(normalizeEffort(null), undefined);
});

test("assertValidEffort throws with allowed values listed", () => {
  assert.throws(() => assertValidEffort("turbo"), /Invalid --effort/);
  assert.throws(() => assertValidEffort("turbo"), /low, medium, high, xhigh/);
  assert.throws(() => assertValidEffort("turbo"), /max/);
});

test("assertValidEffort returns normalized for valid input including max", () => {
  assert.equal(assertValidEffort("medium"), "medium");
  assert.equal(assertValidEffort("MAX"), "xhigh");
  assert.equal(assertValidEffort("max"), "xhigh");
});

test("chooseSetupEffort respects explicit effort without prompting", async () => {
  const result = await chooseSetupEffort({ target: "Codex", explicitEffort: "high", prompt: true });
  assert.equal(result.effort, "high");
  assert.equal(result.source, "explicit");
  assert.equal(result.displayed, false);
});

test("chooseSetupEffort normalizes explicit max -> xhigh", async () => {
  const result = await chooseSetupEffort({ target: "Codex", explicitEffort: "max", prompt: true });
  assert.equal(result.effort, "xhigh");
  assert.equal(result.source, "explicit");
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

test("formatEffortSelection differentiates non-TTY default", () => {
  const explicit = formatEffortSelection({ target: "Codex", effort: "high", source: "explicit" });
  const prompt = formatEffortSelection({ target: "Codex", effort: "low", source: "prompt" });
  const nonTty = formatEffortSelection({ target: "Codex", effort: "medium", source: "default_non_tty" });
  assert.match(explicit, /Selected Codex effort: high/);
  assert.match(prompt, /Selected Codex effort: low/);
  assert.match(nonTty, /No interactive terminal/);
  assert.match(nonTty, /--effort <low\|medium\|high\|xhigh\|max>/);
});

// --- model discovery / ranking / selection ---

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
