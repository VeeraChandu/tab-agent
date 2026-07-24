// lib/mediaSniffer.js
// Passive, per-tab capture of network requests that look like a direct media
// stream (HLS/DASH manifests, segments, or a plain video/audio file) — the
// only reliable way to find a stream URL that a player never writes into the
// DOM at all (fetched by JS and piped straight into a <video>/MediaSource,
// e.g. via hls.js). read_page can't see this no matter how good the page
// scan is, because there's nothing on the page to scan.
//
// This module owns the chrome.webRequest listener and the buffer; it does
// NOT touch the DOM or talk to content.js. startMediaSniffer() must be
// called once, synchronously, at service worker load time (background.js
// does this) — MV3 service workers only get to register listeners during
// their initial evaluation, not lazily inside a later async callback.

const MAX_PER_TAB = 30;

// details.type === "media" is the direct signal Chrome gives for an actual
// <video>/<audio> fetch, but HLS/DASH manifests and segments are usually
// fetched by the player's own JS via fetch()/XHR, which webRequest reports
// as "xmlhttprequest" or "other" — so extension/content-type matching below
// catches those that the resourceType check alone would miss.
const MEDIA_EXT_RE = /\.(m3u8|mpd|ts|m4s|mp4|m4v|webm|mkv|flv|m4a|aac|ogg)(\?|#|$)/i;
const MEDIA_CONTENT_TYPE_RE = /^(video\/|audio\/)|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|vnd\.ms-sstr\+xml)/i;

// Narrower than the two patterns above — just the actual manifest/playlist,
// not every segment/chunk a player fetches. Used only to decide eviction
// priority below, so a manifest never gets pushed out of the buffer just
// because a stream is actively downloading dozens of .ts/.m4s segments.
const MANIFEST_EXT_RE = /\.(m3u8|mpd)(\?|#|$)/i;
const MANIFEST_CONTENT_TYPE_RE = /application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|vnd\.ms-sstr\+xml)/i;

function isManifestEntry(entry) {
  return MANIFEST_CONTENT_TYPE_RE.test(entry.contentType || "") || MANIFEST_EXT_RE.test(entry.url || "");
}

/**
 * Pure classifier, kept separate from the webRequest listener so it's
 * testable without a real chrome.webRequest environment.
 * @param {{url: string, type?: string, contentType?: string}} details
 * @returns {boolean}
 */
export function isMediaRequest({ url, type, contentType }) {
  if (type === "media") return true;
  if (contentType && MEDIA_CONTENT_TYPE_RE.test(contentType)) return true;
  if (url && MEDIA_EXT_RE.test(url)) return true;
  return false;
}

function getContentType(responseHeaders) {
  const header = (responseHeaders || []).find((h) => h.name.toLowerCase() === "content-type");
  return header ? header.value : null;
}

// tabId -> array of { url, contentType, resourceType, seenAt }, most recent
// first, capped at MAX_PER_TAB. Not persisted to chrome.storage — this is
// live/session-only, like assistant_delta broadcasts, so a killed/restarted
// service worker just starts with an empty buffer rather than surfacing
// stale links from before the restart.
const buffersByTab = new Map();

// tabId -> hostname of the last top-level navigation we saw. Used to only
// clear a tab's buffer when it genuinely leaves a site, not on every
// onCommitted — an agent retrying the same player URL, re-navigating after
// a restricted-page dead end, or a site's own internal redirect chain all
// fire onCommitted repeatedly without the user/agent actually leaving the
// page they're working with, and wiping the buffer each time was throwing
// away a manifest/segment URL captured moments earlier, before the agent
// even got a chance to call list_media_requests.
const lastHostByTab = new Map();

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Exported (like isMediaRequest above) so the eviction-priority behavior is
// directly testable without a real chrome.webRequest environment.
export function recordMediaRequest(tabId, entry) {
  if (typeof tabId !== "number" || tabId < 0) return; // not a real tab (e.g. -1 for non-tab requests)
  let list = buffersByTab.get(tabId);
  if (!list) {
    list = [];
    buffersByTab.set(tabId, list);
  }
  if (list.some((e) => e.url === entry.url)) return; // same manifest/segment re-requested — keep the first sighting
  list.unshift(entry);
  if (list.length > MAX_PER_TAB) {
    // A manifest is usually the FIRST thing captured for a stream, and an
    // HLS/DASH player then fetches dozens of individual segment URLs right
    // after it — with a plain "always drop the oldest" trim, that flood of
    // segments pushes the manifest itself off the end within moments, right
    // when list_media_requests is called to find exactly that URL. Evict
    // the oldest NON-manifest entry first so a busy stream's segment churn
    // can't evict the one link this feature exists to surface.
    let evictAt = -1;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (!isManifestEntry(list[i])) {
        evictAt = i;
        break;
      }
    }
    if (evictAt === -1) evictAt = list.length - 1; // somehow all manifests — fall back to plain oldest
    list.splice(evictAt, 1);
  }
}

/**
 * @param {number} tabId
 * @returns {Array<{url: string, contentType: string|null, resourceType: string, seenAt: number}>}
 */
export function getMediaRequests(tabId) {
  return buffersByTab.get(tabId) || [];
}

function clearTabBuffer(tabId) {
  buffersByTab.delete(tabId);
  lastHostByTab.delete(tabId);
}

let started = false;

/**
 * Registers the webRequest/webNavigation/tabs listeners. Idempotent — safe
 * to call more than once (a second call is a no-op), but only the first,
 * synchronous, top-level call matters for MV3's "listeners must be added
 * during initial script evaluation" rule.
 */
export function startMediaSniffer() {
  if (started) return;
  started = true;

  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (!isMediaRequest({ url: details.url, type: details.type, contentType: getContentType(details.responseHeaders) })) return;
      recordMediaRequest(details.tabId, {
        url: details.url,
        contentType: getContentType(details.responseHeaders),
        resourceType: details.type,
        seenAt: Date.now(),
      });
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );

  // Only drop the buffer when the top-level frame's HOST actually changes —
  // a genuine "left this site" signal — not on every committed navigation.
  // Re-navigating to the same host (retrying the same player page, bouncing
  // off a restricted view-source attempt and coming back, a site's own
  // internal redirects) keeps whatever was already captured.
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    const host = hostnameOf(details.url);
    const lastHost = lastHostByTab.get(details.tabId);
    if (host && lastHost && host !== lastHost) {
      buffersByTab.delete(details.tabId);
    }
    if (host) lastHostByTab.set(details.tabId, host);
    else lastHostByTab.delete(details.tabId);
  });

  chrome.tabs.onRemoved.addListener((tabId) => clearTabBuffer(tabId));
}
