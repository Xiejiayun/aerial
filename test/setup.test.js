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
const { setupCodex, setupClaude } = await import("../src/setup.js");
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
