const HEALTH_TIMEOUT_MS = 1500;
const HEALTH_START_TIMEOUT_MS = 5000;
const HEALTH_POLL_INTERVAL_MS = 250;

export async function defaultHealthFetch(host, port) {
  if (process.env.AERIAL_SERVICE_DRYRUN === "1") {
    return { ok: false, error: "dryrun" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: controller.signal });
    let body;
    let parseFailed = false;
    try {
      body = await res.json();
    } catch {
      parseFailed = true;
    }
    return { ok: res.ok, status: res.status, body, parseFailed };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export function classifyHealth(probe) {
  if (!probe || probe.error) return { mode: "absent" };
  if (probe.status !== 200) return { mode: "absent", httpStatus: probe.status };
  if (probe.parseFailed) return { mode: "port_conflict", reason: "health body is not JSON" };
  if (!probe.body || probe.body.service !== "aerial") {
    return { mode: "port_conflict", reason: "200 response but not Aerial" };
  }
  return { mode: "aerial_running", body: probe.body };
}

export async function pollForAerialUp(host, port, healthFetch, deadlineMs = HEALTH_START_TIMEOUT_MS) {
  const fetcher = healthFetch || defaultHealthFetch;
  const start = Date.now();
  let lastProbe;
  let lastCls;
  let attempts = 0;
  while (Date.now() - start < deadlineMs) {
    attempts += 1;
    lastProbe = await fetcher(host, port);
    lastCls = classifyHealth(lastProbe);
    if (lastCls.mode === "aerial_running" || lastCls.mode === "port_conflict") {
      return { cls: lastCls, probe: lastProbe, attempts, elapsedMs: Date.now() - start };
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return { cls: lastCls || { mode: "absent" }, probe: lastProbe, attempts, elapsedMs: Date.now() - start };
}
