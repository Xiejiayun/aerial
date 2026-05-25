import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseNumberChoice } from "./prompt-utils.js";

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

export async function chooseSetupEffort({
  target,
  explicitEffort,
  prompt,
  input: inputStream = input,
  output: outputStream = output
} = {}) {
  if (explicitEffort !== undefined) {
    return { effort: assertValidEffort(explicitEffort), source: "explicit", displayed: false };
  }
  const shouldPrompt = prompt === undefined ? Boolean(inputStream.isTTY) : prompt;
  if (!shouldPrompt) {
    return { effort: DEFAULT_EFFORT, source: "default_non_tty", displayed: false };
  }
  const defaultIndex = EFFORT_VALUES.indexOf(DEFAULT_EFFORT);
  const rl = createInterface({ input: inputStream, output: outputStream });
  try {
    outputStream.write(`Choose ${target} reasoning effort:\n`);
    for (const [index, value] of EFFORT_VALUES.entries()) {
      const marker = index === defaultIndex ? "  (default)" : "";
      outputStream.write(`  ${index + 1}. ${value}${marker}\n`);
    }
    while (true) {
      const answer = await rl.question(`Choose effort [1-${EFFORT_VALUES.length}, default ${defaultIndex + 1} = ${DEFAULT_EFFORT}]: `);
      const selectedIndex = parseNumberChoice(answer, { max: EFFORT_VALUES.length, defaultIndex });
      if (selectedIndex !== undefined) {
        return { effort: EFFORT_VALUES[selectedIndex], source: "prompt", displayed: true };
      }
      outputStream.write(`Enter a number from 1 to ${EFFORT_VALUES.length}, or press Enter for ${defaultIndex + 1}.\n`);
    }
  } finally {
    rl.close();
  }
}

export function formatEffortSelection({ target, effort, source }) {
  if (source === "explicit") return `Selected ${target} effort: ${effort}`;
  if (source === "prompt") return `Selected ${target} effort: ${effort}`;
  return `No interactive terminal detected; selected ${target} effort: ${effort}. Pass --effort <low|medium|high|xhigh|max> to choose a different effort.`;
}
