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
  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) headers.set("cache-control", cacheControl);
  return headers;
}
