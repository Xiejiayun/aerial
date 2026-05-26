import fs from "node:fs";
import path from "node:path";

const BACKUP_PREFIX = ".aerial-backup-";
const ISO_STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function backupIfExists(file) {
  if (!fs.existsSync(file)) return undefined;
  const backup = `${file}.aerial-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(file, backup);
  return backup;
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

export function backupPathsFor(file) {
  return listBackups(file).map((entry) => entry.path);
}
