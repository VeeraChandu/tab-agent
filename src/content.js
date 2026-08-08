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

  // A link's text is often the distinguishing data itself (paper titles, product
  // names differing only past char 120), so links get a longer cap than buttons.
  function shortText(el) {
    const text =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("title") ||
      el.value ||
      el.innerText ||
      el.textContent ||
      "";
    return text.replace(/\s+/g, " ").trim().slice(0, el.tagName === "A" ? 300 : 120);
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

  // Every ARIA role a library uses to make a plain <div> operable. One missing
  // here is a control the agent can't see at all.
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option",
    "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "treeitem", "gridcell",
    "slider", "spinbutton",
  ]);

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "textarea", "select", "summary"].includes(tag)) return true;
    if (INTERACTIVE_ROLES.has(el.getAttribute("role"))) return true;
    if (el.getAttribute("contenteditable") === "true") return true;
    if (el.onclick || el.getAttribute("onclick")) return true;
    // Component libraries hide the input and style the label over it, so the
    // label is often the only thing a click can land on (see occludedBy).
    if (tag === "label" && el.control) return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex?.trim() && Number(tabindex) >= 0) return true;
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
  // These are pathological-safety ceilings, not content budgets — the agent
  // is meant to see everything actually rendered on a page, the same as a
  // person would, not a pre-guessed "enough" slice of it. Sized to never
  // realistically trigger on real content; only to stop a genuinely
  // pathological page (e.g. a broken infinite-scroll dumping thousands of
  // nodes) from making one scan unworkably large.
  const MAX_IMAGES = 300;
  // The prompt allows navigating only via hrefs from read_page, so a cut href
  // corrupts the one mechanism it has. Real URLs routinely pass 300 chars
  // (signed/tokenized links); this is a pathological ceiling, not a budget.
  const MAX_HREF_CHARS = 4096;

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
      // For a <div>-built control the tag says nothing; the role is the description.
      const role = el.getAttribute("role");
      if (role) entry.role = role;
      // Nearest tagged ancestor, so a flat list reads as a tree. Absent unless
      // the container is itself interactive — <div> wrappers are never tagged.
      const parentTagged = el.parentElement?.closest(`[${AGENT_ATTR}]`);
      if (parentTagged) entry.parent = parentTagged.getAttribute(AGENT_ATTR);

      // Read off ANY element, not just real <input>s — a div-built switch
      // carrying only ARIA attributes is otherwise indistinguishable from off.
      if (el.disabled === true || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
      const ariaChecked = el.getAttribute("aria-checked");
      if (ariaChecked === "true" || ariaChecked === "false") entry.checked = ariaChecked === "true";
      else if (el.type === "checkbox" || el.type === "radio") entry.checked = !!el.checked;
      const pressed = el.getAttribute("aria-pressed");
      if (pressed === "true" || pressed === "false") entry.pressed = pressed === "true";
      const selected = el.getAttribute("aria-selected");
      if (selected === "true" || selected === "false") entry.selected = selected === "true";
      // Every collapsed disclosure, not just the filter-gating ones flagged below.
      const expanded = el.getAttribute("aria-expanded");
      if (expanded === "true" || expanded === "false") entry.expanded = expanded === "true";

      if (tag === "input") {
        entry.inputType = el.type || "text";
        entry.value = el.value ? el.value.slice(0, 200) : "";
        // A slider's value means nothing without its scale — without these the
        // model can't work out what number to write. Defaults are the spec's.
        if (el.type === "range") {
          entry.min = el.min || "0";
          entry.max = el.max || "100";
          entry.step = el.step || "1";
        }
        if (el.type === "checkbox" || el.type === "radio") {
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
        }
      }
      if (tag === "a" && el.href) entry.href = el.href.slice(0, MAX_HREF_CHARS);
      if (tag === "select") {
        // Country/state dropdowns run to ~200 options — showing 30 made the
        // model conclude the option it needed simply wasn't offered.
        entry.options = Array.from(el.options)
          .slice(0, 500)
          .map((o) => o.textContent.trim().slice(0, 200));
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
      if (elements.length >= 2000) break; // pathological-safety cap, see MAX_IMAGES above
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
      if (tables.length >= 100) break; // pathological-safety cap, see MAX_IMAGES above
    }

    // No token-budget trim here — the agent should read the complete text
    // that's actually rendered, the same as a person looking at the page,
    // regardless of how it got there (static HTML or client-side JS). The
    // only limit is a pathological-safety ceiling far above anything a real
    // page would hit; agentLoop.js's readPage() decides whether this fits in
    // one message or needs chunking, not this scan.
    const MAX_BODY_TEXT_CHARS = 2000000;
    const pdf = scanPdfViewer();
    let bodyText = (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
    // innerText orders the PDF's overlay spans by DOM position, not reading
    // order, so a clean per-page copy is appended rather than relied on.
    if (pdf?.text) bodyText += `\n\n=== Rendered PDF (${pdf.pages} page${pdf.pages === 1 ? "" : "s"}) ===\n${pdf.text}`;
    return {
      url: location.href,
      title: document.title,
      elements,
      images,
      tables,
      bodyText: bodyText.slice(0, MAX_BODY_TEXT_CHARS),
      metaCategory: detectMetaCategory(),
      pdf: pdf ? { pages: pdf.pages } : null,
      editorHint: detectEditorHint(),
    };
  }

  // pdf.js paints to a <canvas> a DOM scan can't read, but lays a real text
  // layer of positioned spans over it — the same thing that makes rendered
  // text selectable. Without this a rendered document scans as a blank page.
  function scanPdfViewer() {
    const layers = document.querySelectorAll(".textLayer");
    // Page count and text are separately available: Overleaf's viewer renders
    // canvas only (each page holds just a canvasWrapper), so the count is all
    // there is - and it alone answers "how many pages is this".
    const pages = document.querySelectorAll("[data-page-number]").length || layers.length;
    if (!pages) return null;
    const text = Array.from(layers)
      .map((layer, i) => {
        const num = layer.closest("[data-page-number]")?.getAttribute("data-page-number") || i + 1;
        return `--- page ${num} ---\n${(layer.innerText || layer.textContent || "").replace(/\s+\n/g, "\n").trim()}`;
      })
      .filter((chunk) => chunk.split("\n").slice(1).join("").trim())
      .join("\n\n");
    return { pages, text };
  }

  // The wrapper's class name is plain DOM; the document it holds is not (see
  // readEditorText in lib/agentLoop.js). Gates that round trip to pages that
  // actually have an editor.
  function detectEditorHint() {
    if (document.querySelector(".cm-content")) return "cm6";
    if (document.querySelector(".CodeMirror")) return "cm5";
    if (document.querySelector(".monaco-editor")) return "monaco";
    if (document.querySelector(".ace_editor")) return "ace";
    return null;
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

  // GET_ELEMENT_TEXT / GET_SUBMIT_CONTEXT accept a missing id: that's press_key's
  // risk gate asking about whatever has focus, since Enter fires there. <body>
  // means nothing is focused, which is no target at all — resolving it would
  // feed the whole page's text to the risky-text matcher.
  function resolveForLookup(id) {
    if (id) return findByAgentId(id);
    const active = document.activeElement;
    return active && active !== document.body ? active : null;
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
      if (link && link.href) entry.href = link.href.slice(0, MAX_HREF_CHARS);
      return entry;
    });
  }

  // These setters are brand-checked, so the prototype must match the element:
  // HTMLInputElement's on a <select> throws "Illegal invocation".
  function setValueRaw(el, value) {
    const proto =
      el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype
      : el.tagName === "SELECT" ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  function nativeSetValue(el, value) {
    setValueRaw(el, value);
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

  // Tags whose click() runs a native activation behaviour the page depends on
  // (checkbox/radio toggling, form submit, link navigation) — see doClick.
  const NATIVE_ACTIVATION_TAGS = new Set(["a", "button", "input", "select", "textarea", "label", "summary", "option"]);

  const CLICK_SETTLE_POLL_MS = 150;
  const CLICK_SETTLE_CEILING_MS = 1500;

  // A change that hasn't STARTED yet is indistinguishable from no change, so
  // two matching polls alone can't mean "settled" — XHR listings and lazy
  // images routinely land 500ms+ after the action, and returning at the first
  // match reported them as page_changed: false. Watch at least this long for
  // the first sign of movement before concluding nothing is coming.
  const SETTLE_FIRST_CHANGE_MS = 800;

  // Polls instead of a flat sleep: some client-side re-renders take ~1-1.5s,
  // which a fixed 350ms wait would return before - the next read_page/click
  // would then act on the stale, pre-update page. `baseline` is the caller's
  // pre-action signature, so movement between dispatch and the first poll
  // isn't missed.
  async function waitForSettled(ceilingMs, baseline) {
    let prev = baseline ?? pageSignature();
    let elapsed = 0;
    let changed = false;
    while (elapsed < ceilingMs) {
      await settle(CLICK_SETTLE_POLL_MS);
      elapsed += CLICK_SETTLE_POLL_MS;
      const cur = pageSignature();
      if (cur !== prev) {
        changed = true;
        prev = cur;
        continue;
      }
      if (changed || elapsed >= SETTLE_FIRST_CHANGE_MS) return cur;
    }
    return prev;
  }

  function describeEl(el) {
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}>`;
  }

  // Pre-dispatch actionability: turn a silent no-op into a stated reason. Only
  // conditions that genuinely stop a SYNTHETIC dispatch count as errors here —
  // see occludedBy for the one Playwright treats as fatal and this can't.
  function notActionable(el, id) {
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") {
      return `Element ${id} ${describeEl(el)} is disabled, so clicking or typing into it does nothing. Pick a different element, or first change whatever gates it (a required field, a prior selection).`;
    }
    return notRendered(el, id);
  }

  // The half that applies to any interaction at all. Hover uses only this:
  // "disabled" doesn't stop a hover, and a disabled control's tooltip
  // explaining WHY it's disabled is exactly the kind of thing worth hovering.
  function notRendered(el, id) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return `Element ${id} ${describeEl(el)} is no longer rendered (zero size) — the page changed since the last read_page. Call read_page again for fresh ids.`;
    }
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") {
      return `Element ${id} ${describeEl(el)} is hidden (${style.display === "none" ? "display:none" : "visibility:hidden"}) — expand or open whatever section holds it first, then re-scan.`;
    }
    return null;
  }

  // dispatchEvent reaches an element's listeners even when something covers it,
  // so an overlay must not refuse a click that would have worked — this is only
  // a reason-hint for a click that changed nothing. "" when clear or untestable.
  function occludedBy(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return "";
    const top = document.elementFromPoint(x, y);
    if (!top || top === el || el.contains(top) || top.contains(el)) return "";
    // A <label> (or anything inside one) bound to this control activates it
    // anyway — that's an association, not an obstruction.
    if (top.closest?.("label")?.control === el) return "";
    return describeEl(top);
  }

  function centerOpts(el, extra) {
    const rect = el.getBoundingClientRect();
    return {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      ...extra,
    };
  }

  // The lead-in a real pointer always produces before a press. Drag libraries
  // and hover-primed menus wait for movement, so a sequence that jumps straight
  // to pointerdown reads as "no mouse ever came near this element".
  // enter/over differ only in bubbling — both are dispatched, per spec.
  function hoverEvents(el, opts) {
    try {
      el.dispatchEvent(new PointerEvent("pointerover", opts));
      el.dispatchEvent(new PointerEvent("pointerenter", { ...opts, bubbles: false }));
      el.dispatchEvent(new PointerEvent("pointermove", opts));
    } catch { /* PointerEvent unsupported here — the mouse events below still cover most handlers */ }
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
  }

  async function doHover(id) {
    const el = findByAgentId(id);
    if (!el) return { ok: false, error: `No element with id ${id}. Re-scan the page.` };
    const blocked = notRendered(el, id);
    if (blocked) return { ok: false, error: blocked };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    flashHighlight(el);
    const before = pageSignature();
    hoverEvents(el, centerOpts(el, { button: 0, buttons: 0 }));
    const after = await waitForSettled(CLICK_SETTLE_CEILING_MS, before);
    const changed = before !== after;
    const result = { ok: true, page_changed: changed };
    // CSS :hover needs a trusted pointer, so only JS-driven hover is reachable.
    if (!changed) {
      result.note = "Nothing appeared. If that menu/tooltip is pure CSS :hover, synthetic events can't open it — try clicking the element instead.";
    }
    return result;
  }

  async function doClick(id) {
    const el = findByAgentId(id);
    if (!el) return { ok: false, error: `No element with id ${id}. Re-scan the page.` };
    const blocked = notActionable(el, id);
    if (blocked) return { ok: false, error: blocked };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    flashHighlight(el);
    const covering = occludedBy(el);

    const before = pageSignature();
    const opts = centerOpts(el, { button: 0, buttons: 1 });
    // Some widgets (custom dropdowns, icon buttons, component libraries) key
    // off pointer events rather than mouse events, or read clientX/Y off the
    // event instead of trusting el.click() alone. Dispatch a fuller,
    // coordinate-bearing sequence so more real-world handlers actually fire.
    hoverEvents(el, { ...opts, buttons: 0 });
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
    } catch { /* PointerEvent unsupported in this context — mouse events below still cover most cases */ }
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try {
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    } catch { /* see above */ }
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    // Exactly ONE click activation - firing both el.click() and a synthetic
    // click delivered two click events per agent click, so anything toggling
    // netted back to where it started. Only el.click() runs native activation
    // behaviour (checkbox/radio, form submit, link); the dispatched event
    // carries the real clientX/clientY that el.click() reports as 0.
    if (NATIVE_ACTIVATION_TAGS.has(el.tagName.toLowerCase())) el.click();
    else el.dispatchEvent(new MouseEvent("click", opts));

    const after = await waitForSettled(CLICK_SETTLE_CEILING_MS, before);
    // page_changed is a heuristic, not proof either way: a false page can
    // legitimately not change on a valid click (e.g. toggling a checkbox
    // with no visible label change), and a page can drift on its own (ads,
    // clocks). It's still a strong, cheap signal for the common failure mode
    // this exists to catch — clicking something that does nothing at all.
    const changed = before !== after;
    const result = { ok: true, page_changed: changed };
    if (!changed && covering) {
      result.note = `Nothing changed, and the click point is covered by ${covering} — likely an overlay, cookie banner or sticky header intercepting it. Dismiss that first, or click it instead if it's what you actually wanted.`;
    }
    return result;
  }

  // read_page shows options as visible TEXT, so that's what comes back.
  function findOption(el, wanted) {
    const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
    // Internal spacing is where this actually bites: "32 GB" vs "32GB".
    const squash = (s) => norm(s).replace(/\s/g, "");
    const opts = Array.from(el.options);
    return (
      opts.find((o) => o.value === wanted) ||
      opts.find((o) => o.text.trim() === String(wanted).trim()) ||
      opts.find((o) => norm(o.text) === norm(wanted)) ||
      opts.find((o) => squash(o.text) === squash(wanted)) ||
      opts.find((o) => norm(o.text).includes(norm(wanted))) ||
      null
    );
  }

  async function doSelect(id, values) {
    const el = findByAgentId(id);
    if (!el) return { ok: false, error: `No element with id ${id}. Re-scan the page.` };
    if (el.tagName !== "SELECT") {
      return {
        ok: false,
        error: `Element ${id} ${describeEl(el)} is not a <select> dropdown. If it's a custom dropdown widget, click it to open it and then click the option you want; if it's a text field, use type_text.`,
      };
    }
    const blocked = notActionable(el, id);
    if (blocked) return { ok: false, error: blocked };

    const wanted = (Array.isArray(values) ? values : [values]).filter((v) => v !== undefined && v !== null && v !== "");
    if (!wanted.length) return { ok: false, error: "values is required - pass the option(s) to select, as shown in read_page's options list." };
    if (!el.multiple && wanted.length > 1) {
      return { ok: false, error: `Element ${id} only takes one option at a time (it isn't a multi-select), but ${wanted.length} were given.` };
    }

    const matched = [];
    const missing = [];
    for (const want of wanted) {
      const opt = findOption(el, want);
      if (opt) matched.push(opt);
      else missing.push(want);
    }
    // Listing what IS there costs one round trip instead of a stall.
    if (missing.length) {
      const available = Array.from(el.options).map((o) => o.text.trim()).join(" | ");
      return { ok: false, error: `No option matching ${missing.map((m) => `"${m}"`).join(", ")} in element ${id}. Available options: ${available}` };
    }

    el.scrollIntoView({ block: "center", behavior: "instant" });
    flashHighlight(el);
    const before = pageSignature();
    if (el.multiple) {
      for (const opt of el.options) opt.selected = matched.includes(opt);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      nativeSetValue(el, matched[0].value);
    }
    const after = await waitForSettled(CLICK_SETTLE_CEILING_MS, before);
    return { ok: true, page_changed: before !== after, selected: matched.map((o) => o.text.trim()) };
  }

  function codeForChar(ch) {
    if (/^[a-z]$/i.test(ch)) return `Key${ch.toUpperCase()}`;
    if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
    if (ch === " ") return "Space";
    return "";
  }

  // A one-shot value set fires ONE input event, invisible to widgets built on
  // per-character keydown/keyup (address autocompletes, @-mention menus). The
  // pause gives them a chance to render between keys.
  const PER_KEY_DELAY_MS = 15;

  async function typePerKey(el, text) {
    setValueRaw(el, "");
    for (const ch of text) {
      const init = { key: ch, code: codeForChar(ch), bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", init));
      el.dispatchEvent(new KeyboardEvent("keypress", init));
      setValueRaw(el, el.value + ch);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", init));
      await settle(PER_KEY_DELAY_MS);
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Rich editors (ProseMirror, Slate, Quill, Lexical) rebuild the DOM from
  // their own model, so assigning textContent skips beforeinput and corrupts
  // them. execCommand is deprecated but the only synthetic path they accept.
  function setContentEditable(el, text) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    if (document.execCommand("insertText", false, text)) return;
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
  }

  async function doType(id, text, submit, perKey) {
    const el = findByAgentId(id);
    if (!el) return { ok: false, error: `No element with id ${id}. Re-scan the page.` };
    if (el.tagName === "SELECT") {
      return { ok: false, error: `Element ${id} is a <select> dropdown, not a text field - use select_option with the option's visible text instead.` };
    }
    // Everything else has no value setter to call, and reaching for one throws
    // an opaque "Illegal invocation" instead of saying what's wrong.
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && !el.isContentEditable) {
      return {
        ok: false,
        error: `Element ${id} ${describeEl(el)} isn't a text field, so there's nothing to type into. If it opens one (a search icon, a combobox), click it first and re-scan; the field itself will be a separate id.`,
      };
    }
    const blocked = notActionable(el, id);
    if (blocked) return { ok: false, error: blocked };
    if (el.readOnly) return { ok: false, error: `Element ${id} ${describeEl(el)} is read-only — typed text won't stick. It's probably filled by picking from a widget (date picker, dropdown) instead.` };
    el.scrollIntoView({ block: "center", behavior: "instant" });
    flashHighlight(el);
    el.focus();
    const before = pageSignature();
    if (el.isContentEditable) {
      setContentEditable(el, text);
    } else if (perKey) {
      await typePerKey(el, text);
    } else {
      nativeSetValue(el, text);
    }
    if (submit) {
      const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent("keydown", enter));
      // Legacy form code still binds to keypress, which nothing here fired.
      el.dispatchEvent(new KeyboardEvent("keypress", enter));
      const form = el.closest("form");
      if (form && form.requestSubmit) form.requestSubmit();
      el.dispatchEvent(new KeyboardEvent("keyup", enter));
    }
    // A flat wait returned before async validation/autocomplete had rendered.
    const after = await waitForSettled(CLICK_SETTLE_CEILING_MS, before);
    return { ok: true, page_changed: before !== after };
  }

  // Legacy handlers (and plenty of current ones) still branch on keyCode/which,
  // which KeyboardEvent won't derive from `key` on its own.
  const KEY_CODES = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, " ": 32,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    PageUp: 33, PageDown: 34, Home: 36, End: 35,
  };

  // Handlers compare against `e.key` exactly, so "escape" would reach them
  // spelled wrong and match nothing — a silent no-op with no error to read.
  const CANONICAL_KEYS = new Map(Object.keys(KEY_CODES).map((k) => [k.toLowerCase(), k]));

  // "Escape", "ArrowDown", "Control+a", "Shift+Tab" — modifiers are prefixes,
  // so the key itself is whatever follows the last "+" ("Shift++" → "+").
  function parseKeySpec(spec) {
    const parts = String(spec).split("+");
    const raw = parts.pop() || "+";
    // Only named keys get case-corrected; for a single character, case is the
    // difference between "a" and "A".
    const key = raw.length === 1 ? raw : CANONICAL_KEYS.get(raw.toLowerCase()) || raw;
    const mods = parts.map((m) => m.toLowerCase());
    return {
      key,
      code: key.length === 1 ? codeForChar(key) : key,
      keyCode: KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0),
      ctrlKey: mods.includes("control") || mods.includes("ctrl"),
      shiftKey: mods.includes("shift"),
      altKey: mods.includes("alt") || mods.includes("option"),
      metaKey: mods.includes("meta") || mods.includes("cmd") || mods.includes("command"),
    };
  }

  async function doPressKey(spec, elementId) {
    // " " is a legitimate key, so this can't be a trim()-based check.
    if (typeof spec !== "string" || spec === "") {
      return { ok: false, error: "key is required, e.g. 'Escape', 'ArrowDown', 'Enter', 'Tab', or a combo like 'Control+a'." };
    }
    let el;
    if (elementId) {
      el = findByAgentId(elementId);
      if (!el) return { ok: false, error: `No element with id ${elementId}. Re-scan the page.` };
      const blocked = notActionable(el, elementId);
      if (blocked) return { ok: false, error: blocked };
      el.scrollIntoView({ block: "center", behavior: "instant" });
      el.focus();
    } else {
      // Escape/arrows are usually meant for whatever has focus; document.body
      // is the sane fallback for page-level keys with nothing focused.
      el = document.activeElement || document.body;
    }
    const init = parseKeySpec(spec);
    const eventInit = { ...init, bubbles: true, cancelable: true, which: init.keyCode };

    const before = pageSignature();
    el.dispatchEvent(new KeyboardEvent("keydown", eventInit));
    // keypress only ever fired for printable characters, and legacy form code
    // still binds to it.
    if (init.key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", eventInit));
    el.dispatchEvent(new KeyboardEvent("keyup", eventInit));
    const after = await waitForSettled(CLICK_SETTLE_CEILING_MS, before);
    return { ok: true, page_changed: before !== after, key: init.key, target: el === document.body ? "page" : describeEl(el) };
  }

  const CHECKED_VALUES = /^(true|yes|on|checked|1)$/i;

  // One field, no settle — doFillForm settles once for the whole batch, which
  // is the entire point of filling as a batch. Returns an error string or null.
  function fillOne(el, value) {
    if (el.tagName === "SELECT") {
      if (el.multiple) return "is a multi-select — use select_option for it, which takes several values.";
      const opt = findOption(el, value);
      if (!opt) return `has no option matching "${value}". Available options: ${Array.from(el.options).map((o) => o.text.trim()).join(" | ")}`;
      nativeSetValue(el, opt.value);
      return null;
    }
    if (el.type === "checkbox" || el.type === "radio") {
      const want = value === true || CHECKED_VALUES.test(String(value));
      if (el.type === "radio" && !want) return "is a radio button, which can only be turned on — fill the option you DO want instead.";
      // click(), not .checked = — native activation is what fires input/change.
      if (el.checked !== want) el.click();
      return null;
    }
    if (el.isContentEditable) {
      el.focus();
      setContentEditable(el, String(value));
      return null;
    }
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return "isn't a fillable field — if it's a button, toggle or custom widget, click it instead.";
    if (el.readOnly) return "is read-only — typed text won't stick.";
    // Sequential focus() also fires blur on the previous field, so per-field
    // on-blur validation runs exactly as it would for a person tabbing through.
    el.focus();
    nativeSetValue(el, String(value));
    return null;
  }

  async function doFillForm(fields) {
    if (!Array.isArray(fields) || !fields.length) {
      return { ok: false, error: "fields is required - pass [{ element_id, value }, ...] using ids from read_page." };
    }
    const before = pageSignature();
    const results = [];
    for (const field of fields) {
      const id = field?.element_id;
      const el = id ? findByAgentId(id) : null;
      if (!el) {
        results.push({ element_id: id, ok: false, error: `No element with id ${id}. Re-scan the page.` });
        continue;
      }
      const blocked = notActionable(el, id);
      if (blocked) {
        results.push({ element_id: id, ok: false, error: blocked });
        continue;
      }
      const problem = fillOne(el, field.value);
      results.push(problem ? { element_id: id, ok: false, error: `Element ${id} ${describeEl(el)} ${problem}` } : { element_id: id, ok: true });
    }
    const after = await waitForSettled(CLICK_SETTLE_CEILING_MS, before);
    const failed = results.filter((r) => !r.ok).length;
    return {
      // A partial fill is still a fill: per-field errors say what to retry.
      ok: failed < results.length,
      page_changed: before !== after,
      filled: results.length - failed,
      fields: results,
      error: failed === results.length ? `No field could be filled: ${results[0].error}` : undefined,
    };
  }

  const MAX_TABLE_ROWS = 5000; // pathological-safety cap, see MAX_IMAGES above

  function extractTable(id) {
    const el = findByAgentId(id);
    if (!el || el.tagName.toLowerCase() !== "table") {
      return { ok: false, error: `No table with id ${id}. Re-scan the page.` };
    }
    const allRows = Array.from(el.querySelectorAll("tr"));
    const rows = allRows.slice(0, MAX_TABLE_ROWS).map((tr) =>
      Array.from(tr.querySelectorAll("th, td")).map((cell) => {
        const text = cell.textContent.replace(/\s+/g, " ").trim().slice(0, 2000);
        // Most cells are plain text, kept as a bare string to avoid bloating
        // the payload — only a cell that actually wraps a link (e.g. a
        // product name that's also its own page link) becomes {text, href},
        // so the model can carry that link into a summary/comparison instead
        // of losing it (extract_table used to return text only).
        const link = cell.querySelector("a[href]");
        return link && link.href ? { text, href: link.href.slice(0, MAX_HREF_CHARS) } : text;
      })
    );
    return { ok: true, rows, truncated: allRows.length > MAX_TABLE_ROWS, total_rows: allRows.length };
  }

  // Content in a scrollable div (chat panes, virtualized lists, modal bodies)
  // never moves when only the window scrolls.
  function scrollableAncestor(el) {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      const scrollable = /auto|scroll|overlay/.test(style.overflowY);
      if (scrollable && node.scrollHeight > node.clientHeight + 1) return node;
    }
    return null;
  }

  // to:"bottom" stops when the page stops producing content, so this only
  // bounds a genuinely infinite feed.
  const MAX_SCROLL_STEPS = 40;

  // App-shell layouts (LinkedIn's profile, Gmail, most dashboards) pin the
  // window to viewport height and scroll an inner element instead. There
  // window.scrollBy moves nothing and the at_bottom arithmetic is trivially
  // true, so scrolling reports "already at the end" on a page that has pages
  // of unread content below the fold. Falls back to the tallest real scroller.
  function pageScroller() {
    if (document.documentElement.scrollHeight > window.innerHeight + 4) return null;
    let best = null;
    for (const el of document.querySelectorAll("body *")) {
      if (el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 50) continue;
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      if (!best || el.clientHeight > best.clientHeight) best = el;
    }
    return best;
  }

  async function scrollOnce(container, delta) {
    const before = pageSignature();
    const beforeTop = container ? container.scrollTop : window.scrollY;
    if (container) container.scrollTop += delta;
    else window.scrollBy({ top: delta, behavior: "instant" });

    // Lazy-loading listings render after the scroll event; returning
    // immediately left the next read_page scanning the pre-load DOM.
    const after = await waitForSettled(CLICK_SETTLE_CEILING_MS, before);
    const afterTop = container ? container.scrollTop : window.scrollY;
    const height = container ? container.scrollHeight : document.documentElement.scrollHeight;
    const viewport = container ? container.clientHeight : window.innerHeight;
    return {
      page_changed: before !== after,
      scrolled_by: afterTop - beforeTop,
      at_bottom: afterTop + viewport >= height - 2,
    };
  }

  async function doScroll(direction, amount, elementId, to) {
    let container;
    if (elementId) {
      const el = findByAgentId(elementId);
      if (!el) return { ok: false, error: `No element with id ${elementId}. Re-scan the page.` };
      container = scrollableAncestor(el);
      if (!container) {
        return { ok: false, error: `Element ${elementId} isn't inside a scrollable container - scroll without element_id to scroll the page itself.` };
      }
    } else {
      container = pageScroller();
    }

    // A step is measured against whatever actually scrolls, so an inner pane
    // shorter than the window doesn't get overshot a screenful at a time.
    const px = amount || Math.round((container ? container.clientHeight : window.innerHeight) * 0.8);
    const delta = direction === "up" ? -px : px;

    if (to !== "bottom") {
      // at_bottom with page_changed false is the honest "stop scrolling" signal.
      return { ok: true, ...(await scrollOnce(container, delta)) };
    }

    // A lazy-loading page needs many scrolls to reveal its content; running
    // them here costs one tool call instead of a model turn each.
    let steps = 0;
    let scrolled = 0;
    let last = { page_changed: false, scrolled_by: 0, at_bottom: false };
    while (steps < MAX_SCROLL_STEPS) {
      last = await scrollOnce(container, Math.abs(delta));
      steps += 1;
      scrolled += last.scrolled_by;
      // Content still loading in counts as progress even once the scrollbar
      // stops moving, so a feed that appends on scroll isn't abandoned early.
      if (last.at_bottom && !last.page_changed) break;
      if (last.scrolled_by === 0 && !last.page_changed) break;
    }
    return {
      ok: true,
      page_changed: scrolled !== 0 || last.page_changed,
      scrolled_by: scrolled,
      at_bottom: last.at_bottom,
      scroll_steps: steps,
      note:
        steps >= MAX_SCROLL_STEPS
          ? `Stopped after ${steps} scrolls without reaching the end - this page may load endlessly. Read what's here; scroll again with to:"bottom" only if you specifically need more.`
          : undefined,
    };
  }

  // Every action settles before it answers, so they all reply asynchronously
  // and all fail the same way — one table beats seven copies of .then/.catch.
  const ACTIONS = {
    CLICK: (m) => doClick(m.id),
    TYPE: (m) => doType(m.id, m.text, m.submit, m.perKey),
    SELECT_OPTION: (m) => doSelect(m.id, m.values),
    HOVER: (m) => doHover(m.id),
    PRESS_KEY: (m) => doPressKey(m.key, m.id),
    FILL_FORM: (m) => doFillForm(m.fields),
    SCROLL: (m) => doScroll(m.direction, m.amount, m.elementId, m.to),
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      const action = ACTIONS[msg.type];
      if (action) {
        action(msg)
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      switch (msg.type) {
        case "PING":
          sendResponse({ ok: true });
          break;
        case "SCAN":
          sendResponse({ ok: true, data: scanPage() });
          break;
        case "GET_IMAGE_SRCS":
          sendResponse({ ok: true, data: getImageSrcs(msg.ids) });
          break;
        case "EXTRACT_TABLE":
          sendResponse(extractTable(msg.id));
          break;
        case "GET_ELEMENT_TEXT": {
          const el = resolveForLookup(msg.id);
          if (!el) {
            sendResponse({ ok: false, error: `No element with id ${msg.id}. Re-scan the page.` });
          } else {
            sendResponse({ ok: true, data: { text: shortText(el) } });
          }
          break;
        }
        case "GET_SUBMIT_CONTEXT": {
          const el = resolveForLookup(msg.id);
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
