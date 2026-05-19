import { WebSocket } from "undici";
import { COPILOT_API_ORIGIN } from "./constants.js";

const TERMINAL_RESPONSE_TYPES = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error"
]);

function websocketUrl() {
  const url = new URL(`${COPILOT_API_ORIGIN}/responses`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function normalizeMessageData(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data.text === "function") return data.text();
  return String(data);
}

function toSseFrame(message) {
  if (message === "[DONE]") return "data: [DONE]\n\n";
  try {
    const parsed = JSON.parse(message);
    const lines = [];
    if (typeof parsed.id === "string") lines.push(`id: ${parsed.id}`);
    if (typeof parsed.type === "string") lines.push(`event: ${parsed.type}`);
    lines.push(`data: ${JSON.stringify(parsed)}`);
    return `${lines.join("\n")}\n\n`;
  } catch {
    return `data: ${message}\n\n`;
  }
}

function isTerminalMessage(message) {
  if (!message || message === "[DONE]") return false;
  try {
    return TERMINAL_RESPONSE_TYPES.has(JSON.parse(message).type);
  } catch {
    return false;
  }
}

function openWebSocket(headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(websocketUrl(), { headers });
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (event) => {
      cleanup();
      reject(new Error(`Failed to create responses websocket: ${event?.message || event?.error?.message || "unknown error"}`));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

export function supportsResponsesWebSocket(model) {
  return Array.isArray(model?.supported_endpoints) && model.supported_endpoints.includes("ws:/responses");
}

export function isResponsesWebSocketOptIn() {
  return process.env.AERIAL_RESPONSES_WEBSOCKET === "on";
}

export function shouldUseResponsesWebSocket(payload, model) {
  if (!isResponsesWebSocketOptIn()) return false;
  if (!payload?.stream) return false;
  return supportsResponsesWebSocket(model);
}

export async function proxyResponsesWebSocket(payload, headers, { initiator = "user" } = {}) {
  const ws = await openWebSocket(headers);
  ws.send(JSON.stringify({ ...payload, type: "response.create", initiator }));

  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      const close = () => {
        try { ws.close(); } catch {}
      };
      ws.addEventListener("message", async (event) => {
        const message = await normalizeMessageData(event.data);
        controller.enqueue(encoder.encode(toSseFrame(message)));
        if (isTerminalMessage(message)) {
          controller.close();
          close();
        }
      });
      ws.addEventListener("close", () => {
        try { controller.close(); } catch {}
      });
      ws.addEventListener("error", (event) => {
        controller.error(new Error(event?.message || event?.error?.message || "Responses websocket stream error"));
      });
    },
    cancel() {
      try { ws.close(); } catch {}
    }
  }), { headers: { "content-type": "text/event-stream" } });
}
