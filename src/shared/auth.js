import fs from "node:fs";
import { COPILOT_TOKEN_URL, GITHUB_CLIENT_ID } from "./constants.js";
import { githubTokenPath, writePrivateFile } from "./paths.js";
import { logEvent } from "./log.js";
import { upstreamFetch } from "../upstream/fetch.js";
import { waitForPromise } from "./abort.js";

let cachedCopilotToken;
let refresh;

function formBody(values) {
  return new URLSearchParams(values).toString();
}

export async function startDeviceFlow() {
  logEvent("login_start");
  const response = await upstreamFetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: GITHUB_CLIENT_ID, scope: "read:user copilot" })
  });
  if (!response.ok) throw new Error(`GitHub device flow failed: ${response.status} ${await response.text()}`);
  return response.json();
}

export async function pollDeviceFlow(deviceCode, intervalSeconds) {
  let interval = Math.max(Number(intervalSeconds || 5), 1);
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    const response = await upstreamFetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: formBody({ client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
    });
    if (!response.ok) throw new Error(`GitHub token poll failed: ${response.status} ${await response.text()}`);
    const payload = await response.json();
    if (payload.access_token) {
      writePrivateFile(githubTokenPath(), `${payload.access_token}\n`);
      logEvent("login_success");
      return payload.access_token;
    }
    if (payload.error === "authorization_pending") continue;
    if (payload.error === "slow_down") {
      interval += 5;
      continue;
    }
    if (payload.error === "expired_token") throw new Error("GitHub device code expired. Run `aerial login` again.");
    throw new Error(`GitHub login failed: ${payload.error_description || payload.error}`);
  }
}

export function readGitHubToken() {
  const envToken = process.env.AERIAL_GITHUB_TOKEN?.trim();
  if (envToken) return envToken;
  if (!fs.existsSync(githubTokenPath())) return undefined;
  const fileToken = fs.readFileSync(githubTokenPath(), "utf8").trim();
  return fileToken || undefined;
}

export function gitHubTokenSource() {
  if (process.env.AERIAL_GITHUB_TOKEN?.trim()) return "env";
  if (fs.existsSync(githubTokenPath())) {
    const fileToken = fs.readFileSync(githubTokenPath(), "utf8").trim();
    if (fileToken) return "file";
  }
  return "missing";
}

function jwtExpirySeconds(token) {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp;
  } catch {
    return undefined;
  }
}

export async function exchangeCopilotToken(githubToken = readGitHubToken(), { signal } = {}) {
  signal?.throwIfAborted();
  if (!githubToken) throw new Error("Missing GitHub token. Run: aerial login");
  const response = await upstreamFetch(COPILOT_TOKEN_URL, {
    signal,
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: "application/json",
      "user-agent": "Aerial/0.1"
    }
  });
  if (!response.ok) {
    const err = new Error(`Copilot token exchange failed: ${response.status} ${await response.text()}`);
    err.aerialUpstreamStatus = response.status;
    throw err;
  }
  const payload = await response.json();
  signal?.throwIfAborted();
  const token = payload.token;
  if (!token) throw new Error("Copilot token exchange response did not include token");
  cachedCopilotToken = { token, expiresAt: (payload.expires_at ? Date.parse(payload.expires_at) / 1000 : jwtExpirySeconds(token)) || Math.floor(Date.now() / 1000) + 1200 };
  logEvent("token_refresh_success", { expiresAt: cachedCopilotToken.expiresAt });
  return cachedCopilotToken.token;
}

export async function getCopilotToken({ force = false, signal } = {}) {
  signal?.throwIfAborted();
  const now = Math.floor(Date.now() / 1000);
  if (!force && cachedCopilotToken && cachedCopilotToken.expiresAt - now > 120) return cachedCopilotToken.token;
  if (!refresh || refresh.controller.signal.aborted) {
    const operation = { controller: new AbortController(), waiters: 0, settled: false };
    operation.promise = exchangeCopilotToken(undefined, { signal: operation.controller.signal }).finally(() => {
      operation.settled = true;
      if (refresh === operation) refresh = undefined;
    });
    refresh = operation;
  }
  const operation = refresh;
  operation.waiters += 1;
  try {
    return await waitForPromise(operation.promise, signal);
  } finally {
    operation.waiters -= 1;
    if (!operation.settled && operation.waiters === 0) operation.controller.abort();
  }
}

export function _resetCopilotTokenCacheForTests() {
  cachedCopilotToken = undefined;
  refresh?.controller.abort();
  refresh = undefined;
}
