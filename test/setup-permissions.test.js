import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkHome } from "./helpers.js";

const home = mkHome("setup-permissions");
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.AERIAL_CONFIG_DIR = path.join(home, "aerial");
process.env.AERIAL_API_KEY = "aerial_test_key";
const { setupCodex, setupClaude } = await import("../src/setup/clients.js");

for (const [target, setup, relative, original] of [
  ["codex", setupCodex, ".codex/config.toml", 'model = "old"\n'],
  ["claude", setupClaude, ".claude/settings.json", '{"env":{"KEEP":"private"}}\n']
]) {
  test(`${target} setup protects new files, existing modes and backups`, { skip: process.platform === "win32" }, () => {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    setup({ model: "test" });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    for (const mode of [0o644, 0o600, 0o400]) {
      fs.chmodSync(file, 0o600);
      fs.writeFileSync(file, original);
      fs.chmodSync(file, mode);
      const result = setup({ model: "test" });
      assert.equal(fs.statSync(file).mode & 0o777, mode & 0o600);
      assert.equal(fs.statSync(result.backup).mode & 0o077, 0);
    }
  });

  test(`${target} setup preserves config symlinks and protects their targets`, { skip: process.platform === "win32" }, () => {
    const file = path.join(home, relative);
    const real = path.join(home, `${target}-real`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(real, original, { mode: 0o600 });
    fs.rmSync(file, { force: true });
    fs.symlinkSync(real, file);
    setup({ model: "test" });
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
    assert.equal(fs.statSync(real).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(real, "utf8"), /test/);
    fs.unlinkSync(real);
    assert.throws(() => setup({ model: "test" }), { code: "ENOENT" });
    assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  });
}
