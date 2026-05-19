import fs from "node:fs";
import { CONFIG_VERSION, DEFAULT_HOST, DEFAULT_PORT, DEFAULT_VERSIONS } from "./constants.js";
import { apiKeyPath, configPath, readJsonIfExists, writeJsonPrivate, writePrivateFile } from "./paths.js";
import { hashApiKey, randomApiKey, verifyApiKey } from "./crypto.js";

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    apiKeyHash: undefined,
    defaultModel: undefined,
    logLevel: "info",
    promptCacheRetention: "in_memory",
    promptCacheKey: "auto",
    versions: DEFAULT_VERSIONS
  };
}

export function loadConfig() {
  const loaded = readJsonIfExists(configPath()) || {};
  const envRetention = process.env.AERIAL_PROMPT_CACHE_RETENTION;
  const envCacheKey = process.env.AERIAL_PROMPT_CACHE_KEY;
  const defaults = defaultConfig();
  const promptCacheRetention = envRetention === undefined ? (loaded.promptCacheRetention ?? defaults.promptCacheRetention) : envRetention;
  const promptCacheKey = envCacheKey === undefined ? (loaded.promptCacheKey ?? defaults.promptCacheKey) : envCacheKey;
  return { ...defaults, ...loaded, promptCacheRetention, promptCacheKey, versions: { ...DEFAULT_VERSIONS, ...(loaded.versions || {}) } };
}

export function saveConfig(config) {
  writeJsonPrivate(configPath(), config);
}

export function readStoredApiKey() {
  if (!fs.existsSync(apiKeyPath())) return undefined;
  const apiKey = fs.readFileSync(apiKeyPath(), "utf8").trim();
  return apiKey || undefined;
}

function writeStoredApiKey(apiKey) {
  writePrivateFile(apiKeyPath(), `${apiKey}\n`);
}

export function ensureApiKey() {
  const config = loadConfig();
  const envKey = process.env.AERIAL_API_KEY;
  if (envKey) {
    config.apiKeyHash = hashApiKey(envKey);
    writeStoredApiKey(envKey);
    saveConfig(config);
    return { apiKey: envKey, config, created: false, source: "env" };
  }
  const storedKey = readStoredApiKey();
  if (storedKey) {
    if (!config.apiKeyHash || !verifyApiKey(storedKey, config.apiKeyHash)) {
      config.apiKeyHash = hashApiKey(storedKey);
      saveConfig(config);
    }
    return { apiKey: storedKey, config, created: false, source: "stored" };
  }
  const hadHash = Boolean(config.apiKeyHash);
  const apiKey = randomApiKey();
  config.apiKeyHash = hashApiKey(apiKey);
  writeStoredApiKey(apiKey);
  saveConfig(config);
  return { apiKey, config, created: true, source: hadHash ? "rotated" : "generated" };
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
