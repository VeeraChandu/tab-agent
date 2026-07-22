// content.js
// Runs in every page. Lets the background agent loop "see" and "act on"
// the page without any external server / MCP setup.

(() => {
  if (window.__tabAgentContentLoaded) return;
  window.__tabAgentContentLoaded = true;

  const AGENT_ATTR = "data-agent-id";
  // Deliberately NEVER reset across scans (see scanPage below) — ids climb
  // monotonically for the lifetime of this content script instance instead
  // of restarting at e1/img1/tbl1 every time. clearTags() still wipes every
  // OLD data-agent-id attribute on each scan, so a stale id from an earlier
  // scan simply stops existing anywhere rather than silently resolving to a
  // completely different element that happens to get recycled the same id
  // in a later scan — a real failure mode with per-scan-reset counters,
  // since click/type_text would then act on the wrong element with no error
  // at all (recoverStaleElement only catches the "id doesn't exist" case,
  // not "id now points somewhere else").
  let counter = 0;
  let imgCounter = 0;
  let tableCounter = 0;

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

  // A bare checkbox/radio <input> almost never has its own readable text —
  // it's a void element (no innerText/textContent), and its `value` is
  // frequently an internal code ("32gb", "ram-32", "on"), not the label a
  // person actually reads ("32GB"). The real label almost always lives on a
  // separate <label> element instead, associated one of three standard ways:
  // an explicit for="<id>", wrapping the input directly, or aria-labelledby
  // pointing at another element's id. Checked in that order; first match
  // wins. Used specifically for filter-panel checkboxes/radios (see
  // scanPage below) since that's where a missing/wrong label most directly
  // breaks the agent's ability to pick the right option.
  function labelForInput(el) {
    if (el.id) {
      const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (explicit) {
        const t = (explicit.innerText || explicit.textContent || "").replace(/\s+/g, " ").trim();
        if (t) return t.slice(0, 120);
      }
    }
    const wrapping = el.closest("label");
    if (wrapping) {
      const t = (wrapping.innerText || wrapping.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t.slice(0, 120);
    }
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => (n.innerText || n.textContent || "").trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (t) return t.slice(0, 120);
    }
    return "";
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
          // Groups related checkboxes/radios together (see
          // detectFilterControls in lib/agentLoop.js) — a shared `name` is
          // the standard HTML mechanism a radio group relies on to function
          // at all, and real-world checkbox filter panels commonly reuse it
          // too even though it's not strictly required for them.
          if (el.name) entry.groupName = el.name;
          // Overrides shortText's guess above with the input's REAL
          // associated label when one exists — see labelForInput's comment
          // for why the input's own text is usually empty or unhelpful.
          const label = labelForInput(el);
          if (label) entry.text = label;
          // Real facet panels commonly disable an option that doesn't exist
          // in combination with whatever else is already selected (e.g. a
          // 32GB config that isn't offered for a given model/size pair).
          // Surfacing this means the agent can report "not offered" as a
          // real finding instead of silently failing to click it, or
          // concluding — wrongly — that the option simply isn't on the page.
          if (el.disabled) entry.disabled = true;
        }
      }
      if (tag === "a" && el.href) entry.href = el.href.slice(0, 200);
      if (tag === "select") {
        entry.options = Array.from(el.options)
          .slice(0, 30)
          .map((o) => o.textContent.trim().slice(0, 60));
        entry.value = el.value;
      }
      // Standard ARIA disclosure/accordion pattern: a toggle whose panel is
      // currently collapsed (aria-expanded="false") but still holds real
      // filter controls in the DOM, just hidden until expanded (Apple's own
      // refurb store does exactly this — only "Models" starts expanded;
      // Sizes/Memory/Capacity/etc. are collapsed by default). Those inputs
      // fail isVisible() and never reach this loop at all, so without this,
      // the agent has no way to learn those facets even exist. The toggle
      // ELEMENT itself is visible (only its content panel isn't), so it's
      // already being captured above — this just flags it as worth
      // expanding when it's specifically gating filter controls, not any
      // other kind of collapsed content (nav menus, FAQ answers, etc.).
      if (el.getAttribute("aria-expanded") === "false") {
        const controlsId = el.getAttribute("aria-controls");
        const target = controlsId ? document.getElementById(controlsId) : null;
        if (target && target.querySelector('input[type="checkbox"], input[type="radio"], select')) {
          entry.expandsFilters = true;
        }
      }
      elements.push(entry);
      if (elements.length >= 250) break; // safety cap
    }

    // Separate pass + separate id namespace ("imgN") for <img> elements, so
    // an image that's ALSO a clickable link (e.g. a product thumbnail inside
    // an <a>) can be tagged both ways — "eN" to click it, "imgN" to view it —
    // without either tagging pass clobbering the other's attribute.
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

  // The risky-action confirm gate (agentLoop.js's checkRiskyAction) reads an
  // element's OWN visible text — fine for a button labeled "Delete", but a
  // type_text+submit action's risk usually lives on the FORM's submit
  // button instead (the text field itself rarely says "delete" or "pay
  // now"). Surfaces that button's text separately so the gate can check
  // both instead of missing risky form submissions entirely.
  function getSubmitButtonText(el) {
    const form = el.closest("form");
    if (!form) return "";
    const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    return btn ? shortText(btn) : "";
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
        case "GET_SUBMIT_CONTEXT": {
          const el = findByAgentId(msg.id);
          if (!el) {
            sendResponse({ ok: false, error: `No element with id ${msg.id}. Re-scan the page.` });
          } else {
            sendResponse({ ok: true, data: { text: getSubmitButtonText(el) } });
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
