export const EFFORT_VALUES = Object.freeze(["low", "medium", "high", "xhigh"]);
export const DEFAULT_EFFORT = "medium";

export function normalizeEffort(value) {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === "max") return "xhigh";
  if (EFFORT_VALUES.includes(trimmed)) return trimmed;
  return undefined;
}

export function assertValidEffort(raw) {
  const normalized = normalizeEffort(raw);
  if (!normalized) {
    throw new Error(`Invalid --effort ${JSON.stringify(raw)}. Allowed: ${EFFORT_VALUES.join(", ")} (or alias 'max' for xhigh).`);
  }
  return normalized;
}
