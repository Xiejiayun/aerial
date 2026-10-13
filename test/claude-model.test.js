import test from "node:test";
import assert from "node:assert/strict";
import { claudeNativeModel, claudeSetupEfforts, resolveClaudeSetupEffort, claudeSavedEffort } from "../src/setup/claude-model.js";

test("Copilot Claude versions map to native identities without selecting an upstream model", () => {
  assert.equal(claudeNativeModel("claude-opus-4.7"), "claude-opus-4-7");
  assert.equal(claudeNativeModel("claude-opus-4.7-fast"), "claude-opus-4-7");
  assert.equal(claudeNativeModel("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5-20250929");
  assert.equal(claudeNativeModel("custom-deployment"), undefined);
});

test("setup effort is the intersection of persistent client levels and catalog support", () => {
  assert.deepEqual(claudeSetupEfforts("claude-opus-4.7", ["medium", "high", "max"]), ["medium", "high"]);
  assert.deepEqual(claudeSetupEfforts("claude-opus-4.6", ["low", "xhigh", "max"]), ["low"]);
  assert.deepEqual(claudeSetupEfforts("claude-sonnet-4.5", ["medium"]), []);
  assert.deepEqual(claudeSetupEfforts("custom", ["medium"]), []);
  assert.equal(resolveClaudeSetupEffort("max", "claude-opus-4.7").resolvedEffort, "xhigh");
  assert.equal(resolveClaudeSetupEffort("max", "claude-opus-4.7", ["medium", "high", "max"]).resolvedEffort, "high");
  assert.equal(resolveClaudeSetupEffort("xhigh", "claude-opus-4.6").resolvedEffort, "high");
  assert.equal(resolveClaudeSetupEffort("ultracode", "claude-opus-4.7").reason, "ultracode_is_workflow_mode");
  assert.throws(() => resolveClaudeSetupEffort("high", "custom"), /no verified overlap/);
});

test("status reads per-model effort and never labels proxy fallback as the client setting", () => {
  assert.equal(claudeSavedEffort({}).effort, "missing");
  assert.equal(claudeSavedEffort({ effortLevel: "max" }).effort, "missing");
  assert.deepEqual(claudeSavedEffort({ model: "claude-opus-4-7", effortLevel: "high", modelSettings: { "claude-opus-4-7": { effortLevel: "low" } } }), { effort: "low", effortSource: "modelSettings" });
  assert.equal(claudeSavedEffort({ model: "claude-opus-5-5", effortLevel: "high" }).effort, "missing");
});
