export function serviceGuidance(status) {
  const nextSteps = [];
  const hints = [];
  const state = status.service || {};
  const healthy = status.health?.aerial === true;
  const supported = status.supported !== false;
  const queryFailed = state.reason === "status_query_failed";
  if (queryFailed) {
    nextSteps.push("Check access to the service manager, then run: aerial service status --json");
  }
  if (status.health?.portConflict) {
    const start = !supported ? "aerial start" : state.installed ? "aerial service start" : "aerial service install";
    nextSteps.push(`Free port ${status.config?.port || "used by Aerial"} from the other listener, then run: ${start}`);
  } else if (!healthy && !queryFailed) {
    if (!supported) nextSteps.push("run: aerial start (keep this terminal open)");
    else if (state.loaded) {
      nextSteps.push("run: aerial service restart");
      nextSteps.push(`If health still fails, inspect ${status.logs?.stdio?.file || "the service logs"} and run: aerial service status --json`);
    } else if (state.installed) nextSteps.push("run: aerial service start");
    else nextSteps.push("run: aerial service install");
  } else if (healthy && !queryFailed && !state.loaded) {
    if (supported) hints.push("Aerial is running in the foreground; keep it open. For startup on reboot, stop that foreground process and run `aerial service install`.");
    else hints.push("Aerial is running in the foreground; keep `aerial start` open or manage it with your init system.");
  }
  if (state.wrapper?.stale) hints.push("Refresh the installed wrapper: run `aerial service install`, then `aerial service restart`.");
  return { nextSteps, hints };
}
