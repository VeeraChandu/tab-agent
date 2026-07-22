// lib/pageCache.js
// A per-session, persisted cache of read_page results, so a later turn that
// asks a different question about pages already visited (e.g. "check 10
// profiles for X", then "now give me Y from those same profiles") doesn't
// have to re-read every page from scratch. Populated by EVERY read_page call
// - the main loop, parallel_investigate branches, and run_batch tasks alike
// - so a branch's own reads survive past that branch's lifetime even though
// its local sub-loop history is discarded once it finishes (see runOneBranch/
// runBatch in agentLoop.js, which never returned page content, only prose +
// {title,url} pairs, before this module existed).
//
// Storage layout (two key families, deliberately NOT one shared blob):
//   pagecacheIndex_<sessionId>  -> array of lightweight metadata entries:
//     { entryKey, url, title, signature, capturedAt, turnIndex }
//     Never holds page content - cheap to read/rewrite on every single
//     read_page call, and safe to serialize through one lock per session.
//   pagecacheEntry_<sessionId>_<entryKey> -> the actual cached content:
//     { url, title, visible_text, interactive_elements, images, tables,
//       filter_controls, capturedAt, capturedByLabel, turnIndex, signature }
//     Each entry is its own storage key so two branches caching two
//     DIFFERENT urls at the same moment never race each other at all - only
//     two writes to the exact same url+view at the exact same instant could
//     collide, and the worst case there is losing one of two otherwise-valid
//     copies of the same content, not corruption.
//
// This module knows nothing about chat-session lifecycle beyond the id it's
// given - background.js/sidepanel.js are responsible for calling
// deleteCacheForSession when a chat itself is deleted, and for simply never
// passing a sessionId (or passing enabled:false) when the cache shouldn't
// apply at all (scheduled task runs - see background.js).

const INDEX_PREFIX = "pagecacheIndex_";
const ENTRY_PREFIX = "pagecacheEntry_";

function indexKey(sessionId) {
  return `${INDEX_PREFIX}${sessionId}`;
}
function entryStorageKey(sessionId, entryKey) {
  return `${ENTRY_PREFIX}${sessionId}_${entryKey}`;
}

// Cheap, deterministic string hash (djb2 variant) - not cryptographic, just
// needs to make two different bodies of text very unlikely to collide and
// two identical ones always match. Returned as base36 to keep it short.
function hashString(str) {
  let hash = 5381;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0; // hash*33 + c
  }
  return (hash >>> 0).toString(36);
}

// Signature of what a read_page result actually rendered - deliberately
// based on the real text content, not the URL, precisely because a page can
// update its content via client-side JS/POST without the URL ever changing
// (a profile's tabs, a filter panel that refetches in place). Two reads with
// the same signature are the same content and safe to treat as one entry;
// different signatures at the same URL are genuinely different views and
// both need to survive.
function contentSignature(text) {
  const s = String(text || "");
  return `${s.length}:${hashString(s)}`;
}

function genEntryKey() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Same read-modify-write serialization pattern as background.js's
// withStorageLock (chrome.storage.local has no atomic RMW) - duplicated
// here in miniature rather than imported, since background.js's copy isn't
// exported and this module needs to stay independently usable from
// lib/agentLoop.js without pulling in the whole service-worker entry file.
const locks = new Map(); // storage key -> tail promise
function withLock(key, fn) {
  const tail = (locks.get(key) || Promise.resolve()).then(fn, fn);
  locks.set(key, tail.catch(() => {}));
  return tail;
}

const DEFAULT_MAX_ENTRIES = 15;

// Strictly-increasing tie-breaker for "which entry is more recent," since
// Date.now() alone isn't fine-grained enough - two read_page calls (e.g. two
// concurrent parallel_investigate branches finishing close together) can
// land in the same millisecond, which would make capturedAt-based recency
// comparisons ambiguous/unstable. Module-scope is fine: this only needs to
// be monotonic for the lifetime of one service-worker instance, never
// persisted or compared across a restart.
let sequenceCounter = 0;

// Records one read_page result into the cache. No-op (resolves immediately)
// if the cache is disabled or there's no session to scope it to - callers
// never need to branch on "is this enabled," they can call this
// unconditionally and let it decide. `entry` is the read_page result's own
// fields; `turnIndex` is how many user turns have happened so far this
// conversation (used for turn-aware eviction - see recordPageRead below).
async function recordPageRead(sessionId, entry, config, turnIndex) {
  if (!sessionId || !config?.enabled || !entry?.url) return;
  const maxEntries = Math.max(1, config.maxEntries || DEFAULT_MAX_ENTRIES);
  const signature = contentSignature(entry.visible_text || "");

  await withLock(indexKey(sessionId), async () => {
    const storageIndexKey = indexKey(sessionId);
    const { [storageIndexKey]: index = [] } = await chrome.storage.local.get([storageIndexKey]);

    // Look for an existing entry at this exact URL to decide: refresh in
    // place (identical content), supersede in place (this is a grown/
    // appended version of the same view - infinite scroll, "load more"),
    // or keep both as genuinely distinct views (a tab/filter swap that
    // reused the URL).
    let targetIdx = index.findIndex((e) => e.url === entry.url && e.signature === signature);
    if (targetIdx === -1) {
      const sameUrlIdx = index.findIndex((e) => e.url === entry.url);
      if (sameUrlIdx !== -1) {
        const candidate = index[sameUrlIdx];
        const oldEntry = await getEntryContent(sessionId, candidate.entryKey);
        const oldText = oldEntry?.visible_text || "";
        const newText = entry.visible_text || "";
        // Only the "grew" direction counts as supersede - if the new read is
        // SHORTER or otherwise unrelated, that's more likely a genuinely
        // different view (e.g. a filter narrowed the same listing URL) than
        // the same view losing content, so it's kept as a separate entry
        // instead of silently overwriting something that might still be
        // exactly what an earlier turn was told about.
        if (newText && oldText && newText.startsWith(oldText)) {
          targetIdx = sameUrlIdx;
        }
      }
    }

    const entryKey = targetIdx !== -1 ? index[targetIdx].entryKey : genEntryKey();
    const metaEntry = {
      entryKey,
      url: entry.url,
      title: entry.title || "",
      signature,
      capturedAt: Date.now(),
      seq: ++sequenceCounter,
      turnIndex: turnIndex || 0,
    };
    if (targetIdx !== -1) index[targetIdx] = metaEntry;
    else index.push(metaEntry);

    // Turn-aware eviction: once over the cap, drop the entries from the
    // OLDEST user turn first (ties broken by seq, not capturedAt - see
    // sequenceCounter above) - a task from several messages ago is much
    // less likely to matter to a current follow-up than something read in
    // the last turn or two, even if it was technically read earlier in
    // absolute order.
    let evicted = [];
    if (index.length > maxEntries) {
      index.sort((a, b) => (a.turnIndex - b.turnIndex) || (a.seq - b.seq));
      evicted = index.splice(0, index.length - maxEntries);
    }

    await chrome.storage.local.set({ [storageIndexKey]: index });
    await Promise.all(evicted.map((e) => chrome.storage.local.remove([entryStorageKey(sessionId, e.entryKey)])));

    const content = {
      url: entry.url,
      title: entry.title || "",
      visible_text: entry.visible_text || "",
      interactive_elements: entry.interactive_elements || [],
      images: entry.images || [],
      tables: entry.tables || [],
      filter_controls: entry.filter_controls || null,
      capturedAt: metaEntry.capturedAt,
      capturedByLabel: entry.capturedByLabel || "main",
      turnIndex: metaEntry.turnIndex,
      signature,
    };
    await chrome.storage.local.set({ [entryStorageKey(sessionId, entryKey)]: content });
  });
}

async function getEntryContent(sessionId, entryKey) {
  const key = entryStorageKey(sessionId, entryKey);
  const { [key]: content } = await chrome.storage.local.get([key]);
  return content || null;
}

// Cheap, index-only check - used to proactively tell the model "you already
// have this cached" from navigate/parallel_investigate/run_batch without
// paying the cost of fetching the actual content just to answer yes/no.
async function isUrlCached(sessionId, url, config) {
  if (!sessionId || !config?.enabled || !url) return null;
  const storageIndexKey = indexKey(sessionId);
  const { [storageIndexKey]: index = [] } = await chrome.storage.local.get([storageIndexKey]);
  const hit = index.filter((e) => e.url === url).sort((a, b) => b.seq - a.seq)[0];
  return hit ? { capturedAt: hit.capturedAt } : null;
}

// Returns the most recently captured entry for this URL, or null if nothing
// is cached (evicted, never visited, or the cache is disabled). Deliberately
// never fabricates a result - a miss is always reported plainly so the
// caller (recall_page's tool handler) can point the model back to a real
// read_page/navigate instead.
async function recallPage(sessionId, url, config) {
  if (!sessionId || !config?.enabled || !url) return null;
  const storageIndexKey = indexKey(sessionId);
  const { [storageIndexKey]: index = [] } = await chrome.storage.local.get([storageIndexKey]);
  const candidates = index.filter((e) => e.url === url).sort((a, b) => b.seq - a.seq);
  if (!candidates.length) return null;
  const content = await getEntryContent(sessionId, candidates[0].entryKey);
  return content;
}

// Removes every cache entry for a session - called when the chat itself is
// deleted, so clearing a chat doesn't leave its page content orphaned in
// storage indefinitely. Reads the index first purely to know which entry
// keys exist; safe to call even if the session never had a cache at all.
async function deleteCacheForSession(sessionId) {
  const storageIndexKey = indexKey(sessionId);
  const { [storageIndexKey]: index = [] } = await chrome.storage.local.get([storageIndexKey]);
  const entryKeys = index.map((e) => entryStorageKey(sessionId, e.entryKey));
  await chrome.storage.local.remove([storageIndexKey, ...entryKeys]);
}

export { hashString, contentSignature, recordPageRead, recallPage, isUrlCached, deleteCacheForSession, DEFAULT_MAX_ENTRIES, INDEX_PREFIX, ENTRY_PREFIX };
