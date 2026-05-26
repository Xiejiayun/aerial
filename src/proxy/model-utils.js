export function aerialRoutes(model) {
  return Array.isArray(model?.aerial?.routes) ? model.aerial.routes : [];
}

export function modelsForRoute(models, route) {
  return models
    .filter((model) => typeof model?.id === "string" && aerialRoutes(model).includes(route))
    .map((model) => ({ id: model.id, routes: aerialRoutes(model), notes: model.aerial?.notes || [] }));
}

export function usageSummary(payload) {
  const usage = payload?.usage || payload?.response?.usage || {};
  return {
    input: usage.input_tokens ?? usage.prompt_tokens,
    output: usage.output_tokens ?? usage.completion_tokens,
    cached: usage.input_tokens_details?.cached_tokens
      ?? usage.prompt_tokens_details?.cached_tokens
      ?? usage.cache_read_input_tokens
  };
}
