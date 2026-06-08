import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteFile, readJsonSafely, parseNumberChoice } from "../src/shared/utils.js";
import { aerialRoutes, modelsForRoute, usageSummary } from "../src/proxy/models.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-utils-test-"));

test("readJsonSafely handles empty, JSON, and malformed responses", async () => {
  assert.deepEqual(await readJsonSafely(new Response("")), {});
  assert.deepEqual(await readJsonSafely(Response.json({ ok: true })), { ok: true });
  assert.deepEqual(await readJsonSafely(new Response("not json")), { raw: "not json" });
});

test("model utils normalize missing routes and filter by route", () => {
  const models = [
    { id: "gpt", aerial: { routes: ["responses"], notes: ["stable"] }, capabilities: { supports: { reasoning_effort: ["medium"] } } },
    { id: "claude", aerial: { routes: ["messages"] } },
    { id: 42, aerial: { routes: ["responses"] } },
    { id: "broken", aerial: { routes: "responses" } }
  ];

  assert.deepEqual(aerialRoutes(models[3]), []);
  assert.deepEqual(modelsForRoute(models, "responses"), [
    { id: "gpt", routes: ["responses"], notes: ["stable"], supportedEfforts: ["medium"] }
  ]);
});

test("usageSummary reads OpenAI and Anthropic cache token shapes", () => {
  assert.deepEqual(usageSummary({
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 4 }
    }
  }), { input: 10, output: 2, cached: 4 });

  assert.deepEqual(usageSummary({
    usage: {
      prompt_tokens: 12,
      completion_tokens: 3,
      cache_read_input_tokens: 7
    }
  }), { input: 12, output: 3, cached: 7 });
});

test("parseNumberChoice supports zero-based and one-based callers", () => {
  assert.equal(parseNumberChoice("", { max: 4, defaultIndex: 2 }), 2);
  assert.equal(parseNumberChoice("1", { max: 4 }), 0);
  assert.equal(parseNumberChoice("4", { max: 4 }), 3);
  assert.equal(parseNumberChoice("4", { max: 4, oneBased: true }), 4);
  assert.equal(parseNumberChoice("0", { max: 4 }), undefined);
  assert.equal(parseNumberChoice("5", { max: 4 }), undefined);
  assert.equal(parseNumberChoice("two", { max: 4 }), undefined);
});

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
