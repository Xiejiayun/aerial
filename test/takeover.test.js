import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { mkHome, runCli } from "./helpers.js";
import { setTomlValue } from "../src/setup/toml.js";

let home;
beforeEach(() => {
  home = mkHome("takeover");
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AERIAL_CONFIG_DIR = path.join(home, "aerial");
  process.env.AERIAL_API_KEY = "aerial_test_key";
  process.env.AERIAL_LOG_FILE = path.join(home, "events.log");
});
const { setupCodex, setupClaude, detachAllClients } = await import("../src/setup/index.js");
const { takeoverPath } = await import("../src/setup/takeover.js");
const clients = [
  { target: "codex", setup: setupCodex, relative: ".codex/config.toml", parse: parseToml,
    original: '# original comment\nmodel_provider = "openai"\nmodel = "original"\napproval_policy = "on-request"\n' },
  { target: "claude", setup: setupClaude, relative: ".claude/settings.json", parse: JSON.parse,
    original: '{"model":"original","env":{"KEEP":"yes","ANTHROPIC_BASE_URL":"https://original.example"}}\n' }
];

for (const { target, setup, relative, parse, original } of clients) {
  test(`${target}: repeated fresh setup then teardown removes generated configuration`, () => {
    const file = path.join(home, relative);
    setup({ model: "first", effort: "medium" });
    setup({ model: "second", effort: "high" });
    assert.equal(JSON.parse(fs.readFileSync(takeoverPath(file), "utf8")).original, null);
    const result = detachAllClients();
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(takeoverPath(file)), false);
    assert.equal(detachAllClients().ok, true);
  });

  test(`${target}: repeated setup restores the first baseline, including formatting`, () => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, original);
    setup({ model: "first", effort: "medium" });
    setup({ model: "second", effort: "high" });
    assert.equal(JSON.parse(fs.readFileSync(takeoverPath(file), "utf8")).original, original);
    assert.equal(detachAllClients().ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  });

  test(`${target}: teardown preserves later user changes while undoing managed values`, () => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, original);
    setup({ model: "first", effort: "medium" });
    if (target === "codex") {
      let content = fs.readFileSync(file, "utf8");
      content = setTomlValue(content, ["model"], "user-choice");
      fs.writeFileSync(file, `${content}\n# later user note\n[mcp_servers.user]\ncommand = "keep"\n`);
    } else {
      const doc = parse(fs.readFileSync(file, "utf8"));
      doc.model = "user-choice";
      doc.permissions = { allow: ["Read"] };
      doc.env.LATER = "keep";
      fs.writeFileSync(file, JSON.stringify(doc));
    }
    const result = detachAllClients();
    assert.equal(result.ok, true, JSON.stringify(result));
    const content = fs.readFileSync(file, "utf8");
    const doc = parse(content);
    assert.equal(doc.model, "user-choice");
    if (target === "codex") {
      assert.equal(doc.model_provider, "openai");
      assert.equal(doc.model_providers?.aerial, undefined);
      assert.equal(doc.mcp_servers.user.command, "keep");
      assert.match(content, /# later user note/);
    } else {
      assert.equal(doc.apiKeyHelper, undefined);
      assert.equal(doc.env.ANTHROPIC_BASE_URL, "https://original.example");
      assert.equal(doc.env.LATER, "keep");
      assert.deepEqual(doc.permissions, { allow: ["Read"] });
    }
  });

  test(`${target}: interrupted takeover can be undone using the pending journal`, () => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, original);
    const rename = fs.renameSync;
    let stateWrites = 0;
    const failure = mock.method(fs, "renameSync", (from, to) => {
      if (to === takeoverPath(file) && ++stateWrites === 2) throw Object.assign(new Error("journal write interrupted"), { code: "EPERM" });
      return rename(from, to);
    });
    try { assert.throws(() => setup({ model: "new" }), /interrupted/); }
    finally { failure.mock.restore(); }
    assert.equal(parse(fs.readFileSync(file, "utf8")).model, "new");
    assert.equal(detachAllClients().ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  });

  test(`${target}: pre-journal installations recover the oldest native backup`, () => {
    const file = path.join(home, relative);
    const result = setup({ model: "legacy" });
    const managed = fs.readFileSync(file, "utf8");
    fs.unlinkSync(takeoverPath(file));
    fs.writeFileSync(`${file}.aerial-backup-2026-01-01T00-00-00-000Z`, original);
    fs.writeFileSync(`${file}.aerial-backup-2026-01-02T00-00-00-000Z`, managed);
    assert.ok(result.file);
    assert.equal(detachAllClients().ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), original);
  });
}

test("legacy setup without a backup detaches to defaults and keeps unrelated settings", () => {
  const file = path.join(home, ".claude", "settings.json");
  setupClaude({ model: "legacy" });
  fs.unlinkSync(takeoverPath(file));
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.permissions = { allow: ["Read"] };
  fs.writeFileSync(file, JSON.stringify(doc));
  const result = detachAllClients();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.results.claude.baseline, "legacy-defaults");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { permissions: { allow: ["Read"] } });
});

test("teardown refuses to uninstall when user edits introduce another Aerial dependency", () => {
  const { file } = setupCodex({ model: "new" });
  fs.appendFileSync(file, '\n[profiles.user]\nmodel_provider = "aerial"\n');
  const before = fs.readFileSync(file, "utf8");
  const result = runCli(["teardown"], { home, extraEnv: {
    AERIAL_CONFIG_DIR: process.env.AERIAL_CONFIG_DIR,
    AERIAL_SERVICE_DRYRUN: "1", AERIAL_SERVICE_DRYRUN_INSTALLED: "1", AERIAL_SERVICE_DRYRUN_FAIL: "delete"
  } });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /still references Aerial/);
  assert.match(result.stdout, /service uninstall: skipped/);
  assert.doesNotMatch(result.stdout, /delete_failed/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("corrupt takeover state leaves the live config unchanged", () => {
  const { file } = setupCodex({ model: "new" });
  const before = fs.readFileSync(file, "utf8");
  fs.writeFileSync(takeoverPath(file), '{"schema":"wrong"}');
  const result = detachAllClients();
  assert.equal(result.ok, false);
  assert.match(result.results.codex.error, /Invalid takeover state/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
