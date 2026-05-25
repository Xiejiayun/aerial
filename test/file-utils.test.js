import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile } from "../src/file-utils.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-file-utils-test-"));

test("atomicWriteFile writes through a temporary file and renames into place", () => {
  const file = path.join(temp, "nested", "config.txt");
  let renameCall;
  const originalRename = fs.renameSync;
  const renameSpy = mock.method(fs, "renameSync", (src, dst) => {
    renameCall = { src, dst };
    return originalRename.call(fs, src, dst);
  });
  try {
    atomicWriteFile(file, "ok\n", { mode: 0o600 });
  } finally {
    renameSpy.mock.restore();
  }
  assert.equal(fs.readFileSync(file, "utf8"), "ok\n");
  assert.equal(renameCall.dst, file);
  assert.match(path.basename(renameCall.src), /^config\.txt\.aerial-tmp-/);
  assert.equal(fs.existsSync(renameCall.src), false);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("atomicWriteFile removes the temporary file when rename fails", () => {
  const dir = path.join(temp, "failure");
  const file = path.join(dir, "config.txt");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "old\n", "utf8");
  const renameSpy = mock.method(fs, "renameSync", () => {
    throw new Error("simulated rename failure");
  });
  try {
    assert.throws(() => atomicWriteFile(file, "new\n"), /simulated rename failure/);
  } finally {
    renameSpy.mock.restore();
  }
  assert.equal(fs.readFileSync(file, "utf8"), "old\n");
  assert.deepEqual(fs.readdirSync(dir), ["config.txt"]);
});

test("atomicWriteFile removes the temporary file when write fails", () => {
  const dir = path.join(temp, "write-failure");
  const file = path.join(dir, "config.txt");
  fs.mkdirSync(dir, { recursive: true });
  const originalWrite = fs.writeFileSync;
  const writeSpy = mock.method(fs, "writeFileSync", (tmp, content, opts) => {
    originalWrite.call(fs, tmp, "partial\n", opts);
    throw new Error("simulated write failure");
  });
  try {
    assert.throws(() => atomicWriteFile(file, "new\n"), /simulated write failure/);
  } finally {
    writeSpy.mock.restore();
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});
