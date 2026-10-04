// tests for the context-window budget estimation in lib/agentLoop.js

import { estimateContextTokens } from "../src/lib/agentLoop.js";

describe("estimateContextTokens", () => {
  test("empty history and no system prompt", () => {
    expect(estimateContextTokens([], "")).toBe(0);
  });

  test("system prompt contributes to estimate", () => {
    const val = estimateContextTokens([], "hello world");
    expect(val).toBeGreaterThan(0);
    // "hello world" / 3.5 = ~3.14, ceil = 4
    expect(val).toBe(4);
  });

  test("text blocks are counted", () => {
    const history = [
      { role: "user", content: [{ type: "text", text: "This is a test message with some content." }] },
      { role: "assistant", content: [{ type: "text", text: "And this is the reply." }] },
    ];
    const val = estimateContextTokens(history, "");
    expect(val).toBeGreaterThan(0);
    // Each turn adds 10 overhead, plus text chars / 3.5
  });

  test("tool results contribute their JSON content", () => {
    const bigResult = JSON.stringify({ ok: true, data: "x".repeat(1000) });
    const history = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_page", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: bigResult }] },
    ];
    const val = estimateContextTokens(history, "");
    // Two turns = 20 overhead, tool_use name "read_page" = 8, {} = ~0,
    // tool_result content = 1000 / 3.5
    expect(val).toBeGreaterThan(280);
    expect(val).toBeLessThan(330);
  });

  test("image blocks get a fixed estimate", () => {
    const history = [
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "abcdef" } }] },
    ];
    // 500 (image) + 10 (turn overhead) = 510
    expect(estimateContextTokens(history, "")).toBe(510);
  });

  test("large history stays proportional", () => {
    const manyTurns = [];
    for (let i = 0; i < 20; i++) {
      manyTurns.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "read_page", input: {} }] });
      manyTurns.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: JSON.stringify({ ok: true, text: "x".repeat(2000) }) }] });
    }
    // 20 pairs = 40 turns * 10 overhead = 400
    // 20 tool_use * (ceil(2 chars input/3.5) + 8 name) = 20 * 9 = 180
    // 20 tool_result * (2008 chars / 3.5) = 20 * 574 = 11480
    // system prompt "system prompt" = ceil(13/3.5) = 4
    // Total ~ 400 + 180 + 11480 + 4 = 12064
    const val = estimateContextTokens(manyTurns, "system prompt");
    expect(val).toBeGreaterThan(11000);
    expect(val).toBeLessThan(14000);
  });
});
