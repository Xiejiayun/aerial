export function computeAppStatus(setup, service) {
  const githubTokenPresent = setup.auth.github_token.source !== "missing";
  const apiKeyPresent = setup.auth.api_key.exists;
  const hasAerialClient = setup.clients.codex.state === "aerial" || setup.clients.claude.state === "aerial";
  const serviceHealthy = service.supported !== false && service.health?.aerial === true;
  const ok = apiKeyPresent && githubTokenPresent && hasAerialClient && serviceHealthy;
  const nextSteps = [];
  const hints = [];
  if (!githubTokenPresent) nextSteps.push("run: aerial login");
  if (!hasAerialClient) nextSteps.push("run: aerial setup codex or aerial setup claude");
  if (hasAerialClient && !apiKeyPresent) nextSteps.push("run: aerial setup codex or aerial setup claude to recreate the local Aerial key");
  if (service.supported !== false && !service.service?.loaded) {
    if (serviceHealthy) {
      hints.push("Aerial is running in the foreground but no background service is installed; run `aerial service install` so it starts on reboot.");
    } else {
      nextSteps.push("run: aerial service install");
    }
  }
  if (setup.auth.github_token.source === "env") {
    hints.push("AERIAL_GITHUB_TOKEN is set for this process only; run aerial login without that env var to persist a service-readable login.");
  }
  return { schema: "aerial.status.v1", ok, setup, service, nextSteps, hints };
}
