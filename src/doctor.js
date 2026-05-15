import fs from "node:fs";
import { configPath, githubTokenPath } from "./paths.js";
import { loadConfig } from "./config.js";

export function doctor() {
  const config = loadConfig();
  const checks = [
    { name: "config", ok: fs.existsSync(configPath()), detail: configPath() },
    { name: "api_key", ok: Boolean(config.apiKeyHash), detail: config.apiKeyHash ? "configured" : "run: aerial key generate" },
    { name: "github_token", ok: fs.existsSync(githubTokenPath()) || Boolean(process.env.AERIAL_GITHUB_TOKEN), detail: fs.existsSync(githubTokenPath()) ? githubTokenPath() : "run: aerial login" },
    { name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version },
    { name: "bind", ok: config.host === "127.0.0.1", detail: `${config.host}:${config.port}` }
  ];
  return { ok: checks.every((check) => check.ok), checks };
}
