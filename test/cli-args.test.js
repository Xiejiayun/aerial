import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hasCliHelp, validateCliArgs } from "../src/cli/args.js";
import { mkHome, runCli } from "./helpers.js";

test("help on every mutating command exits without touching configuration", () => {
  const home = mkHome("help-no-side-effects");
  const dir = path.join(home, "config");
  fs.mkdirSync(dir);
  const file = path.join(dir, "config.json");
  const original = '{"port":19999}\n';
  fs.writeFileSync(file, original);
  for (const command of [
    ["config", "reset"], ["config", "set", "port", "18181"],
    ["setup", "codex"], ["setup", "claude"], ["setup", "restore", "all", "--latest"],
    ["teardown"], ["service", "install"], ["service", "start"],
    ["service", "stop"], ["service", "restart"], ["service", "uninstall"],
    ["key", "generate"], ["key", "print"], ["login", "--force"], ["login", "--provider", "cowork", "--force"],
    ["proxy", "enable"], ["proxy", "disable"], ["start"], ["update"], ["upgrade"],
    ["cowork", "configure"], ["cowork", "auth"], ["cowork", "run"], ["cowork", "probe"], ["cowork", "models"], ["cowork", "doctor"], ["cowork", "release", "synthetic-id"]
  ]) {
    const result = runCli([...command, "--help"], { home });
    assert.equal(result.status, 0, `${command.join(" ")}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(home), ["config"]);
    assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  }
});

test("login accepts an explicit provider and rejects malformed provider options before dispatch", () => {
  for (const args of [[], ["--provider", "github"], ["--provider", "cowork"], ["--provider", "cowork", "--force"]]) {
    assert.deepEqual(validateCliArgs(["login", ...args]), { help: false });
  }
  for (const args of [
    ["--provider"], ["--provider", "--force"], ["--provider", "cowork", "--provider", "github"],
    ["--provider", "cowork", "--origin", "https://example.test"], ["--provider", "cowork", "extra"]
  ]) assert.throws(() => validateCliArgs(["login", ...args]));
});

test("Cowork validates its own options while preserving Claude arguments after the separator", () => {
  assert.deepEqual(validateCliArgs(["cowork", "run", "--model", "cowork/test", "--", "--print", "hello", "--help"]), { help: false });
  assert.equal(hasCliHelp(["--config-dir", "somewhere", "cowork", "run", "--model", "cowork/test", "--", "--help"]), false);
  assert.equal(hasCliHelp(["cowork", "run", "--help", "--", "--print"]), true);
  assert.deepEqual(validateCliArgs(["cowork", "auth", "--interactive", "--origin", "https://example.test"]), { help: false });
  assert.deepEqual(validateCliArgs(["cowork", "probe", "--model", "test"]), { help: false });
  assert.deepEqual(validateCliArgs(["cowork", "probe", "--model", "test", "--effort", "medium"]), { help: false });
  for (const args of [
    ["cowork", "run", "--modle", "oops"], ["cowork", "run", "--model"],
    ["cowork", "run", "--model", "test", "--print", "hello"],
    ["cowork", "doctor", "--", "anything"], ["cowork", "auth", "--unknown"],
    ["cowork", "probe", "--model", "test", "--prompt", "arbitrary text"],
    ["cowork", "probe", "--model", "test", "--headers", "x-arbitrary: value"],
    ["cowork", "probe", "--model", "test", "--effort"],
    ["cowork", "probe", "--model", "test", "--effort", "medium", "--effort", "high"],
    ["cowork", "run", "--model", "test", "--effort", "medium"]
  ]) assert.throws(() => validateCliArgs(args));
  assert.throws(() => validateCliArgs(["cowork", "release"]));
  assert.deepEqual(validateCliArgs(["cowork", "operations", "--json"]), { help: false });
});

test("invalid options, extra arguments and missing values fail before dispatch", () => {
  for (const args of [
    ["teardown", "--latest"], ["config", "reset", "extra"], ["config", "oops"],
    ["service", "uninstall", "--wat"], ["setup", "codex", "--modle", "gpt-test"],
    ["start", "--host"], ["start", "--port", "--json"],
    ["setup", "claude", "--effort"], ["login", "--force", "--force"],
    ["status", "extra"], ["key", "print", "extra"], ["update", "--check", "--check"], ["upgrade", "--unknown"]
  ]) assert.throws(() => validateCliArgs(args), Error, args.join(" "));
  assert.deepEqual(validateCliArgs(["service", "uninstall", "-h"]), { help: true });
  assert.deepEqual(validateCliArgs(["setup", "restore", "all", "--latest"]), { help: false });
  assert.deepEqual(validateCliArgs(["proxy", "--json"]), { help: false });
  assert.deepEqual(validateCliArgs(["update", "--check"]), { help: false });
  assert.deepEqual(validateCliArgs(["upgrade"]), { help: false });
});

test("invalid start bind arguments do not create credentials or start a server", () => {
  for (const options of [["--port", "invalid"], ["--host", "0.0.0.0"]]) {
    const home = mkHome("invalid-start");
    const result = runCli(["start", ...options], { home });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be/);
    assert.equal(fs.existsSync(path.join(home, "config", "api_key")), false);
  }
});
