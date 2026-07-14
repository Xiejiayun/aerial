export const EFFORT_VALUES = Object.freeze(["low", "medium", "high", "xhigh"]);
export const CODEX_EFFORT_VALUES = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export const DEFAULT_EFFORT = "medium";

function lower(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim().toLowerCase();
  return trimmed || undefined;
}

export function normalizeEffort(value) {
  const trimmed = lower(value);
  if (!trimmed) return undefined;
  if (trimmed === "max") return "xhigh";
  if (EFFORT_VALUES.includes(trimmed)) return trimmed;
  return undefined;
}

export function normalizeCodexEffort(value) {
  const trimmed = lower(value);
  if (!trimmed) return undefined;
  if (trimmed === "none") return "minimal";
  if (CODEX_EFFORT_VALUES.includes(trimmed)) return trimmed;
  return undefined;
}

export function assertValidEffort(raw) {
  const normalized = normalizeEffort(raw);
  if (!normalized) {
    throw new Error(`Invalid --effort ${JSON.stringify(raw)}. Allowed: ${EFFORT_VALUES.join(", ")} (or alias 'max' for xhigh).`);
  }
  return normalized;
}

export function assertValidCodexEffort(raw) {
  const normalized = normalizeCodexEffort(raw);
  if (!normalized) {
    throw new Error(`Invalid --effort ${JSON.stringify(raw)} for Codex. Allowed: ${CODEX_EFFORT_VALUES.join(", ")} (or alias 'none' for minimal).`);
  }
  return normalized;
}

function codexCatalogEfforts(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const efforts = [];
  for (const value of values) {
    const wireEffort = lower(value);
    const resolvedEffort = normalizeCodexEffort(wireEffort);
    if (!resolvedEffort || seen.has(resolvedEffort)) continue;
    seen.add(resolvedEffort);
    efforts.push({ resolvedEffort, wireEffort, rank: CODEX_EFFORT_VALUES.indexOf(resolvedEffort) });
  }
  return efforts.sort((a, b) => a.rank - b.rank);
}

export function resolveCodexEffort(requested, supportedEfforts) {
  const requestedEffort = normalizeCodexEffort(requested);
  if (!requestedEffort) return undefined;
  const requestedRank = CODEX_EFFORT_VALUES.indexOf(requestedEffort);
  const supported = codexCatalogEfforts(supportedEfforts);

  if (supported.length) {
    const exact = supported.find((entry) => entry.resolvedEffort === requestedEffort);
    const lowerOrEqual = supported.filter((entry) => entry.rank <= requestedRank);
    const selected = exact || lowerOrEqual.at(-1) || supported[0];
    let reason = "exact";
    if (selected.resolvedEffort !== requestedEffort) {
      reason = selected.rank < requestedRank ? "downgraded" : "nearest_supported";
    } else if (selected.wireEffort !== requestedEffort) {
      reason = "alias";
    }
    return {
      requestedEffort,
      resolvedEffort: selected.resolvedEffort,
      wireEffort: selected.wireEffort,
      reason
    };
  }

  if (requestedEffort === "minimal") {
    return { requestedEffort, resolvedEffort: "minimal", wireEffort: "none", reason: "alias" };
  }
  if (requestedEffort === "ultra") {
    return { requestedEffort, resolvedEffort: "max", wireEffort: "max", reason: "fallback" };
  }
  return { requestedEffort, resolvedEffort: requestedEffort, wireEffort: requestedEffort, reason: "exact" };
}
