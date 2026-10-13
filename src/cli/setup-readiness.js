import { spawnSync } from "node:child_process";
import { ensureApiKey, loadConfig } from "../shared/config.js";
import { codexAuthCommand } from "../setup/auth-helper.js";
import { localBaseUrl } from "../shared/urls.js";
import { readJsonSafely } from "../shared/utils.js";
import { errorDetail, requestFailure } from "./errors.js";

export async function verifySetupReadiness({ route, model, effort, fetchImpl = globalThis.fetch, run = spawnSync, platform = process.platform } = {}) {
  const config = loadConfig();
  const base = localBaseUrl(config);
  let health;
  try {
    const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    health = await readJsonSafely(response);
    if (!response.ok || health?.service !== "aerial" || health?.ok !== true) throw new Error("The configured port is not serving a healthy Aerial proxy.");
  } catch (error) {
    const start = ["win32", "darwin"].includes(platform) ? "aerial service install" : "aerial start in another terminal";
    throw new Error(`Aerial is not ready at ${base}: ${errorDetail(error)}\nRun ${start}, then rerun setup. Client configuration was not changed. Use --configure-only with --model only for deliberate offline configuration.`);
  }
  ensureApiKey();
  const helper = codexAuthCommand();
  const keyResult = run(helper.command, helper.args, { encoding: "utf8", windowsHide: true, timeout: helper.timeout_ms, env: process.env });
  const key = keyResult.stdout?.trim();
  if (keyResult.status !== 0 || !key) throw new Error("The generated Aerial key helper failed. Run aerial key generate and retry setup. Client configuration was not changed.");
  const messages = route === "messages";
  const payload = messages
    ? { model, max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }], ...(effort ? { thinking: { type: "adaptive" }, output_config: { effort } } : {}) }
    : { model, input: "Reply with OK.", max_output_tokens: 16, store: false, ...(effort ? { reasoning: { effort } } : {}) };
  let response, body;
  try {
    response = await fetchImpl(`${base}/v1/${messages ? "messages" : "responses"}`, {
      method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...(messages ? { "anthropic-version": "2023-06-01" } : {}) },
      body: JSON.stringify(payload)
    });
    body = await readJsonSafely(response);
  } catch (error) {
    throw requestFailure("Setup route verification failed; client configuration was not changed", undefined, error);
  }
  if (!response.ok || body?.error || body?.status === "failed") {
    const localAuth = response.status === 401 && /Aerial API key/i.test(errorDetail(body));
    throw requestFailure("Setup route verification failed; client configuration was not changed", response.status, body, { localAuth });
  }
  if (messages ? body?.type !== "message" || !Array.isArray(body?.content) : body?.object !== "response" || !Array.isArray(body?.output)) {
    throw new Error("Setup route verification received an invalid API response. Run aerial service install and aerial service restart, then retry. Client configuration was not changed.");
  }
  return { verified: true, localProxy: true, authHelper: true, upstreamRoute: route, model };
}
