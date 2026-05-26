export function parseNumberChoice(value, { max, defaultIndex = 0, oneBased = false } = {}) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return defaultIndex;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (n < 1 || n > max) return undefined;
  return oneBased ? n : n - 1;
}
