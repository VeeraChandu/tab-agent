// content.js
// Runs in every page. Lets the background agent loop "see" and "act on"
// the page without any external server / MCP setup.

(() => {
  if (window.__tabAgentContentLoaded) return;
  window.__tabAgentContentLoaded = true;

  const AGENT_ATTR = "data-agent-id";
  let counter = 0;

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    return true;
  }

  function shortText(el) {
    const text =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.value ||
      el.innerText ||
      el.textContent ||
      "";
    return text.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select"].includes(tag)) return true;
    const role = el.getAttribute("role");
    if (role && ["button", "link", "textbox", "checkbox", "radio", "combobox", "tab", "menuitem"].includes(role)) return true;
    if (el.getAttribute("contenteditable") === "true") return true;
    if (el.onclick || el.getAttribute("onclick")) return true;
    return false;
  }

  function clearTags() {
    document.querySelectorAll(`[${AGENT_ATTR}]`).forEach((el) => el.removeAttribute(AGENT_ATTR));
  }

  // Minimum rendered size (px, either dimension) for an <img> to be worth
  // tagging — filters out icons, avatars-as-decoration, tracking pixels, and
  // other small graphics that are never what a "look at this image" or
  // "filter these images" request actually means.
  const MIN_IMAGE_DIM = 80;
  // Separate cap from the 250-element interactive cap: image-heavy pages
  // (search results, product grids) can have hundreds of <img> tags, and
  // tagging all of them would bloat the scan payload for little benefit —
  // the model can scroll and re-scan to reach more.
  const MAX_IMAGES = 60;

  function scanPage() {
    clearTags();
    counter = 0;
    const nodes = Array.from(document.querySelectorAll("body, body *"));
    const elements = [];

    for (const el of nodes) {
      if (!isInteractive(el)) continue;
      if (!isVisible(el)) continue;

      counter += 1;
      const id = `e${counter}`;
      el.setAttribute(AGENT_ATTR, id);

      const tag = el.tagName.toLowerCase();
      const entry = {
        id,
        tag,
        text: shortText(el),
      };
      if (tag === "input") {
        entry.inputType = el.type || "text";
        entry.value = el.value ? el.value.slice(0, 200) : "";
        if (el.checked !== undefined && (el.type === "checkbox" || el.type === "radio")) {
          entry.checked = el.checked;
        }
      }
      if (tag === "a" && el.href) entry.href = el.href.slice(0, 200);
      if (tag === "select") {
        entry.options = Array.from(el.options)
          .slice(0, 30)
          .map((o) => o.textContent.trim().slice(0, 60));
        entry.value = el.value;
      }
      elements.push(entry);
      if (elements.length >= 250) break; // safety cap
    }

    // Separate pass + separate id namespace ("imgN") for <img> elements, so
    // an image that's ALSO a clickable link (e.g. a product thumbnail inside
    // an <a>) can be tagged both ways — "eN" to click it, "imgN" to view it —
    // without either tagging pass clobbering the other's attribute.
    let imgCounter = 0;
    const images = [];
    for (const el of document.querySelectorAll("img")) {
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_IMAGE_DIM || rect.height < MIN_IMAGE_DIM) continue;

      imgCounter += 1;
      const id = `img${imgCounter}`;
      el.setAttribute(AGENT_ATTR, id);
      images.push({
        id,
        alt: (el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 150),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      if (images.length >= MAX_IMAGES) break;
    }

    // Separate id namespace ("tblN"), same pattern as images — real <table>
    // markup only (thead/tbody/tr/td), since that's the case extract_table
    // can parse reliably. Non-table "card grid" layouts aren't covered.
    let tableCounter = 0;
    const tables = [];
    for (const el of document.querySelectorAll("table")) {
      if (!isVisible(el)) continue;
      tableCounter += 1;
      const id = `tbl${tableCounter}`;
      el.setAttribute(AGENT_ATTR, id);
      const headerCells = Array.from(el.querySelectorAll("thead th, tr:first-child th, tr:first-child td"))
        .slice(0, 20)
        .map((c) => c.textContent.replace(/\s+/g, " ").trim().slice(0, 60));
      tables.push({
        id,
        rows: el.querySelectorAll("tr").length,
        columns: headerCells.length,
        header_preview: headerCells,
      });
      if (tables.length >= 20) break;
    }

    return {
      url: location.href,
      title: document.title,
      elements,
      images,
      tables,
      bodyText: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 6000),
      metaCategory: detectMetaCategory(),
    };
  }

  // The RTA ("Restricted To Adults") label is the actual industry-standard
  // self-rating real content filters use — a page opts into it via this
  // exact meta tag. Checking for it catches adult sites our curated hostname
  // list (lib/siteCategories.js) doesn't know about. Best-effort: a page
  // that doesn't self-label this way won't be caught here.
  function detectMetaCategory() {
    const ratingMeta = document.querySelector('meta[name="rating" i]');
    const content = (ratingMeta?.getAttribute("content") || "").toLowerCase();
    if (content.includes("rta-5042-1996-1400-1577-rta") || content.includes("adult") || content.includes("mature")) {
      return "adult";
    }
    return null;
  }

  function findByAgentId(id) {
    return document.querySelector(`[${AGENT_ATTR}="${CSS.escape(id)}"]`);
  }

  // Re-resolves the current src for a set of previously-tagged image ids, at
  // the moment they're actually needed (not from the original scan) — more
  // robust against SPA pages that swap image sources without a full
  // re-render the agent would otherwise catch via a fresh read_page.
  function getImageSrcs(ids) {
    return (ids || []).map((id) => {
      const el = findByAgentId(id);
      if (!el || el.tagName.toLowerCase() !== "img") {
        return { id, error: `No image with id ${id}. Re-scan the page.` };
      }
      const rect = el.getBoundingClientRect();
      const src = el.currentSrc || el.src || "";
      if (!src) return { id, error: `Image ${id} has no resolvable source.` };
      const entry = {
        id,
        src,
        alt: (el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 150),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      // Product thumbnails are very often wrapped in the link to the product
      // page itself — surface that href here so view_image/filter_images
      // results can be traced back to a page to link to, not just the image.
      const link = el.closest("a[href]");
      if (link && link.href) entry.href = link.href.slice(0, 300);
      return entry;
    });
  }

  function nativeSetValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Brief visual outline so the user watching the actual page (not just the
  // side panel log) can see what the agent just acted on — transparency,
  // same spirit as competitors that show a highlight/cursor over the element
  // they're about to touch. Reverted automatically; never left behind.
  function flashHighlight(el) {
    const prev = { outline: el.style.outline, outlineOffset: el.style.outlineOffset, transition: el.style.transition };
    el.style.transition = "outline-color 0.15s ease";
    el.style.outline = "3px solid #4f46e5";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = prev.outline;
      el.style.outlineOffset = prev.outlineOffset;
      el.style.transition = prev.transition;
    }, 500);
  }

  // Cheap, order-independent-ish fingerprint of what's rendered — not a real
  // diff, just enough signal to tell the model whether an action actually did
  // anything. innerText length catches new/removed visible text (menus,
  // search bars, modals, error messages); element count catches DOM
  // insertions/removals that don't change visible text.
  function pageSignature() {
    const text = document.body?.innerText || "";
    return `${location.href}|${document.title}|${text.length}|${document.querySelectorAll("body *").length}`;
  }

  function settle(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function doClick(id) {
    const el = findByAgentId(id);
    if (!el) return { ok: false, error: `No element with id ${id}. Re-scan the page.` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    flashHighlight(el);

    const before = pageSignature();
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0, buttons: 1 };
    // Some widgets (custom dropdowns, icon buttons, component libraries) key
    // off pointer events rather than mouse events, or read clientX/Y off the
    // event instead of trusting el.click() alone. Dispatch a fuller,
    // coordinate-bearing sequence so more real-world handlers actually fire.
    try {
      el.dispatchEvent(new PointerEvent("pointerover", opts));
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
    } catch { /* PointerEvent unsupported in this context — mouse events below still cover most cases */ }
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try {
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    } catch { /* see above */ }
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click?.();
    el.dispatchEvent(new MouseEvent("click", opts));

    await settle(350);
    const after = pageSignature();
    // page_changed is a heuristic, not proof either way: a false page can
    // legitimately not change on a valid click (e.g. toggling a checkbox
    // with no visible label change), and a page can drift on its own (ads,
    // clocks). It's still a strong, cheap signal for the common failure mode
    // this exists to catch — clicking something that does nothing at all.
    return { ok: true, page_changed: before !== after };
  }

  async function doType(id, text, submit) {
    const el = findByAgentId(id);
    if (!el) return { ok: false, error: `No element with id ${id}. Re-scan the page.` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    flashHighlight(el);
    el.focus();
    const before = pageSignature();
    if (el.getAttribute("contenteditable") === "true") {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      nativeSetValue(el, text);
    }
    if (submit) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const form = el.closest("form");
      if (form && form.requestSubmit) form.requestSubmit();
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    }
    await settle(250);
    const after = pageSignature();
    return { ok: true, page_changed: before !== after };
  }

  const MAX_TABLE_ROWS = 500;

  function extractTable(id) {
    const el = findByAgentId(id);
    if (!el || el.tagName.toLowerCase() !== "table") {
      return { ok: false, error: `No table with id ${id}. Re-scan the page.` };
    }
    const allRows = Array.from(el.querySelectorAll("tr"));
    const rows = allRows.slice(0, MAX_TABLE_ROWS).map((tr) =>
      Array.from(tr.querySelectorAll("th, td")).map((cell) => {
        const text = cell.textContent.replace(/\s+/g, " ").trim().slice(0, 300);
        // Most cells are plain text, kept as a bare string to avoid bloating
        // the payload — only a cell that actually wraps a link (e.g. a
        // product name that's also its own page link) becomes {text, href},
        // so the model can carry that link into a summary/comparison instead
        // of losing it (extract_table used to return text only).
        const link = cell.querySelector("a[href]");
        return link && link.href ? { text, href: link.href.slice(0, 300) } : text;
      })
    );
    return { ok: true, rows, truncated: allRows.length > MAX_TABLE_ROWS, total_rows: allRows.length };
  }

  function doScroll(direction, amount) {
    const px = amount || Math.round(window.innerHeight * 0.8);
    window.scrollBy({ top: direction === "up" ? -px : px, behavior: "instant" });
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      switch (msg.type) {
        case "PING":
          sendResponse({ ok: true });
          break;
        case "SCAN":
          sendResponse({ ok: true, data: scanPage() });
          break;
        case "GET_TEXT":
          sendResponse({ ok: true, data: { url: location.href, title: document.title, text: (document.body?.innerText || "").slice(0, 8000) } });
          break;
        case "CLICK":
          doClick(msg.id)
            .then(sendResponse)
            .catch((err) => sendResponse({ ok: false, error: String(err) }));
          break;
        case "TYPE":
          doType(msg.id, msg.text, msg.submit)
            .then(sendResponse)
            .catch((err) => sendResponse({ ok: false, error: String(err) }));
          break;
        case "SCROLL":
          sendResponse(doScroll(msg.direction, msg.amount));
          break;
        case "GET_IMAGE_SRCS":
          sendResponse({ ok: true, data: getImageSrcs(msg.ids) });
          break;
        case "EXTRACT_TABLE":
          sendResponse(extractTable(msg.id));
          break;
        case "GET_ELEMENT_TEXT": {
          const el = findByAgentId(msg.id);
          if (!el) {
            sendResponse({ ok: false, error: `No element with id ${msg.id}. Re-scan the page.` });
          } else {
            sendResponse({ ok: true, data: { text: shortText(el) } });
          }
          break;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return true;
  });
})();
