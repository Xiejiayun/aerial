import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const repoRoot = path.resolve(import.meta.dirname, "..");
export const cliPath = path.join(repoRoot, "src", "cli", "index.js");

export function mkHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aerial-${label}-`));
}

export function cliEnv(home, extraEnv = {}) {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AERIAL_CONFIG_DIR: path.join(home, "config"),
    AERIAL_API_KEY: "",
    AERIAL_SKIP_ENV_PERSIST: "1",
    ...extraEnv
  };
}

export function runCli(args, { home = mkHome("cli"), env, extraEnv = {}, cwd = repoRoot } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env: env || cliEnv(home, extraEnv)
  });
}

export function configEnv(label, extraEnv = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `aerial-${label}-`));
  return {
    configDir,
    env: {
      ...process.env,
      AERIAL_CONFIG_DIR: configDir,
      AERIAL_API_KEY: "aerial_test_key",
      ...extraEnv
    }
  };
}

export function jsonRequest(url, payload, { headers = {}, method = "POST" } = {}) {
  return new Request(url, {
    method,
    headers: { authorization: "Bearer aerial_test_key", "content-type": "application/json", ...headers },
    body: JSON.stringify(payload)
  });
}

export function messagesRequest(payload, options) {
  return jsonRequest("http://127.0.0.1/v1/messages", payload, options);
}

export function responsesRequest(payload, options) {
  return jsonRequest("http://127.0.0.1/v1/responses", payload, options);
}

export function chatRequest(payload, options) {
  return jsonRequest("http://127.0.0.1/v1/chat/completions", payload, options);
}

export function parseForwardedJson(init) {
  return JSON.parse(Buffer.from(init.body).toString("utf8"));
}
