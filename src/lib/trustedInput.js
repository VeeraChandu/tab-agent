// lib/trustedInput.js
// The one MV3 path to input events a page can't tell apart from a real
// human: chrome.debugger + the Input.* CDP domain. Everywhere else in this
// codebase, click dispatches synthetic DOM events (isTrusted: false) - which
// some sites' own listeners check for and silently ignore (payment widgets,
// anti-bot form guards), reported back as an inert page_changed: false with
// no diagnosis of why. This is a narrow fallback for exactly that case, not
// the default path: it shows Chrome's own "being debugged" infobar on the
// tab while attached, so even though "debugger" is a required permission
// (granted at install - Chrome doesn't allow it to be requested/revoked at
// runtime via chrome.permissions), actually USING it is still gated behind
// a Settings toggle (see options.html/js), off by default. Only ever
// attaches for the single click it's dispatching, detaching immediately
// after regardless of success or failure. Click only for now (see the one
// call site in agentLoop.js's "click" case) - type_text's own untrusted-
// input risk exists too, just not wired to this yet.

const PROTOCOL_VERSION = "1.3";

// Dispatches a real, trusted left-click at the given viewport coordinates
// (main-frame coordinate space only - see agentLoop.js's frameId guard on
// the only caller). Always detaches in a finally, even on failure, so a
// rejected attach/command never leaves the "being debugged" infobar stuck on.
export async function dispatchTrustedClick(tabId, x, y) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
  } catch (err) {
    // Most commonly: real DevTools is already open on this tab, or another
    // extension already has it attached - neither is fixable here.
    return { ok: false, error: `Could not attach for trusted input: ${err.message || err}` };
  }
  try {
    const mouseEvent = { x, y, button: "left", clickCount: 1 };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...mouseEvent, type: "mousePressed" });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { ...mouseEvent, type: "mouseReleased" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Trusted click failed: ${err.message || err}` };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}
