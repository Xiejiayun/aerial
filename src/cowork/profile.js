import path from "node:path";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

export function coworkError(code, message, { statusCode = 502, submitted = false } = {}) {
  return Object.assign(new Error(message), { code, statusCode, submitted });
}

export function validateProfile(value, { requireLive = false } = {}) {
  const invalid = (message) => { throw coworkError("INVALID_PROFILE", message, { statusCode: 400 }); };
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) invalid("Cowork requires a version 1 protocol profile.");
  let origin;
  try { origin = new URL(value.origin); } catch { invalid("Configure the Cowork origin observed in your authorized session."); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) invalid("Cowork origin must be an HTTPS origin without credentials, path, query, or fragment.");
  if (!UUID.test(value.clientId || "") || !UUID.test(value.resourceId || "")) invalid("Configure the client and resource UUIDs observed in the authorized Cowork session.");
  if (value.scope !== `${value.resourceId}/access_as_user`) invalid("Cowork scope must be the configured resource's access_as_user scope.");
  if (value.authorityHost !== "https://login.microsoftonline.com") invalid("This Cowork authentication profile requires the verified Microsoft public-cloud authority.");
  if (value.tenantId !== undefined && value.tenantId !== "organizations" && !UUID.test(value.tenantId)) invalid("Cowork tenantId must be a UUID or organizations.");
  if (value.accountFile !== undefined && (typeof value.accountFile !== "string" || !path.isAbsolute(value.accountFile))) invalid("Cowork accountFile must be an absolute path.");
  if (!["authorized-session", "reference-only", "synthetic-test"].includes(value.evidence?.source)
    || !Number.isFinite(Date.parse(value.evidence?.observedAt))) invalid("Record the protocol parameter evidence source and observation time.");
  const capabilities = value.capabilities || {};
  if (capabilities.verifiedEfforts !== undefined && (!Array.isArray(capabilities.verifiedEfforts)
    || capabilities.verifiedEfforts.some((effort) => !EFFORTS.has(effort)))) invalid("verifiedEfforts must list only verified Cowork effort values.");
  if (requireLive && (value.evidence.source !== "authorized-session"
    || capabilities.connectorsDisabled !== "verified"
    || capabilities.completion !== "fr-plus-rl-ok"
    || capabilities.eventCorrelation !== "verified")) {
    throw coworkError("PROTOCOL_UNVERIFIED", "Cowork live inference requires authorized-session evidence, verified cloud-tool isolation, event correlation, and completion semantics.", { statusCode: 503 });
  }
  return { ...value, origin: origin.origin, capabilities: { ...capabilities, verifiedEfforts: [...(capabilities.verifiedEfforts || [])] } };
}

export function requireAuthorizedProfile(profile) {
  if (profile.evidence.source !== "authorized-session") throw coworkError("PROTOCOL_UNVERIFIED", "Confirm the origin, client, and resource from a normal authorized Cowork session before authenticating.", { statusCode: 503 });
}

export function requireCoworkRuntime({ platform = process.platform, nodeVersion = process.versions.node } = {}) {
  if (platform !== "win32") throw coworkError("UNSUPPORTED_PLATFORM", "Cowork WAM authentication currently requires Windows.", { statusCode: 400 });
  if (Number(nodeVersion.split(".")[0]) < 24) throw coworkError("UNSUPPORTED_RUNTIME", "Cowork requires Node.js 24 or later; other Aerial providers retain their existing runtime requirements.", { statusCode: 400 });
}
