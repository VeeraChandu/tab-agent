// lib/sessionRecorder.js
/* global chrome */
// Per-step visual recording for replay: captures a thumbnail screenshot on
// every tool execution so a finished/stopped run can be reviewed as a visual
// filmstrip. Recordings are stored in chrome.storage.local as
// recording_<sessionId>_<step> keys, auto-pruned when the session is deleted.
//
// Only captures visible/active tabs — branches running in background tabs
// during parallel_investigate quietly skip (can't capture an inactive tab).

const REC_PREFIX = "recording_";
const REC_INDEX_SUFFIX = "_index"; // recording_<sessionId>_index -> array of step numbers
const THUMB_QUALITY = 35; // JPEG quality — small files, good enough for thumbnails

/**
 * Initialize a recording index for a session. Safe to call multiple times.
 */
export async function startRecording(sessionId) {
  const key = `${REC_PREFIX}${sessionId}${REC_INDEX_SUFFIX}`;
  const existing = await chrome.storage.local.get(key);
  if (!existing[key]) {
    await chrome.storage.local.set({ [key]: [] });
  }
}

/**
 * Capture one step: screenshot + metadata.
 *
 * @param {object} opts
 * @param {string}  opts.sessionId
 * @param {number}  opts.step          1-based step number
 * @param {string}  [opts.callId]      tool_use id
 * @param {string}  opts.toolName
 * @param {object}  [opts.toolInput]
 * @param {object}  [opts.toolResult]  only ok/error are kept, not full payload
 * @param {string}  [opts.url]         URL the tool ran on (the tab's current URL)
 * @returns {Promise<{step: number, hasScreenshot: boolean}>}
 */
export async function captureStep({ sessionId, step, callId, toolName, toolInput, toolResult, url }) {
  let screenshot = null;
  try {
    // captureVisibleTab with no windowId captures the current window's active tab
    screenshot = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: THUMB_QUALITY });
  } catch {
    // Tab isn't active/visible — skip screenshot, still record metadata
  }

  const frame = {
    step,
    callId: callId || null,
    toolName,
    toolInput: toolInput ? { ...toolInput } : null,
    toolResult: toolResult ? { ok: toolResult.ok, error: toolResult.error ?? null } : null,
    url: url || null,
    screenshot, // null when capture wasn't possible
    ts: Date.now(),
  };

  const key = `${REC_PREFIX}${sessionId}_${step}`;
  await chrome.storage.local.set({ [key]: frame });

  // Append step to the session's index
  const idxKey = `${REC_PREFIX}${sessionId}${REC_INDEX_SUFFIX}`;
  const stored = await chrome.storage.local.get(idxKey);
  const index = stored[idxKey] || [];
  if (!index.includes(step)) {
    index.push(step);
    await chrome.storage.local.set({ [idxKey]: index });
  }

  return { step, hasScreenshot: !!screenshot };
}

/**
 * Return every recorded frame for a session, ordered by step.
 * Screenshots are included inline (base64 JPEG, ~10-30 KB each).
 */
export async function getRecording(sessionId) {
  const idxKey = `${REC_PREFIX}${sessionId}${REC_INDEX_SUFFIX}`;
  const stored = await chrome.storage.local.get(idxKey);
  const index = stored[idxKey] || [];
  if (!index.length) return [];

  const keys = index.map((s) => `${REC_PREFIX}${sessionId}_${s}`);
  const frames = await chrome.storage.local.get(keys);
  return index
    .map((s) => frames[`${REC_PREFIX}${sessionId}_${s}`])
    .filter(Boolean)
    .sort((a, b) => a.step - b.step);
}

/**
 * Delete a session's entire recording.
 */
export async function deleteRecording(sessionId) {
  const idxKey = `${REC_PREFIX}${sessionId}${REC_INDEX_SUFFIX}`;
  const stored = await chrome.storage.local.get(idxKey);
  const index = stored[idxKey] || [];
  const keys = index.map((s) => `${REC_PREFIX}${sessionId}_${s}`);
  keys.push(idxKey);
  if (keys.length) await chrome.storage.local.remove(keys);
}

/**
 * Estimate storage used by a recording (bytes of screenshot data).
 */
export async function recordingByteSize(sessionId) {
  const frames = await getRecording(sessionId);
  let total = 0;
  for (const f of frames) {
    if (f.screenshot) total += f.screenshot.length;
  }
  return total;
}
