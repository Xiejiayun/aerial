import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-log-test-"));
process.env.AERIAL_CONFIG_DIR = path.join(temp, "config");
process.env.HOME = temp;
process.env.USERPROFILE = temp;
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_SKIP_ENV_PERSIST = "1";

const { logEvent, logPaths, _resetForTests } = await import("../src/log.js");

function freshLogFile(label) {
  const dir = fs.mkdtempSync(path.join(temp, `${label}-`));
  return path.join(dir, "aerial.log");
}

function reset() {
  _resetForTests();
  delete process.env.AERIAL_LOG_FILE;
  delete process.env.AERIAL_LOG_MAX_BYTES;
  delete process.env.AERIAL_LOG_BACKUPS;
}

test("logEvent without AERIAL_LOG_FILE writes to stderr only and never creates a file", () => {
  reset();
  const probeFile = path.join(temp, "should-not-exist", "aerial.log");
  const originalError = console.error;
  let captured;
  console.error = (line) => { captured = line; };
  try {
    logEvent("stderr_only_event", { foo: "bar" });
  } finally {
    console.error = originalError;
  }
  assert.ok(captured, "expected console.error to be invoked");
  const obj = JSON.parse(captured);
  assert.equal(obj.event, "stderr_only_event");
  assert.equal(obj.foo, "bar");
  assert.ok(!fs.existsSync(probeFile));
  const paths = logPaths();
  assert.equal(paths.enabled, false);
  assert.equal(paths.file, undefined);
});

test("logEvent with AERIAL_LOG_FILE writes to file and suppresses console.error", () => {
  reset();
  const file = freshLogFile("write-file");
  process.env.AERIAL_LOG_FILE = file;
  const originalError = console.error;
  let stderrCalled = false;
  console.error = () => { stderrCalled = true; };
  try {
    logEvent("file_event", { hello: "world" });
  } finally {
    console.error = originalError;
  }
  assert.equal(stderrCalled, false, "structured log must not bleed into stderr/stdio in service mode");
  const text = fs.readFileSync(file, "utf8").trim();
  const obj = JSON.parse(text);
  assert.equal(obj.event, "file_event");
  assert.equal(obj.hello, "world");
});

test("logEvent redacts authorization/token/apiKey/body fields when writing to file", () => {
  reset();
  const file = freshLogFile("redact");
  process.env.AERIAL_LOG_FILE = file;
  logEvent("redact_test", {
    authorization: "Bearer SECRET",
    token: "tkn-secret",
    apiKey: "ak-secret",
    api_key: "ak-secret2",
    githubToken: "ghs_secret",
    body: { sensitive: true },
    password: "p",
    secret: "s",
    safe: "ok"
  });
  const content = fs.readFileSync(file, "utf8");
  assert.ok(!content.includes("SECRET"));
  assert.ok(!content.includes("tkn-secret"));
  assert.ok(!content.includes("ak-secret"));
  assert.ok(!content.includes("ghs_secret"));
  assert.ok(!content.includes("sensitive"));
  assert.match(content, /"safe":"ok"/);
});

test("logEvent recursively redacts sensitive keys and token-shaped string values", () => {
  reset();
  const file = freshLogFile("redact-recursive");
  process.env.AERIAL_LOG_FILE = file;
  const circular = { label: "loop" };
  circular.self = circular;
  const localKey = "aerial_" + "abcdefghijklmnopqrstuvwxyzABCDEF";
  logEvent("recursive_redact", {
    nested: {
      access_token: "ghs_abcdefghijklmnopqrstuvwxyz123456",
      message: `upstream said Bearer ${localKey} and jwt abcdefghij.klmnopqrst.uvwxyzABCD`,
      usage: { input_tokens: 11, output_tokens: 5 }
    },
    list: ["github_pat_abcdefghijklmnopqrstuvwxyz_1234567890"],
    circular,
    safe: "ok"
  });
  const content = fs.readFileSync(file, "utf8");
  assert.ok(!content.includes("ghs_abcdefghijklmnopqrstuvwxyz123456"));
  assert.ok(!content.includes(localKey));
  assert.ok(!content.includes("github_pat_abcdefghijklmnopqrstuvwxyz_1234567890"));
  assert.ok(!content.includes("abcdefghij.klmnopqrst.uvwxyzABCD"));
  assert.match(content, /"message":"upstream said Bearer \[redacted\] and jwt \[redacted\]"/);
  assert.match(content, /"input_tokens":11/);
  assert.match(content, /"output_tokens":5/);
  assert.match(content, /"safe":"ok"/);
  assert.match(content, /\[redacted circular\]/);
});

test("logEvent rotates after primary log exceeds AERIAL_LOG_MAX_BYTES default 5 MiB", () => {
  reset();
  const file = freshLogFile("rotate-default");
  process.env.AERIAL_LOG_FILE = file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1, "x"));
  logEvent("rotate_trigger", { n: 1 });
  assert.ok(fs.existsSync(`${file}.1`));
  const fresh = fs.readFileSync(file, "utf8").trim();
  const obj = JSON.parse(fresh);
  assert.equal(obj.event, "rotate_trigger");
});

test("logEvent honors AERIAL_LOG_MAX_BYTES override for rotation", () => {
  reset();
  const file = freshLogFile("rotate-override");
  process.env.AERIAL_LOG_FILE = file;
  process.env.AERIAL_LOG_MAX_BYTES = String(1024);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(2048, "x"));
  logEvent("override_rotate", { n: 1 });
  assert.ok(fs.existsSync(`${file}.1`));
});

test("logEvent truncates lines larger than 64 KiB to a valid JSON marker", () => {
  reset();
  const file = freshLogFile("truncate");
  process.env.AERIAL_LOG_FILE = file;
  const big = "x".repeat(80 * 1024);
  logEvent("big_event", { data: big });
  const content = fs.readFileSync(file, "utf8").trim();
  const obj = JSON.parse(content);
  assert.equal(obj.event, "big_event");
  assert.equal(obj.truncated, true);
  assert.equal(typeof obj.originalBytes, "number");
  assert.ok(obj.originalBytes > 64 * 1024);
});

test("logEvent disables file logging gracefully when AERIAL_LOG_FILE parent cannot be created", () => {
  reset();
  const dir = fs.mkdtempSync(path.join(temp, "block-"));
  const blocker = path.join(dir, "logs");
  fs.writeFileSync(blocker, "I am a file, not a directory");
  process.env.AERIAL_LOG_FILE = path.join(blocker, "aerial.log");
  assert.doesNotThrow(() => logEvent("blocked", { n: 1 }));
});

test("logPaths reports AERIAL_LOG_FILE configuration and defaults", () => {
  reset();
  const noFile = logPaths();
  assert.equal(noFile.enabled, false);
  assert.equal(noFile.maxFileBytes, 5 * 1024 * 1024);
  assert.equal(noFile.maxLineBytes, 64 * 1024);
  assert.equal(noFile.rotateKeep, 3);

  const file = freshLogFile("paths");
  process.env.AERIAL_LOG_FILE = file;
  process.env.AERIAL_LOG_MAX_BYTES = String(2 * 1024 * 1024);
  process.env.AERIAL_LOG_BACKUPS = "4";
  const paths = logPaths();
  assert.equal(paths.enabled, true);
  assert.equal(paths.file, file);
  assert.equal(paths.maxFileBytes, 2 * 1024 * 1024);
  assert.equal(paths.rotateKeep, 4);
});

test("rotate preserves last N ring entries (AERIAL_LOG_BACKUPS) and overwrites older ones", () => {
  reset();
  const file = freshLogFile("ring");
  process.env.AERIAL_LOG_FILE = file;
  process.env.AERIAL_LOG_BACKUPS = "3";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.3`, "old-3");
  fs.writeFileSync(`${file}.2`, "old-2");
  fs.writeFileSync(`${file}.1`, "old-1");
  fs.writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1, "x"));
  logEvent("trigger_rotate", {});
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.existsSync(`${file}.2`));
  assert.ok(fs.existsSync(`${file}.3`));
  assert.equal(fs.readFileSync(`${file}.3`, "utf8"), "old-2");
});
