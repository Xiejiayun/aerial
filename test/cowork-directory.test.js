import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { coworkDirectory } from "../src/cowork/index.js";

function withDirectoryEnvironment(environment, run) {
  const keys = ["AERIAL_COWORK_CONFIG_DIR", "AERIAL_CONFIG_DIR", "LOCALAPPDATA"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (environment[key] === undefined) delete process.env[key];
      else process.env[key] = environment[key];
    }
    return run();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("Cowork-specific configuration takes precedence over the shared Aerial directory", () => {
  const selected = path.join("relative profiles", "cowork-specific");
  withDirectoryEnvironment({
    AERIAL_COWORK_CONFIG_DIR: selected,
    AERIAL_CONFIG_DIR: "other-config",
    LOCALAPPDATA: "other-appdata"
  }, () => assert.equal(coworkDirectory(), path.resolve(selected)));
});

test("Cowork uses a subdirectory of an explicit Aerial configuration when its own override is blank", () => {
  const selected = path.join("relative profiles", "aerial");
  for (const coworkOverride of [undefined, "", " \t"]) {
    withDirectoryEnvironment({
      AERIAL_COWORK_CONFIG_DIR: coworkOverride,
      AERIAL_CONFIG_DIR: selected,
      LOCALAPPDATA: "other-appdata"
    }, () => assert.equal(coworkDirectory(), path.join(path.resolve(selected), "cowork")));
  }
});

test("Cowork defaults to the same user-home directory across normal and packaged AppData environments", () => {
  const expected = path.join(os.homedir(), ".aerial", "cowork");
  const localAppDataPaths = [
    undefined,
    path.join(os.homedir(), "AppData", "Local"),
    path.join(os.homedir(), "AppData", "Local", "Packages", "OpenAI.Codex_test", "LocalCache", "Local")
  ];
  for (const localAppData of localAppDataPaths) {
    withDirectoryEnvironment({ LOCALAPPDATA: localAppData }, () => {
      assert.equal(coworkDirectory(), expected);
    });
  }
});

test("Cowork uses its default when both configuration overrides contain only whitespace", () => {
  withDirectoryEnvironment({ AERIAL_COWORK_CONFIG_DIR: " \t", AERIAL_CONFIG_DIR: " \t" }, () => {
    assert.equal(coworkDirectory(), path.join(os.homedir(), ".aerial", "cowork"));
  });
});
