import test from "node:test";
import assert from "node:assert/strict";
import { copyResponseHeaders } from "../src/proxy/headers.js";

test("retry, rate-limit and diagnostic headers survive without transport or cookie headers", () => {
  const keep = {
    "content-type": "application/json", "cache-control": "no-store", "retry-after": "30", "x-should-retry": "true",
    "x-request-id": "request-123", "x-github-request-id": "github-123",
    "x-ratelimit-remaining": "0", "anthropic-ratelimit-tokens-reset": "2026-10-13T15:00:00Z", "ratelimit-policy": "100;w=60"
  };
  const response = new Response("{}", { headers: { ...keep, "content-encoding": "gzip", "content-length": "100", "transfer-encoding": "chunked", "set-cookie": "session=private" } });
  const headers = copyResponseHeaders(response);
  for (const [name, value] of Object.entries(keep)) assert.equal(headers.get(name), value, name);
  for (const name of ["content-encoding", "content-length", "transfer-encoding", "set-cookie"]) assert.equal(headers.get(name), null);
  response.headers.set("connection", "x-request-id");
  assert.equal(copyResponseHeaders(response).get("x-request-id"), null);
});
