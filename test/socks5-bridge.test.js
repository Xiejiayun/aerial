import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { startSocks5Bridge, _closeSocks5BridgesForTests } from "../src/socks5-bridge.js";

test.afterEach(async () => {
  await _closeSocks5BridgesForTests();
});

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function getFreePort() {
  const server = net.createServer();
  await listen(server);
  const { port } = server.address();
  await closeServer(server);
  return port;
}

function connect(port) {
  const socket = net.connect(port, "127.0.0.1");
  return once(socket, "connect").then(() => socket);
}

function readUntil(socket, marker) {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.includes(marker)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

async function startEchoServer() {
  const server = net.createServer((socket) => socket.pipe(socket));
  await listen(server);
  return {
    port: server.address().port,
    close: () => closeServer(server)
  };
}

function parseSocksDestination(buffer) {
  if (buffer.length < 5) return undefined;
  if (buffer[0] !== 5 || buffer[1] !== 1) return { error: true };
  let offset = 4;
  let host;
  if (buffer[3] === 1) {
    if (buffer.length < offset + 4 + 2) return undefined;
    host = [...buffer.subarray(offset, offset + 4)].join(".");
    offset += 4;
  } else if (buffer[3] === 3) {
    const length = buffer[offset];
    if (buffer.length < offset + 1 + length + 2) return undefined;
    host = buffer.subarray(offset + 1, offset + 1 + length).toString("utf8");
    offset += 1 + length;
  } else {
    return { error: true };
  }
  const port = buffer.readUInt16BE(offset);
  return {
    host,
    port,
    rest: buffer.subarray(offset + 2)
  };
}

async function startMockSocks5Server() {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    let upstream;

    const fail = () => {
      socket.write(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      socket.destroy();
    };

    const pump = () => {
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const methods = buffer[1];
        if (buffer.length < 2 + methods) return;
        socket.write(Buffer.from([5, 0]));
        buffer = buffer.subarray(2 + methods);
        stage = "request";
      }

      if (stage !== "request") return;
      const destination = parseSocksDestination(buffer);
      if (!destination) return;
      if (destination.error) {
        fail();
        return;
      }
      stage = "connected";
      upstream = net.connect(destination.port, destination.host, () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (destination.rest.length) upstream.write(destination.rest);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on("error", fail);
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on("close", () => upstream?.destroy());
    socket.on("error", () => upstream?.destroy());
  });
  await listen(server);
  return {
    port: server.address().port,
    close: () => closeServer(server)
  };
}

test("SOCKS5 bridge rejects non-CONNECT requests", async () => {
  const bridge = await startSocks5Bridge("socks5://127.0.0.1:9");
  const client = await connect(bridge.port);
  const pending = readUntil(client, "\r\n\r\n");
  client.write("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n");
  const response = await pending;
  assert.match(response.toString("latin1"), /^HTTP\/1\.1 400 Bad Request/);
  client.destroy();
});

test("SOCKS5 bridge reports 502 when the SOCKS proxy is unreachable", async () => {
  const port = await getFreePort();
  const bridge = await startSocks5Bridge(`socks5://127.0.0.1:${port}`);
  const client = await connect(bridge.port);
  const pending = readUntil(client, "\r\n\r\n");
  client.write("CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n");
  const response = await pending;
  assert.match(response.toString("latin1"), /^HTTP\/1\.1 502 Bad Gateway/);
  client.destroy();
});

test("SOCKS5 bridge tunnels CONNECT traffic through SOCKS5", async () => {
  const echo = await startEchoServer();
  const socks = await startMockSocks5Server();
  try {
    const bridge = await startSocks5Bridge(`socks5://127.0.0.1:${socks.port}`);
    const client = await connect(bridge.port);
    const pending = readUntil(client, "\r\n\r\n");
    client.write(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n\r\n`);
    const response = await pending;
    assert.match(response.toString("latin1"), /^HTTP\/1\.1 200 Connection Established/);

    client.write("ping");
    const [data] = await once(client, "data");
    assert.equal(data.toString("utf8"), "ping");
    client.destroy();
  } finally {
    await socks.close();
    await echo.close();
  }
});
