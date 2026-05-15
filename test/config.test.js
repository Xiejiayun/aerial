import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-test-"));
process.env.AERIAL_CONFIG_DIR = temp;
process.env.AERIAL_API_KEY = "aerial_test_key";

const { ensureApiKey, loadConfig, validateLocalAuth } = await import("../src/config.js");

test("ensureApiKey stores only a hash and auth validates bearer or x-api-key", () => {
  const result = ensureApiKey();
  assert.equal(result.source, "env");
  const config = loadConfig();
  assert.ok(config.apiKeyHash.startsWith("scrypt$"));
  assert.equal(validateLocalAuth({ authorization: "Bearer aerial_test_key" }, config), true);
  assert.equal(validateLocalAuth({ "x-api-key": "aerial_test_key" }, config), true);
  assert.equal(validateLocalAuth({ authorization: "Bearer bad" }, config), false);
});
