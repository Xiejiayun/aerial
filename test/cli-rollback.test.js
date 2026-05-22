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

function runCli(args, home, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AERIAL_CONFIG_DIR: path.join(home, "config"),
    AERIAL_LOG_DIR: path.join(home, "logs"),
    AERIAL_API_KEY: "aerial_test_key",
    AERIAL_SKIP_ENV_PERSIST: "1",
    AERIAL_SERVICE_DRYRUN: "1",
    ...extraEnv
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
  assert.ok(["missing", "file", "env"].includes(doc.auth.github_token.source), `unexpected github_token.source=${doc.auth.github_token.source}`);
  assert.equal(doc.auth.github_token.exists, doc.auth.github_token.source !== "missing");
});

test("aerial status --json exits non-zero when setup/service is incomplete and emits aggregate schema", () => {
  const home = mkHome("status-json-aggregate");
  const r = runCli(["status", "--json"], home, { AERIAL_GITHUB_TOKEN: "" });
  assert.equal(r.status, 1);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, "aerial.status.v1");
  assert.ok(doc.setup);
  assert.ok(doc.service);
  assert.ok(Array.isArray(doc.nextSteps));
  assert.ok(Array.isArray(doc.hints));
  assert.equal(doc.ok, false);
  assert.equal(doc.setup.auth.github_token.source, "missing");
  assert.ok(doc.nextSteps.some((s) => /aerial login/.test(s)));
});

test("aerial status --json with env-only GitHub token surfaces hint and does not flip ok=false on that basis", () => {
  const home = mkHome("status-json-env-hint");
  const r = runCli(["status", "--json"], home, { AERIAL_GITHUB_TOKEN: "github-env-token" });
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.setup.auth.github_token.source, "env");
  assert.equal(doc.setup.auth.github_token.exists, true);
  assert.ok(doc.hints.some((h) => /AERIAL_GITHUB_TOKEN/.test(h)));
  assert.ok(!doc.nextSteps.some((s) => /aerial login/.test(s)));
});

test("aerial status --json with whitespace AERIAL_GITHUB_TOKEN treats login as missing", () => {
  const home = mkHome("status-json-env-whitespace");
  const r = runCli(["status", "--json"], home, { AERIAL_GITHUB_TOKEN: "   " });
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.setup.auth.github_token.source, "missing");
  assert.equal(doc.setup.auth.github_token.exists, false);
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

test("aerial disable exits 0 with no backups and reports service uninstall result on unsupported platforms", () => {
  const home = mkHome("disable-empty");
  const r = runCli(["disable"], home);
  assert.equal(r.status, 0, r.stderr);
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.match(r.stdout, /service uninstall: (ok|no service installed)/);
  } else {
    assert.match(r.stdout, /service uninstall: skipped/);
  }
});

test("aerial service install --dry-run via AERIAL_SERVICE_DRYRUN exits 0 on supported platforms", { skip: process.platform !== "darwin" && process.platform !== "win32" }, () => {
  const home = mkHome("svc-install");
  const r = runCli(["service", "install"], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Service installed/);
});

test("aerial service install on linux exits 1 with unsupported-platform message", { skip: process.platform === "darwin" || process.platform === "win32" }, () => {
  const home = mkHome("svc-install-linux");
  const r = runCli(["service", "install"], home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unsupported platform/);
});

test("aerial service status --json emits aerial.service-status.v1", () => {
  const home = mkHome("svc-status");
  const r = runCli(["service", "status", "--json"], home);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, "aerial.service-status.v1");
  assert.equal(typeof doc.platform, "string");
  assert.ok(doc.service);
  assert.ok(doc.health);
  assert.ok(doc.logs);
  assert.ok(doc.auth);
  if (process.platform === "darwin" || process.platform === "win32") {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(doc.supported, true);
  } else {
    assert.equal(r.status, 1);
    assert.equal(doc.supported, false);
  }
});

test("aerial service stop on not-installed exits 0 with note (idempotent)", { skip: process.platform !== "darwin" && process.platform !== "win32" }, () => {
  const home = mkHome("svc-stop-noop");
  const r = runCli(["service", "stop"], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not installed/);
});

test("aerial service uninstall on not-installed exits 0 with note (idempotent)", { skip: process.platform !== "darwin" && process.platform !== "win32" }, () => {
  const home = mkHome("svc-uninstall-noop");
  const r = runCli(["service", "uninstall"], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no service installed/);
});

test("aerial service uninstall surfaces reason + retry message when /Delete fails (Windows)", { skip: process.platform !== "win32" }, () => {
  const home = mkHome("svc-uninstall-fail");
  const r = runCli(["service", "uninstall"], home, {
    AERIAL_SERVICE_DRYRUN_INSTALLED: "1",
    AERIAL_SERVICE_DRYRUN_FAIL: "delete"
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAILED \(delete_failed\)/);
  assert.match(r.stdout, /schtasks \/Delete failed/);
  assert.match(r.stdout, /Retry with `aerial service uninstall`/);
  assert.match(r.stdout, /schtasks stderr: ERROR: Access is denied\./);
});

test("aerial disable surfaces uninstall reason + retry message on Windows when /Delete fails", { skip: process.platform !== "win32" }, () => {
  const home = mkHome("disable-uninstall-fail");
  const r = runCli(["disable"], home, {
    AERIAL_SERVICE_DRYRUN_INSTALLED: "1",
    AERIAL_SERVICE_DRYRUN_FAIL: "delete"
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /service uninstall: FAILED \(delete_failed\)/);
  assert.match(r.stdout, /schtasks \/Delete failed/);
});

test("aerial service start without install exits 1 with not_installed reason", { skip: process.platform !== "darwin" && process.platform !== "win32" }, () => {
  const home = mkHome("svc-start-not-installed");
  const r = runCli(["service", "start"], home);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not_installed|service install/);
});

test("aerial service unknown subcommand exits 1", () => {
  const home = mkHome("svc-unknown");
  const r = runCli(["service", "wat"], home);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown service subcommand/);
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

test("aerial login fast-path: file token present exits 0 with --force hint", () => {
  const home = mkHome("login-file-fast");
  const cfgDir = path.join(home, "config");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "github_token"), "ghp_existing_file_token\n");
  const r = runCli(["login"], home, { AERIAL_GITHUB_TOKEN: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /GitHub login already exists \(not verified\)/);
  assert.match(r.stdout, /--force/);
});

test("aerial login fast-path: env token present exits 0 with env-specific copy", () => {
  const home = mkHome("login-env-fast");
  const r = runCli(["login"], home, { AERIAL_GITHUB_TOKEN: "ghp_env_token" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /AERIAL_GITHUB_TOKEN/);
  assert.match(r.stdout, /not verified/);
});

test("aerial login --force with AERIAL_GITHUB_TOKEN set exits 1 and tells user to unset", () => {
  const home = mkHome("login-force-env-refuse");
  const r = runCli(["login", "--force"], home, { AERIAL_GITHUB_TOKEN: "ghp_env_token" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unset/);
  assert.match(r.stderr, /AERIAL_GITHUB_TOKEN/);
});

test("aerial login with whitespace-only AERIAL_GITHUB_TOKEN and no file token falls through past fast-paths (does not hit network in test mode)", () => {
  const home = mkHome("login-whitespace-env");
  const r = runCli(["login"], home, { AERIAL_GITHUB_TOKEN: "   ", AERIAL_TEST_LOGIN_NO_NETWORK: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /already exists/);
  assert.doesNotMatch(r.stdout, /AERIAL_GITHUB_TOKEN.*not verified/);
  assert.match(r.stdout, /skipping GitHub device flow/);
});
