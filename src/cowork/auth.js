import fs from "node:fs";
import { fork } from "node:child_process";
import { waitForPromise } from "../shared/abort.js";
import { coworkError, requireAuthorizedProfile, requireCoworkRuntime, validateProfile } from "./profile.js";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sameId = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
const sameIdentity = (left, right) => left && right && sameId(left.tenantId, right.tenantId) && sameId(left.objectId, right.objectId);

export function tokenLease(bearer, profile, { now = Date.now(), expectedIdentity } = {}) {
  let claims;
  try { claims = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString("utf8")); }
  catch { throw coworkError("AUTH_INVALID_TOKEN", "WAM returned an unreadable access token."); }
  // The token comes directly from WAM; this checks its routing and identity.
  // Signature validation remains the responsibility of the upstream resource.
  if (!sameId(claims.aud, profile.resourceId) || !sameId(claims.azp || claims.appid, profile.clientId)
    || !String(claims.scp || "").split(" ").includes("access_as_user")) throw coworkError("AUTH_INVALID_TOKEN", "WAM returned a token for a different client, resource, or scope.");
  if (!UUID.test(claims.tid || "") || !UUID.test(claims.oid || "") || !Number.isFinite(claims.exp)
    || claims.exp * 1000 <= now + 30_000) throw coworkError("AUTH_INVALID_TOKEN", "WAM returned an expired token or a token without the required identity.");
  const identity = { tenantId: claims.tid, objectId: claims.oid };
  if ((profile.tenantId && profile.tenantId !== "organizations" && !sameId(profile.tenantId, identity.tenantId))
    || (expectedIdentity && !sameIdentity(expectedIdentity, identity))) throw coworkError("ACCOUNT_CHANGED", "The Cowork account or resource tenant changed. Run explicit Cowork authentication to select an identity.", { statusCode: 401 });
  return { bearer, expiresAt: claims.exp * 1000, identity };
}

function sanitizeAuthenticationRecord(record, profile) {
  if (!record || record.authority !== "login.microsoftonline.com" || !sameId(record.clientId, profile.clientId)
    || !UUID.test(record.tenantId || "") || typeof record.homeAccountId !== "string"
    || !record.homeAccountId || typeof record.username !== "string" || record.version !== "1.0") throw coworkError("AUTH_INVALID_RECORD", "WAM returned invalid account metadata.");
  return Object.fromEntries(["authority", "homeAccountId", "clientId", "tenantId", "username", "version"].map((key) => [key, record[key]]));
}

export function sanitizeAccountMetadata(value, profile) {
  if (!value || value.version !== 1 || !sameId(value.clientId, profile.clientId) || !sameId(value.resourceId, profile.resourceId)
    || !UUID.test(value.identity?.tenantId || "") || !UUID.test(value.identity?.objectId || "")) throw coworkError("AUTH_INVALID_RECORD", "Saved Cowork identity metadata is invalid. Run explicit Cowork authentication.", { statusCode: 401 });
  const authenticationRecord = sanitizeAuthenticationRecord(value.authenticationRecord, profile);
  if (!sameId(authenticationRecord.tenantId, value.identity.tenantId)) throw coworkError("AUTH_INVALID_RECORD", "The saved WAM account and Cowork resource tenant do not match.");
  return {
    version: 1, clientId: profile.clientId, resourceId: profile.resourceId,
    identity: { tenantId: value.identity.tenantId, objectId: value.identity.objectId }, authenticationRecord
  };
}

async function loadAccount(profile) {
  if (!profile.accountFile) throw coworkError("INVALID_PROFILE", "Configure an accountFile for Cowork WAM metadata.", { statusCode: 400 });
  let raw;
  try {
    const stat = fs.lstatSync(profile.accountFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw coworkError("AUTH_INVALID_RECORD", "Cowork account metadata must be a bounded regular file.", { statusCode: 401 });
    raw = fs.readFileSync(profile.accountFile, "utf8");
  }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw coworkError("AUTH_INVALID_RECORD", "Unable to read Cowork account metadata.", { statusCode: 401 });
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw coworkError("AUTH_INVALID_RECORD", "Saved Cowork account metadata is not valid JSON.", { statusCode: 401 }); }
  return sanitizeAccountMetadata(value, profile);
}

async function persistAccount(profile, account) {
  const { writePrivateJson } = await import("./private-files.js");
  writePrivateJson(profile.accountFile, sanitizeAccountMetadata(account, profile));
}

export function runWamHelper(options, { spawnChild = fork, timeoutMs = options.interactive ? 300_000 : 60_000, platform = process.platform, nodeVersion = process.versions.node } = {}) {
  requireCoworkRuntime({ platform, nodeVersion });
  const { signal, ...request } = options;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let settled = false;
    let closing = false;
    let outcome;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    const complete = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (outcome?.error) reject(outcome.error); else resolve(outcome?.value);
    };
    const finish = (error, value) => {
      if (closing || settled) return;
      closing = true;
      outcome = { error, value };
      cleanup();
      if (!child?.pid) { complete(); return; }
      child.kill();
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        outcome = { error: coworkError("AUTH_HELPER_FAILED", "The Cowork WAM helper did not exit after shutdown was requested.") };
        complete();
      }, 3000);
    };
    const abort = () => finish(signal.reason || coworkError("AUTH_REQUIRED", "Cowork authentication was canceled.", { statusCode: 401 }));
    try {
      child = spawnChild(new URL("./wam-helper.js", import.meta.url), [], {
        execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, AZURE_LOG_LEVEL: "" }
      });
    } catch { reject(coworkError("AUTH_HELPER_FAILED", "Unable to start the Cowork WAM helper.")); return; }
    child.once("close", () => {
      if (!closing) outcome = { error: coworkError("AUTH_HELPER_FAILED", "The Cowork WAM helper exited before authentication completed.") };
      complete();
    });
    child.once("error", () => finish(coworkError("AUTH_HELPER_FAILED", "Unable to start or communicate with the Cowork WAM helper.")));
    child.once("message", (result) => {
      if (result?.type === "token" && typeof result.bearer === "string") finish(undefined, result);
      else {
        const code = result?.code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : result?.code === "AUTH_DEPENDENCIES_MISSING" ? "AUTH_DEPENDENCIES_MISSING" : "AUTH_DENIED";
        const detail = /^AADSTS\d+$/.test(result?.detail || "") ? ` (${result.detail})` : "";
        finish(coworkError(code, code === "AUTH_DEPENDENCIES_MISSING" ? "Cowork WAM dependencies are unavailable. Reinstall Aerial with optional dependencies enabled." : `Cowork WAM authentication failed${detail}. Run explicit Cowork authentication if interaction is required.`, { statusCode: 401 }));
      }
    });
    timer = setTimeout(() => finish(coworkError("AUTH_REQUIRED", "Cowork WAM authentication timed out.", { statusCode: 401 })), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.send(request, (error) => { if (error) finish(coworkError("AUTH_HELPER_FAILED", "Unable to contact the Cowork WAM helper.")); });
  });
}

export function createAuthSession({ profile: input, interactive = false, acquire = runWamHelper, readAccount = loadAccount, writeAccount = persistAccount, now = Date.now } = {}) {
  const profile = validateProfile(input);
  requireAuthorizedProfile(profile);
  const lifetime = new AbortController();
  let cached;
  let account;
  let pending;
  let closePromise;
  let allowInteraction = interactive;
  const getToken = async ({ signal } = {}) => {
    signal?.throwIfAborted();
    lifetime.signal.throwIfAborted();
    if (cached && cached.expiresAt > now() + 120_000) return cached;
    if (!pending) {
      pending = (async () => {
        const useInteraction = allowInteraction;
        allowInteraction = false;
        if (!account && !useInteraction) account = await readAccount(profile);
        if (!account && !useInteraction) throw coworkError("AUTH_REQUIRED", "No Cowork identity has been selected. Run explicit Cowork authentication first.", { statusCode: 401 });
        const result = await acquire({
          profile: { clientId: profile.clientId, resourceId: profile.resourceId, scope: profile.scope, authorityHost: profile.authorityHost },
          tenantId: profile.tenantId || account?.identity.tenantId || "organizations",
          authenticationRecord: useInteraction ? undefined : account?.authenticationRecord,
          interactive: useInteraction, signal: lifetime.signal
        });
        const lease = tokenLease(result.bearer, profile, { now: now(), expectedIdentity: cached?.identity || (useInteraction ? undefined : account?.identity) });
        const nextAccount = sanitizeAccountMetadata({ version: 1, clientId: profile.clientId, resourceId: profile.resourceId,
          identity: lease.identity, authenticationRecord: result.authenticationRecord }, profile);
        lifetime.signal.throwIfAborted();
        await writeAccount(profile, nextAccount);
        lifetime.signal.throwIfAborted();
        account = nextAccount;
        cached = lease;
        return lease;
      })().finally(() => { pending = undefined; });
    }
    return waitForPromise(pending, signal);
  };
  return {
    getToken,
    close() {
      closePromise ||= (async () => {
        lifetime.abort();
        // The profile lock must outlive helper teardown and any account write.
        await pending?.catch(() => {});
        cached = undefined;
      })();
      return closePromise;
    }
  };
}

export async function authenticate(profile, { interactive = false, signal, ...dependencies } = {}) {
  const session = createAuthSession({ profile, interactive, ...dependencies });
  try {
    const { identity, expiresAt } = await session.getToken({ signal });
    return { identity, expiresAt };
  } finally { await session.close(); }
}
