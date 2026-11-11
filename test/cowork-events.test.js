import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { readCoworkCompletion, readCoworkEvents } from "../src/cowork/events.js";

const frame = (event, data) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
const compressed = (data) => ({ compressed: true, data: gzipSync(JSON.stringify(data)).toString("base64") });
const collect = async (response, options) => { const result = []; for await (const event of readCoworkEvents(response, options)) result.push(event); return result; };

test("Cowork SSE handles split UTF-8, CRLF and compressed final results", async () => {
  const bytes = Buffer.from(frame("dx", { t: "你好😀" }) + frame("fr", compressed({ content: "结果😀" })) + frame("rl", { st: "ok" }));
  const response = new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += 3) controller.enqueue(bytes.subarray(offset, offset + 3));
    controller.close();
  } }));
  assert.deepEqual(await readCoworkCompletion(response), { text: "结果😀", completionEvidence: "fr-plus-rl-ok" });
});

test("Cowork completion requires final and successful lifecycle evidence and cancels open subscription", async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(frame("rl", { st: "started" }) + frame("fr", { content: "" }) + frame("rl", { st: "ok" })));
  }, cancel() { canceled = true; } }));
  assert.equal((await readCoworkCompletion(response)).text, "");
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
