import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { proxyModels } from "../proxy/index.js";
import { readJsonSafely } from "../shared/http-utils.js";
import { modelsForRoute } from "../proxy/model-utils.js";
import { parseNumberChoice } from "../shared/prompt-utils.js";

const MAX_LISTED_MODELS = 20;
const GPT_VERSION_RE = /^gpt-(\d+)(?:\.(\d+))?/i;
const STABLE_GPT_RE = /^gpt-\d+(?:\.\d+)?$/i;

export { modelsForRoute } from "../proxy/model-utils.js";

function gptVersionScore(id) {
  const match = GPT_VERSION_RE.exec(id);
  if (!match) return undefined;
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  return major * 1000 + minor;
}

export function rankModels(choices) {
  return [...choices]
    .map((choice, index) => ({ choice, index, score: gptVersionScore(choice.id) }))
    .sort((a, b) => {
      if (a.score !== undefined && b.score !== undefined && a.score !== b.score) return b.score - a.score;
      if (a.score !== undefined && b.score === undefined) return -1;
      if (a.score === undefined && b.score !== undefined) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.choice);
}

export function pickRecommended(choices) {
  if (!choices.length) return { recommended: undefined, source: "first_available" };
  const ranked = rankModels(choices);
  const stable = ranked.filter((c) => STABLE_GPT_RE.test(c.id));
  if (stable.length) return { recommended: stable[0].id, source: "recommended_stable", ranked };
  return { recommended: ranked[0].id, source: "recommended_fallback", ranked };
}

export function orderForPrompt(ranked, recommended) {
  if (!recommended) return [...ranked];
  const found = ranked.find((c) => c.id === recommended);
  if (!found) return [...ranked];
  return [found, ...ranked.filter((c) => c.id !== recommended)];
}

export async function discoverModelsForRoute(route) {
  const response = await proxyModels(new Request("http://aerial.local/v1/models", { method: "GET" }));
  const payload = await readJsonSafely(response);
  if (!response.ok) {
    const detail = payload.error || payload.raw || JSON.stringify(payload);
    throw new Error(`Could not load Copilot models (${response.status}): ${detail}`);
  }
  const models = Array.isArray(payload.data) ? payload.data : [];
  return modelsForRoute(models, route);
}

export async function chooseSetupModel({ target, route, explicitModel, prompt = input.isTTY }) {
  if (explicitModel) return { model: explicitModel, choices: [], source: "explicit" };
  let raw;
  try {
    raw = await discoverModelsForRoute(route);
  } catch (err) {
    throw new Error(`${err.message}\nRun \`aerial login\` first, or pass \`--model <id>\` if you already know which ${target} model to use.`);
  }
  if (!raw.length) {
    throw new Error(`No Copilot models currently advertise the ${route} route needed by ${target}. Run \`aerial probe\` to inspect the full model list.`);
  }
  const { recommended, source: recommendedSource, ranked } = pickRecommended(raw);
  const choices = ranked;
  const promptListed = orderForPrompt(ranked, recommended).slice(0, MAX_LISTED_MODELS);
  if (!prompt) return { model: recommended, choices, source: recommendedSource, recommended };

  const rl = createInterface({ input, output });
  try {
    output.write(`Available ${target} models (${route} route):\n`);
    if (recommendedSource === "recommended_fallback") {
      output.write(`  No stable gpt-N.M model available; recommending ${recommended} as a fallback. Pass --model <id> to override.\n`);
    }
    for (const [index, choice] of promptListed.entries()) {
      const marker = choice.id === recommended ? "  (recommended)" : "";
      output.write(`  ${index + 1}. ${choice.id}${marker}\n`);
    }
    if (choices.length > MAX_LISTED_MODELS) output.write(`  ... ${choices.length - MAX_LISTED_MODELS} more\n`);
    while (true) {
      const answer = await rl.question(`Choose ${target} model [1-${promptListed.length}, default 1 = ${recommended}]: `);
      const selected = parseNumberChoice(answer, { max: promptListed.length, defaultIndex: 1, oneBased: true });
      if (selected) return { model: promptListed[selected - 1].id, choices, source: "prompt", displayed: true, recommended };
      output.write(`Enter a number from 1 to ${promptListed.length}, or press Enter for 1.\n`);
    }
  } finally {
    rl.close();
  }
}

export function formatModelChoices({ target, route, choices, selectedModel, source, recommended }) {
  if (!choices.length) return [];
  const lines = [
    `Available ${target} models (${route} route):`
  ];
  for (const [index, choice] of choices.slice(0, MAX_LISTED_MODELS).entries()) {
    const markers = [];
    if (choice.id === recommended) markers.push("recommended");
    if (choice.id === selectedModel) markers.push("selected");
    const suffix = markers.length ? `  (${markers.join(", ")})` : "";
    lines.push(`  ${index + 1}. ${choice.id}${suffix}`);
  }
  if (choices.length > MAX_LISTED_MODELS) lines.push(`  ... ${choices.length - MAX_LISTED_MODELS} more`);
  if (source === "first_available" || source === "recommended_stable") {
    lines.push(`No interactive terminal detected; selected ${selectedModel}. Pass --model <id> to choose a different model.`);
  } else if (source === "recommended_fallback") {
    lines.push(`No stable gpt-N.M model available; selected ${selectedModel}. Pass --model <id> to override.`);
  } else {
    lines.push(`Selected ${target} model: ${selectedModel}`);
  }
  return lines;
}
