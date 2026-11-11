import { ensureApiKey, loadConfig } from "../../shared/config.js";
import { startServer } from "../../proxy/server.js";
import { argValue, parseConfigHost, parseConfigPort } from "../helpers.js";

export function runStartCli(args, { start = startServer, signals = process, exit = code => process.exit(code) } = {}) {
  const config = loadConfig();
  const host = parseConfigHost(argValue(args, "--host") || config.host);
  const port = parseConfigPort(argValue(args, "--port") || config.port);
  ensureApiKey();
  const server = start({ host, port });
  let stopping = false;
  const cleanup = () => {
    signals.removeListener("SIGINT", onInterrupt);
    signals.removeListener("SIGTERM", onTerminate);
  };
  const shutdown = code => {
    if (stopping) return;
    stopping = true;
    // The server releases its Cowork session and profile lock before its close
    // callback. Exiting earlier would leave recovery to a stale-lock cleanup.
    server.close(error => {
      cleanup();
      if (error) console.error(`Aerial shutdown failed: ${error.message}`);
      exit(error ? 1 : code);
    });
    // Signal-driven shutdown must not wait indefinitely for an unfinished
    // client request body or a GitHub stream after Cowork cleanup starts.
    server.closeAllConnections?.();
  };
  const onInterrupt = () => shutdown(130);
  const onTerminate = () => shutdown(143);
  signals.on("SIGINT", onInterrupt);
  signals.on("SIGTERM", onTerminate);
  server.once("close", cleanup);
  return server;
}
