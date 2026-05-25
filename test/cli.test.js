import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

test("key generate does not print the raw local key", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-test-"));
  const result = spawnSync(process.execPath, ["src/cli.js", "key", "generate"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, AERIAL_CONFIG_DIR: configDir, AERIAL_API_KEY: "" }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stored privately/);
  assert.doesNotMatch(result.stdout, /aerial_[A-Za-z0-9_-]+/);
});

test("setup codex configures command-backed auth without requiring AERIAL_API_KEY in the environment", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-codex-auth-"));
  const result = spawnSync(process.execPath, ["src/cli.js", "setup", "codex", "--model", "gpt-codex-test"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AERIAL_CONFIG_DIR: path.join(home, "config"),
      AERIAL_API_KEY: "",
      AERIAL_SKIP_ENV_PERSIST: "1"
    }
  });

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-setup-all-removed-"));
  const result = spawnSync(process.execPath, ["src/cli.js", "setup", "all"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AERIAL_CONFIG_DIR: path.join(home, "config"),
      AERIAL_API_KEY: "",
      AERIAL_SKIP_ENV_PERSIST: "1"
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /aerial setup all has been removed/);
  assert.match(result.stderr, /aerial setup codex/);
  assert.match(result.stderr, /aerial setup claude/);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
});

test("setup codex --effort without a value exits 1 with a helpful message", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-effort-missing-"));
  const result = spawnSync(process.execPath, ["src/cli.js", "setup", "codex", "--model", "gpt-codex-test", "--effort"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AERIAL_CONFIG_DIR: path.join(home, "config"),
      AERIAL_API_KEY: "",
      AERIAL_SKIP_ENV_PERSIST: "1"
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--effort requires a value/);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
});

test("setup codex --effort turbo (invalid) exits 1 before writing config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-effort-invalid-"));
  const result = spawnSync(process.execPath, ["src/cli.js", "setup", "codex", "--model", "gpt-codex-test", "--effort", "turbo"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AERIAL_CONFIG_DIR: path.join(home, "config"),
      AERIAL_API_KEY: "",
      AERIAL_SKIP_ENV_PERSIST: "1"
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --effort/);
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
});

test("setup codex and setup claude keep separate model choices", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-separate-models-"));
  const common = {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AERIAL_CONFIG_DIR: path.join(home, "config"),
      AERIAL_API_KEY: "",
      AERIAL_SKIP_ENV_PERSIST: "1"
    }
  };
  const codexResult = spawnSync(process.execPath, ["src/cli.js", "setup", "codex", "--model", "gpt-codex-test"], common);
  const claudeResult = spawnSync(process.execPath, ["src/cli.js", "setup", "claude", "--model", "claude-messages-test"], common);

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
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-effort-config-"));
  const baseEnv = { ...process.env, AERIAL_CONFIG_DIR: configDir, AERIAL_API_KEY: "aerial_test_key" };
  spawnSync(process.execPath, ["src/cli.js", "key", "generate"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });

  const setHigh = spawnSync(process.execPath, ["src/cli.js", "config", "set", "defaultEffort", "high"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.equal(setHigh.status, 0, setHigh.stderr);
  const showHigh = spawnSync(process.execPath, ["src/cli.js", "config"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.match(showHigh.stdout, /"defaultEffort":\s*"high"/);

  const setMax = spawnSync(process.execPath, ["src/cli.js", "config", "set", "defaultEffort", "max"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.equal(setMax.status, 0, setMax.stderr);
  const showMax = spawnSync(process.execPath, ["src/cli.js", "config"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.match(showMax.stdout, /"defaultEffort":\s*"xhigh"/);
});

test("config set defaultEffort rejects invalid values", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-effort-config-bad-"));
  const baseEnv = { ...process.env, AERIAL_CONFIG_DIR: configDir, AERIAL_API_KEY: "aerial_test_key" };
  spawnSync(process.execPath, ["src/cli.js", "key", "generate"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });

  const result = spawnSync(process.execPath, ["src/cli.js", "config", "set", "defaultEffort", "turbo"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid --effort/);
});

test("config reset repairs an invalid config.json", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-config-reset-"));
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), "{bad json", "utf8");
  const result = spawnSync(process.execPath, ["src/cli.js", "config", "reset"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, AERIAL_CONFIG_DIR: configDir, AERIAL_API_KEY: "aerial_test_key" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reset Aerial config/);
  const config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 18181);
});

test("config set validates port before writing", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-port-config-"));
  const baseEnv = { ...process.env, AERIAL_CONFIG_DIR: configDir, AERIAL_API_KEY: "aerial_test_key" };
  const valid = spawnSync(process.execPath, ["src/cli.js", "config", "set", "port", "18182"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  let config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.port, 18182);

  const invalid = spawnSync(process.execPath, ["src/cli.js", "config", "set", "port", "NaN"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /port must be an integer/);
  config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.port, 18182);
});

test("config set host only accepts loopback hosts", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-host-config-"));
  const baseEnv = { ...process.env, AERIAL_CONFIG_DIR: configDir, AERIAL_API_KEY: "aerial_test_key" };
  const valid = spawnSync(process.execPath, ["src/cli.js", "config", "set", "host", "localhost"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  let config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.host, "localhost");

  const invalid = spawnSync(process.execPath, ["src/cli.js", "config", "set", "host", "0.0.0.0"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /host must be a loopback address/);
  config = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assert.equal(config.host, "localhost");
});

test("setup codex prints the full completion summary block", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-codex-summary-"));
  const result = spawnSync(process.execPath, ["src/cli.js", "setup", "codex", "--model", "gpt-summary", "--effort", "high"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AERIAL_CONFIG_DIR: path.join(home, "config"),
      AERIAL_API_KEY: "",
      AERIAL_SKIP_ENV_PERSIST: "1"
    }
  });
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

test("setup claude prints the full completion summary and does not claim to write effort into settings", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-claude-summary-"));
  const result = spawnSync(process.execPath, ["src/cli.js", "setup", "claude", "--model", "claude-summary", "--effort", "low"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      AERIAL_CONFIG_DIR: path.join(home, "config"),
      AERIAL_API_KEY: "",
      AERIAL_SKIP_ENV_PERSIST: "1"
    }
  });
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
  assert.match(result.stdout, /effort is applied via Aerial defaultEffort/);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.effort, undefined);
});

test("setup status --json includes additive effort field on codex and claude", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-status-effort-"));
  const baseEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AERIAL_CONFIG_DIR: path.join(home, "config"),
    AERIAL_API_KEY: "",
    AERIAL_SKIP_ENV_PERSIST: "1"
  };
  spawnSync(process.execPath, ["src/cli.js", "setup", "codex", "--model", "gpt-x", "--effort", "xhigh"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  const result = spawnSync(process.execPath, ["src/cli.js", "setup", "status", "--json"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.schema, "aerial.setup-status.v1");
  assert.equal(status.clients.codex.effort, "xhigh");
  assert.equal(status.clients.claude.effort, "xhigh");
});

test("setup status text shows effort=missing when no client has effort", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-status-missing-"));
  const baseEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AERIAL_CONFIG_DIR: path.join(home, "config"),
    AERIAL_API_KEY: "",
    AERIAL_SKIP_ENV_PERSIST: "1"
  };
  spawnSync(process.execPath, ["src/cli.js", "key", "generate"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  const result = spawnSync(process.execPath, ["src/cli.js", "setup", "status"], { cwd: path.resolve(import.meta.dirname, ".."), env: baseEnv, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex.*effort=missing/);
  assert.match(result.stdout, /claude.*effort=medium/);
});

test("aerial --help lists max alias on setup codex and claude", () => {
  const result = spawnSync(process.execPath, ["src/cli.js", "--help"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, AERIAL_API_KEY: "" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /setup codex.*--effort <low\|medium\|high\|xhigh\|max>/);
  assert.match(result.stdout, /setup claude.*--effort <low\|medium\|high\|xhigh\|max>/);
});
