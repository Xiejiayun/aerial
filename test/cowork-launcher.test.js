import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { buildCoworkClaudeSettings, buildCoworkClaudeEnvironment, launchCoworkClaude, validateClaudeArguments } from "../src/cowork/launcher.js";

const sessionShape = () => ({ baseUrl: "http://127.0.0.1:12345", apiKey: "synthetic-session-key", model: "cowork/claude-test", capabilities: { clientEffort: "low" } });
const version = () => ({ status: 0, stdout: "2.1.281 (Claude Code)\n" });

test("Cowork settings pin all auxiliary models and auth to the local session without native-model claims", () => {
  const settings = buildCoworkClaudeSettings(sessionShape(), path.join(os.tmpdir(), "test helper.cjs"));
  assert.equal(settings.model, "cowork/claude-test");
  assert.deepEqual(settings.modelOverrides, { "cowork/claude-test": "cowork/claude-test" });
  assert.equal(settings.alwaysThinkingEnabled, false);
  assert.equal(settings.env.MAX_THINKING_TOKENS, "0");
  assert.equal(settings.env.API_TIMEOUT_MS, "960000");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, settings.model);
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, settings.model);
  assert.equal(settings.env.CLAUDE_CODE_USE_BEDROCK, "0");
  assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, "low");
  assert.doesNotMatch(settings.apiKeyHelper, /synthetic-session-key/);
  const env = buildCoworkClaudeEnvironment(settings, { PATH: "preserved", ANTHROPIC_API_KEY: "old-key", ANTHROPIC_FOUNDRY_BASE_URL: "https://old.test", CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_OAUTH_TOKEN: "old-auth" });
  assert.equal(env.PATH, "preserved");
  assert.equal(env.ANTHROPIC_FOUNDRY_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, "synthetic-session-key");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "");
});

test("Cowork rejects non-loopback sessions, managed providers and conflicting Claude options", () => {
  assert.throws(() => buildCoworkClaudeSettings({ ...sessionShape(), baseUrl: "https://remote.test" }, "helper"), /loopback/);
  assert.throws(() => buildCoworkClaudeEnvironment({ env: {} }, { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1" }), /managed by its host/);
  for (const option of ["--model=other", "--fallback-model", "--settings", "--setting-sources", "--cloud", "--background", "--effort", "--resume"]) assert.throws(() => validateClaudeArguments([option]), /not supported/);
  assert.doesNotThrow(() => validateClaudeArguments(["--print", "hello", "--tools", "Read,Write", "--permission-mode", "acceptEdits"]));
});

test("Cowork launcher keeps global settings unchanged, uses child-only settings and removes its own secret files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-launcher-test-"));
  const globalSettings = path.join(root, "user-settings.json");
  fs.writeFileSync(globalSettings, '{"permissions":{"deny":["Bash"]}}\n');
  const original = fs.readFileSync(globalSettings, "utf8");
  let directory, opened = 0, closed = 0, captured;
  const signals = new EventEmitter();
  const result = await launchCoworkClaude({
    model: "cowork/claude-test", executable: "claude.exe", args: ["--print", "hello"],
    cwd: root, env: { TEST_SENTINEL: "preserved" }, signals, runVersion: version,
    openSession: async ({ model }) => { opened++; assert.equal(model, "cowork/claude-test"); return { ...sessionShape(), close: async () => { closed++; } }; },
    makeSessionDirectory: () => directory = fs.mkdtempSync(path.join(root, "session-")),
    writeSettings: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    spawnImpl: (executable, args, options) => {
      captured = { executable, args, options };
      const settingsFile = args[args.indexOf("--settings") + 1];
      const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, "synthetic-session-key");
      assert.equal(options.stdio, "inherit");
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    }
  });
  assert.equal(result.exitCode, 0);
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.readFileSync(globalSettings, "utf8"), original);
  assert.equal(captured.options.env.TEST_SENTINEL, "preserved");
  assert.ok(!captured.args.includes("--setting-sources"));
  assert.ok(!captured.args.includes("--dangerously-skip-permissions"));
  assert.doesNotMatch(JSON.stringify(captured.args), /synthetic-session-key/);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  fs.unlinkSync(globalSettings);
  fs.rmdirSync(root);
});

test("Cowork cleanup closes the session and removes temporary settings after a spawn failure", async () => {
  let directory, closed = 0;
  await assert.rejects(launchCoworkClaude({
    model: "cowork/claude-test", env: {}, runVersion: version,
    openSession: async () => ({ ...sessionShape(), close: async () => { closed++; } }),
    makeSessionDirectory: () => directory = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-launcher-failed-")),
    writeSettings: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    spawnImpl: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("spawn failed"))); return child; }
  }), /spawn failed/);
  assert.equal(closed, 1);
  assert.equal(fs.existsSync(directory), false);
});

test("unverified Claude versions fail before opening an authenticated session", async () => {
  await assert.rejects(launchCoworkClaude({
    model: "cowork/claude-test", env: {},
    runVersion: () => ({ status: 0, stdout: "9.0.0 (Claude Code)" }),
    openSession: async () => { assert.fail("must not open session"); }
  }), /verified with Claude Code/);
});

test("interrupting Claude closes the local session exactly once and reports remote uncertainty", async () => {
  const signals = new EventEmitter();
  const warnings = [], kills = [];
  let closed = 0;
  const result = await launchCoworkClaude({
    model: "cowork/claude-test", env: {}, runVersion: version, signals, warn: message => warnings.push(message),
    openSession: async () => ({ ...sessionShape(), close: async () => { closed++; } }),
    makeSessionDirectory: () => fs.mkdtempSync(path.join(os.tmpdir(), "aerial-launcher-interrupt-")),
    writeSettings: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.kill = signal => { kills.push(signal); queueMicrotask(() => child.emit("close", null, signal)); };
      queueMicrotask(() => signals.emit("SIGINT"));
      return child;
    }
  });
  assert.equal(result.exitCode, 130);
  assert.equal(closed, 1);
  assert.deepEqual(kills, ["SIGINT"]);
  assert.match(warnings.join("\n"), /remote task may still be running/);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("an explicitly selected upstream ID may resolve only through its matching recorded route", async () => {
  const result = await launchCoworkClaude({
    model: "exact-upstream-id", env: {}, runVersion: version,
    openSession: async () => ({ ...sessionShape(), route: { upstreamId: "exact-upstream-id", publicId: "cowork/claude-test" }, close: async () => {} }),
    makeSessionDirectory: () => fs.mkdtempSync(path.join(os.tmpdir(), "aerial-launcher-upstream-")),
    writeSettings: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    spawnImpl: (_file, args) => {
      assert.equal(args[args.indexOf("--model") + 1], "cowork/claude-test");
      const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0, null)); return child;
    }
  });
  assert.equal(result.exitCode, 0);
  await assert.rejects(launchCoworkClaude({
    model: "unrelated-route", env: {}, runVersion: version,
    openSession: async () => ({ ...sessionShape(), route: { upstreamId: "exact-upstream-id", publicId: "cowork/claude-test" }, close: async () => {} })
  }), /different model route/);
});

test("successful print output without any Cowork request fails routing verification", async () => {
  for (const args of [["--print", "hello"], ["-p=hello"], ["--print=hello"]]) {
    let closed = 0;
    await assert.rejects(launchCoworkClaude({
      model: "cowork/claude-test", args, env: {}, runVersion: version,
      openSession: async () => ({ ...sessionShape(), stats: { requests: 0 }, close: async () => { closed++; } }),
      makeSessionDirectory: () => fs.mkdtempSync(path.join(os.tmpdir(), "aerial-launcher-unused-")),
      writeSettings: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
      spawnImpl: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0, null)); return child; }
    }), error => error.code === "ROUTE_NOT_USED");
    assert.equal(closed, 1);
  }
});

test("Claude help does not require an inference request even with --print", async () => {
  const result = await launchCoworkClaude({
    model: "cowork/claude-test", args: ["--print", "--help"], env: {}, runVersion: version,
    openSession: async () => ({ ...sessionShape(), stats: { requests: 0 }, close: async () => {} }),
    makeSessionDirectory: () => fs.mkdtempSync(path.join(os.tmpdir(), "aerial-launcher-help-")),
    writeSettings: (file, value) => fs.writeFileSync(file, JSON.stringify(value)),
    spawnImpl: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0, null)); return child; }
  });
  assert.equal(result.exitCode, 0);
});

test("interrupting startup aborts authentication before a Claude child exists", async () => {
  const signals = new EventEmitter();
  let signal;
  const result = await launchCoworkClaude({
    model: "cowork/claude-test", env: {}, runVersion: version, signals, warn: () => {},
    openSession: async options => {
      signal = options.signal;
      queueMicrotask(() => signals.emit("SIGINT"));
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    spawnImpl: () => assert.fail("must not spawn a child after startup cancellation")
  });
  assert.equal(signal.aborted, true);
  assert.equal(result.exitCode, 130);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});
