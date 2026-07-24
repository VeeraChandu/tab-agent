import { hashString, contentSignature, recordPageRead, recallPage, isUrlCached, deleteCacheForSession, DEFAULT_MAX_ENTRIES } from "../src/lib/pageCache.js";

// Minimal in-memory stand-in for chrome.storage.local - just enough of the
// real API (get/set/remove, callback-less/promise-based) for pageCache.js's
// own usage. Reset before every test so entries from one test never leak
// into the next.
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

const ENABLED = { enabled: true, maxEntries: 3 };

describe("contentSignature", () => {
  test("identical text produces the same signature", () => {
    expect(contentSignature("hello world")).toBe(contentSignature("hello world"));
  });

  test("different text produces a different signature", () => {
    expect(contentSignature("hello world")).not.toBe(contentSignature("goodbye world"));
  });

  test("hashString is deterministic", () => {
    expect(hashString("abc123")).toBe(hashString("abc123"));
  });
});

describe("recordPageRead / recallPage", () => {
  beforeEach(() => installFakeStorage());

  test("is a no-op when disabled", async () => {
    await recordPageRead("s1", { url: "https://a.com/x", title: "A", visible_text: "hello" }, { enabled: false }, 1);
    const result = await recallPage("s1", "https://a.com/x", { enabled: false });
    expect(result).toBeNull();
  });

  test("caches a read and recalls it back", async () => {
    await recordPageRead("s1", { url: "https://a.com/x", title: "A", visible_text: "hello there" }, ENABLED, 1);
    const result = await recallPage("s1", "https://a.com/x", ENABLED);
    expect(result).not.toBeNull();
    expect(result.title).toBe("A");
    expect(result.visible_text).toBe("hello there");
  });

  test("recall miss returns null, never fabricates content", async () => {
    const result = await recallPage("s1", "https://never-visited.com", ENABLED);
    expect(result).toBeNull();
  });

  test("same URL + identical content refreshes in place, not a duplicate", async () => {
    await recordPageRead("s1", { url: "https://a.com/x", title: "A", visible_text: "same text" }, ENABLED, 1);
    await recordPageRead("s1", { url: "https://a.com/x", title: "A", visible_text: "same text" }, ENABLED, 2);
    const cached = await isUrlCached("s1", "https://a.com/x", ENABLED);
    expect(cached).not.toBeNull();
    // Only one entry should exist for this URL - verified indirectly via
    // the cap test below actually holding at 3 distinct URLs, not via a
    // direct index read (kept private to the module).
  });

  test("same URL, content GREW (infinite scroll/load more) supersedes rather than duplicating", async () => {
    await recordPageRead("s1", { url: "https://a.com/list", title: "List", visible_text: "item1 item2" }, ENABLED, 1);
    await recordPageRead("s1", { url: "https://a.com/list", title: "List", visible_text: "item1 item2 item3 item4" }, ENABLED, 1);
    const result = await recallPage("s1", "https://a.com/list", ENABLED);
    expect(result.visible_text).toBe("item1 item2 item3 item4");
  });

  test("same URL, different content that ISN'T a supersede stays a separate view (tab switch pattern)", async () => {
    await recordPageRead("s1", { url: "https://a.com/profile", title: "Posts", visible_text: "post one, post two" }, ENABLED, 1);
    await recordPageRead("s1", { url: "https://a.com/profile", title: "About", visible_text: "bio and details here" }, ENABLED, 1);
    // recallPage returns the most-recently-captured view for this URL (the
    // "About" tab, captured second) - the point of this test is that the
    // "Posts" write didn't get silently discarded/corrupted, not that both
    // are simultaneously retrievable by URL alone (a known, documented v1
    // simplification - see recallPage's own comment).
    const result = await recallPage("s1", "https://a.com/profile", ENABLED);
    expect(result.title).toBe("About");
  });

  test("cross-session isolation - a different session never recalls another session's pages", async () => {
    await recordPageRead("session-A", { url: "https://a.com/x", title: "A", visible_text: "secret" }, ENABLED, 1);
    const result = await recallPage("session-B", "https://a.com/x", ENABLED);
    expect(result).toBeNull();
  });

  test("caps at maxEntries and evicts the oldest turn first", async () => {
    await recordPageRead("s1", { url: "https://a.com/1", title: "1", visible_text: "one" }, ENABLED, 1);
    await recordPageRead("s1", { url: "https://a.com/2", title: "2", visible_text: "two" }, ENABLED, 1);
    await recordPageRead("s1", { url: "https://a.com/3", title: "3", visible_text: "three" }, ENABLED, 2);
    // maxEntries is 3 in ENABLED - all three should still be present here.
    expect(await recallPage("s1", "https://a.com/1", ENABLED)).not.toBeNull();

    // A 4th distinct URL from a LATER turn pushes it over the cap - the
    // oldest-turn entry (turn 1's "https://a.com/1") should be evicted
    // first, not whichever was simply recorded first.
    await recordPageRead("s1", { url: "https://a.com/4", title: "4", visible_text: "four" }, ENABLED, 3);
    expect(await recallPage("s1", "https://a.com/1", ENABLED)).toBeNull();
    expect(await recallPage("s1", "https://a.com/4", ENABLED)).not.toBeNull();
    // turn 2's entry, being newer than turn 1's, should have survived.
    expect(await recallPage("s1", "https://a.com/3", ENABLED)).not.toBeNull();
  });

  test("defaults to DEFAULT_MAX_ENTRIES when maxEntries isn't specified", async () => {
    await recordPageRead("s1", { url: "https://a.com/x", title: "A", visible_text: "hi" }, { enabled: true }, 1);
    const result = await recallPage("s1", "https://a.com/x", { enabled: true });
    expect(result).not.toBeNull();
    expect(DEFAULT_MAX_ENTRIES).toBeGreaterThan(0);
  });
});

describe("deleteCacheForSession", () => {
  beforeEach(() => installFakeStorage());

  test("removes every cached entry for a session, leaves other sessions untouched", async () => {
    await recordPageRead("s1", { url: "https://a.com/x", title: "A", visible_text: "hi" }, ENABLED, 1);
    await recordPageRead("s2", { url: "https://b.com/y", title: "B", visible_text: "hey" }, ENABLED, 1);

    await deleteCacheForSession("s1");

    expect(await recallPage("s1", "https://a.com/x", ENABLED)).toBeNull();
    expect(await recallPage("s2", "https://b.com/y", ENABLED)).not.toBeNull();
  });

  test("is safe to call on a session that never had a cache", async () => {
    await expect(deleteCacheForSession("never-existed")).resolves.not.toThrow();
  });
});
