import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cowork-client-effort-"));
process.env.AERIAL_CONFIG_DIR = path.join(root, "aerial");
process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
process.env.CODEX_HOME = path.join(root, "codex");
process.env.AERIAL_API_KEY = "synthetic-client-effort-key";
for (const key of Object.keys(process.env)) if (/^ANTHROPIC_|^CLAUDE_CODE_USE_/.test(key) || ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_MODEL", "MAX_THINKING_TOKENS"].includes(key)) delete process.env[key];
const { loadConfig, saveConfig } = await import("../src/shared/config.js");
const { setupCoworkClaude, persistentCoworkClaudeSettings, coworkSavedEffort } = await import("../src/setup/cowork-claude.js");
const { claudeStatus, setupClaude } = await import("../src/setup/clients.js");
const model = "cowork/claude-opus-5-5-fixture";
const file = path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
const codexFile = path.join(process.env.CODEX_HOME, "config.toml");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.mkdirSync(path.dirname(codexFile), { recursive: true });
fs.writeFileSync(codexFile, 'model = "github-codex-original"\n');
const readSettings = () => JSON.parse(fs.readFileSync(file, "utf8"));
function prepare(effort = "medium", current = {}) {
  saveConfig({ ...loadConfig(), defaultModel: "github-default", defaultEffort: "high",
    cowork: { model, profileDirectory: path.join(root, "synthetic-profile"), effort } });
  fs.writeFileSync(file, JSON.stringify({ permissions: { deny: ["Bash"] }, env: { EXISTING: "keep" }, ...current }));
}

test("persistent Cowork settings preserve every selected effort and pin every model family", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    prepare(effort);
    const settings = persistentCoworkClaudeSettings({ model, effort, config: loadConfig() });
    assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, effort);
    assert.equal(settings.effortLevel, effort === "max" ? undefined : effort);
    assert.equal(settings.modelSettings?.[model]?.effortLevel, effort === "max" ? undefined : effort);
    for (const family of ["OPUS", "SONNET", "HAIKU", "FABLE"]) assert.equal(settings.env[`ANTHROPIC_DEFAULT_${family}_MODEL`], model);
    assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, model);
    assert.equal(settings.env.CLAUDE_CODE_DISABLE_THINKING, "1");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
  }
});

test("Cowork writer moves between all effort levels without stale max selectors or GitHub changes", () => {
  prepare();
  for (const effort of ["low", "medium", "high", "xhigh", "max", "low"]) {
    saveConfig({ ...loadConfig(), cowork: { ...loadConfig().cowork, effort } });
    const result = setupCoworkClaude({ model, effort });
    const settings = readSettings();
    assert.equal(result.effort, effort);
    assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, effort);
    assert.equal(settings.effortLevel, effort === "max" ? undefined : effort);
    assert.equal(settings.modelSettings[model].effortLevel, effort === "max" ? undefined : effort);
    assert.deepEqual(settings.permissions, { deny: ["Bash"] });
    assert.equal(settings.env.EXISTING, "keep");
    const status = claudeStatus({ env: {} });
    assert.equal(status.state, "aerial");
    assert.equal(status.effort, effort);
    assert.equal(status.effortSource, "env");
    assert.equal(status.invalidEffort, undefined);
  }
  assert.equal(loadConfig().defaultModel, "github-default");
  assert.equal(loadConfig().defaultEffort, "high");
  assert.equal(fs.readFileSync(codexFile, "utf8"), 'model = "github-codex-original"\n');
});

test("max removes conflicting effort fields while retaining other model settings", () => {
  prepare("max", { effortLevel: "xhigh", maxEffortLevel: "high", modelSettings: {
    [model]: { effortLevel: "medium", maxEffortLevel: "low", retained: "yes" },
    unrelated: { effortLevel: "high" }
  } });
  setupCoworkClaude({ model, effort: "max" });
  const settings = readSettings();
  assert.equal(Object.hasOwn(settings, "effortLevel"), false);
  assert.equal(Object.hasOwn(settings, "maxEffortLevel"), false);
  assert.deepEqual(settings.modelSettings[model], { retained: "yes" });
  assert.deepEqual(settings.modelSettings.unrelated, { effortLevel: "high" });
  assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, "max");
});

test("Cowork status identifies max from env and reports drift against configured effort", () => {
  prepare("max");
  setupCoworkClaude({ model, effort: "max" });
  assert.deepEqual(coworkSavedEffort(readSettings()), { effort: "max", effortSource: "env" });
  for (const change of [
    settings => { settings.env.CLAUDE_CODE_EFFORT_LEVEL = "high"; },
    settings => { settings.effortLevel = "max"; },
    settings => { settings.modelSettings[model].effortLevel = "xhigh"; },
    settings => { delete settings.env.CLAUDE_CODE_EFFORT_LEVEL; }
  ]) {
    setupCoworkClaude({ model, effort: "max" });
    const settings = readSettings(); change(settings); fs.writeFileSync(file, JSON.stringify(settings));
    assert.equal(claudeStatus({ env: {} }).state, "aerial-drift");
  }
  setupCoworkClaude({ model, effort: "max" });
  saveConfig({ ...loadConfig(), cowork: { ...loadConfig().cowork, effort: "xhigh" } });
  const status = claudeStatus({ env: {} });
  assert.equal(status.state, "aerial-drift");
  assert.equal(status.effort, "max");
  assert.equal(status.effortSource, "env");
});

test("invalid Cowork effort never falls back or edits client settings", () => {
  prepare();
  const original = fs.readFileSync(file, "utf8");
  for (const effort of ["ultra", "MAX", "", 5]) assert.throws(() => setupCoworkClaude({ model, effort }), /No effort fallback/);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("switching max Cowork settings back to GitHub restores normal effort reporting", () => {
  prepare("max");
  setupCoworkClaude({ model, effort: "max" });
  setupClaude({ model: "claude-opus-4.7", effort: "high" });
  const settings = readSettings();
  assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_THINKING, undefined);
  const status = claudeStatus({ env: {} });
  assert.equal(status.state, "aerial");
  assert.equal(status.effort, "high");
  assert.equal(status.effortSource, "modelSettings");
  settings.env.CLAUDE_CODE_EFFORT_LEVEL = "max";
  fs.writeFileSync(file, JSON.stringify(settings));
  assert.equal(claudeStatus({ env: {} }).effortSource, "modelSettings");
});
