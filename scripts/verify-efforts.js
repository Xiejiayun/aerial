#!/usr/bin/env node
import { getCopilotToken } from "../src/shared/auth.js";
import { COPILOT_API_ORIGIN, DEFAULT_ANTHROPIC_VERSION, DEFAULT_VERSIONS } from "../src/shared/constants.js";

const GPT_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_GPT_MODELS = ["gpt-5.2", "gpt-5-mini", "gpt-5.4-mini", "gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.2-codex", "gpt-5.3-codex"];
const DEFAULT_CLAUDE_MODELS = ["claude-opus-4.7", "claude-opus-4.7-high", "claude-opus-4.7-xhigh", "claude-opus-4.7-1m-internal"];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function csvArg(name) {
  const value = argValue(name);
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
}

function outputFormat() {
  return process.argv.includes("--table") ? "table" : "json";
}

function upstreamHeaders(token, extra = {}) {
  const requestId = crypto.randomUUID();
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "content-type": "application/json",
    "copilot-integration-id": "vscode-chat",
    "editor-device-id": "aerial-effort-verify",
    "editor-version": `vscode/${DEFAULT_VERSIONS.vscode}`,
    "editor-plugin-version": `copilot-chat/${DEFAULT_VERSIONS.copilotChat}`,
    "user-agent": `GitHubCopilotChat/${DEFAULT_VERSIONS.copilotChat}`,
    "openai-intent": "conversation-agent",
    "x-github-api-version": "2026-01-09",
    "x-request-id": requestId,
    "x-agent-task-id": requestId,
    "x-interaction-type": "conversation-agent",
    "x-vscode-user-agent-library-version": "electron-fetch",
    ...extra
  };
}

async function requestJson(path, token, body, extraHeaders = {}) {
  const response = await fetch(`${COPILOT_API_ORIGIN}${path}`, {
    method: "POST",
    headers: upstreamHeaders(token, extraHeaders),
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  return {
    status: response.status,
    ok: response.ok,
    usage: payload?.usage,
    error: payload?.error?.message || payload?.message || (!response.ok ? text.slice(0, 500) : undefined)
  };
}

async function testGpt(token, model, effort) {
  const result = await requestJson("/responses", token, {
    model,
    input: "Reply with exactly: ok",
    max_output_tokens: 16,
    reasoning: { effort }
  });
  return { family: "gpt", model, effort, ...result };
}

async function testClaude(token, model, effort) {
  const result = await requestJson("/v1/messages", token, {
    model,
    max_tokens: 1,
    output_config: { effort },
    system: [{ type: "text", text: "Answer with one word." }],
    messages: [{ role: "user", content: "ok?" }]
  }, { "anthropic-version": DEFAULT_ANTHROPIC_VERSION });
  return { family: "claude", model, effort, ...result };
}

function printTable(rows, efforts) {
  const byModel = new Map();
  for (const row of rows) {
    if (!byModel.has(row.model)) byModel.set(row.model, {});
    byModel.get(row.model)[row.effort] = row.ok ? "OK" : `${row.status}`;
  }
  const header = ["model", ...efforts];
  const table = [header, ...[...byModel.entries()].map(([model, results]) => [model, ...efforts.map((effort) => results[effort] || "-")])];
  const widths = header.map((_, col) => Math.max(...table.map((row) => String(row[col]).length)));
  for (const row of table) {
    console.log(row.map((cell, col) => String(cell).padEnd(widths[col])).join("  "));
  }
}

async function main() {
  const family = argValue("--family") || "gpt";
  const models = csvArg("--models") || (family === "claude" ? DEFAULT_CLAUDE_MODELS : DEFAULT_GPT_MODELS);
  const efforts = csvArg("--efforts") || (family === "claude" ? CLAUDE_EFFORTS : GPT_EFFORTS);
  const token = await getCopilotToken();
  const rows = [];
  for (const model of models) {
    for (const effort of efforts) {
      rows.push(family === "claude" ? await testClaude(token, model, effort) : await testGpt(token, model, effort));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (outputFormat() === "table") printTable(rows, efforts);
  else console.log(JSON.stringify(rows, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
