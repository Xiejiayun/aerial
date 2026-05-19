import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureApiKey, loadConfig } from "./config.js";
import { logEvent } from "./log.js";

const AERIAL_ENV_KEY = "AERIAL_API_KEY";

function backupIfExists(file) {
  if (!fs.existsSync(file)) return undefined;
  const backup = `${file}.aerial-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, backup);
  return backup;
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function setTomlString(content, key, value) {
  const line = `${key} = "${value}"`;
  const re = new RegExp(`^${key}\\s*=.*$`, "m");
  return re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
}

function upsertTomlSection(content, section, values) {
  const heading = `[${section}]`;
  const lines = Object.entries(values).map(([key, value]) => `${key} = "${value}"`).join("\n");
  const block = `${heading}\n${lines}\n`;
  const source = content.split(/\r?\n/);
  const start = source.findIndex((line) => line.trim() === heading);
  if (start === -1) return `${content.trimEnd()}\n\n${block}`;
  let end = source.length;
  for (let i = start + 1; i < source.length; i += 1) {
    if (/^\s*\[.*\]\s*$/.test(source[i])) {
      end = i;
      break;
    }
  }
  source.splice(start, end - start, ...block.trimEnd().split("\n"));
  return `${source.join("\n").trimEnd()}\n`;
}

function persistUserEnv(name, value) {
  process.env[name] = value;
  if (process.env.AERIAL_SKIP_ENV_PERSIST === "1") return { persisted: false, reason: "skipped" };
  if (process.platform === "win32") {
    const escaped = String(value).replace(/'/g, "''");
    const command = `[Environment]::SetEnvironmentVariable('${name}', '${escaped}', 'User')`;
    const { status, error } = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "ignore" });
    if (status === 0) return { persisted: true, target: "user" };
    return { persisted: false, reason: error?.message || `powershell exited ${status}` };
  }
  return { persisted: false, reason: "unsupported_platform" };
}

function ensureClientApiKeyEnv() {
  const result = ensureApiKey();
  if (!result.apiKey) return { ...result, env: { name: AERIAL_ENV_KEY, persisted: false, reason: "raw_key_unavailable" } };
  return { ...result, env: { name: AERIAL_ENV_KEY, ...persistUserEnv(AERIAL_ENV_KEY, result.apiKey) } };
}

function claudeEnvForAerial(currentEnv, config) {
  const {
    ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL,
    ...rest
  } = currentEnv || {};
  return {
    ...rest,
    ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
  };
}

export function setupCodex({ model } = {}) {
  const apiKey = ensureClientApiKeyEnv();
  const config = loadConfig();
  const selectedModel = model || config.defaultModel || "gpt-4.1";
  const file = path.join(os.homedir(), ".codex", "config.toml");
  ensureParent(file);
  const backup = backupIfExists(file);
  let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  content = setTomlString(content, "model_provider", "aerial");
  content = setTomlString(content, "model", selectedModel);
  content = upsertTomlSection(content, "model_providers.aerial", {
    name: "Aerial Copilot Local",
    base_url: `http://${config.host}:${config.port}/v1`,
    wire_api: "responses",
    env_key: AERIAL_ENV_KEY
  });
  content = upsertTomlSection(content, "profiles.aerial", { model_provider: "aerial", model: selectedModel });
  fs.writeFileSync(file, content, "utf8");
  logEvent("setup_write", { target: "codex", file, backup, env: apiKey.env });
  return { file, backup, model: selectedModel, env: apiKey.env };
}

export function setupClaude({ model } = {}) {
  ensureApiKey();
  const config = loadConfig();
  const selectedModel = model || config.defaultModel;
  const dir = path.join(os.homedir(), ".claude");
  const file = path.join(dir, "settings.json");
  ensureParent(file);
  const backup = backupIfExists(file);
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const next = {
    ...current,
    apiKeyHelper: "aerial key print",
    env: claudeEnvForAerial(current.env, config)
  };
  if (selectedModel) next.model = selectedModel;
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  logEvent("setup_write", { target: "claude", file, backup, model: selectedModel });
  return { file, backup, model: selectedModel };
}

