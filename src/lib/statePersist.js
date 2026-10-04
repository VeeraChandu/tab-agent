// lib/statePersist.js
/* global chrome, setTimeout, URL, btoa */
// Save and restore a tab's cookies + localStorage across runs, keyed by
// sessionId. Meant to be called explicitly — the model can use
// save_session_state / restore_session_state tools, or a run can
// auto-restore on startup.
//
// Cookies go through chrome.cookies (MV3 extension API). localStorage is
// read/written via the content script.
//
// Stored as:
//   persistCookies_<sessionId>_<originHash>  -> Cookie[] (JSON)
//   persistLocalStorage_<sessionId>_<originHash>  -> { [key]: string }

// Inline sendToTab helper — avoids a circular dependency with agentLoop.js.
function sendToTab(tabId, message, frameId = 0) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: frameId || 0 }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: "No response from content script" });
      }
    });
    // 5s safety timeout
    setTimeout(() => resolve({ ok: false, error: "Timed out waiting for content script" }), 5000);
  });
}

const PREFIX = "persist_";
const MAX_COOKIES_PER_ORIGIN = 200;

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

async function getCookies(origin) {
  const all = await chrome.cookies.getAll({ url: origin });
  // Filter out session cookies (those without an expiry) — they're
  // meaningless to restore since the session died anyway.
  return all.filter((c) => c.session === false).slice(0, MAX_COOKIES_PER_ORIGIN);
}

async function setCookies(origin, cookies) {
  for (const c of cookies) {
    try {
      await chrome.cookies.set({
        url: origin,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        secure: c.secure ?? false,
        httpOnly: c.httpOnly ?? false,
        sameSite: c.sameSite || "unspecified",
        expirationDate: c.expirationDate,
      });
    } catch {
      // Best-effort per cookie; some may fail (e.g. httpOnly from a
      // different extension's perspective). Silently skip.
    }
  }
}

async function getLocalStorage(tabId, frameId) {
  const res = await sendToTab(tabId, { type: "GET_LOCAL_STORAGE" }, frameId, null);
  if (!res.ok || !res.data) return {};
  return res.data;
}

async function setLocalStorage(tabId, frameId, data) {
  await sendToTab(tabId, { type: "SET_LOCAL_STORAGE", data }, frameId, null);
}

// --- Public API ---------------------------------------------------------

/**
 * Save cookies + localStorage for every origin present in the given tab.
 * @param {number} tabId
 * @param {string} sessionId
 * @param {number} [frameId=0]
 */
export async function saveTabState(tabId, sessionId, frameId = 0) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return { ok: false, error: "Cannot access tab" };

  const origin = originOf(tab.url);
  if (!origin) return { ok: false, error: "Cannot determine tab origin" };

  const originHash = btoa(origin); // simple encoding, not cryptographic

  // Cookies
  const cookies = await getCookies(origin);
  const cookieKey = `${PREFIX}cookies_${sessionId}_${originHash}`;

  // localStorage
  let ls = {};
  try {
    ls = await getLocalStorage(tabId, frameId);
  } catch { /* best-effort */ }
  const lsKey = `${PREFIX}localStorage_${sessionId}_${originHash}`;

  const toSet = {};
  if (cookies.length) toSet[cookieKey] = cookies;
  if (Object.keys(ls).length) toSet[lsKey] = ls;

  if (Object.keys(toSet).length) {
    await chrome.storage.local.set(toSet);
  }

  // Record which origins were saved (for cleanup & dedup)
  const idxKey = `${PREFIX}index_${sessionId}`;
  const stored = await chrome.storage.local.get(idxKey);
  const index = stored[idxKey] || [];
  if (!index.find((e) => e.origin === origin)) {
    index.push({ origin, originHash, cookieKey, lsKey });
    await chrome.storage.local.set({ [idxKey]: index });
  }

  return {
    ok: true,
    origins: [origin],
    cookies_saved: cookies.length,
    localStorage_keys: Object.keys(ls).length,
  };
}

/**
 * Restore cookies + localStorage previously saved for a session.
 * Applies all saved origins to the given tab.
 * @param {number} tabId
 * @param {string} sessionId
 * @param {number} [frameId=0]
 */
export async function restoreTabState(tabId, sessionId, frameId = 0) {
  const idxKey = `${PREFIX}index_${sessionId}`;
  const stored = await chrome.storage.local.get(idxKey);
  const index = stored[idxKey] || [];
  if (!index.length) return { ok: false, error: "No saved state for this session" };

  for (const entry of index) {
    // Restore cookies
    const cookieData = await chrome.storage.local.get(entry.cookieKey);
    if (cookieData[entry.cookieKey]) {
      await setCookies(entry.origin, cookieData[entry.cookieKey]);
    }

    // Restore localStorage — only works if the tab is on this origin
    const lsData = await chrome.storage.local.get(entry.lsKey);
    if (lsData[entry.lsKey]) {
      try {
        await setLocalStorage(tabId, frameId, lsData[entry.lsKey]);
      } catch { /* best-effort */ }
    }
  }

  return { ok: true, origins_restored: index.length };
}

/**
 * Check whether a session has saved state.
 */
export async function hasSavedState(sessionId) {
  const idxKey = `${PREFIX}index_${sessionId}`;
  const stored = await chrome.storage.local.get(idxKey);
  return !!(stored[idxKey]?.length);
}

/**
 * Delete all saved state for a session.
 */
export async function deleteSessionState(sessionId) {
  const idxKey = `${PREFIX}index_${sessionId}`;
  const stored = await chrome.storage.local.get(idxKey);
  const index = stored[idxKey] || [];
  const keys = [idxKey];
  for (const entry of index) {
    keys.push(entry.cookieKey, entry.lsKey);
  }
  await chrome.storage.local.remove(keys);
}
