// lib/markdown.js
// A tiny, dependency-free markdown -> HTML renderer for the side panel.
// Deliberately not using a CDN library: extension pages run under a strict
// default CSP that blocks remotely-hosted scripts, and vendoring a full
// markdown library felt like overkill for chat-style model output.
//
// Safety: all text is HTML-escaped before any markdown syntax is applied,
// so raw HTML/script tags that happen to appear in model output (e.g.
// echoed page content) can't execute. Only a small whitelist of tags is
// ever produced, and links are only rendered for http(s) URLs.

(function (global) {
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Matches a bare (non-bracketed) URL. Deliberately excludes *, `, ], and
  // closing-paren from the "URL body" character class — not because those
  // are invalid URL characters, but so a URL sitting inside markdown
  // emphasis/link punctuation (e.g. "*https://x.com*" or "(https://x.com)")
  // doesn't swallow the closing delimiter into the link itself.
  const BARE_URL_RE = /\bhttps?:\/\/[^\s<>"')\]*`]+/g;

  // Applies bare-URL autolinking everywhere EXCEPT inside <a>...</a> spans
  // already produced by the bracketed-link regex — otherwise a link whose
  // visible text is itself the URL (or whose href attribute contains it)
  // would get wrapped a second time, producing nested/duplicate anchors.
  function autolink(html) {
    const parts = html.split(/(<a\b[^>]*>[\s\S]*?<\/a>)/);
    return parts
      .map((part, i) =>
        i % 2 === 1 ? part : part.replace(BARE_URL_RE, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
      )
      .join("");
  }

  // Same bare-URL wrapping as autolink() above, applied to code-block content
  // instead of prose. Code blocks otherwise render as inert escaped text —
  // fine for a snippet, but the model uses ```...``` for things like captured
  // stream URLs specifically because their exact characters matter, and
  // those still deserve to be clickable. The wrapped <a>'s visible text is
  // exactly the original (already-escaped) string, so selecting/copying it
  // is completely unaffected — this only adds click-to-open on top.
  function autolinkCode(escapedText) {
    return escapedText.replace(BARE_URL_RE, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  }

  function renderInline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
    // Bracketed links first (so a custom link label doesn't also get
    // autolinked by its raw URL below), THEN bare-URL autolinking for any
    // plain https://... the model wrote without [text](url) syntax — which
    // previously rendered as inert (and, if wrapped in single asterisks for
    // emphasis, italic) plain text instead of a clickable link.
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    out = autolink(out);
    return out;
  }

  // CommonMark-style thematic break: a line consisting solely of 3+ of the
  // same character among -, *, _ (optionally space-separated, e.g. "- - -").
  // Model output commonly uses "---" as a section divider and expects it to
  // render as a rule, not literal dashes in a paragraph.
  const HR_RE = /^([-*_])( ?\1){2,}$/;

  // --- GFM-style tables ---------------------------------------------

  function splitRow(line) {
    let t = line.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|")) t = t.slice(0, -1);
    // Split on unescaped pipes.
    return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
  }

  function isTableSeparatorRow(line) {
    const t = line.trim();
    if (!t.includes("-") || !t.includes("|")) return false;
    const cells = splitRow(t);
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
  }

  function renderTable(headerCells, bodyRows) {
    let out = '<table><thead><tr>';
    for (const c of headerCells) out += `<th>${renderInline(c)}</th>`;
    out += "</tr></thead>";
    if (bodyRows.length) {
      out += "<tbody>";
      for (const row of bodyRows) {
        out += "<tr>";
        for (const c of row) out += `<td>${renderInline(c)}</td>`;
        out += "</tr>";
      }
      out += "</tbody>";
    }
    out += "</table>";
    return out;
  }

  function renderMarkdown(md) {
    if (!md) return "";
    const lines = String(md).split(/\r?\n/);
    let html = "";
    let inCode = false;
    let codeBuffer = [];
    let listBuffer = [];
    let listType = null;

    function flushList() {
      if (listBuffer.length) {
        const tag = listType === "ol" ? "ol" : "ul";
        html += `<${tag}>${listBuffer.map((i) => `<li>${renderInline(i)}</li>`).join("")}</${tag}>`;
        listBuffer = [];
      }
      listType = null;
    }

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (line.trim().startsWith("```")) {
        if (inCode) {
          html += `<pre><code>${autolinkCode(escapeHtml(codeBuffer.join("\n")))}</code></pre>`;
          codeBuffer = [];
          inCode = false;
        } else {
          flushList();
          inCode = true;
        }
        i += 1;
        continue;
      }
      if (inCode) {
        codeBuffer.push(line);
        i += 1;
        continue;
      }

      // Must be checked before the unordered-list check below — "- - -" or
      // "***" would otherwise be misread as a (nonsensical) bullet item.
      if (HR_RE.test(line.trim())) {
        flushList();
        html += "<hr>";
        i += 1;
        continue;
      }

      // Table: a row containing '|' immediately followed by a separator row.
      if (line.includes("|") && i + 1 < lines.length && isTableSeparatorRow(lines[i + 1])) {
        flushList();
        const headerCells = splitRow(line);
        const bodyRows = [];
        i += 2; // skip header + separator row
        while (i < lines.length && lines[i].trim() !== "" && lines[i].includes("|")) {
          bodyRows.push(splitRow(lines[i]));
          i += 1;
        }
        html += renderTable(headerCells, bodyRows);
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        flushList();
        const level = heading[1].length;
        html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
        i += 1;
        continue;
      }

      const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
      const unordered = line.match(/^\s*[-*]\s+(.*)$/);
      if (ordered) {
        if (listType && listType !== "ol") flushList();
        listType = "ol";
        listBuffer.push(ordered[1]);
        i += 1;
        continue;
      }
      if (unordered) {
        if (listType && listType !== "ul") flushList();
        listType = "ul";
        listBuffer.push(unordered[1]);
        i += 1;
        continue;
      }

      flushList();
      if (line.trim() !== "") {
        html += `<p>${renderInline(line)}</p>`;
      }
      i += 1;
    }

    flushList();
    if (inCode && codeBuffer.length) {
      html += `<pre><code>${autolinkCode(escapeHtml(codeBuffer.join("\n")))}</code></pre>`;
    }
    return html;
  }

  global.TabAgentMarkdown = { renderMarkdown, escapeHtml };
})(window);
