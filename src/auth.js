import fs from "node:fs";
import { COPILOT_TOKEN_URL, GITHUB_CLIENT_ID } from "./constants.js";
import { githubTokenPath, writePrivateFile } from "./paths.js";
import { logEvent } from "./log.js";

let cachedCopilotToken;
let refreshPromise;

function formBody(values) {
  return new URLSearchParams(values).toString();
}

export async function startDeviceFlow() {
  logEvent("login_start");
  const response = await fetch("https://github.com/login/device/code", {
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
    const response = await fetch("https://github.com/login/oauth/access_token", {
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
  if (process.env.AERIAL_GITHUB_TOKEN) return process.env.AERIAL_GITHUB_TOKEN;
  if (!fs.existsSync(githubTokenPath())) return undefined;
  return fs.readFileSync(githubTokenPath(), "utf8").trim();
}

function jwtExpirySeconds(token) {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp;
  } catch {
    return undefined;
  }
}

export async function exchangeCopilotToken(githubToken = readGitHubToken()) {
  if (!githubToken) throw new Error("Missing GitHub token. Run: aerial login");
  const response = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: "application/json",
      "user-agent": "Aerial/0.1"
    }
  });
  if (!response.ok) throw new Error(`Copilot token exchange failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const token = payload.token;
  if (!token) throw new Error("Copilot token exchange response did not include token");
  cachedCopilotToken = { token, expiresAt: (payload.expires_at ? Date.parse(payload.expires_at) / 1000 : jwtExpirySeconds(token)) || Math.floor(Date.now() / 1000) + 1200 };
  logEvent("token_refresh_success", { expiresAt: cachedCopilotToken.expiresAt });
  return cachedCopilotToken.token;
}

export async function getCopilotToken({ force = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && cachedCopilotToken && cachedCopilotToken.expiresAt - now > 120) return cachedCopilotToken.token;
  if (!refreshPromise) {
    refreshPromise = exchangeCopilotToken().finally(() => {
      refreshPromise = undefined;
    });
  }
  return refreshPromise;
}
