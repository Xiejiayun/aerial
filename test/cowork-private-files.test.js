import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrivateSessionDirectory, ensurePrivateDirectory, writePrivateJson } from "../src/cowork/private-files.js";

test("private session files are created only after directory permissions are established", () => {
  const directory = createPrivateSessionDirectory();
  const file = path.join(directory, "settings.json");
  try {
    writePrivateJson(file, { synthetic: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { synthetic: true });
    assert.deepEqual(fs.readdirSync(directory), ["settings.json"]);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
});

test("failed Windows ACL verification fails closed without writing any credential", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-cowork-acl-fail-"));
  try {
    assert.throws(() => ensurePrivateDirectory(directory, { platform: "win32", run: () => ({ status: 1 }) }), /Cannot establish and verify/);
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmdirSync(directory); }
});

test("private writes reject directory targets instead of replacing their contents", () => {
  const directory = createPrivateSessionDirectory();
  const nested = path.join(directory, "not-a-file");
  fs.mkdirSync(nested);
  try { assert.throws(() => writePrivateJson(nested, { synthetic: true }), /non-file/); }
  finally { fs.rmdirSync(nested); fs.rmdirSync(directory); }
});
