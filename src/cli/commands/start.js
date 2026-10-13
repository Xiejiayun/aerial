import { ensureApiKey, loadConfig } from "../../shared/config.js";
import { startServer } from "../../proxy/server.js";
import { argValue, parseConfigHost, parseConfigPort } from "../helpers.js";

export function runStartCli(args) {
  const config = loadConfig();
  const host = parseConfigHost(argValue(args, "--host") || config.host);
  const port = parseConfigPort(argValue(args, "--port") || config.port);
  ensureApiKey();
  startServer({ host, port });
}
