import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { chatRequest, messagesRequest, parseForwardedJson, responsesRequest } from "./helpers.js";

process.env.AERIAL_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "aerial-copilot-test-"));
process.env.AERIAL_API_KEY = "aerial_test_key";
process.env.AERIAL_GITHUB_TOKEN = "github-test-token";

const { proxyModels, proxyResponses, proxyMessages, proxyChatCompletions } = await import("../src/proxy/index.js");
const { clearModelCatalogCacheForTests } = await import("../src/proxy/model-catalog.js");
const { ensureApiKey, loadConfig, saveConfig } = await import("../src/shared/config.js");
ensureApiKey();

const originalFetch = globalThis.fetch;
const originalError = console.error;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalError;
  clearModelCatalogCacheForTests();
});

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > 500) return reject(new Error("timed out waiting for condition"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function anthropicEffortModel(id, efforts = ["low", "medium", "high", "xhigh"]) {
  return {
    id,
    supported_endpoints: ["/v1/messages"],
    capabilities: { supports: { adaptive_thinking: true, reasoning_effort: efforts } }
  };
}

function mockMessagesFetch({ models = [] } = {}) {
  const forwarded = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    if (u.endsWith("/models")) return Response.json({ data: models });
    forwarded.push(parseForwardedJson(init));
    return Response.json({ ok: true });
  };
  return { forwarded };
}

function openAIEffortModel(id, efforts) {
  return {
    id,
    supported_endpoints: ["/responses", "/chat/completions"],
    capabilities: { supports: { reasoning_effort: efforts } }
  };
}

function mockOpenAIFetch({ models = [] } = {}) {
  const forwarded = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    if (u.endsWith("/models")) return Response.json({ data: models });
    forwarded.push(parseForwardedJson(init));
    return Response.json({ ok: true });
  };
  return { forwarded };
}

test("proxyModels annotates Aerial route support", async () => {
  let calls = 0;
  globalThis.fetch = async () => Response.json({
    ...(calls++ === 0
      ? { token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" }
      : { data: [
          { id: "gpt", supported_endpoints: ["/responses", "ws:/responses"], capabilities: { type: "chat" } },
          { id: "embed", capabilities: { type: "embeddings" } }
        ] })
  });

  const response = await proxyModels(new Request("http://127.0.0.1/v1/models", { headers: { authorization: "Bearer aerial_test_key" } }));
  const payload = await response.json();
  assert.deepEqual(payload.data[0].aerial.routes, ["responses", "responses_websocket"]);
  assert.equal(payload.data[0].aerial.supported, true);
  assert.deepEqual(payload.data[0].aerial.notes, []);
  assert.equal(payload.data[1].aerial.supported, false);
  assert.deepEqual(payload.data[1].aerial.notes, ["embeddings_not_implemented"]);
});

test("proxyModels does not mark ws-only models as HTTP responses-capable", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [
        { id: "ws-only", supported_endpoints: ["ws:/responses"], capabilities: { type: "chat" } },
        { id: "http-only", supported_endpoints: ["/responses"], capabilities: { type: "chat" } }
      ] });
    }
    // Any non-/models call is the Copilot token exchange; respond with a fresh long-lived token.
    return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
  };

  const response = await proxyModels(new Request("http://127.0.0.1/v1/models", { headers: { authorization: "Bearer aerial_test_key" } }));
  const payload = await response.json();
  // ws:/responses alone must NOT imply HTTP /responses support
  assert.deepEqual(payload.data[0].aerial.routes, ["responses_websocket"]);
  assert.equal(payload.data[0].aerial.supported, true);
  // /responses alone must NOT imply ws upstream support either
  assert.deepEqual(payload.data[1].aerial.routes, ["responses"]);
  assert.equal(payload.data[1].aerial.supported, true);
});

test("proxyChatCompletions maps max_tokens to max_completion_tokens", async () => {
  let forwarded;
  globalThis.fetch = async (_url, init) => {
    forwarded = parseForwardedJson(init);
    return Response.json({ ok: true });
  };

  const request = chatRequest({ model: "gpt-5.4", messages: [], max_tokens: 12 });
  const response = await proxyChatCompletions(request);
  assert.equal(response.status, 200);
  assert.equal(forwarded.max_tokens, undefined);
  assert.equal(forwarded.max_completion_tokens, 12);
});

test("proxyResponses preserves client cache fields", async () => {
  let forwarded;
  const logs = [];
  console.error = (line) => logs.push(JSON.parse(line));
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    forwarded = parseForwardedJson(init);
    return Response.json({ ok: true, usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 7 } } });
  };

  const request = responsesRequest({ model: "gpt-5.4", input: "hello", prompt_cache_retention: "24h", prompt_cache_key: "project-a" });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(forwarded.prompt_cache_retention, "24h");
  assert.equal(forwarded.prompt_cache_key, "project-a");
  await waitFor(() => logs.some((line) => line.event === "cache_observe"));
  const observed = logs.find((line) => line.event === "cache_observe");
  assert.equal(observed.request.promptCacheRetention, "24h");
  assert.equal(observed.request.hasPromptCacheKey, true);
  assert.equal(observed.usage.cached, 7);
});

test("proxyResponses observes cache usage from SSE responses", async () => {
  const logs = [];
  console.error = (line) => logs.push(JSON.parse(line));
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    return new Response([
      "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":20,\"output_tokens\":2,\"input_tokens_details\":{\"cached_tokens\":11}}}}\n\n",
      "data: [DONE]\n\n"
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  };

  const request = responsesRequest(
    { model: "gpt-5.4", input: "hello", prompt_cache_retention: "in_memory" },
    { headers: { accept: "text/event-stream" } }
  );
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  await response.text();
  await waitFor(() => logs.some((line) => line.event === "cache_observe"));
  const observed = logs.find((line) => line.event === "cache_observe");
  assert.equal(observed.usage.cached, 11);
});

test("cache telemetry preserves upstream cancel on SSE responses", async () => {
  const logs = [];
  console.error = (line) => logs.push(JSON.parse(line));
  let upstreamCanceled = false;
  let pullCount = 0;
  const encoder = new TextEncoder();
  const upstreamBody = new ReadableStream({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) {
        controller.enqueue(encoder.encode("data: {\"type\":\"response.in_progress\"}\n\n"));
        return;
      }
      // Keep the stream open: never enqueue more, never close. A telemetry
      // reader that ignores client cancel would block waiting on this pull
      // and the upstream would stay alive indefinitely.
    },
    cancel() {
      upstreamCanceled = true;
    }
  });

  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    return new Response(upstreamBody, { headers: { "content-type": "text/event-stream" } });
  };

  const request = responsesRequest(
    { model: "gpt-5.4", input: "hello", prompt_cache_retention: "in_memory" },
    { headers: { accept: "text/event-stream" } }
  );
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);

  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  await reader.cancel();

  await waitFor(() => upstreamCanceled);
  assert.equal(upstreamCanceled, true, "client cancel must propagate to upstream source");
  // No flush ran, so cache_observe must not log under cancel even though a
  // prompt_cache_retention hint was sent (telemetry must not extend lifetime).
  assert.equal(logs.some((line) => line.event === "cache_observe"), false);
});


test("proxyResponses injects default cache hints transparently", async () => {
  const previousRetention = process.env.AERIAL_PROMPT_CACHE_RETENTION;
  const previousKey = process.env.AERIAL_PROMPT_CACHE_KEY;
  delete process.env.AERIAL_PROMPT_CACHE_RETENTION;
  delete process.env.AERIAL_PROMPT_CACHE_KEY;
  let forwarded;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    forwarded = parseForwardedJson(init);
    return Response.json({ ok: true });
  };

  try {
    const request = responsesRequest({ model: "gpt-5.4-mini", input: "hello", metadata: { session_id: "session-a" } });
    const response = await proxyResponses(request);
    assert.equal(response.status, 200);
    assert.equal(forwarded.prompt_cache_retention, "in_memory");
    assert.match(forwarded.prompt_cache_key, /^aerial:[a-f0-9]{32}$/);
  } finally {
    if (previousRetention === undefined) delete process.env.AERIAL_PROMPT_CACHE_RETENTION;
    else process.env.AERIAL_PROMPT_CACHE_RETENTION = previousRetention;
    if (previousKey === undefined) delete process.env.AERIAL_PROMPT_CACHE_KEY;
    else process.env.AERIAL_PROMPT_CACHE_KEY = previousKey;
  }
});

test("proxyResponses respects cache opt-out", async () => {
  const previousRetention = process.env.AERIAL_PROMPT_CACHE_RETENTION;
  const previousKey = process.env.AERIAL_PROMPT_CACHE_KEY;
  process.env.AERIAL_PROMPT_CACHE_RETENTION = "off";
  process.env.AERIAL_PROMPT_CACHE_KEY = "off";
  let forwarded;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [] });
    forwarded = parseForwardedJson(init);
    return Response.json({ ok: true });
  };

  try {
    const request = responsesRequest({ model: "gpt-5.4-mini", input: "hello" });
    const response = await proxyResponses(request);
    assert.equal(response.status, 200);
    assert.equal(forwarded.prompt_cache_retention, undefined);
    assert.equal(forwarded.prompt_cache_key, undefined);
  } finally {
    if (previousRetention === undefined) delete process.env.AERIAL_PROMPT_CACHE_RETENTION;
    else process.env.AERIAL_PROMPT_CACHE_RETENTION = previousRetention;
    if (previousKey === undefined) delete process.env.AERIAL_PROMPT_CACHE_KEY;
    else process.env.AERIAL_PROMPT_CACHE_KEY = previousKey;
  }
});

test("proxyResponses preserves max when the selected model supports it", async () => {
  const capture = mockOpenAIFetch({
    models: [openAIEffortModel("gpt-5.6-sol", ["none", "low", "medium", "high", "xhigh", "max"])]
  });

  const request = responsesRequest({ model: "gpt-5.6-sol", input: "hello", reasoning: { effort: "max" } });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning.effort, "max");
});

test("proxyResponses downgrades ultra to model-supported max", async () => {
  const capture = mockOpenAIFetch({
    models: [openAIEffortModel("gpt-5.6-sol", ["none", "low", "medium", "high", "xhigh", "max"])]
  });

  const request = responsesRequest({ model: "gpt-5.6-sol", input: "hello", reasoning: { effort: "ultra" } });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning.effort, "max");
});

test("proxyResponses maps Codex minimal to catalog wire effort none", async () => {
  const capture = mockOpenAIFetch({
    models: [openAIEffortModel("gpt-5.6-sol", ["none", "low", "medium", "high", "xhigh", "max"])]
  });

  const request = responsesRequest({ model: "gpt-5.6-sol", input: "hello", reasoning: { effort: "minimal" } });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning.effort, "none");
});

test("proxyResponses routes nested and flat efforts from one model catalog lookup", async () => {
  const capture = mockOpenAIFetch({
    models: [openAIEffortModel("gpt-5.6-sol", ["none", "low", "medium", "high", "xhigh", "max"])]
  });

  const request = responsesRequest({
    model: "gpt-5.6-sol",
    input: "hello",
    reasoning: { effort: "minimal" },
    reasoning_effort: "ultra"
  });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning.effort, "none");
  assert.equal(capture.forwarded[0].reasoning_effort, "max");
});

test("proxyResponses applies deterministic ultra fallback without catalog metadata", async () => {
  const capture = mockOpenAIFetch({ models: [] });

  const request = responsesRequest({ model: "gpt-future", input: "hello", reasoning: { effort: "ultra" } });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning.effort, "max");
});

test("proxyResponses downgrades max to xhigh for models without max", async () => {
  const capture = mockOpenAIFetch({
    models: [openAIEffortModel("gpt-5.5", ["none", "low", "medium", "high", "xhigh"])]
  });

  const request = responsesRequest({ model: "gpt-5.5", input: "hello", reasoning: { effort: "max" } });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning.effort, "xhigh");
});

test("proxyResponses maps gpt-5-mini xhigh effort to high", async () => {
  const capture = mockOpenAIFetch({
    models: [openAIEffortModel("gpt-5-mini", ["low", "medium", "high"])]
  });

  const request = responsesRequest({ model: "gpt-5-mini", input: "hello", reasoning: { effort: "xhigh" } });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning.effort, "high");
});

test("proxyResponses trusts catalog support over legacy gpt-5-mini fallback", async () => {
  const capture = mockOpenAIFetch({
    models: [openAIEffortModel("gpt-5-mini", ["low", "medium", "high", "xhigh"])]
  });

  const request = responsesRequest({ model: "gpt-5-mini", input: "hello", reasoning: { effort: "xhigh" } });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning.effort, "xhigh");
});

test("proxyResponses keeps legacy gpt-5-mini fallback when catalog metadata is missing", async () => {
  const capture = mockOpenAIFetch({ models: [] });

  const request = responsesRequest({ model: "gpt-5-mini", input: "hello", reasoning: { effort: "xhigh" } });
  const response = await proxyResponses(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning.effort, "high");
});

test("proxyChatCompletions maps flat OpenAI max effort to xhigh", async () => {
  const capture = mockOpenAIFetch({
    models: [openAIEffortModel("gpt-5.5", ["none", "low", "medium", "high", "xhigh"])]
  });

  const request = chatRequest({ model: "gpt-5.5", messages: [{ role: "user", content: "hello" }], reasoning_effort: "max" });
  const response = await proxyChatCompletions(request);
  assert.equal(response.status, 200);
  assert.equal(capture.forwarded[0].reasoning_effort, "xhigh");
});

test("proxyMessages injects Anthropic cache_control on system content", async () => {
  const previous = process.env.AERIAL_PROMPT_CACHE_RETENTION;
  delete process.env.AERIAL_PROMPT_CACHE_RETENTION;
  let forwarded;
  globalThis.fetch = async (_url, init) => {
    forwarded = parseForwardedJson(init);
    return Response.json({ ok: true, usage: { cache_creation_input_tokens: 13, cache_read_input_tokens: 0 } });
  };

  try {
    const request = messagesRequest({
      model: "claude-sonnet-4.6",
      max_tokens: 32,
      system: [{ type: "text", text: "Long stable project context" }],
      messages: [{ role: "user", content: "hello" }]
    });
    const response = await proxyMessages(request);
    assert.equal(response.status, 200);
    assert.deepEqual(forwarded.system[0].cache_control, { type: "ephemeral" });
  } finally {
    if (previous === undefined) delete process.env.AERIAL_PROMPT_CACHE_RETENTION;
    else process.env.AERIAL_PROMPT_CACHE_RETENTION = previous;
  }
});

test("proxyMessages preserves client Anthropic cache_control", async () => {
  let forwarded;
  globalThis.fetch = async (_url, init) => {
    forwarded = parseForwardedJson(init);
    return Response.json({ ok: true });
  };

  const request = messagesRequest({
    model: "claude-sonnet-4.6",
    max_tokens: 32,
    system: [{ type: "text", text: "Long stable project context", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded.system, [{ type: "text", text: "Long stable project context", cache_control: { type: "ephemeral" } }]);
});

test("proxyMessages maps legacy enabled thinking to adaptive thinking plus effort", async () => {
  const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-thinking-current")] });

  const request = messagesRequest({
    model: "claude-opus-4.7",
    max_tokens: 32,
    thinking: { type: "enabled", budget_tokens: 32000 },
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  const forwarded = capture.forwarded[0];
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded.thinking, { type: "adaptive" });
  assert.equal(forwarded.output_config.effort, "high");
  assert.equal(forwarded.model, "claude-opus-4.7-thinking-current");
});

test("proxyMessages preserves existing output_config effort when mapping legacy thinking", async () => {
  const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-thinking-current")] });

  const request = messagesRequest({
    model: "claude-opus-4.7",
    max_tokens: 32,
    thinking: { type: { enabled: true } },
    output_config: { effort: "xhigh" },
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  const forwarded = capture.forwarded[0];
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded.thinking, { type: "adaptive" });
  assert.equal(forwarded.output_config.effort, "xhigh");
  assert.equal(forwarded.model, "claude-opus-4.7-thinking-current");
});

test("proxyMessages leaves adaptive thinking unchanged", async () => {
  let forwarded;
  globalThis.fetch = async (_url, init) => {
    forwarded = parseForwardedJson(init);
    return Response.json({ ok: true });
  };

  const request = messagesRequest({
    model: "claude-sonnet-4.6",
    max_tokens: 32,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  assert.equal(response.status, 200);
  assert.deepEqual(forwarded.thinking, { type: "adaptive" });
  assert.equal(forwarded.output_config.effort, "medium");
});

test("proxyMessages routes Claude Opus 4.7 non-medium effort to live catalog model", async () => {
  const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-effort-2026")] });

  const request = messagesRequest({
    model: "claude-opus-4.7",
    max_tokens: 32,
    output_config: { effort: "xhigh" },
    system: [{ type: "text", text: "Long stable project context" }],
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  const forwarded = capture.forwarded[0];
  assert.equal(response.status, 200);
  assert.equal(forwarded.model, "claude-opus-4.7-effort-2026");
  assert.equal(forwarded.output_config.effort, "xhigh");
});

test("proxyMessages maps max effort to xhigh on a live catalog Claude Opus 4.7 model", async () => {
  const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-effort-2026")] });

  const request = messagesRequest({
    model: "claude-opus-4.7",
    max_tokens: 32,
    output_config: { effort: "max" },
    system: [{ type: "text", text: "Long stable project context" }],
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  const forwarded = capture.forwarded[0];
  assert.equal(response.status, 200);
  assert.equal(forwarded.model, "claude-opus-4.7-effort-2026");
  assert.equal(forwarded.output_config.effort, "xhigh");
});

test("proxyMessages clamps Claude Opus 4.8 high effort to selected model supported effort", async () => {
  const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.8", ["medium"])] });

  const request = messagesRequest({
    model: "claude-opus-4.8",
    max_tokens: 32,
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  const forwarded = capture.forwarded[0];
  assert.equal(response.status, 200);
  assert.equal(forwarded.model, "claude-opus-4.8");
  assert.equal(forwarded.output_config.effort, "medium");
});

test("proxyMessages clamps hyphenated Claude Opus 4.8 alias to catalog supported effort", async () => {
  const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.8", ["medium"])] });

  const request = messagesRequest({
    model: "claude-opus-4-8",
    max_tokens: 32,
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  const forwarded = capture.forwarded[0];
  assert.equal(response.status, 200);
  assert.equal(forwarded.model, "claude-opus-4.8");
  assert.equal(forwarded.output_config.effort, "medium");
});

test("proxyMessages routes hyphenated Claude Opus 4.7 aliases to live catalog model", async () => {
  const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-effort-2026")] });

  const request = messagesRequest({
    model: "claude-opus-4-7",
    max_tokens: 32,
    output_config: { effort: "xhigh" },
    system: [{ type: "text", text: "Long stable project context" }],
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  const forwarded = capture.forwarded[0];
  assert.equal(response.status, 200);
  assert.equal(forwarded.model, "claude-opus-4.7-effort-2026");
  assert.equal(forwarded.output_config.effort, "xhigh");
});

test("proxyMessages normalizes legacy Claude Opus 4.7 effort model suffixes", async () => {
  const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-effort-2026")] });

  const request = messagesRequest({
    model: "claude-opus-4.7-high",
    max_tokens: 32,
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  const forwarded = capture.forwarded[0];
  assert.equal(response.status, 200);
  assert.equal(forwarded.model, "claude-opus-4.7-effort-2026");
  assert.equal(forwarded.output_config.effort, "high");
});

test("proxyMessages leaves model unchanged when live catalog has no compatible Claude effort model", async () => {
  const capture = mockMessagesFetch({
    models: [
      { id: "claude-opus-4.7-effortless", supported_endpoints: ["/v1/messages"], capabilities: { supports: { adaptive_thinking: true, reasoning_effort: ["medium"] } } }
    ]
  });

  const request = messagesRequest({
    model: "claude-opus-4.7",
    max_tokens: 32,
    thinking: { type: "enabled", budget_tokens: 32000 },
    messages: [{ role: "user", content: "hello" }]
  });
  const response = await proxyMessages(request);
  const forwarded = capture.forwarded[0];
  assert.equal(response.status, 200);
  assert.equal(forwarded.model, "claude-opus-4.7");
  assert.deepEqual(forwarded.thinking, { type: "adaptive" });
  assert.equal(forwarded.output_config.effort, "high");
});

test("proxyResponses can apply configured default cache retention", async () => {
  const previous = process.env.AERIAL_PROMPT_CACHE_RETENTION;
  process.env.AERIAL_PROMPT_CACHE_RETENTION = "in_memory";
  let forwarded;
  globalThis.fetch = async (_url, init) => {
    forwarded = parseForwardedJson(init);
    return Response.json({ ok: true });
  };

  try {
    const request = responsesRequest({ model: "gpt-5.4-mini", input: "hello" });
    const response = await proxyResponses(request);
    assert.equal(response.status, 200);
    assert.equal(forwarded.prompt_cache_retention, "in_memory");
  } finally {
    if (previous === undefined) delete process.env.AERIAL_PROMPT_CACHE_RETENTION;
    else process.env.AERIAL_PROMPT_CACHE_RETENTION = previous;
  }
});

test("proxyMessages catalog fetch is cached across sequential Claude Opus 4.7 requests", async () => {
  let modelsCalls = 0;
  const forwarded = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("copilot_internal")) return Response.json({ token: "header.eyJleHAiOjk5OTk5OTk5OTl9.sig" });
    if (u.endsWith("/models")) {
      modelsCalls += 1;
      return Response.json({ data: [anthropicEffortModel("claude-opus-4.7-cache-target")] });
    }
    forwarded.push(parseForwardedJson(init));
    return Response.json({ ok: true });
  };
  const makeRequest = () => messagesRequest({
    model: "claude-opus-4.7",
    messages: [{ role: "user", content: "hello" }],
    output_config: { effort: "xhigh" },
    max_tokens: 8
  });
  await proxyMessages(makeRequest());
  await proxyMessages(makeRequest());
  assert.equal(modelsCalls, 1, "two sequential Claude Opus 4.7 effort requests must share catalog cache");
  assert.equal(forwarded.length, 2);
  for (const body of forwarded) assert.equal(body.model, "claude-opus-4.7-cache-target");
});

function withDefaultEffort(value, fn) {
  const original = loadConfig().defaultEffort;
  saveConfig({ ...loadConfig(), defaultEffort: value });
  return Promise.resolve(fn()).finally(() => {
    saveConfig({ ...loadConfig(), defaultEffort: original });
  });
}

test("proxyMessages injects Aerial defaultEffort when request has no effort/thinking signal", async () => {
  await withDefaultEffort("high", async () => {
    const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-thinking-current")] });
    const request = messagesRequest({
      model: "claude-opus-4.7",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }]
    });
    const response = await proxyMessages(request);
    const forwarded = capture.forwarded[0];
    assert.equal(response.status, 200);
    assert.equal(forwarded.output_config.effort, "high");
    assert.equal(forwarded.model, "claude-opus-4.7-thinking-current");
  });
});

test("proxyMessages does not override explicit output_config.effort with defaultEffort", async () => {
  await withDefaultEffort("high", async () => {
    const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-effort-low")] });
    const request = messagesRequest({
      model: "claude-opus-4.7",
      max_tokens: 32,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: "hello" }]
    });
    const response = await proxyMessages(request);
    const forwarded = capture.forwarded[0];
    assert.equal(response.status, 200);
    assert.equal(forwarded.output_config.effort, "low");
  });
});

test("proxyMessages does not override legacy thinking effort with defaultEffort", async () => {
  await withDefaultEffort("xhigh", async () => {
    const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-thinking-current")] });
    const request = messagesRequest({
      model: "claude-opus-4.7",
      max_tokens: 32,
      thinking: { type: "enabled", budget_tokens: 4096 },
      messages: [{ role: "user", content: "hello" }]
    });
    const response = await proxyMessages(request);
    const forwarded = capture.forwarded[0];
    assert.equal(response.status, 200);
    assert.deepEqual(forwarded.thinking, { type: "adaptive" });
    assert.equal(forwarded.output_config.effort, "low");
  });
});

test("proxyMessages does not inject defaultEffort when adaptive thinking is set without explicit effort", async () => {
  await withDefaultEffort("high", async () => {
    let forwarded;
    globalThis.fetch = async (_url, init) => {
      forwarded = parseForwardedJson(init);
      return Response.json({ ok: true });
    };
    const request = messagesRequest({
      model: "claude-sonnet-4.6",
      max_tokens: 32,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hello" }]
    });
    const response = await proxyMessages(request);
    assert.equal(response.status, 200);
    assert.deepEqual(forwarded.thinking, { type: "adaptive" });
    assert.equal(forwarded.output_config, undefined);
  });
});

test("proxyMessages does not inject defaultEffort for non-Opus Claude models (e.g. Sonnet 4.6)", async () => {
  await withDefaultEffort("high", async () => {
    let forwarded;
    globalThis.fetch = async (_url, init) => {
      forwarded = parseForwardedJson(init);
      return Response.json({ ok: true });
    };
    const request = messagesRequest({
      model: "claude-sonnet-4.6",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }]
    });
    const response = await proxyMessages(request);
    assert.equal(response.status, 200);
    assert.equal(forwarded.output_config, undefined);
  });
});

test("proxyMessages falls back to medium when defaultEffort is invalid in config", async () => {
  const original = loadConfig().defaultEffort;
  const raw = (await import("../src/shared/paths.js")).configPath();
  const current = JSON.parse(fs.readFileSync(raw, "utf8"));
  fs.writeFileSync(raw, JSON.stringify({ ...current, defaultEffort: "turbo" }, null, 2));
  try {
    const capture = mockMessagesFetch({ models: [anthropicEffortModel("claude-opus-4.7-medium-target")] });
    const request = messagesRequest({
      model: "claude-opus-4.7",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }]
    });
    const response = await proxyMessages(request);
    const forwarded = capture.forwarded[0];
    assert.equal(response.status, 200);
    assert.equal(forwarded.output_config.effort, "medium");
  } finally {
    saveConfig({ ...loadConfig(), defaultEffort: original });
  }
});
