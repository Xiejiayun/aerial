import { proxyChatCompletions, proxyMessages, proxyModels, proxyResponses } from "../proxy/index.js";
import { readJsonSafely } from "../shared/http-utils.js";
import { aerialRoutes, usageSummary } from "../proxy/model-utils.js";

function modelRoutes(model) {
  return aerialRoutes(model);
}

function firstModel(models, route) {
  return models.find((model) => modelRoutes(model).includes(route));
}

async function probeRoute(name, model, handler, payload, headers = {}) {
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
  const modelsResponse = await proxyModels(new Request("http://aerial.local/v1/models", { method: "GET" }));
  const modelsPayload = await readJsonSafely(modelsResponse);
  if (!modelsResponse.ok) {
    return { ok: false, generatedAt: new Date().toISOString(), error: modelsPayload.error || modelsPayload };
  }

  const models = Array.isArray(modelsPayload.data) ? modelsPayload.data : [];
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    live,
    summary: summarizeModels(models),
    routes: [],
    models: models.map((model) => ({
      id: model.id,
      routes: modelRoutes(model),
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

  return report;
}

export function formatProbeReport(report) {
  if (!report.ok) return `Aerial probe failed: ${JSON.stringify(report.error)}`;
  const lines = [
    `Aerial probe (${report.live ? "live" : "models"}) at ${report.generatedAt}`,
    `Models: ${report.models.length}`,
    `Routes: responses=${report.summary.responses}, responsesWebSocket=${report.summary.websocketResponses}, messages=${report.summary.messages}, chat=${report.summary.chat}`,
    `Unsupported: embeddings=${report.summary.embeddings}, noRoute=${report.summary.unsupported}`
  ];

  if (report.routes.length) {
    lines.push("", "Live route checks:");
    for (const route of report.routes) {
      const usage = route.usage ? ` input=${route.usage.input ?? "?"} output=${route.usage.output ?? "?"} cached=${route.usage.cached ?? 0}` : "";
      lines.push(`- ${route.route}: ${route.ok ? "ok" : "fail"} status=${route.status} model=${route.model}${usage}`);
    }
  }

  lines.push("", "Model matrix:");
  for (const model of report.models) {
    const routes = model.routes.length ? model.routes.join(",") : "-";
    const notes = model.notes.length ? ` notes=${model.notes.join(",")}` : "";
    lines.push(`- ${model.id}: routes=${routes}${notes}`);
  }
  return lines.join("\n");
}
