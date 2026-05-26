import test from "node:test";
import assert from "node:assert/strict";

const {
  EFFORT_VALUES,
  DEFAULT_EFFORT,
  normalizeEffort,
  assertValidEffort,
  chooseSetupEffort,
  formatEffortSelection
} = await import("../src/cli/setup-selection.js");

test("EFFORT_VALUES and DEFAULT_EFFORT exposed and frozen", () => {
  assert.deepEqual([...EFFORT_VALUES], ["low", "medium", "high", "xhigh"]);
  assert.equal(DEFAULT_EFFORT, "medium");
  assert.throws(() => EFFORT_VALUES.push("max"));
});

test("normalizeEffort accepts canonical values", () => {
  for (const value of ["low", "medium", "high", "xhigh"]) {
    assert.equal(normalizeEffort(value), value);
    assert.equal(normalizeEffort(value.toUpperCase()), value);
    assert.equal(normalizeEffort(`  ${value}  `), value);
  }
});

test("normalizeEffort aliases 'max' to 'xhigh'", () => {
  assert.equal(normalizeEffort("max"), "xhigh");
  assert.equal(normalizeEffort("MAX"), "xhigh");
});

test("normalizeEffort returns undefined for invalid input", () => {
  assert.equal(normalizeEffort("turbo"), undefined);
  assert.equal(normalizeEffort(""), undefined);
  assert.equal(normalizeEffort("   "), undefined);
  assert.equal(normalizeEffort(undefined), undefined);
  assert.equal(normalizeEffort(null), undefined);
});

test("assertValidEffort throws with allowed values listed", () => {
  assert.throws(() => assertValidEffort("turbo"), /Invalid --effort/);
  assert.throws(() => assertValidEffort("turbo"), /low, medium, high, xhigh/);
  assert.throws(() => assertValidEffort("turbo"), /max/);
});

test("assertValidEffort returns normalized for valid input including max", () => {
  assert.equal(assertValidEffort("medium"), "medium");
  assert.equal(assertValidEffort("MAX"), "xhigh");
  assert.equal(assertValidEffort("max"), "xhigh");
});

test("chooseSetupEffort respects explicit effort without prompting", async () => {
  const result = await chooseSetupEffort({ target: "Codex", explicitEffort: "high", prompt: true });
  assert.equal(result.effort, "high");
  assert.equal(result.source, "explicit");
  assert.equal(result.displayed, false);
});

test("chooseSetupEffort normalizes explicit max -> xhigh", async () => {
  const result = await chooseSetupEffort({ target: "Codex", explicitEffort: "max", prompt: true });
  assert.equal(result.effort, "xhigh");
  assert.equal(result.source, "explicit");
});

test("chooseSetupEffort rejects invalid explicit effort", async () => {
  await assert.rejects(
    () => chooseSetupEffort({ target: "Codex", explicitEffort: "turbo", prompt: true }),
    /Invalid --effort/
  );
});

test("chooseSetupEffort returns default medium under non-TTY", async () => {
  const result = await chooseSetupEffort({ target: "Codex", prompt: false });
  assert.equal(result.effort, "medium");
  assert.equal(result.source, "default_non_tty");
  assert.equal(result.displayed, false);
});

test("formatEffortSelection differentiates non-TTY default", () => {
  const explicit = formatEffortSelection({ target: "Codex", effort: "high", source: "explicit" });
  const prompt = formatEffortSelection({ target: "Codex", effort: "low", source: "prompt" });
  const nonTty = formatEffortSelection({ target: "Codex", effort: "medium", source: "default_non_tty" });
  assert.match(explicit, /Selected Codex effort: high/);
  assert.match(prompt, /Selected Codex effort: low/);
  assert.match(nonTty, /No interactive terminal/);
  assert.match(nonTty, /--effort <low\|medium\|high\|xhigh\|max>/);
});

import { PassThrough, Writable } from "node:stream";

function fakeStreams(stdinText) {
  const inputStream = new PassThrough();
  inputStream.isTTY = true;
  setImmediate(() => {
    inputStream.write(stdinText);
    inputStream.end();
  });
  const chunks = [];
  const outputStream = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); }
  });
  outputStream.isTTY = true;
  return { inputStream, outputStream, getOutput: () => chunks.join("") };
}

test("chooseSetupEffort TTY: Enter selects default medium", async () => {
  const { inputStream, outputStream, getOutput } = fakeStreams("\n");
  const result = await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  assert.equal(result.effort, "medium");
  assert.equal(result.source, "prompt");
  assert.equal(result.displayed, true);
  const text = getOutput();
  assert.match(text, /Choose Codex reasoning effort/);
  assert.match(text, /2\. medium  \(default\)/);
});

test("chooseSetupEffort TTY: invalid input loops, then accepts valid", async () => {
  const inputStream = new PassThrough();
  inputStream.isTTY = true;
  const chunks = [];
  const outputStream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      const text = chunks.join("");
      if (/Enter a number from 1 to 4/.test(text) && !chunks._fed) {
        chunks._fed = true;
        setImmediate(() => inputStream.write("3\n"));
      }
      cb();
    }
  });
  outputStream.isTTY = true;
  setImmediate(() => inputStream.write("9\n"));
  const result = await chooseSetupEffort({ target: "Codex", input: inputStream, output: outputStream });
  assert.equal(result.effort, "high");
  assert.equal(result.source, "prompt");
  assert.equal(result.displayed, true);
  assert.match(chunks.join(""), /Enter a number from 1 to 4, or press Enter for 2\./);
});

test("chooseSetupEffort TTY: choice 1 selects low and choice 4 selects xhigh", async () => {
  const a = fakeStreams("1\n");
  const aResult = await chooseSetupEffort({ target: "Codex", input: a.inputStream, output: a.outputStream });
  assert.equal(aResult.effort, "low");
  const b = fakeStreams("4\n");
  const bResult = await chooseSetupEffort({ target: "Codex", input: b.inputStream, output: b.outputStream });
  assert.equal(bResult.effort, "xhigh");
});
