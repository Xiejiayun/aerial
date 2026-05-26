import { defaultConfig, loadConfig, saveConfig } from "../shared/config.js";
import { configPath } from "../shared/paths.js";
import { assertValidEffort } from "../shared/effort.js";
import { parseConfigHost, parseConfigPort } from "./args.js";

export function runConfigCli(subcommand, rest) {
  if (subcommand === "reset") {
    saveConfig(defaultConfig());
    console.log(`Reset Aerial config: ${configPath()}`);
    return;
  }
  const config = loadConfig();
  if (subcommand === "set") {
    const [key, value] = rest;
    if (!key || value === undefined) throw new Error("Usage: aerial config set <key> <value>");
    if (!["host", "port", "defaultModel", "defaultEffort", "logLevel", "promptCacheRetention", "promptCacheKey"].includes(key)) throw new Error(`Unsupported config key: ${key}`);
    if (key === "promptCacheRetention" && !["in_memory", "24h", "off"].includes(value)) throw new Error("promptCacheRetention must be one of: in_memory, 24h, off");
    if (key === "promptCacheKey" && !value.trim()) throw new Error("promptCacheKey must be auto, off, or a non-empty string");
    if (key === "host") {
      config.host = parseConfigHost(value);
      saveConfig(config);
      return;
    }
    if (key === "port") {
      config.port = parseConfigPort(value);
      saveConfig(config);
      return;
    }
    if (key === "defaultEffort") {
      config.defaultEffort = assertValidEffort(value);
      saveConfig(config);
      return;
    }
    config[key] = value;
    saveConfig(config);
    return;
  }
  console.log(JSON.stringify(config, null, 2));
}
