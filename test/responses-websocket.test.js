import test from "node:test";
import assert from "node:assert/strict";

import { shouldUseResponsesWebSocket, supportsResponsesWebSocket } from "../src/proxy/responses-websocket.js";

test("supportsResponsesWebSocket detects Copilot ws:/responses endpoint", () => {
  assert.equal(supportsResponsesWebSocket({ supported_endpoints: ["/responses", "ws:/responses"] }), true);
  assert.equal(supportsResponsesWebSocket({ supported_endpoints: ["/responses"] }), false);
  assert.equal(supportsResponsesWebSocket({}), false);
});

test("shouldUseResponsesWebSocket is opt-in via AERIAL_RESPONSES_WEBSOCKET=on and requires streaming", () => {
  const model = { supported_endpoints: ["/responses", "ws:/responses"] };
  const previous = process.env.AERIAL_RESPONSES_WEBSOCKET;

  try {
    delete process.env.AERIAL_RESPONSES_WEBSOCKET;
    // default-off: streaming alone is not enough
    assert.equal(shouldUseResponsesWebSocket({ stream: true }, model), false);

    process.env.AERIAL_RESPONSES_WEBSOCKET = "on";
    assert.equal(shouldUseResponsesWebSocket({ stream: true }, model), true);
    assert.equal(shouldUseResponsesWebSocket({ stream: false }, model), false);
    assert.equal(shouldUseResponsesWebSocket({}, model), false);
    // model without ws:/responses still must not use WS
    assert.equal(shouldUseResponsesWebSocket({ stream: true }, { supported_endpoints: ["/responses"] }), false);

    process.env.AERIAL_RESPONSES_WEBSOCKET = "off";
    assert.equal(shouldUseResponsesWebSocket({ stream: true }, model), false);

    process.env.AERIAL_RESPONSES_WEBSOCKET = "true";
    assert.equal(shouldUseResponsesWebSocket({ stream: true }, model), false);
  } finally {
    if (previous === undefined) delete process.env.AERIAL_RESPONSES_WEBSOCKET;
    else process.env.AERIAL_RESPONSES_WEBSOCKET = previous;
  }
});
