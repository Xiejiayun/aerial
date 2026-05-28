import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { cliEnv, configEnv, mkHome, repoRoot, runCli } from "./helpers.js";

test("key generate does not print the raw local key", () => {
  const { env } = configEnv("cli-test", { AERIAL_API_KEY: "" });
  const result = runCli(["key", "generate"], { env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stored privately/);
  assert.doesNotMatch(result.stdout, /aerial_[A-Za-z0-9_-]+/);
});

test("setup codex configures command-backed auth without requiring AERIAL_API_KEY in the environment", () => {
  const home = mkHome("cli-codex-auth");
  const result = runCli(["setup", "codex", "--model", "gpt-codex-test"], { home });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured Codex/);
  assert.match(result.stdout, /cli: Codex/);
  assert.match(result.stdout, /auth: command-backed local Aerial key/);
  const content = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  assert.match(content, /\[model_providers\.aerial\.auth\]/);
  assert.match(content, /args = \[.*"key", "print"\]/);
  assert.match(content, /model = "gpt-codex-test"/);
  assert.doesNotMatch(content, /env_key = "AERIAL_API_KEY"/);
});

test("setup all is not a client setup command", () => {
  const home = mkHome("cli-setup-all-removed");
  const result = runCli(["setup", "all"], { home });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /aerial setup all has been removed/);
  assert.match(result.stderr, /aerial setup codex/);
  assert.match(result.stderr, /aerial setup claude/);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
});

test("setup codex --effort without a value exits 1 with a helpful message", () => {
  const home = mkHome("cli-effort-missing");
  const result = runCli(["setup", "codex", "--model", "gpt-codex-test", "--effort"], { home });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--effort requires a value/);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
});

test("setup codex --effort turbo (invalid) exits 1 before writing config", () => {
  const home = mkHome("cli-effort-invalid");
  const result = runCli(["setup", "codex", "--model", "gpt-codex-test", "--effort", "turbo"], { home });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --effort/);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
});

test("setup codex and setup claude keep separate model choices", () => {
  const home = mkHome("cli-separate-models");
  const env = cliEnv(home);
  const codexResult = runCli(["setup", "codex", "--model", "gpt-codex-test"], { env });
  const claudeResult = runCli(["setup", "claude", "--model", "claude-messages-test"], { env });

  assert.equal(codexResult.status, 0, codexResult.stderr);
  assert.equal(claudeResult.status, 0, claudeResult.stderr);
  const codex = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
  const claude = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.match(codex, /model = "gpt-codex-test"/);
  assert.equal(claude.model, "claude-messages-test");
  assert.match(claude.apiKeyHelper, /key" "print"/);
  assert.doesNotMatch(claude.apiKeyHelper, /^aerial key print$/);
});

test("config set defaultEffort accepts low/medium/high/xhigh and max alias", () => {
  const { env: baseEnv } = configEnv("cli-effort-config");
  runCli(["key", "generate"], { env: baseEnv });

  const setHigh = runCli(["config", "set", "defaultEffort", "high"], { env: baseEnv });
  assert.equal(setHigh.status, 0, setHigh.stderr);
  const showHigh = runCli(["config"], { env: baseEnv });
  assert.match(showHigh.stdout, /"defaultEffort":\s*"high"/);

  const setMax = runCli(["config", "set", "defaultEffort", "max"], { env: baseEnv });
  assert.equal(setMax.status, 0, setMax.stderr);
  const showMax = runCli(["config"], { env: baseEnv });
  assert.match(showMax.stdout, /"defaultEffort":\s*"xhigh"/);
});

test("config set defaultEffort rejects invalid values", () => {
  const { env: baseEnv } = configEnv("cli-effort-config-bad");
  runCli(["key", "generate"], { env: baseEnv });

  const result = runCli(["config", "set", "defaultEffort", "turbo"], { env: baseEnv });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --effort/);
});

test("config reset repairs an invalid config.json", () => {
  const { configDir, env } = configEnv("cli-config-reset");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), "{bad json", "utf8");
  const result = runCli(["config", "reset"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reset Aerial config/);
  const config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 18181);
});

test("config set validates port before writing", () => {
  const { configDir, env: baseEnv } = configEnv("cli-port-config");
  const valid = runCli(["config", "set", "port", "18182"], { env: baseEnv });
  assert.equal(valid.status, 0, valid.stderr);
  let config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.port, 18182);

  const invalid = runCli(["config", "set", "port", "NaN"], { env: baseEnv });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /port must be an integer/);
  config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.port, 18182);
});

test("config set host only accepts loopback hosts", () => {
  const { configDir, env: baseEnv } = configEnv("cli-host-config");
  const valid = runCli(["config", "set", "host", "localhost"], { env: baseEnv });
  assert.equal(valid.status, 0, valid.stderr);
  let config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.host, "localhost");

  const invalid = runCli(["config", "set", "host", "0.0.0.0"], { env: baseEnv });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /host must be a loopback address/);
  config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.host, "localhost");
});

test("setup codex prints the full completion summary block", () => {
  const home = mkHome("cli-codex-summary");
  const result = runCli(["setup", "codex", "--model", "gpt-summary", "--effort", "high"], { home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured Codex/);
  assert.match(result.stdout, /cli: Codex/);
  assert.match(result.stdout, /model: gpt-summary/);
  assert.match(result.stdout, /effort: high/);
  assert.match(result.stdout, /proxy: http:\/\/127\.0\.0\.1:18181\/v1/);
  assert.match(result.stdout, /config: .*\.codex.*config\.toml/);
  assert.match(result.stdout, /aerial config: /);
  assert.match(result.stdout, /aerial defaultEffort: high/);
  assert.match(result.stdout, /backup: none/);
  assert.match(result.stdout, /auth: command-backed local Aerial key/);
  assert.match(result.stdout, /note: restart Codex/);
});

test("setup claude prints the full completion summary and writes effortLevel", () => {
  const home = mkHome("cli-claude-summary");
  const result = runCli(["setup", "claude", "--model", "claude-summary", "--effort", "low"], { home });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured Claude Code/);
  assert.match(result.stdout, /cli: Claude Code/);
  assert.match(result.stdout, /model: claude-summary/);
  assert.match(result.stdout, /effort: low/);
  assert.match(result.stdout, /proxy: http:\/\/127\.0\.0\.1:18181/);
  assert.match(result.stdout, /config: .*\.claude.*settings\.json/);
  assert.match(result.stdout, /aerial config: /);
  assert.match(result.stdout, /aerial defaultEffort: low/);
  assert.match(result.stdout, /auth: apiKeyHelper local Aerial key/);
  assert.match(result.stdout, /effort is written to Claude settings\.json effortLevel/);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.effortLevel, "low");
  assert.equal(settings.effort, undefined);
});

test("setup status --json includes additive effort field on codex and claude", () => {
  const home = mkHome("cli-status-effort");
  const baseEnv = cliEnv(home);
  runCli(["setup", "codex", "--model", "gpt-x", "--effort", "xhigh"], { env: baseEnv });
  const result = runCli(["setup", "status", "--json"], { env: baseEnv });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.schema, "aerial.setup-status.v1");
  assert.equal(status.clients.codex.effort, "xhigh");
  assert.equal(status.clients.claude.effort, "xhigh");
});

test("setup status text shows effort=missing when no client has effort", () => {
  const home = mkHome("cli-status-missing");
  const baseEnv = cliEnv(home);
  runCli(["key", "generate"], { env: baseEnv });
  const result = runCli(["setup", "status"], { env: baseEnv });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex.*effort=missing/);
  assert.match(result.stdout, /claude.*effort=medium/);
});

test("aerial --help lists max alias on setup codex and claude", () => {
  const result = runCli(["--help"], { env: { ...process.env, AERIAL_API_KEY: "" }, cwd: repoRoot });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /setup codex.*--effort <low\|medium\|high\|xhigh\|max>/);
  assert.match(result.stdout, /setup claude.*--effort <low\|medium\|high\|xhigh\|max>/);
  assert.match(result.stdout, /proxy status\|enable\|disable/);
});
