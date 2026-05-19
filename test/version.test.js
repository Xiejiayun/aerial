import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import { readPackageVersion } from "../src/version.js";

test("readPackageVersion returns the package.json version", () => {
  // Defaults to the package.json adjacent to src/version.js.
  const version = readPackageVersion();
  assert.equal(typeof version, "string");
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.notEqual(version, "unknown");
});

test("readPackageVersion warns and returns 'unknown' when the file is missing", () => {
  const missing = new URL("../no-such-package.json", import.meta.url);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    const version = readPackageVersion(missing);
    assert.equal(version, "unknown");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cannot read package version/);
    assert.match(warnings[0], /reporting "unknown"/);
  } finally {
    console.warn = originalWarn;
  }
});

test("readPackageVersion warns and returns 'unknown' when the file has no version field", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-version-test-"));
  const fakePackage = path.join(tempDir, "package.json");
  fs.writeFileSync(fakePackage, JSON.stringify({ name: "no-version" }), "utf8");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    const version = readPackageVersion(new URL(`file://${fakePackage.replace(/\\/g, "/")}`));
    assert.equal(version, "unknown");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /missing version field/);
  } finally {
    console.warn = originalWarn;
  }
});

test("aerial --version prints the package version and exits 0", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const result = spawnSync(process.execPath, ["src/cli.js", "--version"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const stdout = result.stdout.trim();
  assert.match(stdout, /^\d+\.\d+\.\d+/);
  assert.notEqual(stdout, "unknown");
  const expected = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  assert.equal(stdout, expected);
});
