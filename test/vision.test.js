import { looksVisionCapable } from "../src/lib/vision.js";

describe("looksVisionCapable", () => {
  test("returns false for falsy input", () => {
    expect(looksVisionCapable("")).toBe(false);
    expect(looksVisionCapable(null)).toBe(false);
    expect(looksVisionCapable(undefined)).toBe(false);
  });

  test("recognizes known vision-capable model families", () => {
    expect(looksVisionCapable("gpt-4o")).toBe(true);
    expect(looksVisionCapable("gpt-4o-mini")).toBe(true);
    expect(looksVisionCapable("gpt-4.1")).toBe(true);
    expect(looksVisionCapable("claude-3-5-sonnet-20241022")).toBe(true);
    expect(looksVisionCapable("claude-sonnet-4-20250514")).toBe(true);
    expect(looksVisionCapable("gemini-1.5-pro")).toBe(true);
  });

  test("treats unrecognized models as not vision-capable (conservative default)", () => {
    expect(looksVisionCapable("some-custom-local-model")).toBe(false);
    expect(looksVisionCapable("llama-3-8b")).toBe(false);
  });

  test("text-only hint patterns win even if a vision-ish substring is nearby", () => {
    expect(looksVisionCapable("text-embedding-3-large")).toBe(false);
    expect(looksVisionCapable("whisper-1")).toBe(false);
    expect(looksVisionCapable("gpt-3.5-turbo-instruct")).toBe(false);
  });
});
