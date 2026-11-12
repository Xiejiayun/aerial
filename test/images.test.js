import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-images-"));
process.env.AERIAL_API_KEY = "aerial_test_images";
process.env.AERIAL_GITHUB_TOKEN = "github-test-images";
delete process.env.AERIAL_UPSTREAM_PROXY;

const { createServer } = await import("../src/proxy/server.js");
const { ensureApiKey } = await import("../src/shared/config.js");
const { _resetCopilotTokenCacheForTests } = await import("../src/shared/auth.js");
ensureApiKey();
const originalFetch = globalThis.fetch;
const routes = ["/v1/images/generations", "/v1/images/edits"];
const localHeaders = { authorization: "Bearer aerial_test_images", "content-type": "application/json" };

test.beforeEach(() => _resetCopilotTokenCacheForTests());
test.afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetCopilotTokenCacheForTests();
});

async function listen(t) {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function upstream(handler) {
  let tokenCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("copilot_internal")) {
      return Response.json({ token: `copilot-image-token-${++tokenCalls}` });
    }
    return handler(String(url), init);
  };
  return () => tokenCalls;
}

function postHeaders(url, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: "POST", agent: false, headers: { connection: "close", ...headers } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on("error", reject);
    request.setTimeout(3000, () => request.destroy(new Error("header rejection timed out")));
    request.end();
  });
}

for (const route of routes) {
  test(`${route} rejects unauthorized and oversized uploads before contacting Copilot`, async t => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error("must not contact upstream"); };
    const base = await listen(t);
    for (const authorization of [undefined, "Bearer wrong-key"]) {
      const response = await postHeaders(base + route, {
        ...(authorization ? { authorization } : {}), "content-length": "33554433"
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.error.type, "authentication_error");
    }
    const response = await postHeaders(base + route, { ...localHeaders, "content-length": "33554433" });
    assert.equal(response.status, 413);
    assert.equal(response.body.error.type, "request_entity_too_large");
    assert.equal(calls, 0);
  });

  test(`${route} preserves JSON bytes, image options, response bytes and usage`, async t => {
    const input = '{ "model": "image-test", "prompt": "字母 A–Z", "size": "3840x2160", "quality": "high", "n": 1, "output_format": "png", "future_option": true }\n';
    const output = '{ "created": 1, "data": [{"b64_json":"dGVzdC1pbWFnZQ=="}], "usage": {"output_tokens":12} }\n';
    let calls = 0;
    upstream((url, init) => {
      calls++;
      assert.equal(url, `https://api.githubcopilot.com${route}`);
      assert.equal(init.method, "POST");
      assert.equal(Buffer.from(init.body).toString("utf8"), input);
      assert.equal(init.headers.authorization, "Bearer copilot-image-token-1");
      assert.equal(init.headers["x-api-key"], undefined);
      assert.equal(init.headers["content-type"], "application/json");
      const response = new Response(output, { headers: { "content-type": "application/json", "x-request-id": "image-request" } });
      response.clone = () => { throw new Error("large image responses must not be cloned for telemetry"); };
      return response;
    });
    const base = await listen(t);
    const response = await originalFetch(base + route, { method: "POST", headers: localHeaders, body: input });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-request-id"), "image-request");
    assert.equal(await response.text(), output);
    assert.equal(calls, 1);
  });
}

test("multipart edits preserve multiple files, masks, boundary and binary bytes", async t => {
  const image = new Uint8Array([0, 255, 13, 10, 128, 42]);
  const form = new FormData();
  form.set("model", "image-edit-test");
  form.set("prompt", "Make the background blue");
  form.set("size", "3840x2160");
  form.append("image[]", new Blob([image], { type: "image/png" }), "first.png");
  form.append("image[]", new Blob([image], { type: "image/png" }), "second.png");
  form.set("mask", new Blob([image], { type: "image/png" }), "mask.png");
  const encoded = new Request("http://local.test", { method: "POST", body: form });
  const contentType = encoded.headers.get("content-type");
  const body = Buffer.from(await encoded.arrayBuffer());
  upstream((url, init) => {
    assert.equal(url, "https://api.githubcopilot.com/v1/images/edits");
    assert.equal(init.headers["content-type"], contentType);
    assert.deepEqual(Buffer.from(init.body), body);
    return Response.json({ data: [{ b64_json: "ZWRpdGVk" }] });
  });
  const base = await listen(t);
  const response = await originalFetch(base + routes[1], {
    method: "POST", headers: { "x-api-key": "aerial_test_images", "content-type": contentType }, body
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data[0].b64_json, "ZWRpdGVk");
});

for (const route of routes) {
  test(`${route} refreshes once on 401 and replays the identical buffered body`, async t => {
    const contentType = route.endsWith("edits") ? "multipart/form-data; boundary=image-test" : "application/json";
    const body = route.endsWith("edits")
      ? Buffer.from("--image-test\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.png\"\r\n\r\n\x00\xff\r\n--image-test--\r\n", "latin1")
      : Buffer.from('{"model":"image-test","prompt":"A"}');
    let calls = 0;
    let discarded = false;
    const tokenCalls = upstream((_url, init) => {
      assert.deepEqual(Buffer.from(init.body), body);
      assert.equal(init.headers["content-type"], contentType);
      assert.equal(init.headers.authorization, `Bearer copilot-image-token-${++calls}`);
      if (calls === 1) return new Response(new ReadableStream({ cancel() { discarded = true; } }), { status: 401 });
      return Response.json({ error: { message: "still unauthorized" } }, { status: 401 });
    });
    const base = await listen(t);
    const response = await originalFetch(base + route, { method: "POST", headers: { ...localHeaders, "content-type": contentType }, body });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.message, "still unauthorized");
    assert.equal(calls, 2);
    assert.equal(tokenCalls(), 2);
    assert.equal(discarded, true);
  });
}

for (const status of [400, 403, 429, 500]) {
  test(`image failures preserve ${status} and diagnostics without retrying`, async t => {
    let calls = 0;
    upstream(() => {
      calls++;
      return Response.json({ error: { type: "image_error", message: "upstream image failure" } }, { status, headers: {
        "retry-after": "15", "x-request-id": "image-failure", "x-ratelimit-remaining": "0", "set-cookie": "private=value"
      } });
    });
    const base = await listen(t);
    const response = await originalFetch(base + routes[0], { method: "POST", headers: localHeaders, body: "{}" });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "15");
    assert.equal(response.headers.get("x-request-id"), "image-failure");
    assert.equal(response.headers.get("x-ratelimit-remaining"), "0");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.json()).error.message, "upstream image failure");
    assert.equal(calls, 1);
  });
}

for (const route of routes) {
  test(`${route} streams partial image events before completion and cancels on disconnect`, async t => {
    const first = 'event: image_generation.partial_image\ndata: {"partial_image_b64":"dGVzdA=="}\n\n';
    let cancelled;
    const closed = new Promise(resolve => { cancelled = resolve; });
    upstream((_url, init) => {
      assert.equal(init.headers.accept, "text/event-stream");
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(first)); },
        cancel() { cancelled(); }
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const base = await listen(t);
    const response = await originalFetch(base + route, {
      method: "POST", headers: { ...localHeaders, accept: "text/event-stream" }, body: '{"model":"image-test","stream":true}'
    });
    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.equal(new TextDecoder().decode(value), first);
    await reader.cancel();
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("image stream not cancelled")), 3000); })]);
    } finally { clearTimeout(timer); }
    const health = await originalFetch(base + "/health");
    assert.equal(health.status, 200);
  });
}
