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

  // querySelectorAll never descends into shadow roots - a site built on web
  // components (Salesforce Lightning, many design systems, parts of YouTube/
  // Reddit) renders controls that would otherwise be invisible to every pass
  // below, and the model concludes the content simply doesn't exist. Closed
  // shadow roots stay invisible regardless (.shadowRoot is null for those,
  // nothing to pierce) - same as Playwright without special handling.
  // Includes `root` itself (not just its descendants) - the old
  // document.querySelectorAll("body, body *") this replaced matched body
  // itself via the "body" branch, so a body with onclick/tabindex was
  // taggable; dropping it here would have silently stopped that working.
  function allDescendants(root) {
    const out = [root];
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      for (const child of node.children) {
        out.push(child);
        stack.push(child);
        if (child.shadowRoot) stack.push(child.shadowRoot);
      }
    }
    return out;
  }

  function scanPage() {
    // One walk, reused for both clearing last scan's tags and this scan's
    // own passes below - clearTags() used to do its own separate
    // allDescendants() walk here, doubling the shadow-DOM tree-walk cost of
    // every single read_page call for no benefit.
    const nodes = allDescendants(document.body);
    for (const el of nodes) {
      if (el.hasAttribute(AGENT_ATTR)) el.removeAttribute(AGENT_ATTR);
    }
    const elements = [];

    for (const el of nodes) {
      if (!isInteractive(el)) continue;
      if (!isVisible(el)) continue;

      counter += 1;
      const id = `e${counter}`;
      el.setAttribute(AGENT_ATTR, id);

      const tag = el.tagName.toLowerCase();
      const rect = el.getBoundingClientRect();
      const entry = {
        id,
        tag,
        text: shortText(el),
        // Viewport-relative [x, y, width, height], rounded - spatial signal
        // ("the X next to the cart icon") and a ready-made target for a
        // coordinate click (see the click tool's x/y args) without a second
        // round trip to work out where something actually is.
        box: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
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
    for (const el of nodes) {
      if (el.tagName !== "IMG") continue;
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
    for (const el of nodes) {
      if (el.tagName !== "TABLE") continue;
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

    // Third-party embeds (video/ad/widget players) are almost always their own
    // iframe, invisible to the scan above no matter how thorough it looks —
    // this doesn't reach INTO the iframe (that's list_frames/frame_id's job),
    // it just tells the model one exists here at all, so it isn't left to
    // remember to check on every page on the chance one might be hiding.
    const iframes = [];
    for (const el of nodes) {
      if (el.tagName !== "IFRAME") continue;
      if (!isVisible(el)) continue;
      const rect = el.getBoundingClientRect();
      iframes.push({ src: (el.src || "").slice(0, MAX_HREF_CHARS), width: Math.round(rect.width), height: Math.round(rect.height) });
      if (iframes.length >= 20) break; // pathological-safety cap, see MAX_IMAGES above
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
      iframes,
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
    // Fast path: native querySelector, which covers the vast majority of
    // pages (no shadow DOM at all) at native speed. querySelector doesn't
    // pierce shadow roots, so a tag set inside one is otherwise unreachable
    // no matter how it's queried — allDescendants already walks those (see
    // its own comment), so a plain scan of that list is the correct fallback.
    return (
      document.querySelector(`[${AGENT_ATTR}="${CSS.escape(id)}"]`) ||
      allDescendants(document.body).find((el) => el.getAttribute(AGENT_ATTR) === id) ||
      null
    );
  }

  function normalizeLabel(s) {
    return String(s).replace(/\s+/g, " ").trim().toLowerCase();
  }

  // Same shadow-DOM-piercing need as findByAgentId above — a plain
  // querySelectorAll(`[${AGENT_ATTR}]`) misses anything tagged inside an
  // open shadow root.
  function taggedElements() {
    return allDescendants(document.body).filter((el) => el.hasAttribute(AGENT_ATTR));
  }

  // Lets click/type_text target an element by the visible text read_page
  // showed for it, instead of its scan id — useful when the id went stale
  // (a re-render bumped the counter) but the model still knows what the
  // element SAYS. Only matches against currently tagged (already-scanned)
  // elements — this is an alternate address for something read_page already
  // showed, not a general page search (that's find_in_page's job).
  function resolveTarget(id, targetText, targetTag) {
    if (id) {
      const el = findByAgentId(id);
      return el ? { el } : { error: `No element with id ${id}. Re-scan the page.` };
    }
    if (!targetText) return { error: "Pass element_id or element_text." };
    const wanted = normalizeLabel(targetText);
    const tagWanted = targetTag ? String(targetTag).toLowerCase() : null;
    const candidates = [];
    for (const el of taggedElements()) {
      if (tagWanted && el.tagName.toLowerCase() !== tagWanted) continue;
      const label = shortText(el);
      if (label && normalizeLabel(label) === wanted) candidates.push(el);
    }
    if (!candidates.length) {
      return {
        error: `No currently-tagged element with text "${targetText}"${tagWanted ? ` and tag ${tagWanted}` : ""} was found. Call read_page for a fresh scan and use its element ids instead.`,
      };
    }
    if (candidates.length > 1) {
      const ids = candidates.slice(0, 10).map((el) => el.getAttribute(AGENT_ATTR));
      return {
        error: `${candidates.length} elements match text "${targetText}" — ambiguous. Use one of these ids instead: ${ids.join(", ")}${tagWanted ? "" : ", or narrow it with element_tag"}.`,
      };
    }
    return { el: candidates[0] };
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
  // feed the whole page's text to the risky-text matcher. A text-targeted
  // click/type_text (see resolveTarget) needs the SAME resolution here too —
  // otherwise the risky-action gate would check document.activeElement
  // instead of the element that's actually about to be acted on, silently
  // skipping the confirmation it exists to enforce. A coordinate click (see
  // doClick) needs it a third way, via elementFromPoint.
  function resolveForLookup(id, targetText, targetTag, x, y) {
    if (id || targetText) return resolveTarget(id, targetText, targetTag).el || null;
    if (typeof x === "number" && typeof y === "number") return document.elementFromPoint(x, y);
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
    // Node count and text length miss attribute-only changes (an accordion
    // toggling aria-expanded, a checkbox's checked state) that add/remove no
    // text or elements - those clicks were reporting page_changed: false even
    // though they genuinely worked. A cheap count of the states that matter
    // closes that gap without a real diff.
    const stateCount = document.querySelectorAll(
      '[aria-expanded="true"], [open], input:checked, [aria-checked="true"], [aria-pressed="true"], [aria-selected="true"]'
    ).length;
    return `${location.href}|${document.title}|${text.length}|${document.querySelectorAll("body *").length}|${stateCount}`;
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

  // Hard ceiling regardless of what's requested - the whole point is to
  // bound a poll the model could otherwise ask to run indefinitely.
  const WAIT_FOR_CEILING_MS = 10000;
  const WAIT_FOR_POLL_MS = 200;

  async function doWaitFor(text, textGone, seconds) {
    if (!text && !textGone) {
      return { ok: false, error: "Pass text (wait for it to appear) or text_gone (wait for it to disappear)." };
    }
    const ceiling = Math.min(Math.max(Number(seconds) || 10, 1) * 1000, WAIT_FOR_CEILING_MS);
    const needle = String(text || textGone).toLowerCase();
    const before = pageSignature();
    const start = Date.now();
    let found;
    for (;;) {
      const has = (document.body?.innerText || "").toLowerCase().includes(needle);
      found = text ? has : !has;
      if (found || Date.now() - start >= ceiling) break;
      await settle(WAIT_FOR_POLL_MS);
    }
    return { ok: true, found, timed_out: !found, page_changed: pageSignature() !== before };
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

  // navigator.clipboard requires the document to actually have focus - a
  // background tab (e.g. a parallel_investigate branch) throws here rather
  // than silently no-oping, which is exactly what the tool result should
  // surface to the model instead of a generic failure.
  async function doClipboardWrite(text) {
    try {
      await navigator.clipboard.writeText(text ?? "");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Couldn't write to the clipboard (${err.message || err}) - this tab may not be focused.` };
    }
  }

  async function doClipboardRead() {
    try {
      const text = await navigator.clipboard.readText();
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: `Couldn't read the clipboard (${err.message || err}) - this tab may not be focused, or clipboard access was denied.` };
    }
  }

  // Shared alias table for modifier names - used by both click's `modifiers`
  // array and press_key's `Control+a`-style combo specs (see parseKeySpec
  // below), so an alias added to one (e.g. "option" for alt) can't silently
  // fail to apply to the other.
  function modifierFlagsFromNames(names) {
    const has = (name) => names.includes(name);
    return {
      ctrlKey: has("ctrl") || has("control"),
      shiftKey: has("shift"),
      altKey: has("alt") || has("option"),
      metaKey: has("meta") || has("cmd") || has("command"),
    };
  }

  function modifierFlags(modifiers) {
    return modifierFlagsFromNames((modifiers || []).map((m) => String(m).toLowerCase()));
  }

  // PointerEvent isn't guaranteed available in every context; the matching
  // MouseEvent always fires regardless and covers the vast majority of
  // handlers on its own, so a missing PointerEvent constructor is silently
  // ignored rather than treated as a failure. `kind` is "down"|"up"|"move".
  function dispatchPointerAndMouse(el, kind, opts) {
    try {
      el.dispatchEvent(new PointerEvent(`pointer${kind}`, opts));
    } catch { /* unsupported here - the mouse event below still covers most handlers */ }
    el.dispatchEvent(new MouseEvent(`mouse${kind}`, opts));
  }

  // One full press+release+activation for the left button - factored out so
  // a double-click can run it twice (matching a real double-click, which
  // really does fire two complete clicks - see the dblclick branch below).
  function fireLeftClick(el, opts, detail) {
    const clickOpts = { ...opts, detail };
    dispatchPointerAndMouse(el, "down", clickOpts);
    dispatchPointerAndMouse(el, "up", clickOpts);
    // Exactly ONE click activation per press - firing both el.click() and a
    // synthetic click delivered two click events per agent click, so
    // anything toggling netted back to where it started. Only el.click()
    // runs native activation behaviour (checkbox/radio, form submit, link);
    // the dispatched event carries the real clientX/clientY that el.click()
    // reports as 0.
    if (NATIVE_ACTIVATION_TAGS.has(el.tagName.toLowerCase())) el.click();
    else el.dispatchEvent(new MouseEvent("click", clickOpts));
  }

  async function doClick(msg) {
    const { id, targetText, targetTag, clickType, modifiers, x, y } = msg;
    const hasCoords = typeof x === "number" && typeof y === "number";

    let el;
    let resolvedId;
    if (hasCoords) {
      // Coordinate targeting is the only way to reach canvas content (maps,
      // drawing apps, games) - there's no element the scan could have tagged.
      el = document.elementFromPoint(x, y);
      if (!el) {
        return { ok: false, error: `No element at viewport coordinates (${x}, ${y}) - they must be within the visible viewport. Scroll the target into view first.` };
      }
      resolvedId = el.getAttribute(AGENT_ATTR) || null;
    } else {
      const resolved = resolveTarget(id, targetText, targetTag);
      if (resolved.error) return { ok: false, error: resolved.error };
      el = resolved.el;
      resolvedId = el.getAttribute(AGENT_ATTR) || id;
    }
    const label = resolvedId || `(${x}, ${y})`;

    // A synthetic click on a file input can't open (or drive/dismiss) the
    // native OS chooser it would normally trigger — that's a dead end the
    // model has no recovery from except waiting out the 12s timeout. Refuse
    // up front and point at the one thing that actually works instead.
    if (el.tagName === "INPUT" && el.type === "file") {
      return { ok: false, error: `Element ${label} ${describeEl(el)} is a file upload input — clicking it would open a native OS file chooser nothing can drive or dismiss. Use upload_file instead (it needs a file already attached to this conversation).` };
    }
    const blocked = notActionable(el, label);
    if (blocked) return { ok: false, error: blocked };
    // A coordinate click already resolved to a point that must be in the
    // current viewport (see the error above) - scrolling now would move the
    // page under it and invalidate the exact (x, y) the model computed.
    if (!hasCoords) el.scrollIntoView({ block: "center", behavior: "instant" });
    flashHighlight(el);
    // A coordinate click resolved el via elementFromPoint at that exact
    // point, so by definition nothing else is "covering" it - the check
    // only means something for an id/text-resolved target.
    const covering = hasCoords ? "" : occludedBy(el);

    const before = pageSignature();
    const mods = modifierFlags(modifiers);
    // Coordinate clicks use the EXACT point given (meaningful on a canvas -
    // different points mean different things), not el's bounding-box center.
    const point = hasCoords ? { clientX: x, clientY: y } : {};

    if (clickType === "right") {
      const opts = centerOpts(el, { button: 2, buttons: 2, ...mods, ...point });
      hoverEvents(el, { ...opts, buttons: 0 });
      dispatchPointerAndMouse(el, "down", opts);
      dispatchPointerAndMouse(el, "up", opts);
      // A real right-click never fires "click" - only contextmenu.
      el.dispatchEvent(new MouseEvent("contextmenu", opts));
    } else {
      const opts = centerOpts(el, { button: 0, buttons: 1, ...mods, ...point });
      hoverEvents(el, { ...opts, buttons: 0 });
      fireLeftClick(el, opts, 1);
      if (clickType === "double") {
        fireLeftClick(el, opts, 2);
        el.dispatchEvent(new MouseEvent("dblclick", { ...opts, detail: 2 }));
      }
    }

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
    // A coordinate click may have landed on an already-tagged element -
    // surface its id so the model can address it directly next time
    // instead of guessing coordinates again.
    if (hasCoords && resolvedId) result.element_id = resolvedId;
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

  async function doType(id, text, submit, perKey, targetText, targetTag) {
    const resolved = resolveTarget(id, targetText, targetTag);
    if (resolved.error) return { ok: false, error: resolved.error };
    const el = resolved.el;
    const resolvedId = el.getAttribute(AGENT_ATTR) || id;
    if (el.tagName === "SELECT") {
      return { ok: false, error: `Element ${resolvedId} is a <select> dropdown, not a text field - use select_option with the option's visible text instead.` };
    }
    // Everything else has no value setter to call, and reaching for one throws
    // an opaque "Illegal invocation" instead of saying what's wrong.
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && !el.isContentEditable) {
      return {
        ok: false,
        error: `Element ${resolvedId} ${describeEl(el)} isn't a text field, so there's nothing to type into. If it opens one (a search icon, a combobox), click it first and re-scan; the field itself will be a separate id.`,
      };
    }
    const blocked = notActionable(el, resolvedId);
    if (blocked) return { ok: false, error: blocked };
    if (el.readOnly) return { ok: false, error: `Element ${resolvedId} ${describeEl(el)} is read-only — typed text won't stick. It's probably filled by picking from a widget (date picker, dropdown) instead.` };
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
      ...modifierFlagsFromNames(mods),
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

  const FIND_IN_PAGE_MAX_MATCHES = 50;
  const FIND_CONTEXT_CHARS = 80;
  // A pathological regex (catastrophic backtracking) run synchronously
  // against a huge page can hang the tab for a very long time - JS has no
  // way to time out or abort a regex exec once it's started. Input LENGTH is
  // what backtracking cost scales with, so bounding it bounds the worst
  // case; the plain-substring path below (native String.indexOf, no
  // backtracking) doesn't need this.
  const FIND_IN_PAGE_REGEX_SEARCH_CHARS = 200000;

  function findTextEntry(body, at, len) {
    const start = Math.max(0, at - FIND_CONTEXT_CHARS);
    const end = Math.min(body.length, at + len + FIND_CONTEXT_CHARS);
    return { id: null, tag: "text", text: body.slice(start, end).replace(/\s+/g, " ").trim() };
  }

  // Checks tagged elements' labels first (a match there gives the model a
  // clickable id directly) then falls back to raw page text for content
  // that isn't a tagged interactive element - a plain paragraph, a price,
  // an error message. Reuses the existing scan's tagging; no new scan pass.
  function findInPage(text, regexSource) {
    if (!text && !regexSource) return { ok: false, error: "Pass either text (plain substring, case-insensitive) or regex to search for." };
    let regex;
    if (regexSource) {
      try {
        regex = new RegExp(regexSource, "gi");
      } catch (err) {
        return { ok: false, error: `Invalid regex: ${err.message}` };
      }
    }
    const matchesLabel = (s) => (regex ? new RegExp(regex.source, "i").test(s) : s.toLowerCase().includes(String(text).toLowerCase()));

    const matches = [];
    for (const el of taggedElements()) {
      const label = shortText(el);
      if (!label || !matchesLabel(label)) continue;
      const entry = { id: el.getAttribute(AGENT_ATTR), tag: el.tagName.toLowerCase(), text: label };
      if (el.tagName === "A" && el.href) entry.href = el.href.slice(0, MAX_HREF_CHARS);
      matches.push(entry);
      if (matches.length >= FIND_IN_PAGE_MAX_MATCHES) break;
    }

    if (matches.length < FIND_IN_PAGE_MAX_MATCHES) {
      const body = document.body?.innerText || "";
      if (regex) {
        const searchText = body.length > FIND_IN_PAGE_REGEX_SEARCH_CHARS ? body.slice(0, FIND_IN_PAGE_REGEX_SEARCH_CHARS) : body;
        let m;
        while (matches.length < FIND_IN_PAGE_MAX_MATCHES && (m = regex.exec(searchText))) {
          matches.push(findTextEntry(searchText, m.index, m[0].length));
          if (m[0].length === 0) regex.lastIndex += 1; // don't spin forever on a zero-width match
        }
      } else {
        const needle = String(text).toLowerCase();
        const haystack = body.toLowerCase();
        let from = 0;
        let at;
        while (matches.length < FIND_IN_PAGE_MAX_MATCHES && (at = haystack.indexOf(needle, from)) !== -1) {
          matches.push(findTextEntry(body, at, needle.length));
          from = at + needle.length;
        }
      }
    }
    return { ok: true, matches, truncated: matches.length >= FIND_IN_PAGE_MAX_MATCHES };
  }

  // Two independent sequences, since drag libraries split between them: a
  // pointer/mouse move-between-press-and-release (interact.js, SortableJS,
  // dnd-kit) and the native HTML5 DnD event family (draggable="true"
  // elements), sharing one DataTransfer the way a real drag would. Like
  // trusted-input-required clicks (see doClick), some native drag
  // implementations only respond to real OS-level drag input — this covers
  // the JS-library majority, not every possible page.
  async function doDrag(fromId, toId) {
    const fromEl = findByAgentId(fromId);
    if (!fromEl) return { ok: false, error: `No element with id ${fromId}. Re-scan the page.` };
    const toEl = findByAgentId(toId);
    if (!toEl) return { ok: false, error: `No element with id ${toId}. Re-scan the page.` };
    const blockedFrom = notActionable(fromEl, fromId);
    if (blockedFrom) return { ok: false, error: blockedFrom };
    const blockedTo = notRendered(toEl, toId);
    if (blockedTo) return { ok: false, error: blockedTo };

    fromEl.scrollIntoView({ block: "center", behavior: "instant" });
    toEl.scrollIntoView({ block: "center", behavior: "instant" });
    flashHighlight(fromEl);
    const before = pageSignature();

    const fromRect = fromEl.getBoundingClientRect();
    const toRect = toEl.getBoundingClientRect();
    const start = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };
    const end = { x: toRect.left + toRect.width / 2, y: toRect.top + toRect.height / 2 };
    const pointOpts = (p, extra) => ({ bubbles: true, cancelable: true, view: window, clientX: p.x, clientY: p.y, ...extra });

    const dt = new DataTransfer();
    hoverEvents(fromEl, pointOpts(start, { button: 0, buttons: 0 }));
    dispatchPointerAndMouse(fromEl, "down", pointOpts(start, { button: 0, buttons: 1 }));
    fromEl.dispatchEvent(new DragEvent("dragstart", { ...pointOpts(start), dataTransfer: dt }));

    const DRAG_STEPS = 6;
    for (let i = 1; i <= DRAG_STEPS; i += 1) {
      const p = { x: start.x + (end.x - start.x) * (i / DRAG_STEPS), y: start.y + (end.y - start.y) * (i / DRAG_STEPS) };
      dispatchPointerAndMouse(document, "move", pointOpts(p, { button: 0, buttons: 1 }));
      await settle(20);
    }

    toEl.dispatchEvent(new DragEvent("dragenter", { ...pointOpts(end), dataTransfer: dt }));
    toEl.dispatchEvent(new DragEvent("dragover", { ...pointOpts(end), dataTransfer: dt }));
    toEl.dispatchEvent(new DragEvent("drop", { ...pointOpts(end), dataTransfer: dt }));
    dispatchPointerAndMouse(toEl, "up", pointOpts(end, { button: 0, buttons: 0 }));
    fromEl.dispatchEvent(new DragEvent("dragend", { ...pointOpts(end), dataTransfer: dt }));

    const after = await waitForSettled(CLICK_SETTLE_CEILING_MS, before);
    return { ok: true, page_changed: before !== after };
  }

  const MIME_TYPES_BY_EXT = {
    txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
    json: "application/json", log: "text/plain", yaml: "application/x-yaml", yml: "application/x-yaml",
    xml: "application/xml", html: "text/html",
  };
  function mimeTypeForName(name) {
    const ext = String(name || "").toLowerCase().split(".").pop();
    return MIME_TYPES_BY_EXT[ext] || "text/plain";
  }

  // Only text-based attachments are reachable this way — lib/attachmentCache.js
  // only ever stores extracted TEXT (see its own comment), never the original
  // file bytes, so a PDF/image attachment has nothing to reconstruct here.
  // upload_file's tool description says so; agentLoop.js is what actually
  // fetches `text` from the cache before sending this message.
  async function doSetFiles(id, name, text) {
    const el = findByAgentId(id);
    if (!el) return { ok: false, error: `No element with id ${id}. Re-scan the page.` };
    if (el.tagName !== "INPUT" || el.type !== "file") {
      return { ok: false, error: `Element ${id} ${describeEl(el)} isn't a file upload input. upload_file only works on <input type="file">.` };
    }
    const blocked = notActionable(el, id);
    if (blocked) return { ok: false, error: blocked };

    const file = new File([text ?? ""], name || "attachment.txt", { type: mimeTypeForName(name) });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    flashHighlight(el);
    const before = pageSignature();
    el.files = dt.files;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const after = await waitForSettled(CLICK_SETTLE_CEILING_MS, before);
    return { ok: true, page_changed: before !== after };
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

  // Backgrounded tabs (e.g. a parallel_investigate branch) get
  // requestAnimationFrame fully paused and IntersectionObserver-gated
  // lazy-loading may simply never fire — a scroll that "did nothing" here
  // looks identical to genuinely having reached the end of the page. Only
  // worth flagging when scrolling actually looks stuck, not on every scroll
  // of a background tab that's working fine.
  function withBackgroundHint(result) {
    if (document.hidden && result.page_changed === false) {
      result.note = [
        result.note,
        "This tab is currently backgrounded (not the visible/focused tab) - scroll-triggered lazy-loading may be " +
          "paused rather than genuinely finished. If content seems to be missing, switch_tab to foreground this tab " +
          "briefly and try again.",
      ]
        .filter(Boolean)
        .join(" ");
    }
    return result;
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
      return withBackgroundHint({ ok: true, ...(await scrollOnce(container, delta)) });
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
    return withBackgroundHint({
      ok: true,
      page_changed: scrolled !== 0 || last.page_changed,
      scrolled_by: scrolled,
      at_bottom: last.at_bottom,
      scroll_steps: steps,
      note:
        steps >= MAX_SCROLL_STEPS
          ? `Stopped after ${steps} scrolls without reaching the end - this page may load endlessly. Read what's here; scroll again with to:"bottom" only if you specifically need more.`
          : undefined,
    });
  }

  // Every action settles before it answers, so they all reply asynchronously
  // and all fail the same way — one table beats seven copies of .then/.catch.
  const ACTIONS = {
    CLICK: (m) => doClick(m),
    TYPE: (m) => doType(m.id, m.text, m.submit, m.perKey, m.targetText, m.targetTag),
    SELECT_OPTION: (m) => doSelect(m.id, m.values),
    HOVER: (m) => doHover(m.id),
    PRESS_KEY: (m) => doPressKey(m.key, m.id),
    FILL_FORM: (m) => doFillForm(m.fields),
    SCROLL: (m) => doScroll(m.direction, m.amount, m.elementId, m.to),
    WAIT_FOR: (m) => doWaitFor(m.text, m.textGone, m.seconds),
    DRAG: (m) => doDrag(m.fromId, m.toId),
    SET_FILES: (m) => doSetFiles(m.id, m.name, m.text),
    CLIPBOARD_WRITE: (m) => doClipboardWrite(m.text),
    CLIPBOARD_READ: () => doClipboardRead(),
    // Used only by retryClickTrusted (agentLoop.js) - see its own comment
    // for why a flat sleep isn't good enough here.
    WAIT_FOR_SETTLE: async (m) => ({ ok: true, signature: await waitForSettled(CLICK_SETTLE_CEILING_MS, m.baseline) }),
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
        case "FIND_IN_PAGE":
          sendResponse(findInPage(msg.text, msg.regex));
          break;
        case "GET_ELEMENT_TEXT": {
          const el = resolveForLookup(msg.id, msg.targetText, msg.targetTag, msg.x, msg.y);
          if (!el) {
            sendResponse({ ok: false, error: `No element with id ${msg.id}. Re-scan the page.` });
          } else {
            sendResponse({ ok: true, data: { text: shortText(el) } });
          }
          break;
        }
        case "GET_SUBMIT_CONTEXT": {
          const el = resolveForLookup(msg.id, msg.targetText, msg.targetTag, msg.x, msg.y);
          if (!el) {
            sendResponse({ ok: false, error: `No element with id ${msg.id}. Re-scan the page.` });
          } else {
            sendResponse({ ok: true, data: { text: getSubmitButtonText(el) } });
          }
          break;
        }
        // Both only ever used by the chrome.debugger trusted-input retry
        // (see lib/trustedInput.js / agentLoop.js) — the coordinates and
        // before/after signature it needs to dispatch and verify a real
        // trusted click at the same target the normal click already tried.
        case "GET_ELEMENT_RECT": {
          const resolved = resolveTarget(msg.id, msg.targetText, msg.targetTag);
          if (resolved.error) {
            sendResponse({ ok: false, error: resolved.error });
          } else {
            const rect = resolved.el.getBoundingClientRect();
            sendResponse({ ok: true, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 });
          }
          break;
        }
        case "PAGE_SIGNATURE":
          sendResponse({ ok: true, signature: pageSignature() });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return true;
  });
})();
