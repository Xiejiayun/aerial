import test from "node:test";
import assert from "node:assert/strict";
import { readJsonSafely } from "../src/http-utils.js";
import { aerialRoutes, modelsForRoute, usageSummary } from "../src/model-utils.js";
import { parseNumberChoice } from "../src/prompt-utils.js";

test("readJsonSafely handles empty, JSON, and malformed responses", async () => {
  assert.deepEqual(await readJsonSafely(new Response("")), {});
  assert.deepEqual(await readJsonSafely(Response.json({ ok: true })), { ok: true });
  assert.deepEqual(await readJsonSafely(new Response("not json")), { raw: "not json" });
});

test("model utils normalize missing routes and filter by route", () => {
  const models = [
    { id: "gpt", aerial: { routes: ["responses"], notes: ["stable"] } },
    { id: "claude", aerial: { routes: ["messages"] } },
    { id: 42, aerial: { routes: ["responses"] } },
    { id: "broken", aerial: { routes: "responses" } }
  ];

  assert.deepEqual(aerialRoutes(models[3]), []);
  assert.deepEqual(modelsForRoute(models, "responses"), [
    { id: "gpt", routes: ["responses"], notes: ["stable"] }
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
