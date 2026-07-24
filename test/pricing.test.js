// lib/pricing.js is a classic (non-module) script — see the note in
// test/markdown.test.js and CLAUDE.md's "Module system" section.
require("../src/lib/pricing.js");
const { findPricing, estimateCost, formatCost } = window.TabAgentPricing;

describe("findPricing", () => {
  test("returns null for falsy or unknown model ids", () => {
    expect(findPricing("")).toBeNull();
    expect(findPricing(null)).toBeNull();
    expect(findPricing("some-unlisted-local-model")).toBeNull();
  });

  test("matches the most specific pattern first (haiku vs opus vs sonnet)", () => {
    expect(findPricing("claude-3-5-haiku-20241022").label).toBe("Claude 3.5 Haiku");
    expect(findPricing("claude-3-opus-20240229").label).toBe("Claude 3 Opus");
    expect(findPricing("claude-3-5-sonnet-20241022").label).toBe("Claude 3.5 Sonnet");
  });

  test("matches known OpenAI model families", () => {
    expect(findPricing("gpt-4o-mini").label).toBe("GPT-4o mini");
    expect(findPricing("gpt-4.1-nano").label).toBe("GPT-4.1 nano");
  });
});

describe("estimateCost", () => {
  test("returns null when the model has no known rate", () => {
    expect(estimateCost("unknown-model", 1000, 1000)).toBeNull();
  });

  test("computes cost from per-1M-token input/output rates", () => {
    // Claude 3.5 Haiku: $0.8/1M in, $4/1M out.
    const { cost, label } = estimateCost("claude-3-5-haiku-20241022", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.8 + 4, 5);
    expect(label).toBe("Claude 3.5 Haiku");
  });

  test("treats missing token counts as zero", () => {
    const { cost } = estimateCost("claude-3-5-haiku-20241022", undefined, undefined);
    expect(cost).toBe(0);
  });
});

describe("formatCost", () => {
  test("shows a <$0.01 floor for very small amounts", () => {
    expect(formatCost(0.0001)).toBe("<$0.01");
  });

  test("formats larger amounts to two decimal places", () => {
    expect(formatCost(1.2345)).toBe("$1.23");
    expect(formatCost(0.5)).toBe("$0.50");
  });
});
