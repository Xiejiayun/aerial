export function errorDetail(value) {
  if (typeof value === "string") return value;
  if (typeof value?.message === "string") return value.message;
  if (value?.error !== undefined) return errorDetail(value.error);
  if (typeof value?.raw === "string") return value.raw.slice(0, 500);
  return value ? JSON.stringify(value).slice(0, 500) : "No error detail returned.";
}

export function requestFailure(context, status, payload, { localAuth = false } = {}) {
  const detail = errorDetail(payload);
  let hint;
  if (status === 401 && localAuth) hint = "The running proxy rejected the local key. Run aerial service restart (or restart aerial start), then retry.";
  else if (status === 401) hint = "Run aerial login --force to renew the GitHub login.";
  else if (status === 403) hint = "Check your Copilot subscription and organization/model access permissions. Use aerial proxy status to check the network route.";
  else if (status === 429) hint = "The upstream rate limit was reached. Wait for its retry interval, then retry.";
  else if (status === 404) hint = "This model or API route is unavailable. Run aerial probe and select a model advertising the required route.";
  else if (status >= 500) hint = "The upstream service is unavailable. Check aerial proxy status and retry when it recovers.";
  else if (!status) hint = "Check the network connection and aerial proxy status; enable an upstream proxy with aerial proxy enable if needed.";
  else hint = "Check the selected model and effort, then retry.";
  return new Error(`${context}${status ? ` (${status})` : ""}: ${detail}\n${hint}`);
}
