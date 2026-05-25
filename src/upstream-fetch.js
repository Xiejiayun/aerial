import { spawnSync } from "node:child_process";
import { ProxyAgent } from "undici";
import { loadConfig, saveConfig } from "./config.js";
import { PROXY_MODE_AUTO, PROXY_MODE_DISABLED, isSocksProxyEndpoint, normalizeProxyEndpoint, normalizeProxyMode } from "./proxy-config.js";
import { startSocks5Bridge, _closeSocks5BridgesForTests } from "./socks5-bridge.js";

const VALIDATION_URL = "https://api.github.com/rate_limit";
const EGRESS_URL = "https://ipinfo.io/json";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PAC_BYTES = 1024 * 1024;
const COMMON_LOCAL_HTTP_PROXY_PORTS = Object.freeze([
  1087,
  7890,
  7897,
  7899,
  6152,
  10808,
  10809
]);
const COMMON_LOCAL_SOCKS_PROXY_PORTS = Object.freeze([
  1086,
  1080,
  7891,
  10808
]);

const dispatcherCache = new Map();

function defaultRunCommand(file, args, opts = {}) {
  const result = spawnSync(file, args, {
    stdio: "pipe",
    encoding: "utf8",
    timeout: opts.timeout || 3000,
    windowsHide: true
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error
  };
}

function endpointFromHostPort({ scheme = "http", host, port }) {
  const hostname = String(host || "").trim();
  const n = Number(String(port || "").trim());
  if (!hostname || !Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  const hostPart = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return normalizeProxyEndpoint(`${scheme}://${hostPart}:${n}`);
}

function addCandidate(map, candidate) {
  const endpoint = normalizeProxyEndpoint(candidate?.endpoint);
  if (!endpoint || map.has(endpoint)) return;
  map.set(endpoint, {
    endpoint,
    source: candidate?.source || "discovered",
    priority: Number.isFinite(candidate?.priority) ? candidate.priority : map.size
  });
}

function parseScutilValueMap(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1].trim()] = match[2].trim();
  }
  return values;
}

function scutilEnabled(values, key) {
  return values[key] === "1" || values[key]?.toLowerCase?.() === "yes";
}

export function parseScutilProxyOutput(text) {
  const values = parseScutilValueMap(text);
  const candidates = [];
  if (scutilEnabled(values, "HTTPEnable")) {
    const endpoint = endpointFromHostPort({ host: values.HTTPProxy, port: values.HTTPPort });
    if (endpoint) candidates.push({ endpoint, source: "macos-http-proxy" });
  }
  if (scutilEnabled(values, "HTTPSEnable")) {
    const endpoint = endpointFromHostPort({ host: values.HTTPSProxy, port: values.HTTPSPort });
    if (endpoint) candidates.push({ endpoint, source: "macos-https-proxy" });
  }
  if (scutilEnabled(values, "SOCKSEnable")) {
    const endpoint = endpointFromHostPort({ scheme: "socks5", host: values.SOCKSProxy, port: values.SOCKSPort });
    if (endpoint) candidates.push({ endpoint, source: "macos-socks-proxy" });
  }
  return {
    values,
    candidates,
    pacUrl: scutilEnabled(values, "ProxyAutoConfigEnable") ? values.ProxyAutoConfigURLString : undefined
  };
}

export function parsePacProxyCandidates(text, { source = "pac" } = {}) {
  const out = [];
  const re = /\b(PROXY|HTTPS|SOCKS5?|SOCKS)\s+([A-Za-z0-9_.-]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})\b/g;
  let match;
  while ((match = re.exec(String(text || ""))) !== null) {
    const directive = match[1].toUpperCase();
    const scheme = directive === "HTTPS" ? "https" : directive.startsWith("SOCKS") ? "socks5" : "http";
    const endpoint = endpointFromHostPort({ scheme, host: match[2], port: match[3] });
    if (endpoint) out.push({ endpoint, source });
  }
  return out;
}

function proxyEndpointFromEnv(name) {
  const endpoint = normalizeProxyEndpoint(process.env[name]);
  return endpoint ? { endpoint, source: name } : undefined;
}

async function responseTextWithLimit(response, maxBytes) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new Error("PAC file is too large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("PAC file is too large");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error("PAC file is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function pacCandidatesFromUrl(pacUrl, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, maxPacBytes = MAX_PAC_BYTES } = {}) {
  if (!pacUrl) return [];
  try {
    const response = await fetchImpl(pacUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return [];
    const text = await responseTextWithLimit(response, maxPacBytes);
    return parsePacProxyCandidates(text, { source: `macos-pac:${pacUrl}` });
  } catch {
    return [];
  }
}

export async function discoverProxyCandidates({
  config = loadConfig(),
  fetchImpl = globalThis.fetch,
  runCommand = defaultRunCommand,
  platform = process.platform,
  commonPorts = COMMON_LOCAL_HTTP_PROXY_PORTS,
  commonSocksPorts = COMMON_LOCAL_SOCKS_PROXY_PORTS,
  maxPacBytes = MAX_PAC_BYTES
} = {}) {
  const candidates = new Map();

  for (const envName of ["AERIAL_UPSTREAM_PROXY", "ALL_PROXY", "HTTPS_PROXY", "HTTP_PROXY", "all_proxy", "https_proxy", "http_proxy"]) {
    addCandidate(candidates, proxyEndpointFromEnv(envName));
  }

  addCandidate(candidates, {
    endpoint: config.upstreamProxyEndpoint,
    source: config.upstreamProxySource || "configured"
  });

  if (platform === "darwin") {
    const scutil = runCommand("scutil", ["--proxy"], { timeout: 3000 });
    if (scutil.status === 0) {
      const parsed = parseScutilProxyOutput(scutil.stdout);
      for (const candidate of parsed.candidates) addCandidate(candidates, candidate);
      const pacCandidates = await pacCandidatesFromUrl(parsed.pacUrl, { fetchImpl, maxPacBytes });
      for (const candidate of pacCandidates) addCandidate(candidates, candidate);
    }
  }

  for (const port of commonSocksPorts) {
    addCandidate(candidates, {
      endpoint: `socks5://127.0.0.1:${port}`,
      source: "common-local-socks-port"
    });
  }

  for (const port of commonPorts) {
    addCandidate(candidates, {
      endpoint: `http://127.0.0.1:${port}`,
      source: "common-local-port"
    });
  }

  return [...candidates.values()].sort((a, b) => a.priority - b.priority);
}

async function agentEndpointForProxyEndpoint(endpoint) {
  const normalized = normalizeProxyEndpoint(endpoint);
  if (!normalized) return undefined;
  if (!isSocksProxyEndpoint(normalized)) return normalized;
  const bridge = await startSocks5Bridge(normalized);
  return bridge.endpoint;
}

async function dispatcherForEndpoint(endpoint) {
  const agentEndpoint = await agentEndpointForProxyEndpoint(endpoint);
  if (!agentEndpoint) return undefined;
  if (!dispatcherCache.has(agentEndpoint)) dispatcherCache.set(agentEndpoint, new ProxyAgent(agentEndpoint));
  return dispatcherCache.get(agentEndpoint);
}

export function upstreamProxyState(config = loadConfig()) {
  const envProxy = proxyEndpointFromEnv("AERIAL_UPSTREAM_PROXY");
  if (envProxy) {
    return {
      mode: "env",
      enabled: true,
      endpoint: envProxy.endpoint,
      source: envProxy.source
    };
  }
  const mode = normalizeProxyMode(config.upstreamProxyMode);
  const endpoint = normalizeProxyEndpoint(config.upstreamProxyEndpoint);
  const enabled = mode === PROXY_MODE_AUTO && Boolean(endpoint);
  return {
    mode,
    enabled,
    endpoint: enabled ? endpoint : undefined,
    source: enabled ? (config.upstreamProxySource || "configured") : undefined
  };
}

export async function upstreamDispatcher(config = loadConfig()) {
  const state = upstreamProxyState(config);
  return state.enabled ? await dispatcherForEndpoint(state.endpoint) : undefined;
}

export async function fetchWithProxyEndpoint(url, init = {}, endpoint, fetchImpl = globalThis.fetch) {
  const dispatcher = await dispatcherForEndpoint(endpoint);
  if (!dispatcher) return fetchImpl(url, init);
  return fetchImpl(url, { ...init, dispatcher });
}

export async function upstreamFetch(url, init = {}) {
  const state = upstreamProxyState();
  if (!state.enabled) return globalThis.fetch(url, init);
  return fetchWithProxyEndpoint(url, init, state.endpoint);
}

export async function validateProxyEndpoint(endpoint, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const normalized = normalizeProxyEndpoint(endpoint);
  if (!normalized) return { ok: false, error: "invalid proxy endpoint" };
  try {
    const response = await fetchWithProxyEndpoint(VALIDATION_URL, {
      headers: { "user-agent": "Aerial/0.1" },
      signal: AbortSignal.timeout(timeoutMs)
    }, normalized, fetchImpl);
    if (!response.ok) return { ok: false, status: response.status, error: `http ${response.status}` };
    let payload;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    if (payload?.resources && typeof payload.resources === "object") {
      return { ok: true, status: response.status };
    }
    if (payload?.rate && typeof payload.rate === "object") {
      return { ok: true, status: response.status };
    }
    return { ok: false, status: response.status, error: "GitHub validation response did not match rate_limit JSON" };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

export async function selectWorkingProxyCandidate(candidates, opts = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const validated = await Promise.all(list.map(async (candidate) => ({
    ...candidate,
    validation: await validateProxyEndpoint(candidate.endpoint, opts)
  })));
  return validated.find((candidate) => candidate.validation.ok) || undefined;
}

export async function enableUpstreamProxy(opts = {}) {
  const config = opts.config || loadConfig();
  const candidates = opts.candidates || await discoverProxyCandidates({ ...opts, config });
  const selected = await selectWorkingProxyCandidate(candidates, opts);
  if (!selected) {
    return {
      ok: false,
      candidates,
      error: candidates.length
        ? "No discovered HTTP(S) or SOCKS5 proxy could reach GitHub."
        : "No HTTP(S) or SOCKS5 proxy candidates were found."
    };
  }
  const next = {
    ...config,
    upstreamProxyMode: PROXY_MODE_AUTO,
    upstreamProxyEndpoint: selected.endpoint,
    upstreamProxySource: selected.source
  };
  saveConfig(next);
  return { ok: true, selected, candidates };
}

export function disableUpstreamProxy(config = loadConfig()) {
  const next = {
    ...config,
    upstreamProxyMode: PROXY_MODE_DISABLED,
    upstreamProxyEndpoint: undefined,
    upstreamProxySource: undefined
  };
  saveConfig(next);
  return next;
}

export async function probeEgress({
  endpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  try {
    const response = await fetchWithProxyEndpoint(EGRESS_URL, {
      headers: { "user-agent": "Aerial/0.1" },
      signal: AbortSignal.timeout(timeoutMs)
    }, endpoint, fetchImpl);
    if (!response.ok) return { ok: false, status: response.status, error: `http ${response.status}` };
    const payload = await response.json();
    return {
      ok: true,
      ip: payload.ip,
      city: payload.city,
      region: payload.region,
      country: payload.country,
      org: payload.org
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

export function _clearProxyDispatcherCacheForTests() {
  dispatcherCache.clear();
  return _closeSocks5BridgesForTests();
}
