import test from "node:test";
import assert from "node:assert/strict";
import { pickRecommended, formatModelChoices, formatEffortSelection } from "../src/cli/select.js";
import { requestFailure } from "../src/cli/errors.js";

test("Claude choices are deterministic without a GPT fallback or an invented recommendation", () => {
  const choices = [{ id: "claude-sonnet-4.6" }, { id: "claude-opus-4.7" }];
  const picked = pickRecommended(choices, "Claude Code");
  assert.equal(picked.recommended, undefined);
  assert.equal(picked.source, "first_available");
  assert.deepEqual(picked.ranked.map(item => item.id), ["claude-opus-4.7", "claude-sonnet-4.6"]);
  const text = formatModelChoices({ target: "Claude Code", route: "messages", choices: picked.ranked, selectedModel: picked.ranked[0].id, source: picked.source }).join("\n");
  assert.doesNotMatch(text, /gpt-N|recommended/);
});

test("effort output explains the requested-to-effective change", () => {
  const text = formatEffortSelection({ target: "Claude Code", effort: "xhigh", requestedEffort: "max", reason: "max_is_session_only", source: "explicit" });
  assert.match(text, /max -> xhigh/);
  assert.match(text, /claude --effort max/);
});

test("model failures distinguish authentication, access, network and missing routes", () => {
  const forbidden = requestFailure("Models", 403, { error: { message: "Copilot access denied" } }).message;
  assert.match(forbidden, /Copilot access denied/);
  assert.match(forbidden, /subscription.*permissions/);
  assert.doesNotMatch(forbidden, /\[object Object\]|login --force/);
  assert.match(requestFailure("Models", 401, {}).message, /login --force/);
  assert.match(requestFailure("Models", undefined, new Error("fetch failed")).message, /network connection/);
  assert.match(requestFailure("Inference", 404, {}).message, /required route/);
  assert.match(requestFailure("Inference", 401, {}, { localAuth: true }).message, /local key.*service restart/);
});
