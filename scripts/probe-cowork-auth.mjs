#!/usr/bin/env node
// Source-checkout diagnostic: one WAM acquisition and one read-only directory
// request. No browser credential extraction, inference, or alternate clients.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runWamHelper, tokenLease, sanitizeAccountMetadata } from "../src/cowork/auth.js";
import { coworkError, requireCoworkRuntime, validateProfile } from "../src/cowork/profile.js";
import { readCoworkModelCatalog } from "../src/cowork/transport.js";
import { ensurePrivateDirectory, writePrivateJson } from "../src/cowork/private-files.js";

export async function probeCoworkAuth(candidate, {
  signal, onProgress, acquire = runWamHelper, fetchImpl = fetch, save = async () => {},
  checkRuntime = requireCoworkRuntime, now = Date.now
} = {}) {
  checkRuntime();
  signal?.throwIfAborted();
  // Deliberately reconstruct an allowlist; callers cannot promote capabilities
  // or pass credentials/persistence paths through a candidate profile.
  const profile = validateProfile({
    version: 1, origin: candidate.origin, clientId: candidate.clientId,
    resourceId: candidate.resourceId, scope: candidate.scope,
    authorityHost: "https://login.microsoftonline.com", tenantId: candidate.tenantId,
    evidence: { source: "reference-only", observedAt: new Date(now()).toISOString() },
    capabilities: { connectorsDisabled: "unverified", completion: "unverified", eventCorrelation: "unverified", verifiedEfforts: [] }
  });
  const result = await acquire({
    profile: { clientId: profile.clientId, resourceId: profile.resourceId, scope: profile.scope, authorityHost: profile.authorityHost },
    tenantId: profile.tenantId || "organizations", interactive: true, signal,
    ...(onProgress ? { onProgress } : {})
  });
  signal?.throwIfAborted();
  const lease = tokenLease(result.bearer, profile, { now: now() });
  const account = sanitizeAccountMetadata({ version: 1, clientId: profile.clientId,
    resourceId: profile.resourceId, identity: lease.identity, authenticationRecord: result.authenticationRecord }, profile);
  const models = await readCoworkModelCatalog({ profile, lease, signal, fetchImpl });
  signal?.throwIfAborted();
  if (!models.length) throw coworkError("MODEL_UNAVAILABLE", "The Cowork model directory is empty.");
  const observedAt = new Date(now()).toISOString();
  const verifiedProfile = { ...profile, tenantId: lease.identity.tenantId,
    evidence: { source: "authorized-session", observedAt } };
  const report = {
    ok: true, origin: profile.origin, clientId: profile.clientId,
    resourceId: profile.resourceId, scope: profile.scope, observedAt,
    authMethod: "windows-wam", catalogAccepted: true, models, inferenceReady: false
  };
  // Only metadata reaches persistence, and only after the actual resource has
  // accepted the token and returned a valid directory. Bearer stays in memory.
  await save({ profile: verifiedProfile, account, report });
  return report;
}

export function saveProbeEvidence(directory, { profile, account, report }) {
  // A new isolated directory avoids overwriting existing identity/recovery data.
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  ensurePrivateDirectory(directory);
  writePrivateJson(path.join(directory, "account.json"), account);
  writePrivateJson(path.join(directory, "auth-evidence.json"), report);
  // Write the usable profile last. Inference flags remain unverified.
  writePrivateJson(path.join(directory, "profile.json"), profile);
}

export function publicProbeFailure(error) {
  const allowed = new Set(["AUTH_REQUIRED", "AUTH_DENIED", "AUTH_CANCELED", "AUTH_DEPENDENCIES_MISSING", "AUTH_HELPER_FAILED", "AUTH_INVALID_TOKEN",
    "AUTH_INVALID_RECORD", "ACCOUNT_CHANGED", "INVALID_PROFILE", "UNSUPPORTED_PLATFORM", "UNSUPPORTED_RUNTIME", "PROTOCOL_CHANGED",
    "UPSTREAM_UNAVAILABLE", "UPSTREAM_REJECTED", "MODEL_UNAVAILABLE"]);
  const code = allowed.has(error?.code) ? error.code : error?.name === "AbortError" || error?.name === "TimeoutError" ? "CANCELED_OR_TIMED_OUT" : "PROBE_FAILED";
  const aadsts = /\bAADSTS\d+\b/.exec(String(error?.message || ""))?.[0];
  // Never print arbitrary SDK/server messages, claims, account records, or bodies.
  return { ok: false, code, ...(aadsts ? { aadsts } : {}), inferenceReady: false };
}

async function main() {
  const { values } = parseArgs({ options: {
    origin: { type: "string" }, "client-id": { type: "string" }, "resource-id": { type: "string" },
    scope: { type: "string" }, "tenant-id": { type: "string" }, "output-dir": { type: "string" }
  } });
  const directory = values["output-dir"] ? path.resolve(values["output-dir"]) : undefined;
  if (directory && (fs.existsSync(directory) || !fs.statSync(path.dirname(directory)).isDirectory())) {
    throw new Error("Output must be a new directory with an existing parent.");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    process.stderr.write("Checking one candidate with Windows WAM. Complete any Microsoft sign-in prompt manually. Only GET /v1/models follows; no inference.\n");
    const report = await probeCoworkAuth({ origin: values.origin, clientId: values["client-id"],
      resourceId: values["resource-id"], scope: values.scope, tenantId: values["tenant-id"] }, {
      signal: controller.signal,
      onProgress: (stage) => process.stderr.write(`WAM: ${stage}\n`),
      ...(directory ? { save: (evidence) => saveProbeEvidence(directory, evidence) } : {})
    });
    process.stdout.write(`${JSON.stringify({ ...report, ...(directory ? { savedDirectory: directory } : {}) }, null, 2)}\n`);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(publicProbeFailure(error))}\n`);
    process.exitCode = 1;
  });
}
