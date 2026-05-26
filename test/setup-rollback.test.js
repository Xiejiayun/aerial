import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-rollback-test-"));
process.env.AERIAL_CONFIG_DIR = path.join(temp, "config");
process.env.HOME = temp;
process.env.USERPROFILE = temp;
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_SKIP_ENV_PERSIST = "1";

const { ensureApiKey, loadConfig, saveConfig } = await import("../src/shared/config.js");
const {
  findLatestBackup,
  codexStatus,
  claudeStatus,
  setupStatus,
  restoreClient,
  restoreAllClients
} = await import("../src/setup/index.js");
ensureApiKey();

const codexDir = path.join(temp, ".codex");
const codexFile = path.join(codexDir, "config.toml");
const claudeDir = path.join(temp, ".claude");
const claudeFile = path.join(claudeDir, "settings.json");

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function clearClientDirs() {
  fs.rmSync(codexDir, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
}

beforeEach(() => {
  clearClientDirs();
});

const AERIAL_CODEX = [
  'model_provider = "aerial"',
  'model = "gpt-4.1"',
  "",
  "[model_providers.aerial]",
  'name = "Aerial"',
  'base_url = "http://127.0.0.1:18181/v1"',
  'wire_api = "responses"',
  "",
  "[model_providers.aerial.auth]",
  'command = "aerial"',
  'args = ["key", "print"]',
  "timeout_ms = 5000",
  "refresh_interval_ms = 0",
  ""
].join("\n");

const LEGACY_ENV_KEY_CODEX = [
  'model_provider = "aerial"',
  'model = "gpt-4.1"',
  "",
  "[model_providers.aerial]",
  'name = "Aerial"',
  'base_url = "http://127.0.0.1:18181/v1"',
  'wire_api = "responses"',
  'env_key = "AERIAL_API_KEY"',
  ""
].join("\n");

const AERIAL_CLAUDE = JSON.stringify({
  apiKeyHelper: "aerial key print",
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18181", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" },
  model: "claude-sonnet-4.6"
}, null, 2);

const VALID_CODEX_BACKUP = 'model_provider = "openai"\nmodel = "gpt-4o"\n';
const VALID_CLAUDE_BACKUP = '{"keep":"original"}';

test("findLatestBackup picks the latest by ISO stamp", () => {
  writeFile(codexFile, "x = 1");
  const stamps = [
    "2026-05-19T10-00-00-000Z",
    "2026-05-20T09-00-00-000Z",
    "2026-05-19T23-59-59-999Z"
  ];
  for (const s of stamps) {
    fs.writeFileSync(`${codexFile}.aerial-backup-${s}`, "snapshot " + s);
  }
  const latest = findLatestBackup(codexFile);
  assert.equal(latest.stamp, "2026-05-20T09-00-00-000Z");
});

test("findLatestBackup ignores .aerial-pre-restore- snapshots", () => {
  writeFile(codexFile, "x = 1");
  fs.writeFileSync(`${codexFile}.aerial-pre-restore-2026-05-20T09-00-00-000Z`, "pre");
  assert.equal(findLatestBackup(codexFile), undefined);
});

test("findLatestBackup ignores backups with non-ISO stamps", () => {
  writeFile(codexFile, "x = 1");
  fs.writeFileSync(`${codexFile}.aerial-backup-zzz`, "garbage stamp");
  fs.writeFileSync(`${codexFile}.aerial-backup-2026-05-20`, "short stamp");
  fs.writeFileSync(`${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`, "valid");
  const latest = findLatestBackup(codexFile);
  assert.equal(latest.stamp, "2026-05-20T10-00-00-000Z");
});

test("findLatestBackup returns undefined when only non-ISO stamps exist", () => {
  writeFile(codexFile, "x = 1");
  fs.writeFileSync(`${codexFile}.aerial-backup-not-a-stamp`, "garbage");
  assert.equal(findLatestBackup(codexFile), undefined);
});

test("codexStatus returns missing when file does not exist", () => {
  const s = codexStatus();
  assert.equal(s.state, "missing");
  assert.equal(s.file, codexFile);
  assert.deepEqual(s.backups, []);
});

test("codexStatus returns invalid on TOML parse failure", () => {
  writeFile(codexFile, "model_provider = \"aerial\nbroken");
  const s = codexStatus();
  assert.equal(s.state, "invalid");
  assert.ok(s.error);
});

test("codexStatus returns not-aerial when no aerial signature", () => {
  writeFile(codexFile, 'model_provider = "openai"\nmodel = "gpt-4o"\n');
  assert.equal(codexStatus().state, "not-aerial");
});

test("codexStatus returns aerial when fully configured", () => {
  writeFile(codexFile, AERIAL_CODEX);
  const s = codexStatus();
  assert.equal(s.state, "aerial");
  assert.equal(s.model, "gpt-4.1");
});

test("codexStatus accepts legacy AERIAL_API_KEY env_key configs for migration", () => {
  writeFile(codexFile, LEGACY_ENV_KEY_CODEX);
  const s = codexStatus();
  assert.equal(s.state, "aerial");
  assert.equal(s.model, "gpt-4.1");
});

test("codexStatus returns aerial-stale when provider section complete but model_provider flipped", () => {
  writeFile(codexFile, AERIAL_CODEX.replace('model_provider = "aerial"', 'model_provider = "openai"'));
  assert.equal(codexStatus().state, "aerial-stale");
});

test("codexStatus returns aerial-drift on partial provider section", () => {
  const drifted = AERIAL_CODEX.replace('wire_api = "responses"', 'wire_api = "chat"');
  writeFile(codexFile, drifted);
  assert.equal(codexStatus().state, "aerial-drift");
});

test("codexStatus returns aerial-stale when provider base_url does not match host/port", () => {
  writeFile(codexFile, AERIAL_CODEX.replace('base_url = "http://127.0.0.1:18181/v1"', 'base_url = "http://127.0.0.1:19999/v1"'));
  const s = codexStatus();
  assert.equal(s.state, "aerial-stale");
  assert.equal(s.baseUrl, "http://127.0.0.1:19999/v1");
});

test("codexStatus expected base URL includes /v1 path", () => {
  writeFile(codexFile, AERIAL_CODEX.replace('base_url = "http://127.0.0.1:18181/v1"', 'base_url = "http://127.0.0.1:18181"'));
  assert.equal(codexStatus().state, "aerial-stale");
});

test("claudeStatus returns missing/invalid/not-aerial states", () => {
  assert.equal(claudeStatus().state, "missing");
  writeFile(claudeFile, "{not json");
  assert.equal(claudeStatus().state, "invalid");
  writeFile(claudeFile, JSON.stringify({ apiKeyHelper: "other" }));
  assert.equal(claudeStatus().state, "not-aerial");
});

test("claudeStatus returns aerial when helper + baseUrl match", () => {
  writeFile(claudeFile, AERIAL_CLAUDE);
  const s = claudeStatus();
  assert.equal(s.state, "aerial");
  assert.equal(s.model, "claude-sonnet-4.6");
});

test("claudeStatus returns aerial-stale when baseUrl points to different aerial port", () => {
  writeFile(claudeFile, JSON.stringify({
    apiKeyHelper: "aerial key print",
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:19999" }
  }));
  assert.equal(claudeStatus().state, "aerial-stale");
});

test("claudeStatus returns aerial-drift on partial signature", () => {
  writeFile(claudeFile, JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18181" }
  }));
  assert.equal(claudeStatus().state, "aerial-drift");
});

test("setupStatus aggregates clients and auth files", () => {
  writeFile(codexFile, AERIAL_CODEX);
  writeFile(claudeFile, AERIAL_CLAUDE);
  const s = setupStatus();
  assert.equal(s.schema, "aerial.setup-status.v1");
  assert.equal(typeof s.platform, "string");
  assert.equal(typeof s.config.host, "string");
  assert.equal(typeof s.config.port, "number");
  assert.equal(s.clients.codex.state, "aerial");
  assert.equal(s.clients.claude.state, "aerial");
  assert.equal(s.auth.api_key.exists, true);
  assert.equal(typeof s.auth.github_token.file, "string");
});

test("restoreClient returns ok+restored:false when no backup exists", () => {
  writeFile(codexFile, "current content");
  const r = restoreClient("codex");
  assert.equal(r.ok, true);
  assert.equal(r.restored, false);
  assert.equal(r.reason, "no_backup");
});

test("restoreClient restores latest backup and creates pre-restore snapshot", () => {
  writeFile(codexFile, "modified = \"by aerial\"\n");
  const olderBackup = `${codexFile}.aerial-backup-2026-05-19T10-00-00-000Z`;
  const newerBackup = `${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`;
  const olderContent = 'model_provider = "older"\nmodel = "gpt-3.5"\n';
  const newerContent = VALID_CODEX_BACKUP;
  fs.writeFileSync(olderBackup, olderContent);
  fs.writeFileSync(newerBackup, newerContent);
  const r = restoreClient("codex");
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  assert.equal(r.from, newerBackup);
  assert.equal(fs.readFileSync(codexFile, "utf8"), newerContent);
  assert.ok(r.snapshot);
  assert.match(r.snapshot, /\.aerial-pre-restore-/);
  assert.equal(fs.readFileSync(r.snapshot, "utf8"), "modified = \"by aerial\"\n");
});

test("restoreClient pre-restore snapshot does not pollute next backup search", () => {
  writeFile(codexFile, "live = 1\n");
  const backup = `${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`;
  fs.writeFileSync(backup, VALID_CODEX_BACKUP);
  restoreClient("codex");
  const latest = findLatestBackup(codexFile);
  assert.equal(latest.path, backup);
});

test("restoreClient handles missing live file but present backup", () => {
  fs.mkdirSync(codexDir, { recursive: true });
  const backup = `${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`;
  fs.writeFileSync(backup, VALID_CODEX_BACKUP);
  const r = restoreClient("codex");
  assert.equal(r.ok, true);
  assert.equal(r.restored, true);
  assert.equal(r.snapshot, undefined);
  assert.equal(fs.readFileSync(codexFile, "utf8"), VALID_CODEX_BACKUP);
});

test("restoreClient throws on EXDEV with actionable message", () => {
  writeFile(codexFile, "live = 1\n");
  const backup = `${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`;
  fs.writeFileSync(backup, VALID_CODEX_BACKUP);
  const originalRename = fs.renameSync;
  const mocked = mock.method(fs, "renameSync", (src, dst) => {
    const err = new Error("simulated cross-device link");
    err.code = "EXDEV";
    throw err;
  });
  try {
    assert.throws(() => restoreClient("codex"), /EXDEV/);
  } finally {
    mocked.mock.restore();
  }
  assert.equal(fs.renameSync, originalRename);
});

test("restoreClient unknown target throws", () => {
  assert.throws(() => restoreClient("vscode"), /Unknown restore target/);
});

test("restoreClient aborts on invalid codex TOML backup, leaving live file unchanged", () => {
  writeFile(codexFile, "live = 1\n");
  const backup = `${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`;
  fs.writeFileSync(backup, "model_provider = \"aerial\nbroken");
  assert.throws(() => restoreClient("codex"), /not valid TOML/);
  assert.equal(fs.readFileSync(codexFile, "utf8"), "live = 1\n");
  const preRestoreSnaps = fs.readdirSync(codexDir).filter((n) => n.includes(".aerial-pre-restore-"));
  assert.deepEqual(preRestoreSnaps, []);
});

test("restoreClient aborts on invalid claude JSON backup, leaving live file unchanged", () => {
  writeFile(claudeFile, JSON.stringify({ keep: true }));
  const backup = `${claudeFile}.aerial-backup-2026-05-20T10-00-00-000Z`;
  fs.writeFileSync(backup, "{not json");
  assert.throws(() => restoreClient("claude"), /not valid JSON/);
  assert.equal(JSON.parse(fs.readFileSync(claudeFile, "utf8")).keep, true);
  const preRestoreSnaps = fs.readdirSync(claudeDir).filter((n) => n.includes(".aerial-pre-restore-"));
  assert.deepEqual(preRestoreSnaps, []);
});

test("restoreClient floors mode at 0600 on POSIX", () => {
  if (process.platform === "win32") return;
  writeFile(codexFile, "live = 1\n");
  fs.chmodSync(codexFile, 0o644);
  const backup = `${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`;
  fs.writeFileSync(backup, 'model_provider = "openai"\n');
  const r = restoreClient("codex");
  assert.equal(r.restored, true);
  const restoredMode = fs.statSync(codexFile).mode & 0o777;
  assert.equal(restoredMode, 0o600);
  assert.equal(r.mode, 0o600);
});

test("restoreClient preserves restrictive existing mode on POSIX", () => {
  if (process.platform === "win32") return;
  writeFile(codexFile, "live = 1\n");
  fs.chmodSync(codexFile, 0o400);
  const backup = `${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`;
  fs.writeFileSync(backup, 'model_provider = "openai"\n');
  const r = restoreClient("codex");
  assert.equal(r.restored, true);
  const restoredMode = fs.statSync(codexFile).mode & 0o777;
  assert.equal(restoredMode, 0o400);
});

test("restoreAllClients is best-effort across clients", () => {
  writeFile(codexFile, "live = 1\n");
  fs.writeFileSync(`${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`, VALID_CODEX_BACKUP);
  writeFile(claudeFile, "{}");
  const out = restoreAllClients();
  assert.equal(out.ok, true);
  assert.equal(out.results.codex.restored, true);
  assert.equal(out.results.claude.restored, false);
  assert.equal(out.results.claude.reason, "no_backup");
});

test("restoreAllClients surfaces per-client failure without aborting siblings", () => {
  writeFile(codexFile, "live = 1\n");
  fs.writeFileSync(`${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`, VALID_CODEX_BACKUP);
  writeFile(claudeFile, JSON.stringify({ live: true }));
  fs.writeFileSync(`${claudeFile}.aerial-backup-2026-05-20T10-00-00-000Z`, VALID_CLAUDE_BACKUP);
  const claudeWritePath = fs.realpathSync(claudeFile);
  const originalRename = fs.renameSync;
  const renameSpy = mock.method(fs, "renameSync", (src, dst) => {
    if (dst === claudeFile || dst === claudeWritePath) {
      const err = new Error("simulated EXDEV on claude");
      err.code = "EXDEV";
      throw err;
    }
    return originalRename.call(fs, src, dst);
  });
  try {
    const out = restoreAllClients();
    assert.equal(out.ok, false);
    assert.equal(out.results.codex.ok, true);
    assert.equal(out.results.claude.ok, false);
    assert.match(out.results.claude.error, /EXDEV/);
  } finally {
    renameSpy.mock.restore();
  }
});

test("restoreClient backup search uses logical path even when symlinked", () => {
  if (process.platform === "win32") return;
  const realDir = path.join(temp, "real-codex");
  fs.mkdirSync(realDir, { recursive: true });
  const realFile = path.join(realDir, "config.toml");
  fs.writeFileSync(realFile, "real = true\n");
  fs.mkdirSync(codexDir, { recursive: true });
  if (fs.existsSync(codexFile)) fs.unlinkSync(codexFile);
  fs.symlinkSync(realFile, codexFile);
  const backup = `${codexFile}.aerial-backup-2026-05-20T10-00-00-000Z`;
  fs.writeFileSync(backup, VALID_CODEX_BACKUP);
  const r = restoreClient("codex");
  assert.equal(r.restored, true);
  assert.equal(r.file, fs.realpathSync(codexFile));
  assert.equal(fs.readFileSync(realFile, "utf8"), VALID_CODEX_BACKUP);
});
