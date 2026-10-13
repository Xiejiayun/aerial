import crypto from "node:crypto";
import { loadConfig } from "../shared/config.js";

export function upstreamHeaders(token, extra = {}) {
  const config = loadConfig();
  const requestId = extra["x-request-id"] || crypto.randomUUID();
  return {
    authorization: `Bearer ${token}`,
    accept: extra.accept || "application/json",
    "content-type": extra["content-type"] || "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-device-id": config.deviceId || "aerial-local",
    "editor-version": `vscode/${config.versions.vscode}`,
    "editor-plugin-version": `copilot-chat/${config.versions.copilotChat}`,
    "user-agent": `GitHubCopilotChat/${config.versions.copilotChat}`,
    "openai-intent": "conversation-agent",
    "x-github-api-version": "2026-01-09",
    "x-request-id": requestId,
    "x-agent-task-id": requestId,
    "x-interaction-type": "conversation-agent",
    "x-vscode-user-agent-library-version": "electron-fetch",
    ...extra
  };
}

export function copyResponseHeaders(upstream) {
  const headers = new Headers();
  const allowed = new Set([
    "content-type", "cache-control", "retry-after", "retry-after-ms", "x-should-retry",
    "request-id", "x-request-id", "x-github-request-id", "x-ms-request-id", "x-correlation-id",
    "ratelimit", "ratelimit-policy"
  ]);
  const hopByHop = new Set((upstream.headers.get("connection") || "").split(",").map(name => name.trim().toLowerCase()));
  for (const [name, value] of upstream.headers) {
    if (hopByHop.has(name)) continue;
    if (allowed.has(name) || /^(?:x-ratelimit-|ratelimit-|anthropic-ratelimit-)/.test(name)) headers.set(name, value);
  }
  // fetch may have decompressed the body. Content-Encoding/Length and other
  // transport headers must not describe the original wire representation.
  return headers;
}
