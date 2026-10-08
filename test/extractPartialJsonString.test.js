import { extractPartialJsonString } from "../src/lib/providers.js";

test("returns null before the field's opening quote arrives", () => {
  expect(extractPartialJsonString('{"answ', "answer")).toBeNull();
  expect(extractPartialJsonString('{"answer": ', "answer")).toBeNull();
});

test("returns the in-progress value while streaming", () => {
  expect(extractPartialJsonString('{"answer": "The capital of Fra', "answer")).toBe("The capital of Fra");
});

test("stops at the closing quote once the value is complete", () => {
  expect(extractPartialJsonString('{"answer": "Paris.", "success": true}', "answer")).toBe("Paris.");
});

test("unescapes standard JSON escapes and \\uXXXX", () => {
  expect(extractPartialJsonString('{"answer": "line1\\nline2 \\u00e9"', "answer")).toBe("line1\nline2 é");
});

test("withholds a trailing incomplete escape until more input arrives", () => {
  expect(extractPartialJsonString('{"answer": "abc\\', "answer")).toBe("abc");
  expect(extractPartialJsonString('{"answer": "abc\\u00e', "answer")).toBe("abc");
});

test("ignores unrelated fields", () => {
  expect(extractPartialJsonString('{"success": true', "answer")).toBeNull();
});
