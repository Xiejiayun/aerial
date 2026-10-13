import { fileURLToPath } from "node:url";
import { configDir } from "../shared/paths.js";

const CLI_ENTRY = fileURLToPath(new URL("../cli/index.js", import.meta.url));

export function codexAuthCommand() {
  return {
    command: process.execPath,
    args: [CLI_ENTRY, "--config-dir", configDir(), "key", "print"],
    timeout_ms: 5000,
    refresh_interval_ms: 0
  };
}

function quoteCommandPart(value) {
  const text = String(value);
  // POSIX shells expand dollar signs and backticks even inside double quotes.
  return `"${process.platform === "win32" ? text.replace(/"/g, '\\"') : text.replace(/[\\"$\x60]/g, "\\$&")}"`;
}

export function claudeApiKeyHelper() {
  const { command, args } = codexAuthCommand();
  return [command, ...args].map(quoteCommandPart).join(" ");
}

export const isAerialKeyHelper = value => typeof value === "string" && /\bkey["']?\s+["']?print\b/.test(value);
