import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ensureApiKey, loadConfig, saveConfig } from "./config.js";
import { apiKeyPath, githubTokenPath } from "./paths.js";
import { gitHubTokenSource } from "./auth.js";
import { logEvent } from "./log.js";
import { assertValidEffort, normalizeEffort } from "./setup-selection.js";

const BACKUP_PREFIX = ".aerial-backup-";
const PRE_RESTORE_PREFIX = ".aerial-pre-restore-";
const ISO_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const DEFAULT_CODEX_AUTH = Object.freeze({
  command: "aerial",
  args: ["key", "print"],
  timeout_ms: 5000,
  refresh_interval_ms: 0
});
const DEFAULT_CLAUDE_API_KEY_HELPER = "aerial key print";

function backupIfExists(file) {
  if (!fs.existsSync(file)) return undefined;
  const backup = `${file}.aerial-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, backup);
  return backup;
}

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function tomlValue(value) {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

function setTomlString(content, key, value) {
  const line = `${key} = ${tomlValue(value)}`;
  const re = new RegExp(`^${key}\\s*=.*$`, "m");
  return re.test(content) ? content.replace(re, line) : `${content.trimEnd()}\n${line}\n`;
}

function upsertTomlSection(content, section, values) {
  const heading = `[${section}]`;
  const lines = Object.entries(values).map(([key, value]) => `${key} = ${tomlValue(value)}`).join("\n");
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

export function setupCodex({ model, effort, authCommand = DEFAULT_CODEX_AUTH } = {}) {
  const normalizedEffort = effort === undefined ? undefined : assertValidEffort(effort);
  ensureApiKey();
  const config = loadConfig();
  const selectedModel = model || config.defaultModel;
  if (!selectedModel) {
    throw new Error("setupCodex requires a model id; pass --model or let `aerial setup codex` select one from live Copilot models.");
  }
  const file = path.join(os.homedir(), ".codex", "config.toml");
  ensureParent(file);
  const backup = backupIfExists(file);
  let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  content = setTomlString(content, "model_provider", "aerial");
  content = setTomlString(content, "model", selectedModel);
  content = upsertTomlSection(content, "model_providers.aerial", {
    name: "Aerial",
    base_url: `http://${config.host}:${config.port}/v1`,
    wire_api: "responses"
  });
  content = upsertTomlSection(content, "model_providers.aerial.auth", {
    command: authCommand.command,
    args: authCommand.args || [],
    timeout_ms: authCommand.timeout_ms || DEFAULT_CODEX_AUTH.timeout_ms,
    refresh_interval_ms: authCommand.refresh_interval_ms ?? DEFAULT_CODEX_AUTH.refresh_interval_ms
  });
  const profileValues = { model_provider: "aerial", model: selectedModel };
  if (normalizedEffort) profileValues.model_reasoning_effort = normalizedEffort;
  content = upsertTomlSection(content, "profiles.aerial", profileValues);
  fs.writeFileSync(file, content, "utf8");
  if (normalizedEffort && config.defaultEffort !== normalizedEffort) {
    saveConfig({ ...config, defaultEffort: normalizedEffort });
  }
  logEvent("setup_write", { target: "codex", file, backup, auth: "command", effort: normalizedEffort });
  return { file, backup, model: selectedModel, effort: normalizedEffort, auth: { type: "command", command: authCommand.command, args: authCommand.args || [] } };
}

export function setupClaude({ model, effort, apiKeyHelper = DEFAULT_CLAUDE_API_KEY_HELPER } = {}) {
  const normalizedEffort = effort === undefined ? undefined : assertValidEffort(effort);
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
    apiKeyHelper,
    env: claudeEnvForAerial(current.env, config)
  };
  if (selectedModel) next.model = selectedModel;
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  if (normalizedEffort && config.defaultEffort !== normalizedEffort) {
    saveConfig({ ...config, defaultEffort: normalizedEffort });
  }
  logEvent("setup_write", { target: "claude", file, backup, model: selectedModel, effort: normalizedEffort });
  return { file, backup, model: selectedModel, effort: normalizedEffort, apiKeyHelper };
}

function codexConfigFile() {
  return path.join(os.homedir(), ".codex", "config.toml");
}

function claudeSettingsFile() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function listBackups(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  if (!fs.existsSync(dir)) return [];
  const prefix = `${base}${BACKUP_PREFIX}`;
  const entries = fs.readdirSync(dir);
  const matches = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const stamp = entry.slice(prefix.length);
    if (!ISO_STAMP_RE.test(stamp)) continue;
    matches.push({ name: entry, path: path.join(dir, entry), stamp });
  }
  matches.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
  return matches;
}

export function findLatestBackup(file) {
  const all = listBackups(file);
  return all.length ? all[all.length - 1] : undefined;
}

function backupPathsFor(file) {
  return listBackups(file).map((entry) => entry.path);
}

function codexStateFromDoc(doc, expectedBaseUrl) {
  const providerSection = doc && typeof doc === "object" ? doc.model_providers?.aerial : undefined;
  const providerSet = doc?.model_provider === "aerial";
  const authArgs = Array.isArray(providerSection?.auth?.args) ? providerSection.auth.args : [];
  const authLooksAerial = typeof providerSection?.auth?.command === "string"
    && providerSection.auth.command.trim()
    && authArgs.slice(-2).join(" ") === "key print";
  const providerShapeComplete = providerSection
    && providerSection.wire_api === "responses"
    && (authLooksAerial || providerSection.env_key === "AERIAL_API_KEY")
    && typeof providerSection.base_url === "string";
  const providerBaseMatches = providerSection?.base_url === expectedBaseUrl;
  if (!providerSection && !providerSet) return "not-aerial";
  if (providerSet && providerShapeComplete && providerBaseMatches) return "aerial";
  if (providerShapeComplete) return "aerial-stale";
  return "aerial-drift";
}

export function codexStatus() {
  const config = loadConfig();
  const expectedBaseUrl = `http://${config.host}:${config.port}/v1`;
  const file = codexConfigFile();
  const backups = backupPathsFor(file);
  if (!fs.existsSync(file)) return { target: "codex", state: "missing", file, backups, effort: "missing" };
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { target: "codex", state: "invalid", file, backups, error: err.message, effort: "missing" };
  }
  let doc;
  try {
    doc = parseToml(content);
  } catch (err) {
    return { target: "codex", state: "invalid", file, backups, error: err.message, effort: "missing" };
  }
  const state = codexStateFromDoc(doc, expectedBaseUrl);
  const model = typeof doc?.model === "string" ? doc.model : undefined;
  const baseUrl = typeof doc?.model_providers?.aerial?.base_url === "string"
    ? doc.model_providers.aerial.base_url
    : undefined;
  const profileEffort = doc?.profiles?.aerial?.model_reasoning_effort;
  const effort = typeof profileEffort === "string" ? (normalizeEffort(profileEffort) || "missing") : "missing";
  return { target: "codex", state, file, backups, model, baseUrl, effort };
}

function claudeStateFromDoc(doc, expectedBaseUrl) {
  const helperIsAerial = typeof doc?.apiKeyHelper === "string" && /\bkey\s+print\b/.test(doc.apiKeyHelper);
  const baseUrl = doc?.env?.ANTHROPIC_BASE_URL;
  const baseUrlMatches = baseUrl === expectedBaseUrl;
  const baseUrlAerialShape = typeof baseUrl === "string" && /^http:\/\/127\.0\.0\.1:\d+/.test(baseUrl);
  const hasAerialTrace = helperIsAerial || baseUrlAerialShape;
  if (!hasAerialTrace) return "not-aerial";
  if (helperIsAerial && baseUrlMatches) return "aerial";
  if (helperIsAerial && typeof baseUrl === "string" && !baseUrlMatches) return "aerial-stale";
  return "aerial-drift";
}

export function claudeStatus() {
  const config = loadConfig();
  const expectedBaseUrl = `http://${config.host}:${config.port}`;
  const file = claudeSettingsFile();
  const backups = backupPathsFor(file);
  const effort = typeof config.defaultEffort === "string" && config.defaultEffort.trim() ? config.defaultEffort.trim() : "missing";
  if (!fs.existsSync(file)) return { target: "claude", state: "missing", file, backups, effort };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { target: "claude", state: "invalid", file, backups, error: err.message, effort };
  }
  const state = claudeStateFromDoc(doc, expectedBaseUrl);
  const model = typeof doc?.model === "string" ? doc.model : undefined;
  const baseUrl = doc?.env?.ANTHROPIC_BASE_URL;
  return { target: "claude", state, file, backups, model, baseUrl, effort };
}

export function setupStatus() {
  const config = loadConfig();
  const apiKeyFile = apiKeyPath();
  const githubTokenFile = githubTokenPath();
  return {
    schema: "aerial.setup-status.v1",
    platform: process.platform,
    config: { host: config.host, port: config.port },
    auth: {
      api_key: { file: apiKeyFile, exists: fs.existsSync(apiKeyFile) },
      github_token: (() => {
        const source = gitHubTokenSource();
        return { file: githubTokenFile, exists: source !== "missing", source };
      })()
    },
    clients: {
      codex: codexStatus(),
      claude: claudeStatus()
    }
  };
}

function clientFile(target) {
  if (target === "codex") return codexConfigFile();
  if (target === "claude") return claudeSettingsFile();
  throw new Error(`Unknown restore target: ${target}. Use codex, claude, or all.`);
}

function resolveWritePath(file) {
  if (!fs.existsSync(file)) return file;
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

function validateBackupContent(target, content) {
  const text = content.toString("utf8");
  if (target === "codex") {
    try {
      parseToml(text);
    } catch (err) {
      throw new Error(`Restore aborted: backup is not valid TOML (${err.message}). Live file left unchanged.`);
    }
  } else if (target === "claude") {
    try {
      JSON.parse(text);
    } catch (err) {
      throw new Error(`Restore aborted: backup is not valid JSON (${err.message}). Live file left unchanged.`);
    }
  }
}

function resolveRestoreMode(writePath, backupPath, targetExisted) {
  if (process.platform === "win32") return undefined;
  let preserved;
  if (targetExisted) {
    try { preserved = fs.statSync(writePath).mode & 0o777; } catch { preserved = undefined; }
  }
  if (preserved === undefined) {
    try { preserved = fs.statSync(backupPath).mode & 0o777; } catch { preserved = 0o600; }
  }
  return preserved & 0o600;
}

export function restoreClient(target, { now = () => new Date() } = {}) {
  const file = clientFile(target);
  const writePath = resolveWritePath(file);
  const latest = findLatestBackup(file);
  if (!latest) {
    return { target, ok: true, restored: false, reason: "no_backup", file };
  }
  let backupContent;
  try {
    backupContent = fs.readFileSync(latest.path);
  } catch (err) {
    throw new Error(`Restore failed: cannot read backup ${latest.path}: ${err.message}`);
  }
  validateBackupContent(target, backupContent);
  const targetExisted = fs.existsSync(writePath);
  const mode = resolveRestoreMode(writePath, latest.path, targetExisted);
  let snapshot;
  if (targetExisted) {
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    snapshot = `${writePath}${PRE_RESTORE_PREFIX}${stamp}`;
    fs.copyFileSync(writePath, snapshot);
  }
  ensureParent(writePath);
  const tmp = `${writePath}.aerial-restore-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const writeOpts = mode !== undefined ? { mode } : undefined;
  fs.writeFileSync(tmp, backupContent, writeOpts);
  try {
    fs.renameSync(tmp, writePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    if (err.code === "EXDEV") {
      throw new Error(`Restore failed: backup and target on different filesystems (EXDEV). File: ${writePath}. Move the backup next to the target and retry.`);
    }
    throw err;
  }
  if (mode !== undefined) {
    try { fs.chmodSync(writePath, mode); } catch {}
  }
  logEvent("setup_restore", { target, file: writePath, from: latest.path, snapshot, mode });
  return { target, ok: true, restored: true, file: writePath, from: latest.path, snapshot, mode };
}

export function restoreAllClients(opts) {
  const results = {};
  for (const target of ["codex", "claude"]) {
    try {
      results[target] = restoreClient(target, opts);
    } catch (err) {
      results[target] = { target, ok: false, error: err.message };
    }
  }
  const ok = Object.values(results).every((r) => r.ok);
  return { ok, results };
}

