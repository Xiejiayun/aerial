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
  const opts = { flag: "wx", ...(mode !== undefined ? { mode } : {}) };
  try {
    fs.writeFileSync(tmp, content, opts);
    // Never remove the live file as a fallback: a second failed rename would
    // otherwise leave the user with no configuration at all.
    fs.renameSync(tmp, file);
    if (process.platform !== "win32" && mode !== undefined) {
      try { fs.chmodSync(file, mode); } catch {}
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}
