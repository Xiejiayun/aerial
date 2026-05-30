import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { atomicWriteFile } from "./utils.js";

export function configDir() {
  if (process.env.AERIAL_CONFIG_DIR) return process.env.AERIAL_CONFIG_DIR;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "aerial");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "aerial");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "aerial");
}

export function configPath() {
  return path.join(configDir(), "config.json");
}

export function githubTokenPath() {
  return path.join(configDir(), "github_token");
}

export function apiKeyPath() {
  return path.join(configDir(), "api_key");
}

export function ensureDir(dir = configDir()) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writePrivateFile(file, content) {
  atomicWriteFile(file, content, { mode: 0o600 });
}

export function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJsonPrivate(file, value) {
  writePrivateFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
