import { WebSocket } from "undici";
import { COPILOT_API_ORIGIN } from "../shared/constants.js";
import { upstreamDispatcher } from "../upstream/fetch.js";
import { waitForPromise } from "../shared/abort.js";

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

async function openWebSocket(url, headers, signal) {
  signal?.throwIfAborted();
  const dispatcher = await waitForPromise(upstreamDispatcher(), signal);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, dispatcher ? { headers, dispatcher } : { headers });
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve(ws);
    };
    const onError = (event) => {
      cleanup();
      reject(new Error(`Failed to create responses websocket: ${event?.message || event?.error?.message || "unknown error"}`));
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Responses websocket closed before opening"));
    };
    const onAbort = () => {
      cleanup();
      try { ws.close(); } catch {}
      reject(signal.reason);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
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

export async function proxyResponsesWebSocket(payload, headers, { initiator = "user", signal, url = websocketUrl() } = {}) {
  const ws = await openWebSocket(url, headers, signal);
  try {
    signal?.throwIfAborted();
    if (ws.readyState !== WebSocket.OPEN) throw new Error("Responses websocket closed before sending the request");
    ws.send(JSON.stringify({ ...payload, type: "response.create", initiator }));
  } catch (error) {
    try { ws.close(); } catch {}
    throw error;
  }

  const encoder = new TextEncoder();
  let stop;
  return new Response(new ReadableStream({
    start(controller) {
      let finished = false;
      const cleanup = () => {
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      stop = (error, cancelled = false) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (!cancelled) {
          if (error) controller.error(error);
          else controller.close();
        }
        try { ws.close(); } catch {}
      };
      const onMessage = async (event) => {
        try {
          const message = await normalizeMessageData(event.data);
          if (finished || !message) return;
          controller.enqueue(encoder.encode(toSseFrame(message)));
          if (isTerminalMessage(message)) stop();
        } catch (error) {
          stop(error);
        }
      };
      const onClose = () => stop();
      const onError = event => stop(new Error(event?.message || event?.error?.message || "Responses websocket stream error"));
      const onAbort = () => stop(signal.reason);
      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    },
    cancel() {
      stop(undefined, true);
    }
  }), { headers: { "content-type": "text/event-stream" } });
}
