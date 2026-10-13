// Real OS integration, invoked separately from unit tests. All service names,
// files, ports, and credentials are isolated from the user's Aerial instance.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";

if (!["darwin", "win32"].includes(process.platform)) {
  console.log("Native service smoke: no built-in manager on this platform.");
  process.exit(0);
}
const repo = fileURLToPath(new URL("../", import.meta.url));
const parent = path.join(repo, ".tmp-native-service");
fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, "smoke-"));
fs.cpSync(path.join(repo, "src"), path.join(root, "src"), { recursive: true });
fs.copyFileSync(path.join(repo, "package.json"), path.join(root, "package.json"));
const suffix = `${process.pid}${Date.now()}`;
const name = `AerialReviewSmoke${suffix}`;
const label = `com.jiayunxie.aerial.review${suffix}`;
const renderer = path.join(root, "src/service/wrapper-render.js");
const source = fs.readFileSync(renderer, "utf8");
assert.ok(source.includes('export const WIN_TASK_NAME = "AerialLocalProxy";'));
assert.ok(source.includes('export const SERVICE_LABEL = "com.jiayunxie.aerial";'));
fs.writeFileSync(renderer, source.replace('export const WIN_TASK_NAME = "AerialLocalProxy";', `export const WIN_TASK_NAME = "${name}";`)
  .replace('export const SERVICE_LABEL = "com.jiayunxie.aerial";', `export const SERVICE_LABEL = "${label}";`));
for (const key of Object.keys(process.env)) {
  if (key.startsWith("AERIAL_")) delete process.env[key];
}
// Together with the launcher path this exceeds schtasks /TR's old limit.
process.env.AERIAL_CONFIG_DIR = path.join(root, "long configuration path O'Hara 测试", "config");
process.env.AERIAL_SKIP_ENV_PERSIST = "1";
process.env.AERIAL_LOG_FILE = path.join(root, "smoke.log");
const service = await import(pathToFileURL(path.join(root, "src/service/index.js")));
assert.equal(service._internal.WIN_TASK_NAME, name);
assert.equal(service._internal.SERVICE_LABEL, label);
assert.notEqual(name, "AerialLocalProxy");
assert.notEqual(label, "com.jiayunxie.aerial");
const { loadConfig, saveConfig } = await import(pathToFileURL(path.join(root, "src/shared/config.js")));
const listener = net.createServer().listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
saveConfig({ ...loadConfig(), port });
const check = (step, result) => {
  console.log(JSON.stringify({ step, name, label, port, ok: result.ok, reason: result.reason }));
  assert.equal(result.ok, true, JSON.stringify(result));
};
const healthy = async step => {
  const status = await service.serviceStatus();
  check(step, status);
  assert.equal(status.health.supervisor, "service-managed");
};
try {
  check("install", await service.serviceInstall({ healthDeadlineMs: 30000 }));
  await healthy("installed health");
  const refreshed = await service.serviceInstall();
  check("refresh", refreshed);
  assert.equal(refreshed.definitionUpdated, true);
  check("stop", service.serviceStop());
  const down = await service.serviceStatus();
  assert.notEqual(down.health.aerial, true);
  assert.equal(down.service.loaded, false);
  check("stop again", service.serviceStop());
  check("start", await service.serviceStart({ healthDeadlineMs: 30000 }));
  check("restart", await service.serviceRestart({ healthDeadlineMs: 30000 }));
  await healthy("restarted health");
} finally {
  check("uninstall", service.serviceUninstall());
  const absent = await service.serviceStatus();
  assert.equal(absent.service.installed, false);
  assert.notEqual(absent.health.aerial, true);
  // Verify the resolved target before recursively deleting our unique copy.
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(parent));
  fs.rmSync(root, { recursive: true, force: true });
  console.log("Native service smoke: cleanup verified.");
}
