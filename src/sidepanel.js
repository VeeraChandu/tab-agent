const logEl = document.getElementById("log");
// #log is just a content wrapper with no overflow of its own — the actual
// scrollable viewport (overflow-y:auto in CSS) is its parent, <main>. All
// scroll position reads/writes must target scrollEl, not logEl, or they're
// silent no-ops (and clearing #log's innerHTML during a full re-render
// resets main's scrollTop to 0, which looked like "auto-scrolls to top").
const scrollEl = document.querySelector("main");
const emptyState = document.getElementById("emptyState");
const taskInput = document.getElementById("taskInput");
const runBtn = document.getElementById("runBtn");
const stopBtn = document.getElementById("stopBtn");
const queueBadge = document.getElementById("queueBadge");
const settingsBtn = document.getElementById("settingsBtn");
const newChatBtn = document.getElementById("newChatBtn");
const historyBtn = document.getElementById("historyBtn");
const closeHistoryBtn = document.getElementById("closeHistoryBtn");
const historyPanel = document.getElementById("historyPanel");
const historyList = document.getElementById("historyList");
const historySearch = document.getElementById("historySearch");
const warningBanner = document.getElementById("warningBanner");
const privacyNotice = document.getElementById("privacyNotice");
const privacyNoticeDismiss = document.getElementById("privacyNoticeDismiss");
const statusBar = document.getElementById("statusBar");
const statusText = document.getElementById("statusText");
const topProgress = document.getElementById("topProgress");
const modelSelect = document.getElementById("modelSelect");
const attachBtn = document.getElementById("attachBtn");
const micBtn = document.getElementById("micBtn");
const fileInput = document.getElementById("fileInput");
const attachmentsRow = document.getElementById("attachmentsRow");
const agentChip = document.getElementById("agentChip");
const agentChipName = document.getElementById("agentChipName");
const agentChipClear = document.getElementById("agentChipClear");
const agentPopover = document.getElementById("agentPopover");
const editBanner = document.getElementById("editBanner");
const editBannerCancel = document.getElementById("editBannerCancel");
const themeBtn = document.getElementById("themeBtn");
const themeIconDark = document.getElementById("themeIconDark");
const themeIconLight = document.getElementById("themeIconLight");
const themeIconAuto = document.getElementById("themeIconAuto");

const { renderMarkdown, escapeHtml } = window.TabAgentMarkdown;

// --- theme (light / dark / system) -----------------------------------
// "System" (stored as null) tracks prefers-color-scheme via the plain
// @media block in sidepanel.css; "light"/"dark" pin data-theme regardless of
// the OS setting. One button cycles through all three — click again to
// advance — with the icon itself showing which mode is active, rather than
// a dropdown that takes a click to open and a second to actually pick one.
const THEME_CYCLE = [null, "light", "dark"]; // null = system
let themePreference = null; // "light" | "dark" | null (system)

function applyTheme() {
  if (themePreference) {
    document.documentElement.setAttribute("data-theme", themePreference);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }

  // Button icon reflects the MODE (system gets its own icon), not just
  // whether the page currently looks dark — otherwise "system" would be
  // visually indistinguishable from having explicitly picked light/dark.
  themeIconDark.classList.toggle("hidden", themePreference !== "dark");
  themeIconLight.classList.toggle("hidden", themePreference !== "light");
  themeIconAuto.classList.toggle("hidden", themePreference !== null);

  const current = themePreference || "system";
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(themePreference) + 1) % THEME_CYCLE.length] || "system";
  themeBtn.title = `Theme: ${current} (click for ${next})`;
}

async function initTheme() {
  const { themePreference: stored } = await chrome.storage.local.get(["themePreference"]);
  themePreference = stored === "light" || stored === "dark" ? stored : null;
  applyTheme();
}
initTheme();

themeBtn.addEventListener("click", () => {
  themePreference = THEME_CYCLE[(THEME_CYCLE.indexOf(themePreference) + 1) % THEME_CYCLE.length];
  chrome.storage.local.set({ themePreference });
  applyTheme();
});

// pdfjsLib is loaded globally via lib/pdf.min.js (see sidepanel.html). It
// needs a worker script to do the actual parsing off the main thread; point
// it at the vendored copy sitting next to it rather than pdf.js's default of
// fetching one from a CDN (which the extension's CSP wouldn't allow anyway).
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
}

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
// No page/char cap here anymore — nothing extracted from an attachment is
// ever trimmed. lib/attachmentCache.js chunks the full text on the
// background side instead, so a large file just means more chunks, not
// missing content. MAX_TEXT_ATTACHMENT_BYTES below is a different kind of
// limit: a sanity ceiling on the RAW FILE at attach time, so a genuinely
// enormous file can't hang the side panel just reading it into memory —
// rejecting it outright is not the same thing as trimming what a smaller,
// accepted file's content would show the model.
const MAX_TEXT_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Extension -> a short format tag used for the attachment's chip icon and
// passed through to the model's document wrapper tag. Anything not listed
// here still gets treated as text if the browser reports a text-ish MIME
// type (see textAttachmentFormat below) — this table just gives the common
// ones a more specific tag than the generic "text" fallback.
const TEXT_ATTACHMENT_FORMATS = {
  txt: "text",
  log: "text",
  md: "markdown",
  markdown: "markdown",
  csv: "csv",
  tsv: "tsv",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  html: "html",
  htm: "html",
  js: "code",
  ts: "code",
  py: "code",
  css: "code",
  sh: "code",
  java: "code",
  c: "code",
  cpp: "code",
  go: "code",
  rb: "code",
  php: "code",
  rs: "code",
};

// Extension-first, same reasoning as the existing PDF check just below
// (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) — browsers
// are unreliable about reporting MIME types for plain text files (empty
// string is common for unrecognized extensions), so the filename is the
// more trustworthy signal. Falls back to sniffing file.type for anything
// with an unrecognized extension that's still clearly text-like.
function textAttachmentFormat(file) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TEXT_ATTACHMENT_FORMATS, ext)) return TEXT_ATTACHMENT_FORMATS[ext];
  if (file.type === "text/plain" || file.type === "text/csv" || file.type === "application/json" || file.type.startsWith("text/")) return "text";
  return null;
}

// Shared by every place a non-image attachment chip gets rendered (the
// composer's own attachments row, a sent message's preview chips, and the
// history replay of both) so the icon-per-format mapping only lives once.
function docIcon(format) {
  if (format === "pdf") return "📄";
  if (format === "csv" || format === "tsv") return "📊";
  if (format === "json") return "🧾";
  if (format === "code") return "💻";
  return "📝";
}

let running = false;
let stepThroughEnabled = false;
let autoScroll = true;
let attachments = []; // images: { id, name, kind:"image", mediaType, data (base64, no prefix), previewUrl }
                       // pdfs:   { id, name, kind:"pdf", text, pageCount, truncated }
let editingNodeId = null;
let currentSessionId = null;
// The node id of the run currently being displayed live. null means "not
// locked onto a run yet — the next AGENT_EVENT/AGENT_PAUSED/AGENT_DONE we see
// for the current session is it." Reset to null right before every message
// that starts or resumes a run (see resetActiveRunTracking below), so a stray
// broadcast from an abandoned run (e.g. a branch that was edited away from
// mid-run, or a step-limit pause that later times out on its own) can't get
// appended into whatever the sidepanel happens to be showing right now.
let activeRunNodeId = null;
let agents = [];
let activeAgent = null;
let popoverMatches = [];
let popoverIndex = 0;

// --- built-in slash commands ----------------------------------------------
// Distinct from Agents (which are user-defined presets) — these are fixed
// utility commands, always available, matched by the same "/" picker.

const BUILTIN_COMMANDS = [
  { slug: "clear", description: "Reset this chat (wipes its messages, keeps the session)", kind: "command" },
  { slug: "retry", description: "Regenerate the last response", kind: "command" },
  { slug: "compact", description: "Summarize this chat to save tokens", kind: "command" },
  { slug: "stop", description: "Stop the current run", kind: "command" },
  { slug: "model", description: "Switch model - /model <name>", kind: "command" },
  { slug: "help", description: "List available commands and agents", kind: "command" },
];

// --- agents / slash command picker ---------------------------------------

async function loadAgents() {
  const { agents: stored = [] } = await chrome.storage.local.get(["agents"]);
  agents = stored;
}
loadAgents();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.agents) loadAgents();
});

function setActiveAgent(agent) {
  activeAgent = agent || null;
  if (activeAgent) {
    agentChipName.textContent = activeAgent.name || activeAgent.slug;
    agentChip.classList.remove("hidden");
  } else {
    agentChip.classList.add("hidden");
  }
}

agentChipClear.addEventListener("click", () => setActiveAgent(null));

function hidePopover() {
  agentPopover.classList.add("hidden");
  agentPopover.innerHTML = "";
  popoverMatches = [];
}

// headerLabel + a fixed trigger char (not per-item) because / and @ now open
// two entirely separate, single-purpose pickers — see checkForSlashCommand
// below. The header is mostly a reminder during the transition away from the
// old merged "/ shows both" behavior; the trigger char itself already
// disambiguates which list you're looking at.
function renderPopover(matches, headerLabel, triggerChar) {
  popoverMatches = matches;
  popoverIndex = 0;
  agentPopover.innerHTML = "";

  if (!matches.length) {
    hidePopover();
    return;
  }

  if (headerLabel) {
    const header = document.createElement("div");
    header.className = "agent-popover-header";
    header.textContent = headerLabel;
    agentPopover.appendChild(header);
  }

  matches.forEach((item, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "agent-popover-row" + (i === 0 ? " highlighted" : "") + (item.kind === "command" ? " builtin" : "");
    row.innerHTML = `<span class="agent-popover-slug">${triggerChar}${escapeHtml(item.slug)}</span><span class="agent-popover-desc">${escapeHtml(item.description || "")}</span>`;
    row.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep textarea focus
      pickPopoverItem(item);
    });
    agentPopover.appendChild(row);
  });

  agentPopover.classList.remove("hidden");
}

function updatePopoverHighlight() {
  const rows = agentPopover.querySelectorAll(".agent-popover-row");
  rows.forEach((r, i) => r.classList.toggle("highlighted", i === popoverIndex));
  // The popover scrolls (max-height + overflow-y in sidepanel.css) once the
  // list is taller than it, so arrow-key navigation needs to actively keep
  // the highlighted row in view — "nearest" only scrolls the minimum amount
  // needed (no jump when already visible) and still scrolls fully when the
  // index wraps from last back to first, or vice versa.
  rows[popoverIndex]?.scrollIntoView({ block: "nearest" });
}

function pickPopoverItem(item) {
  hidePopover();
  if (item.kind === "command") {
    if (item.slug === "model") {
      // Needs an argument — fill it in and let the user type the model name,
      // rather than executing immediately like the zero-argument commands.
      taskInput.value = "/model ";
      autoResize();
      taskInput.focus();
      return;
    }
    taskInput.value = "";
    autoResize();
    runBuiltinCommand(item.slug, "");
    return;
  }
  setActiveAgent(item.ref);
  taskInput.value = "";
  autoResize();
  taskInput.focus();
}

// "/" and "@" open two separate, single-purpose pickers rather than one
// merged list — built-in commands (one-shot actions: reset the chat, switch
// model, stop a run...) and agents (persistent presets that stay sticky for
// the rest of the chat once picked) are different enough kinds of things
// that showing them identically in one list made it easy to mix them up, and
// let an agent's slug silently collide with a reserved command name. Splitting
// the trigger char removes that collision entirely: an agent can be named
// anything, including "clear" or "help", since it's only ever reachable as
// @clear / @help, never confusable with the built-in /clear or /help.
function checkForSlashCommand() {
  const value = taskInput.value;
  const commandMatch = value.match(/^\/([a-z0-9_]*)$/i);
  if (commandMatch) {
    const query = commandMatch[1].toLowerCase();
    const commandItems = BUILTIN_COMMANDS.filter((c) => c.slug.includes(query));
    renderPopover(commandItems, "Commands", "/");
    return;
  }
  const agentMatch = value.match(/^@([a-z0-9_]*)$/i);
  if (agentMatch) {
    const query = agentMatch[1].toLowerCase();
    const agentItems = agents
      .filter((a) => a.slug.toLowerCase().includes(query) || (a.name || "").toLowerCase().includes(query))
      .map((a) => ({ slug: a.slug, description: a.description || a.name || "", kind: "agent", ref: a }));
    renderPopover(agentItems, "Agents", "@");
    return;
  }
  hidePopover();
}

// Lets users type the whole command directly, e.g. "@research_agent find X",
// without ever touching the popover. "@" — not "/" — matching the picker
// split above; there's no /agent_slug fallback, a clean cutover rather than
// supporting both forms indefinitely.
function extractDirectAgentCommand(text) {
  const match = text.match(/^@([a-z0-9_]+)\s+([\s\S]*)$/i);
  if (!match) return null;
  const agent = agents.find((a) => a.slug.toLowerCase() === match[1].toLowerCase());
  if (!agent) return null;
  return { agent, remainder: match[2] };
}

// --- providers / model selector -----------------------------------------

async function loadProviders() {
  const { providers = [], activeProviderId, activeModelId } = await chrome.storage.local.get(["providers", "activeProviderId", "activeModelId"]);
  modelSelect.innerHTML = "";

  const options = [];
  providers.forEach((p) => {
    // p.enabled === false is an explicit provider-level opt-out (the
    // Settings switch that replaced the old "default" radio) — skip its
    // models entirely rather than just deprioritizing them. Providers saved
    // before this switch existed have no `enabled` field, so absence still
    // means enabled (back-compat default).
    if (p.enabled === false) return;
    // See background.js's getConfig() for why this checks presence, not
    // length — an empty array means "explicitly disabled", not "unset".
    const enabled = p.enabledModelIds ? p.enabledModelIds : (p.models || []).map((m) => m.id);
    enabled.forEach((modelId) => {
      const m = (p.models || []).find((x) => x.id === modelId);
      options.push({ providerId: p.id, modelId, label: `${p.label || p.type} · ${m?.label || modelId}` });
    });
  });

  if (!options.length) {
    modelSelect.disabled = true;
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = providers.length ? "No models enabled" : "No provider set up";
    modelSelect.appendChild(opt);
  } else {
    modelSelect.disabled = false;
    options.forEach((o) => {
      const opt = document.createElement("option");
      opt.value = `${o.providerId}::${o.modelId}`;
      opt.textContent = o.label;
      modelSelect.appendChild(opt);
    });
    const preferred = `${activeProviderId}::${activeModelId}`;
    const match = options.some((o) => `${o.providerId}::${o.modelId}` === preferred);
    modelSelect.value = match ? preferred : `${options[0].providerId}::${options[0].modelId}`;
  }

  checkConfig(providers, options);
}

modelSelect.addEventListener("change", () => {
  if (!modelSelect.value) return;
  const [providerId, modelId] = modelSelect.value.split("::");
  chrome.storage.local.set({ activeProviderId: providerId, activeModelId: modelId });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.providers || changes.activeProviderId || changes.activeModelId)) loadProviders();
});

function checkConfig(providers, options) {
  if (!providers.length) {
    warningBanner.textContent = "No provider set up yet - click ⚙ to add an Anthropic or OpenAI-compatible API key.";
    warningBanner.classList.remove("hidden");
  } else if (!options.length) {
    warningBanner.textContent = "No models enabled - click ⚙ to confirm a provider and check at least one model.";
    warningBanner.classList.remove("hidden");
  } else {
    warningBanner.classList.add("hidden");
  }
}

// --- data-use disclosure ------------------------------------------------
// Bump this when what Tab Agent accesses or where it sends data actually
// changes — a stored ack from an older version won't suppress the notice
// for a newer one, so a material change gets surfaced again rather than
// silently inheriting a prior "Got it" click. See PRIVACY_POLICY.md.
const PRIVACY_NOTICE_VERSION = 1;

async function checkPrivacyNotice() {
  const { privacyNoticeAckVersion } = await chrome.storage.local.get(["privacyNoticeAckVersion"]);
  if (privacyNoticeAckVersion === PRIVACY_NOTICE_VERSION) return;
  privacyNotice.classList.remove("hidden");
}

privacyNoticeDismiss.addEventListener("click", () => {
  privacyNotice.classList.add("hidden");
  chrome.storage.local.set({ privacyNoticeAckVersion: PRIVACY_NOTICE_VERSION });
});

checkPrivacyNotice();

loadProviders();

// A task started before this panel was closed (or before it was ever
// opened, if the run was kicked off from a different window) keeps running
// in the background regardless — background.js's activeRuns doesn't care
// whether anyone's watching. Without this, reopening the panel always
// defaults to a blank new chat with zero indication that anything is
// happening, other than the toolbar's pulsing dot — the only signal
// available is the tool-call log inside a chat this panel isn't showing.
// Re-attaching means loading that chat AND telling the UI it's running
// (setRunning/showStatus/showTypingBubble), the same way clicking
// "Continue" on a step-limit prompt already resumes a known node — a live
// AGENT_EVENT broadcast could be seconds away, or over a minute (still
// within the watchdog's grace period — see setRunning), so there's nothing
// to visibly wait for in between.
// A paused run (ask_user, a step-limit check-in, or a site-access gate) is
// the other half of drive()'s two exit paths — unlike an active run, it's
// not tracked in background.js's in-memory activeRuns at all (drive()'s
// finally block clears that entry the instant it pauses, same moment
// getRunningBadge's dot would turn off), so there's no live state to ask
// background.js for. It's fully described by node.pendingQuestion, already
// sitting in storage, so this reads sessions directly rather than adding a
// second message round-trip. Ties go to whichever chat was paused most
// recently — with several waiting at once, that's the one most likely to
// still be relevant.
function findMostRecentPausedSession(sessions) {
  let best = null;
  for (const raw of sessions) {
    const session = migrateSessionIfNeeded(raw);
    const path = computeActivePath(session);
    const lastNode = path[path.length - 1];
    if (!lastNode?.pendingQuestion) continue;
    if (!best || (session.updatedAt || 0) > (best.updatedAt || 0)) best = session;
  }
  return best;
}

(async () => {
  const { sessionId, nodeId } = await chrome.runtime.sendMessage({ type: "GET_RUNNING_SESSION" }).catch(() => ({}));
  if (sessionId) {
    const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
    const raw = sessions.find((s) => s.id === sessionId);
    if (!raw) return;
    loadSessionIntoView(raw);
    activeRunNodeId = nodeId || null;
    setRunning(true);
    showStatus("Thinking", true);
    showTypingBubble();
    return;
  }

  const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
  const paused = findMostRecentPausedSession(sessions);
  // loadSessionIntoView's own renderSessionPath replays the node's
  // ask_user/confirm_continue/confirm_site_category uiEvent exactly as it
  // would on a manual History visit, forms and all — no separate "paused"
  // UI state to set here, since setRunning's default (false) is already
  // the resting state a paused chat wants (composer usable, no progress bar).
  if (paused) loadSessionIntoView(paused);
})();
settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// --- new chat / history -------------------------------------------------

function startNewChat() {
  currentSessionId = null;
  activeRunNodeId = null;
  editingNodeId = null;
  editBanner.classList.add("hidden");
  logEl.innerHTML = "";
  attachments = [];
  renderAttachments();
  setActiveAgent(null);
  autoScroll = true;
  showEmptyState();
  closeHistory();
  document.getElementById("composerUsage")?.classList.add("hidden");
}

newChatBtn.addEventListener("click", startNewChat);

// /clear — distinct from "+ New chat": this wipes the CURRENT session's
// messages in place (same session id, same History entry) rather than
// abandoning it in favor of a brand-new one. Mirrors startNewChat()'s UI
// reset, but writes an emptied-out version of the existing session back to
// storage instead of just setting currentSessionId to null.
async function clearCurrentSession() {
  if (!currentSessionId) {
    // Panel is already blank/unsent — nothing to wipe in place.
    startNewChat();
    return;
  }
  if (running) {
    addEntry("info", "Info", "Stop the current task before clearing this chat.");
    return;
  }
  const { sessions: current = [] } = await chrome.storage.local.get(["sessions"]);
  const idx = current.findIndex((s) => s.id === currentSessionId);
  if (idx === -1) {
    // Already gone from storage some other way — fall back to a normal new chat.
    startNewChat();
    return;
  }
  const cleared = {
    ...current[idx],
    title: "New chat",
    agentId: null,
    updatedAt: Date.now(),
    nodes: {},
    rootChildIds: [],
    rootSelectedChildId: null,
  };
  delete cleared.compactedUsage; // lifetime token ledger — nothing left to account for once wiped

  // Re-read storage right before writing instead of reusing `current` from
  // above — this page and background.js (which can be mid checkpoint-save
  // for a DIFFERENT session that's still running there, via
  // persistAgentEvent -> saveSession, since activeRuns allows more than one
  // concurrent run) are separate processes with no shared lock, so time can
  // pass between that read and this write. Replacing only the one session
  // being cleared in a freshly-read copy keeps a concurrent background
  // write to any other session from being silently reverted.
  const { sessions: fresh = [] } = await chrome.storage.local.get(["sessions"]);
  const freshIdx = fresh.findIndex((s) => s.id === currentSessionId);
  if (freshIdx === -1) {
    // Deleted from storage between the two reads — nothing left to clear.
    startNewChat();
    return;
  }
  fresh[freshIdx] = cleared;
  await chrome.storage.local.set({ sessions: fresh });

  activeRunNodeId = null;
  editingNodeId = null;
  editBanner.classList.add("hidden");
  logEl.innerHTML = "";
  attachments = [];
  renderAttachments();
  setActiveAgent(null);
  autoScroll = true;
  showEmptyState();
  closeHistory();
  document.getElementById("composerUsage")?.classList.add("hidden");
}

// Settings' "Run manually" button (for a scheduled check that needs input)
// opens this panel with the task's prompt+notes pre-filled — reuses the
// normal composer/send flow so ask_user works exactly like any other run,
// since a headless scheduled run has nobody to answer it.
//
// Two things this guards against: (1) the live PREFILL_SCHEDULED_TASK
// message and the storage-fallback check below can both fire for the exact
// same prefill (the fallback exists in case the panel wasn't listening yet)
// — `ts` uniquely identifies one prefill, so applying it twice is a no-op;
// (2) unlike startNewChat() elsewhere, this used to blow away the panel
// unconditionally even if a different run was already in progress here —
// mirror clearCurrentSession()'s `running` guard instead of silently
// orphaning that run.
let lastAppliedPrefillTs = null;
function applyScheduledTaskPrefill({ prompt, notes, ts }) {
  if (ts && ts === lastAppliedPrefillTs) return;
  if (running) {
    addEntry("info", "Info", 'A task is already running in this chat - stop it first, then use "Run manually" again from Settings.');
    return;
  }
  lastAppliedPrefillTs = ts || Date.now();
  startNewChat();
  const combined = notes && notes.trim() ? `${prompt || ""}\n\n${notes.trim()}` : prompt || "";
  taskInput.value = combined;
  autoResize();
  taskInput.focus();
}

// The prefill message sent the instant the tab/panel opens can arrive before
// this script has finished loading and registered its listener — fall back
// to checking storage for anything left within the last 30s (background.js
// stashes it there right before sending the message, as a just-in-case).
(async () => {
  const { pendingScheduledTaskPrefill } = await chrome.storage.local.get(["pendingScheduledTaskPrefill"]);
  if (pendingScheduledTaskPrefill) {
    if (Date.now() - pendingScheduledTaskPrefill.ts < 30000) applyScheduledTaskPrefill(pendingScheduledTaskPrefill);
    chrome.storage.local.remove("pendingScheduledTaskPrefill").catch(() => {});
  }
})();

historyBtn.addEventListener("click", async () => {
  historySearch.value = "";
  await renderHistoryList();
  historyPanel.classList.remove("hidden");
  historyBtn.setAttribute("aria-expanded", "true");
});
closeHistoryBtn.addEventListener("click", closeHistory);

function closeHistory() {
  historyPanel.classList.add("hidden");
  historyBtn.setAttribute("aria-expanded", "false");
}

// Click-outside-to-close — historyPanel is a positioned popup (absolute,
// no backdrop element covering the rest of the UI), so nothing was closing
// it on an outside click before this; only Escape and the panel's own X
// button did. mousedown (not click) so this fires before any click handler
// on whatever was clicked underneath, matching normal popup/dropdown
// behavior. Ignores clicks on historyBtn itself since that already has its
// own toggle-open handler above — without this guard, a click on the button
// while the panel is open would close it here and then immediately reopen
// it via the click handler right after.
document.addEventListener("mousedown", (e) => {
  if (historyPanel.classList.contains("hidden")) return;
  if (historyPanel.contains(e.target) || historyBtn.contains(e.target)) return;
  closeHistory();
});

// Global Escape: stop a running task if one is in progress, otherwise close
// whatever overlay is open (history panel, agent popover). Per-input Escape
// handling (agent popover while typing) is handled separately in the
// taskInput keydown listener and takes priority while it's focused.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (document.activeElement === taskInput && !agentPopover.classList.contains("hidden")) return;
  if (running) {
    showStatus("Stopping…");
    chrome.runtime.sendMessage({ type: "STOP_TASK", sessionId: currentSessionId });
    return;
  }
  if (!historyPanel.classList.contains("hidden")) {
    closeHistory();
  }
});

// Panel-local shortcuts — only fire while this side panel has focus (unlike
// the global chrome.commands shortcuts in background.js, which work even
// when the panel isn't the focused surface). Ctrl on Windows/Linux, Cmd on
// Mac — checking both e.ctrlKey and e.metaKey covers both without needing
// to detect platform.
document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;

  if (e.key.toLowerCase() === "k") {
    e.preventDefault();
    startNewChat();
    return;
  }
  if (e.key === "/") {
    e.preventDefault();
    showHelp();
    return;
  }
  if (e.key.toLowerCase() === "h" && e.shiftKey) {
    e.preventDefault();
    if (historyPanel.classList.contains("hidden")) {
      historySearch.value = "";
      renderHistoryList();
      historyPanel.classList.remove("hidden");
      historyBtn.setAttribute("aria-expanded", "true");
    } else {
      closeHistory();
    }
  }
});

// --- Footer resize (drag handle) ----------------------------------------
(function initFooterResize() {
  const handle = document.getElementById("footerResizeHandle");
  const footer = document.querySelector("footer");
  if (!handle || !footer) return;
  let startY = 0;
  let startH = 0;
  const onMove = (e) => {
    const delta = startY - e.clientY;
    const newH = Math.max(80, Math.min(window.innerHeight * 0.7, startH + delta));
    footer.style.height = `${newH}px`;
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  };
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = footer.offsetHeight;
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
})();

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

const HISTORY_MAX_SESSIONS = 30;

// Sums token usage across every node in a session — nodes accumulate their
// own usage from the agent loop, so this is just a fold rather than a
// separately-maintained (and easily desynced) running counter. Also folds
// in a $ cost estimate per node (each node records which model generated
// its tokens, so a session that switched models mid-conversation via
// /model still prices each turn at the rate that actually applied).
// Two different numbers live behind this one label: "total" (everything this
// chat has ever cost, across every turn and every /compact — monotonic,
// never goes down) and "active" (the size of the context that would be sent
// on the NEXT message, which is the number /compact actually shrinks). Until
// a chat has been compacted at least once, these are the same figure by
// construction, so showing one merged number is both simpler and accurate.
// The moment session.compactedUsage exists (set by background.js the first
// time /compact runs), the two are free to diverge and get their own labels.
function sessionUsageLabel(session) {
  let input = 0;
  let output = 0;
  let knownCost = 0;
  let hasKnownCost = false;
  let hasUnknownCost = false;
  const addUsage = (usage) => {
    if (!usage) return;
    input += usage.inputTokens || 0;
    output += usage.outputTokens || 0;
    const priced = window.TabAgentPricing?.estimateCost(usage.model, usage.inputTokens, usage.outputTokens);
    if (priced) {
      knownCost += priced.cost;
      hasKnownCost = true;
    } else if (usage.inputTokens || usage.outputTokens) {
      hasUnknownCost = true;
    }
  };
  for (const node of Object.values(session.nodes || {})) addUsage(node.usage);
  // Tokens a /compact cleared off a node still cost real money — fold them
  // (and each compaction call's own cost) back in so the lifetime total
  // never drops just because the context was summarized.
  addUsage(session.compactedUsage);

  const total = input + output;
  if (!total) return "";
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  let costPart = "";
  if (hasKnownCost) {
    const costLabel = window.TabAgentPricing.formatCost(knownCost);
    costPart = ` · ~${costLabel}${hasUnknownCost ? "+" : ""}`;
  }

  if (!session.compactedUsage) return ` · ~${fmt(total)} tokens${costPart}`;

  const activeNode = computeActivePath(session).at(-1);
  const active = activeNode?.usage ? (activeNode.usage.inputTokens || 0) + (activeNode.usage.outputTokens || 0) : 0;
  return ` · ~${fmt(total)} total${costPart} · ~${fmt(active)} active`;
}

function sessionToTranscript(session) {
  const migrated = migrateSessionIfNeeded(JSON.parse(JSON.stringify(session)));
  const path = computeActivePath(migrated);
  const lines = [`# ${migrated.title || "Tab Agent chat"}`, ""];
  for (const node of path) {
    lines.push(`**You:** ${node.userText || "(attachment only)"}`, "");
    const docNames = (node.userAttachmentPreviews || []).filter((p) => p && typeof p === "object" && (p.kind === "pdf" || p.kind === "doc"));
    if (docNames.length) lines.push(`_Attached: ${docNames.map((d) => d.name).join(", ")}_`, "");
    for (const event of node.uiEvents || []) {
      if (event.type === "finish") lines.push(event.answer || "", "");
      else if (event.type === "done" && !event.alreadyShown) lines.push(event.finalAnswer || "", "");
    }
  }
  return lines.join("\n");
}

function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function duplicateSession(session) {
  const { sessions: current = [] } = await chrome.storage.local.get(["sessions"]);
  const clone = JSON.parse(JSON.stringify(session));
  clone.id = "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  clone.title = `${session.title || "New chat"} (copy)`;
  clone.createdAt = Date.now();
  clone.updatedAt = Date.now();
  current.unshift(clone);
  current.sort((a, b) => b.updatedAt - a.updatedAt);
  await chrome.storage.local.set({ sessions: current.slice(0, HISTORY_MAX_SESSIONS) });
  renderHistoryList(historySearch.value);
}

async function renderHistoryList(filterText = "") {
  const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  const q = filterText.trim().toLowerCase();
  const filtered = q ? sessions.filter((s) => (s.title || "").toLowerCase().includes(q)) : sessions;
  historyList.innerHTML = "";

  if (!filtered.length) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = sessions.length ? "No chats match your search." : "No conversations yet.";
    historyList.appendChild(empty);
    return;
  }

  for (const session of filtered) {
    const row = document.createElement("div");
    row.className = "history-row" + (session.id === currentSessionId ? " active" : "");

    const main = document.createElement("button");
    main.type = "button";
    main.className = "history-row-main";
    main.innerHTML = `<span class="history-row-title">${escapeHtml(session.title || "New chat")}</span><span class="history-row-time">${relativeTime(session.updatedAt)}${sessionUsageLabel(session)}</span>`;
    main.addEventListener("click", () => loadSessionIntoView(session));

    const actions = document.createElement("div");
    actions.className = "history-row-actions";

    const dup = document.createElement("button");
    dup.type = "button";
    dup.className = "history-row-action";
    dup.title = "Duplicate";
    dup.textContent = "⧉";
    dup.addEventListener("click", (e) => {
      e.stopPropagation();
      duplicateSession(session);
    });

    const replay = document.createElement("button");
    replay.type = "button";
    replay.className = "history-row-action";
    replay.title = "Visual replay";
    replay.textContent = "📽";
    replay.addEventListener("click", (e) => {
      e.stopPropagation();
      openReplay(session.id);
    });

    const exp = document.createElement("button");
    exp.type = "button";
    exp.className = "history-row-action";
    exp.title = "Export as markdown";
    exp.textContent = "⬇";
    exp.addEventListener("click", (e) => {
      e.stopPropagation();
      const name = (session.title || "chat").replace(/[^\w-]+/g, "_").slice(0, 60) || "chat";
      downloadText(`${name}.md`, sessionToTranscript(session), "text/markdown");
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-row-delete";
    del.title = "Delete";
    del.textContent = "✕";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { sessions: current = [] } = await chrome.storage.local.get(["sessions"]);
      await chrome.storage.local.set({ sessions: current.filter((s) => s.id !== session.id) });
      // Clears this chat's page recall cache entries too (see
      // lib/pageCache.js) so deleting a chat doesn't leave its cached page
      // content orphaned in storage. Routed through background.js since
      // this file can't import lib/pageCache.js directly (classic script,
      // not a module) - fire-and-forget, deletion of the visible chat
      // itself doesn't need to wait on it.
      chrome.runtime.sendMessage({ type: "DELETE_SESSION_CACHE", sessionId: session.id }).catch(() => {});
      if (session.id === currentSessionId) startNewChat();
      renderHistoryList(historySearch.value);
    });

    actions.appendChild(dup);
    actions.appendChild(exp);
    actions.appendChild(del);

    row.appendChild(main);
    row.appendChild(actions);
    historyList.appendChild(row);
  }
}

historySearch.addEventListener("input", () => renderHistoryList(historySearch.value));

// Best-effort mirror of background.js's migration, so sessions saved before
// the tree model existed still render (as a single linear chain) here too.
function migrateSessionIfNeeded(session) {
  if (session.nodes) return session;

  const nodes = {};
  const rootChildIds = [];
  let rootSelectedChildId = null;
  let currentNode = null;

  for (const event of session.uiEvents || []) {
    if (event.type === "user_message") {
      const node = {
        id: `n_${Math.random().toString(36).slice(2, 10)}`,
        parentId: currentNode ? currentNode.id : null,
        userText: event.text,
        userAttachmentPreviews: event.attachmentPreviews || [],
        uiEvents: [],
        pendingQuestion: null,
        childIds: [],
        selectedChildId: null,
      };
      nodes[node.id] = node;
      if (currentNode) {
        currentNode.childIds.push(node.id);
        currentNode.selectedChildId = node.id;
      } else {
        rootChildIds.push(node.id);
        rootSelectedChildId = node.id;
      }
      currentNode = node;
    } else if (currentNode) {
      currentNode.uiEvents.push(event);
    }
  }
  if (currentNode) currentNode.pendingQuestion = session.pendingQuestion || null;

  return { ...session, nodes, rootChildIds, rootSelectedChildId };
}

function computeActivePath(session) {
  const path = [];
  let id = session.rootSelectedChildId;
  while (id && session.nodes[id]) {
    const node = session.nodes[id];
    path.push(node);
    id = node.selectedChildId;
  }
  return path;
}

function renderSessionPath(session) {
  logEl.innerHTML = "";
  removeTypingBubble();
  const path = computeActivePath(session);

  if (!path.length) {
    showEmptyState();
  } else {
    hideEmptyState();
    for (const node of path) {
      renderUserNode(session, node);
      for (const event of node.uiEvents || []) applyAgentEvent(event, true, node.id);
    }
  }

  updateComposerUsage(session);

  autoScroll = true;
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

// Context ring + click-to-compact — shows active context size as a filled
// ring (clamped relative to AUTO_COMPACT_TOKEN_THRESHOLD). Clicking it
// compacts the session. Only shown when there's measurable usage and only
// active when the user is NOT mid-run.
function updateComposerUsage(session) {
  const el = document.getElementById("composerUsage");
  if (!el) return;

  if (!session) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  const path = computeActivePath(session);
  const lastNode = path[path.length - 1];
  const active = lastNode?.usage ? (lastNode.usage.inputTokens || 0) + (lastNode.usage.outputTokens || 0) : 0;
  if (!active) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  const MAX = AUTO_COMPACT_TOKEN_THRESHOLD; // 250k
  const pct = Math.min(active / MAX, 1);
  const circumference = 2 * Math.PI * 8; // r=8
  const dashOffset = circumference * (1 - pct);
  const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

  el.innerHTML = `
    <button id="contextCompactBtn" class="context-ring-btn" title="Active context: ~${fmtNum(active)} / ${fmtNum(MAX)} tokens — click to compact">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <circle class="context-ring-bg" cx="12" cy="12" r="8"/>
        <circle class="context-ring-fg" cx="12" cy="12" r="8" stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"/>
      </svg>
      <span class="context-ring-label"><strong>${fmtNum(active)}</strong> / ${fmtNum(MAX)} · compact</span>
    </button>`;
  el.classList.remove("hidden");

  const btn = document.getElementById("contextCompactBtn");
  if (btn) {
    btn.addEventListener("click", () => {
      if (running) return;
      compactCurrentSession();
    });
  }
}

function renderUserNode(session, node) {
  const div = document.createElement("div");
  div.className = "entry user";
  div.dataset.nodeId = node.id;

  // Avatar + header row
  const headerRow = document.createElement("div");
  headerRow.className = "msg-header";
  const avatar = document.createElement("span");
  avatar.className = "msg-avatar user-avatar";
  avatar.title = "You";
  avatar.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>`;
  headerRow.appendChild(avatar);
  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(node.createdAt);
  headerRow.appendChild(time);
  div.appendChild(headerRow);

  const body = document.createElement("div");
  body.className = "body user-body";
  body.textContent = node.userText;
  div.appendChild(body);

  for (const preview of node.userAttachmentPreviews || []) {
    if (preview && typeof preview === "object" && (preview.kind === "pdf" || preview.kind === "doc")) {
      const chip = document.createElement("span");
      chip.className = "attachment-doc-thumb";
      chip.title = preview.name;
      chip.textContent = `${docIcon(preview.format)} ${preview.name}${preview.pageCount ? ` (${preview.pageCount}p)` : ""}`;
      div.appendChild(chip);
      continue;
    }
    const img = document.createElement("img");
    img.className = "attachment-thumb";
    img.src = preview;
    div.appendChild(img);
  }

  const siblings = node.parentId ? session.nodes[node.parentId]?.childIds || [] : session.rootChildIds || [];
  const footer = document.createElement("div");
  footer.className = "msg-footer";

  // Branch switcher (left side)
  if (siblings.length > 1) {
    const idx = siblings.indexOf(node.id);
    const switcher = document.createElement("div");
    switcher.className = "branch-switcher";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.textContent = "‹";
    prevBtn.disabled = idx <= 0;
    prevBtn.addEventListener("click", () => switchBranch(node, -1));

    const countLabel = document.createElement("span");
    countLabel.textContent = `${idx + 1}/${siblings.length}`;

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.textContent = "›";
    nextBtn.disabled = idx >= siblings.length - 1;
    nextBtn.addEventListener("click", () => switchBranch(node, 1));

    switcher.appendChild(prevBtn);
    switcher.appendChild(countLabel);
    switcher.appendChild(nextBtn);
    footer.appendChild(switcher);
  }

  // Actions toolbar (copy, edit) — right side
  const actions = document.createElement("div");
  actions.className = "msg-actions";

  actions.appendChild(createCopyButton(() => node.userText, "light"));

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "edit-msg-btn";
  editBtn.title = "Edit this message";
  editBtn.innerHTML = "✎";
  editBtn.addEventListener("click", () => startEditingNode(node));
  actions.appendChild(editBtn);

  footer.appendChild(actions);
  div.appendChild(footer);

  logEl.appendChild(div);
}

async function switchBranch(node, direction) {
  const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
  const raw = sessions.find((s) => s.id === currentSessionId);
  if (!raw) return;
  const session = migrateSessionIfNeeded(raw);

  const siblings = node.parentId ? session.nodes[node.parentId]?.childIds || [] : session.rootChildIds || [];
  const idx = siblings.indexOf(node.id);
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= siblings.length) return;
  const newSelectedId = siblings[newIdx];

  if (node.parentId) session.nodes[node.parentId].selectedChildId = newSelectedId;
  else session.rootSelectedChildId = newSelectedId;
  session.updatedAt = Date.now();

  await chrome.storage.local.set({ sessions: sessions.map((s) => (s.id === session.id ? session : s)) });
  renderSessionPath(session);
}

function startEditingNode(node) {
  editingNodeId = node.id;
  taskInput.value = node.userText;
  autoResize();
  taskInput.focus();
  editBanner.classList.remove("hidden");

  const el = logEl.querySelector(`[data-node-id="${node.id}"]`);
  if (el) {
    let sib = el;
    while (sib) {
      const next = sib.nextSibling;
      sib.remove();
      sib = next;
    }
  }
  if (!logEl.children.length) showEmptyState();
  hidePopover();
}

function cancelEditing() {
  editingNodeId = null;
  taskInput.value = "";
  autoResize();
  editBanner.classList.add("hidden");
  refreshCurrentSessionView();
}

editBannerCancel.addEventListener("click", cancelEditing);

async function refreshCurrentSessionView() {
  if (!currentSessionId) return;
  const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
  const raw = sessions.find((s) => s.id === currentSessionId);
  if (!raw) return;
  renderSessionPath(migrateSessionIfNeeded(raw));
}

function loadSessionIntoView(rawSession) {
  const session = migrateSessionIfNeeded(rawSession);
  currentSessionId = session.id;
  activeRunNodeId = null;
  editingNodeId = null;
  editBanner.classList.add("hidden");
  setActiveAgent(session.agentId ? agents.find((a) => a.id === session.agentId) || null : null);
  renderSessionPath(session);
  closeHistory();
}

// --- log entries -----------------------------------------------------

function showEmptyState() {
  emptyState.classList.remove("hidden");
}
function hideEmptyState() {
  emptyState.classList.add("hidden");
}

// Copy-to-clipboard button reused on user bubbles (beside edit) and on
// assistant/final bubbles (AI responses) — `getText` is a function rather
// than a plain string so callers can pass something that might change (the
// final answer text is stable once rendered, but keeping the same pattern
// as the edit button's node reference costs nothing and avoids ever copying
// stale text if this is ever reused somewhere more dynamic).
// Every link in rendered markdown (bracketed links, bare-URL autolinks, and
// now URLs inside code blocks — see lib/markdown.js's autolinkCode) already
// opens in a new tab via target="_blank". This adds the other half: a tiny
// inline copy button right after each one, so a long/tokenized URL (a
// captured stream link, say) can be copied exactly without the user having
// to manually select it or hunt for "copy link address" in a context menu.
function addCopyButtonsToLinks(body) {
  body.querySelectorAll("a[href]").forEach((a) => {
    const btn = createCopyButton(() => a.href, "muted");
    btn.classList.add("link-copy-btn");
    btn.title = "Copy link";
    a.insertAdjacentElement("afterend", btn);
  });
}

function createCopyButton(getText, variant = "muted") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = variant === "light" ? "msg-copy-btn light" : "msg-copy-btn";
  btn.title = "Copy to clipboard";
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  btn.addEventListener("click", async () => {
    const text = getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API can refuse outside a fresh user gesture in some
      // contexts — fall back to the old execCommand path rather than just
      // silently doing nothing.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up quietly — the button just won't show "Copied" below */
      }
      document.body.removeChild(ta);
    }
    btn.classList.add("copied");
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => {
      btn.classList.remove("copied");
      btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
    }, 1200);
  });
  return btn;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const opts = { hour: "2-digit", minute: "2-digit" };
  if (d.toDateString() !== now.toDateString()) {
    opts.month = "short";
    opts.day = "numeric";
  }
  return d.toLocaleTimeString([], opts);
}

function addPendingTool(id, name, input) {
  hideEmptyState();
  const div = document.createElement("div");
  div.className = "entry tool pending";
  if (id) div.id = `tool-${id}`;

  const inner = document.createElement("div");
  inner.className = "tool-card";

  const headerEl = document.createElement("div");
  headerEl.className = "tool-card-header";
  headerEl.innerHTML = toolIcon(name) + '<span class="tool-card-name">' + toolLabel(name) + '</span>';
  inner.appendChild(headerEl);

  const body = document.createElement("div");
  body.className = "tool-card-body tool-body";
  const summary = summarizeInput(name, input);
  const spinner = document.createElement("span");
  spinner.className = "spinner-inline";
  body.appendChild(spinner);
  body.appendChild(buildToolTextSpan(name, input, summary, summary ? " — running…" : "running…"));
  inner.appendChild(body);

  div.appendChild(inner);
  logEl.appendChild(div);
  scrollToBottomIfNeeded();
}

function addEntry(kind, label, text, markdown = false, attachmentPreviews = []) {
  hideEmptyState();
  const div = document.createElement("div");
  div.className = `entry ${kind}`;

  // Avatar + header row
  const headerRow = document.createElement("div");
  headerRow.className = "msg-header";

  const avatar = document.createElement("span");
  if (kind === "user") {
    avatar.className = "msg-avatar user-avatar";
    avatar.title = "You";
    avatar.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>`;
  } else {
    avatar.className = "msg-avatar agent-avatar";
    avatar.textContent = "T";
  }
  headerRow.appendChild(avatar);

  const labelSpan = document.createElement("span");
  labelSpan.className = "msg-label";
  if (label) labelSpan.textContent = label;
  headerRow.appendChild(labelSpan);

  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime(Date.now());
  headerRow.appendChild(time);

  // Copy button on user/final messages (reuses existing createCopyButton)
  const copyableKind = kind === "user" || kind === "final";
  if (copyableKind) {
    headerRow.appendChild(createCopyButton(() => text, kind === "user" ? "light" : "muted"));
  }

  div.appendChild(headerRow);

  const body = document.createElement("div");
  body.className = kind === "user" ? "body user-body" : "body";
  if (markdown) {
    body.innerHTML = renderMarkdown(text);
    addCopyButtonsToLinks(body);
  } else {
    body.textContent = text;
  }
  div.appendChild(body);

  for (const preview of attachmentPreviews) {
    if (preview && typeof preview === "object" && (preview.kind === "pdf" || preview.kind === "doc")) {
      const chip = document.createElement("span");
      chip.className = "attachment-doc-thumb";
      chip.title = preview.name;
      chip.textContent = `${docIcon(preview.format)} ${preview.name}${preview.pageCount ? ` (${preview.pageCount}p)` : ""}`;
      div.appendChild(chip);
      continue;
    }
    const img = document.createElement("img");
    img.className = "attachment-thumb";
    img.src = preview;
    div.appendChild(img);
  }

  logEl.appendChild(div);
  scrollToBottomIfNeeded();
  return div;
}

// navigate/open_tab's whole summary IS the destination URL (see
// summarizeInput below) — rendered as a real clickable element instead of
// plain text so a step that went somewhere can be reopened directly rather
// than the user re-typing/copying it out of the log. Only for genuine
// http(s) URLs; navigate's "back" pseudo-target and anything else falls
// through to plain text. Reuses the same REOPEN_TAB plumbing (and focusing/
// focus-error feedback states) as the "↻ reopen" affordance on a closed
// parallel_investigate branch row (see reopenTab above).
const LINKABLE_TOOLS = new Set(["navigate", "open_tab"]);

function isHttpUrl(str) {
  if (typeof str !== "string" || !str) return false;
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Builds the `.tool-text` span shared by the pending and completed states of
// a tool card. `suffix` is plain trailing text (e.g. " — running…") appended
// after the summary/link — never part of the link itself.
function buildToolTextSpan(name, input, summaryText, suffix = "") {
  const span = document.createElement("span");
  span.className = "tool-text";

  if (LINKABLE_TOOLS.has(name) && isHttpUrl(summaryText)) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "tool-link";
    link.title = summaryText;
    link.textContent = summaryText.length > 70 ? `${summaryText.slice(0, 67)}…` : summaryText;
    link.addEventListener("click", (e) => {
      e.stopPropagation();
      reopenTab(summaryText, link);
    });
    span.appendChild(link);
  } else {
    span.appendChild(document.createTextNode(summaryText));
  }

  if (suffix) span.appendChild(document.createTextNode(suffix));
  return span;
}

function toolIcon(name) {
  const SVG_ICONS = {
    read_page: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>',
    click: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 2v8l-4-2-2 4 6 3 2 6 4-2 1-7z"/></svg>',
    type_text: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h4M6 14h8"/></svg>',
    select_option: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>',
    fill_form: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12h8M8 16h5"/></svg>',
    press_key: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="2 12 7 17 13 7"/></svg>',
    hover: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>',
    wait_for: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
    find_in_page: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
    scroll: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="8 15 12 19 16 15"/><polyline points="8 9 12 5 16 9"/></svg>',
    navigate: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    open_tab: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    switch_tab: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
    list_tabs: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
    close_tab: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
    read_tabs: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/></svg>',
    view_image: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    screenshot: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="3"/></svg>',
    copy_to_clipboard: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    read_clipboard: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/><path d="M12 15l2 2 4-4"/></svg>',
    create_file: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    extract_table: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="3" x2="9" y2="21"/></svg>',
    upload_file: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    parallel_investigate: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M5 12h.01M19 12h.01M12 5h.01M12 19h.01"/></svg>',
    run_batch: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>',
  };
  return SVG_ICONS[name] || '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/></svg>';
}

// User-facing phrasing for each tool name — shown in the status bar and on
// tool cards instead of the raw snake_case name the model/API sees. Falls
// back to a de-snake-cased version of the name for anything not listed here
// (new tools added later still show *something* readable rather than
// silently reverting to raw_snake_case).
const TOOL_LABELS = {
  read_page: "Reading the page",
  click: "Clicking",
  type_text: "Typing",
  select_option: "Choosing an option",
  fill_form: "Filling in the form",
  press_key: "Pressing a key",
  hover: "Hovering",
  wait_for: "Waiting",
  find_in_page: "Searching the page",
  drag: "Dragging",
  upload_file: "Uploading a file",
  scroll: "Scrolling",
  navigate: "Navigating",
  list_tabs: "Listing open tabs",
  switch_tab: "Switching tabs",
  open_tab: "Opening a new tab",
  close_tab: "Closing a tab",
  read_tabs: "Reading tabs",
  extract_table: "Extracting a table",
  view_image: "Looking at an image",
  filter_images: "Filtering images",
  screenshot: "Taking a screenshot",
  parallel_investigate: "Investigating sources",
  run_batch: "Running batch task",
  copy_to_clipboard: "Copying to clipboard",
  read_clipboard: "Reading the clipboard",
  create_file: "Creating a file",
};
function toolLabel(name) {
  return TOOL_LABELS[name] || name.replace(/_/g, " ");
}

function updateToolEntry(id, name, result, input) {
  const div = id ? document.getElementById(`tool-${id}`) : null;
  const ok = !!(result && result.ok);

  if (name === "list_tabs" && ok && Array.isArray(result.tabs)) {
    renderTabListEntry(div, result.tabs);
    return;
  }

  if (name === "view_image" && ok && result.src) {
    renderViewImageEntry(div, result);
    return;
  }

  if (name === "filter_images" && ok) {
    renderFilterImagesEntry(div, result);
    return;
  }

  if (name === "create_file" && ok) {
    renderCreateFileEntry(div, result, input);
    return;
  }

  const text = ok ? summarizeResult(name, result, input) : `Error: ${result?.error || "unknown error"}`;

  if (!div) {
    addEntry(`tool ${ok ? "ok" : "error"}`, "Tab Agent", text);
    return;
  }

  div.classList.remove("pending");
  div.classList.add(ok ? "ok" : "error");
  const inner = div.querySelector(".tool-card");
  if (inner) {
    // Replace header with done/error state
    const header = inner.querySelector(".tool-card-header");
    if (header) {
      if (!ok) {
        header.style.color = "var(--error-text)";
      }
    }
    const body = inner.querySelector(".tool-body");
    if (body) {
      body.innerHTML = "";
      body.appendChild(buildToolTextSpan(name, input, text));
      if (!ok) {
        body.style.color = "var(--error-text)";
      }
    }
  }
  scrollToBottomIfNeeded();
}

function renderTabListEntry(div, tabs) {
  const target = div;
  if (!target) return;

  target.classList.remove("pending");
  target.classList.add("ok");
  const body = target.querySelector(".tool-body");
  if (!body) return;
  body.classList.add("tab-list");
  body.innerHTML = "";

  tabs.forEach((t) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tab-row" + (t.active ? " active" : "") + (t.restricted ? " restricted" : "");
    row.title = t.restricted ? "Chrome-restricted page" : "Click to switch to this tab";

    const dot = document.createElement("span");
    dot.className = "tab-row-dot";
    row.appendChild(dot);

    const text = document.createElement("span");
    text.className = "tab-row-text";
    text.innerHTML = `<span class="tab-row-title">${escapeHtml(t.title || "(untitled)")}</span><span class="tab-row-url">${escapeHtml(t.url || "")}</span>`;
    row.appendChild(text);

    if (t.restricted) {
      const badge = document.createElement("span");
      badge.className = "tab-row-badge";
      badge.textContent = "restricted";
      row.appendChild(badge);
    }

    row.addEventListener("click", () => focusTab(t.id, row));
    body.appendChild(row);
  });

  scrollToBottomIfNeeded();
}

// Renders view_image's result as a thumbnail (loaded directly from the
// page's own image URL — <img> tags aren't subject to the CORS restriction
// that blocks fetch()-based pixel reads, so this works even for images the
// background fetch needed host_permissions to retrieve) alongside the
// vision model's description, so the user can see exactly what the agent
// saw rather than just trusting a text summary.
function renderViewImageEntry(div, result) {
  if (!div) {
    addEntry("tool ok", `${toolIcon("view_image")} ${toolLabel("view_image")}`, result.description || "Done.");
    return;
  }
  div.classList.remove("pending");
  div.classList.add("ok");
  const body = div.querySelector(".tool-body");
  if (!body) return;
  body.classList.add("vision-result");
  body.innerHTML = "";

  const img = document.createElement("img");
  img.className = "vision-thumb";
  img.src = result.src;
  body.appendChild(img);

  const desc = document.createElement("div");
  desc.className = "tool-text";
  desc.textContent = result.description || "(no description returned)";
  body.appendChild(desc);

  scrollToBottomIfNeeded();
}

// Renders filter_images's result as a grid of thumbnails, each labeled with
// whether it matched the criteria and why — plus a one-line summary count.
// Matches are shown first so the user can immediately see what the agent is
// about to act on; non-matches and any images that couldn't be classified
// follow, faded out, purely for transparency ("every attempt logged").
function renderFilterImagesEntry(div, result) {
  const matches = result.matches || [];
  const nonMatches = result.non_matches || [];
  const uncertain = result.uncertain || [];
  const summaryText = `${matches.length} of ${matches.length + nonMatches.length + uncertain.length} match${matches.length === 1 ? "es" : ""}${result.criteria ? ` - "${result.criteria}"` : ""}`;

  if (!div) {
    addEntry("tool ok", `${toolIcon("filter_images")} ${toolLabel("filter_images")}`, summaryText);
    return;
  }
  div.classList.remove("pending");
  div.classList.add("ok");
  const body = div.querySelector(".tool-body");
  if (!body) return;
  body.classList.add("filter-images-result");
  body.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "tool-text";
  summary.textContent = summaryText;
  body.appendChild(summary);

  const grid = document.createElement("div");
  grid.className = "filter-images-grid";
  const addCell = (entry, cls) => {
    const cell = document.createElement("div");
    cell.className = `filter-image-cell ${cls}`;
    cell.title = entry.reason || "";
    const img = document.createElement("img");
    img.src = entry.src;
    img.alt = entry.reason || "";
    cell.appendChild(img);
    grid.appendChild(cell);
  };
  matches.forEach((e) => addCell(e, "match"));
  nonMatches.forEach((e) => addCell(e, "no-match"));
  uncertain.forEach((e) => addCell(e, "uncertain"));
  body.appendChild(grid);

  scrollToBottomIfNeeded();
}

function formatFileSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The file's actual text lives only in the tool CALL's own input (see
// lib/agentLoop.js's create_file case) — result carries just filename/
// mime_type/size, so this is the one render function that reads `input`
// instead of `result` for its main content. Blob + a synthetic <a download>
// click needs no chrome.downloads permission at all; it's the same
// mechanism any web page uses to offer a generated file.
function renderCreateFileEntry(div, result, input) {
  const filename = result.filename || input?.filename || "file.txt";
  const mimeType = result.mime_type || "text/plain";
  const content = input?.content ?? "";
  const sizeLabel = formatFileSize(typeof result.size === "number" ? result.size : content.length);

  const fillBody = (body) => {
    body.classList.add("create-file-result");
    body.innerHTML = "";

    const info = document.createElement("div");
    info.className = "tool-text";
    info.textContent = `${filename} · ${sizeLabel}`;
    body.appendChild(info);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "download-file-btn";
    btn.textContent = "⬇ Download";
    btn.addEventListener("click", () => {
      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
    body.appendChild(btn);
  };

  if (!div) {
    // Same defensive fallback as renderViewImageEntry/renderFilterImagesEntry
    // above — shouldn't normally happen since the assistant event that
    // preceded this always creates the pending card first via addPendingTool.
    const wrapper = document.createElement("div");
    wrapper.className = "entry tool ok";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = `${toolIcon("create_file")} ${toolLabel("create_file")}`;
    wrapper.appendChild(label);
    const body = document.createElement("div");
    body.className = "tool-body";
    fillBody(body);
    wrapper.appendChild(body);
    logEl.appendChild(wrapper);
    scrollToBottomIfNeeded();
    return;
  }

  div.classList.remove("pending");
  div.classList.add("ok");
  const body = div.querySelector(".tool-body");
  if (!body) return;
  fillBody(body);
  scrollToBottomIfNeeded();
}

function focusTab(tabId, rowEl) {
  rowEl.classList.add("focusing");
  chrome.runtime.sendMessage({ type: "FOCUS_TAB", tabId }, (res) => {
    rowEl.classList.remove("focusing");
    if (!res || !res.ok) {
      rowEl.classList.add("focus-error");
      setTimeout(() => rowEl.classList.remove("focus-error"), 900);
    }
  });
}

function reopenTab(url, btnEl) {
  btnEl.classList.add("focusing");
  btnEl.disabled = true;
  chrome.runtime.sendMessage({ type: "REOPEN_TAB", url }, (res) => {
    btnEl.classList.remove("focusing");
    btnEl.disabled = false;
    if (!res || !res.ok) {
      btnEl.classList.add("focus-error");
      setTimeout(() => btnEl.classList.remove("focus-error"), 900);
    }
  });
}

// Scoped "skip remaining sub-tasks" — the card-level button, distinct from
// the global Stop button. Only ends whatever parallel_investigate/run_batch
// call this specific card represents; the main conversation keeps going
// once it wraps up. See background.js's SKIP_SUBTASKS handler and
// lib/agentLoop.js's ctx.shouldSkip for the rest of the plumbing.
function skipSubtasks(callId, btnEl) {
  btnEl.disabled = true;
  btnEl.textContent = "Skipping…";
  chrome.runtime.sendMessage({ type: "SKIP_SUBTASKS", callId, sessionId: currentSessionId }, (res) => {
    if (!res || !res.ok) {
      btnEl.disabled = false;
      btnEl.textContent = "⏹ Skip remaining, continue";
    }
    // On success, leave it disabled/labeled "Skipping…" — the branch_done/
    // batch_done events that follow will hide it entirely once everything
    // still in flight has actually wound down.
  });
}

// --- parallel_investigate live status card --------------------------------
//
// One card per parallel_investigate call, keyed by the tool call's id so the
// branch_active/branch_step/branch_done/branch_closed events that follow
// (each carrying the same callId) can find and update the right row without
// re-rendering the whole card. Rows go planned -> active -> done(-ok/error),
// and separately gain a "closed" flag once their tab auto-closes, which
// swaps the view button for a reopen button.

function branchLabelText(b) {
  return b.label + (b.url ? ` - ${hostnameLabel(b.url)}` : "");
}

function hostnameLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function addInvestigateCard(callId, branches, remainingCount, nodeId) {
  hideEmptyState();
  const div = document.createElement("div");
  div.className = "entry investigate-card";
  div.id = `investigate-${callId}`;
  if (nodeId) div.dataset.nodeId = nodeId;
  div.dataset.pendingCount = String(branches.length);

  const header = document.createElement("div");
  header.className = "sub-card-header";

  const labelSpan = document.createElement("span");
  labelSpan.className = "label";
  labelSpan.textContent = `🔀 Investigating ${branches.length} source${branches.length === 1 ? "" : "s"}`;
  header.appendChild(labelSpan);

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "sub-card-skip-btn";
  skipBtn.textContent = "⏹ Skip remaining, continue";
  skipBtn.title = "Stop waiting on sources still running and let the agent continue with what it has";
  skipBtn.addEventListener("click", () => skipSubtasks(callId, skipBtn));
  header.appendChild(skipBtn);

  div.appendChild(header);

  const rows = document.createElement("div");
  rows.className = "investigate-rows";

  for (const b of branches) {
    const row = document.createElement("div");
    row.className = "branch-row planned";
    row.id = `branch-${callId}-${cssEscape(b.label)}`;
    row.dataset.label = b.label;
    if (b.url) row.dataset.url = b.url;
    if (b.objective) row.dataset.objective = b.objective;
    if (nodeId) row.dataset.nodeId = nodeId;

    const main = document.createElement("div");
    main.className = "branch-row-main";

    const dot = document.createElement("span");
    dot.className = "branch-row-dot";
    main.appendChild(dot);

    const text = document.createElement("span");
    text.className = "branch-row-text";
    text.innerHTML = `<span class="branch-row-title">${escapeHtml(branchLabelText(b))}</span><span class="branch-row-caption">Queued…</span>`;
    main.appendChild(text);

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "branch-row-view hidden";
    viewBtn.textContent = "↗ view";
    main.appendChild(viewBtn);

    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "branch-row-resume hidden";
    resumeBtn.textContent = "▶ resume";
    main.appendChild(resumeBtn);

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "branch-row-expand";
    expandBtn.textContent = "⌄";
    expandBtn.title = "Show steps";
    main.appendChild(expandBtn);

    row.appendChild(main);

    const detail = document.createElement("div");
    detail.className = "branch-row-detail hidden";
    const steps = document.createElement("ul");
    steps.className = "branch-row-steps";
    detail.appendChild(steps);
    const findings = document.createElement("div");
    findings.className = "branch-row-findings hidden";
    detail.appendChild(findings);
    row.appendChild(detail);

    expandBtn.addEventListener("click", () => {
      detail.classList.toggle("hidden");
      expandBtn.textContent = detail.classList.contains("hidden") ? "⌄" : "⌃";
    });

    rows.appendChild(row);
  }

  div.appendChild(rows);

  if (remainingCount > 0) {
    const note = document.createElement("div");
    note.className = "investigate-remaining";
    note.textContent = `+${remainingCount} more queued for the next round…`;
    div.appendChild(note);
  }

  logEl.appendChild(div);
  scrollToBottomIfNeeded();
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function findBranchRow(callId, label) {
  return document.getElementById(`branch-${callId}-${cssEscape(label)}`);
}

function updateBranchRowView(row, tabId, url, closed) {
  const viewBtn = row.querySelector(".branch-row-view");
  if (!viewBtn) return;
  if (closed && url) {
    viewBtn.classList.remove("hidden");
    viewBtn.textContent = "↻ reopen";
    viewBtn.onclick = () => reopenTab(url, viewBtn);
  } else if (typeof tabId === "number") {
    viewBtn.classList.remove("hidden");
    viewBtn.textContent = "↗ view";
    viewBtn.onclick = () => focusTab(tabId, viewBtn);
  }
}

function handleBranchActive(event) {
  const row = findBranchRow(event.callId, event.label);
  if (!row) return;
  // A resume re-fires branch_active on a row that's already in some "done"
  // state (most commonly done-incomplete, from the "ran out of steps"
  // outcome that triggered the resume in the first place) — detect that
  // BEFORE clearing the classes below, so the row's own history can carry a
  // marker into the next round.
  const isResume = row.classList.contains("done-ok") || row.classList.contains("done-error") || row.classList.contains("done-incomplete");

  row.classList.remove("planned", "done-ok", "done-error", "done-incomplete", "closed");
  row.classList.add("active");
  if (typeof event.tabId === "number") row.dataset.tabId = String(event.tabId);
  const caption = row.querySelector(".branch-row-caption");
  if (caption) caption.textContent = isResume ? "Resuming…" : "Starting…";
  const resumeBtn = row.querySelector(".branch-row-resume");
  if (resumeBtn) resumeBtn.classList.add("hidden");

  // Clear the previous attempt's findings summary (e.g. "Reached the step
  // limit…") — it's about to be superseded by this attempt's outcome, and
  // leaving it visible while a resume is actively running makes it look
  // like the resume had no effect / is stuck repeating the same message.
  const findings = row.querySelector(".branch-row-findings");
  if (findings) {
    findings.textContent = "";
    findings.classList.add("hidden");
  }

  if (isResume) {
    const steps = row.querySelector(".branch-row-steps");
    if (steps) {
      const li = document.createElement("li");
      li.className = "branch-row-steps-divider";
      li.textContent = "· resumed ·";
      steps.appendChild(li);
      steps.scrollTop = steps.scrollHeight;
    }
  }

  updateBranchRowView(row, event.tabId, event.url, false);
}

function handleBranchStep(event) {
  const row = findBranchRow(event.callId, event.label);
  if (!row) return;
  const caption = row.querySelector(".branch-row-caption");
  if (caption) caption.textContent = event.caption || "Working…";

  // The row title is otherwise frozen at whatever URL the branch STARTED
  // on (e.g. a Google search) — once the model navigates to a specific
  // result, the title should follow it, both so the label stays honest
  // and so "view"/"reopen" point at the page actually being read rather
  // than the stale starting point.
  if (event.url) {
    row.dataset.url = event.url;
    const titleEl = row.querySelector(".branch-row-title");
    if (titleEl) titleEl.textContent = branchLabelText({ label: row.dataset.label, url: event.url });
  }

  const steps = row.querySelector(".branch-row-steps");
  if (steps && event.caption) {
    const li = document.createElement("li");
    li.textContent = event.caption;
    steps.appendChild(li);
    // The list is a fixed-height scroll area (see .branch-row-steps in
    // sidepanel.css) rather than growing the card unbounded — keep it
    // pinned to the newest step, same idea as the main log's auto-scroll.
    steps.scrollTop = steps.scrollHeight;
  }
}

// Bulk-inserts a run's full set of step captions in one go — used only on
// replay (see handleBranchDone/handleBatchDone below), since a live run
// already appends these one at a time as each branch_step/batch_step event
// arrives. branch_step/batch_step themselves are still broadcast-only (never
// written to storage, see persistAgentEvent in background.js) — instead the
// terminal branch_done/batch_done event (which IS persisted) now carries the
// whole run's captions in a `steps` array, so reloading/switching edit
// versions/reopening from History can rebuild the list without a storage
// write per micro-step.
function appendStepCaptions(stepsEl, captions) {
  if (!stepsEl || !Array.isArray(captions) || !captions.length) return;
  for (const caption of captions) {
    const li = document.createElement("li");
    li.textContent = caption;
    stepsEl.appendChild(li);
  }
  stepsEl.scrollTop = stepsEl.scrollHeight;
}

function handleBranchDone(event, isReplay = false) {
  const row = findBranchRow(event.callId, event.label);
  if (!row) return;
  if (isReplay) appendStepCaptions(row.querySelector(".branch-row-steps"), event.steps);
  row.classList.remove("planned", "active");
  if (event.objective) row.dataset.objective = event.objective;
  if (typeof event.tabId === "number") row.dataset.tabId = String(event.tabId);

  const caption = row.querySelector(".branch-row-caption");
  const findings = row.querySelector(".branch-row-findings");
  const resumeBtn = row.querySelector(".branch-row-resume");

  if (event.skipped) {
    // User-directed, via the card's own skip button — not a failure and
    // not something to invite a resume for (that would undo the point of
    // skipping it), so it gets its own neutral state distinct from both
    // done-error and done-incomplete.
    row.classList.add("skipped");
    if (caption) caption.textContent = "Skipped";
    if (resumeBtn) resumeBtn.classList.add("hidden");
  } else if (event.incomplete) {
    // Ran out of steps, not a real failure — the tab was deliberately left
    // open (see resumeBranch in agentLoop.js) so the user can pick this
    // specific source back up with a fresh step budget instead of it just
    // being a dead end.
    row.classList.add("done-incomplete");
    if (caption) caption.textContent = "Ran out of steps - resume?";
    if (resumeBtn) {
      resumeBtn.classList.remove("hidden");
      resumeBtn.disabled = false;
      resumeBtn.textContent = "▶ resume";
      resumeBtn.onclick = () => resumeBranchRow(row, event.callId);
    }
  } else {
    row.classList.add(event.ok ? "done-ok" : "done-error");
    if (caption) caption.textContent = event.ok ? "Done" : "Couldn't complete";
    if (resumeBtn) resumeBtn.classList.add("hidden");
  }

  if (findings && event.findings) {
    // Sub-agents write findings the same way the main loop writes a finish
    // answer — markdown (bold, bullets, etc.) — so render it the same way
    // instead of dumping it as plain text, which just showed the raw
    // **asterisks**/- bullets literally instead of formatting them.
    findings.innerHTML = renderMarkdown(event.findings);
    addCopyButtonsToLinks(findings);
    findings.classList.remove("hidden");
  }
  const tabId = typeof event.tabId === "number" ? event.tabId : Number(row.dataset.tabId);
  updateBranchRowView(row, Number.isFinite(tabId) ? tabId : null, event.href || event.url, false);

  hideSkipButtonIfCardDone(event.callId);
}

// The investigate card's skip button only makes sense while at least one
// row is still planned/active — once every row has landed in some terminal
// state (done-ok/done-error/done-incomplete/skipped), there's nothing left
// to skip, so hide it rather than leave a dead button sitting there.
function hideSkipButtonIfCardDone(callId) {
  const card = document.getElementById(`investigate-${callId}`);
  if (!card) return;
  const stillGoing = card.querySelector(".branch-row.planned, .branch-row.active");
  if (!stillGoing) {
    const skipBtn = card.querySelector(".sub-card-skip-btn");
    if (skipBtn) skipBtn.classList.add("hidden");
  }
}

// Fires the "▶ resume" button on a branch row that ran out of steps —
// sends RESUME_BRANCH to background.js, which reuses the same (still open)
// tab for a fresh step budget. Runs independently of the model's turn (that
// tool call already returned), so this doesn't touch the assistant/tool_call
// transcript — it just keeps updating the same row via the same callId/label
// the way the original branch did.
function resumeBranchRow(row, callId) {
  const resumeBtn = row.querySelector(".branch-row-resume");
  const tabId = Number(row.dataset.tabId);
  const label = row.dataset.label;
  const url = row.dataset.url || null;
  const objective = row.dataset.objective;
  const nodeId = row.dataset.nodeId;

  if (!Number.isFinite(tabId) || !objective) return;

  if (resumeBtn) {
    resumeBtn.disabled = true;
    resumeBtn.textContent = "Resuming…";
  }

  activeRunNodeId = nodeId;
  const [providerId, modelId] = (modelSelect.value || "").split("::");
  chrome.runtime.sendMessage(
    {
      type: "RESUME_BRANCH",
      sessionId: currentSessionId,
      nodeId,
      callId,
      label,
      tabId,
      url,
      objective,
      providerId: providerId || undefined,
      modelId: modelId || undefined,
    },
    (res) => {
      if (!res || !res.ok) {
        if (resumeBtn) {
          resumeBtn.disabled = false;
          resumeBtn.textContent = "▶ resume";
        }
        const caption = row.querySelector(".branch-row-caption");
        if (caption) caption.textContent = (res && res.error) || "Couldn't resume - try again.";
      }
      // On success, the branch_active/branch_step/branch_done broadcast
      // events (fired from resumeBranch via the same onEvent callback)
      // drive the rest of the row's UI, same as the original run.
    }
  );
}

function handleBranchClosed(event) {
  const row = findBranchRow(event.callId, event.label);
  if (!row) return;
  row.classList.add("closed");
  updateBranchRowView(row, null, event.url || row.dataset.url, true);
}

// --- run_batch live status card --------------------------------------------

function addBatchCard(callId, maxSteps) {
  hideEmptyState();
  const div = document.createElement("div");
  div.className = "entry batch-card active";
  div.id = `batch-${callId}`;
  div.dataset.maxSteps = String(maxSteps);

  const header = document.createElement("div");
  header.className = "sub-card-header";

  const labelSpan = document.createElement("span");
  labelSpan.className = "label";
  labelSpan.textContent = "🔁 Batch task";
  header.appendChild(labelSpan);

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "sub-card-skip-btn";
  skipBtn.textContent = "⏹ Stop here, continue";
  skipBtn.title = "End this batch task now and let the agent continue with whatever it's gathered so far";
  skipBtn.addEventListener("click", () => skipSubtasks(callId, skipBtn));
  header.appendChild(skipBtn);

  div.appendChild(header);

  const main = document.createElement("div");
  main.className = "batch-card-main";

  const dot = document.createElement("span");
  dot.className = "branch-row-dot";
  main.appendChild(dot);

  const text = document.createElement("span");
  text.className = "batch-card-text";
  text.innerHTML = `<span class="batch-card-caption">Starting…</span><span class="batch-card-progress">Step 0 / ${maxSteps}</span>`;
  main.appendChild(text);

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "branch-row-expand";
  expandBtn.textContent = "⌄";
  expandBtn.title = "Show steps";
  main.appendChild(expandBtn);

  div.appendChild(main);

  const findings = document.createElement("div");
  findings.className = "batch-card-findings hidden";
  div.appendChild(findings);

  const detail = document.createElement("div");
  detail.className = "branch-row-detail hidden";
  const steps = document.createElement("ul");
  steps.className = "branch-row-steps";
  detail.appendChild(steps);
  div.appendChild(detail);

  expandBtn.addEventListener("click", () => {
    detail.classList.toggle("hidden");
    expandBtn.textContent = detail.classList.contains("hidden") ? "⌄" : "⌃";
  });

  logEl.appendChild(div);
  scrollToBottomIfNeeded();
}

function handleBatchStep(event) {
  const div = document.getElementById(`batch-${event.callId}`);
  if (!div) return;
  const maxSteps = Number(div.dataset.maxSteps) || "?";
  const caption = div.querySelector(".batch-card-caption");
  if (caption) caption.textContent = event.caption || "Working…";
  const progress = div.querySelector(".batch-card-progress");
  if (progress) progress.textContent = `Step ${event.stepsUsed || 0} / ${maxSteps}`;
  const steps = div.querySelector(".branch-row-steps");
  if (steps && event.caption) {
    const li = document.createElement("li");
    li.textContent = event.caption;
    steps.appendChild(li);
    steps.scrollTop = steps.scrollHeight;
  }
}

function handleBatchDone(event, isReplay = false) {
  const div = document.getElementById(`batch-${event.callId}`);
  if (!div) return;
  if (isReplay) appendStepCaptions(div.querySelector(".branch-row-steps"), event.steps);
  div.classList.remove("active");

  if (event.skipped) {
    div.classList.add("skipped");
  } else {
    div.classList.add(event.ok ? (event.incomplete ? "done-incomplete" : "done-ok") : "done-error");
  }

  const caption = div.querySelector(".batch-card-caption");
  if (caption) {
    caption.textContent = event.skipped
      ? `Stopped after ${event.stepsUsed} steps - skipped by user`
      : event.incomplete
      ? `Paused after ${event.stepsUsed} steps - call run_batch again to continue`
      : event.ok
      ? "Done"
      : "Couldn't complete";
  }

  // A batch task's terminal state (finished or gave up, not paused/skipped)
  // is the closest thing it has to a "final answer" — render its summary the
  // same way a normal chat final response renders (markdown, not a plain-text
  // dump), instead of leaving the user to expand the raw step-by-step
  // caption log to find out what it actually concluded.
  const findings = div.querySelector(".batch-card-findings");
  if (findings && event.summary && !event.skipped && !event.incomplete) {
    findings.innerHTML = renderMarkdown(event.summary);
    addCopyButtonsToLinks(findings);
    findings.classList.remove("hidden");
  }

  const skipBtn = div.querySelector(".sub-card-skip-btn");
  if (skipBtn) skipBtn.classList.add("hidden");
}

function summarizeInput(name, input) {
  if (!input || Object.keys(input).length === 0) return "";
  if (name === "type_text") return `"${input.text || ""}" → ${input.element_id || input.element_text || ""}`;
  if (name === "click") {
    const target = input.element_id || input.element_text || (typeof input.x === "number" ? `(${input.x}, ${input.y})` : "");
    const prefix = input.click_type === "double" ? "double-click " : input.click_type === "right" ? "right-click " : "";
    return prefix ? `${prefix}${target}` : target;
  }
  if (name === "select_option") return `${(input.values || []).join(", ")} → ${input.element_id || ""}`;
  if (name === "fill_form") return `${(input.fields || []).length} field${(input.fields || []).length === 1 ? "" : "s"}`;
  if (name === "press_key") return `${input.key || ""}${input.element_id ? ` → ${input.element_id}` : ""}`;
  if (name === "hover") return input.element_id || "";
  if (name === "wait_for") return input.text ? `"${input.text}" appears` : input.text_gone ? `"${input.text_gone}" gone` : "";
  if (name === "find_in_page") return input.text || input.regex || "";
  if (name === "drag") return `${input.from_element_id || ""} → ${input.to_element_id || ""}`;
  if (name === "upload_file") return `${input.attachment_id || ""} → ${input.element_id || ""}`;
  if (name === "navigate") return input.url || "";
  if (name === "recall_page") return input.url || "";
  if (name === "read_attachment_chunk") return `chunk ${input.chunk_index} of ${input.attachment_id || "attachment"}`;
  if (name === "scroll") return input.to === "bottom" ? "to bottom" : input.direction || "";
  if (name === "switch_tab") return `tab ${input.tab_id}`;
  if (name === "open_tab") return input.url || "";
  if (name === "close_tab") return `tab ${input.tab_id}`;
  if (name === "read_tabs") return `${(input.tab_ids || []).length} tabs`;
  if (name === "extract_table") return input.table_id || "";
  if (name === "view_image") return input.image_id || "";
  if (name === "filter_images") return `${(input.image_ids || []).length} image${(input.image_ids || []).length === 1 ? "" : "s"} - "${input.criteria || ""}"`;
  if (name === "copy_to_clipboard") return `"${(input.text || "").slice(0, 60)}"`;
  if (name === "create_file") return input.filename || "";
  return JSON.stringify(input);
}

function summarizeResult(name, result, input) {
  if (name === "read_page" && result.interactive_elements) {
    const imgCount = (result.images || []).length;
    return `Read "${result.title || result.url || "page"}" - ${result.interactive_elements.length} interactive elements${imgCount ? `, ${imgCount} image${imgCount === 1 ? "" : "s"}` : ""} found.`;
  }
  if (name === "list_tabs" && result.tabs) {
    return `Found ${result.tabs.length} open tab${result.tabs.length === 1 ? "" : "s"}.`;
  }
  if (name === "recall_page") {
    // Distinguishable from a live "Read ..." caption (see read_page above)
    // so the transcript/usage history makes clear this step didn't re-visit
    // anything - it still costs tokens (whatever comes back still enters
    // context), just not a browsing round-trip.
    return result.ok
      ? `Recalled cached page "${result.title || result.url || "page"}" (captured ${relativeTime(new Date(result.captured_at).getTime())}) - not a live read.`
      : `No cached page for this URL - ${result.error || "not available"}`;
  }
  if (name === "read_attachment_chunk") {
    return result.ok
      ? `Read chunk ${result.chunk_index} of ${result.total_chunks} of "${result.name || "attachment"}"${result.has_more ? "" : " (last chunk)"}.`
      : `No cached chunk for that attachment - ${result.error || "not available"}`;
  }
  if (name === "read_tabs" && result.tabs) {
    const okCount = result.tabs.filter((t) => t.ok).length;
    return `Read ${okCount} of ${result.tabs.length} tab${result.tabs.length === 1 ? "" : "s"}.`;
  }
  if (name === "extract_table" && result.rows) {
    return `Extracted ${result.row_count} row${result.row_count === 1 ? "" : "s"}${result.truncated ? ` (of ${result.total_rows} total, truncated)` : ""}.`;
  }
  if (name === "find_in_page" && result.matches) {
    return `Found ${result.matches.length} match${result.matches.length === 1 ? "" : "es"}${result.truncated ? " (truncated)" : ""}.`;
  }
  if (name === "wait_for") {
    return result.found ? "Condition met." : "Timed out waiting.";
  }
  if (name === "read_clipboard" && result.ok) {
    return `Clipboard: "${(result.text || "").slice(0, 60)}"`;
  }
  if ((name === "view_image" || name === "screenshot") && result.description) {
    return result.description;
  }
  if (result.note) return result.note;
  // click / type_text / scroll / navigate / switch_tab / open_tab have no
  // special-cased rendering above — keep showing what was actually done
  // (the same summary already shown while pending) instead of collapsing to
  // a generic "Done.", which threw away the one useful piece of information
  // (which element, which URL, which tab) on every single completed card.
  return summarizeInput(name, input) || "Done.";
}

// --- typing indicator + status bar + top progress bar --------------------

function typingDotsHtml() {
  return `<span class="dots"><span></span><span></span><span></span></span>`;
}

function showTypingBubble() {
  if (document.getElementById("typingBubble")) return;
  hideEmptyState();
  const div = document.createElement("div");
  div.className = "entry assistant typing";
  div.id = "typingBubble";
  div.innerHTML = `<div class="body">${typingDotsHtml()}</div>`;
  logEl.appendChild(div);
  scrollToBottomIfNeeded();
}

// Pending markdown re-render, coalesced to one paint per animation frame —
// deltas can arrive many times faster than the screen refreshes, and without
// this each one triggers its own renderMarkdown() pass + reflow, letting the
// total re-parse cost grow with delta *count* instead of just answer length.
let pendingStreamText = null;
let streamRafId = null;

function removeTypingBubble() {
  if (streamRafId) {
    cancelAnimationFrame(streamRafId);
    streamRafId = null;
  }
  pendingStreamText = null;
  document.getElementById("typingBubble")?.remove();
}

// Live token-by-token preview while a step is streaming in. Re-renders the
// whole accumulated text as markdown (renderMarkdown() is cheap line-based
// parsing, not worth diffing) — an unclosed construct (a dangling ``` fence,
// a lone leading -) just renders literally until the next delta completes
// it, since renderMarkdown()'s inline regexes require a matching closing
// delimiter before converting anything. The final 'assistant' event replaces
// this bubble outright once the step completes.
function updateStreamingText(text) {
  if (!text) return;
  pendingStreamText = text;
  if (streamRafId) return;
  streamRafId = requestAnimationFrame(() => {
    streamRafId = null;
    const bubble = document.getElementById("typingBubble");
    const body = bubble?.querySelector(".body");
    if (!body || pendingStreamText == null) return;
    body.innerHTML = renderMarkdown(pendingStreamText);
    body.classList.add("streaming-text");
    scrollToBottomIfNeeded();
  });
}

// A tool call (e.g. 'finish') is about to start streaming its own text into
// this same bubble — snap back to the thinking-dots placeholder first rather
// than jump-cutting straight from an unrelated block of prose to a single
// character of the new content, which reads as a glitch rather than a new
// message starting.
function resetStreamingText() {
  if (streamRafId) {
    cancelAnimationFrame(streamRafId);
    streamRafId = null;
  }
  pendingStreamText = null;
  const bubble = document.getElementById("typingBubble");
  const body = bubble?.querySelector(".body");
  if (!body) return;
  body.innerHTML = typingDotsHtml();
  body.classList.remove("streaming-text");
}

function showStatus(text, animated = false) {
  statusText.innerHTML = animated ? `${escapeHtml(text)} ${typingDotsHtml()}` : escapeHtml(text);
  statusBar.classList.remove("hidden");
}

function hideStatus() {
  statusBar.classList.add("hidden");
}

function setProgressActive(state) {
  topProgress.classList.toggle("active", state);
}

// --- autoscroll: follow while generating, stop if user scrolls up,
// resume automatically the next time a task is sent -----------------

scrollEl.addEventListener("scroll", () => {
  const threshold = 32;
  const atBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < threshold;
  if (!atBottom) autoScroll = false;
});

function scrollToBottomIfNeeded() {
  if (autoScroll) scrollEl.scrollTop = scrollEl.scrollHeight;
}

// --- composer: auto-resize textarea, Enter to send ----------------------

function autoResize() {
  taskInput.style.height = "auto";
  taskInput.style.height = `${Math.min(taskInput.scrollHeight, 140)}px`;
}
taskInput.addEventListener("input", () => {
  autoResize();
  checkForSlashCommand();
});
// Deferred a frame — called this synchronously at parse time, the side
// panel's own layout isn't always settled yet, so scrollHeight can measure
// against a not-yet-final width and stick the box near its 140px cap with
// nothing to ever re-measure it afterward (no input event fires on an
// untouched box). Waiting for the next paint gives an accurate reading.
requestAnimationFrame(autoResize);

taskInput.addEventListener("keydown", (e) => {
  if (!agentPopover.classList.contains("hidden") && popoverMatches.length) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      popoverIndex = (popoverIndex + 1) % popoverMatches.length;
      updatePopoverHighlight();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      popoverIndex = (popoverIndex - 1 + popoverMatches.length) % popoverMatches.length;
      updatePopoverHighlight();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pickPopoverItem(popoverMatches[popoverIndex]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hidePopover();
      return;
    }
  }

  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendTask();
  }
});

taskInput.addEventListener("blur", hidePopover);

// --- attachments ---------------------------------------------------

attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = "";

  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      addEntry("error", "Attachment", `You can attach up to ${MAX_ATTACHMENTS} files per message.`);
      break;
    }

    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (isPdf) {
      if (file.size > MAX_PDF_BYTES) {
        addEntry("error", "Attachment", `${file.name} is too large (max ${MAX_PDF_BYTES / (1024 * 1024)}MB).`);
        continue;
      }
      try {
        const extracted = await extractPdfText(file);
        attachments.push({
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          kind: "doc",
          format: "pdf",
          text: extracted.text,
          pageCount: extracted.pageCount,
        });
      } catch (err) {
        addEntry("error", "Attachment", `${file.name}: couldn't read this PDF (${err?.message || err}).`);
      }
      continue;
    }

    const textFormat = textAttachmentFormat(file);
    if (textFormat) {
      if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
        addEntry("error", "Attachment", `${file.name} is too large (max ${MAX_TEXT_ATTACHMENT_BYTES / (1024 * 1024)}MB).`);
        continue;
      }
      try {
        const text = (await file.text()).replace(/^\uFEFF/, ""); // strip a UTF-8 BOM if present
        attachments.push({
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          kind: "doc",
          format: textFormat,
          text,
        });
      } catch (err) {
        addEntry("error", "Attachment", `${file.name}: couldn't read this file (${err?.message || err}).`);
      }
      continue;
    }

    if (!file.type.startsWith("image/")) {
      addEntry("error", "Attachment", `${file.name}: only images, PDFs, and plain-text files (.txt, .md, .csv, .json, and similar) are supported.`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      addEntry("error", "Attachment", `${file.name} is too large (max 5MB).`);
      continue;
    }

    const dataUrl = await readFileAsDataUrl(file);
    const [, mediaType, base64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
    if (!base64) continue;

    attachments.push({
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: file.name,
      kind: "image",
      mediaType,
      data: base64,
      previewUrl: dataUrl,
    });
  }

  renderAttachments();
});

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Client-side text extraction via the vendored pdf.js build — runs entirely
// in the side panel, nothing leaves the browser. Only extracts embedded text
// layers; scanned/image-only PDFs won't yield useful text (a limitation we
// surface via pageCount/truncated rather than silently returning nothing).
async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error("PDF support unavailable");
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const pageCount = doc.numPages;
  let text = "";

  // Every page, no cap — background.js's buildDocBlocks chunks whatever
  // comes back through lib/attachmentCache.js instead of this function
  // trimming it up front. A very long PDF just means more chunks for the
  // model to page through via read_attachment_chunk, not missing pages.
  for (let i = 1; i <= pageCount; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it) => it.str || "").join(" ");
    text += (text ? "\n\n" : "") + `[Page ${i}]\n${pageText}`;
  }

  return { text: text.trim(), pageCount };
}

function renderAttachments() {
  attachmentsRow.innerHTML = "";
  if (!attachments.length) {
    attachmentsRow.classList.add("hidden");
    return;
  }
  attachmentsRow.classList.remove("hidden");
  for (const att of attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";

    if (att.kind === "pdf" || att.kind === "doc") {
      chip.classList.add("attachment-chip-doc");
      const icon = document.createElement("span");
      icon.className = "attachment-doc-icon";
      icon.textContent = docIcon(att.format);
      chip.appendChild(icon);
      const info = document.createElement("span");
      info.className = "attachment-doc-name";
      info.title = att.name;
      info.textContent = `${att.name}${att.pageCount ? ` (${att.pageCount}p)` : ""}`;
      chip.appendChild(info);
    } else {
      const img = document.createElement("img");
      img.src = att.previewUrl;
      img.alt = att.name;
      chip.appendChild(img);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-chip";
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      attachments = attachments.filter((a) => a.id !== att.id);
      renderAttachments();
    });
    chip.appendChild(removeBtn);
    attachmentsRow.appendChild(chip);
  }
}

// --- voice input -----------------------------------------------------

// Chrome's Web Speech API (webkitSpeechRecognition) works the same in an
// extension side panel as it does on a regular page — no manifest permission
// needed, just a getUserMedia-style mic prompt on first use. Feature-detect
// rather than assume, since it's Chromium-only and can be disabled by policy.
const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;
// Text already in the box before this recognition session started — new
// speech is appended after it rather than replacing it, so a user can type
// part of a request, then dictate the rest.
let voiceBaseText = "";

if (SpeechRecognitionCtor) {
  micBtn.classList.remove("hidden");
  micBtn.addEventListener("click", toggleVoiceInput);
} else {
  micBtn.title = "Voice input isn't supported in this browser";
}

function toggleVoiceInput() {
  if (listening) {
    recognizer?.stop();
    return;
  }
  startVoiceInput();
}

function startVoiceInput() {
  if (!SpeechRecognitionCtor) return;
  voiceBaseText = taskInput.value;
  recognizer = new SpeechRecognitionCtor();
  recognizer.lang = navigator.language || "en-US";
  recognizer.continuous = true;
  recognizer.interimResults = true;

  recognizer.onstart = () => {
    listening = true;
    micBtn.classList.add("listening");
  };

  recognizer.onresult = (event) => {
    let finalText = "";
    let interimText = "";
    for (let i = 0; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interimText += result[0].transcript;
    }
    const joiner = voiceBaseText && !/\s$/.test(voiceBaseText) ? " " : "";
    taskInput.value = `${voiceBaseText}${joiner}${finalText}${interimText}`.trimStart();
    autoResize();
  };

  recognizer.onerror = (event) => {
    const messages = {
      "not-allowed":
        "Microphone access is blocked, and Chrome often doesn't even show the permission prompt inside this side panel. Open Settings (⚙) → Voice input → \"Enable microphone access\" to grant it from a regular tab instead; it'll carry over here.",
      "no-speech": "Didn't catch any speech - try again.",
      "audio-capture": "No microphone found.",
    };
    if (event.error !== "aborted") {
      addEntry("error", "Voice input", messages[event.error] || `Voice input error: ${event.error}`);
    }
  };

  recognizer.onend = () => {
    listening = false;
    micBtn.classList.remove("listening");
    // Anything left in the box once recognition stops is now the new
    // baseline, so re-starting (rather than toggling off/on) keeps appending
    // instead of duplicating text.
    voiceBaseText = taskInput.value;
  };

  recognizer.start();
}

// --- ask_user: inline forms that pause the run until answered ------------

function renderAskUserCard(event) {
  hideEmptyState();
  const div = document.createElement("div");
  div.className = "entry assistant ask-user";
  div.id = `ask-${event.id}`;

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "❓ Question";
  div.appendChild(label);

  const body = document.createElement("div");
  body.className = "body ask-user-body";

  const q = document.createElement("p");
  q.className = "ask-user-question";
  q.textContent = event.question;
  body.appendChild(q);

  const formEl = document.createElement("div");
  formEl.className = "ask-user-form";

  if (event.inputType === "text") {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ask-user-text";
    input.placeholder = "Type your answer…";
    formEl.appendChild(input);
    formEl.appendChild(makeAskUserSubmitBtn(() => submitAnswer(event.id, input.value.trim())));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitAnswer(event.id, input.value.trim());
    });
    setTimeout(() => input.focus(), 30);
  } else {
    const optsWrap = document.createElement("div");
    optsWrap.className = "ask-user-options";
    const inputName = `ask-${event.id}`;
    (event.options || []).forEach((opt) => {
      const optLabel = document.createElement("label");
      optLabel.className = "ask-user-option";
      const control = document.createElement("input");
      control.type = event.inputType === "checkbox" ? "checkbox" : "radio";
      control.name = inputName;
      control.value = opt;
      optLabel.appendChild(control);
      const span = document.createElement("span");
      span.textContent = opt;
      optLabel.appendChild(span);
      optsWrap.appendChild(optLabel);
    });
    formEl.appendChild(optsWrap);
    formEl.appendChild(
      makeAskUserSubmitBtn(() => {
        const checked = Array.from(optsWrap.querySelectorAll("input:checked")).map((el) => el.value);
        submitAnswer(event.id, event.inputType === "radio" ? checked[0] || "" : checked);
      })
    );
  }

  body.appendChild(formEl);
  div.appendChild(body);
  logEl.appendChild(div);
  scrollToBottomIfNeeded();
}

function makeAskUserSubmitBtn(onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ask-user-submit";
  btn.textContent = "Submit";
  btn.addEventListener("click", onClick);
  return btn;
}

function markAskUserAnswered(id, answer) {
  const div = document.getElementById(`ask-${id}`) || document.getElementById(`step-${id}`);
  if (!div) return;
  const formEl = div.querySelector(".ask-user-form") || div.querySelector(".step-confirm-buttons");
  if (!formEl) return;
  const answerText = Array.isArray(answer) ? (answer.length ? answer.join(", ") : "(none selected)") : answer || "(no answer)";
  formEl.innerHTML = `<div class="ask-user-answered">You answered: <strong>${escapeHtml(answerText)}</strong></div>`;
}

// --- step-through confirmation card (Visual Debugger) ----------------------
// Rendered when stepThrough mode is enabled and the agent is about to execute
// a tool call. Shows the intended tool + input and lets the user Execute,
// Skip, or Stop.

function renderStepConfirmCard(event) {
  hideEmptyState();
  const div = document.createElement("div");
  div.className = "entry assistant ask-user step-confirm";
  div.id = `step-${event.id}`;

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "🐞 Step-Through";
  div.appendChild(label);

  const body = document.createElement("div");
  body.className = "body step-confirm-body";

  const toolName = document.createElement("div");
  toolName.className = "step-confirm-tool";
  toolName.textContent = `Tool: ${event.name}`;
  body.appendChild(toolName);

  const inputPreview = document.createElement("pre");
  inputPreview.className = "step-confirm-input";
  inputPreview.textContent = JSON.stringify(event.input, null, 2);
  body.appendChild(inputPreview);

  const btnRow = document.createElement("div");
  btnRow.className = "step-confirm-buttons";

  const executeBtn = document.createElement("button");
  executeBtn.type = "button";
  executeBtn.className = "step-confirm-execute";
  executeBtn.textContent = "▶ Execute";
  executeBtn.addEventListener("click", () => submitStepThrough(event.id, "execute"));

  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "step-confirm-skip";
  skipBtn.textContent = "⏭ Skip";
  skipBtn.addEventListener("click", () => submitStepThrough(event.id, "skip"));

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "step-confirm-stop";
  stopBtn.textContent = "⏹ Stop";
  stopBtn.addEventListener("click", () => submitStepThrough(event.id, "stop"));

  btnRow.appendChild(executeBtn);
  btnRow.appendChild(skipBtn);
  btnRow.appendChild(stopBtn);
  body.appendChild(btnRow);
  div.appendChild(body);
  logEl.appendChild(div);
  scrollToBottomIfNeeded();

  // Auto-highlight the Execute button as the safe default
  executeBtn.focus();
}

function submitStepThrough(toolUseId, action) {
  const div = document.getElementById(`step-${toolUseId}`);
  if (div) {
    const btnRow = div.querySelector(".step-confirm-buttons");
    if (btnRow) {
      btnRow.innerHTML = `<div class="ask-user-answered">You chose: <strong>${action}</strong></div>`;
    }
  }
  // Reuses the ANSWER_QUESTION flow in background.js — the step-through
  // pause stores the action as the "answer" and background.js's ANSWER_QUESTION
  // handler picks it up from pendingQuestion.
  submitAnswer(toolUseId, action);
}

// --- step-limit "still working?" pause: Continue / Stop here -------------
// Same visual language as an ask_user card, but there's no toolUseId to key
// off (this is a system pause, not a model tool call) — keyed by node id
// instead, which is unique per pause since only one can be pending at a time.

function renderConfirmContinueCard(event, nodeId) {
  hideEmptyState();
  const div = document.createElement("div");
  div.className = "entry assistant ask-user";
  div.id = `steplimit-${nodeId}`;

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "⏱️ Still working";
  div.appendChild(label);

  const body = document.createElement("div");
  body.className = "body ask-user-body";

  const q = document.createElement("p");
  q.className = "ask-user-question";
  q.textContent = `I've used ${event.stepsUsed || "a lot of"} steps on this without finishing - want me to keep going? I'll stop on my own if I don't hear back within 10 minutes.`;
  body.appendChild(q);

  const formEl = document.createElement("div");
  formEl.className = "ask-user-form";

  const btnRow = document.createElement("div");
  btnRow.className = "step-limit-actions";

  const stopBtn2 = document.createElement("button");
  stopBtn2.type = "button";
  stopBtn2.className = "step-limit-stop";
  stopBtn2.textContent = "Stop here";
  stopBtn2.addEventListener("click", () => respondToStepLimit(nodeId, false));
  btnRow.appendChild(stopBtn2);

  const continueBtn = document.createElement("button");
  continueBtn.type = "button";
  continueBtn.className = "ask-user-submit";
  continueBtn.textContent = "Continue";
  continueBtn.addEventListener("click", () => respondToStepLimit(nodeId, true));
  btnRow.appendChild(continueBtn);

  formEl.appendChild(btnRow);
  body.appendChild(formEl);
  div.appendChild(body);
  logEl.appendChild(div);
  scrollToBottomIfNeeded();
}

function markConfirmContinueResolved(nodeId, didContinue, timedOut) {
  const div = document.getElementById(`steplimit-${nodeId}`);
  if (!div) return;
  const formEl = div.querySelector(".ask-user-form");
  if (!formEl) return;
  const text = timedOut ? "Stopped automatically - no response within 10 minutes." : didContinue ? "Continuing…" : "Stopped here.";
  formEl.innerHTML = `<div class="ask-user-answered">${escapeHtml(text)}</div>`;
}

async function respondToStepLimit(nodeId, doContinue) {
  markConfirmContinueResolved(nodeId, doContinue, false);
  if (doContinue) {
    autoScroll = true;
    activeRunNodeId = nodeId;
    setRunning(true);
    showStatus("Thinking", true);
    showTypingBubble();
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [providerId, modelId] = (modelSelect.value || "").split("::");
  chrome.runtime.sendMessage({
    type: "STEP_LIMIT_RESPONSE",
    sessionId: currentSessionId,
    nodeId,
    continue: doContinue,
    tabId: tab?.id,
    providerId: providerId || undefined,
    modelId: modelId || undefined,
    agentId: activeAgent?.id || undefined,
  });
}

// --- site-category confirm-gate: adult / financial sites -----------------
// Same visual pattern as the step-limit card — a system pause, not a model
// tool call — keyed by node id. Deliberately NOT a hard block: approving
// once remembers the domain (see Settings → Site access) so it's a one-time
// ask per site, not a recurring interruption.

function renderConfirmSiteCategoryCard(event, nodeId) {
  hideEmptyState();
  const div = document.createElement("div");
  div.className = "entry assistant ask-user";
  div.id = `sitegate-${nodeId}`;

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = event.category === "adult" ? "🔞 Adult content site" : "🏦 Financial site";
  div.appendChild(label);

  const body = document.createElement("div");
  body.className = "body ask-user-body";

  const q = document.createElement("p");
  q.className = "ask-user-question";
  q.textContent =
    event.category === "adult"
      ? `${event.hostname} looks like an adult-content site. Confirm you're of legal age and want Tab Agent to operate here - this is remembered for this domain, so you won't be asked again.`
      : `${event.hostname} looks like a financial services site. Confirm you want Tab Agent to operate here - this is remembered for this domain, so you won't be asked again.`;
  body.appendChild(q);

  const formEl = document.createElement("div");
  formEl.className = "ask-user-form";

  const btnRow = document.createElement("div");
  btnRow.className = "step-limit-actions";

  const stopBtn2 = document.createElement("button");
  stopBtn2.type = "button";
  stopBtn2.className = "step-limit-stop";
  stopBtn2.textContent = "Stop here";
  stopBtn2.addEventListener("click", () => respondToSiteGate(nodeId, false));
  btnRow.appendChild(stopBtn2);

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "ask-user-submit";
  approveBtn.textContent = "Confirm & continue";
  approveBtn.addEventListener("click", () => respondToSiteGate(nodeId, true));
  btnRow.appendChild(approveBtn);

  formEl.appendChild(btnRow);
  body.appendChild(formEl);
  div.appendChild(body);
  logEl.appendChild(div);
  scrollToBottomIfNeeded();
}

function markSiteGateResolved(nodeId, approved) {
  const div = document.getElementById(`sitegate-${nodeId}`);
  if (!div) return;
  const formEl = div.querySelector(".ask-user-form");
  if (!formEl) return;
  formEl.innerHTML = `<div class="ask-user-answered">${approved ? "Confirmed - continuing…" : "Stopped."}</div>`;
}

async function respondToSiteGate(nodeId, approve) {
  markSiteGateResolved(nodeId, approve);
  if (approve) {
    autoScroll = true;
    activeRunNodeId = nodeId;
    setRunning(true);
    showStatus("Thinking", true);
    showTypingBubble();
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [providerId, modelId] = (modelSelect.value || "").split("::");
  chrome.runtime.sendMessage({
    type: "SITE_GATE_RESPONSE",
    sessionId: currentSessionId,
    nodeId,
    approve,
    tabId: tab?.id,
    providerId: providerId || undefined,
    modelId: modelId || undefined,
    agentId: activeAgent?.id || undefined,
  });
}

async function submitAnswer(toolUseId, answer) {
  markAskUserAnswered(toolUseId, answer);
  autoScroll = true;
  // The node id isn't known client-side here (only the tool_use id it
  // answers) — null tells the AGENT_EVENT listener to lock onto whichever
  // node the very next event for this session belongs to.
  activeRunNodeId = null;
  setRunning(true);
  showStatus("Thinking", true);
  showTypingBubble();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [providerId, modelId] = (modelSelect.value || "").split("::");
  chrome.runtime.sendMessage({
    type: "ANSWER_QUESTION",
    sessionId: currentSessionId,
    toolUseId,
    answer,
    tabId: tab?.id,
    providerId: providerId || undefined,
    modelId: modelId || undefined,
    agentId: activeAgent?.id || undefined,
    stepThrough: stepThroughEnabled,
  });
}

// --- run state -----------------------------------------------------

function setRunning(state) {
  running = state;
  taskInput.disabled = state;
  attachBtn.disabled = state;
  micBtn.disabled = state;
  runBtn.classList.toggle("hidden", state);
  runBtn.disabled = state;
  stopBtn.classList.toggle("hidden", !state);
  setProgressActive(state);
  if (state) {
    lastRunEventAt = Date.now();
  } else {
    hideStatus();
    removeTypingBubble();
  }
}

// Resets the UI back to normal and tells the user their run appears to have
// died, without requiring them to have clicked anything — shared by
// stopCurrentRun's orphan-detection fallback below and the watchdog further
// down, which are two different ways of noticing the same situation: either
// you clicked Stop and got no reply, or nothing happened for a long time and
// you never clicked anything at all. nodeId guards against a stray call
// landing on a DIFFERENT, legitimately-still-running task (e.g. one that
// started after this check was scheduled).
function declareRunStalled(nodeId, reason) {
  if (!running || activeRunNodeId !== nodeId) return;
  setRunning(false);
  addEntry(
    "error",
    "Error",
    `This run stopped responding${reason ? ` (${reason})` : ""} and couldn't continue. Nothing is lost - your chat history is saved - but you'll need to send the task again.`
  );
}

// Sends STOP_TASK and, if the background reports no matching run, treats
// that as a possibly orphaned run rather than leaving the UI stuck on
// "Stopping…" forever. "No matching run" has two very different causes that
// look identical from here: (1) harmless — the run finished normally in the
// same instant we clicked, and its own AGENT_DONE/AGENT_PAUSED broadcast is
// already on its way to reset the UI correctly, or (2) the service worker
// that was actually driving this run got torn down and restarted (Chrome
// enforces a hard cap on how long one can run at all, independent of the
// keep-alive ping/chrome.power that only reduce how often this happens, not
// eliminate it — see background.js) — which wipes its in-memory activeRuns
// entry along with everything it was doing, so there's nothing left to
// receive the stop flag or ever broadcast another event. Waiting a beat lets
// case (1) resolve itself (a same-machine runtime message arrives near-
// instantly) before deciding it's actually case (2) and forcing the UI back
// to normal with an explanation instead of hanging silently.
function stopCurrentRun() {
  showStatus("Stopping…");
  const stoppedNodeId = activeRunNodeId;
  chrome.runtime.sendMessage({ type: "STOP_TASK", sessionId: currentSessionId }, (res) => {
    if (chrome.runtime.lastError) return; // panel closed/reloaded mid-call — nothing to update
    if (res && res.stopped) return;
    setTimeout(() => {
      declareRunStalled(stoppedNodeId, "the browser likely paused the extension in the background during a long task");
    }, 1500);
  });
}

// Watchdog: catches a stalled run even when nobody clicks Stop at all — the
// same underlying causes (service worker torn down/throttled, a stream that
// silently stopped receiving data, the OS deprioritizing background work
// while the screen was locked/asleep — see background.js and lib/
// providers.js) can just as easily happen while you've stepped away from a
// long task as while you're watching it. lastRunEventAt is bumped by
// setRunning(true) and by every run-related broadcast (see the
// chrome.runtime.onMessage listener below); if a run is still marked active
// but nothing has come in for RUN_STALL_THRESHOLD_MS, it's not a fast local
// message anymore — the run is almost certainly dead. RUN_STALL_THRESHOLD_MS
// is deliberately generous (well beyond any single legitimate step's normal
// latency) to avoid a false alarm on a genuinely slow but healthy step.
let lastRunEventAt = 0;
const RUN_WATCHDOG_INTERVAL_MS = 15000;
const RUN_STALL_THRESHOLD_MS = 60000;
setInterval(() => {
  if (!running || Date.now() - lastRunEventAt < RUN_STALL_THRESHOLD_MS) return;
  declareRunStalled(activeRunNodeId, "nothing happened for over a minute - possibly the screen locked/slept, or the browser paused the extension in the background");
}, RUN_WATCHDOG_INTERVAL_MS);

// --- built-in command execution --------------------------------------

function runBuiltinCommand(slug, arg) {
  switch (slug) {
    case "clear":
      clearCurrentSession();
      break;
    case "stop":
      if (running) {
        stopCurrentRun();
      } else {
        addEntry("info", "Info", "Nothing is running right now.");
      }
      break;
    case "retry":
      retryLastMessage();
      break;
    case "compact":
      compactCurrentSession();
      break;
    case "model":
      selectModelByName(arg);
      break;
    case "help":
      showHelp();
      break;
    default:
      break;
  }
}

async function retryLastMessage() {
  if (running) {
    addEntry("info", "Info", "Wait for the current run to finish (or /stop it) before retrying.");
    return;
  }
  if (!currentSessionId) {
    addEntry("info", "Info", "No conversation to retry yet.");
    return;
  }
  const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
  const raw = sessions.find((s) => s.id === currentSessionId);
  if (!raw) {
    addEntry("info", "Info", "No conversation to retry yet.");
    return;
  }
  const session = migrateSessionIfNeeded(raw);
  const path = computeActivePath(session);
  const lastNode = path[path.length - 1];
  if (!lastNode) {
    addEntry("info", "Info", "No conversation to retry yet.");
    return;
  }
  // Reuses the exact same branch-and-resend mechanism as clicking ✎ on a
  // message — a retry is just "edit the last message with the same text".
  startEditingNode(lastNode);
  await sendTask();
}

// --- /compact: summarize this chat's context to save tokens --------------

const AUTO_COMPACT_TOKEN_THRESHOLD = 250000;

// sendMessage's own callback fires as soon as background.js acknowledges
// receipt (it kicks off the actual work in a detached async IIFE) — NOT once
// compaction has actually finished rewriting the session. Waiting on the
// SESSION_COMPACTED broadcast (sent only when the real work completes)
// avoids sending the next task against stale, pre-compaction history.
function waitForCompaction(sessionId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.runtime.onMessage.removeListener(listener);
      resolve();
    };
    const listener = (msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.type === "SESSION_COMPACTED") finish();
      else if (msg.type === "AGENT_EVENT" && msg.event?.type === "error") finish();
    };
    chrome.runtime.onMessage.addListener(listener);
    setTimeout(finish, timeoutMs); // don't block sending forever if something goes wrong
  });
}

async function compactCurrentSession() {
  if (running) {
    addEntry("info", "Info", "Wait for the current run to finish before compacting.");
    return;
  }
  if (!currentSessionId) {
    addEntry("info", "Info", "No conversation to compact yet.");
    return;
  }
  const [providerId, modelId] = (modelSelect.value || "").split("::");
  const sessionIdAtStart = currentSessionId;
  showStatus("Compacting…", true);
  chrome.runtime.sendMessage({
    type: "COMPACT_SESSION",
    sessionId: sessionIdAtStart,
    providerId: providerId || undefined,
    modelId: modelId || undefined,
  });
  await waitForCompaction(sessionIdAtStart);
  if (currentSessionId !== sessionIdAtStart) {
    hideStatus();
    return;
  }
  hideStatus();
}

// Checked at the top of every send — keeps a long-running chat's per-message
// cost from creeping up unbounded. Compaction itself shows its own "📦
// Compacted…" info line once it lands, via the SESSION_COMPACTED listener
// below triggering a storage refresh.
async function maybeAutoCompact() {
  if (!currentSessionId) return;
  const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
  const raw = sessions.find((s) => s.id === currentSessionId);
  if (!raw) return;
  const session = migrateSessionIfNeeded(raw);
  // The active leaf's own usage IS the active context size — each request is
  // stateless and resends the full history, so its inputTokens already
  // reflects everything accumulated so far on this path. Summing node.usage
  // across every node in session.nodes (the old behavior) instead added up
  // lifetime billed tokens across the whole tree, including dead retry/edit
  // branches never even sent again - a number that only ever grows and has
  // nothing to do with how large the next request's context actually is.
  const path = computeActivePath(session);
  const lastNode = path[path.length - 1];
  const active = lastNode?.usage ? (lastNode.usage.inputTokens || 0) + (lastNode.usage.outputTokens || 0) : 0;
  if (active <= AUTO_COMPACT_TOKEN_THRESHOLD) return;
  addEntry("info", "Info", `This chat has grown large (~${Math.round(active / 1000)}k tokens) - compacting automatically before sending to keep costs down.`);
  await compactCurrentSession();
}

function selectModelByName(query) {
  if (!query) {
    addEntry("info", "Info", "Usage: /model <name> - e.g. /model gpt-4.1 or /model claude");
    return;
  }
  const q = query.toLowerCase();
  const options = Array.from(modelSelect.options);
  const match = options.find((o) => o.textContent.toLowerCase().includes(q)) || options.find((o) => o.value.toLowerCase().includes(q));
  if (!match) {
    addEntry("info", "Info", `No enabled model matches "${query}". Check Settings (⚙) for your enabled models.`);
    return;
  }
  modelSelect.value = match.value;
  const [providerId, modelId] = match.value.split("::");
  chrome.storage.local.set({ activeProviderId: providerId, activeModelId: modelId });
  addEntry("info", "Info", `Switched model to ${match.textContent}.`);
}

function showHelp() {
  const cmdLines = BUILTIN_COMMANDS.map((c) => `- \`/${c.slug}\` - ${c.description}`).join("\n");
  const agentLines = agents.length
    ? agents.map((a) => `- \`@${a.slug}\` - ${a.description || a.name}`).join("\n")
    : "_No agents configured yet - add some in Settings (⚙)._";
  const shortcutLines = [
    "- `Enter` - send · `Shift+Enter` - new line",
    "- `Ctrl/Cmd+K` - new chat",
    "- `Ctrl/Cmd+Shift+H` - toggle history",
    "- `Ctrl/Cmd+/` - this help",
    "- `Esc` - stop the current run (or close a panel)",
    "- `Ctrl/Cmd+Shift+Y` (global) - open Tab Agent from any tab",
    "- `Ctrl/Cmd+Shift+U` (global) - open Tab Agent and start a new chat",
  ].join("\n");
  const text = `**Commands**\n${cmdLines}\n\n**Agents**\n${agentLines}\n\n**Keyboard shortcuts**\n${shortcutLines}`;
  addEntry("assistant", "Help", text, true);
}

// --- send / stop -----------------------------------------------------

async function sendTask() {
  if (running) return;
  hidePopover();

  // Sending stops any in-progress dictation right away — abort() (not
  // stop()) so the recognizer discards whatever it was still processing
  // instead of flushing one more final result into the box a moment after
  // it's been cleared, which is what caused voice input to "keep hearing"
  // into the next message.
  if (listening) recognizer?.abort();

  let task = taskInput.value.trim();
  if (!task && attachments.length === 0) return;

  // Built-in commands (/clear, /stop, /retry, /compact, /model, /help) never
  // get sent to the model — intercept them here whether typed via the
  // popover or the whole command at once (e.g. "/model gpt-4.1").
  const builtinMatch = task.match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
  if (builtinMatch && BUILTIN_COMMANDS.some((c) => c.slug === builtinMatch[1].toLowerCase())) {
    const slug = builtinMatch[1].toLowerCase();
    const arg = (builtinMatch[2] || "").trim();
    taskInput.value = "";
    autoResize();
    runBuiltinCommand(slug, arg);
    return;
  }

  // Typed the whole command directly (e.g. "@research_agent find X") without
  // using the popover — pick it up here and make it sticky going forward.
  if (!activeAgent && task) {
    const direct = extractDirectAgentCommand(task);
    if (direct) {
      setActiveAgent(direct.agent);
      task = direct.remainder.trim();
    }
  }

  await maybeAutoCompact();

  const imageAttachments = attachments.filter((a) => a.kind !== "pdf" && a.kind !== "doc");
  const docAttachments = attachments.filter((a) => a.kind === "pdf" || a.kind === "doc");

  // The user's chat bubble stays exactly what they typed — the extracted
  // text rides separately to the background page, which appends it (chunked,
  // see lib/attachmentCache.js — nothing is trimmed) to what the MODEL sees
  // (same "shown to user" vs "sent to model" split already used for the
  // tab-switch note and the vision-fallback image description).
  const effectiveTask = task || "Describe / act on the attached file(s).";
  const outgoingDocAttachments = docAttachments.map((a) => ({
    id: a.id,
    name: a.name,
    format: a.format,
    text: a.text,
    pageCount: a.pageCount,
  }));

  const previewUrls = imageAttachments.map((a) => a.previewUrl);
  const outgoingAttachments = imageAttachments.map((a) => ({ mediaType: a.mediaType, data: a.data, name: a.name }));
  const docPreviews = docAttachments.map((a) => ({ kind: a.kind, format: a.format, name: a.name, pageCount: a.pageCount }));

  const editNodeId = editingNodeId;
  editingNodeId = null;
  editBanner.classList.add("hidden");

  addEntry("user", "", effectiveTask, false, [...previewUrls, ...docPreviews]);

  taskInput.value = "";
  autoResize();
  attachments = [];
  renderAttachments();

  autoScroll = true; // resume auto-follow for this new run
  // The new (or branched-to) node's id is generated server-side and not
  // known yet here — null tells the AGENT_EVENT listener to lock onto
  // whichever node the first event for this session belongs to, instead of
  // still accepting stray events tagged with a PREVIOUS/abandoned node id
  // (e.g. a sibling branch this edit just replaced, or an earlier run that
  // hadn't fully finished stopping yet).
  activeRunNodeId = null;
  setRunning(true);
  showStatus("Thinking", true);
  showTypingBubble();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [providerId, modelId] = (modelSelect.value || "").split("::");
  chrome.runtime.sendMessage({
    type: "RUN_TASK",
    task: effectiveTask,
    tabId: tab?.id,
    sessionId: currentSessionId || undefined,
    editNodeId: editNodeId || undefined,
    providerId: providerId || undefined,
    modelId: modelId || undefined,
    agentId: activeAgent?.id || undefined,
    stepThrough: stepThroughEnabled,
    attachments: outgoingAttachments,
    docAttachments: outgoingDocAttachments,
  });
}

// --- replay overlay -----------------------------------------------------
const replayOverlay = document.getElementById("replayOverlay");
const replayTitle = document.getElementById("replayTitle");
const replayClose = document.getElementById("replayClose");
const replayStrip = document.getElementById("replayStrip");
const replayScreenshot = document.createElement("div");
replayScreenshot.id = "replayScreenshot";

async function openReplay(sessionId) {
  // Fetch the recording frames from the background
  let frames;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_RECORDING", sessionId });
    if (!resp?.ok || !resp.frames?.length) {
      addEntry("error", "Replay", "No recording found for this session.");
      return;
    }
    frames = resp.frames;
  } catch {
    addEntry("error", "Replay", "Could not load recording.");
    return;
  }

  replayStrip.innerHTML = "";

  function renderFrame(idx) {
    const frame = frames[idx];
    if (!frame) return;
    replayScreenshot.innerHTML = "";
    if (frame.screenshot) {
      const img = document.createElement("img");
      img.src = frame.screenshot;
      img.alt = `${frame.toolName} step ${frame.step}`;
      replayScreenshot.appendChild(img);
    } else {
      replayScreenshot.innerHTML = "<p class='replay-no-capture'>(This step ran in a background tab — no screenshot available.)</p>";
    }
    // Highlight the active thumbnail
    Array.from(replayStrip.children).forEach((el, i) => el.classList.toggle("active", i === idx));
    // Scroll it into view
    const active = replayStrip.children[idx];
    if (active) active.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });

    // Step detail panel
    const infoEl = document.getElementById("replayInfo");
    if (infoEl) infoEl.innerHTML = formatReplayInfo(frame);
  }

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const thumb = document.createElement("button");
    thumb.className = "replay-thumb";
    if (f.screenshot) {
      const img = document.createElement("img");
      img.src = f.screenshot;
      img.alt = `Step ${f.step}`;
      thumb.appendChild(img);
    } else {
      thumb.innerHTML =
        `<span class="replay-thumb-placeholder">${toolIcon(f.toolName)}</span>`;
    }
    const label = document.createElement("span");
    label.className = "replay-thumb-label";
    label.textContent = toolLabel(f.toolName).slice(0, 16);
    thumb.appendChild(label);
    thumb.addEventListener("click", () => renderFrame(i));
    replayStrip.appendChild(thumb);
  }

  const infoHtml = document.getElementById("replayInfo");
  if (!infoHtml) {
    // First time — build the info panel
    const info = document.createElement("div");
    info.id = "replayInfo";
    info.className = "replay-info";
    replayScreenshot.after(info);
  }
  replayTitle.textContent = `${frames.length} step${frames.length !== 1 ? "s" : ""}`;
  replayOverlay.classList.remove("hidden");
  renderFrame(0);
}

replayClose.addEventListener("click", () => replayOverlay.classList.add("hidden"));

function formatReplayInfo(frame) {
  const lines = [
    `<div class="replay-info-row"><strong>Tool:</strong> ${toolLabel(frame.toolName)}</div>`,
  ];
  if (frame.url) {
    const short = frame.url.length > 60 ? frame.url.slice(0, 57) + "…" : frame.url;
    lines.push(`<div class="replay-info-row"><strong>URL:</strong> ${escapeHtml(short)}</div>`);
  }
  if (frame.callId) {
    lines.push(`<div class="replay-info-row"><strong>Call ID:</strong> <code>${escapeHtml(frame.callId)}</code></div>`);
  }
  if (frame.toolInput && Object.keys(frame.toolInput).length) {
    const inp = JSON.stringify(frame.toolInput, null, 2);
    lines.push(`<div class="replay-info-row"><strong>Input:</strong></div><pre class="replay-info-pre">${escapeHtml(inp)}</pre>`);
  }
  if (frame.toolResult) {
    const label = frame.toolResult.ok ? "✅ Success" : `❌ Error: ${escapeHtml(frame.toolResult.error || "unknown")}`;
    lines.push(`<div class="replay-info-row">${label}</div>`);
  }
  return lines.join("\n");
}

runBtn.addEventListener("click", sendTask);

stopBtn.addEventListener("click", stopCurrentRun);

const stepThroughToggle = document.getElementById("stepThroughToggle");
stepThroughToggle.addEventListener("click", () => {
  stepThroughEnabled = !stepThroughEnabled;
  stepThroughToggle.classList.toggle("active", stepThroughEnabled);
  stepThroughToggle.title = stepThroughEnabled
    ? "Step-through mode ON — the agent will pause before each tool call"
    : "Step-through mode: pause before each tool call";
});

// --- agent events (shared between live updates and history replay) ------

function applyAgentEvent(event, isReplay = false, nodeId = null) {
  switch (event.type) {
    case "user_message":
      addEntry("user", "", event.text, false, event.attachmentPreviews || []);
      break;

    case "thinking":
      removeTypingBubble();
      showTypingBubble();
      if (!isReplay) showStatus("Thinking", true);
      break;

    case "assistant_delta":
      if (event.reset) resetStreamingText();
      else updateStreamingText(event.text);
      break;

    case "assistant": {
      removeTypingBubble();
      if (!isReplay) hideStatus();
      // If this same turn also calls finish, its answer is the authoritative
      // final message and is about to render its own bubble right after this
      // one — showing the model's prose here too would just duplicate it
      // (models often narrate a full summary AND pass a full summary as the
      // finish answer). Skip the intermediate text bubble in that case.
      const callsFinish = (event.toolCalls || []).some((c) => c.name === "finish");
      if (event.text && !callsFinish) addEntry("assistant", "Tab Agent", event.text, true);
      for (const call of event.toolCalls || []) {
        if (call.name === "finish" || call.name === "ask_user") continue;
        // parallel_investigate/run_batch get their own dedicated live status
        // card (see investigate_start/batch_start below) instead of the
        // generic one-line tool card every other tool uses — a granular
        // tool-call transcript is the wrong shape for "several things
        // happening at once" or "hundreds of repeated steps".
        if (call.name === "parallel_investigate" || call.name === "run_batch") continue;
        addPendingTool(call.id, call.name, call.input);
      }
      break;
    }

    case "tool_start":
      if (!isReplay) showStatus(toolLabel(event.name), true);
      break;

    case "tool_result":
      if (event.name !== "parallel_investigate" && event.name !== "run_batch") {
        updateToolEntry(event.id, event.name, event.result, event.input);
      }
      break;

    // --- parallel_investigate / run_batch live status cards ---------------
    // These are broadcast-only during a live run (not persisted/replayed —
    // see persistAgentEvent in background.js), so isReplay is never true
    // for them; the card is a live progress view, not part of the durable
    // transcript. The underlying tool_result (handled above) still carries
    // the final structured data for history/replay purposes.

    case "investigate_start":
      addInvestigateCard(event.callId, event.branches, event.remainingCount || 0, nodeId);
      break;

    case "branch_active":
      handleBranchActive(event);
      break;

    case "branch_step":
      handleBranchStep(event);
      break;

    case "branch_done":
      handleBranchDone(event, isReplay);
      break;

    case "branch_closed":
      handleBranchClosed(event);
      break;

    case "batch_start":
      addBatchCard(event.callId, event.maxSteps);
      break;

    case "batch_step":
      handleBatchStep(event);
      break;

    case "batch_done":
      handleBatchDone(event, isReplay);
      break;

    case "error":
      removeTypingBubble();
      if (!isReplay) hideStatus();
      addEntry("error", "Error", event.message);
      break;

    case "stopped":
      removeTypingBubble();
      if (!isReplay) hideStatus();
      addEntry("stopped", "Stopped", "Run stopped by user.");
      break;

    case "finish":
      removeTypingBubble();
      if (!isReplay) hideStatus();
      addEntry("final", event.success ? "Done" : "Ended", event.answer, true);
      break;

    case "ask_user":
      removeTypingBubble();
      if (!isReplay) hideStatus();
      renderAskUserCard(event);
      break;

    case "step_confirm":
      removeTypingBubble();
      if (!isReplay) hideStatus();
      renderStepConfirmCard(event);
      break;

    case "answered":
      markAskUserAnswered(event.id, event.answer);
      break;

    case "confirm_continue":
      removeTypingBubble();
      if (!isReplay) hideStatus();
      renderConfirmContinueCard(event, nodeId);
      break;

    case "continue_resolved":
      markConfirmContinueResolved(nodeId, event.continue, event.timedOut);
      break;

    case "confirm_site_category":
      removeTypingBubble();
      if (!isReplay) hideStatus();
      renderConfirmSiteCategoryCard(event, nodeId);
      break;

    case "site_gate_resolved":
      markSiteGateResolved(nodeId, event.approved);
      break;

    case "info":
      addEntry("info", "Info", event.message);
      break;

    case "done":
      removeTypingBubble();
      if (!event.alreadyShown) {
        addEntry(event.success ? "final" : "error", event.success ? "Done" : "Result", event.finalAnswer, true);
      }
      break;

    default:
      break;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  const isRunMessage = msg.type === "AGENT_EVENT" || msg.type === "AGENT_PAUSED" || msg.type === "AGENT_DONE";

  if (isRunMessage) {
    // Ignore broadcasts for a different chat entirely — e.g. a scheduled
    // check running headlessly in its own tab. Only enforced once a session
    // is actually loaded; a brand-new, not-yet-saved chat has
    // currentSessionId === null and accepts its first event to learn its id.
    if (currentSessionId && msg.sessionId && msg.sessionId !== currentSessionId) return;

    // Lock onto whichever node the current run belongs to (set explicitly
    // by whichever function just resumed a known node, or null-latched onto
    // the first event seen after starting/branching a new one — see every
    // send site above that touches activeRunNodeId) and ignore anything
    // tagged with a different node id. Without this, a stray broadcast from
    // an abandoned run — a sibling branch you just edited away from, or a
    // step-limit pause that times out on its own 10 minutes later — would
    // get appended into whatever branch is currently on screen, which is
    // exactly what made an unrelated run's step numbers appear to "carry
    // over" into a freshly started branch.
    if (msg.nodeId) {
      if (activeRunNodeId === null) activeRunNodeId = msg.nodeId;
      else if (msg.nodeId !== activeRunNodeId) return;
    }

    // Any message that made it past the filters above is a genuine sign of
    // life for the run this panel is currently tracking — see the watchdog
    // near setRunning/stopCurrentRun, which declares a run stalled once too
    // long passes without this being touched.
    lastRunEventAt = Date.now();

    // Only a run message gets to ADOPT a new currentSessionId (the "learn
    // my own id" case for a brand-new chat above). A message type like
    // SESSION_COMPACTED below carries its own sessionId too, but must never
    // reach this — otherwise a compact finishing for a chat the user has
    // since navigated away from would silently overwrite currentSessionId
    // to match it, which then makes that type's OWN "is this my chat?"
    // check further down trivially true and yanks the view back to it.
    // Similarly, SESSION_COMPACTED is not a run message and must not adopt.
    if (msg.sessionId && msg.type !== "SESSION_COMPACTED") currentSessionId = msg.sessionId;
  }

  if (msg.type === "AGENT_EVENT") {
    applyAgentEvent(msg.event, false, msg.nodeId);
  }

  if (msg.type === "AGENT_PAUSED") {
    // Run is waiting on an ask_user answer — not "done", just idle for now.
    setRunning(false);
    // Authoritative re-render from storage: picks up the edit button and any
    // sibling switcher for the message that was just generated.
    refreshCurrentSessionView();
  }

  if (msg.type === "AGENT_DONE") {
    applyAgentEvent({ type: "done", success: msg.success, finalAnswer: msg.finalAnswer, alreadyShown: msg.alreadyShown === true }, false);
    setRunning(false);
    refreshCurrentSessionView();
  }

  if (msg.type === "SESSION_COMPACTED" && msg.sessionId === currentSessionId) {
    refreshCurrentSessionView();
  }

  // Fired by background.js's chrome.commands listener when the user presses
  // the global "new chat" keyboard shortcut (manifest.json "commands") —
  // works even if this was the message that just opened the panel.
  if (msg.type === "NEW_CHAT_SHORTCUT") {
    startNewChat();
  }

  // Sent by background.js's OPEN_SCHEDULED_TASK_MANUAL handler right after
  // it opens this panel — see applyScheduledTaskPrefill above. Clear the
  // storage fallback now that the live message actually landed, so a later
  // panel reload doesn't re-apply the same stale prefill.
  if (msg.type === "QUEUE_BROADCAST") {
    if (msg.depth > 0) {
      queueBadge.textContent = msg.depth;
      queueBadge.classList.remove("hidden");
    } else {
      queueBadge.classList.add("hidden");
    }
  }

  if (msg.type === "PREFILL_SCHEDULED_TASK") {
    applyScheduledTaskPrefill(msg);
    chrome.storage.local.remove("pendingScheduledTaskPrefill").catch(() => {});
  }
});
