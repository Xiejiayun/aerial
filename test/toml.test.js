import test from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";
import { setTomlRootString, upsertTomlSection, removeTomlSection } from "../src/setup/toml.js";
const plain = value => JSON.parse(JSON.stringify(value));

test("quoted keys and multiline string contents are updated by syntax ranges", () => {
  const original = `# root comment\n"model" = "old" # keep this comment\nprompt = '''\n[model_providers.aerial]\nmodel = "inside a prompt"\n'''\n[projects.'space . name']\ntrust_level = "trusted"\n`;
  const next = setTomlRootString(original, "model", "new");
  assert.equal(parse(next).model, "new");
  assert.equal(parse(next).prompt, parse(original).prompt);
  assert.match(next, /"model" = "new" # keep this comment/);
  assert.ok(next.includes("[projects.'space . name']\ntrust_level = \"trusted\""));
});

test("equivalent quoted/spaced section paths and descendants are replaced once", () => {
  const original = `[ model_providers . 'aerial' ] # old\nbase_url = "old"\n["model_providers".aerial.auth]\ncommand = "old"\n# unrelated provider\n[model_providers.other]\nbase_url = "other"\n`;
  const next = upsertTomlSection(original, "model_providers.aerial", { base_url: "new", auth: { command: "new" } });
  assert.deepEqual(plain(parse(next).model_providers.aerial), { base_url: "new", auth: { command: "new" } });
  assert.ok(next.includes('# unrelated provider\n[model_providers.other]\nbase_url = "other"'));
});

test("inline and dotted table declarations preserve unrelated siblings", () => {
  for (const original of [
    'model_providers = { other = { name = "keep" }, aerial = { name = "old" } }\n',
    'model_providers.other.name = "keep"\nmodel_providers.aerial.name = "old"\n',
    '[model_providers]\nother = { name = "keep" }\naerial = { name = "old" }\n'
  ]) {
    const next = upsertTomlSection(original, "model_providers.aerial", { name: "new", auth: { args: ["key", "print"] } });
    assert.deepEqual(plain(parse(next).model_providers), { other: { name: "keep" }, aerial: { name: "new", auth: { args: ["key", "print"] } } });
    assert.deepEqual(plain(parse(removeTomlSection(next, "model_providers.aerial")).model_providers), { other: { name: "keep" } });
  }
});

test("profile removal does not parse string contents or quoted dots as sections", () => {
  const original = `[profiles."aerial.other"]\nmodel = "keep"\n[ profiles . 'aerial' ]\nmodel = '''\n[profiles.work]\n'''\n[profiles.aerial.nested]\nx = 1\n[profiles.work]\nmodel = "keep too"\n`;
  const next = removeTomlSection(original, "profiles.aerial");
  assert.deepEqual(plain(parse(next).profiles), { "aerial.other": { model: "keep" }, work: { model: "keep too" } });
});
