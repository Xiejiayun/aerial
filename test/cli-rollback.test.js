import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cliPath = path.join(repoRoot, "src", "cli.js");

function mkHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aerial-cli-rb-${label}-`));
}

function runCli(args, home) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AERIAL_CONFIG_DIR: path.join(home, "config"),
    AERIAL_API_KEY: "aerial_test_key",
    AERIAL_SKIP_ENV_PERSIST: "1"
  };
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
}

test("aerial setup status --json exits 0 and emits parseable schema", () => {
  const home = mkHome("status-json");
  const r = runCli(["setup", "status", "--json"], home);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, "aerial.setup-status.v1");
  assert.equal(typeof doc.platform, "string");
  assert.equal(typeof doc.config.host, "string");
  assert.equal(typeof doc.config.port, "number");
  assert.ok(doc.clients.codex);
  assert.ok(doc.clients.claude);
  assert.ok(doc.auth.api_key);
  assert.ok(doc.auth.github_token);
});

test("aerial setup restore codex without --latest exits 1", () => {
  const home = mkHome("no-latest");
  const r = runCli(["setup", "restore", "codex"], home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only --latest is supported/);
});

test("aerial setup restore codex --latest exits 0 when no backup", () => {
  const home = mkHome("no-backup");
  const r = runCli(["setup", "restore", "codex", "--latest"], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no backup to restore/);
});

test("aerial disable exits 0 with no backups and notes service uninstall unavailable", () => {
  const home = mkHome("disable-empty");
  const r = runCli(["disable"], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /service uninstall: not available until service support is installed/);
});

test("aerial setup restore codex --latest exits 1 when backup is corrupt and leaves live file unchanged", () => {
  const home = mkHome("corrupt");
  const codexFile = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(codexFile), { recursive: true });
  const liveContent = "live = 1\n";
  fs.writeFileSync(codexFile, liveContent);
  fs.writeFileSync(`${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`, 'model_provider = "aerial\nbroken');
  const r = runCli(["setup", "restore", "codex", "--latest"], home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid TOML/);
  assert.equal(fs.readFileSync(codexFile, "utf8"), liveContent);
  const preRestore = fs.readdirSync(path.dirname(codexFile)).filter((n) => n.includes(".aerial-pre-restore-"));
  assert.deepEqual(preRestore, []);
});
