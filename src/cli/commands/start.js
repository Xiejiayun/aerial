import { ensureApiKey, loadConfig } from "../../shared/config.js";
import { startServer } from "../../proxy/server.js";
import { argValue } from "../helpers.js";

export function runStartCli(args) {
  const config = loadConfig();
  const host = argValue(args, "--host") || config.host;
  const port = Number(argValue(args, "--port") || config.port);
  ensureApiKey();
  startServer({ host, port });
}
