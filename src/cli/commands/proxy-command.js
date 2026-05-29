import { loadConfig } from "../../shared/config.js";
import { disableUpstreamProxy, enableUpstreamProxy, probeEgress, upstreamProxyState } from "../../upstream/fetch.js";
import { redactProxyEndpoint, redactProxySource } from "../../upstream/proxy-config.js";
import { runProbe } from "../probe.js";
import { formatEgress } from "../output.js";

async function proxyRouteSummary() {
  try {
    const report = await runProbe();
    if (!report.ok) return { ok: false, error: JSON.stringify(report.error) };
    return {
      ok: true,
      models: report.models.length,
      responses: report.summary.responses,
      responsesWebSocket: report.summary.websocketResponses,
      messages: report.summary.messages,
      chat: report.summary.chat
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function proxyStatus({ includeRoutes = true } = {}) {
  const state = upstreamProxyState(loadConfig());
  const egress = await probeEgress({ endpoint: state.endpoint });
  return {
    schema: "aerial.proxy-status.v1",
    mode: state.mode,
    enabled: state.enabled,
    endpoint: state.endpoint,
    source: state.source,
    egress,
    routes: includeRoutes ? await proxyRouteSummary() : undefined
  };
}

function publicProxyCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return candidate;
  return {
    ...candidate,
    endpoint: redactProxyEndpoint(candidate.endpoint),
    source: redactProxySource(candidate.source)
  };
}

function publicProxyStatus(status) {
  if (!status || typeof status !== "object") return status;
  return {
    ...status,
    endpoint: redactProxyEndpoint(status.endpoint),
    source: redactProxySource(status.source)
  };
}

function publicProxyEnableResult(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    selected: publicProxyCandidate(result.selected),
    candidates: Array.isArray(result.candidates) ? result.candidates.map(publicProxyCandidate) : result.candidates,
    status: publicProxyStatus(result.status)
  };
}

function printProxyStatus(status) {
  const safeStatus = publicProxyStatus(status);
  console.log(`proxy: ${status.enabled ? `enabled (${status.mode})` : "disabled"}`);
  console.log(`endpoint: ${status.enabled ? `${safeStatus.endpoint} (${safeStatus.source})` : "direct"}`);
  console.log(`egress: ${formatEgress(status.egress)}`);
  if (status.routes) {
    if (status.routes.ok) {
      console.log(`copilot routes: responses=${status.routes.responses}, responsesWebSocket=${status.routes.responsesWebSocket}, messages=${status.routes.messages}, chat=${status.routes.chat}`);
    } else {
      console.log(`copilot routes: unavailable (${status.routes.error})`);
    }
  }
}

export async function runProxyCli(subcommand, rest) {
  const json = rest.includes("--json") || subcommand === "--json";
  if (!subcommand || subcommand === "status" || subcommand === "--json") {
    const status = await proxyStatus();
    if (json) console.log(JSON.stringify(publicProxyStatus(status), null, 2));
    else printProxyStatus(status);
    return;
  }
  if (subcommand === "enable") {
    const result = await enableUpstreamProxy();
    if (!result.ok) {
      if (json) console.log(JSON.stringify(publicProxyEnableResult(result), null, 2));
      else {
        console.error(`Proxy enable failed: ${result.error}`);
        if (result.candidates?.length) {
          console.error(`Checked: ${result.candidates.map((c) => redactProxyEndpoint(c.endpoint)).join(", ")}`);
        }
      }
      process.exitCode = 1;
      return;
    }
    const status = await proxyStatus();
    if (json) console.log(JSON.stringify(publicProxyEnableResult({ ...result, status }), null, 2));
    else {
      console.log(`Proxy enabled: ${redactProxyEndpoint(result.selected.endpoint)} (${redactProxySource(result.selected.source)})`);
      printProxyStatus(status);
    }
    return;
  }
  if (subcommand === "disable") {
    disableUpstreamProxy();
    const status = await proxyStatus();
    if (json) console.log(JSON.stringify(publicProxyStatus(status), null, 2));
    else {
      console.log("Proxy disabled.");
      printProxyStatus(status);
    }
    return;
  }
  throw new Error("Usage: aerial proxy status|enable|disable [--json]");
}
