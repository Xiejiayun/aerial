import fs from "node:fs";
import { logEvent } from "../shared/log.js";
import { atomicWriteFile } from "../shared/file-utils.js";
import { findLatestBackup } from "./backup.js";
import { CLIENTS } from "./clients.js";

const PRE_RESTORE_PREFIX = ".aerial-pre-restore-";

function clientDescriptor(target) {
  const descriptor = CLIENTS[target];
  if (!descriptor) throw new Error(`Unknown restore target: ${target}. Use codex, claude, or all.`);
  return descriptor;
}

function clientFile(target) {
  return clientDescriptor(target).file();
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
  clientDescriptor(target).validateBackup(content);
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
  const writeOpts = mode !== undefined ? { mode } : undefined;
  try {
    atomicWriteFile(writePath, backupContent, writeOpts);
  } catch (err) {
    if (err.code === "EXDEV") {
      throw new Error(`Restore failed: backup and target on different filesystems (EXDEV). File: ${writePath}. Move the backup next to the target and retry.`);
    }
    throw err;
  }
  logEvent("setup_restore", { target, file: writePath, from: latest.path, snapshot, mode });
  return { target, ok: true, restored: true, file: writePath, from: latest.path, snapshot, mode };
}

export function restoreAllClients(opts) {
  const results = {};
  for (const target of Object.keys(CLIENTS)) {
    try {
      results[target] = restoreClient(target, opts);
    } catch (err) {
      results[target] = { target, ok: false, error: err.message };
    }
  }
  const ok = Object.values(results).every((r) => r.ok);
  return { ok, results };
}
