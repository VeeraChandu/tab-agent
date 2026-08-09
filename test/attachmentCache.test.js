import { chunkText, recordAttachment, getChunk, getFullAttachment, deleteCacheForSession, CHUNK_CHARS } from "../src/lib/attachmentCache.js";

// Same minimal in-memory stand-in for chrome.storage.local used by
// pageCache.test.js - reset before every test so entries from one test
// never leak into the next.
function installFakeStorage() {
  const store = new Map();
  global.chrome = {
    storage: {
      local: {
        get: (keys) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) out[k] = store.has(k) ? store.get(k) : undefined;
          return Promise.resolve(out);
        },
        set: (obj) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
          return Promise.resolve();
        },
        remove: (keys) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) store.delete(k);
          return Promise.resolve();
        },
      },
    },
  };
  return store;
}

describe("chunkText", () => {
  test("short text stays in one chunk", () => {
    expect(chunkText("hello world")).toEqual(["hello world"]);
  });

  test("empty text still returns one (empty) chunk, not zero chunks", () => {
    expect(chunkText("")).toEqual([""]);
  });

  test("concatenating every chunk reconstructs the exact original text - nothing is ever dropped", () => {
    const lines = [];
    for (let i = 0; i < 500; i += 1) lines.push(`line ${i}: ${"x".repeat(30)}`);
    const text = lines.join("\n");
    const chunks = chunkText(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  test("never cuts a line in half when a newline exists within the window", () => {
    const lines = [];
    for (let i = 0; i < 200; i += 1) lines.push(`row-${i}-${"y".repeat(20)}`);
    const text = lines.join("\n");
    const chunks = chunkText(text, 300);
    for (const chunk of chunks.slice(0, -1)) {
      // every chunk but the last should end exactly at a line boundary
      expect(chunk.endsWith("\n")).toBe(true);
    }
  });

  test("falls back to a raw character cut when a single line exceeds the chunk size (e.g. minified JSON)", () => {
    const text = `{"a":${"1".repeat(50)}}`; // one giant line, no newlines at all
    const chunks = chunkText(text, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text); // still lossless, just split mid-line
  });

  test("default chunk size matches the exported CHUNK_CHARS constant", () => {
    const text = "a".repeat(CHUNK_CHARS * 2 + 10);
    const chunks = chunkText(text);
    expect(chunks.length).toBe(3);
  });
});

describe("recordAttachment / getChunk", () => {
  beforeEach(() => installFakeStorage());

  test("small attachment (one chunk) round-trips exactly", async () => {
    const { totalChunks, firstChunkText } = await recordAttachment("s1", "att1", { name: "notes.txt", format: "text", text: "hello world" });
    expect(totalChunks).toBe(1);
    expect(firstChunkText).toBe("hello world");

    const chunk = await getChunk("s1", "att1", 1);
    expect(chunk).toEqual({ name: "notes.txt", format: "text", chunkText: "hello world", chunkIndex: 1, totalChunks: 1 });
  });

  test("large attachment splits into multiple chunks, all individually fetchable", async () => {
    const lines = [];
    const lineCount = Math.ceil((CHUNK_CHARS * 2.5) / 10); // comfortably past 2 chunks' worth at ~10 chars/line
    for (let i = 0; i < lineCount; i += 1) lines.push(`line ${i}`);
    const text = lines.join("\n");

    const { totalChunks, firstChunkText } = await recordAttachment("s1", "att1", { name: "big.csv", format: "csv", text });
    expect(totalChunks).toBeGreaterThan(1);
    expect(firstChunkText.startsWith("line 0\n")).toBe(true);

    // Walking every chunk in order reconstructs the exact original text.
    let reassembled = "";
    for (let i = 1; i <= totalChunks; i += 1) {
      const chunk = await getChunk("s1", "att1", i);
      expect(chunk.totalChunks).toBe(totalChunks);
      reassembled += chunk.chunkText;
    }
    expect(reassembled).toBe(text);
  });

  test("getChunk returns null for an unknown attachment id", async () => {
    await recordAttachment("s1", "att1", { name: "a.txt", format: "text", text: "hi" });
    expect(await getChunk("s1", "att-does-not-exist", 1)).toBeNull();
  });

  test("getChunk returns null for a chunk_index past the end", async () => {
    await recordAttachment("s1", "att1", { name: "a.txt", format: "text", text: "hi" });
    expect(await getChunk("s1", "att1", 2)).toBeNull();
    expect(await getChunk("s1", "att1", 0)).toBeNull();
  });

  test("different sessions never see each other's attachments", async () => {
    await recordAttachment("s1", "att1", { name: "a.txt", format: "text", text: "session one" });
    await recordAttachment("s2", "att1", { name: "a.txt", format: "text", text: "session two" });

    expect((await getChunk("s1", "att1", 1)).chunkText).toBe("session one");
    expect((await getChunk("s2", "att1", 1)).chunkText).toBe("session two");
  });

  test("re-recording the same attachment id overwrites, doesn't duplicate", async () => {
    await recordAttachment("s1", "att1", { name: "a.txt", format: "text", text: "first version" });
    const { totalChunks } = await recordAttachment("s1", "att1", { name: "a.txt", format: "text", text: "second version, much longer than before" });
    const chunk = await getChunk("s1", "att1", 1);
    expect(chunk.chunkText).toBe("second version, much longer than before");
    expect(totalChunks).toBe(1);
  });

  test("empty file records as a single empty chunk, not zero chunks", async () => {
    const { totalChunks, firstChunkText } = await recordAttachment("s1", "att1", { name: "empty.txt", format: "text", text: "" });
    expect(totalChunks).toBe(1);
    expect(firstChunkText).toBe("");
  });
});

describe("getFullAttachment", () => {
  beforeEach(() => installFakeStorage());

  test("reconstructs the exact original text across multiple chunks", async () => {
    const lines = [];
    const lineCount = Math.ceil((CHUNK_CHARS * 2.5) / 10);
    for (let i = 0; i < lineCount; i += 1) lines.push(`line ${i}`);
    const text = lines.join("\n");
    await recordAttachment("s1", "att1", { name: "big.csv", format: "csv", text });

    const full = await getFullAttachment("s1", "att1");
    expect(full.name).toBe("big.csv");
    expect(full.text).toBe(text);
  });

  test("returns null for an unknown attachment id", async () => {
    expect(await getFullAttachment("s1", "att-does-not-exist")).toBeNull();
  });
});

describe("deleteCacheForSession", () => {
  beforeEach(() => installFakeStorage());

  test("removes every attachment for a session, leaves other sessions untouched", async () => {
    await recordAttachment("s1", "att1", { name: "a.txt", format: "text", text: "hello" });
    await recordAttachment("s1", "att2", { name: "b.txt", format: "text", text: "world" });
    await recordAttachment("s2", "att1", { name: "c.txt", format: "text", text: "other session" });

    await deleteCacheForSession("s1");

    expect(await getChunk("s1", "att1", 1)).toBeNull();
    expect(await getChunk("s1", "att2", 1)).toBeNull();
    expect((await getChunk("s2", "att1", 1)).chunkText).toBe("other session");
  });

  test("safe to call for a session that never had any attachments", async () => {
    await expect(deleteCacheForSession("never-existed")).resolves.toBeUndefined();
  });
});
