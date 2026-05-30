import fs from "node:fs";
import path from "node:path";

export function parseNumberChoice(value, { max, defaultIndex = 0, oneBased = false } = {}) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return defaultIndex;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (n < 1 || n > max) return undefined;
  return oneBased ? n : n - 1;
}

export async function readJsonSafely(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function ensureParentDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export function atomicWriteFile(file, content, { mode } = {}) {
  ensureParentDir(file);
  const tmp = `${file}.aerial-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const opts = mode !== undefined ? { mode } : undefined;
  try {
    fs.writeFileSync(tmp, content, opts);
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      if (process.platform === "win32" && fs.existsSync(file) && (err.code === "EEXIST" || err.code === "EPERM")) {
        fs.unlinkSync(file);
        fs.renameSync(tmp, file);
        return;
      }
      throw err;
    }
    if (process.platform !== "win32" && mode !== undefined) {
      try { fs.chmodSync(file, mode); } catch {}
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}
