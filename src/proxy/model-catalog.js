import crypto from "node:crypto";

const TTL_MS = 30000;
const cache = new Map();

export function tokenFingerprintOf(token) {
  if (typeof token !== "string" || token.length === 0) return "anonymous";
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export async function fetchModelsCatalog({ fetchImpl, tokenFingerprint } = {}) {
  if (typeof fetchImpl !== "function") return undefined;
  const key = tokenFingerprint || "anonymous";
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;
  const models = await fetchImpl();
  if (!Array.isArray(models)) return undefined;
  cache.set(key, { models, expiresAt: now + TTL_MS });
  return models;
}

export function clearModelCatalogCacheForTests() {
  cache.clear();
}

export function canonicalClaudeFamily(modelId) {
  if (typeof modelId !== "string") return undefined;
  if (/^claude-opus-4[.-]7(?:-|$)/.test(modelId)) return "claude-opus-4.7";
  return undefined;
}

function modelHasRoute(model, route) {
  const endpoints = Array.isArray(model?.supported_endpoints) ? model.supported_endpoints : [];
  const routes = Array.isArray(model?.aerial?.routes) ? model.aerial.routes : [];
  if (route === "/v1/messages") return endpoints.includes("/v1/messages") || routes.includes("messages");
  return endpoints.includes(route);
}

function modelSupportsAdaptiveThinking(model) {
  const supports = model?.capabilities?.supports;
  return supports?.adaptive_thinking === true || supports?.thinking?.adaptive === true;
}

function supportedReasoningEfforts(model) {
  const supports = model?.capabilities?.supports;
  const values = supports?.reasoning_effort ?? supports?.reasoning_efforts;
  if (Array.isArray(values)) return values.map(String);
  if (typeof values === "string") return [values];
  return [];
}

export function findCompatibleModel({ models, family, route, adaptiveThinking, effort, preferredId } = {}) {
  if (!Array.isArray(models) || !family) return undefined;
  const candidates = models.filter((model) => {
    const id = typeof model?.id === "string" ? model.id : "";
    if (canonicalClaudeFamily(id) !== family) return false;
    if (route && !modelHasRoute(model, route)) return false;
    if (adaptiveThinking === true && !modelSupportsAdaptiveThinking(model)) return false;
    if (effort && !supportedReasoningEfforts(model).includes(effort)) return false;
    return true;
  });
  if (candidates.length === 0) return undefined;
  if (preferredId) {
    const preferred = candidates.find((model) => model.id === preferredId);
    if (preferred) return preferred;
  }
  return candidates[0];
}
