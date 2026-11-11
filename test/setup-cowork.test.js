import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-setup-cowork-"));
process.env.AERIAL_API_KEY = "synthetic-persistent-aerial-key";
for (const key of Object.keys(process.env)) {
  if (/^ANTHROPIC_|^CLAUDE_CODE_USE_/.test(key) || ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_MODEL", "MAX_THINKING_TOKENS"].includes(key)) delete process.env[key];
}
const { loadConfig, saveConfig } = await import("../src/shared/config.js");
const { setupCoworkProvider } = await import("../src/cli/setup-cowork.js");
const { persistentCoworkClaudeSettings } = await import("../src/setup/cowork-claude.js");
const { setupClaude, claudeStatus } = await import("../src/setup/clients.js");
const { detachClientTakeover } = await import("../src/setup/takeover.js");
const { runSetupCli } = await import("../src/cli/commands/setup.js");
const publicModel = "cowork/claude-opus-5-5-fixture";

function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  process.env.AERIAL_CONFIG_DIR = path.join(directory, "config");
  process.env.AERIAL_COWORK_CONFIG_DIR = path.join(directory, "profile");
  process.env.CLAUDE_CONFIG_DIR = path.join(directory, "claude");
  process.env.CODEX_HOME = path.join(directory, "codex");
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  fs.mkdirSync(process.env.CODEX_HOME);
  const file = path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
  const codexFile = path.join(process.env.CODEX_HOME, "config.toml");
  const original = JSON.stringify({ model: "previous", permissions: { deny: ["Bash"] }, env: { EXISTING: "keep", ANTHROPIC_AUTH_TOKEN: "old-user-token" } });
  fs.writeFileSync(file, original);
  fs.writeFileSync(codexFile, 'model = "github-codex-original"\n');
  const selected = { model: publicModel, profileDirectory: process.env.AERIAL_COWORK_CONFIG_DIR, effort: "medium" };
  saveConfig({ ...loadConfig(), defaultModel: "github-default", defaultEffort: "high", ...(options.configured ? { cowork: selected } : {}) });
  const calls = [], requestIds = [];
  const status = () => ({ provider: "cowork", configured: true, ready: true, ...selected,
    upstreamModel: "opus-5.5", supportedEfforts: ["medium"], cloudToolIsolation: "unverified", experimentalTrial: true,
    ...options.statusOverride });
  const deps = {
    checkRuntime: () => { calls.push("runtime"); },
    checkVersion: () => { calls.push("version"); return "2.1.322"; },
    run: (command, args) => { calls.push("helper"); assert.deepEqual(args.slice(-2), ["key", "print"]); return { status: 0, stdout: "synthetic-persistent-aerial-key\n" }; },
    openSession: async request => {
      calls.push("preflight");
      assert.equal(request.model, "opus-5.5");
      assert.equal(request.effort, "medium");
      assert.equal(request.directory, selected.profileDirectory);
      if (options.preflightError) throw options.preflightError;
      return { model: publicModel, route: { upstreamId: "opus-5.5", displayName: "Synthetic Opus" },
        capabilities: { clientEffort: "medium", supportedEfforts: ["medium"], cloudToolIsolation: "unverified", experimentalTrial: true },
        close: async () => { calls.push("preflight-close"); } };
    },
    fetchImpl: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      calls.push(`${init.method || "GET"} ${pathname}`);
      assert.equal(init.redirect, "error");
      if (pathname === "/health") return Response.json({ service: "aerial", ok: true });
      assert.equal(init.headers.authorization, "Bearer synthetic-persistent-aerial-key");
      if (pathname === "/_aerial/cowork/status") return Response.json(loadConfig().cowork ? status() : { provider: "cowork", configured: false, ready: false });
      if (pathname === "/_aerial/cowork/close") {
        assert.ok(loadConfig().cowork, "Keep the configuration until the service confirms release of its lock");
        return options.closeFails ? Response.json({ error: "synthetic close failure" }, { status: 503 }) : Response.json({ ok: true, provider: "cowork", closed: true });
      }
      assert.equal(pathname, "/v1/messages");
      assert.equal(init.method, "POST");
      assert.match(init.headers["idempotency-key"], /^[a-f0-9-]{36}$/i);
      requestIds.push(init.headers["idempotency-key"]);
      assert.equal(fs.readFileSync(file, "utf8"), original, "Client settings must not change before readiness succeeds");
      const body = JSON.parse(init.body);
      assert.equal(body.model, publicModel);
      assert.equal(body.thinking, undefined);
      assert.deepEqual(body.output_config, { effort: "medium" });
      options.onMessages?.();
      return options.routeFails ? Response.json({ error: { message: "synthetic denied route" } }, { status: 403 })
        : Response.json({ type: "message", content: [{ type: "text", text: "OK" }] });
    }
  };
  return { file, codexFile, original, selected, calls, requestIds, deps };
}

test("Cowork setup verifies its service before writing persistent helper-backed Claude settings and leaves Codex unchanged", async () => {
  const f = fixture();
  const result = await setupCoworkProvider({ model: "opus-5.5" }, f.deps);
  assert.equal(result.readiness.verified, true);
  assert.equal(result.claudeVersion, "2.1.322");
  const settings = JSON.parse(fs.readFileSync(f.file, "utf8"));
  assert.equal(settings.model, publicModel);
  assert.deepEqual(settings.modelOverrides, { [publicModel]: publicModel });
  assert.equal(settings.effortLevel, "medium");
  assert.equal(settings.modelSettings[publicModel].effortLevel, "medium");
  assert.match(settings.apiKeyHelper, /key" "print/);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:18181");
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) assert.equal(settings.env[key], undefined);
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_THINKING, "1");
  assert.equal(settings.env.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, "1");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, publicModel);
  assert.equal(settings.env.EXISTING, "keep");
  assert.deepEqual(settings.permissions, { deny: ["Bash"] });
  assert.doesNotMatch(fs.readFileSync(f.file, "utf8"), /synthetic-persistent-aerial-key|setup-placeholder|old-user-token/);
  assert.equal(fs.readFileSync(result.backup, "utf8"), f.original);
  assert.equal(fs.readFileSync(f.codexFile, "utf8"), 'model = "github-codex-original"\n');
  assert.equal(loadConfig().defaultModel, "github-default");
  assert.equal(loadConfig().defaultEffort, "high");
  assert.equal(loadConfig().cowork.effort, "medium");
  assert.equal(claudeStatus({ env: {} }).state, "aerial");
  assert.deepEqual(f.calls.filter(call => call.startsWith("preflight")), ["preflight", "preflight-close"]);
  assert.ok(f.calls.indexOf("preflight-close") < f.calls.lastIndexOf("GET /_aerial/cowork/status"));
  detachClientTakeover({ target: "claude", file: f.file });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, "utf8")), JSON.parse(f.original));
});

test("Cowork setup reuses authenticated service status without acquiring its profile lock again", async () => {
  const f = fixture({ configured: true });
  f.deps.openSession = async () => assert.fail("An active service owns this profile lock");
  await setupCoworkProvider({ model: "opus-5.5", effort: "medium" }, f.deps);
  assert.deepEqual(loadConfig().cowork, f.selected);
  assert.equal(f.calls.includes("POST /_aerial/cowork/close"), false);
});

for (const failing of [false, true]) test(`switching Cowork model and max effort ${failing ? "rolls back after a failed route" : "preserves GitHub defaults"}`, async () => {
  const f = fixture({ configured: true });
  const next = { publicId: "cowork/claude-sonnet-fixture", upstreamId: "sonnet-5.5", provider: "anthropic", supportedEfforts: ["medium", "max"] };
  let active = f.selected, reloads = 0;
  const originalFetch = f.deps.fetchImpl;
  f.deps.fetchImpl = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const report = () => ({ provider: "cowork", configured: true, ready: true, ...active,
      upstreamModel: active.model === publicModel ? "opus-5.5" : next.upstreamId,
      supportedEfforts: ["medium", "max"], cloudToolIsolation: "unverified", experimentalTrial: true });
    if (pathname === "/_aerial/cowork/status") {
      if (loadConfig().cowork.model !== active.model) return Response.json({ error: "restart required" }, { status: 503 });
      return Response.json(report());
    }
    if (pathname === "/_aerial/cowork/catalog") return Response.json({ provider: "cowork", configured: true, profileDirectory: f.selected.profileDirectory, models: [next] });
    if (pathname === "/_aerial/cowork/reload") { reloads++; active = loadConfig().cowork; return Response.json(report()); }
    if (pathname === "/v1/messages") {
      assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
      assert.deepEqual(JSON.parse(init.body).output_config, { effort: "max" });
      assert.equal(JSON.parse(init.body).model, next.publicId);
      return failing ? Response.json({ error: "synthetic failure" }, { status: 502 }) : Response.json({ type: "message", content: [{ type: "text", text: "OK" }] });
    }
    return originalFetch(url, init);
  };
  if (failing) {
    await assert.rejects(setupCoworkProvider({ model: next.upstreamId, effort: "max" }, f.deps), /Previous Cowork model and effort were restored/);
    assert.deepEqual(loadConfig().cowork, f.selected);
    assert.equal(fs.readFileSync(f.file, "utf8"), f.original); assert.equal(reloads, 2);
  } else {
    const result = await setupCoworkProvider({ model: next.upstreamId, effort: "max" }, f.deps);
    assert.equal(result.effort, "max"); assert.equal(reloads, 1);
    const settings = JSON.parse(fs.readFileSync(f.file, "utf8"));
    assert.equal(settings.model, next.publicId);
    assert.equal(settings.env.CLAUDE_CODE_EFFORT_LEVEL, "max"); assert.equal(settings.effortLevel, undefined);
  }
  assert.equal(loadConfig().defaultModel, "github-default"); assert.equal(loadConfig().defaultEffort, "high");
  assert.equal(fs.readFileSync(f.codexFile, "utf8"), 'model = "github-codex-original"\n');
});

test("each explicit setup verification uses a fresh idempotency key without persisting it in client settings", async () => {
  const f = fixture({ configured: true });
  const deps = { ...f.deps, writeClient: () => ({}) };
  await setupCoworkProvider({ model: "opus-5.5" }, deps);
  await setupCoworkProvider({ model: "opus-5.5" }, deps);
  assert.equal(new Set(f.requestIds).size, 2);
  for (const id of f.requestIds) assert.equal(fs.readFileSync(f.file, "utf8").includes(id), false);
});

test("Cowork setup rejects missing models, unsupported effort, offline mode and unsupported clients before changing state", async () => {
  const f = fixture();
  for (const options of [{}, { model: "opus-5.5", effort: "ultra" }, { model: "opus-5.5", configureOnly: true }]) {
    await assert.rejects(setupCoworkProvider(options, f.deps), /requires|Unsupported Cowork effort|not supported/);
  }
  await assert.rejects(setupCoworkProvider({ model: "opus-5.5" }, { ...f.deps, checkVersion: () => { throw new Error("unsupported client version"); } }), /unsupported client/);
  assert.equal(f.calls.some(call => call.startsWith("GET ")), false);
  assert.equal(loadConfig().cowork, undefined);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});

test("failed profile preflight does not enable persistent Cowork routing", async () => {
  const f = fixture({ preflightError: new Error("profile evidence is unverified") });
  await assert.rejects(setupCoworkProvider({ model: "opus-5.5" }, f.deps), /evidence is unverified/);
  assert.equal(loadConfig().cowork, undefined);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
  assert.equal(f.calls.includes("POST /v1/messages"), false);
});

test("failed first readiness closes the newly opened service before rolling back only its Cowork configuration", async () => {
  const f = fixture({ routeFails: true, onMessages: () => saveConfig({ ...loadConfig(), logLevel: "debug" }) });
  await assert.rejects(setupCoworkProvider({ model: "opus-5.5" }, f.deps), /closed.*rolled back.*Restart/s);
  assert.equal(loadConfig().cowork, undefined);
  assert.equal(loadConfig().logLevel, "debug");
  assert.equal(loadConfig().defaultEffort, "high");
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
  assert.equal(fs.existsSync(`${f.file}.aerial-state.json`), false);
  assert.equal(f.calls.filter(call => call === "POST /_aerial/cowork/close").length, 1);
});

test("a failed close retains service configuration and reports incomplete rollback", async () => {
  const f = fixture({ routeFails: true, closeFails: true });
  await assert.rejects(setupCoworkProvider({ model: "opus-5.5" }, f.deps), /could not be closed.*configuration was retained/s);
  assert.equal(loadConfig().cowork.model, publicModel);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});

test("a failed existing route is not closed or reconfigured by setup", async () => {
  const f = fixture({ configured: true, routeFails: true });
  await assert.rejects(setupCoworkProvider({ model: "opus-5.5" }, f.deps), /route verification failed/);
  assert.deepEqual(loadConfig().cowork, f.selected);
  assert.equal(f.calls.includes("POST /_aerial/cowork/close"), false);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});

test("mismatched service profile, model, effort or isolation evidence cannot configure Claude", async () => {
  for (const statusOverride of [{ model: "cowork/different", upstreamModel: "different" }, { model: "Cowork/uppercase" }, { profileDirectory: path.join(root, "different") }, { effort: "high" }, { supportedEfforts: [] }, { experimentalTrial: false }]) {
    const f = fixture({ configured: true, statusOverride });
    await assert.rejects(setupCoworkProvider({ model: "opus-5.5" }, f.deps), /did not verify/);
    assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
    assert.equal(f.calls.includes("POST /v1/messages"), false);
  }
});

test("persistent Cowork settings reject noncanonical model namespaces", () => {
  fixture();
  for (const model of ["Cowork/route", "cowork/Uppercase", "opus-5.5"]) assert.throws(() => persistentCoworkClaudeSettings({ model, config: loadConfig() }), /exact public Cowork model/);
});

test("client write failures close and roll back only a newly enabled Cowork service", async () => {
  const f = fixture();
  await assert.rejects(setupCoworkProvider({ model: "opus-5.5" }, { ...f.deps, writeClient: () => { throw new Error("synthetic client write failure"); } }), /client write failure.*rolled back/s);
  assert.equal(loadConfig().cowork, undefined);
  assert.equal(f.calls.includes("POST /_aerial/cowork/close"), true);
});

test("a partial client write keeps the verified route available for takeover recovery", async () => {
  const f = fixture();
  const writeClient = () => {
    fs.writeFileSync(f.file, JSON.stringify({ model: publicModel }));
    throw new Error("synthetic final journal failure");
  };
  await assert.rejects(setupCoworkProvider({ model: "opus-5.5" }, { ...f.deps, writeClient }), /settings changed.*configuration was retained.*takeover journal/s);
  assert.equal(loadConfig().cowork.model, publicModel);
  assert.equal(f.calls.includes("POST /_aerial/cowork/close"), false);
});

test("a concurrent proxy address change cannot redirect the client to an unverified endpoint", async () => {
  const f = fixture({ onMessages: () => saveConfig({ ...loadConfig(), port: 18182 }) });
  await assert.rejects(setupCoworkProvider({ model: "opus-5.5" }, f.deps), /routing changed.*rolled back/s);
  assert.equal(loadConfig().port, 18182);
  assert.equal(loadConfig().cowork, undefined);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});

test("switching Claude back to GitHub removes Cowork compatibility settings while preserving later user changes", async () => {
  const f = fixture();
  await setupCoworkProvider({ model: "opus-5.5" }, f.deps);
  const settings = JSON.parse(fs.readFileSync(f.file, "utf8"));
  settings.env.API_TIMEOUT_MS = "75000";
  fs.writeFileSync(f.file, JSON.stringify(settings));
  setupClaude({ model: "claude-opus-4.7", effort: "medium" });
  const switched = JSON.parse(fs.readFileSync(f.file, "utf8"));
  for (const key of ["DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_THINKING", "CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK", "MAX_THINKING_TOKENS", "ANTHROPIC_MODEL"]) assert.equal(switched.env[key], undefined);
  assert.equal(switched.env.API_TIMEOUT_MS, "75000");
  assert.equal(switched.env.EXISTING, "keep");
  assert.equal(claudeStatus({ env: {} }).state, "aerial");
});

test("unknown setup providers and Cowork routes without provider selection fail before setup", async () => {
  const f = fixture();
  await assert.rejects(runSetupCli("claude", ["--provider", "typo"]), /Unknown setup provider/);
  await assert.rejects(runSetupCli("claude", ["--model", publicModel, "--configure-only"]), /require.*--provider cowork/);
  assert.equal(fs.readFileSync(f.file, "utf8"), f.original);
});
