import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");

export function codexAuthCommand() {
  return {
    command: process.execPath,
    args: [CLI_ENTRY, "key", "print"],
    timeout_ms: 5000,
    refresh_interval_ms: 0
  };
}

function quoteCommandPart(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

export function claudeApiKeyHelper() {
  return [process.execPath, CLI_ENTRY, "key", "print"].map(quoteCommandPart).join(" ");
}
