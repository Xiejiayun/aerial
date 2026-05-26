import fs from "node:fs";
import path from "node:path";

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
      fs.chmodSync(file, mode);
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}
