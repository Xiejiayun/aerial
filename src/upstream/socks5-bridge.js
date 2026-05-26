import net from "node:net";
import { SocksClient } from "socks";
import { isSocksProxyEndpoint, normalizeProxyEndpoint } from "./proxy-config.js";

const MAX_CONNECT_HEADER_BYTES = 8192;
const SOCKET_TIMEOUT_MS = 10000;
const bridgeCache = new Map();

function stripIpv6Brackets(host) {
  return String(host || "").replace(/^\[/, "").replace(/\]$/, "");
}

function parseSocksEndpoint(endpoint) {
  const normalized = normalizeProxyEndpoint(endpoint);
  if (!isSocksProxyEndpoint(normalized)) throw new Error("invalid SOCKS5 proxy endpoint");
  const url = new URL(normalized);
  const port = Number(url.port || 1080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid SOCKS5 proxy port");
  }
  return {
    host: stripIpv6Brackets(url.hostname),
    port,
    type: 5,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined
  };
}

function parseConnectAuthority(authority) {
  const text = String(authority || "").trim();
  let host;
  let portText;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0 || text[end + 1] !== ":") return undefined;
    host = text.slice(1, end);
    portText = text.slice(end + 2);
  } else {
    const colon = text.lastIndexOf(":");
    if (colon <= 0) return undefined;
    host = text.slice(0, colon);
    portText = text.slice(colon + 1);
    if (host.includes(":")) return undefined;
  }
  if (!host || !/^\d+$/.test(portText)) return undefined;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

function parseConnectRequest(buffer) {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return undefined;
  const header = buffer.subarray(0, headerEnd).toString("latin1");
  const [requestLine] = header.split("\r\n");
  const match = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(requestLine || "");
  const target = match ? parseConnectAuthority(match[1]) : undefined;
  if (!target) return { error: "bad_request" };
  return {
    target,
    rest: buffer.subarray(headerEnd + 4)
  };
}

function writeHttpError(socket, status, reason) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function destroyBoth(left, right) {
  try { left.destroy(); } catch {}
  try { right.destroy(); } catch {}
}

async function connectViaSocks(proxy, target) {
  const result = await SocksClient.createConnection({
    command: "connect",
    proxy,
    destination: target,
    timeout: SOCKET_TIMEOUT_MS
  });
  return result.socket;
}

function handleClient(client, proxy) {
  let buffer = Buffer.alloc(0);
  client.setTimeout(SOCKET_TIMEOUT_MS, () => writeHttpError(client, 408, "Request Timeout"));

  const onData = async (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_CONNECT_HEADER_BYTES) {
      client.removeListener("data", onData);
      writeHttpError(client, 400, "Bad Request");
      return;
    }

    const parsed = parseConnectRequest(buffer);
    if (!parsed) return;
    client.removeListener("data", onData);
    client.setTimeout(0);
    if (parsed.error) {
      writeHttpError(client, 400, "Bad Request");
      return;
    }

    client.pause();
    let upstream;
    try {
      upstream = await connectViaSocks(proxy, parsed.target);
    } catch {
      writeHttpError(client, 502, "Bad Gateway");
      return;
    }
    if (client.destroyed) {
      upstream.destroy();
      return;
    }

    upstream.on("error", () => destroyBoth(client, upstream));
    client.on("error", () => destroyBoth(client, upstream));
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());

    client.write("HTTP/1.1 200 Connection Established\r\nProxy-agent: Aerial\r\n\r\n");
    if (parsed.rest.length) upstream.write(parsed.rest);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  };

  client.on("data", onData);
  client.on("error", () => client.destroy());
}

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

async function createBridge(endpoint) {
  const normalized = normalizeProxyEndpoint(endpoint);
  const proxy = parseSocksEndpoint(normalized);
  const server = net.createServer((client) => handleClient(client, proxy));
  await listen(server);
  server.unref();
  const address = server.address();
  return {
    socksEndpoint: normalized,
    endpoint: `http://127.0.0.1:${address.port}`,
    host: "127.0.0.1",
    port: address.port,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    })
  };
}

export async function startSocks5Bridge(endpoint) {
  const normalized = normalizeProxyEndpoint(endpoint);
  if (!isSocksProxyEndpoint(normalized)) throw new Error("invalid SOCKS5 proxy endpoint");
  if (!bridgeCache.has(normalized)) {
    const promise = createBridge(normalized).catch((err) => {
      bridgeCache.delete(normalized);
      throw err;
    });
    bridgeCache.set(normalized, promise);
  }
  return bridgeCache.get(normalized);
}

export async function _closeSocks5BridgesForTests() {
  const bridges = await Promise.allSettled([...bridgeCache.values()]);
  bridgeCache.clear();
  await Promise.all(bridges
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value.close().catch(() => {})));
}
