// lib/pricing.js
// Best-effort $/1M-token pricing for a cost ESTIMATE dashboard — not billing.
// Rates are hand-maintained snapshots and will drift as providers change
// them; this is meant to give the user a rough sense of spend, not an
// authoritative invoice. Local-model / self-hosted OpenAI-compatible
// endpoints (baseUrl set, no known rate) correctly show as "no cost data"
// rather than a guessed number.
//
// Classic (non-module) script, same pattern as lib/markdown.js — sidepanel.js
// is loaded as a plain <script>, not type="module", so this attaches to
// window instead of using ES `export`.
//
// Matching is by substring against the model id, most-specific pattern
// first, so e.g. "claude-3-5-haiku-20241022" matches the "claude-3-5-haiku"
// entry before anything looser could.

(function (global) {
  const PRICING_TABLE = [
    // --- Anthropic (per 1M tokens, USD) ---
    { match: /claude-opus-4/i, label: "Claude Opus 4", inputPerM: 15, outputPerM: 75 },
    { match: /claude-sonnet-4/i, label: "Claude Sonnet 4", inputPerM: 3, outputPerM: 15 },
    { match: /claude-3-7-sonnet/i, label: "Claude 3.7 Sonnet", inputPerM: 3, outputPerM: 15 },
    { match: /claude-3-5-sonnet/i, label: "Claude 3.5 Sonnet", inputPerM: 3, outputPerM: 15 },
    { match: /claude-3-5-haiku/i, label: "Claude 3.5 Haiku", inputPerM: 0.8, outputPerM: 4 },
    { match: /claude-3-opus/i, label: "Claude 3 Opus", inputPerM: 15, outputPerM: 75 },
    { match: /claude-3-haiku/i, label: "Claude 3 Haiku", inputPerM: 0.25, outputPerM: 1.25 },

    // --- OpenAI (per 1M tokens, USD) ---
    { match: /gpt-4\.1-nano/i, label: "GPT-4.1 nano", inputPerM: 0.1, outputPerM: 0.4 },
    { match: /gpt-4\.1-mini/i, label: "GPT-4.1 mini", inputPerM: 0.4, outputPerM: 1.6 },
    { match: /gpt-4\.1/i, label: "GPT-4.1", inputPerM: 2, outputPerM: 8 },
    { match: /gpt-4o-mini/i, label: "GPT-4o mini", inputPerM: 0.15, outputPerM: 0.6 },
    { match: /gpt-4o/i, label: "GPT-4o", inputPerM: 2.5, outputPerM: 10 },
    { match: /\bo4-mini/i, label: "o4-mini", inputPerM: 1.1, outputPerM: 4.4 },
    { match: /\bo3-mini/i, label: "o3-mini", inputPerM: 1.1, outputPerM: 4.4 },
    { match: /\bo3\b/i, label: "o3", inputPerM: 2, outputPerM: 8 },
    { match: /gpt-3\.5-turbo/i, label: "GPT-3.5 Turbo", inputPerM: 0.5, outputPerM: 1.5 },
  ];

  // Returns the matching table row (with a human label + $/1M rates), or
  // null if this model isn't in the hand-maintained list (unknown model,
  // local model, or a naming scheme this table hasn't been updated for).
  function findPricing(model) {
    if (!model) return null;
    for (const row of PRICING_TABLE) {
      if (row.match.test(model)) return row;
    }
    return null;
  }

  // Returns { cost, label } in USD, or null if the model has no known rate.
  function estimateCost(model, inputTokens, outputTokens) {
    const row = findPricing(model);
    if (!row) return null;
    const cost = ((inputTokens || 0) / 1e6) * row.inputPerM + ((outputTokens || 0) / 1e6) * row.outputPerM;
    return { cost, label: row.label };
  }

  function formatCost(cost) {
    if (cost < 0.01) return `<$0.01`;
    return `$${cost.toFixed(2)}`;
  }

  global.TabAgentPricing = { findPricing, estimateCost, formatCost };
})(window);
