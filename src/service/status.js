import fs from "node:fs";
import { apiKeyPath, githubTokenPath } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { defaultHealthFetch, classifyHealth } from "./health.js";
import { defaultRunCommand } from "./runner.js";
import { isUnsupportedPlatform, serviceState } from "./platform.js";
import {
  aerialLogPath,
  buildSchtasksArgs,
  darwinWrapperPath,
  logsDir,
  stdioLogPath,
  winWrapperPath,
  wrapperLogConfig
} from "./wrapper-render.js";

function unescapeShSingleQuoted(line, prefix) {
  if (!line.startsWith(prefix)) return undefined;
  const rest = line.slice(prefix.length);
  if (!rest.startsWith("'")) return undefined;
  let i = 1;
  let out = "";
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "'") {
      if (rest.slice(i, i + 4) === "'\\''") {
        out += "'";
        i += 4;
        continue;
      }
      return out;
    }
    out += ch;
    i += 1;
  }
  return undefined;
}

function unescapePsSingleQuoted(line, prefix) {
  if (!line.startsWith(prefix)) return undefined;
  const rest = line.slice(prefix.length);
  if (!rest.startsWith("'")) return undefined;
  let i = 1;
  let out = "";
  while (i < rest.length) {
    const ch = rest[i];
    if (ch === "'") {
      if (rest[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      return out;
    }
    out += ch;
    i += 1;
  }
  return undefined;
}

export function parseWrapperPaths(wrapperFile) {
  if (!wrapperFile) return { node: undefined, cli: undefined };
  try {
    if (!fs.existsSync(wrapperFile)) return { node: undefined, cli: undefined };
    const data = fs.readFileSync(wrapperFile, "utf8");
    const lines = data.split(/\r?\n/);
    if (wrapperFile.endsWith(".sh")) {
      let node;
      let cli;
      for (const line of lines) {
        if (node === undefined) {
          const candidate = unescapeShSingleQuoted(line, "NODE_BIN=");
          if (candidate !== undefined) node = candidate;
        }
        if (cli === undefined) {
          const candidate = unescapeShSingleQuoted(line, "CLI_ENTRY=");
          if (candidate !== undefined) cli = candidate;
        }
        if (node !== undefined && cli !== undefined) break;
      }
      return { node, cli };
    }
    if (wrapperFile.endsWith(".ps1")) {
      let node;
      let cli;
      for (const line of lines) {
        if (node === undefined) {
          const m = line.match(/^\$node\s*=\s*(.*)$/);
          if (m) {
            const candidate = unescapePsSingleQuoted(m[1].trim(), "");
            if (candidate !== undefined) node = candidate;
          }
        }
        if (cli === undefined) {
          const m = line.match(/^\$cli\s*=\s*(.*)$/);
          if (m) {
            const candidate = unescapePsSingleQuoted(m[1].trim(), "");
            if (candidate !== undefined) cli = candidate;
          }
        }
        if (node !== undefined && cli !== undefined) break;
      }
      return { node, cli };
    }
  } catch {}
  return { node: undefined, cli: undefined };
}

export function readWrapperNodePath(wrapperFile) {
  return parseWrapperPaths(wrapperFile).node;
}

export const STALE_REASONS = Object.freeze({
  WRAPPER_MISSING: "wrapper_missing",
  WRAPPER_NODE_MISSING: "wrapper_node_missing",
  WRAPPER_CLI_MISSING: "wrapper_cli_missing",
  WRAPPER_LOG_CONFIG_UNPARSEABLE: "wrapper_log_config_unparseable"
});

export function wrapperBlock(state) {
  if (!state || state.installed !== true) {
    return { stale: false, staleReasons: [] };
  }
  let wrapperPath;
  if (process.platform === "darwin") wrapperPath = darwinWrapperPath();
  else if (process.platform === "win32") wrapperPath = winWrapperPath();
  const wrapperFileExists = wrapperPath ? fs.existsSync(wrapperPath) : false;
  const staleReasons = [];
  if (!wrapperFileExists) {
    return {
      path: wrapperPath,
      nodePath: undefined,
      nodeExists: undefined,
      cliPath: undefined,
      cliExists: undefined,
      logConfigParseable: undefined,
      stale: true,
      staleReasons: [STALE_REASONS.WRAPPER_MISSING]
    };
  }
  const { node: nodePath, cli: cliPath } = parseWrapperPaths(wrapperPath);
  const nodeExists = nodePath ? fs.existsSync(nodePath) : false;
  const cliExists = cliPath ? fs.existsSync(cliPath) : false;
  const logConfigParseable = parseWrapperLogValues(wrapperPath) !== null;
  if (!nodeExists) staleReasons.push(STALE_REASONS.WRAPPER_NODE_MISSING);
  if (!cliExists) staleReasons.push(STALE_REASONS.WRAPPER_CLI_MISSING);
  if (!logConfigParseable) staleReasons.push(STALE_REASONS.WRAPPER_LOG_CONFIG_UNPARSEABLE);
  return {
    path: wrapperPath,
    nodePath,
    nodeExists,
    cliPath,
    cliExists,
    logConfigParseable,
    stale: staleReasons.length > 0,
    staleReasons
  };
}

function authFileStatus(file) {
  if (!fs.existsSync(file)) return { file, state: "missing" };
  try {
    const data = fs.readFileSync(file, "utf8");
    if (!data || !data.trim()) return { file, state: "invalid", reason: "empty" };
    return { file, state: "present" };
  } catch (err) {
    return { file, state: "invalid", reason: err.message };
  }
}

export function authBlock() {
  return {
    api_key: authFileStatus(apiKeyPath()),
    github_token: authFileStatus(githubTokenPath())
  };
}

function statFile(file) {
  if (!file) return { exists: false };
  try {
    if (!fs.existsSync(file)) return { exists: false };
    return { exists: true, size: fs.statSync(file).size };
  } catch {
    return { exists: false };
  }
}

export function logsBlock() {
  const dir = logsDir();
  const primary = aerialLogPath();
  const stdio = stdioLogPath();
  let wrapperFile;
  if (process.platform === "darwin") wrapperFile = darwinWrapperPath();
  else if (process.platform === "win32") wrapperFile = winWrapperPath();
  const parsed = wrapperFile ? parseWrapperLogValues(wrapperFile) : null;
  let maxBytes;
  let rotateKeep;
  let source;
  if (parsed) {
    maxBytes = parsed.maxBytes;
    rotateKeep = parsed.backups;
    source = "installed-wrapper";
  } else {
    const cfg = wrapperLogConfig();
    maxBytes = cfg.maxBytes;
    rotateKeep = cfg.backups;
    source = "next-install-default";
  }
  return {
    dir,
    primary: { file: primary, ...statFile(primary) },
    stdio: { file: stdio, ...statFile(stdio) },
    maxFileBytes: maxBytes,
    rotateKeep,
    source
  };
}

export function parseWrapperLogValues(file) {
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const data = fs.readFileSync(file, "utf8");
    let maxBytes;
    let backups;
    if (file.endsWith(".sh")) {
      const m = data.match(/^MAX_BYTES=(\d+)\s*$/m);
      const b = data.match(/^BACKUPS=(\d+)\s*$/m);
      if (m) maxBytes = Number(m[1]);
      if (b) backups = Number(b[1]);
    } else if (file.endsWith(".ps1")) {
      const m = data.match(/^\$maxBytes\s*=\s*(\d+)\s*$/m);
      const b = data.match(/^\$backups\s*=\s*(\d+)\s*$/m);
      if (m) maxBytes = Number(m[1]);
      if (b) backups = Number(b[1]);
    }
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) return null;
    if (!Number.isInteger(backups) || backups < 1) return null;
    return { maxBytes, backups };
  } catch {
    return null;
  }
}

export async function serviceStatus({ run = defaultRunCommand, healthFetch } = {}) {
  const config = loadConfig();
  const ctx = { run };
  if (isUnsupportedPlatform()) {
    return {
      schema: "aerial.service-status.v1",
      platform: process.platform,
      supported: false,
      config: { host: config.host, port: config.port },
      service: { installed: false, loaded: false, reason: "unsupported_platform", platform: process.platform, wrapper: wrapperBlock({ installed: false }) },
      health: { ok: false, error: "unsupported_platform" },
      logs: logsBlock(),
      auth: authBlock(),
      summary: "unsupported"
    };
  }
  const state = serviceState(ctx);
  const probe = await (healthFetch || defaultHealthFetch)(config.host, config.port);
  const cls = classifyHealth(probe);
  const wrapper = wrapperBlock(state);
  let supervisor;
  if (cls.mode === "aerial_running") {
    supervisor = state.installed && state.loaded ? "service-managed" : "foreground";
  }
  const health = { ...probe };
  if (cls.mode === "port_conflict") {
    health.portConflict = true;
    health.conflictReason = cls.reason;
  }
  if (cls.mode === "aerial_running") {
    health.aerial = true;
    health.supervisor = supervisor;
  }
  let summary;
  if (cls.mode === "aerial_running" && supervisor === "service-managed") summary = "running (service-managed)";
  else if (cls.mode === "aerial_running" && supervisor === "foreground") summary = "running (foreground)";
  else if (cls.mode === "port_conflict") summary = "port conflict (non-Aerial process on port)";
  else if (state.installed && state.loaded) summary = "manager reports up but health failed";
  else if (state.installed) summary = "installed (not running)";
  else summary = "not installed";
  return {
    schema: "aerial.service-status.v1",
    platform: process.platform,
    supported: true,
    config: { host: config.host, port: config.port },
    service: { platform: process.platform, ...state, wrapper },
    health,
    logs: logsBlock(),
    auth: authBlock(),
    summary
  };
}
