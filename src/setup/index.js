import fs from "node:fs";
import { loadConfig } from "../shared/config.js";
import { apiKeyPath, githubTokenPath } from "../shared/paths.js";
import { gitHubTokenSource } from "../shared/auth.js";
import { CLIENTS, setupCodex, setupClaude, codexStatus, claudeStatus } from "./clients.js";

export { setupCodex, setupClaude, codexStatus, claudeStatus } from "./clients.js";
export { findLatestBackup, restoreClient, restoreAllClients } from "./restore.js";

export function setupStatus() {
  const config = loadConfig();
  const apiKeyFile = apiKeyPath();
  const githubTokenFile = githubTokenPath();
  return {
    schema: "aerial.setup-status.v1",
    platform: process.platform,
    config: { host: config.host, port: config.port },
    auth: {
      api_key: { file: apiKeyFile, exists: fs.existsSync(apiKeyFile) },
      github_token: (() => {
        const source = gitHubTokenSource();
        return { file: githubTokenFile, exists: source !== "missing", source };
      })()
    },
    clients: Object.fromEntries(Object.entries(CLIENTS).map(([target, client]) => [target, client.status()]))
  };
}
