import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import fs from "node:fs";

test("key generate does not print the raw local key", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cli-test-"));
  const result = spawnSync(process.execPath, ["src/cli.js", "key", "generate"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, AERIAL_CONFIG_DIR: configDir, AERIAL_API_KEY: "" }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stored privately/);
  assert.doesNotMatch(result.stdout, /aerial_[A-Za-z0-9_-]+/);
});
