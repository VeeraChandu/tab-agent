// lib/providers.js
// Normalizes calls to Anthropic's Messages API and any OpenAI-compatible
// Chat Completions API (OpenAI itself, or self-hosted / third-party
// endpoints that speak the same schema) behind one interface.
//
// Internal "neutral" history format (kept in background/agentLoop.js):
//   { role: "user" | "assistant", content: Block[] }
// Block =
//   { type: "text", text }
//   | { type: "tool_use", id, name, input }        (assistant only)
//   | { type: "tool_result", tool_use_id, content } (user only)
//
// This mirrors Anthropic's native shape, and gets converted to OpenAI's
// message/tool_calls shape when needed.

import { TOOLS } from "./tools.js";

const ANTHROPIC_VERSION = "2023-06-01";

// A transient 429/5xx or network blip shouldn't abort an entire multi-step
// run. Retry a couple of times with exponential backoff + jitter before
// giving up; anything else (4xx auth/validation errors) fails immediately
// since retrying won't help.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_FETCH_RETRIES = 2;

function backoffDelay(attempt) {
  return 500 * 2 ** attempt + Math.random() * 250;
}

async function fetchWithRetry(url, options, maxRetries = MAX_FETCH_RETRIES) {
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
      continue;
    }
    if (res.ok || attempt >= maxRetries || !RETRYABLE_STATUS.has(res.status)) return res;
    await new Promise((r) => setTimeout(r, backoffDelay(attempt)));
  }
}

// Builds an OpenAI-compatible endpoint URL from a user-supplied base URL.
// OpenAI's own base ("https://api.openai.com") is a bare origin, so the
// standard "/v1/..." suffix is appended. But many OpenAI-compatible
// providers (Venice, Groq, and others) document their base URL as already
// INCLUDING the version segment, e.g. "https://api.venice.ai/api/v1" —
// blindly appending "/v1/..." on top of that produces a doubled
// ".../v1/v1/models" path that 404s. Detect an already-versioned base and
// skip adding a second "/v1".
function openaiApiUrl(baseUrl, path) {
  const trimmed = (baseUrl || "https://api.openai.com").replace(/\/+$/, "");
  const alreadyVersioned = /\/v\d+$/i.test(trimmed);
  return alreadyVersioned ? `${trimmed}${path}` : `${trimmed}/v1${path}`;
}

function anthropicTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

function openaiTools() {
  return TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

export async function callAnthropic(config, history, system) {
  const baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await fetchWithRetry(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: config.model || "claude-sonnet-4-5",
      max_tokens: 2048,
      system,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      tools: anthropicTools(),
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Anthropic API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const blocks = [];
  const toolCalls = [];
  let text = "";

  for (const block of data.content || []) {
    if (block.type === "text") {
      text += block.text;
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
  }

  const usage = data.usage
    ? { inputTokens: data.usage.input_tokens || 0, outputTokens: data.usage.output_tokens || 0 }
    : null;

  return { assistantBlocks: blocks, toolCalls, text, stopReason: data.stop_reason, usage };
}

function toOpenAIMessages(history, system) {
  const messages = [{ role: "system", content: system }];

  for (const turn of history) {
    if (turn.role === "user") {
      const toolResults = turn.content.filter((b) => b.type === "tool_result");
      const contentBlocks = turn.content.filter((b) => b.type === "text" || b.type === "image");

      if (toolResults.length) {
        for (const tr of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
      }
      if (contentBlocks.length) {
        const hasImage = contentBlocks.some((b) => b.type === "image");
        if (!hasImage) {
          messages.push({ role: "user", content: contentBlocks.map((b) => b.text).join("\n") });
        } else {
          const parts = contentBlocks.map((b) =>
            b.type === "image"
              ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
              : { type: "text", text: b.text }
          );
          messages.push({ role: "user", content: parts });
        }
      }
    } else if (turn.role === "assistant") {
      const textBlocks = turn.content.filter((b) => b.type === "text");
      const toolUses = turn.content.filter((b) => b.type === "tool_use");
      const msg = { role: "assistant", content: textBlocks.map((b) => b.text).join("\n") || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: "function",
          function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
        }));
      }
      messages.push(msg);
    }
  }

  return messages;
}

export async function callOpenAI(config, history, system) {
  const res = await fetchWithRetry(openaiApiUrl(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || "gpt-4.1",
      messages: toOpenAIMessages(history, system),
      tools: openaiTools(),
      tool_choice: "auto",
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI-compatible API error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const msg = choice?.message || {};
  const blocks = [];
  const toolCalls = [];

  if (msg.content) blocks.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input;
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    toolCalls.push({ id: tc.id, name: tc.function.name, input });
  }

  const usage = data.usage
    ? { inputTokens: data.usage.prompt_tokens || 0, outputTokens: data.usage.completion_tokens || 0 }
    : null;

  return { assistantBlocks: blocks, toolCalls, text: msg.content || "", stopReason: choice?.finish_reason, usage };
}

// --- streaming ------------------------------------------------------------
// Same request, with stream: true, parsed incrementally so the UI can show
// text as it's generated instead of waiting for the whole response. Builds
// the exact same { assistantBlocks, toolCalls, text, stopReason, usage }
// shape as the non-streaming calls above, just assembled from SSE chunks.
// onDelta(text) is called with the growing text after every text chunk.

async function readSSE(res, onEvent) {
  if (!res.body || !res.body.getReader) {
    throw new Error("Streaming is not supported in this environment.");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the last (possibly partial) line for next chunk
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue; // skip any malformed/partial line rather than aborting the whole stream
      }
      onEvent(parsed);
    }
  }
}

async function callAnthropicStream(config, history, system, onDelta) {
  const baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const res = await fetchWithRetry(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: config.model || "claude-sonnet-4-5",
      max_tokens: 2048,
      system,
      messages: history.map((m) => ({ role: m.role, content: m.content })),
      tools: anthropicTools(),
      stream: true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Anthropic API error (${res.status}): ${errText}`);
  }

  const blocksByIndex = new Map();
  let text = "";
  let stopReason = null;
  const usage = { inputTokens: 0, outputTokens: 0 };

  await readSSE(res, (evt) => {
    if (evt.type === "message_start" && evt.message?.usage) {
      usage.inputTokens = evt.message.usage.input_tokens || 0;
    } else if (evt.type === "content_block_start") {
      const block = evt.content_block || {};
      blocksByIndex.set(
        evt.index,
        block.type === "tool_use" ? { type: "tool_use", id: block.id, name: block.name, jsonText: "" } : { type: "text", text: "" }
      );
    } else if (evt.type === "content_block_delta") {
      const block = blocksByIndex.get(evt.index);
      if (!block) return;
      if (evt.delta?.type === "text_delta") {
        block.text += evt.delta.text || "";
        text += evt.delta.text || "";
        if (onDelta) onDelta(text);
      } else if (evt.delta?.type === "input_json_delta") {
        block.jsonText += evt.delta.partial_json || "";
      }
    } else if (evt.type === "message_delta") {
      if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
      if (evt.usage?.output_tokens != null) usage.outputTokens = evt.usage.output_tokens;
    }
  });

  const blocks = [];
  const toolCalls = [];
  for (const idx of Array.from(blocksByIndex.keys()).sort((a, b) => a - b)) {
    const block = blocksByIndex.get(idx);
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else {
      let input;
      try {
        input = JSON.parse(block.jsonText || "{}");
      } catch {
        input = {};
      }
      blocks.push({ type: "tool_use", id: block.id, name: block.name, input });
      toolCalls.push({ id: block.id, name: block.name, input });
    }
  }

  return { assistantBlocks: blocks, toolCalls, text, stopReason, usage };
}

async function callOpenAIStream(config, history, system, onDelta) {
  const res = await fetchWithRetry(openaiApiUrl(config.baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || "gpt-4.1",
      messages: toOpenAIMessages(history, system),
      tools: openaiTools(),
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI-compatible API error (${res.status}): ${errText}`);
  }

  let text = "";
  let finishReason = null;
  let usage = null;
  const toolCallsByIndex = new Map();

  await readSSE(res, (chunk) => {
    if (chunk.usage) {
      usage = { inputTokens: chunk.usage.prompt_tokens || 0, outputTokens: chunk.usage.completion_tokens || 0 };
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.content) {
      text += delta.content;
      if (onDelta) onDelta(text);
    }
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      if (!toolCallsByIndex.has(idx)) toolCallsByIndex.set(idx, { id: tc.id, name: tc.function?.name || "", argsText: "" });
      const entry = toolCallsByIndex.get(idx);
      if (tc.id) entry.id = tc.id;
      if (tc.function?.name) entry.name = tc.function.name;
      if (tc.function?.arguments) entry.argsText += tc.function.arguments;
    }
  });

  const blocks = [];
  const toolCalls = [];
  if (text) blocks.push({ type: "text", text });
  for (const idx of Array.from(toolCallsByIndex.keys()).sort((a, b) => a - b)) {
    const tc = toolCallsByIndex.get(idx);
    let input;
    try {
      input = JSON.parse(tc.argsText || "{}");
    } catch {
      input = {};
    }
    blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    toolCalls.push({ id: tc.id, name: tc.name, input });
  }

  return { assistantBlocks: blocks, toolCalls, text, stopReason: finishReason, usage };
}

// Real API errors (auth, validation, rate limit exhausted) start with "API
// error (" from the throws above — retrying via the non-streaming call
// would just fail the same way, so only fall back for genuine
// streaming-specific problems (parsing, environment support).
function isRealApiError(err) {
  return /API error \(/.test(err?.message || "");
}

export async function callProvider(config, history, system, onDelta) {
  if (config.provider === "anthropic") {
    if (onDelta) {
      try {
        return await callAnthropicStream(config, history, system, onDelta);
      } catch (err) {
        if (isRealApiError(err)) throw err;
        return callAnthropic(config, history, system);
      }
    }
    return callAnthropic(config, history, system);
  }
  if (config.provider === "openai") {
    if (onDelta) {
      try {
        return await callOpenAIStream(config, history, system, onDelta);
      } catch (err) {
        if (isRealApiError(err)) throw err;
        return callOpenAI(config, history, system);
      }
    }
    return callOpenAI(config, history, system);
  }
  throw new Error(`Unknown provider: ${config.provider}`);
}

// A minimal, tool-free single-turn call: hands optional image attachments
// plus a custom text prompt to the model and returns its raw text response.
// Shared building block for describeImage/classifyImages (vision tools,
// always with attachments) and summarizeHistory below (/compact, always
// text-only, attachments === []) — same request shape either way.
async function singleTurnComplete(config, promptText, attachments) {
  if (config.provider === "anthropic") {
    const baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    const content = [{ type: "text", text: promptText }];
    for (const att of attachments) {
      content.push({ type: "image", source: { type: "base64", media_type: att.mediaType, data: att.data } });
    }
    const res = await fetchWithRetry(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1536,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Vision helper error (${res.status}): ${errText}`);
    }
    const data = await res.json();
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }

  if (config.provider === "openai") {
    const content = [{ type: "text", text: promptText }];
    for (const att of attachments) {
      content.push({ type: "image_url", image_url: { url: `data:${att.mediaType};base64,${att.data}` } });
    }
    const res = await fetchWithRetry(openaiApiUrl(config.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Vision helper error (${res.status}): ${errText}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }

  throw new Error(`Unknown provider: ${config.provider}`);
}

const DESCRIBE_IMAGE_PROMPT = "Describe this image in detail, including any visible text, for someone who cannot see it. Be thorough and objective.";

// Used by both the vision fallback (describing a user-attached image for a
// chat model that can't see images) and the view_image tool (describing a
// page-rendered image, e.g. to check/critique a freshly generated one).
export async function describeImage(config, attachment) {
  return singleTurnComplete(config, DESCRIBE_IMAGE_PROMPT, [attachment]);
}

// Keep individual requests a reasonable size / stay well clear of most
// providers' per-request image limits when a filter_images call is asked to
// check a large batch at once.
const MAX_IMAGES_PER_CLASSIFY_CALL = 12;

// Checks a batch of images against a plain-language criteria in as few model
// calls as possible (one call per MAX_IMAGES_PER_CLASSIFY_CALL images, not
// one call per image) — used by the filter_images tool. Returns one entry
// per input attachment, in order, as { index, match, reason }. A failed or
// unparseable batch degrades to match:null (rather than throwing and losing
// every other batch's results) so the caller can report "couldn't classify
// this one" for just the affected images instead of failing the whole call.
export async function classifyImages(config, attachments, criteria) {
  const results = [];
  for (let start = 0; start < attachments.length; start += MAX_IMAGES_PER_CLASSIFY_CALL) {
    const batch = attachments.slice(start, start + MAX_IMAGES_PER_CLASSIFY_CALL);
    const prompt =
      `You will be shown ${batch.length} image${batch.length === 1 ? "" : "s"}, numbered 1 to ${batch.length} in the order given. ` +
      `For EACH image, decide whether it matches this criteria: "${criteria}". ` +
      `Respond with ONLY a JSON array (no other text before or after), one entry per image in order, ` +
      `each shaped like {"index": <1-based number>, "match": <true or false>, "reason": "<short reason, under 12 words>"}.`;

    let raw;
    try {
      raw = await singleTurnComplete(config, prompt, batch);
    } catch (err) {
      batch.forEach((_att, i) => results.push({ index: start + i, match: null, reason: `Could not classify: ${err.message || err}` }));
      continue;
    }

    let parsed = [];
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      if (!Array.isArray(parsed)) throw new Error("not an array");
    } catch {
      batch.forEach((_att, i) => results.push({ index: start + i, match: null, reason: "Model response could not be parsed." }));
      continue;
    }

    batch.forEach((_att, i) => {
      const entry = parsed.find((p) => p && p.index === i + 1) || {};
      results.push({ index: start + i, match: entry.match === true, reason: (entry.reason || "").toString().slice(0, 200) });
    });
  }
  return results;
}

// --- /compact: history summarization --------------------------------------

// Flattens the neutral block-format history into a plain-text transcript for
// the summarization prompt below. Deliberately lossy (tool results truncated,
// image bytes replaced with a placeholder) — this is a one-way trip to
// produce a briefing, not something ever converted back into structured
// history itself.
function historyToTranscript(history) {
  const lines = [];
  for (const turn of history || []) {
    for (const block of turn.content || []) {
      if (block.type === "text" && block.text) {
        lines.push(`${turn.role === "user" ? "User" : "Assistant"}: ${block.text}`);
      } else if (block.type === "tool_use") {
        lines.push(`[Assistant called ${block.name}(${JSON.stringify(block.input || {}).slice(0, 300)})]`);
      } else if (block.type === "tool_result") {
        let content = block.content;
        try {
          content = JSON.stringify(JSON.parse(content)).slice(0, 500);
        } catch {
          content = String(content ?? "").slice(0, 500);
        }
        lines.push(`[Tool result: ${content}]`);
      } else if (block.type === "image") {
        lines.push("[User attached an image]");
      }
    }
  }
  return lines.join("\n");
}

const SUMMARIZE_HISTORY_PROMPT =
  "Summarize the conversation transcript below into a concise briefing for continuing this exact task later, " +
  "from a fresh context with no memory of these details. Include: what the user originally asked for, what's " +
  "concretely been done or found so far (specific facts, decisions, results — not vague generalities), and " +
  "anything still outstanding or unresolved. Write it as plain prose for the assistant to read, not a transcript. " +
  "Keep it under 300 words.\n\n---\n\n";

// Used by the /compact command and its auto-trigger past a token threshold —
// replaces a long conversation history with a short synthetic exchange
// carrying the gist, so future messages in this chat cost far less to send
// without losing the thread of what's already happened.
export async function summarizeHistory(config, history) {
  // Guards against a pathologically large transcript blowing the summarizer
  // call's own context — 60k chars is generous headroom for a 300-word ask.
  const transcript = historyToTranscript(history).slice(0, 60000);
  return singleTurnComplete(config, `${SUMMARIZE_HISTORY_PROMPT}${transcript}`, []);
}

// Filters out non-chat models (embeddings, audio, image generation, etc.)
// from an OpenAI-compatible /v1/models listing, which mixes every model
// type together with no reliable "capability" field to filter on.
const NON_CHAT_MODEL_PATTERN = /embedding|whisper|tts|dall-e|moderation|davinci|babbage|curie|^ada|image|audio/i;

export async function listModels(config) {
  if (config.provider === "anthropic") {
    const baseUrl = (config.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    const res = await fetchWithRetry(`${baseUrl}/v1/models?limit=100`, {
      headers: {
        "x-api-key": config.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Anthropic models error (${res.status}): ${errText}`);
    }
    const data = await res.json();
    return (data.data || [])
      .map((m) => ({ id: m.id, label: m.display_name || m.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  if (config.provider === "openai") {
    const res = await fetchWithRetry(openaiApiUrl(config.baseUrl, "/models"), {
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(`Models error (${res.status}): ${errText}`);
    }
    const data = await res.json();
    return (data.data || [])
      .map((m) => ({ id: m.id, label: m.id }))
      .filter((m) => !NON_CHAT_MODEL_PATTERN.test(m.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  throw new Error(`Unknown provider: ${config.provider}`);
}
