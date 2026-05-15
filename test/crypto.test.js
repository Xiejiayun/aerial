import test from "node:test";
import assert from "node:assert/strict";
import { hashApiKey, verifyApiKey } from "../src/crypto.js";

test("api key hash verifies the original key only", () => {
  const encoded = hashApiKey("aerial_test_key", "fixedsalt");
  assert.equal(verifyApiKey("aerial_test_key", encoded), true);
  assert.equal(verifyApiKey("wrong", encoded), false);
});
