import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { proxyModels } from "../proxy/index.js";
import { readJsonSafely } from "../shared/utils.js";
import { modelsForRoute } from "../proxy/models.js";
import { codexStatus, claudeStatus } from "../setup/clients.js";
import {
  CODEX_EFFORT_VALUES,
  DEFAULT_EFFORT,
  EFFORT_VALUES,
  assertValidCodexEffort,
  assertValidEffort,
  normalizeCodexEffort,
  normalizeEffort,
  resolveCodexEffort
} from "../shared/effort.js";

export { modelsForRoute } from "../proxy/models.js";
export {
  CODEX_EFFORT_VALUES,
  DEFAULT_EFFORT,
  EFFORT_VALUES,
  assertValidCodexEffort,
  assertValidEffort,
  normalizeCodexEffort,
  normalizeEffort,
  resolveCodexEffort
} from "../shared/effort.js";

const MAX_LISTED_MODELS = 20;
const GPT_VERSION_RE = /^gpt-(\d+)(?:\.(\d+))?/i;
const STABLE_GPT_RE = /^gpt-\d+(?:\.\d+)?$/i;
const CODEX_EFFORT_USAGE = "<minimal|low|medium|high|xhigh|max|ultra>";
const CLAUDE_EFFORT_USAGE = "<low|medium|high|xhigh|max>";

const CLEAR_LINE = "\x1b[2K";
const CURSOR_UP = "\x1b[1A";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

const MAX_VISIBLE = 10;

// Color is opt-out via NO_COLOR and gated on a real TTY, so piped output and
// dumb terminals get clean ASCII instead of escape-code soup.
const COLOR = process.env.NO_COLOR ? false : Boolean(output.isTTY);

const sgr = (code) => (COLOR ? `\x1b[${code}m` : "");
const RESET = sgr(0);
const BOLD = sgr(1);
const DIM = sgr(2);
const CYAN = sgr(36);
const BRIGHT_CYAN = sgr(96);
const GREEN = sgr(32);
const BLUE = sgr(34);
const YELLOW = sgr(33);

const GLYPHS = COLOR
  ? { bar: "▌", on: "●", off: "○", arrow: "↑", darrow: "↓", enter: "⏎" }
  : { bar: "|", on: "*", off: " ", arrow: "^", darrow: "v", enter: "<-" };

const TAG_COLORS = {
  recommended: GREEN,
  current: BLUE,
  selected: BLUE,
  default: YELLOW
};

function paintTags(tags) {
  if (!tags.length) return "";
  const painted = tags.map((t) => `${TAG_COLORS[t] || DIM}${t}${RESET}`).join(`${DIM}, ${RESET}`);
  return `  ${painted}`;
}

function helpBar() {
  const key = (s) => `${DIM}${s}${RESET}`;
  return `${key(`${GLYPHS.arrow}${GLYPHS.darrow}`)} move  ${key(GLYPHS.enter)} select  ${key("q")} cancel`;
}

export function viewportStart(cursor, total, maxVisible) {
  if (total <= maxVisible) return 0;
  const half = Math.floor(maxVisible / 2);
  const start = cursor - half;
  if (start < 0) return 0;
  if (start + maxVisible > total) return total - maxVisible;
  return start;
}

function buildFrame({ title, items, cursor, getTags, maxVisible = MAX_VISIBLE }) {
  const lines = [`${BOLD}${title}${RESET}`, ""];
  const total = items.length;
  const start = viewportStart(cursor, total, maxVisible);
  const end = Math.min(start + maxVisible, total);
  // Overflow hints occupy a fixed line whether or not there is overflow, so the
  // frame height stays constant and incremental redraws never leave stale rows.
  lines.push(start > 0 ? `${DIM}   ${GLYPHS.arrow} ${start} more${RESET}` : "");
  for (let index = start; index < end; index++) {
    const item = items[index];
    const active = index === cursor;
    const tagText = paintTags(getTags ? getTags(item, index) : []);
    if (active) {
      const bar = `${BRIGHT_CYAN}${GLYPHS.bar}${RESET}`;
      const dot = `${BRIGHT_CYAN}${GLYPHS.on}${RESET}`;
      lines.push(`${bar} ${dot} ${CYAN}${BOLD}${item.label}${RESET}${tagText}`);
    } else {
      lines.push(`  ${DIM}${GLYPHS.off}${RESET} ${item.label}${tagText}`);
    }
  }
  lines.push(end < total ? `${DIM}   ${GLYPHS.darrow} ${total - end} more${RESET}` : "");
  lines.push("");
  lines.push(helpBar());
  return lines;
}

/**
 * Arrow-key list selector. TTY-only; callers gate on isTTY and supply their own
 * non-interactive path. Number keys jump to that 1-based row and Enter confirms,
 * so tests can drive it by feeding "3\n".
 */
async function select({
  title,
  items,
  initialIndex = 0,
  getTags,
  maxVisible = MAX_VISIBLE,
  input: inputStream = input,
  output: outputStream = output
} = {}) {
  if (!items.length) throw new Error("select requires at least one item");
  let cursor = Math.min(Math.max(initialIndex, 0), items.length - 1);
  let drawn = 0;

  const render = () => {
    if (drawn) outputStream.write(CURSOR_UP.repeat(drawn - 1) + "\r");
    const lines = buildFrame({ title, items, cursor, getTags, maxVisible });
    outputStream.write(lines.map((line) => CLEAR_LINE + line).join("\n"));
    drawn = lines.length;
  };

  const wasRaw = Boolean(inputStream.isRaw);
  const wasPaused = inputStream.isPaused();
  readline.emitKeypressEvents(inputStream);
  if (inputStream.isTTY && inputStream.setRawMode) inputStream.setRawMode(true);
  inputStream.resume();
  outputStream.write(HIDE_CURSOR);
  render();

  return await new Promise((resolve) => {
    const cleanup = () => {
      inputStream.removeListener("keypress", onKeypress);
      if (inputStream.isTTY && inputStream.setRawMode) inputStream.setRawMode(wasRaw);
      // Restore stdin to its prior flow state. emitKeypressEvents/resume left it
      // flowing; if it started paused (the usual CLI case), re-pausing lets the
      // event loop drain so the process exits after the final selection — while
      // still allowing a subsequent select() in the same run to resume cleanly.
      if (wasPaused) inputStream.pause();
      outputStream.write("\n" + SHOW_CURSOR);
    };
    const onKeypress = (str, key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve({ index: cursor, item: items[cursor], cancelled: false });
      } else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        resolve({ index: cursor, item: items[cursor], cancelled: true });
      } else if (/^[1-9]$/.test(str || "")) {
        const target = Number(str) - 1;
        if (target < items.length) {
          cursor = target;
          render();
        }
      }
    };
    inputStream.on("keypress", onKeypress);
  });
}

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

function currentModelFor(target) {
  try {
    const status = target === "Codex" ? codexStatus() : claudeStatus();
    return typeof status.model === "string" ? status.model : undefined;
  } catch {
    return undefined;
  }
}

function currentEffortFor(target) {
  try {
    const status = target === "Codex" ? codexStatus() : claudeStatus();
    if (typeof status.effort !== "string") return undefined;
    return target === "Codex" ? normalizeCodexEffort(status.effort) : normalizeEffort(status.effort);
  } catch {
    return undefined;
  }
}

export function normalizeEffortCandidates(values) {
  if (!Array.isArray(values)) return [];
  const normalized = new Set();
  for (const value of values) {
    const effort = normalizeEffort(value);
    if (effort) normalized.add(effort);
  }
  return EFFORT_VALUES.filter((effort) => normalized.has(effort));
}

export function normalizeCodexEffortCandidates(values) {
  if (!Array.isArray(values)) return [];
  const normalized = new Set();
  for (const value of values) {
    const effort = normalizeCodexEffort(value);
    if (effort) normalized.add(effort);
  }
  return CODEX_EFFORT_VALUES.filter((effort) => normalized.has(effort));
}

function effortUsage(target, candidates, restricted) {
  if (!restricted) return target === "Codex" ? CODEX_EFFORT_USAGE : CLAUDE_EFFORT_USAGE;
  if (target === "Codex") return `<${candidates.join("|")}>`;
  const values = [...candidates];
  if (values.includes("xhigh")) values.push("max");
  return `<${values.join("|")}>`;
}

function defaultEffortFor(candidates) {
  return candidates.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : candidates[0];
}

export async function chooseSetupModel({
  target,
  route,
  explicitModel,
  prompt,
  input: inputStream = input,
  output: outputStream = output
} = {}) {
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
  const promptListed = orderForPrompt(ranked, recommended);
  const shouldPrompt = prompt === undefined ? Boolean(inputStream.isTTY) : prompt;
  if (!shouldPrompt) return { model: recommended, choices, source: recommendedSource, recommended };

  const current = currentModelFor(target);
  const items = promptListed.map((choice) => ({ label: choice.id, id: choice.id }));
  const currentIndex = items.findIndex((item) => item.id === current);
  const initialIndex = currentIndex >= 0 ? currentIndex : 0;

  outputStream.write(`Available ${target} models (${route} route):\n`);
  if (recommendedSource === "recommended_fallback") {
    outputStream.write(`  No stable gpt-N.M model available; ${recommended} is the fallback. Pass --model <id> to override.\n`);
  }

  const { item, cancelled } = await select({
    title: `Choose ${target} model:`,
    items,
    initialIndex,
    getTags: (it) => {
      const tags = [];
      if (it.id === recommended) tags.push("recommended");
      if (it.id === current) tags.push("current");
      return tags;
    },
    input: inputStream,
    output: outputStream
  });
  if (cancelled) throw new Error(`${target} setup cancelled.`);
  return { model: item.id, choices, source: "prompt", displayed: true, recommended };
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

export async function chooseSetupEffort({
  target,
  explicitEffort,
  model,
  supportedEfforts,
  prompt,
  input: inputStream = input,
  output: outputStream = output
} = {}) {
  const isCodex = target === "Codex";
  const restrictedEfforts = isCodex
    ? normalizeCodexEffortCandidates(supportedEfforts)
    : normalizeEffortCandidates(supportedEfforts);
  const restricted = restrictedEfforts.length > 0;
  const globalEfforts = isCodex ? CODEX_EFFORT_VALUES : EFFORT_VALUES;
  const candidates = restricted ? restrictedEfforts : globalEfforts;
  if (explicitEffort !== undefined) {
    if (isCodex) {
      const requested = assertValidCodexEffort(explicitEffort);
      const resolved = resolveCodexEffort(requested, supportedEfforts);
      return {
        effort: resolved.resolvedEffort,
        source: "explicit",
        displayed: false,
        supportedEfforts: restricted ? candidates : undefined
      };
    }
    const effort = assertValidEffort(explicitEffort);
    if (restricted && !candidates.includes(effort)) {
      const subject = model ? `${target} model ${model}` : `${target} model`;
      throw new Error(`Effort ${JSON.stringify(explicitEffort)} is not supported by ${subject}. Allowed: ${effortUsage(target, candidates, true)}.`);
    }
    return { effort, source: "explicit", displayed: false, supportedEfforts: restricted ? candidates : undefined };
  }
  const shouldPrompt = prompt === undefined ? Boolean(inputStream.isTTY) : prompt;
  if (!shouldPrompt) {
    return { effort: defaultEffortFor(candidates), source: "default_non_tty", displayed: false, supportedEfforts: restricted ? candidates : undefined };
  }
  const current = currentEffortFor(target);
  const currentIndex = candidates.indexOf(current);
  const defaultIndex = candidates.indexOf(DEFAULT_EFFORT);
  const initialIndex = currentIndex >= 0 ? currentIndex : defaultIndex >= 0 ? defaultIndex : 0;
  const { item, cancelled } = await select({
    title: `Choose ${target} reasoning effort:`,
    items: candidates.map((value) => ({ label: value, value })),
    initialIndex,
    getTags: (it) => {
      const tags = [];
      if (it.value === DEFAULT_EFFORT) tags.push("default");
      if (it.value === current) tags.push("current");
      return tags;
    },
    input: inputStream,
    output: outputStream
  });
  if (cancelled) throw new Error(`${target} setup cancelled.`);
  const effort = isCodex
    ? resolveCodexEffort(item.value, supportedEfforts).resolvedEffort
    : item.value;
  return { effort, source: "prompt", displayed: true, supportedEfforts: restricted ? candidates : undefined };
}

export function formatEffortSelection({ target, effort, source, supportedEfforts }) {
  if (source === "explicit") return `Selected ${target} effort: ${effort}`;
  if (source === "prompt") return `Selected ${target} effort: ${effort}`;
  const restrictedEfforts = target === "Codex"
    ? normalizeCodexEffortCandidates(supportedEfforts)
    : normalizeEffortCandidates(supportedEfforts);
  const restricted = restrictedEfforts.length > 0;
  return `No interactive terminal detected; selected ${target} effort: ${effort}. Pass --effort ${effortUsage(target, restrictedEfforts, restricted)} to choose a different effort.`;
}
