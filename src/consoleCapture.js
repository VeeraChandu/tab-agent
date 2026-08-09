// consoleCapture.js
// Runs in the page's own MAIN world (see manifest.json's "world": "MAIN"
// entry) — wrapping console.error/alert/confirm/etc from content.js's
// isolated world would never see the page's own calls, since an
// isolated-world content script shares the DOM with the page but not its JS
// heap (window.console/window.alert there are different objects). read_page
// drains both buffers below via a separate world:"MAIN"
// chrome.scripting.executeScript call (see readCapturedEvents in
// lib/agentLoop.js) for the same reason: the isolated-world content script
// can't read these window properties back out directly either.
(() => {
  if (window.__tabAgentConsoleBuffer) return;
  window.__tabAgentConsoleBuffer = [];
  const MAX_ENTRIES = 50;

  function record(level, message) {
    const buf = window.__tabAgentConsoleBuffer;
    buf.push({ level, message: String(message).slice(0, 500) });
    if (buf.length > MAX_ENTRIES) buf.shift();
  }

  function stringifyArg(a) {
    if (a instanceof Error) return a.message;
    if (typeof a !== "object" || a === null) return String(a);
    try {
      return JSON.stringify(a);
    } catch {
      return String(a); // circular reference (e.g. a logged DOM node) — JSON.stringify throws
    }
  }

  for (const level of ["error", "warn"]) {
    const original = console[level];
    console[level] = (...args) => {
      // Capturing must never be why the page's OWN console.error/warn call
      // doesn't happen - a page logging something unusual (a DOM node, a
      // getter that throws) must not silently lose its real log output.
      try {
        record(level, args.map(stringifyArg).join(" "));
      } catch { /* never let capture break the page's own logging */ }
      original.apply(console, args);
    };
  }

  window.addEventListener("error", (e) => record("error", e.message || String(e.error)));
  window.addEventListener("unhandledrejection", (e) => record("error", `Unhandled promise rejection: ${e.reason?.message || e.reason}`));

  // A native alert()/confirm()/prompt() blocks the page's OWN JS thread
  // until a human clicks it — which also blocks content.js's response to
  // whatever click/type_text triggered it, freezing the whole agent run at
  // the 12s sendToTab timeout with no way to dismiss it (an extension has no
  // way to click a native dialog without chrome.debugger). Replacing these
  // outright (not forwarding to the original, unlike console above) is the
  // point: it resolves the dialog before it can ever block anything, the
  // same auto-accept default Playwright and Chrome DevTools both use.
  window.__tabAgentDialogBuffer = [];
  function recordDialog(kind, message) {
    const buf = window.__tabAgentDialogBuffer;
    buf.push({ kind, message: String(message ?? "").slice(0, 500) });
    if (buf.length > MAX_ENTRIES) buf.shift();
  }
  window.alert = (message) => { recordDialog("alert", message); };
  window.confirm = (message) => { recordDialog("confirm", message); return true; };
  window.prompt = (message) => { recordDialog("prompt", message); return null; };
})();
