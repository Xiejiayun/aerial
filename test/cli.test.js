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
  assert.match(result.stdout, /read the local Aerial key automatically/);
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
