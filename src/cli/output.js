export function printSetupCompletionSummary({ heading, cli, model, effort, proxy, configFile, aerialConfigFile, aerialDefaultEffort, backup, auth, notes = [] }) {
  console.log(heading);
  console.log(`  cli: ${cli}`);
  console.log(`  model: ${model}`);
  console.log(`  effort: ${effort}`);
  console.log(`  proxy: ${proxy}`);
  console.log(`  client config: ${configFile}`);
  console.log(`  aerial config: ${aerialConfigFile}`);
  console.log(`  aerial defaultEffort: ${aerialDefaultEffort}`);
  console.log(`  backup: ${backup || "none"}`);
  console.log(`  auth: ${auth}`);
  for (const note of notes) console.log(`  note: ${note}`);
}

export function printSetupSummary(status) {
  console.log("clients:");
  for (const client of Object.values(status.clients)) {
    const model = client.model ? ` model=${client.model}` : "";
    const effort = ` effort=${client.effort || "missing"}`;
    console.log(`  ${client.target}: ${client.state}${model}${effort}`);
    if (client.migration) console.log(`    migration: ${client.migration}`);
  }
  console.log(`api key: ${status.auth.api_key.exists ? "present" : "missing"}`);
  const ghSource = status.auth.github_token.source;
  const ghText = ghSource === "missing" ? "missing" : `present (${ghSource})`;
  console.log(`github login: ${ghText}`);
}

export function printServiceSummary(status) {
  console.log(`service: ${status.summary}`);
  if (status.supported === false) {
    console.log(`platform: ${status.platform} (service unsupported)`);
    return;
  }
  const health = status.health?.aerial ? `ok (${status.health.supervisor})`
    : status.health?.portConflict ? `port conflict (${status.health.conflictReason})`
    : status.health?.ok ? "ok"
    : `unreachable (${status.health?.error || `http ${status.health?.status}`})`;
  console.log(`health: ${health}`);
}

export function printRestoreResults(results) {
  for (const r of Object.values(results)) {
    if (r.restored) {
      console.log(`Restored ${r.target}: ${r.file} <- ${r.from}`);
      if (r.snapshot) console.log(`  pre-restore snapshot: ${r.snapshot}`);
    } else if (r.reason === "no_backup") {
      console.log(`Restored ${r.target}: no backup to restore`);
    } else if (r.error) {
      console.log(`Restored ${r.target}: FAILED  ${r.error}`);
    }
  }
}

export function printServiceDiagnostics(diagnostics) {
  if (!diagnostics) return;
  if (diagnostics.stdioLog) console.log(`  stdio log: ${diagnostics.stdioLog}`);
  if (diagnostics.aerialLog) console.log(`  aerial log: ${diagnostics.aerialLog}`);
  if (diagnostics.wrapperNode) console.log(`  wrapper node: ${diagnostics.wrapperNode}`);
  if (diagnostics.health) {
    const h = diagnostics.health;
    const tail = h.lastError ? `, last error: ${h.lastError}` : (h.lastStatus !== undefined ? `, last status: ${h.lastStatus}` : "");
    console.log(`  health probe: ${h.attempts} attempts over ${h.elapsedMs}ms${tail}`);
  }
  console.log("  Run: aerial service status --json");
}

export function printServiceWarning(result) {
  if (result.warning) console.log(`  WARNING: ${result.warning.message}`);
}

export function formatEgress(egress) {
  if (!egress?.ok) return `unavailable (${egress?.error || "unknown"})`;
  const place = [egress.city, egress.region, egress.country].filter(Boolean).join(", ");
  return [egress.ip, place].filter(Boolean).join("  ");
}
