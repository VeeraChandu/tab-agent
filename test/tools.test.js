import { TOOLS, SYSTEM_PROMPT, buildSystemPrompt } from "../src/lib/tools.js";

describe("TOOLS schema", () => {
  test("every tool has a unique name, a description, and a JSON-schema input_schema", () => {
    const names = new Set();
    for (const tool of TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);

      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);

      expect(tool.input_schema).toBeDefined();
      expect(tool.input_schema.type).toBe("object");
      expect(Array.isArray(tool.input_schema.required)).toBe(true);
      // Every required field must actually be declared in properties.
      for (const req of tool.input_schema.required) {
        expect(tool.input_schema.properties).toHaveProperty(req);
      }
    }
  });

  test("includes the core tools the agent loop depends on by name", () => {
    const names = TOOLS.map((t) => t.name);
    for (const expected of ["read_page", "click", "type_text", "select_option", "scroll", "navigate", "finish"]) {
      expect(names).toContain(expected);
    }
  });
});

describe("buildSystemPrompt", () => {
  test("starts with the base SYSTEM_PROMPT and stamps today's date when there is no agent context", () => {
    for (const result of [buildSystemPrompt(undefined), buildSystemPrompt(null), buildSystemPrompt(null, "")]) {
      expect(result.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(result).toMatch(/Today's date is/);
    }
  });

  test("layers agent instructions on top of the base prompt", () => {
    const result = buildSystemPrompt({ name: "Test Agent", instructions: "Only ever answer in haiku." });
    expect(result.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(result).toContain('running as the "Test Agent" agent');
    expect(result).toContain("Only ever answer in haiku.");
  });

  test("appends custom instructions section without agent context", () => {
    const result = buildSystemPrompt(null, "Always include source links.");
    expect(result).toContain("## Custom instructions");
    expect(result).toContain("Always include source links.");
  });

  test("appends custom instructions after agent context when both are given", () => {
    const result = buildSystemPrompt({ name: "Agent X" }, "Be concise.");
    expect(result).toContain('running as the "Agent X" agent');
    expect(result).toContain("## Custom instructions");
    expect(result).toContain("Be concise.");
    // Custom instructions should come after the agent section
    const agentIdx = result.indexOf("Agent X");
    const customIdx = result.indexOf("## Custom instructions");
    expect(customIdx).toBeGreaterThan(agentIdx);
  });

  test("omits custom instructions section when empty", () => {
    const result = buildSystemPrompt({ name: "Agent X" });
    expect(result).not.toContain("## Custom instructions");
  });
});
