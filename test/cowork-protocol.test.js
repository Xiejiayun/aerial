import test from "node:test";
import assert from "node:assert/strict";
import { prepareRequest, decodeCompletion, completionMessage, messageStart, messageEvents, semanticRequest } from "../src/cowork/protocol.js";

const route = { publicId: "cowork/claude-opus-test", upstreamId: "verified-test-route" };
const capabilities = { allowedBetas: ["claude-code-20250219", "mid-conversation-system-2026-04-07"], supportedEfforts: ["low"] };
const request = { model: route.publicId, max_tokens: 200, messages: [{ role: "user", content: "hello" }] };
const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {
  file_path: { type: "string", minLength: 1 }, limit: { type: "integer", exclusiveMinimum: 0 }, mode: { enum: ["text", "raw"] }
}, required: ["file_path"], additionalProperties: false };
const tool = { name: "Read", input_schema: schema };
const prepare = (body, extra = {}) => prepareRequest(body, { route, capabilities, ...extra });
const envelope = (calls, text = "", extra = {}) => JSON.stringify({ version: 1, text, tool_calls: calls, ...extra });

test("Cowork request keeps intervening system, error results and actual tool input unchanged", () => {
  const body = { ...request, metadata: { user_id: "do-not-send-attribution" }, system: "start", messages: [
    { role: "user", content: "first" }, { role: "system", content: [{ type: "text", text: "middle" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "old", name: "HistoricalTool", input: { cache_control: "ordinary argument" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "old", is_error: true, content: [{ type: "text", text: "denied" }], cache_control: { type: "ephemeral" } }] }
  ] };
  const before = structuredClone(body);
  const prepared = prepare(body);
  const encoded = prepared.prompt.split("<LOCAL_CLIENT_REQUEST>\n")[1].split("\n</LOCAL_CLIENT_REQUEST>")[0];
  const sent = JSON.parse(encoded);
  assert.deepEqual(sent.messages.map(message => message.role), ["user", "system", "assistant", "user"]);
  assert.equal(sent.messages[2].content[0].input.cache_control, "ordinary argument");
  assert.equal(sent.messages[3].content[0].is_error, true);
  assert.equal(prepared.prompt.includes("do-not-send-attribution"), false);
  assert.deepEqual(body, before);
});

test("Cowork refuses unsupported semantic fields, betas and thinking before generating", () => {
  for (const addition of [{ stop_sequences: ["end"] }, { output_config: { format: { type: "json_schema" } } }, { output_config: { effort: "max" } }, { thinking: { type: "adaptive" } }, { thinking: { type: "enabled", budget_tokens: 100 } }]) {
    assert.throws(() => prepare({ ...request, ...addition }), { code: "UNSUPPORTED_CAPABILITY" });
  }
  assert.throws(() => prepare(request, { beta: "unknown-beta" }), { code: "UNSUPPORTED_CAPABILITY" });
  assert.doesNotThrow(() => prepare({ ...request, thinking: { type: "disabled" } }, { beta: "claude-code-20250219" }));
  assert.doesNotThrow(() => prepare({ ...request, thinking: { type: "adaptive" }, output_config: { effort: "low" } }, { capabilities: { ...capabilities, thinkingMode: "cowork-managed" } }));
  assert.throws(() => prepare({ ...request, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "reason", signature: "signed" }] }] }), { code: "UNSUPPORTED_CAPABILITY" });
});

test("Cowork validates full tool schema without coercion, defaults or property deletion", () => {
  const prepared = prepare({ ...request, tools: [tool] });
  for (const input of [{}, { file_path: 42 }, { file_path: "x", limit: "1" }, { file_path: "x", limit: 0 }, { file_path: "x", mode: "other" }, { file_path: "x", extra: true }]) {
    assert.throws(() => decodeCompletion(envelope([{ name: "Read", input }]), prepared), { code: "UPSTREAM_OUTPUT_INVALID" });
  }
  const decoded = decodeCompletion(envelope([{ name: "Read", input: { file_path: "你好.txt", limit: 2 } }]), prepared);
  assert.equal(decoded.stop_reason, "tool_use");
  assert.deepEqual(decoded.content[0].input, { file_path: "你好.txt", limit: 2 });
  assert.match(decoded.content[0].id, /^toolu_aerial_/);
});

test("Cowork supports local refs and rejects remote schema references and unknown semantics", () => {
  const local = { type: "object", properties: { value: { $ref: "#/$defs/number" } }, $defs: { number: { type: "integer", minimum: 1 } }, required: ["value"] };
  const prepared = prepare({ ...request, tools: [{ name: "Use", input_schema: local }] });
  assert.throws(() => decodeCompletion(envelope([{ name: "Use", input: { value: 0 } }]), prepared), { code: "UPSTREAM_OUTPUT_INVALID" });
  assert.doesNotThrow(() => decodeCompletion(envelope([{ name: "Use", input: { value: 2 } }]), prepared));
  for (const bad of [{ ...local, properties: { value: { $ref: "https://example.invalid/schema" } } }, { ...local, inventedKeyword: true }, { ...local, properties: { value: { type: "string", format: "email" } } }]) {
    assert.throws(() => prepare({ ...request, tools: [{ name: "Use", input_schema: bad }] }), { code: "UNSUPPORTED_CAPABILITY" });
  }
  // Property names that happen to match schema keywords remain ordinary fields.
  assert.doesNotThrow(() => prepare({ ...request, tools: [{ name: "Use", input_schema: { type: "object", properties: { format: { type: "string" }, $ref: { type: "string" } } } }] }));
});

test("Cowork tool envelopes fail closed and enforce every tool_choice mode", () => {
  const body = { ...request, tools: [tool] };
  const call = { name: "Read", input: { file_path: "x" } };
  for (const raw of ["ordinary text", "```json\n{}\n```", '{"text":"done","tool_calls":[]}', envelope([], 42), envelope([], "", { ignored: true }), envelope([{ ...call, ignored: true }]), envelope([{ name: "Other", input: {} }])]) {
    assert.throws(() => decodeCompletion(raw, prepare(body)), { code: "UPSTREAM_OUTPUT_INVALID" });
  }
  assert.throws(() => decodeCompletion(envelope([call]), prepare({ ...body, tool_choice: { type: "none" } })), { code: "UPSTREAM_OUTPUT_INVALID" });
  assert.throws(() => decodeCompletion(envelope([]), prepare({ ...body, tool_choice: { type: "any" } })), { code: "UPSTREAM_OUTPUT_INVALID" });
  assert.throws(() => decodeCompletion(envelope([call, call]), prepare({ ...body, tool_choice: { type: "tool", name: "Read", disable_parallel_tool_use: true } })), { code: "UPSTREAM_OUTPUT_INVALID" });
  assert.equal(decodeCompletion(envelope([]), prepare(body)).stop_reason, "end_turn");
  assert.equal(decodeCompletion('{"answer":1}', prepare(request)).content[0].text, '{"answer":1}');
});

test("Cowork rejects duplicate and unassociated tool results", () => {
  const result = { type: "tool_result", tool_use_id: "id", content: "ok" };
  assert.throws(() => prepare({ ...request, messages: [{ role: "user", content: [result] }] }), { code: "INVALID_REQUEST" });
  assert.throws(() => prepare({ ...request, messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "id", name: "Read", input: {} }] }, { role: "user", content: [result, result] }
  ] }), { code: "INVALID_REQUEST" });
  assert.throws(() => prepare({ ...request, tools: [tool, tool] }), { code: "INVALID_REQUEST" });
});

test("Cowork validates the default Claude WebFetch URI format rather than ignoring it", () => {
  const prepared = prepare({ ...request, tools: [{ name: "WebFetch", input_schema: {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    properties: { url: { type: "string", format: "uri" }, prompt: { type: "string" } },
    required: ["url", "prompt"], additionalProperties: false
  } }] });
  for (const url of ["relative/path", "not a uri", "https://space in hostname.invalid"]) {
    assert.throws(() => decodeCompletion(envelope([{ name: "WebFetch", input: { url, prompt: "synthetic" } }]), prepared), { code: "UPSTREAM_OUTPUT_INVALID" });
  }
  const url = "https://example.test/a?query=value#fragment";
  assert.equal(decodeCompletion(envelope([{ name: "WebFetch", input: { url, prompt: "synthetic" } }]), prepared).content[0].input.url, url);
});

test("Cowork emits tool JSON deltas and estimated usage covering the wrapping prompt", () => {
  const prepared = prepare({ ...request, tools: [tool], stream: true });
  const message = completionMessage(decodeCompletion(envelope([{ name: "Read", input: { file_path: "x" } }], "你好😀"), prepared), prepared, "fixed-id");
  const events = [messageStart(message.id, prepared), ...messageEvents(message)];
  assert.equal(events[0].message.id, "fixed-id");
  assert.equal(events.at(-1).type, "message_stop");
  assert.equal(events.find(event => event.delta?.type === "input_json_delta").delta.partial_json, '{"file_path":"x"}');
  assert.ok(message.usage.input_tokens >= Math.ceil(Buffer.byteLength(prepared.prompt) / 3));
  assert.equal(message.usage.cache_read_input_tokens, undefined);
  assert.deepEqual(semanticRequest({ ...request, metadata: { ignored: true }, stream: true }), request);
});
