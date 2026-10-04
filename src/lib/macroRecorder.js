// lib/macroRecorder.js
// Record user actions (clicks, typing, selects) on a tab and replay them as
// an automated macro sequence. Macros are stored as named sequences of
// { action, target, value } steps that get converted to tool calls on replay.

const RECORDING_KEY = "macroRecording"; // per-tab recording state (volatile)
const MACROS_KEY = "savedMacros";       // persisted named macros

// --- recording (volatile, per session) ---

/** Active recording state, keyed by tabId. Not persisted — lost on service
 *  worker restart (MV3), which is fine since recording is a live activity. */
const activeRecordings = new Map(); // tabId -> { steps: [], startedAt }

/** Start recording user actions on a given tab. */
export function startRecording(tabId) {
  if (activeRecordings.has(tabId)) return { ok: false, error: "Already recording on this tab." };
  activeRecordings.set(tabId, { steps: [], startedAt: Date.now() });
  return { ok: true };
}

/** Stop recording and return the captured steps. */
export function stopRecording(tabId) {
  const state = activeRecordings.get(tabId);
  if (!state) return { ok: false, error: "Not recording on this tab.", steps: [] };
  activeRecordings.delete(tabId);
  return { ok: true, steps: state.steps };
}

/** Get the current recording state (for checking if recording is active). */
export function isRecording(tabId) {
  return activeRecordings.has(tabId);
}

/** Append a user action to the current recording. */
export function recordAction(tabId, action) {
  const state = activeRecordings.get(tabId);
  if (!state) return false;
  state.steps.push({ ...action, ts: Date.now() });
  return true;
}

// --- macro storage (persistent) ---

/** Load all saved macros. */
async function getMacros() {
  try {
    const data = await chrome.storage.local.get([MACROS_KEY]);
    return data[MACROS_KEY] || {};
  } catch {
    return {};
  }
}

/** Save a named macro from recorded steps. */
export async function saveMacro(name, steps) {
  const macros = await getMacros();
  macros[name] = { name, steps, createdAt: Date.now(), updatedAt: Date.now() };
  await chrome.storage.local.set({ [MACROS_KEY]: macros });
}

/** Delete a saved macro. */
export async function deleteMacro(name) {
  const macros = await getMacros();
  delete macros[name];
  await chrome.storage.local.set({ [MACROS_KEY]: macros });
}

/** List saved macro names. */
export async function listMacros() {
  const macros = await getMacros();
  return Object.values(macros);
}

// --- playback ---

/** Convert a recorded user action to a tool call input. Normalizes different
 *  ways users can interact (click, type, select) into the tool format. */
function actionToToolCall(step) {
  switch (step.action) {
    case "click":
      return {
        name: "click",
        input: { element_id: step.target, element_text: step.text, element_tag: step.tag },
      };
    case "type":
      return {
        name: "type_text",
        input: { element_id: step.target, text: step.value },
      };
    case "select":
      return {
        name: "select_option",
        input: { element_id: step.target, values: [step.value] },
      };
    case "press_key":
      return {
        name: "press_key",
        input: { key: step.value, element_id: step.element_id },
      };
    case "navigate":
      return {
        name: "navigate",
        input: { url: step.value },
      };
    default:
      return null;
  }
}

/** Play back a macro by sending PLAY_MACRO_STEP events to the side panel
 *  so it can feed each step back as a tool call. Returns { ok, completed, total }. */
export async function playMacro(macroName, ctx, onEvent) {
  const macros = await getMacros();
  const macro = macros[macroName];
  if (!macro) return { ok: false, error: `Macro "${macroName}" not found.` };
  if (!macro.steps || macro.steps.length === 0) return { ok: true, completed: 0, total: 0 };

  let completed = 0;
  for (const step of macro.steps) {
    const toolCall = actionToToolCall(step);
    if (!toolCall) {
      await onEvent({ type: "macro_step_skip", reason: `Unknown action: ${step.action}` });
      continue;
    }
    await onEvent({ type: "macro_step", name: toolCall.name, input: toolCall.input, index: completed, total: macro.steps.length });
    try {
      const { executeTool } = await import("./agentLoop.js");
      const result = await executeTool(ctx, toolCall.name, toolCall.input, `macro-${macroName}-${completed}`);
      await onEvent({ type: "macro_step_result", index: completed, ok: result?.ok, error: result?.error });
      completed++;
    } catch (err) {
      await onEvent({ type: "macro_step_error", index: completed, error: String(err) });
      return { ok: false, completed, total: macro.steps.length, error: String(err) };
    }
  }
  return { ok: true, completed, total: macro.steps.length };
}
