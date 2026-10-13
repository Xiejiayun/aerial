import { proxyChatCompletions, proxyMessages, proxyModels, proxyResponses } from "../proxy/index.js";
import { readJsonSafely } from "../shared/utils.js";
import { aerialRoutes, usageSummary } from "../proxy/models.js";
import { supportedReasoningEfforts } from "../proxy/model-catalog.js";

function modelRoutes(model) {
  return aerialRoutes(model);
}

function firstModel(models, route) {
  return models.find((model) => modelRoutes(model).includes(route));
}

async function probeRoute(name, model, handler, payload, headers = {}) {
  try {
    const response = await handler(new Request(`http://aerial.local/probe/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload)
    }));
    const body = await readJsonSafely(response);
    return {
      route: name,
      model: model.id,
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") || undefined,
      usage: response.ok ? usageSummary(body) : undefined,
      error: response.ok ? undefined : body.error || body
    };
  } catch (error) {
    return { route: name, model: model.id, ok: false, error: { message: error.message || String(error) } };
  }
}

function summarizeModels(models) {
  const summary = { responses: 0, messages: 0, chat: 0, websocketResponses: 0, embeddings: 0, unsupported: 0 };
  for (const model of models) {
    const routes = modelRoutes(model);
    if (routes.includes("responses")) summary.responses += 1;
    if (routes.includes("messages")) summary.messages += 1;
    if (routes.includes("chat")) summary.chat += 1;
    if (routes.includes("responses_websocket")) summary.websocketResponses += 1;
    if (model.aerial?.notes?.includes("embeddings_not_implemented")) summary.embeddings += 1;
    if (!model.aerial?.supported) summary.unsupported += 1;
  }
  return summary;
}

export async function runProbe({ live = false } = {}) {
  const context = { generatedAt: new Date().toISOString(), live, scope: "proxy-handlers", notChecked: ["running-service", "client-configuration"] };
  let modelsResponse;
  try {
    modelsResponse = await proxyModels(new Request("http://aerial.local/v1/models", { method: "GET" }));
  } catch (error) {
    return { ...context, ok: false, error: { message: error.message || String(error) } };
  }
  const modelsPayload = await readJsonSafely(modelsResponse);
  if (!modelsResponse.ok) {
    return { ...context, ok: false, status: modelsResponse.status, error: modelsPayload.error || modelsPayload };
  }

  const models = Array.isArray(modelsPayload.data) ? modelsPayload.data : [];
  const report = {
    ok: true,
    ...context,
    summary: summarizeModels(models),
    routes: [],
    models: models.map((model) => ({
      id: model.id,
      routes: modelRoutes(model),
      efforts: supportedReasoningEfforts(model),
      notes: model.aerial?.notes || [],
      supported: Boolean(model.aerial?.supported)
    }))
  };

  if (!live) return report;

  const responsesModel = firstModel(models, "responses");
  if (responsesModel) {
    report.routes.push(await probeRoute("responses", responsesModel, proxyResponses, {
      model: responsesModel.id,
      input: "Return only: aerial-probe",
      max_output_tokens: 16,
      store: false
    }));
  }

  const messagesModel = firstModel(models, "messages");
  if (messagesModel) {
    report.routes.push(await probeRoute("messages", messagesModel, proxyMessages, {
      model: messagesModel.id,
      max_tokens: 16,
      messages: [{ role: "user", content: "Return only: aerial-probe" }]
    }, { "anthropic-version": "2023-06-01" }));
  }

  const chatModel = firstModel(models, "chat");
  if (chatModel) {
    report.routes.push(await probeRoute("chat", chatModel, proxyChatCompletions, {
      model: chatModel.id,
      messages: [{ role: "user", content: "Return only: aerial-probe" }],
      max_completion_tokens: 16
    }));
  }

  report.ok = report.routes.length > 0 && report.routes.every(route => route.ok);
  report.skippedRoutes = ["responses", "messages", "chat"].filter(route => !report.routes.some(check => check.route === route));
  if (!report.routes.length) report.error = { message: "No inference routes are available to test. Check your Copilot subscription, network and model catalog." };
  return report;
}

export function formatProbeReport(report) {
  if (!report.summary) return `Aerial probe failed: ${JSON.stringify(report.error)}`;
  const lines = [
    `Aerial probe (${report.live ? "live" : "models"}): ${report.ok ? "ok" : "FAILED"} at ${report.generatedAt}`,
    "Scope: in-process proxy handlers and upstream API. Check local service/client readiness with aerial status.",
    `Models: ${report.models.length}`,
    `Routes: responses=${report.summary.responses}, responsesWebSocket=${report.summary.websocketResponses}, messages=${report.summary.messages}, chat=${report.summary.chat}`,
    `Unsupported: embeddings=${report.summary.embeddings}, noRoute=${report.summary.unsupported}`
  ];

  if (report.routes.length) {
    lines.push("", "Live route checks:");
    for (const route of report.routes) {
      const usage = route.usage ? ` input=${route.usage.input ?? "?"} output=${route.usage.output ?? "?"} cached=${route.usage.cached ?? 0}` : "";
      lines.push(`- ${route.route}: ${route.ok ? "ok" : "fail"} status=${route.status ?? "network-error"} model=${route.model}${usage}`);
      if (route.error) lines.push(`  ${typeof route.error === "string" ? route.error : JSON.stringify(route.error)}`);
    }
  }
  if (report.error) lines.push(`Error: ${JSON.stringify(report.error)}`);
  if (report.skippedRoutes?.length) lines.push(`Unavailable routes (not tested): ${report.skippedRoutes.join(", ")}`);

  lines.push("", "Model matrix:");
  for (const model of report.models) {
    const routes = model.routes.length ? model.routes.join(",") : "-";
    const efforts = model.efforts.length ? ` efforts=${model.efforts.join(",")}` : "";
    const notes = model.notes.length ? ` notes=${model.notes.join(",")}` : "";
    lines.push(`- ${model.id}: routes=${routes}${efforts}${notes}`);
  }
  return lines.join("\n");
}
