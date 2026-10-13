import { assertValidEffort, EFFORT_VALUES } from "../shared/effort.js";

export const CLAUDE_PERSISTENT_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);

// Claude recognizes Anthropic's hyphenated identity; Copilot uses dotted
// versions and sometimes suffixes for deployments of the same model.
export function claudeNativeModel(model) {
  if (typeof model !== "string") return undefined;
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d{1,2}))?(?:-(\d{8}))?(?:-[a-z][a-z0-9-]*)?$/.exec(model);
  if (!match) return undefined;
  return `claude-${match[1]}-${match[2]}${match[3] ? `-${match[3]}` : ""}${match[4] ? `-${match[4]}` : ""}`;
}

export function claudeModelSettingsKey(model) {
  return claudeNativeModel(model)?.replace(/-\d{8}$/, "") || model;
}

export function claudeSetupEfforts(model, supportedEfforts) {
  const native = claudeNativeModel(model);
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?/.exec(native || "");
  if (!match) return [];
  const [, family, majorText, minorText] = match;
  const major = Number(majorText), minor = Number(minorText || 0);
  // Current official Claude Code capability table. Unknown older/custom models
  // get no claimed persistent effort support; catalog support alone is not enough.
  const extended = (major === 5 && ["opus", "sonnet", "fable"].includes(family))
    || (major === 5 && minor >= 5 && family === "haiku")
    || (major === 4 && [7, 8].includes(minor) && family === "opus");
  const basic = major === 4 && minor === 6 && ["opus", "sonnet"].includes(family);
  const client = extended ? [...CLAUDE_PERSISTENT_EFFORTS] : basic ? ["low", "medium", "high"] : [];
  if (!Array.isArray(supportedEfforts) || !supportedEfforts.length) return client;
  const catalog = new Set(supportedEfforts.map(value => String(value).toLowerCase()));
  return client.filter(value => catalog.has(value));
}

export function resolveClaudeSetupEffort(requested, model, supportedEfforts) {
  const requestedEffort = assertValidEffort(requested);
  const candidates = claudeSetupEfforts(model, supportedEfforts);
  if (!candidates.length) {
    throw new Error(`Cannot persist an effort for ${model}: no verified overlap between Claude Code settings and this model's capabilities. Omit --effort or choose a compatible Claude model.`);
  }
  const ceiling = requestedEffort === "ultracode" ? "xhigh" : requestedEffort;
  const rank = EFFORT_VALUES.indexOf(ceiling);
  const selected = candidates.filter(value => EFFORT_VALUES.indexOf(value) <= rank).at(-1) || candidates[0];
  const reason = requestedEffort === "ultracode" ? "ultracode_is_workflow_mode"
    : requestedEffort === "max" ? "max_is_session_only"
      : selected !== requestedEffort ? "client_and_model_capabilities" : "exact";
  return { requestedEffort, resolvedEffort: selected, reason, supportedEfforts: candidates };
}

export function claudeSavedEffort(doc) {
  const modelKey = claudeModelSettingsKey(doc?.model);
  const perModel = doc?.modelSettings?.[modelKey]?.effortLevel;
  // Recent models ignore the legacy top-level key in user settings.
  const ignoresLegacy = /^claude-(?:opus|sonnet|haiku)-5-5(?:-|$)/.test(modelKey || "");
  const value = perModel ?? (ignoresLegacy ? undefined : doc?.effortLevel);
  return {
    effort: CLAUDE_PERSISTENT_EFFORTS.includes(value) ? value : "missing",
    effortSource: perModel !== undefined ? "modelSettings" : value !== undefined ? "effortLevel" : "missing",
    ...(value !== undefined && !CLAUDE_PERSISTENT_EFFORTS.includes(value) ? { invalidEffort: value } : {})
  };
}
