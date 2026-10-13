import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-claude-migration-"));
process.env.AERIAL_CONFIG_DIR = path.join(root, "aerial");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.AERIAL_SKIP_ENV_PERSIST = "1";
const { setupClaude, claudeStatus, setupStatus, detachAllClients } = await import("../src/setup/index.js");
const { loadConfig, saveConfig } = await import("../src/shared/config.js");
const { computeAppStatus } = await import("../src/cli/helpers.js");
const { claudeEnvironmentConflicts } = await import("../src/setup/claude-conflicts.js");
const file = path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");

test("migration removes provider/model/effort overrides and teardown restores the exact original", () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = JSON.stringify({
    model: "old-deployment", apiKeyHelper: "old helper", effortLevel: "max",
    alwaysThinkingEnabled: false, ultracode: true, maxEffortLevel: "low", availableModels: ["old-deployment"],
    modelOverrides: { "claude-opus-4-7": "old-arn" },
    modelSettings: { "claude-opus-4-7": { effortLevel: "low", maxEffortLevel: "low", autoCompactWindow: 200000 }, other: { effortLevel: "high" } },
    env: { CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "old-haiku", ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES: "effort", CLAUDE_CODE_EFFORT_LEVEL: "low", MAX_THINKING_TOKENS: "0", ANTHROPIC_AUTH_TOKEN: "synthetic-secret", KEEP: "yes" }
  }, null, 2);
  fs.writeFileSync(file, before);
  setupClaude({ model: "claude-opus-4.7", effort: "medium", models: [{ id: "claude-haiku-4.5" }] });
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(doc.env).sort(), ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY", "KEEP"]);
  assert.deepEqual(doc.modelOverrides, { "claude-haiku-4-5": "claude-haiku-4.5", "claude-opus-4-7": "claude-opus-4.7" });
  assert.deepEqual(doc.modelSettings["claude-opus-4-7"], { effortLevel: "medium", autoCompactWindow: 200000 });
  assert.equal(doc.modelSettings.other.effortLevel, "high");
  assert.equal(doc.maxEffortLevel, undefined);
  assert.equal(doc.alwaysThinkingEnabled, undefined);
  assert.equal(claudeStatus().state, "aerial");
  assert.equal(detachAllClients().ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("shell overrides block setup before writes, are reported without secret values, and fail aggregate readiness", () => {
  setupClaude({ model: "claude-opus-4.7", effort: "medium" });
  const original = fs.readFileSync(file, "utf8");
  const old = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = "synthetic-private-value";
  try {
    assert.throws(() => setupClaude({ model: "claude-opus-4.7", effort: "high" }), error => /ANTHROPIC_AUTH_TOKEN/.test(error.message) && !error.message.includes("synthetic-private-value"));
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(claudeStatus().state, "aerial-drift");
    const setup = setupStatus();
    setup.clients.codex.state = "aerial";
    setup.auth.github_token.source = "file";
    const status = computeAppStatus(setup, { supported: false, platform: "linux", service: {}, health: { aerial: true } });
    assert.equal(status.ok, false);
    assert.ok(status.nextSteps.some(step => step.includes("ANTHROPIC_AUTH_TOKEN")));
    assert.doesNotMatch(JSON.stringify(status), /synthetic-private-value/);
  } finally {
    if (old === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = old;
  }
});

test("disabled providers and an identical base URL are not conflicts; missing effort stays missing", () => {
  assert.deepEqual(claudeEnvironmentConflicts({ CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "false", ANTHROPIC_BASE_URL: "http://127.0.0.1:18181" }, loadConfig()), []);
  saveConfig({ ...loadConfig(), defaultEffort: "high" });
  setupClaude({ model: "claude-opus-4.7" });
  assert.equal(claudeStatus().effort, "missing");
});
