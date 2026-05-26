import crypto from "node:crypto";
import { loadConfig } from "../shared/config.js";

export function configuredPromptCacheRetention(config = loadConfig()) {
  const value = config.promptCacheRetention;
  if (!value || value === "off") return undefined;
  if (!["in_memory", "24h"].includes(value)) return undefined;
  return value;
}

function stableCacheKeyPart(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function metadataCacheKey(metadata) {
  if (!metadata || typeof metadata !== "object") return undefined;
  for (const key of ["prompt_cache_key", "session_id", "conversation_id", "thread_id", "user_id"]) {
    const value = stableCacheKeyPart(metadata[key]);
    if (value) return value;
  }
  return undefined;
}

export function configuredPromptCacheKey(payload, config = loadConfig()) {
  const value = config.promptCacheKey;
  if (!value || value === "off") return undefined;
  if (value !== "auto") return String(value);
  const basis = [
    stableCacheKeyPart(payload?.model),
    metadataCacheKey(payload?.metadata),
    stableCacheKeyPart(payload?.conversation_id),
    stableCacheKeyPart(payload?.thread_id),
    stableCacheKeyPart(process.cwd())
  ].filter(Boolean).join(":");
  if (!basis) return undefined;
  return "aerial:" + crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

export function withDefaultPromptCache(payload) {
  const config = loadConfig();
  const retention = configuredPromptCacheRetention(config);
  const promptCacheKey = configuredPromptCacheKey(payload, config);
  const next = { ...payload };
  if (retention && next.prompt_cache_retention === undefined) next.prompt_cache_retention = retention;
  if (promptCacheKey && next.prompt_cache_key === undefined) next.prompt_cache_key = promptCacheKey;
  return next;
}

export function countCacheControlBlocks(value) {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countCacheControlBlocks(item), 0);
  return Object.entries(value).reduce((total, [key, item]) => total + (key === "cache_control" ? 1 : 0) + countCacheControlBlocks(item), 0);
}

function addEphemeralCacheControl(value) {
  if (typeof value === "string") {
    return value.trim() ? { value: [{ type: "text", text: value, cache_control: { type: "ephemeral" } }], changed: true } : { value, changed: false };
  }
  if (!Array.isArray(value) || value.length === 0) return { value, changed: false };
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const item = value[i];
    if (item && typeof item === "object" && !Array.isArray(item) && item.cache_control === undefined) {
      const next = [...value];
      next[i] = { ...item, cache_control: { type: "ephemeral" } };
      return { value: next, changed: true };
    }
  }
  return { value, changed: false };
}

export function withDefaultAnthropicCache(payload) {
  const retention = configuredPromptCacheRetention();
  if (!retention || countCacheControlBlocks(payload) > 0) return payload;
  const next = { ...payload };
  const system = addEphemeralCacheControl(next.system);
  if (system.changed) return { ...next, system: system.value };
  if (Array.isArray(next.tools) && next.tools.length > 0) {
    const tools = addEphemeralCacheControl(next.tools);
    if (tools.changed) return { ...next, tools: tools.value };
  }
  return next;
}
