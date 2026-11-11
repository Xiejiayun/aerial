import path from "node:path";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,200}$/;

export function isSupportedCoworkModel(model) {
  return /^(anthropic|claude)$/i.test(model?.provider || "")
    && /\b(opus|sonnet|fable)\b/i.test(`${model?.displayName || ""} ${model?.upstreamId || ""}`);
}

export function modelVerifiedEfforts(profile, model) {
  if (!isSupportedCoworkModel(model)) return [];
  const scoped = profile.capabilities?.verifiedModelEfforts;
  if (scoped && Object.hasOwn(scoped, model.upstreamId)) return [...scoped[model.upstreamId]];
  // The legacy profile was verified against this exact Anthropic route. It
  // cannot authorize another Opus version, Sonnet, Fable or a different vendor.
  return model.upstreamId === "opus-5.5" && /^anthropic$/i.test(model.provider)
    ? [...(profile.capabilities?.verifiedEfforts || [])] : [];
}

export function modelSupportedEfforts(profile, model) {
  const verified = modelVerifiedEfforts(profile, model);
  return [...new Set((model.supportedEfforts || []).filter(effort => EFFORTS.has(effort) && verified.includes(effort)))];
}

export function selectCoworkEffort(profile, model, requested) {
  const supported = modelSupportedEfforts(profile, model);
  if (requested !== undefined) {
    if (!supported.includes(requested)) throw coworkError("UNSUPPORTED_CAPABILITY", "Select an effort advertised and verified for this exact Cowork model.", { statusCode: 400 });
    return requested;
  }
  if (supported.includes(model.defaultEffort)) return model.defaultEffort;
  return ["medium", "high", "low", "xhigh", "max"].find(effort => supported.includes(effort));
}

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
  const verifiedModelEfforts = capabilities.verifiedModelEfforts;
  if (verifiedModelEfforts !== undefined && (!verifiedModelEfforts || typeof verifiedModelEfforts !== "object"
    || Array.isArray(verifiedModelEfforts)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(verifiedModelEfforts)) || Object.entries(verifiedModelEfforts).length > 128
    || Object.entries(verifiedModelEfforts).some(([model, efforts]) => !MODEL_ID.test(model)
      || ["__proto__", "prototype", "constructor"].includes(model)
      || !Array.isArray(efforts) || efforts.length > 5 || new Set(efforts).size !== efforts.length
      || efforts.some(effort => !EFFORTS.has(effort))))) {
    invalid("verifiedModelEfforts must map exact upstream model IDs to unique verified Cowork effort values.");
  }
  const verifiedModelConversationReuse = capabilities.verifiedModelConversationReuse;
  if (verifiedModelConversationReuse !== undefined && (!verifiedModelConversationReuse || typeof verifiedModelConversationReuse !== "object"
    || Array.isArray(verifiedModelConversationReuse)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(verifiedModelConversationReuse))
    || Object.entries(verifiedModelConversationReuse).length > 128
    || Object.entries(verifiedModelConversationReuse).some(([model, verified]) => !MODEL_ID.test(model)
      || ["__proto__", "prototype", "constructor"].includes(model) || verified !== true))) {
    invalid("verifiedModelConversationReuse must map exact upstream model IDs to true after conversation verification.");
  }
  const localTrial = value.localTrial;
  if (localTrial !== undefined && (!localTrial || typeof localTrial !== "object" || Array.isArray(localTrial)
    || Object.keys(localTrial).length !== 1 || !Object.hasOwn(localTrial, "allowUnverifiedCloudTools")
    || typeof localTrial.allowUnverifiedCloudTools !== "boolean")) {
    invalid("localTrial must contain only the boolean allowUnverifiedCloudTools option.");
  }
  if (requireLive && (value.evidence.source !== "authorized-session"
    || (capabilities.connectorsDisabled !== "verified" && localTrial?.allowUnverifiedCloudTools !== true)
    || capabilities.completion !== "fr-plus-rl-ok"
    || capabilities.eventCorrelation !== "verified")) {
    throw coworkError("PROTOCOL_UNVERIFIED", "Cowork live inference requires authorized-session evidence, event correlation, completion semantics, and verified cloud-tool isolation or an explicitly enabled local experimental trial.", { statusCode: 503 });
  }
  return { ...value, origin: origin.origin, capabilities: { ...capabilities, verifiedEfforts: [...(capabilities.verifiedEfforts || [])],
    ...(verifiedModelEfforts !== undefined ? { verifiedModelEfforts: Object.fromEntries(Object.entries(verifiedModelEfforts).map(([model, efforts]) => [model, [...efforts]])) } : {}),
    ...(verifiedModelConversationReuse !== undefined ? { verifiedModelConversationReuse: { ...verifiedModelConversationReuse } } : {}) },
    ...(localTrial !== undefined ? { localTrial: { allowUnverifiedCloudTools: localTrial.allowUnverifiedCloudTools } } : {}) };
}

export function requireAuthorizedProfile(profile) {
  if (profile.evidence.source !== "authorized-session") throw coworkError("PROTOCOL_UNVERIFIED", "Confirm the origin, client, and resource from a normal authorized Cowork session before authenticating.", { statusCode: 503 });
}

export function requireCoworkRuntime({ platform = process.platform, nodeVersion = process.versions.node } = {}) {
  if (platform !== "win32") throw coworkError("UNSUPPORTED_PLATFORM", "Cowork WAM authentication currently requires Windows.", { statusCode: 400 });
  if (Number(nodeVersion.split(".")[0]) < 24) throw coworkError("UNSUPPORTED_RUNTIME", "Cowork requires Node.js 24 or later; other Aerial providers retain their existing runtime requirements.", { statusCode: 400 });
}
