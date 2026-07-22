import { isMediaRequest, getMediaRequests, recordMediaRequest } from "../lib/mediaSniffer.js";

describe("isMediaRequest", () => {
  test("flags Chrome's own 'media' resource type regardless of URL", () => {
    expect(isMediaRequest({ url: "https://example.com/whatever", type: "media" })).toBe(true);
  });

  test("flags known media content-types", () => {
    expect(isMediaRequest({ url: "https://cdn.example.com/x", contentType: "video/mp4" })).toBe(true);
    expect(isMediaRequest({ url: "https://cdn.example.com/x", contentType: "application/vnd.apple.mpegurl" })).toBe(true);
    expect(isMediaRequest({ url: "https://cdn.example.com/x", contentType: "application/dash+xml" })).toBe(true);
  });

  test("flags known streaming file extensions even with no content-type", () => {
    expect(isMediaRequest({ url: "https://cdn.example.com/master.m3u8" })).toBe(true);
    expect(isMediaRequest({ url: "https://cdn.example.com/seg-001.ts?token=abc" })).toBe(true);
    expect(isMediaRequest({ url: "https://cdn.example.com/video.mp4#t=10" })).toBe(true);
  });

  test("does not flag ordinary page assets", () => {
    expect(isMediaRequest({ url: "https://example.com/app.js", type: "script" })).toBe(false);
    expect(isMediaRequest({ url: "https://example.com/style.css", contentType: "text/css" })).toBe(false);
    expect(isMediaRequest({ url: "https://example.com/api/data", type: "xmlhttprequest", contentType: "application/json" })).toBe(false);
  });
});

describe("getMediaRequests", () => {
  test("returns an empty array for a tab with nothing recorded", () => {
    expect(getMediaRequests(999999)).toEqual([]);
  });
});

describe("recordMediaRequest eviction", () => {
  test("a manifest recorded first survives a flood of later segment requests past the cap", () => {
    const tabId = 100001;
    recordMediaRequest(tabId, { url: "https://cdn.example.com/master.m3u8", contentType: "application/vnd.apple.mpegurl", resourceType: "xmlhttprequest", seenAt: 1 });
    // Well past the internal 30-entry cap — a naive "always drop the tail"
    // trim would have evicted the manifest above long before this loop ends.
    for (let i = 0; i < 40; i += 1) {
      recordMediaRequest(tabId, { url: `https://cdn.example.com/seg-${i}.ts`, contentType: "video/mp2t", resourceType: "xmlhttprequest", seenAt: i + 2 });
    }
    const urls = getMediaRequests(tabId).map((e) => e.url);
    expect(urls).toContain("https://cdn.example.com/master.m3u8");
  });

  test("still caps the buffer size even with a manifest pinned", () => {
    const tabId = 100002;
    recordMediaRequest(tabId, { url: "https://cdn.example.com/master.mpd", contentType: "application/dash+xml", resourceType: "xmlhttprequest", seenAt: 1 });
    for (let i = 0; i < 40; i += 1) {
      recordMediaRequest(tabId, { url: `https://cdn.example.com/chunk-${i}.m4s`, contentType: "video/mp4", resourceType: "xmlhttprequest", seenAt: i + 2 });
    }
    expect(getMediaRequests(tabId).length).toBeLessThanOrEqual(30);
  });

  test("without a manifest in the mix, plain oldest-first eviction still applies", () => {
    const tabId = 100003;
    for (let i = 0; i < 35; i += 1) {
      recordMediaRequest(tabId, { url: `https://cdn.example.com/plain-${i}.mp4`, contentType: "video/mp4", resourceType: "media", seenAt: i });
    }
    const urls = getMediaRequests(tabId).map((e) => e.url);
    expect(urls).not.toContain("https://cdn.example.com/plain-0.mp4"); // oldest, evicted
    expect(urls).toContain("https://cdn.example.com/plain-34.mp4"); // newest, kept
  });
});
