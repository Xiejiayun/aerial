import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_ROTATE_KEEP = 3;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_REDACT_DEPTH = 8;

const state = {
  fd: undefined,
  bytes: 0,
  path: undefined,
  disabled: false,
  warned: false,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  rotateKeep: DEFAULT_ROTATE_KEEP
};

function envFilePath() {
  const file = process.env.AERIAL_LOG_FILE;
  if (!file || !file.trim()) return undefined;
  return file;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function maxFileBytes() {
  return envInt("AERIAL_LOG_MAX_BYTES", DEFAULT_MAX_FILE_BYTES);
}

function rotateKeep() {
  return envInt("AERIAL_LOG_BACKUPS", DEFAULT_ROTATE_KEEP);
}

function warnOnce(reason) {
  if (state.warned) return;
  state.warned = true;
  try {
    process.stderr.write(`aerial: file logging disabled (${state.path || "<unset>"}): ${reason}\n`);
  } catch {}
}

function disableWriter(reason) {
  state.disabled = true;
  if (state.fd !== undefined) {
    try { fs.closeSync(state.fd); } catch {}
    state.fd = undefined;
  }
  warnOnce(reason);
}

function openWriter() {
  const file = envFilePath();
  if (!file) return false;
  if (state.disabled) return false;
  if (state.fd !== undefined && state.path === file) return true;
  if (state.fd !== undefined && state.path !== file) {
    try { fs.closeSync(state.fd); } catch {}
    state.fd = undefined;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    state.path = file;
    disableWriter(`mkdir failed: ${err.message}`);
    return false;
  }
  let size = 0;
  try {
    if (fs.existsSync(file)) size = fs.statSync(file).size;
  } catch (err) {
    state.path = file;
    disableWriter(`stat failed: ${err.message}`);
    return false;
  }
  try {
    state.fd = process.platform === "win32"
      ? fs.openSync(file, "a")
      : fs.openSync(file, "a", 0o600);
  } catch (err) {
    state.path = file;
    disableWriter(`open failed: ${err.message}`);
    return false;
  }
  state.path = file;
  state.bytes = size;
  state.maxFileBytes = maxFileBytes();
  state.rotateKeep = rotateKeep();
  if (process.platform !== "win32") {
    try { fs.chmodSync(file, 0o600); } catch {}
  }
  return true;
}

function safeRename(src, dst) {
  if (process.platform === "win32") {
    try { fs.unlinkSync(dst); } catch {}
  }
  fs.renameSync(src, dst);
}

function rotate() {
  const file = state.path;
  if (!file) return;
  if (state.fd !== undefined) {
    try { fs.closeSync(state.fd); } catch {}
    state.fd = undefined;
  }
  const keep = state.rotateKeep;
  try {
    for (let i = keep - 1; i >= 1; i -= 1) {
      const src = `${file}.${i}`;
      const dst = `${file}.${i + 1}`;
      if (fs.existsSync(src)) safeRename(src, dst);
    }
    if (fs.existsSync(file)) safeRename(file, `${file}.1`);
  } catch (err) {
    disableWriter(`rotate failed: ${err.message}`);
    return;
  }
  openWriter();
}

function writeBuffer(buf) {
  if (!openWriter()) return;
  if (state.bytes + buf.length > state.maxFileBytes) {
    rotate();
    if (state.disabled) return;
  }
  try {
    fs.writeSync(state.fd, buf);
    state.bytes += buf.length;
  } catch (err) {
    disableWriter(`write failed: ${err.message}`);
  }
}

function sensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[_-]/g, "");
  return normalized === "authorization"
    || normalized === "token"
    || (normalized.endsWith("token") && !normalized.endsWith("tokens"))
    || normalized.includes("apikey")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized === "body"
    || normalized.endsWith("body");
}

function scrubString(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+/g, "[redacted]")
    .replace(/\bgh[opsru]_[A-Za-z0-9_]{20,}\b/g, "[redacted]")
    .replace(/\baerial_[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted]");
}

function scrub(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return "[redacted buffer]";
  if (depth >= MAX_REDACT_DEPTH) return "[redacted depth]";
  if (seen.has(value)) return "[redacted circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => scrub(item, seen, depth + 1));
    seen.delete(value);
    return out;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (sensitiveKey(k)) continue;
    out[k] = scrub(v, seen, depth + 1);
  }
  seen.delete(value);
  return out;
}

function lineFor(event, fields) {
  const safe = scrub(fields);
  const ts = new Date().toISOString();
  const obj = { ts, event: scrubString(event), ...safe };
  const line = JSON.stringify(obj);
  const buf = Buffer.from(`${line}\n`, "utf8");
  if (buf.length <= MAX_LINE_BYTES) return buf;
  const truncated = JSON.stringify({ ts, event, truncated: true, originalBytes: buf.length - 1 });
  return Buffer.from(`${truncated}\n`, "utf8");
}

export function logEvent(event, fields = {}) {
  const buf = lineFor(event, fields);
  if (envFilePath()) {
    writeBuffer(buf);
    return;
  }
  try {
    const text = buf.toString("utf8").replace(/\n$/, "");
    console.error(text);
  } catch {}
}

export function logPaths() {
  const file = envFilePath();
  return {
    file,
    enabled: Boolean(file),
    maxFileBytes: maxFileBytes(),
    maxLineBytes: MAX_LINE_BYTES,
    rotateKeep: rotateKeep()
  };
}

export function _resetForTests() {
  if (state.fd !== undefined) {
    try { fs.closeSync(state.fd); } catch {}
  }
  state.fd = undefined;
  state.bytes = 0;
  state.path = undefined;
  state.disabled = false;
  state.warned = false;
  state.maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  state.rotateKeep = DEFAULT_ROTATE_KEEP;
}
