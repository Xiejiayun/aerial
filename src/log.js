import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_ROTATE_KEEP = 3;
const MAX_LINE_BYTES = 64 * 1024;
const REDACT_KEYS = new Set([
  "authorization",
  "token",
  "apiKey",
  "api_key",
  "githubToken",
  "github_token",
  "body",
  "password",
  "secret"
]);

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

function redact(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function lineFor(event, fields) {
  const safe = redact(fields);
  const ts = new Date().toISOString();
  const obj = { ts, event, ...safe };
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
