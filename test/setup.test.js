import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-setup-test-"));
process.env.AERIAL_CONFIG_DIR = path.join(temp, "config");
process.env.HOME = temp;
process.env.USERPROFILE = temp;
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_SKIP_ENV_PERSIST = "1";

const { ensureApiKey } = await import("../src/config.js");
const { setupCodex, setupClaude, setupStatus } = await import("../src/setup.js");
const { loadConfig, saveConfig } = await import("../src/config.js");
ensureApiKey();

test("setupCodex writes responses provider without deleting existing content", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "approval_policy = \"never\"\n", "utf8");
  const result = setupCodex({ model: "copilot-test" });
  const content = fs.readFileSync(result.file, "utf8");
  assert.match(content, /approval_policy = "never"/);
  assert.match(content, /wire_api = "responses"/);
  assert.match(content, /\[model_providers\.aerial\.auth\]/);
  assert.match(content, /command = "aerial"/);
  assert.match(content, /args = \["key", "print"\]/);
  assert.doesNotMatch(content, /env_key = "AERIAL_API_KEY"/);
  assert.ok(result.backup);
  assert.equal(result.auth.type, "command");
  assert.equal(result.auth.command, "aerial");
});

test("setupCodex can write an absolute command-backed auth helper for CLI installs", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");
  const result = setupCodex({
    model: "copilot-test",
    authCommand: {
      command: "/usr/local/bin/node",
      args: ["/usr/local/lib/node_modules/@jiayunxie/aerial/src/cli.js", "key", "print"],
      timeout_ms: 5000,
      refresh_interval_ms: 0
    }
  });
  const content = fs.readFileSync(result.file, "utf8");
  assert.match(content, /command = "\/usr\/local\/bin\/node"/);
  assert.match(content, /args = \["\/usr\/local\/lib\/node_modules\/@jiayunxie\/aerial\/src\/cli\.js", "key", "print"\]/);
  assert.match(content, /refresh_interval_ms = 0/);
});

test("setupClaude merges gateway settings", () => {
  const claudeDir = path.join(temp, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    env: {
      EXISTING: "1",
      ANTHROPIC_BASE_URL: "http://localhost:23333/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "Powered by Agent Maestro",
      ANTHROPIC_API_KEY: "Powered by Agent Maestro",
      ANTHROPIC_MODEL: "claude-opus-4.7-xhigh",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4.7-xhigh"
    }
  }), "utf8");
  const result = setupClaude({ model: "claude-test", apiKeyHelper: "\"/usr/local/bin/node\" \"/usr/local/lib/node_modules/@jiayunxie/aerial/src/cli.js\" \"key\" \"print\"" });
  const settings = JSON.parse(fs.readFileSync(result.file, "utf8"));
  assert.equal(settings.apiKeyHelper, "\"/usr/local/bin/node\" \"/usr/local/lib/node_modules/@jiayunxie/aerial/src/cli.js\" \"key\" \"print\"");
  assert.equal(settings.model, "claude-test");
  assert.equal(settings.env.EXISTING, "1");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18181");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(settings.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(settings.env.ANTHROPIC_MODEL, undefined);
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, undefined);
  assert.equal(result.model, "claude-test");
  assert.match(result.apiKeyHelper, /key" "print/);
});

test("setupCodex writes model_reasoning_effort into profiles.aerial when effort is provided", () => {
  const result = setupCodex({ model: "copilot-test", effort: "high" });
  const content = fs.readFileSync(result.file, "utf8");
  const profileBlock = content.split("[profiles.aerial]")[1] || "";
  assert.match(profileBlock, /model_reasoning_effort = "high"/);
  assert.doesNotMatch(content.split("[")[0], /model_reasoning_effort/);
  assert.equal(result.effort, "high");
  assert.equal(loadConfig().defaultEffort, "high");
});

test("setupCodex normalizes max effort to xhigh", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "medium" });
  const result = setupCodex({ model: "copilot-test", effort: "max" });
  const content = fs.readFileSync(result.file, "utf8");
  const profileBlock = content.split("[profiles.aerial]")[1] || "";
  assert.match(profileBlock, /model_reasoning_effort = "xhigh"/);
  assert.equal(result.effort, "xhigh");
  assert.equal(loadConfig().defaultEffort, "xhigh");
});

test("setupCodex rejects invalid effort before writing config", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "medium" });
  assert.throws(() => setupCodex({ model: "copilot-test", effort: "turbo" }), /Invalid --effort/);
  assert.equal(loadConfig().defaultEffort, "medium");
});

test("setupCodex/setupClaude with invalid effort have no side effects on a fresh dir (no ensureApiKey, no config.json, no client file)", async () => {
  const freshTemp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-setup-fresh-"));
  const freshConfigDir = path.join(freshTemp, "config");
  const restoreConfigDir = process.env.AERIAL_CONFIG_DIR;
  const restoreHome = process.env.HOME;
  const restoreUserprofile = process.env.USERPROFILE;
  process.env.AERIAL_CONFIG_DIR = freshConfigDir;
  process.env.HOME = freshTemp;
  process.env.USERPROFILE = freshTemp;
  try {
    assert.throws(() => setupCodex({ model: "copilot-test", effort: "turbo" }), /Invalid --effort/);
    assert.equal(fs.existsSync(freshConfigDir), false, "AERIAL_CONFIG_DIR must not be created");
    assert.equal(fs.existsSync(path.join(freshTemp, ".codex", "config.toml")), false, "codex config must not be written");

    assert.throws(() => setupClaude({ model: "claude-test", effort: "turbo" }), /Invalid --effort/);
    assert.equal(fs.existsSync(freshConfigDir), false, "AERIAL_CONFIG_DIR must not be created by setupClaude either");
    assert.equal(fs.existsSync(path.join(freshTemp, ".claude", "settings.json")), false, "claude settings must not be written");
  } finally {
    process.env.AERIAL_CONFIG_DIR = restoreConfigDir;
    process.env.HOME = restoreHome;
    process.env.USERPROFILE = restoreUserprofile;
  }
});

test("setupClaude updates Aerial defaultEffort without writing effort into Claude settings.json", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "medium" });
  const result = setupClaude({ model: "claude-test", effort: "low" });
  const settings = JSON.parse(fs.readFileSync(result.file, "utf8"));
  assert.equal(settings.model, "claude-test");
  assert.equal(settings.effort, undefined);
  assert.equal(settings.reasoning_effort, undefined);
  assert.equal(result.effort, "low");
  assert.equal(loadConfig().defaultEffort, "low");
});

test("setupStatus exposes additive effort field with canonical or 'missing'", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "high" });
  setupCodex({ model: "copilot-test", effort: "xhigh" });
  const status = setupStatus();
  assert.equal(status.schema, "aerial.setup-status.v1");
  assert.equal(status.clients.codex.effort, "xhigh");
  assert.equal(status.clients.claude.effort, "xhigh");
});

test("setupStatus reports codex effort 'missing' when Codex profile lacks model_reasoning_effort", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");
  setupCodex({ model: "copilot-test" });
  const status = setupStatus();
  assert.equal(status.clients.codex.effort, "missing");
});

test("setupStatus normalizes Codex profile effort 'max' to canonical 'xhigh'", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  setupCodex({ model: "copilot-test", effort: "medium" });
  const file = path.join(codexDir, "config.toml");
  const content = fs.readFileSync(file, "utf8").replace(/model_reasoning_effort = "medium"/, 'model_reasoning_effort = "max"');
  fs.writeFileSync(file, content, "utf8");
  const status = setupStatus();
  assert.equal(status.clients.codex.effort, "xhigh");
});

test("setupStatus reports codex effort 'missing' for non-canonical Codex profile values like 'turbo'", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  setupCodex({ model: "copilot-test", effort: "medium" });
  const file = path.join(codexDir, "config.toml");
  const content = fs.readFileSync(file, "utf8").replace(/model_reasoning_effort = "medium"/, 'model_reasoning_effort = "turbo"');
  fs.writeFileSync(file, content, "utf8");
  const status = setupStatus();
  assert.equal(status.clients.codex.effort, "missing");
});
