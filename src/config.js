import fs from "node:fs";
import { CONFIG_VERSION, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_VERSIONS } from "./constants.js";
import { configPath, readJsonIfExists, writeJsonPrivate } from "./paths.js";
import { hashApiKey, randomApiKey, verifyApiKey } from "./crypto.js";

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    apiKeyHash: undefined,
    defaultModel: undefined,
    logLevel: "info",
    versions: DEFAULT_VERSIONS
  };
}

export function loadConfig() {
  const loaded = readJsonIfExists(configPath()) || {};
  return { ...defaultConfig(), ...loaded, versions: { ...DEFAULT_VERSIONS, ...(loaded.versions || {}) } };
}

export function saveConfig(config) {
  writeJsonPrivate(configPath(), config);
}

export function ensureApiKey() {
  const config = loadConfig();
  const envKey = process.env.AERIAL_API_KEY;
  if (envKey) {
    config.apiKeyHash = hashApiKey(envKey);
    saveConfig(config);
    return { apiKey: envKey, config, created: false, source: "env" };
  }
  if (config.apiKeyHash) return { apiKey: undefined, config, created: false, source: "config" };
  const apiKey = randomApiKey();
  config.apiKeyHash = hashApiKey(apiKey);
  saveConfig(config);
  return { apiKey, config, created: true, source: "generated" };
}

export function validateLocalAuth(headers, config = loadConfig()) {
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const authorization = lowerHeaders.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
  const apiKey = lowerHeaders["x-api-key"] || bearer;
  return verifyApiKey(apiKey, config.apiKeyHash);
}

export function requireConfigFile() {
  if (!fs.existsSync(configPath())) {
    throw new Error(`Aerial is not initialized. Run: aerial key generate`);
  }
}
