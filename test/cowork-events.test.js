import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { eventProtocolEvidence, readCoworkCompletion, readCoworkEvents } from "../src/cowork/events.js";

const frame = (event, data) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
const compressed = (data) => ({ compressed: true, data: gzipSync(JSON.stringify(data)).toString("base64") });
const collect = async (response, options) => { const result = []; for await (const event of readCoworkEvents(response, options)) result.push(event); return result; };

test("Cowork SSE handles split UTF-8, CRLF and compressed final results", async () => {
  const bytes = Buffer.from(frame("dx", { t: "你好😀" }) + frame("fr", compressed({ content: "结果😀" })) + frame("rl", { st: "ok", mid: "request-message" }));
  const response = new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.subarray(offset, offset + 3));
    controller.close();
  } }));
  assert.deepEqual(await readCoworkCompletion(response, { messageId: "request-message" }), { text: "结果😀", completionEvidence: "fr-plus-rl-ok", correlationEvidence: "request-mid" });
});

test("Cowork completion requires final and successful lifecycle evidence and cancels open subscription", async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(frame("rl", { st: "started", mid: "request-message" }) + frame("fr", { content: "" }) + frame("rl", { st: "ok", requestMessageId: "request-message" })));
  }, cancel() { canceled = true; } }));
  assert.equal((await readCoworkCompletion(response, { messageId: "request-message" })).text, "");
  assert.equal(canceled, true);
  await assert.rejects(readCoworkCompletion(new Response(frame("fr", { content: "candidate" }))), { code: "SUBMISSION_UNKNOWN" });
  await assert.rejects(readCoworkCompletion(new Response(frame("rl", { st: "ok" }))), { code: "PROTOCOL_CHANGED" });
  await assert.rejects(readCoworkCompletion(new Response(frame("rl", { st: "future-success" }))), { code: "PROTOCOL_CHANGED" });
});

test("Cowork rejects cross-operation events, duplicate final results and upstream errors", async () => {
  for (const input of [frame("fr", { content: "wrong", conversationId: "other" }),
    frame("fr", { content: "first" }) + frame("fr", { content: "second" })]) {
    await assert.rejects(readCoworkCompletion(new Response(input), { conversationId: "selected" }), { code: "PROTOCOL_CHANGED" });
  }
  await assert.rejects(readCoworkCompletion(new Response(frame("error", { message: "secret" }))), (error) => error.code === "UPSTREAM_REJECTED" && !error.message.includes("secret"));
});

test("invalid plain JSON, compressed data and incomplete frames do not become success", async () => {
  for (const input of ["event: fr\ndata: secret-invalid-json\n\n", frame("fr", { compressed: true, data: "bad!" }),
    frame("fr", { compressed: true, data: Buffer.from("not-gzip").toString("base64") }), "event: fr\ndata: {}"] ) {
    await assert.rejects(collect(new Response(input)), (error) => error.code === "PROTOCOL_CHANGED" && !error.message.includes("secret"));
  }
});

test("SSE data lines preserve specification whitespace and join with newline", async () => {
  const events = await collect(new Response('event: dx\ndata: {\ndata:  "t": "value"\ndata: }\n\n'));
  assert.equal(events[0].data.t, "value");
});

test("Cowork parsing bounds wire frames, decompression, total data and event counts", async () => {
  await assert.rejects(collect(new Response(frame("dx", { t: "a".repeat(100) })), { limits: { frameBytes: 32 } }), { code: "PROTOCOL_CHANGED" });
  await assert.rejects(collect(new Response(frame("fr", compressed({ content: "a".repeat(1000) }))), { limits: { decodedBytes: 32 } }), { code: "PROTOCOL_CHANGED" });
  await assert.rejects(collect(new Response(frame("dx", { t: "abc" }).repeat(10)), { limits: { totalBytes: 100 } }), { code: "PROTOCOL_CHANGED" });
  await assert.rejects(collect(new Response(frame("dx", { t: "abc" }).repeat(3)), { limits: { eventCount: 2 } }), { code: "PROTOCOL_CHANGED" });
});

test("canceling a pending event read releases the local subscription", async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({ cancel() { canceled = true; } }));
  const controller = new AbortController();
  const pending = readCoworkCompletion(response, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(canceled, true);
});

test("protocol evidence bounds server and tool metadata without exposing names or values", () => {
  const servers = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`private-server-${index}`, {
    name: `private-name-${index}`, url: `https://private-host-${index}.example`,
    headers: { authorization: "private-token" }, "private-dynamic-field": "private-account"
  }]));
  const serverEvidence = eventProtocolEvidence({ event: "cs", compressed: true, data: {
    servers, packages: ["private-package"], "private-top-level-field": "private-body"
  } });
  assert.equal(serverEvidence.kind, "cs");
  assert.equal(serverEvidence.compressed, true);
  assert.equal(serverEvidence.serverCount, 8);
  assert.equal(serverEvidence.packageCount, 1);
  assert.equal(serverEvidence.serverValueFieldTypes.length, 5);
  assert.deepEqual(serverEvidence.serverValueFieldTypes[0], {
    name: "string", url: "string", headers: "object", "<unrecognized-field-name>": "string"
  });
  assert.deepEqual(serverEvidence.fieldTypes, { servers: "object", packages: "array", "<unrecognized-field-name>": "string" });

  const toolEvidence = eventProtocolEvidence({ event: "tk", data: {
    type: "private-tool-type", cnt: 9, items: Array.from({ length: 7 }, () => ({
      name: "private-tool", description: "private-instructions", arguments: { body: "private-arguments" },
      inputSchema: { properties: { "private-property": { type: "string" } } }
    }))
  } });
  assert.equal(toolEvidence.itemCount, 7);
  assert.equal(toolEvidence.reportedCount, 9);
  assert.equal(toolEvidence.itemFieldTypes.length, 5);
  assert.deepEqual(toolEvidence.itemFieldTypes[0], { name: "string", description: "string", arguments: "object", inputSchema: "object" });
  assert.equal(JSON.stringify([serverEvidence, toolEvidence]).includes("private-"), false);
});

test("protocol evidence distinguishes present, matched, mismatched and absent correlation fields", () => {
  const data = { conversationId: "private-conversation", requestMessageId: "private-message", messageId: null,
    mid: "private-upstream-message", eid: "private-message" };
  const evidence = eventProtocolEvidence({ event: "q", data }, { conversationId: "private-conversation", messageId: "private-message" });
  assert.deepEqual(evidence.correlation, {
    conversationId: { present: true, matchesConversationId: true, matchesMessageId: false },
    requestMessageId: { present: true, matchesConversationId: false, matchesMessageId: true },
    messageId: { present: true, matchesConversationId: false, matchesMessageId: false },
    mid: { present: true, matchesConversationId: false, matchesMessageId: false },
    eid: { present: true, matchesConversationId: false, matchesMessageId: true }
  });
  const withoutIds = eventProtocolEvidence({ event: "q", data: { mid: "private-message" } });
  assert.deepEqual(withoutIds.correlation.mid, { present: true });
  assert.deepEqual(withoutIds.correlation.eid, { present: false });
  assert.deepEqual(eventProtocolEvidence({ event: "q", data: {} }, { messageId: "private-message" }).correlation.mid, { present: false });
  assert.equal(JSON.stringify([evidence, withoutIds]).includes("private-"), false);
});

test("protocol evidence emits only allowlisted status and stop strings and valid counters", () => {
  assert.equal(eventProtocolEvidence({ event: "rl", data: { st: "ok", tc: 0, tcc: true } }).toolCallCount, 0);
  assert.equal(eventProtocolEvidence({ event: "rl", data: { st: "running", tc: 2, tcc: false } }).status, "running");
  assert.equal(eventProtocolEvidence({ event: "fr", data: { stop: "end_turn" } }).stopReason, "end_turn");
  assert.equal(eventProtocolEvidence({ event: "tk", data: { cnt: Number.MAX_SAFE_INTEGER } }).reportedCount, Number.MAX_SAFE_INTEGER);
  for (const invalid of [undefined, null, true, false, "3", -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(Object.hasOwn(eventProtocolEvidence({ event: "tk", data: { cnt: invalid } }), "reportedCount"), false);
    assert.equal(Object.hasOwn(eventProtocolEvidence({ event: "rl", data: { tc: invalid, tcc: 5 } }), "toolCallCount"), false);
  }
  const unknownStatus = eventProtocolEvidence({ event: "rl", data: { st: "private-status", content: "private-body" } });
  const unknownStop = eventProtocolEvidence({ event: "fr", data: { stop: "private-stop", content: "private-result" } });
  const unknownKind = eventProtocolEvidence({ event: "private-event", data: { "private-account": "private-value" } });
  assert.equal(Object.hasOwn(unknownStatus, "status"), false);
  assert.equal(Object.hasOwn(unknownStop, "stopReason"), false);
  assert.equal(unknownKind.kind, "<unrecognized-event>");
  assert.equal(JSON.stringify([unknownStatus, unknownStop, unknownKind]).includes("private-"), false);
});

test("protocol evidence summarizes malformed shapes without claiming zero counts", () => {
  for (const servers of [null, [], "private-server"]) {
    const evidence = eventProtocolEvidence({ event: "cs", data: { servers, packages: {} } });
    assert.equal(Object.hasOwn(evidence, "serverCount"), false);
    assert.equal(Object.hasOwn(evidence, "packageCount"), false);
  }
  assert.equal(eventProtocolEvidence({ event: "cs", data: { servers: {}, packages: [] } }).serverCount, 0);
  assert.equal(eventProtocolEvidence({ event: "cs", data: { servers: {}, packages: [] } }).packageCount, 0);
  const evidence = eventProtocolEvidence({ event: "tk", data: { items: ["private-tool", null, [], 7] } });
  assert.deepEqual(evidence.itemFieldTypes, [{ $type: "string" }, { $type: "null" }, { $type: "array" }, { $type: "number" }]);
  assert.equal(Object.hasOwn(eventProtocolEvidence({ event: "tk", data: { items: {} } }), "itemCount"), false);
  assert.deepEqual(eventProtocolEvidence({ event: "fr", data: null }), { kind: "fr", compressed: false, fieldTypes: { $type: "null" } });
  const manyFields = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`private-field-${index}`, "private-value"]));
  const bounded = eventProtocolEvidence({ event: "tk", data: { items: [manyFields] } });
  assert.ok(Object.keys(bounded.itemFieldTypes[0]).length <= 40);
  assert.equal(JSON.stringify([evidence, bounded]).includes("private-"), false);
});

test("completion callback reports safe evidence with distinct request and assistant message IDs", async () => {
  const observations = [];
  const input = frame("q", { mid: "private-message", eid: "private-message" })
    + frame("rl", { st: "started", mid: "private-message" })
    + frame("fr", compressed({ content: "private-result", stop: "end_turn", mid: "private-assistant-id" }))
    + frame("rl", { st: "ok", tc: 2, tcc: false, mid: "private-message" });
  const result = await readCoworkCompletion(new Response(input), {
    conversationId: "private-conversation", messageId: "private-message", onEvent: async (event) => observations.push(event)
  });
  assert.deepEqual(result, { text: "private-result", completionEvidence: "fr-plus-rl-ok", correlationEvidence: "request-mid" });
  assert.equal(observations[0].correlation.mid.matchesMessageId, true);
  assert.equal(observations[0].correlation.eid.matchesMessageId, true);
  assert.equal(observations[1].status, "started");
  assert.equal(observations[1].correlation.mid.matchesMessageId, true);
  assert.equal(observations[2].compressed, true);
  assert.equal(observations[2].stopReason, "end_turn");
  assert.equal(observations[2].correlation.mid.matchesMessageId, false);
  assert.equal(observations[3].status, "ok");
  assert.equal(observations[3].toolCallCount, 2);
  assert.equal(observations[3].fieldTypes.tcc, "boolean");
  assert.equal(JSON.stringify(observations).includes("private-"), false);

  const failedObservations = [];
  await assert.rejects(readCoworkCompletion(new Response(frame("fr", { content: "private-result" }) + frame("rl", { st: "private-status" })), {
    onEvent: (event) => failedObservations.push(event)
  }), { code: "PROTOCOL_CHANGED" });
  assert.equal(Object.hasOwn(failedObservations[1], "status"), false);
  assert.equal(JSON.stringify(failedObservations).includes("private-"), false);
  await assert.rejects(readCoworkCompletion(new Response(frame("fr", { content: "private-result", stop: "end_turn" })), {
    onEvent: () => {}
  }), { code: "SUBMISSION_UNKNOWN" });
});

test("q and lifecycle mid must match the request even when requestMessageId matches", async () => {
  for (const [kind, status] of [["q", undefined], ["rl", "started"], ["rl", "running"], ["rl", "queued"], ["rl", "ok"]]) {
    for (const mid of ["private-other-request", null, "", 42]) {
      const observations = [];
      const input = frame("fr", { content: "private-result", mid: "private-assistant-id" })
        + frame(kind, { st: status, mid, requestMessageId: "private-message" })
        + frame("rl", { st: "ok", mid: "private-message" });
      await assert.rejects(readCoworkCompletion(new Response(input), {
        messageId: "private-message", onEvent: (event) => observations.push(event)
      }), (error) => error.code === "PROTOCOL_CHANGED" && error.submitted && !error.message.includes("private-"));
      assert.equal(observations[1].correlation.mid.matchesMessageId, false);
      assert.equal(observations[1].correlation.requestMessageId.matchesMessageId, true);
      assert.equal(JSON.stringify(observations).includes("private-"), false);
    }
  }
});

test("terminal lifecycle requires its own request ID and cannot borrow earlier correlation", async () => {
  for (const terminal of [{}, { messageId: "private-message" }, { eid: "private-message" }, { conversationId: "private-conversation" },
    { mid: null }, { requestMessageId: null }, { mid: "private-message", requestMessageId: "private-other-request" }]) {
    const input = frame("q", { mid: "private-message" }) + frame("rl", { st: "started", mid: "private-message" })
      + frame("fr", { content: "private-result", mid: "private-message" }) + frame("rl", { st: "ok", ...terminal });
    await assert.rejects(readCoworkCompletion(new Response(input), {
      conversationId: "private-conversation", messageId: "private-message"
    }), { code: "PROTOCOL_CHANGED", submitted: true });
  }
});

test("terminal requestMessageId supplies correlation without binding the assistant mid", async () => {
  for (const terminal of [{ requestMessageId: "request-message" }, { requestMessageId: "request-message", mid: "request-message" }]) {
    const input = frame("q", {}) + frame("rl", { st: "started" })
      + frame("fr", { content: "result", mid: "assistant-message", stop: "end_turn" }) + frame("rl", { st: "ok", ...terminal });
    assert.deepEqual(await readCoworkCompletion(new Response(input), { messageId: "request-message" }), {
      text: "result", completionEvidence: "fr-plus-rl-ok", correlationEvidence: "request-message-id"
    });
  }
  await assert.rejects(readCoworkCompletion(new Response(frame("fr", {
    content: "result", mid: "assistant-message", requestMessageId: "another-request"
  }) + frame("rl", { st: "ok", mid: "request-message" })), { messageId: "request-message" }), { code: "PROTOCOL_CHANGED", submitted: true });
});

test("completion cannot claim correlation without a valid context message ID", async () => {
  for (const messageId of [undefined, null, "", 42]) {
    const input = frame("fr", { content: "candidate" }) + frame("rl", { st: "ok", ...(messageId === undefined ? {} : { mid: messageId }) });
    await assert.rejects(readCoworkCompletion(new Response(input), { messageId }), { code: "PROTOCOL_CHANGED", submitted: true });
  }
});
