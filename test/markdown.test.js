// lib/markdown.js is a classic (non-module) script that attaches its API to
// `window.TabAgentMarkdown` via an IIFE rather than using `export` — see the
// "Module system is intentionally mixed" note in CLAUDE.md. Under the jsdom
// test environment `window` is already global, so requiring the file for its
// side effect is enough to pick up the API it attaches.
require("../src/lib/markdown.js");
const { renderMarkdown, escapeHtml } = window.TabAgentMarkdown;

describe("escapeHtml", () => {
  test("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>&"'</script>`)).toBe("&lt;script&gt;&amp;&quot;'&lt;/script&gt;");
  });
});

describe("renderMarkdown", () => {
  test("returns an empty string for falsy input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown(null)).toBe("");
    expect(renderMarkdown(undefined)).toBe("");
  });

  test("escapes raw HTML/script tags instead of letting them through", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("renders bold, italic, and inline code", () => {
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("*italic*")).toContain("<em>italic</em>");
    expect(renderMarkdown("`code`")).toContain("<code>code</code>");
  });

  test("renders a bracketed markdown link with target=_blank and rel=noopener", () => {
    const out = renderMarkdown("[Anthropic](https://anthropic.com)");
    expect(out).toContain('href="https://anthropic.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain(">Anthropic</a>");
  });

  test("autolinks a bare URL", () => {
    const out = renderMarkdown("See https://example.com/path for details.");
    expect(out).toContain('<a href="https://example.com/path"');
  });

  test("does not double-wrap a bracketed link's own URL text", () => {
    const out = renderMarkdown("[https://example.com](https://example.com)");
    expect(out.match(/<a /g).length).toBe(1);
  });

  test("autolinks a bare URL inside a fenced code block without altering its visible text", () => {
    const out = renderMarkdown("```\nhttps://cdn.example.com/vod/abc/segment1.ts?token=xyz\n```");
    expect(out).toContain('<pre><code><a href="https://cdn.example.com/vod/abc/segment1.ts?token=xyz" target="_blank" rel="noopener noreferrer">https://cdn.example.com/vod/abc/segment1.ts?token=xyz</a></code></pre>');
  });

  test("renders a '>' quote line as a blockquote instead of a literal '>'", () => {
    const out = renderMarkdown('> "quoted text"');
    expect(out).toBe('<blockquote><p>&quot;quoted text&quot;</p></blockquote>');
  });

  test("groups consecutive '>' lines into one blockquote and closes it on the next line type", () => {
    const out = renderMarkdown("> line one\n> line two\n\nafter");
    expect(out).toBe("<blockquote><p>line one</p><p>line two</p></blockquote><p>after</p>");
  });

  test("autolinks a bare URL in an unclosed trailing code block", () => {
    const out = renderMarkdown("```\nhttps://example.com/a");
    expect(out).toContain('<a href="https://example.com/a"');
  });

  test("preserves non-URL code content unchanged", () => {
    const out = renderMarkdown("```\nconst x = 1;\n```");
    expect(out).toBe("<pre><code>const x = 1;</code></pre>");
  });
});
