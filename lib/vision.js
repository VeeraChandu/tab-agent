// lib/vision.js
// Best-effort heuristic for whether a model id likely supports image input.
// Neither Anthropic's nor OpenAI-compatible /v1/models responses reliably
// expose a "supports vision" capability flag, so this is a name-based guess
// — conservative on purpose: anything not clearly recognized is treated as
// NOT vision-capable, so the vision-fallback path (if configured) kicks in
// rather than silently sending images to a model that will ignore them.

const VISION_HINT_PATTERNS = [
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4-turbo/i,
  /gpt-4-vision/i,
  /\bo3\b/i,
  /\bo4/i,
  /claude-3/i,
  /claude-sonnet/i,
  /claude-opus/i,
  /claude-haiku/i,
  /gemini/i,
  /vision/i,
  /pixtral/i,
  /llava/i,
];

const TEXT_ONLY_HINT_PATTERNS = [
  /embedding/i,
  /whisper/i,
  /\btts\b/i,
  /moderation/i,
  /^o1-mini/i,
  /^gpt-3\.5/i,
  /instruct/i,
  /babbage/i,
  /davinci/i,
  /curie/i,
  /^ada\b/i,
];

export function looksVisionCapable(modelId) {
  if (!modelId) return false;
  if (TEXT_ONLY_HINT_PATTERNS.some((re) => re.test(modelId))) return false;
  if (VISION_HINT_PATTERNS.some((re) => re.test(modelId))) return true;
  return false;
}
