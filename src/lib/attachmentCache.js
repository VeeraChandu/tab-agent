// lib/attachmentCache.js
// A per-session cache of the FULL text of every file the user attaches to a
// chat, so large attachments never get silently truncated. Extraction still
// happens client-side in sidepanel.js (FileReader/pdf.js) exactly as before
// - this module only owns what happens to that text once it reaches
// background.js: split it into fixed-size chunks, persist all of them, and
// hand back just the first chunk for the model to see right away. The rest
// are fetched on demand via the read_attachment_chunk tool (see
// lib/agentLoop.js's executeTool), so a huge file costs nothing extra unless
// the model actually asks for more of it.
//
// Deliberately simpler than lib/pageCache.js: a page can be re-read and its
// content can change between reads, so that module needs signature-based
// dedup, refresh/supersede logic, and a write lock to stay safe under
// concurrent branches. An attachment is immutable the moment it's uploaded -
// written exactly once, before the agent loop even starts, then only ever
// read after that. No lock, no dedup, no eviction-by-recency: nothing here
// is ever mutated once recorded.
//
// Storage layout (mirrors pageCache's two-key-family split for the same
// reason - keep the frequently-read index cheap, keep bulk content out of it):
//   attcacheIndex_<sessionId>  -> array of lightweight metadata entries:
//     { attachmentId, name, format, totalChunks, totalChars, capturedAt }
//   attcacheEntry_<sessionId>_<attachmentId> -> { name, format, chunks: [...],
//     totalChunks, totalChars, capturedAt }
//
// Cleaned up the same way pageCache is: background.js's DELETE_SESSION_CACHE
// handler calls this module's deleteCacheForSession alongside pageCache's,
// so a deleted chat doesn't leave either kind of cached content orphaned.

const INDEX_PREFIX = "attcacheIndex_";
const ENTRY_PREFIX = "attcacheEntry_";

function indexKey(sessionId) {
  return `${INDEX_PREFIX}${sessionId}`;
}
function entryStorageKey(sessionId, attachmentId) {
  return `${ENTRY_PREFIX}${sessionId}_${attachmentId}`;
}

// Fixed chunk size - not model-aware (no context-window metadata exists
// anywhere in this codebase to size against; lib/pricing.js only has
// cost-per-token, not context limits). ~50k tokens at the same 4-chars/token
// estimate background.js's compaction path uses — big enough that the vast
// majority of attachments round-trip in a single chunk (no
// read_attachment_chunk round-trip needed at all), while still bounding any
// one request's size for the genuine outliers.
const CHUNK_CHARS = 200000;

// Splits text into chunks without ever cutting a line in half where that can
// be avoided - a CSV/log/code file split mid-line doesn't lose any data
// (chunks still concatenate back to the exact original), but a model reading
// one chunk in isolation can misread a truncated row as the whole row. Falls
// back to a raw character cut only when a single line is itself longer than
// one chunk (e.g. minified JSON on one line) - unavoidable there, but still
// lossless once every chunk is read.
function chunkText(text, chunkSize = CHUNK_CHARS) {
  const s = String(text || "");
  if (!s) return [""];
  const chunks = [];
  let pos = 0;
  while (pos < s.length) {
    let end = Math.min(pos + chunkSize, s.length);
    if (end < s.length) {
      const lastNewline = s.lastIndexOf("\n", end);
      if (lastNewline > pos) end = lastNewline + 1; // keep the newline with the chunk before it
      // else: no newline anywhere in this window - fall through to the raw cut
    }
    chunks.push(s.slice(pos, end));
    pos = end;
  }
  return chunks;
}

// Records one attachment's full text, chunked, and returns just enough for
// the caller (background.js's buildDocBlocks) to fold chunk 1 into the task
// text without a second read round-trip. No-op-ish (still chunks and returns
// data, just doesn't persist) if there's no session to scope it to - callers
// can still show chunk 1 even when caching itself isn't possible.
async function recordAttachment(sessionId, attachmentId, entry) {
  const name = entry?.name || "attachment";
  const format = entry?.format || "text";
  const text = entry?.text || "";
  const chunks = chunkText(text);
  const totalChunks = chunks.length;
  const capturedAt = Date.now();

  if (sessionId && attachmentId) {
    const storageIndexKey = indexKey(sessionId);
    const { [storageIndexKey]: index = [] } = await chrome.storage.local.get([storageIndexKey]);
    const metaEntry = { attachmentId, name, format, totalChunks, totalChars: text.length, capturedAt };
    const existingIdx = index.findIndex((e) => e.attachmentId === attachmentId);
    if (existingIdx !== -1) index[existingIdx] = metaEntry;
    else index.push(metaEntry);

    await chrome.storage.local.set({
      [storageIndexKey]: index,
      [entryStorageKey(sessionId, attachmentId)]: { name, format, chunks, totalChunks, totalChars: text.length, capturedAt },
    });
  }

  return { totalChunks, firstChunkText: chunks[0] || "" };
}

// Returns { name, format, chunkText, chunkIndex, totalChunks } for one
// 1-based chunk, or null if this session/attachment/chunk doesn't exist
// (never fabricated - a miss is always reported plainly so the tool handler
// can give the model an honest error instead of silently making something up).
async function getChunk(sessionId, attachmentId, chunkIndex) {
  if (!sessionId || !attachmentId) return null;
  const key = entryStorageKey(sessionId, attachmentId);
  const { [key]: content } = await chrome.storage.local.get([key]);
  if (!content || !Array.isArray(content.chunks)) return null;
  const idx = chunkIndex - 1;
  if (idx < 0 || idx >= content.chunks.length) return null;
  return {
    name: content.name,
    format: content.format,
    chunkText: content.chunks[idx],
    chunkIndex,
    totalChunks: content.totalChunks,
  };
}

// Full reconstructed text for a cached attachment — used by the upload_file
// tool (see lib/agentLoop.js), which needs the WHOLE file to write into a
// page's <input type="file">, not one chunk at a time the way the model
// reads it via read_attachment_chunk. Reuses the same storage entry (one
// read, not a loop of getChunk calls).
async function getFullAttachment(sessionId, attachmentId) {
  if (!sessionId || !attachmentId) return null;
  const key = entryStorageKey(sessionId, attachmentId);
  const { [key]: content } = await chrome.storage.local.get([key]);
  if (!content || !Array.isArray(content.chunks)) return null;
  return { name: content.name, format: content.format, text: content.chunks.join("") };
}

// Removes every cached attachment for a session - called (alongside
// pageCache's own deleteCacheForSession) when the chat itself is deleted, so
// clearing a chat doesn't leave its attachments' full text orphaned in
// storage indefinitely.
async function deleteCacheForSession(sessionId) {
  const storageIndexKey = indexKey(sessionId);
  const { [storageIndexKey]: index = [] } = await chrome.storage.local.get([storageIndexKey]);
  const entryKeys = index.map((e) => entryStorageKey(sessionId, e.attachmentId));
  await chrome.storage.local.remove([storageIndexKey, ...entryKeys]);
}

export { chunkText, recordAttachment, getChunk, getFullAttachment, deleteCacheForSession, CHUNK_CHARS, INDEX_PREFIX, ENTRY_PREFIX };
