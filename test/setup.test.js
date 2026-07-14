import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { parse as parseToml } from "smol-toml";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-setup-test-"));
process.env.AERIAL_CONFIG_DIR = path.join(temp, "config");
process.env.HOME = temp;
process.env.USERPROFILE = temp;
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_SKIP_ENV_PERSIST = "1";

const { ensureApiKey } = await import("../src/shared/config.js");
const { setupCodex, setupClaude, setupStatus, codexStatus } = await import("../src/setup/index.js");
const { loadConfig, saveConfig } = await import("../src/shared/config.js");
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
  assert.match(content, /args = \[ "key", "print" \]/);
  assert.doesNotMatch(content, /env_key = "AERIAL_API_KEY"/);
  assert.ok(result.backup);
  assert.equal(result.auth.type, "command");
  assert.equal(result.auth.command, "aerial");
});

test("setupCodex writes root model keys before existing TOML sections", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const file = path.join(codexDir, "config.toml");
  fs.writeFileSync(file, [
    "[profiles.work]",
    "model = \"gpt-old\"",
    "approval_policy = \"never\"",
    ""
  ].join("\n"), "utf8");

  setupCodex({ model: "copilot-test" });
  const content = fs.readFileSync(file, "utf8");
  const doc = parseToml(content);
  assert.equal(doc.model_provider, "aerial");
  assert.equal(doc.model, "copilot-test");
  assert.equal(doc.profiles.work.model, "gpt-old");
  assert.equal(codexStatus().state, "aerial");
});

test("setupCodex can write an absolute command-backed auth helper for CLI installs", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");
  const result = setupCodex({
    model: "copilot-test",
    authCommand: {
      command: "/usr/local/bin/node",
      args: ["/usr/local/lib/node_modules/@jiayunxie/aerial/src/cli/index.js", "key", "print"],
      timeout_ms: 5000,
      refresh_interval_ms: 0
    }
  });
  const content = fs.readFileSync(result.file, "utf8");
  assert.match(content, /command = "\/usr\/local\/bin\/node"/);
  assert.match(content, /args = \[ "\/usr\/local\/lib\/node_modules\/@jiayunxie\/aerial\/src\/cli\/index\.js", "key", "print" \]/);
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
  const result = setupClaude({ model: "claude-test", apiKeyHelper: "\"/usr/local/bin/node\" \"/usr/local/lib/node_modules/@jiayunxie/aerial/src/cli/index.js\" \"key\" \"print\"" });
  const settings = JSON.parse(fs.readFileSync(result.file, "utf8"));
  assert.equal(settings.apiKeyHelper, "\"/usr/local/bin/node\" \"/usr/local/lib/node_modules/@jiayunxie/aerial/src/cli/index.js\" \"key\" \"print\"");
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

test("setupCodex writes model_reasoning_effort at root when effort is provided", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "medium" });
  const result = setupCodex({ model: "copilot-test", effort: "high" });
  const content = fs.readFileSync(result.file, "utf8");
  const rootBlock = content.split("[")[0];
  assert.match(rootBlock, /model_reasoning_effort = "high"/);
  assert.doesNotMatch(content, /\[profiles\.aerial\]/);
  assert.equal(result.effort, "high");
  assert.equal(loadConfig().defaultEffort, "medium", "Codex setup must not overwrite Claude's proxy fallback");
});

test("setupCodex preserves native Codex max effort", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "medium" });
  const result = setupCodex({ model: "copilot-test", effort: "max" });
  const content = fs.readFileSync(result.file, "utf8");
  const rootBlock = content.split("[")[0];
  assert.match(rootBlock, /model_reasoning_effort = "max"/);
  assert.equal(result.effort, "max");
  assert.equal(loadConfig().defaultEffort, "medium");
});

test("setupCodex canonicalizes none to Codex minimal", () => {
  const result = setupCodex({ model: "copilot-test", effort: "none" });
  const content = fs.readFileSync(result.file, "utf8");
  const rootBlock = content.split("[")[0];
  assert.match(rootBlock, /model_reasoning_effort = "minimal"/);
  assert.equal(result.effort, "minimal");
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

test("setupClaude writes native effortLevel and updates Aerial defaultEffort", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "medium" });
  const result = setupClaude({ model: "claude-test", effort: "low" });
  const settings = JSON.parse(fs.readFileSync(result.file, "utf8"));
  assert.equal(settings.model, "claude-test");
  assert.equal(settings.effortLevel, "low");
  assert.equal(settings.effort, undefined);
  assert.equal(settings.reasoning_effort, undefined);
  assert.equal(result.effort, "low");
  assert.equal(loadConfig().defaultEffort, "low");
});

test("setupClaude normalizes max effort to xhigh in Claude settings", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "medium" });
  const result = setupClaude({ model: "claude-test", effort: "max" });
  const settings = JSON.parse(fs.readFileSync(result.file, "utf8"));
  assert.equal(settings.effortLevel, "xhigh");
  assert.equal(result.effort, "xhigh");
  assert.equal(loadConfig().defaultEffort, "xhigh");
});

test("setupStatus exposes additive effort field with canonical or 'missing'", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "high" });
  setupCodex({ model: "copilot-test", effort: "xhigh" });
  const status = setupStatus();
  assert.equal(status.schema, "aerial.setup-status.v1");
  assert.equal(status.clients.codex.effort, "xhigh");
  assert.equal(status.clients.claude.effort, "xhigh");
});

test("setupStatus prefers Claude effortLevel over Aerial defaultEffort", () => {
  saveConfig({ ...loadConfig(), defaultEffort: "high" });
  const claudeDir = path.join(temp, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    apiKeyHelper: "aerial key print",
    effortLevel: "low",
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18181"
    }
  }, null, 2), "utf8");
  const status = setupStatus();
  assert.equal(status.clients.claude.effort, "low");
});

test("setupStatus reports codex effort 'missing' when Codex config lacks model_reasoning_effort", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, "config.toml"), "", "utf8");
  setupCodex({ model: "copilot-test" });
  const status = setupStatus();
  assert.equal(status.clients.codex.effort, "missing");
});

test("setupStatus flags legacy Codex profile effort for migration without accepting it", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const file = path.join(codexDir, "config.toml");
  fs.writeFileSync(file, [
    'model_provider = "aerial"',
    'model = "copilot-test"',
    "",
    "[model_providers.aerial]",
    'name = "Aerial"',
    'base_url = "http://127.0.0.1:18181/v1"',
    'wire_api = "responses"',
    "",
    "[model_providers.aerial.auth]",
    'command = "aerial"',
    'args = [ "key", "print" ]',
    "",
    "[profiles.aerial]",
    'model_reasoning_effort = "high"',
    ""
  ].join("\n"), "utf8");
  const status = setupStatus();
  assert.equal(status.clients.codex.state, "aerial");
  assert.equal(status.clients.codex.effort, "missing");
  assert.equal(status.clients.codex.migration, "run aerial setup codex");
});

test("setupStatus does not flag an ordinary non-Aerial profile named aerial", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const file = path.join(codexDir, "config.toml");
  fs.writeFileSync(file, [
    'model_provider = "openai"',
    'model = "gpt-4o"',
    "",
    "[profiles.aerial]",
    'model = "some-user-profile"',
    ""
  ].join("\n"), "utf8");
  const status = setupStatus();
  assert.equal(status.clients.codex.state, "not-aerial");
  assert.equal(status.clients.codex.migration, undefined);
});

test("setupStatus preserves Codex root effort 'max'", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  setupCodex({ model: "copilot-test", effort: "medium" });
  const file = path.join(codexDir, "config.toml");
  const content = fs.readFileSync(file, "utf8").replace(/model_reasoning_effort = "medium"/, 'model_reasoning_effort = "max"');
  fs.writeFileSync(file, content, "utf8");
  const status = setupStatus();
  assert.equal(status.clients.codex.effort, "max");
});

test("setupStatus reports Codex root effort 'none' as canonical 'minimal'", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  setupCodex({ model: "copilot-test", effort: "medium" });
  const file = path.join(codexDir, "config.toml");
  const content = fs.readFileSync(file, "utf8").replace(/model_reasoning_effort = "medium"/, 'model_reasoning_effort = "none"');
  fs.writeFileSync(file, content, "utf8");
  const status = setupStatus();
  assert.equal(status.clients.codex.effort, "minimal");
});

test("setupStatus reports codex effort 'missing' for non-canonical Codex root values like 'turbo'", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  setupCodex({ model: "copilot-test", effort: "medium" });
  const file = path.join(codexDir, "config.toml");
  const content = fs.readFileSync(file, "utf8").replace(/model_reasoning_effort = "medium"/, 'model_reasoning_effort = "turbo"');
  fs.writeFileSync(file, content, "utf8");
  const status = setupStatus();
  assert.equal(status.clients.codex.effort, "missing");
});

const { setTomlRootString, upsertTomlSection, removeTomlSection } = await import("../src/setup/toml.js");

test("upsertTomlSection appends the aerial block without touching other providers", () => {
  const input = ["[model_providers.openai]", 'name = "OpenAI"', 'wire_api = "chat"', ""].join("\n");
  const out = upsertTomlSection(input, "model_providers.aerial", { wire_api: "responses" });
  const doc = parseToml(out);
  assert.equal(doc.model_providers.openai.wire_api, "chat");
  assert.equal(doc.model_providers.aerial.wire_api, "responses");
});

test("setTomlRootString does not corrupt a section that has a trailing comment", () => {
  const input = ["[profiles.work] # my work profile", 'model = "gpt-old"', ""].join("\n");
  const out = setTomlRootString(input, "model", "copilot-test");
  const doc = parseToml(out);
  assert.equal(doc.model, "copilot-test");
  assert.equal(doc.profiles.work.model, "gpt-old");
});

test("upsertTomlSection preserves a root-level multiline array", () => {
  const input = ["values = [", '  "a",', '  "b",', "]", ""].join("\n");
  const out = upsertTomlSection(input, "profiles.aerial", { model: "copilot-test" });
  const doc = parseToml(out);
  assert.deepEqual(doc.values, ["a", "b"]);
  assert.equal(doc.profiles.aerial.model, "copilot-test");
});

test("upsertTomlSection preserves comments and untouched content verbatim", () => {
  const input = [
    "# my hand-written banner",
    'model = "gpt-old"',
    "",
    "[profiles.work] # work profile",
    'model = "work-model"  # do not touch',
    "",
  ].join("\n");
  const out = upsertTomlSection(input, "profiles.aerial", { model: "copilot-test" });
  assert.ok(out.includes("# my hand-written banner"));
  assert.ok(out.includes("# work profile"));
  assert.ok(out.includes("# do not touch"));
  const doc = parseToml(out);
  assert.equal(doc.profiles.aerial.model, "copilot-test");
  assert.equal(doc.profiles.work.model, "work-model");
});

test("upsertTomlSection rewrites the aerial block, dropping a superseded scalar key", () => {
  const input = [
    "[model_providers.aerial]",
    'name = "Aerial"',
    'env_key = "AERIAL_API_KEY"',
    "",
    "[model_providers.aerial.auth]",
    'command = "aerial"',
    "",
  ].join("\n");
  const out = upsertTomlSection(input, "model_providers.aerial", {
    name: "Aerial",
    base_url: "http://127.0.0.1:8787/v1",
    wire_api: "responses",
  });
  assert.doesNotMatch(out, /env_key/);
  const doc = parseToml(out);
  assert.equal(doc.model_providers.aerial.wire_api, "responses");
  assert.equal(doc.model_providers.aerial.auth.command, "aerial");
});

test("upsertTomlSection does not crash on TOML that is malformed elsewhere", () => {
  const input = ["[other]", "broken = ", "", "# trailing note", ""].join("\n");
  const out = upsertTomlSection(input, "profiles.aerial", { model: "copilot-test" });
  assert.ok(out.includes("[profiles.aerial]"));
  assert.ok(out.includes("# trailing note"));
});

test("setTomlRootString always emits parseable TOML and overwrites an existing root key", () => {
  const input = 'model = "old"\n[profiles.work]\nmodel = "gpt-old"\n';
  const out = setTomlRootString(input, "model", "new");
  const doc = parseToml(out);
  assert.equal(doc.model, "new");
  assert.equal(doc.profiles.work.model, "gpt-old");
});

test("upsertTomlSection handles a section body containing a multiline array of arrays", () => {
  const input = [
    "[model_providers.aerial]",
    'name = "Old"',
    "matrix = [",
    "  [1, 2]",
    "]",
    "after = 9",
    "",
    "[keep]",
    "k = 1",
    "",
  ].join("\n");
  const out = upsertTomlSection(input, "model_providers.aerial", { name: "Aerial", wire_api: "responses" });
  const doc = parseToml(out);
  assert.equal(doc.model_providers.aerial.wire_api, "responses");
  assert.equal(doc.keep.k, 1);
});

test("upsertTomlSection matches a non-canonical spaced heading instead of appending a duplicate", () => {
  const input = ["[ model_providers.aerial ]", 'name = "Old"', ""].join("\n");
  const out = upsertTomlSection(input, "model_providers.aerial", { name: "Aerial", wire_api: "responses" });
  const doc = parseToml(out);
  assert.equal(doc.model_providers.aerial.name, "Aerial");
  assert.equal(doc.model_providers.aerial.wire_api, "responses");
});

test("removeTomlSection sweeps a child table that is separated from its parent by another section", () => {
  const input = [
    "[profiles.aerial]",
    "x = 1",
    "",
    "[other]",
    "y = 2",
    "",
    "[profiles.aerial.env]",
    "z = 3",
    "",
  ].join("\n");
  const out = removeTomlSection(input, "profiles.aerial");
  const doc = parseToml(out);
  assert.equal(doc.profiles, undefined);
  assert.equal(doc.other.y, 2);
});

test("upsertTomlSection preserves quoted-key sections containing slashes and at-signs", () => {
  const input = [
    "[model_providers.aerial]",
    'name = "Old"',
    "",
    '[projects."/Users/jeremy/workspace"]',
    'trust_level = "trusted"',
    "",
    '[plugins."documents@openai-primary-runtime"]',
    "enabled = true",
    "",
    "[mcp_servers.context7]",
    'command = "npx"',
    "",
  ].join("\n");
  const out = upsertTomlSection(input, "model_providers.aerial", { name: "Aerial", wire_api: "responses" });
  const doc = parseToml(out);
  assert.equal(doc.model_providers.aerial.wire_api, "responses");
  assert.equal(doc.projects["/Users/jeremy/workspace"].trust_level, "trusted");
  assert.equal(doc.plugins["documents@openai-primary-runtime"].enabled, true);
  assert.equal(doc.mcp_servers.context7.command, "npx");
});

test("removeTomlSection does not swallow a following quoted-path section", () => {
  const input = [
    "[profiles.aerial]",
    'model = "old"',
    "",
    '[projects."/Users/jeremy"]',
    'trust_level = "trusted"',
    "",
    "[mcp_servers.context7]",
    'command = "npx"',
    "",
  ].join("\n");
  const out = removeTomlSection(input, "profiles.aerial");
  const doc = parseToml(out);
  assert.equal(doc.profiles, undefined);
  assert.equal(doc.projects["/Users/jeremy"].trust_level, "trusted");
  assert.equal(doc.mcp_servers.context7.command, "npx");
});

test("setTomlRootString keeps the key at root when the first section is a quoted-path header", () => {
  const input = ['[projects."/Users/jeremy"]', 'trust_level = "trusted"', ""].join("\n");
  const out = setTomlRootString(input, "model", "gpt-5.5");
  const doc = parseToml(out);
  assert.equal(doc.model, "gpt-5.5");
  assert.equal(doc.projects["/Users/jeremy"].trust_level, "trusted");
});

test("removeTomlSection drops the target block and its trailing blank line, keeping neighbors", () => {
  const input = [
    "[profiles.aerial]",
    'model = "gpt-old"',
    'model_reasoning_effort = "high"',
    "",
    "[profiles.aerial.env]",
    'API_KEY = "secret"',
    "",
    "[desktop]",
    "k = 1",
    "",
  ].join("\n");
  const out = removeTomlSection(input, "profiles.aerial");
  assert.doesNotMatch(out, /\[profiles\.aerial\]/);
  assert.doesNotMatch(out, /API_KEY/);
  const doc = parseToml(out);
  assert.equal(doc.profiles, undefined);
  assert.equal(doc.desktop.k, 1);
});

test("removeTomlSection drops target child sections even when they are not contiguous", () => {
  const input = [
    "[profiles.aerial]",
    'model = "gpt-old"',
    "",
    "[desktop]",
    "k = 1",
    "",
    "[profiles.aerial.env]",
    'API_KEY = "secret"',
    "",
  ].join("\n");
  const out = removeTomlSection(input, "profiles.aerial");
  assert.doesNotMatch(out, /\[profiles\.aerial/);
  assert.doesNotMatch(out, /API_KEY/);
  const doc = parseToml(out);
  assert.equal(doc.profiles, undefined);
  assert.equal(doc.desktop.k, 1);
});

test("removeTomlSection is a no-op when the section is absent", () => {
  const input = '[desktop]\nk = 1\n';
  const out = removeTomlSection(input, "profiles.aerial");
  assert.equal(parseToml(out).desktop.k, 1);
});

test("setupCodex removes a legacy profiles.aerial block and writes effort at root", () => {
  const codexDir = path.join(temp, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const file = path.join(codexDir, "config.toml");
  fs.writeFileSync(file, ['[profiles.aerial]', 'model = "old"', 'model_reasoning_effort = "low"', ""].join("\n"), "utf8");
  setupCodex({ model: "copilot-test", effort: "high" });
  const content = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(content, /\[profiles\.aerial\]/);
  assert.match(content.split("[")[0], /model_reasoning_effort = "high"/);
});
