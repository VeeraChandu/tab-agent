// lib/customTools.js
// Extensible tool system: lets users define their own tools (name, schema,
// handler) without editing the extension source. Custom tools are stored in
// chrome.storage.local under the key "customTools", merged into the system
// prompt at startup, and dispatched from executeTool.

/**
 * Saved in storage as:
 *   customTools = { "my_tool": { name, description, input_schema, handler } }
 *
 * handler is stored as a string (the function body) and eval'd at runtime.
 * It receives (ctx, input) and must return a result object.
 */

const STORAGE_KEY = "customTools";

/** Load all custom tool definitions from storage. */
export async function getCustomTools() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return data[STORAGE_KEY] || {};
  } catch {
    return {};
  }
}

/** Save a single custom tool (upserts by name). */
export async function saveCustomTool(name, toolDef) {
  const tools = await getCustomTools();
  tools[name] = { name, ...toolDef };
  await chrome.storage.local.set({ [STORAGE_KEY]: tools });
}

/** Remove a custom tool by name. */
export async function removeCustomTool(name) {
  const tools = await getCustomTools();
  delete tools[name];
  await chrome.storage.local.set({ [STORAGE_KEY]: tools });
}

/** Build the handler function from a stored string body. Returns a no-op
 *  error handler if the function body is invalid. */
function buildHandler(raw) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function("ctx", "input", raw);
  } catch {
    return () => ({ ok: false, error: "Invalid custom tool handler (parse error)." });
  }
}

/** Execute a custom tool. Returns the result of the handler, or
 *  { _notFound: true } if no custom tool with this name is registered. */
export async function executeCustomTool(ctx, name, input) {
  const tools = await getCustomTools();
  const def = tools[name];
  if (!def) return { _notFound: true };
  if (!def.handler) return { ok: false, error: `Custom tool "${name}" has no handler.` };
  try {
    const handler = buildHandler(def.handler);
    const result = await handler(ctx, input);
    return result ?? { ok: true };
  } catch (err) {
    return { ok: false, error: `Custom tool "${name}" threw: ${err.message || err}` };
  }
}

/** Get the tool definition array (for merging into TOOLS / system prompt). */
export async function getCustomToolDefs() {
  const tools = await getCustomTools();
  return Object.values(tools).map((t) => ({
    name: t.name,
    description: t.description || `Custom tool: ${t.name}`,
    input_schema: t.input_schema || { type: "object", properties: {} },
  }));
}
