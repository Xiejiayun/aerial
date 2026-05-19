import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";

process.env.AERIAL_CONFIG_DIR = process.env.AERIAL_CONFIG_DIR || "aerial-server-test";
process.env.AERIAL_API_KEY = "aerial_test_key";

const { createServer } = await import("../src/server.js");

test("server rejects websocket upgrade explicitly", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();

  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.write([
    "GET /v1/responses HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
    "",
    ""
  ].join("\r\n"));

  let data = "";
  socket.on("data", (chunk) => { data += chunk.toString("utf8"); });
  await once(socket, "end");
  server.close();

  assert.match(data, /501 Not Implemented/);
  assert.match(data, /Aerial does not expose a client WebSocket/);
  assert.match(data, /HTTP POST \/v1\/responses/);
  assert.match(data, /internal opt-in transport/);
  assert.doesNotMatch(data, /WebSocket Responses is not implemented/);
});
