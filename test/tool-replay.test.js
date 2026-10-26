import test from "node:test";
import assert from "node:assert/strict";
import { createToolReplayCache } from "../src/proxy/tool-replay.js";

const metadata = () => ({ thread_id: "thread-a", session_id: "thread-a" });
const declaration = (overrides = {}) => ({
  type: "function",
  name: "send_message",
  description: "Send a message",
  strict: true,
  parameters: {
    type: "object",
    properties: { message: { type: "string", encrypted: true } },
    required: ["message"],
    additionalProperties: false
  },
  ...overrides
});
const call = (overrides = {}) => ({
  type: "function_call", id: "opaque-original-item", status: "completed",
  call_id: "call-a", name: "send_message",
  arguments: '{"message":"UlQC_SYNTHETIC_OPAQUE_ARGUMENTS"}',
  ...overrides
});
const generation = (tools = [declaration()], overrides = {}) => ({
  model: "gpt-test", stream: true, client_metadata: metadata(), tools,
  input: [{ role: "user", content: "Synthetic protocol test" }], ...overrides
});
const compaction = (calls = [call()], overrides = {}) => ({
  model: "gpt-test", stream: true,
  client_metadata: {
    ...metadata(), "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" })
  },
  input: calls.flatMap(item => [item, { type: "function_call_output", call_id: item.call_id, output: "ok" }]),
  ...overrides
});

function remember(cache, source = generation(), output = call(), eventType = "response.output_item.done") {
  const prepared = cache.prepare(source);
  prepared.onResponsePayload?.(eventType === "response.completed"
    ? { type: eventType, response: { output: [output] } }
    : { type: eventType, item: output });
  return prepared;
}

function assertUnchanged(cache, payload) {
  const before = structuredClone(payload);
  assert.deepEqual(cache.prepare(payload).payload, before);
  assert.deepEqual(payload, before, "prepare must not mutate its input");
}

test("compaction restores the generating declaration and preserves opaque history", () => {
  const cache = createToolReplayCache();
  const source = generation();
  const sourceBefore = structuredClone(source);
  const observed = call();
  const observedBefore = structuredClone(observed);
  const prepared = remember(cache, source, observed);
  assert.equal(typeof prepared.onResponsePayload, "function");
  assert.deepEqual(prepared.payload, sourceBefore);

  // A later mutation by the caller must not replace the generating schema.
  source.tools[0].parameters.properties.message.type = "number";
  const request = compaction();
  const before = structuredClone(request);
  const restored = cache.prepare(request).payload;
  assert.deepEqual(restored.tools, sourceBefore.tools);
  assert.equal(restored.tool_choice, "none");
  const { tools, tool_choice, ...rest } = restored;
  assert.deepEqual(rest, before);
  assert.deepEqual(request, before);
  assert.deepEqual(observed, observedBefore);
});

test("inline additional_tools and completed response outputs populate the cache", () => {
  const cache = createToolReplayCache();
  const tool = declaration();
  const source = generation(undefined, {
    tools: undefined,
    input: [{ type: "additional_tools", role: "developer", id: "tools-a", tools: [tool] }]
  });
  remember(cache, source, call(), "response.completed");
  assert.deepEqual(cache.prepare(compaction()).payload.tools, [tool]);
});

test("restoration merges different children of the same namespace without duplicating calls", () => {
  const cache = createToolReplayCache();
  const namespace = {
    type: "namespace", name: "collaboration", description: "Original namespace metadata",
    tools: [declaration(), declaration({ name: "followup_task" })]
  };
  const first = call({ namespace: namespace.name });
  const second = call({ namespace: namespace.name, name: "followup_task", call_id: "call-b" });
  const prepared = cache.prepare(generation([namespace]));
  prepared.onResponsePayload({ type: "response.completed", response: { output: [first, second] } });
  const restored = cache.prepare(compaction([first, second, first])).payload;
  assert.deepEqual(restored.tools, [namespace]);
  assert.equal(restored.tool_choice, "none");
});

test("only completed streaming function calls bind declarations", () => {
  for (const eventType of ["response.output_item.added", "response.function_call_arguments.done", "response.failed"]) {
    const cache = createToolReplayCache();
    remember(cache, generation(), call(), eventType);
    assertUnchanged(cache, compaction());
  }
  for (const output of [call({ status: "in_progress" }), call({ status: "incomplete" }), call({ type: "custom_tool_call" })]) {
    const cache = createToolReplayCache();
    remember(cache, generation(), output);
    assertUnchanged(cache, compaction([output]));
  }
  for (const stream of [undefined, false]) {
    const cache = createToolReplayCache();
    remember(cache, generation(undefined, { stream }));
    assertUnchanged(cache, compaction());
  }
});

test("plain function declarations and unrelated output names do not bind", () => {
  for (const tool of [
    declaration({ parameters: { type: "object", properties: { message: { type: "string" } } } }),
    declaration({ parameters: { type: "object", properties: { message: { type: "string", encrypted: "true" } } } }),
    declaration({ type: "custom" }),
    declaration({ name: "another_function" })
  ]) {
    const cache = createToolReplayCache();
    remember(cache, generation([tool]));
    assertUnchanged(cache, compaction());
  }
});

test("encryption flags inside nested schema alternatives are recognized", () => {
  const tool = declaration({ parameters: {
    type: "object", properties: { messages: { type: "array", items: { anyOf: [
      { type: "null" }, { type: "object", properties: { text: { type: "string", encrypted: true } } }
    ] } } }
  } });
  const cache = createToolReplayCache();
  remember(cache, generation([tool]));
  assert.deepEqual(cache.prepare(compaction()).payload.tools, [tool]);
});

test("replay requires exact call id, namespace, name and argument bytes", () => {
  const cache = createToolReplayCache();
  const original = call({ namespace: "collaboration" });
  const tool = { type: "namespace", name: "collaboration", tools: [declaration()] };
  remember(cache, generation([tool]), original);
  for (const patch of [
    { call_id: "different-call" }, { namespace: "different_namespace" }, { namespace: undefined },
    { name: "different_function" }, { arguments: original.arguments + " " },
    { arguments: '{"message":"UlQC_DIFFERENT_OPAQUE_ARGUMENTS"}' }
  ]) assertUnchanged(cache, compaction([{ ...original, ...patch }]));

  // Codex can omit its optional item id when serializing the same historical call.
  assert.deepEqual(cache.prepare(compaction([{ ...original, id: undefined }])).payload.tools, [tool]);
});

test("model, conversation identity and installation isolate cached declarations", () => {
  const cache = createToolReplayCache();
  const installation = { "x-codex-installation-id": "installation-a" };
  remember(cache, generation(undefined, { client_metadata: { ...metadata(), ...installation } }));
  for (const patch of [
    { model: "different-model" },
    { client_metadata: { thread_id: "thread-b", session_id: "thread-b", ...installation } },
    { client_metadata: { ...metadata(), "x-codex-installation-id": "installation-b" } },
    { client_metadata: metadata() }
  ]) {
    const request = compaction();
    request.client_metadata = { ...request.client_metadata, ...installation };
    assertUnchanged(cache, { ...request, ...patch,
      client_metadata: patch.client_metadata ? {
        ...patch.client_metadata, "x-codex-turn-metadata": request.client_metadata["x-codex-turn-metadata"]
      } : request.client_metadata
    });
  }
});

test("one matching conversation id is sufficient but conflicting or missing scope is rejected", () => {
  for (const scopedMetadata of [{ thread_id: "thread-a" }, { session_id: "thread-a" }, metadata()]) {
    const cache = createToolReplayCache();
    remember(cache, generation(undefined, { client_metadata: scopedMetadata }));
    assert.deepEqual(cache.prepare(compaction()).payload.tools, [declaration()]);
  }
  for (const invalidMetadata of [
    {}, { thread_id: "thread-a", session_id: "thread-b" },
    { thread_id: 42 }, { session_id: "" },
    { ...metadata(), "x-codex-installation-id": "" },
    { ...metadata(), "x-codex-installation-id": 42 }
  ]) {
    const cache = createToolReplayCache();
    remember(cache, generation(undefined, { client_metadata: invalidMetadata }));
    assertUnchanged(cache, compaction());
    remember(cache);
    assertUnchanged(cache, compaction(undefined, { client_metadata: {
      ...invalidMetadata, "x-codex-turn-metadata": '{"request_kind":"compaction"}'
    } }));
  }
  const cache = createToolReplayCache();
  remember(cache, generation(undefined, { model: undefined }));
  assertUnchanged(cache, compaction());
});

test("a prompt cache key cannot substitute for conversation identity", () => {
  const cache = createToolReplayCache();
  remember(cache, generation(undefined, { client_metadata: {}, prompt_cache_key: "shared-cache-key" }));
  assertUnchanged(cache, compaction(undefined, { prompt_cache_key: "shared-cache-key" }));
});

test("ordinary tool-less questions and malformed compaction metadata remain untouched", () => {
  const cache = createToolReplayCache();
  remember(cache);
  for (const marker of [undefined, "{", "null", "{}", '{"request_kind":"turn"}', { request_kind: "compaction" }]) {
    assertUnchanged(cache, compaction(undefined, { client_metadata: {
      ...metadata(), "x-codex-turn-metadata": marker
    } }));
  }
});

test("only absent, auto or none tool choice permits recovery", () => {
  const cache = createToolReplayCache();
  remember(cache);
  for (const tool_choice of [undefined, "auto", "none"]) {
    const restored = cache.prepare(compaction(undefined, { tool_choice })).payload;
    assert.deepEqual(restored.tools, [declaration()]);
    assert.equal(restored.tool_choice, "none");
  }
  for (const tool_choice of ["required", { type: "function", name: "send_message" }]) {
    assertUnchanged(cache, compaction(undefined, { tool_choice }));
  }
});

test("existing top-level or inline tools prevent recovery", () => {
  const cache = createToolReplayCache();
  remember(cache);
  assertUnchanged(cache, compaction(undefined, { tools: [{ type: "web_search" }] }));
  const inline = compaction();
  inline.input.unshift({ type: "additional_tools", tools: [declaration({ name: "other" })] });
  assertUnchanged(cache, inline);
  const empty = compaction(undefined, { tools: [] });
  empty.input.unshift({ type: "additional_tools", tools: [] });
  assert.deepEqual(cache.prepare(empty).payload.tools, [declaration()]);
});

test("same-name schema versions in one compaction prevent all restoration", () => {
  const cache = createToolReplayCache();
  const first = call();
  const second = call({ call_id: "call-b" });
  remember(cache, generation(), first);
  remember(cache, generation([declaration({ description: "New schema version" })]), second);
  assertUnchanged(cache, compaction([first, second]));
  assert.deepEqual(cache.prepare(compaction([first])).payload.tools, [declaration()]);
});

test("a missing same-name historical call prevents applying a newer declaration to it", () => {
  const cache = createToolReplayCache();
  const known = call();
  remember(cache, generation(), known);
  const unknown = call({ call_id: "call-before-proxy-started", arguments: '{"olderField":"opaque"}' });
  assertUnchanged(cache, compaction([unknown, known]));
  // A different tool identity does not receive the restored declaration.
  const unrelated = call({ call_id: "unrelated", name: "ordinary_tool" });
  assert.deepEqual(cache.prepare(compaction([unrelated, known])).payload.tools, [declaration()]);
});

test("conflicting namespace metadata prevents restoration of its children", () => {
  const cache = createToolReplayCache();
  const first = call({ namespace: "collaboration" });
  const second = call({ namespace: "collaboration", name: "followup_task", call_id: "call-b" });
  remember(cache, generation([{ type: "namespace", name: "collaboration", description: "v1", tools: [declaration()] }]), first);
  remember(cache, generation([{ type: "namespace", name: "collaboration", description: "v2", tools: [declaration({ name: "followup_task" })] }]), second);
  assertUnchanged(cache, compaction([first, second]));
});

test("conflicting declarations in the generating request cannot bind a call", () => {
  for (const conflicting of [
    declaration({ description: "Different declaration" }),
    declaration({ parameters: { type: "object", properties: { message: { type: "string" } } } })
  ]) {
    const cache = createToolReplayCache();
    remember(cache, generation([declaration(), conflicting]));
    assertUnchanged(cache, compaction());
  }
  const cache = createToolReplayCache();
  remember(cache, generation([declaration(), declaration()]));
  assert.deepEqual(cache.prepare(compaction()).payload.tools, [declaration()]);
});

test("conflicting observations for the same call cannot replace its original schema", () => {
  const cache = createToolReplayCache();
  remember(cache);
  remember(cache, generation([declaration({ description: "Different declaration" })]));
  assertUnchanged(cache, compaction());
});

test("cold and expired caches leave compact requests unchanged", () => {
  let timestamp = 1_000;
  const cache = createToolReplayCache({ now: () => timestamp, ttlMs: 10 });
  assertUnchanged(cache, compaction());
  remember(cache);
  assert.deepEqual(cache.prepare(compaction()).payload.tools, [declaration()]);
  timestamp = 1_011;
  assertUnchanged(cache, compaction());
});

test("entry limits evict old calls and repeated terminal events do not consume extra entries", () => {
  const cache = createToolReplayCache({ maxEntries: 2 });
  const first = call();
  const second = call({ call_id: "call-b" });
  const third = call({ call_id: "call-c" });
  remember(cache, generation(), first);
  remember(cache, generation(), second);
  remember(cache, generation(), second, "response.completed");
  assert.deepEqual(cache.prepare(compaction([first])).payload.tools, [declaration()]);
  remember(cache, generation(), third);
  assertUnchanged(cache, compaction([first]));
  assert.deepEqual(cache.prepare(compaction([third])).payload.tools, [declaration()]);
});

test("byte limits bound retained declarations and reject oversized schemas", () => {
  const tiny = createToolReplayCache({ maxBytes: 1 });
  remember(tiny);
  assertUnchanged(tiny, compaction());

  const cache = createToolReplayCache({ maxBytes: 7_500 });
  const calls = ["first", "second", "third"].map(name => call({ name, call_id: `call-${name}` }));
  for (const output of calls) remember(cache, generation([
    declaration({ name: output.name, description: "x".repeat(3_000) })
  ]), output);
  const restored = calls.map(output => cache.prepare(compaction([output])).payload.tools);
  assert.ok(restored.filter(Boolean).length <= 2, "the byte budget cannot retain all three distinct large declarations");
  assert.ok(restored.at(-1), "a declaration smaller than the budget should remain available");
});
