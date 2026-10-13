import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkHome, cliEnv, runCli } from "./helpers.js";

const home = mkHome("directory-overrides");
Object.assign(process.env, cliEnv(home, {
  CODEX_HOME: path.join(home, "custom codex"),
  CLAUDE_CONFIG_DIR: path.join(home, "custom claude"),
  AERIAL_CONFIG_DIR: path.join(home, "Aerial 用户 & $config"),
  AERIAL_API_KEY: "aerial_directory_test_key"
}));
const { setupCodex, setupClaude, setupStatus, restoreClient, detachAllClients } = await import("../src/setup/index.js");
const { loadConfig, validateLocalAuth } = await import("../src/shared/config.js");
const { explicitConfigDir } = await import("../src/service/wrapper-render.js");

test("setup, status and restore honor both client directory overrides", () => {
  const codex = setupCodex({ model: "first" });
  const claude = setupClaude({ model: "first" });
  assert.equal(codex.file, path.join(process.env.CODEX_HOME, "config.toml"));
  assert.equal(claude.file, path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json"));
  assert.equal(explicitConfigDir(), path.resolve(process.env.AERIAL_CONFIG_DIR));
  assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
  setupCodex({ model: "second" });
  setupClaude({ model: "second" });
  restoreClient("codex");
  restoreClient("claude");
  const status = setupStatus();
  assert.equal(status.clients.codex.model, "first");
  assert.equal(status.clients.claude.model, "first");
  assert.equal(status.clients.claude.state, "aerial", "quoted helper commands are recognized");
});

test("generated auth helpers read the server key without inheriting its environment", () => {
  const codex = setupCodex({ model: "test" });
  const claude = setupClaude({ model: "test" });
  const env = { ...process.env, AERIAL_API_KEY: "", AERIAL_CONFIG_DIR: "", HOME: mkHome("helper-home"), USERPROFILE: mkHome("helper-profile") };
  const structured = spawnSync(codex.auth.command, codex.auth.args, { env, encoding: "utf8" });
  assert.equal(structured.status, 0, structured.stderr);
  assert.equal(validateLocalAuth({ authorization: `Bearer ${structured.stdout.trim()}` }, loadConfig()), true);
  const shell = spawnSync(claude.apiKeyHelper, { shell: true, env, encoding: "utf8" });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, structured.stdout);
});

test("teardown uses the same overridden client directories", () => {
  const result = detachAllClients();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(process.env.CODEX_HOME, "config.toml")), false);
  assert.equal(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json")), false);
});

test("the explicit global config directory is validated before dispatch", () => {
  const result = runCli(["--config-dir", "--help"]);
  assert.equal(result.status, 0);
  const missing = runCli(["--config-dir"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires a directory/);
});
