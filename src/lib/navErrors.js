// lib/navErrors.js
// Tracks the actual network failure behind a navigation. A DNS failure or
// refused connection leaves tab.url pointing at the target while the
// rendered document is Chrome's own net-error page - content scripts can't
// run there, which looks IDENTICAL to a genuinely restricted page from
// ensureContentScript's point of view. Without this, agentLoop.js reports a
// wrong diagnosis ("restricted page") pointing away from the real problem.
// Must be started synchronously at service worker load, same MV3 listener-
// registration constraint as mediaSniffer.js (see its own comment).

const lastErrorByTab = new Map(); // tabId -> { error, url, at }

export function getLastNavError(tabId) {
  return lastErrorByTab.get(tabId) || null;
}

let started = false;

export function startNavErrorTracking() {
  if (started) return;
  started = true;

  chrome.webNavigation.onErrorOccurred.addListener((details) => {
    if (details.frameId !== 0) return; // only the top-level nav is what read_page/navigate/open_tab act on
    lastErrorByTab.set(details.tabId, { error: details.error, url: details.url, at: Date.now() });
  });

  // A later successful commit means whatever failed before is stale.
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    lastErrorByTab.delete(details.tabId);
  });

  chrome.tabs.onRemoved.addListener((tabId) => lastErrorByTab.delete(tabId));
}
