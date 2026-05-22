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
  const result = spawnSync(process.execPath, ["src/cli.js", "setup", "codex"], {
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
  assert.doesNotMatch(content, /env_key = "AERIAL_API_KEY"/);
});
