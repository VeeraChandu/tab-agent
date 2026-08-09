// background.js — MV3 service worker
// Routes messages between the side panel UI and the agent loop, which in
// turn drives the content script on the active tab. Nothing here talks to
// any local server or MCP process — the model API is called directly.
//
// Sessions are stored as a TREE of nodes, not a flat list: each node is one
// user message plus everything the agent did in response. Editing a past
// message creates a new sibling node under that message's parent, so the
// old branch stays intact and reachable while the new one becomes active —
// like ChatGPT's "edit and regenerate" behavior.

import { runAgentTask, resumeBranch } from "./lib/agentLoop.js";
import { describeImage, summarizeHistory } from "./lib/providers.js";
import { looksVisionCapable } from "./lib/vision.js";
import { startMediaSniffer } from "./lib/mediaSniffer.js";
import { startNavErrorTracking } from "./lib/navErrors.js";
import { deleteCacheForSession, DEFAULT_MAX_ENTRIES as PAGE_CACHE_DEFAULT_MAX_ENTRIES } from "./lib/pageCache.js";
import { recordAttachment, deleteCacheForSession as deleteAttachmentCacheForSession } from "./lib/attachmentCache.js";

// Must run synchronously at service worker load, not inside any later async
// callback — MV3 only allows event listeners (webRequest/webNavigation/tabs)
// to be registered during the worker's initial evaluation.
startMediaSniffer();
startNavErrorTracking();

const MAX_SESSIONS = 30;

// No agents ship pre-installed — Settings → Agents starts empty, and every
// agent a user sees there is one they created themselves.
chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  const { agents } = await chrome.storage.local.get(["agents"]);
  if (!agents) {
    await chrome.storage.local.set({ agents: [] });
  }
});

// Global keyboard shortcuts (manifest.json "commands") — these fire even
// when the side panel isn't the focused surface (or isn't open at all),
// unlike the panel-local shortcuts handled inside sidepanel.js. Opening the
// panel from a command handler is a direct response to the user's key press,
// which Chrome treats as a valid user gesture for chrome.sidePanel.open.
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.windowId) return;

  if (command === "open-panel") {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  } else if (command === "new-chat") {
    await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    // Best-effort — if the panel just opened for the first time it may not
    // have a listener registered yet to catch this, but if it was already
    // open (the common case for a "new chat" shortcut) it works instantly.
    chrome.runtime.sendMessage({ type: "NEW_CHAT_SHORTCUT" }).catch(() => {});
  }
});

// Per-session run state, keyed by session.id — NOT a single global. Chrome
// can have this side panel open in more than one window at once (each gets
// its own sidepanel.js instance talking to this one shared service worker),
// and RESUME_BRANCH can also run concurrently alongside a fresh chat. A
// single shared object here would let one window's Stop button abort a
// different window's run, and would let one run's completion (drive()'s
// cleanup) wipe out tracking for another run still in progress.
// skipSubtasks is the scoped "skip remaining sub-tasks, keep the
// conversation going" flag from the investigate/batch card's own skip
// button — distinct from stop (which aborts the whole run). It's reset at
// the start of every parallel_investigate/run_batch call (see
// lib/agentLoop.js's resetSkipSubtasks) so a stale click can't bleed into
// a later, unrelated call within the same run.
const activeRuns = new Map(); // sessionId -> { stop: boolean, skipSubtasks: boolean }

// MV3 kills this service worker after ~30s with no chrome.* API call — but
// the agent loop's actual work (an LLM call streamed over plain fetch/SSE,
// see lib/providers.js) doesn't touch chrome.* APIs at all while it's in
// flight, so a single slow/complex model turn can silently outlast that
// window and get the worker torn down mid-request with no error, killing
// whatever was in flight (including the in-memory Stop-button check). This
// is a lightweight reference-counted keep-alive: as long as at least one
// interactive run (drive()/RESUME_BRANCH) or scheduled task run is in
// progress, a trivial chrome.* call fires every 20s (safely under the 30s
// threshold, and higher-frequency than chrome.alarms' 30s minimum interval
// allows) purely to keep resetting Chrome's idle timer — the call itself
// does nothing. Reference-counted rather than boolean so two runs (e.g. a
// side panel task and a scheduled check) overlapping doesn't have the first
// one to finish stop the ping the other one still needs.
//
// Same lifetime also covers chrome.power.requestKeepAwake: an OS-level idle
// timeout locking the screen or sleeping the system mid-run risks the exact
// same class of problem this ping guards against — a locked/sleeping screen
// is a strong "inactive" signal Chrome and the OS use to throttle timers and
// network sockets in the background, which can silently stall the very
// things (this keep-alive ping, the model's streamed response) that would
// otherwise keep the run healthy. requestKeepAwake("system") only prevents
// the AUTOMATIC, idle-driven lock/sleep — it can't and shouldn't override
// the user deliberately locking their screen themselves, so this reduces how
// often a long run gets caught out by this, not a guarantee it never does.
let activeRunRefCount = 0;
let keepAliveTimer = null;
function beginKeepAlive() {
  activeRunRefCount += 1;
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    chrome.power.requestKeepAwake("system");
  }
}
function endKeepAlive() {
  activeRunRefCount = Math.max(0, activeRunRefCount - 1);
  if (activeRunRefCount === 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    chrome.power.releaseKeepAwake();
  }
}

// STOP_TASK/SKIP_SUBTASKS should target the run the message's own panel is
// looking at — but a brand-new, not-yet-saved chat's session id is minted
// inside RUN_TASK below and only reaches sidepanel.js once the first event
// broadcasts it back, so there's a narrow window where the panel doesn't
// know its own session id yet and sends the message without one. Falling
// back to "the only run currently active" (rather than doing nothing)
// preserves that case working, while still scoping correctly whenever two
// runs really are active at once.
function findRunState(sessionId) {
  if (sessionId) return activeRuns.get(sessionId) || null;
  return activeRuns.size === 1 ? activeRuns.values().next().value : null;
}

// --- provider config resolution -----------------------------------------

// Resolves a provider config from the multi-provider store. By default
// honors which models the user has enabled for CHAT (requireEnabled: true)
// — but the vision-fallback config is a standalone assignment, independent
// of the chat checklist, so it's resolved with requireEnabled: false to
// validate against the provider's full fetched model catalog instead.
// Validating a vision pick against the chat-enabled subset would silently
// swap in whatever IS chat-enabled the moment the two don't match.
// Also falls back to the old single-provider keys for anyone upgrading who
// hasn't opened Settings yet — but only when "providers" has never been
// saved at all (undefined), not when the user has deliberately emptied it
// by deleting every provider (an empty array is a real, intentional state).
async function getConfig(providerId, modelId, { requireEnabled = true } = {}) {
  const stored = await chrome.storage.local.get([
    "providers",
    "activeProviderId",
    "activeModelId",
    "provider",
    "apiKey",
    "model",
    "baseUrl",
  ]);
  let providers = stored.providers;

  if (providers === undefined && stored.apiKey) {
    providers = [
      {
        id: "legacy",
        label: stored.provider === "anthropic" ? "Anthropic" : "OpenAI",
        type: stored.provider || "anthropic",
        apiKey: stored.apiKey,
        baseUrl: stored.baseUrl || "",
        models: stored.model ? [{ id: stored.model, label: stored.model }] : [],
        enabledModelIds: stored.model ? [stored.model] : [],
      },
    ];
  }
  providers = providers || [];

  const pid = providerId || stored.activeProviderId;
  const p = providers.find((x) => x.id === pid) || providers[0];
  if (!p || !p.apiKey) return null;

  // Distinguish "never customized" (enabledModelIds absent — default to all,
  // for backward compatibility with providers saved before this field
  // existed) from "explicitly set to none" (an empty array, e.g. after
  // clicking "None" in Settings) — checking .length here would treat both
  // the same and silently re-enable every model the user just disabled.
  const enabled = p.enabledModelIds ? p.enabledModelIds : (p.models || []).map((m) => m.id);
  const allModelIds = (p.models || []).map((m) => m.id);
  const pool = requireEnabled ? enabled : allModelIds;

  let model = modelId && pool.includes(modelId) ? modelId : null;
  if (!model && requireEnabled && p.id === pid && enabled.includes(stored.activeModelId)) model = stored.activeModelId;
  if (!model) model = pool[0] || "";

  return { provider: p.type, apiKey: p.apiKey, model, baseUrl: p.baseUrl || "" };
}

async function getAgent(agentId) {
  if (!agentId) return null;
  const { agents = [] } = await chrome.storage.local.get(["agents"]);
  return agents.find((a) => a.id === agentId) || null;
}

// Resolves the standalone vision-model assignment (Settings → Vision model)
// into a usable config for the view_image/filter_images tools, or null if
// the user hasn't set one up. Same underlying setting as applyVisionFallback
// below, but used mid-loop by agentLoop.js's tool execution rather than as a
// one-shot pre-loop step.
async function resolveVisionConfig() {
  const { visionFallback } = await chrome.storage.local.get(["visionFallback"]);
  if (!visionFallback || !visionFallback.providerId) return null;
  return getConfig(visionFallback.providerId, visionFallback.modelId, { requireEnabled: false });
}

// --- site-category access grants (adult/financial confirm-gate) ---------
// Domains the user has already confirmed via the site-category prompt —
// checked by runAgentTask itself (both the pre-run URL check and the
// mid-run RTA-meta-tag check in lib/siteCategories.js / lib/agentLoop.js).
// This is intentionally NOT a blocklist: once granted, a domain is never
// re-prompted unless revoked in Settings.
async function getGrantedDomains() {
  const { siteAccessGrants = {} } = await chrome.storage.local.get(["siteAccessGrants"]);
  return new Set(Object.keys(siteAccessGrants));
}

// --- runtime limits (Settings → Limits) -----------------------------------
// Defaults mirror lib/agentLoop.js's DEFAULT_LIMITS. runAgentTask itself
// also falls back to those same defaults for any field this doesn't
// provide, so a fresh install with nothing saved yet still behaves exactly
// as before this feature existed.
const DEFAULT_LIMITS = { mainMaxSteps: 20, batchStepLimit: 150, maxParallelTabs: 5, branchMaxSteps: 20, maxSourcesPerTask: 15 };
async function getLimits() {
  const { limits = {} } = await chrome.storage.local.get(["limits"]);
  return { ...DEFAULT_LIMITS, ...limits };
}

// --- page recall cache (Settings → Page recall) --------------------------
// On by default: compactHistory (lib/agentLoop.js) collapses all but the most
// recent read_page result, and with the cache off the placeholder it leaves
// can only say "call read_page again" — i.e. re-visit the site live, which is
// what drove the agent to re-investigate sources it had already finished with.
// With the cache on that placeholder points at recall_page instead. Page
// content can change between reads (the original reason this was opt-in);
// pageCache.js handles that with signature-based dedup and refresh/supersede
// logic rather than serving stale text blindly.
const DEFAULT_PAGE_CACHE = { enabled: true, maxEntries: PAGE_CACHE_DEFAULT_MAX_ENTRIES };
async function getPageCacheConfig() {
  const { pageCache = {} } = await chrome.storage.local.get(["pageCache"]);
  return { ...DEFAULT_PAGE_CACHE, ...pageCache };
}

// Off by default - the chrome.debugger trusted-input fallback (see
// lib/trustedInput.js) shows Chrome's own "being debugged" infobar on the
// tab while it's attached, so this is opt-in only. options.js requests/
// removes the actual "debugger" optional permission when this toggle is
// flipped; this just reads the user's stated preference.
async function getTrustedInputEnabled() {
  const { trustedInputFallback } = await chrome.storage.local.get(["trustedInputFallback"]);
  if (!trustedInputFallback?.enabled) return false;
  // The user can revoke the optional "debugger" permission directly from
  // chrome://extensions without ever touching the Settings toggle -
  // options.js only reconciles storage back to false when Options happens
  // to be reopened, so check the ACTUAL grant here too. Otherwise every
  // click retry after a revoke attempts (and fails) a doomed attach until
  // then, instead of just skipping the retry like it would if storage were
  // accurate.
  return chrome.permissions.contains({ permissions: ["debugger"] });
}

// --- vision fallback -----------------------------------------------------

// If the chat model probably can't see images, and the user has configured
// a vision-fallback model in Settings, describe each attachment with that
// model and fold the description into the task text instead of sending raw
// image bytes the chat model would just ignore (or error on).
async function applyVisionFallback(config, task, attachments) {
  if (!attachments || !attachments.length || looksVisionCapable(config.model)) {
    return { task, attachments, note: null };
  }

  const { visionFallback } = await chrome.storage.local.get(["visionFallback"]);
  if (!visionFallback || !visionFallback.providerId) {
    return { task, attachments, note: null };
  }

  // Vision is a standalone assignment, not a pick from the chat checklist —
  // validate against the provider's full model catalog, not enabledModelIds.
  const visionConfig = await getConfig(visionFallback.providerId, visionFallback.modelId, { requireEnabled: false });
  if (!visionConfig) return { task, attachments, note: null };

  let combinedTask = task;
  let described = 0;
  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i];
    try {
      const description = await describeImage(visionConfig, att);
      combinedTask += `\n\n[Image ${i + 1}${att.name ? ` (${att.name})` : ""} — described by ${visionConfig.model} since "${config.model}" doesn't appear to support images directly]:\n${description}`;
      described += 1;
    } catch (err) {
      combinedTask += `\n\n[Image ${i + 1}: could not be processed by the vision helper model — ${err.message || err}]`;
    }
  }

  const note = described
    ? `Used ${visionConfig.model} to describe ${described} image${described === 1 ? "" : "s"} for ${config.model}.`
    : null;

  return { task: combinedTask, attachments: [], note };
}

// --- document attachments (PDF, and free-tier text formats) -------------

// Text was already extracted client-side in the side panel (via pdf.js, or
// File.text() for plain text/markdown/csv/json/etc.) — this folds it into
// the task text the MODEL sees, the same "sent to model, not shown in the
// user's chat bubble" split used for tabSwitchNote above. Wrapped the same
// way read_page wraps untrusted page content in lib/agentLoop.js, since an
// attached file's text can carry an injection attempt just as easily as a
// web page's.
//
// Nothing is ever trimmed here. Every attachment's FULL text gets chunked
// and persisted via lib/attachmentCache.js (keyed by this session + the
// attachment's own id); only chunk 1 gets folded into this turn's actual
// task text. If there's more than one chunk, the wrapper says so and gives
// the model everything it needs to fetch the rest via read_attachment_chunk
// — see that tool's definition in lib/tools.js and its executeTool case in
// lib/agentLoop.js. This is what replaced the old flat MAX_PDF_CHARS cap:
// that cap silently dropped content past 40k characters forever; chunking
// means nothing is ever lost, it just isn't all paid for up front.
async function buildDocBlocks(sessionId, docAttachments) {
  if (!docAttachments || !docAttachments.length) return { taskAddition: "", note: null };

  const blocks = [];
  const noteParts = [];
  for (const a of docAttachments) {
    const safeName = String(a.name || "document").replace(/"/g, "'");
    const hasText = a.text && a.text.trim();
    const body = hasText ? a.text : a.format === "pdf" ? "(no extractable text — likely a scanned/image-only PDF)" : "(empty file)";

    let totalChunks = 1;
    let firstChunkText = body;
    if (hasText) {
      const recorded = await recordAttachment(sessionId, a.id, { name: a.name, format: a.format, text: a.text }).catch(() => null);
      if (recorded) {
        totalChunks = recorded.totalChunks;
        firstChunkText = recorded.firstChunkText;
      }
    }

    const chunkNote = totalChunks > 1 ? ` (chunk 1 of ${totalChunks} — call read_attachment_chunk with attachment_id "${a.id}" and chunk_index 2, 3, ... for the rest before assuming this is the whole file)` : "";
    blocks.push(`<document_content_untrusted name="${safeName}" attachment_id="${a.id}">${chunkNote}\n${firstChunkText}\n</document_content_untrusted>`);
    noteParts.push(`${a.name}${a.pageCount ? ` (${a.pageCount}p)` : ""}${totalChunks > 1 ? `, ${totalChunks} chunks` : ""}`);
  }

  const note = `Attached ${docAttachments.length} file${docAttachments.length === 1 ? "" : "s"}: ${noteParts.join(", ")}`;
  return { taskAddition: `\n\n${blocks.join("\n\n")}`, note };
}

// --- session tree ----------------------------------------------------

function newSessionId() {
  return "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function newNodeId() {
  return "n_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function deriveTitle(task) {
  const clean = (task || "").replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

function createEmptySession(agentId) {
  const now = Date.now();
  return {
    id: newSessionId(),
    title: "New chat",
    agentId: agentId || null,
    createdAt: now,
    updatedAt: now,
    nodes: {},
    rootChildIds: [],
    rootSelectedChildId: null,
  };
}

function createNode(parentId, userText, userAttachmentPreviews) {
  const now = Date.now();
  return {
    id: newNodeId(),
    parentId: parentId || null,
    userText,
    userAttachmentPreviews: userAttachmentPreviews || [],
    uiEvents: [],
    cumulativeHistory: [],
    pendingQuestion: null,
    childIds: [],
    selectedChildId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function attachNode(session, parentNode, node) {
  session.nodes[node.id] = node;
  if (parentNode) {
    parentNode.childIds.push(node.id);
    parentNode.selectedChildId = node.id;
  } else {
    session.rootChildIds.push(node.id);
    session.rootSelectedChildId = node.id;
  }
}

function getActiveTipNode(session) {
  let id = session.rootSelectedChildId;
  let node = null;
  while (id && session.nodes[id]) {
    node = session.nodes[id];
    id = node.selectedChildId;
  }
  return node;
}

// Best-effort upgrade of sessions saved before the tree model existed: turns
// the old flat { uiEvents, history, pendingQuestion } shape into a single
// linear chain of nodes so old conversations keep working.
function migrateSessionIfNeeded(session) {
  if (session.nodes) return session;

  const nodes = {};
  const rootChildIds = [];
  let rootSelectedChildId = null;
  let currentNode = null;

  for (const event of session.uiEvents || []) {
    if (event.type === "user_message") {
      const node = createNode(currentNode ? currentNode.id : null, event.text, event.attachmentPreviews || []);
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

  if (currentNode) {
    currentNode.cumulativeHistory = session.history || [];
    currentNode.pendingQuestion = session.pendingQuestion || null;
  }

  return {
    id: session.id,
    title: session.title,
    agentId: session.agentId || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    nodes,
    rootChildIds,
    rootSelectedChildId,
  };
}

// chrome.storage.local has no atomic read-modify-write — every writer here
// does a plain get() -> mutate -> set() on the WHOLE array under one key.
// Two of those interleaving (e.g. persistAgentEvent's frequent checkpoint
// saves racing a second concurrent run now that activeRuns allows more than
// one — see drive() above — or two scheduled tasks finishing moments apart,
// each racing loadScheduledTasks/set in runScheduledTaskById below) can lose
// whichever write lands first: both read the same pre-write snapshot, so
// the second set() silently overwrites the first's change with a copy that
// never saw it. Serializing every read-modify-write on the same storage key
// through one promise chain closes that window — cheap since these are all
// same-process awaits, not real lock contention.
const storageQueues = new Map(); // storage key -> tail promise of the chain
function withStorageLock(key, fn) {
  const tail = (storageQueues.get(key) || Promise.resolve()).then(fn, fn);
  // Swallow rejections here so one failed write doesn't wedge the queue for
  // everyone after it — the actual error still propagates to whoever awaited
  // this specific call via the `tail` returned below.
  storageQueues.set(key, tail.catch(() => {}));
  return tail;
}

async function loadSession(sessionId) {
  if (!sessionId) return null;
  const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
  const found = sessions.find((s) => s.id === sessionId);
  return found ? migrateSessionIfNeeded(found) : null;
}

function saveSession(session) {
  return withStorageLock("sessions", async () => {
    const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) sessions[idx] = session;
    else sessions.push(session);
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    await chrome.storage.local.set({ sessions: sessions.slice(0, MAX_SESSIONS) });
  });
}

function broadcast(sessionId, nodeId, event) {
  chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId, nodeId, event });
}

// --- step-limit "still working?" pause -----------------------------------
// A run that exhausts its step budget pauses (like ask_user) instead of
// silently ending, so the user can choose to keep going. chrome.alarms
// (rather than setTimeout) is used for the 10-minute auto-stop because MV3
// service workers can be killed after ~30s idle — setTimeout would simply
// never fire if that happens; alarms survive and wake the worker.
function stepLimitAlarmName(sessionId, nodeId) {
  return `steplimit|${sessionId}|${nodeId}`;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith("steplimit|")) return;
  (async () => {
    const [, sessionId, nodeId] = alarm.name.split("|");
    const session = await loadSession(sessionId);
    if (!session) return;
    const node = session.nodes[nodeId];
    // Already answered (and its alarm cleared) in the normal case — this
    // guard only matters for a narrow race between the alarm firing and an
    // in-flight answer, and is a no-op otherwise.
    if (!node || !node.pendingQuestion || node.pendingQuestion.kind !== "step_limit") return;

    const resolvedEvent = { type: "continue_resolved", continue: false, timedOut: true };
    node.uiEvents.push(resolvedEvent);
    node.pendingQuestion = null;
    const finalAnswer = "Ended - no response within 10 minutes of reaching the step limit.";
    node.uiEvents.push({ type: "done", success: false, finalAnswer, alreadyShown: false });
    node.updatedAt = Date.now();
    session.updatedAt = Date.now();
    await saveSession(session);
    broadcast(session.id, node.id, resolvedEvent);
    chrome.runtime.sendMessage({ type: "AGENT_DONE", sessionId: session.id, nodeId: node.id, finalAnswer, success: false, alreadyShown: false });
  })();
});

// Persists each in-run event immediately (instead of only at the start and
// end of a run) so a killed/suspended MV3 service worker — which can happen
// mid-task — loses at most the current in-flight step, not the whole run's
// visible progress. "checkpoint" events are internal bookkeeping from
// agentLoop.js: they sync the node's cumulativeHistory/usage after each
// completed step but are never shown in the UI. "thinking" is skipped to
// cut write volume — losing "a step was about to start" is harmless.
async function persistAgentEvent(session, node, event) {
  if (event.type === "checkpoint") {
    node.cumulativeHistory = event.history;
    if (event.usage) node.usage = event.usage;
    node.updatedAt = Date.now();
    session.updatedAt = Date.now();
    await saveSession(session);
    return;
  }

  // Live token-by-token preview text — broadcast for the UI only. Storing
  // every delta (or even just appending it to uiEvents) would bloat storage
  // for no benefit, since the complete text arrives moments later in the
  // 'assistant' event that IS persisted.
  //
  // branch_step/batch_step are the same shape of problem, one level down:
  // parallel_investigate/run_batch can fire many of these per second across
  // several concurrent branches, and each one is superseded by the row's
  // next update (or the final branch_done/batch_done, which IS persisted).
  // Broadcasting-only keeps the live status card responsive without a
  // storage write per sub-step.
  if (event.type === "assistant_delta" || event.type === "branch_step" || event.type === "batch_step") {
    broadcast(session.id, node.id, event);
    return;
  }

  node.uiEvents.push(event);
  node.updatedAt = Date.now();
  broadcast(session.id, node.id, event);

  if (event.type !== "thinking") {
    session.updatedAt = Date.now();
    await saveSession(session);
  }
}

// Closes a list of tab ids once the whole task has genuinely finished —
// never the tab the run actually ended on (endedTabId, the one most likely
// to still be relevant), and never a tab the user is actively looking at
// right now. Used for openedTabIds — tabs the main loop opened itself via
// open_tab (see lib/agentLoop.js) — always, once a run is truly over.
// incompleteBranchTabIds (parallel_investigate branches left open to be
// resumed) go through closeIncompleteBranchTabs below instead, since closing
// those also needs to update their status-card row. Mirrors the same "only
// close what we opened, never yank an active tab" safeguard parallel_investigate
// branches already use for their own auto-close.
async function closeLeftoverOpenedTabs(tabIds, endedTabId) {
  for (const tabId of tabIds || []) {
    if (tabId === endedTabId) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && !tab.active) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

// Same idea, but for parallel_investigate branches that ran out of steps
// (see lib/agentLoop.js's incompleteBranchTabIds) — these are left open
// while the task is still going, so a per-branch "Resume" click can reuse
// the tab, but once the whole task is genuinely over (finished normally or
// stopped — see the call site in drive()) there's no more "later" for that
// button to matter. Unlike closeLeftoverOpenedTabs' plain tab-id list, each
// entry here also carries callId/label, so closing the tab can also emit a
// branch_closed event (persisted the same way runOneBranch's own auto-close
// does) to flip that row to "closed" instead of leaving it stuck showing
// "▶ resume"/"↗ view" for a tab that's actually already gone.
async function closeIncompleteBranchTabs(session, node, branches, endedTabId) {
  for (const branch of branches || []) {
    const tabId = branch?.tabId;
    if (!tabId || tabId === endedTabId) continue;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && !tab.active) {
      await chrome.tabs.remove(tabId).catch(() => {});
      await persistAgentEvent(session, node, { type: "branch_closed", callId: branch.callId, label: branch.label, url: branch.url });
    }
  }
}

// Runs the agent loop (fresh or resumed) for a specific node and handles
// the two ways it can end: a normal finish/stop/error, or a pause on
// ask_user.
async function drive(session, node, runOpts) {
  // A local object, not a lookup into activeRuns on every call — closing
  // over this directly means shouldStop/shouldSkipSubtasks below can never
  // accidentally read a DIFFERENT run's state even if activeRuns.set(id, ...)
  // gets overwritten by something else for this same session id before this
  // run finishes.
  const runState = { stop: false, skipSubtasks: false };
  activeRuns.set(session.id, runState);
  beginKeepAlive();
  try {
    const result = await runAgentTask({
      ...runOpts,
      // Scopes the page recall cache (see lib/pageCache.js) to this exact
      // chat — every drive() call already has session available, so this is
      // set here once rather than requiring every call site below to pass
      // it redundantly. Never leaks across sessions/windows this way.
      sessionId: session.id,
      shouldStop: () => runState.stop === true,
      shouldSkipSubtasks: () => runState.skipSubtasks === true,
      resetSkipSubtasks: () => { runState.skipSubtasks = false; },
      // Seeds runAgentTask's own tracking with whatever survived a PRIOR
      // pause on this same node (ask_user, a site-category gate, or the
      // step limit) — see the `if (result.paused)` branch below, which is
      // where these get saved in the first place. Without this, a task that
      // spans a pause-and-continue would start each leg with empty tracking
      // and forget about tabs opened before the pause, even though the task
      // as a whole never actually finished in between.
      initialOpenedTabIds: node.pendingOpenedTabIds,
      initialIncompleteBranchTabIds: node.pendingIncompleteBranchTabIds,
    });

    // Remember wherever the agent actually ended up (which may differ from
    // runOpts.tabId if it used switch_tab/open_tab mid-run) — the NEXT
    // message compares its own target tab against this to detect a tab
    // change the model wouldn't otherwise know about. See RUN_TASK below.
    const endedTabId = result.tabId || runOpts.tabId;
    if (endedTabId) session.lastTabId = endedTabId;

    if (result.paused) {
      node.pendingQuestion = { ...result.pendingQuestion, pendingToolResultBlocks: result.pendingToolResultBlocks };
      node.cumulativeHistory = result.history;
      node.usage = result.usage || node.usage;
      // Carried into the next runAgentTask call above whenever this node's
      // pause gets resumed (ANSWER_QUESTION/STEP_LIMIT_RESPONSE/
      // SITE_GATE_RESPONSE all funnel back through this same drive()) —
      // without this, tabs opened before the pause would be silently
      // forgotten once the task eventually does finish for real.
      node.pendingOpenedTabIds = result.openedTabIds || [];
      node.pendingIncompleteBranchTabIds = result.incompleteBranchTabIds || [];
      node.updatedAt = Date.now();
      session.updatedAt = Date.now();
      await saveSession(session);
      if (result.pendingQuestion?.kind === "step_limit") {
        chrome.alarms.create(stepLimitAlarmName(session.id, node.id), { delayInMinutes: 10 });
      }
      chrome.runtime.sendMessage({ type: "AGENT_PAUSED", sessionId: session.id, nodeId: node.id });
      return;
    }

    node.pendingQuestion = null;
    node.pendingOpenedTabIds = null;
    node.pendingIncompleteBranchTabIds = null;
    node.uiEvents.push({ type: "done", success: result.success, finalAnswer: result.finalAnswer, alreadyShown: result.alreadyShown === true });
    node.cumulativeHistory = result.history || node.cumulativeHistory;
    node.usage = result.usage || node.usage;
    node.updatedAt = Date.now();
    session.updatedAt = Date.now();
    await saveSession(session);
    chrome.runtime.sendMessage({ type: "AGENT_DONE", sessionId: session.id, nodeId: node.id, finalAnswer: result.finalAnswer, success: result.success, alreadyShown: result.alreadyShown === true });
    // Only reached on a genuine finish/stop/error, never on a pause (see the
    // `if (result.paused)` branch above, which returns before this point) —
    // a resumed run might still need one of these tabs, so cleanup has to
    // wait until the task is truly over.
    await closeLeftoverOpenedTabs(result.openedTabIds, endedTabId);
    // Branch tabs that ran out of steps (see lib/agentLoop.js's
    // incompleteBranchTabIds) are left open on purpose WHILE the task is
    // still going, so "Resume" can pick them back up later without losing
    // that source's progress. But once we're at this point, the task itself
    // is over — either it finished normally or the user hit the global Stop
    // button (both funnel through this exact block; only a pause returns
    // earlier, above) — so there's no more "later" for the per-branch Resume
    // button to matter, and leaving these open would just be a trail of
    // dangling tabs. Close them here unconditionally rather than only on
    // Stop, and update their rows to "closed" (see closeIncompleteBranchTabs).
    await closeIncompleteBranchTabs(session, node, result.incompleteBranchTabIds, endedTabId);
  } catch (err) {
    node.pendingQuestion = null;
    node.pendingOpenedTabIds = null;
    node.pendingIncompleteBranchTabIds = null;
    node.uiEvents.push({ type: "done", success: false, finalAnswer: `Unexpected error: ${err.message || err}`, alreadyShown: false });
    node.updatedAt = Date.now();
    session.updatedAt = Date.now();
    await saveSession(session);
    chrome.runtime.sendMessage({ type: "AGENT_DONE", sessionId: session.id, nodeId: node.id, finalAnswer: `Unexpected error: ${err.message || err}`, success: false, alreadyShown: false });
  } finally {
    // Only clear the entry if it's still THIS run's — guards against a
    // vanishingly narrow race where a new run for the same session id
    // somehow started and re-set the map entry before this one's cleanup ran.
    if (activeRuns.get(session.id) === runState) activeRuns.delete(session.id);
    endKeepAlive();
  }
}

// --- scheduled / recurring checks ----------------------------------------
// Runs a saved task on a timer with no side panel involved: opens its target
// URL in a new background tab, drives the agent loop against it headlessly,
// records the outcome, closes the tab, and (optionally) fires a system
// notification. CRUD and chrome.alarms scheduling live in options.js — any
// extension page can call chrome.alarms with the "alarms" permission this
// extension already has — so this only needs to react when one fires. That
// split matters because it's the one thing that must keep working even if
// Settings isn't open: a killed/restarted MV3 service worker still gets
// woken by the alarm itself (same reasoning as the step-limit alarm above).
// Same prefix convention options.js uses when it calls chrome.alarms.create
// directly for CRUD — the two files don't share a module, so this constant
// (and the "scheduledTask|" string it builds on) has to stay in sync by hand
// if it's ever changed in one place.
const SCHEDULED_TASK_ALARM_PREFIX = "scheduledTask|";
const MAX_RUN_HISTORY = 20; // per task — bounds storage growth for frequently-run checks

// A schemeless URL like "google.com" passed to chrome.tabs.create resolves
// relative to the CALLING context — which for a scheduled check is the
// extension itself — landing on a nonexistent chrome-extension://<id>/...
// page instead of the real site. Same normalization also lives in
// options.js (applied when a check is saved) — this copy is a defensive
// second layer for tasks saved before that existed, or edited via import.
function normalizeTaskUrl(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) return trimmed;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

async function loadScheduledTasks() {
  const { scheduledTasks = [] } = await chrome.storage.local.get(["scheduledTasks"]);
  return scheduledTasks;
}

// Resolves once the tab reaches "complete" load state, or after timeoutMs —
// whichever comes first. A stuck/slow page shouldn't hang a scheduled run
// forever; the agent loop will just see whatever the page looks like at
// that point (same as a user running a task on a still-loading tab).
function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

// manual = true for the Settings "Run now" button — a deliberate, one-off
// user action that should always actually run (and report why if it can't),
// never silently no-op. manual = false is the unattended alarm-fired path,
// which still needs its own guards: skip if the task was disabled (by the
// user, or automatically after a prior needs_input run — see below), and
// skip (without even counting it as a run) on a "weekly" schedule if today
// isn't one of the selected days.
async function runScheduledTaskById(id, { manual = false } = {}) {
  const tasks = await loadScheduledTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  if (!manual) {
    // Guards a narrow race: the alarm can fire moments after the task was
    // deleted or disabled in Settings, since clearing the alarm there isn't
    // perfectly atomic with the alarm queue.
    if (!task.enabled) return;
    if (task.schedule?.kind === "weekly") {
      const today = new Date().getDay(); // 0=Sun..6=Sat, matches the UI's day checkboxes
      if (!Array.isArray(task.schedule.days) || !task.schedule.days.includes(today)) return;
    }
  }

  const startedAt = Date.now();
  let tabId = null;
  // The agent can end up on a DIFFERENT tab than the one this function
  // opened — e.g. if the starting page was broken/unusable and it called
  // open_tab to actually get the work done elsewhere. runResult.tabId
  // reflects wherever it ended up; track it separately so cleanup below can
  // close both instead of only the tab this function itself created.
  let finalTabId = null;
  // Any other tabs the model opened via open_tab mid-run (see lib/agentLoop.js's
  // openedTabIds) beyond just the first and the last — a scheduled run is
  // headless, so unlike the interactive side panel these have no chance of
  // being useful afterward and should all be swept up in the finally block
  // below, not just the two endpoints.
  let openedTabIds = [];
  // parallel_investigate branches left open to be resumable (see
  // lib/agentLoop.js's incompleteBranchTabIds) — that only matters when
  // there's a side panel around for someone to click "Resume" on, which a
  // headless scheduled check never has, so these get closed unconditionally
  // here too rather than only when the interactive drive() run was stopped.
  let incompleteBranchTabIds = [];
  let status; // "ok" | "error" | "needs_input"
  let message;
  let usage = null;
  beginKeepAlive();
  try {
    const config = await getConfig(task.providerId, task.modelId, { requireEnabled: false });
    if (!config || !config.model) throw new Error("No API key/model configured for this scheduled check - check Settings.");

    const url = normalizeTaskUrl(task.url);
    if (!url) throw new Error("No URL configured for this scheduled check - check Settings.");

    // Notes/default context gathered from a prior manual run (see the
    // "needs_input" branch below) — appended so the model has that
    // information up front instead of needing to ask again.
    const effectiveTask = task.notes && task.notes.trim() ? `${task.prompt}\n\n${task.notes.trim()}` : task.prompt;

    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId, 25000);

    const grantedDomains = await getGrantedDomains();
    const visionConfig = await resolveVisionConfig();
    const limits = await getLimits();
    // No pageCacheConfig here — a scheduled check's entire point is seeing
    // current state on every run, so it must never read from (or pollute)
    // the persisted page cache from a previous run. recordPageRead/recallPage
    // (lib/pageCache.js) both check ctx.pageCacheConfig?.enabled, which stays
    // falsy since it's never passed, so that cache stays off regardless of
    // sessionId below.
    //
    // sessionId itself IS passed (scoped to just this one run, cleaned up in
    // the finally block below) — it's what gates lib/agentLoop.js's readPage()
    // chunk-and-store path for a page whose text is too big for one
    // read_page result. Without it, an oversized page would be silently cut
    // to its first chunk with no way for this headless run to ever see the
    // rest.
    const chunkSessionId = `sched_${task.id}_${startedAt}`;
    const runResult = await runAgentTask({
      tabId,
      task: effectiveTask,
      initialHistory: [],
      config,
      visionConfig,
      grantedDomains,
      limits,
      sessionId: chunkSessionId,
      onEvent: () => {},
      shouldStop: () => false,
    });
    finalTabId = runResult.tabId || null;
    usage = runResult.usage || null;
    openedTabIds = runResult.openedTabIds || [];
    incompleteBranchTabIds = runResult.incompleteBranchTabIds || [];

    if (runResult.paused) {
      // A scheduled run has nobody to answer ask_user or a site-category
      // gate — this isn't a "the task is broken" failure, it's "this task
      // needs a human's input to proceed." Distinguish it (status:
      // needs_input) from a genuine error so Settings can surface it
      // differently and point the user at "run it manually" instead of just
      // showing a generic failure.
      status = "needs_input";
      message =
        runResult.pendingQuestion?.kind === "site_category"
          ? `Needs input: this page needs one-time confirmation (${runResult.pendingQuestion.category}) - open it manually once in the side panel to grant access, then re-enable this check.`
          : "Needs input: the task asked a question only a person can answer, so it couldn't finish unattended. Run it manually to answer, then Save - what you enter can be kept as default context for future runs.";
    } else if (runResult.success === false) {
      status = "error";
      message = runResult.finalAnswer || "Failed.";
    } else {
      status = "ok";
      message = runResult.finalAnswer || "";
    }
  } catch (err) {
    status = "error";
    message = `Error: ${err.message || err}`;
  } finally {
    const idsToClose = new Set([tabId, finalTabId, ...openedTabIds, ...incompleteBranchTabIds.map((b) => b.tabId)].filter((v) => v));
    for (const closeId of idsToClose) {
      await chrome.tabs.remove(closeId).catch(() => {});
    }
    // Matches the chunkSessionId passed into runAgentTask above (same
    // deterministic id, recomputed rather than hoisted) — cleans up any
    // oversized-page chunks this one run stored under it, so a scheduled
    // check that fires repeatedly doesn't leave orphaned entries behind.
    deleteAttachmentCacheForSession(`sched_${task.id}_${startedAt}`).catch(() => {});
    endKeepAlive();
  }

  const finishedAt = Date.now();
  // Two scheduled checks finishing close together would otherwise race on
  // this same read-modify-write (see withStorageLock's comment above) — one
  // run's history write could silently clobber the other's.
  await withStorageLock("scheduledTasks", async () => {
    const freshTasks = await loadScheduledTasks();
    const idx = freshTasks.findIndex((t) => t.id === id);
    if (idx !== -1) {
      const runUsage = { inputTokens: usage?.inputTokens || 0, outputTokens: usage?.outputTokens || 0 };
      // A stable id (independent of array position) so Settings' history
      // popup can select/delete a specific entry safely even if the list
      // shifts under it — e.g. a 1-minute-interval task completing another
      // run while the popup happens to be open.
      const entryId = `run_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
      const entry = { id: entryId, startedAt, finishedAt, status, summary: (message || "").slice(0, 4000), usage: runUsage };
      const history = Array.isArray(freshTasks[idx].runHistory) ? freshTasks[idx].runHistory : [];
      history.unshift(entry);
      freshTasks[idx].runHistory = history.slice(0, MAX_RUN_HISTORY);
      freshTasks[idx].lastRun = entry; // convenience pointer to the latest entry
      // Lifetime ledger — every run's tokens/count are added here regardless
      // of whether that run's history entry survives (deleting old rows from
      // runHistory is just log housekeeping; the tokens were still spent).
      // Never decremented, same "total vs active" pattern used for chat
      // sessions' /compact usage.
      const prevTotal = freshTasks[idx].totalUsage || { inputTokens: 0, outputTokens: 0 };
      freshTasks[idx].totalUsage = {
        inputTokens: prevTotal.inputTokens + runUsage.inputTokens,
        outputTokens: prevTotal.outputTokens + runUsage.outputTokens,
      };
      freshTasks[idx].totalRunCount = (freshTasks[idx].totalRunCount || 0) + 1;
      if (status === "needs_input") {
        // Stop firing on schedule until the user has actually looked at
        // this and either fixed it (added notes/default context, changed
        // the prompt) or re-enabled it deliberately — otherwise it would
        // just fail the same way every single interval. Flipping `enabled`
        // alone isn't enough: the alarm itself (created by options.js's
        // syncAlarmForTask) has to be cleared too, or it just keeps firing
        // forever and silently no-op'ing on the `!task.enabled` guard above
        // — looking exactly like "this never runs" even though Chrome is
        // dutifully firing it every interval.
        freshTasks[idx].enabled = false;
        freshTasks[idx].disabledReason = "needs_input";
        await chrome.alarms.clear(`${SCHEDULED_TASK_ALARM_PREFIX}${id}`);
      } else if (status === "ok" && freshTasks[idx].disabledReason) {
        // A successful manual run after fixing things up clears the flag,
        // though the user still has to re-check Enabled themselves — this
        // just stops Settings from showing a stale "needs input" badge.
        delete freshTasks[idx].disabledReason;
      }
      await chrome.storage.local.set({ scheduledTasks: freshTasks });
    }
  });

  if (task.notify) {
    chrome.notifications
      .create(`scheduledTask-${id}-${finishedAt}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: `Tab Agent - ${task.name}${status === "ok" ? "" : status === "needs_input" ? " (needs input)" : " (failed)"}`,
        message: (message || "Done.").slice(0, 250),
      })
      .catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(SCHEDULED_TASK_ALARM_PREFIX)) return;
  const id = alarm.name.slice(SCHEDULED_TASK_ALARM_PREFIX.length);
  // runScheduledTaskById's own try/catch only covers the run itself — a
  // failure loading the task list up front, or in the withStorageLock write
  // at the end (which re-throws to its caller if the write itself fails),
  // happens outside that. Nothing here awaits this call, so without a
  // .catch() either of those would become an unhandled rejection in the
  // service worker instead of just being logged.
  runScheduledTaskById(id).catch((err) => {
    console.error(`Scheduled task ${id} failed outside its own error handling:`, err);
  });
});

// --- message routing -----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "RUN_TASK") {
    (async () => {
      const config = await getConfig(msg.providerId, msg.modelId);
      if (!config) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", event: { type: "error", message: "No provider configured. Open Settings (⚙) to add an API key." } });
        chrome.runtime.sendMessage({ type: "AGENT_DONE", finalAnswer: "No provider configured.", success: false, alreadyShown: true });
        return;
      }
      if (!config.model) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", event: { type: "error", message: "No model enabled for this provider. Open Settings and check at least one model." } });
        chrome.runtime.sendMessage({ type: "AGENT_DONE", finalAnswer: "No model enabled.", success: false, alreadyShown: true });
        return;
      }

      let tabId = msg.tabId;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }
      if (!tabId) {
        chrome.runtime.sendMessage({ type: "AGENT_DONE", finalAnswer: "No active tab found.", success: false });
        return;
      }

      const agent = await getAgent(msg.agentId);

      let session = await loadSession(msg.sessionId);
      if (!session) session = createEmptySession(agent?.id);
      if (agent) session.agentId = agent.id;
      if (!session.title || session.title === "New chat") session.title = deriveTitle(msg.task);

      // Editing a past message branches from THAT message's parent (a new
      // sibling), rather than appending after the current active tip.
      let parentNode;
      if (msg.editNodeId && session.nodes[msg.editNodeId]) {
        const targetNode = session.nodes[msg.editNodeId];
        parentNode = targetNode.parentId ? session.nodes[targetNode.parentId] : null;
      } else {
        parentNode = getActiveTipNode(session);
      }
      const ancestorHistory = parentNode ? parentNode.cumulativeHistory : [];

      const attachmentPreviews = [
        ...(msg.attachments || []).map((a) => `data:${a.mediaType};base64,${a.data}`),
        ...(msg.docAttachments || []).map((a) => ({ kind: a.kind || "doc", format: a.format, name: a.name, pageCount: a.pageCount })),
      ];
      const newNode = createNode(parentNode ? parentNode.id : null, msg.task, attachmentPreviews);
      attachNode(session, parentNode, newNode);
      session.updatedAt = Date.now();
      await saveSession(session);

      // Each message already targets whatever tab is active right now (see
      // sidepanel.js's sendTask, which re-queries on every send) — so tool
      // calls always act on the right tab. But the conversation HISTORY still
      // reads like it's about the previous tab, and the model has no way to
      // know the user moved unless told: it isn't shown to have called
      // switch_tab itself, so "the page you're already looking at" from the
      // system prompt would otherwise resolve to stale content. Make the
      // change explicit in the message the model sees (not in what the user
      // sees — their chat bubble stays exactly what they typed).
      let tabSwitchNote = null;
      if (session.lastTabId && session.lastTabId !== tabId) {
        const newTab = await chrome.tabs.get(tabId).catch(() => null);
        tabSwitchNote = `You're now on a different tab than before${newTab?.title ? ` — "${newTab.title}"` : ""}. Call read_page again before assuming anything carries over from the previous tab.`;
      }
      let taskForModel = tabSwitchNote ? `[${tabSwitchNote}]\n\n${msg.task}` : msg.task;

      const { taskAddition: docAddition, note: docNote } = await buildDocBlocks(session.id, msg.docAttachments);
      if (docAddition) taskForModel += docAddition;

      const { task: effectiveTask, attachments: effectiveAttachments, note: visionNote } = await applyVisionFallback(config, taskForModel, msg.attachments);
      if (tabSwitchNote) {
        const infoEvent = { type: "info", message: `🔀 ${tabSwitchNote}` };
        newNode.uiEvents.push(infoEvent);
        broadcast(session.id, newNode.id, infoEvent);
      }
      if (docNote) {
        const infoEvent = { type: "info", message: `📄 ${docNote}` };
        newNode.uiEvents.push(infoEvent);
        broadcast(session.id, newNode.id, infoEvent);
      }
      if (visionNote) {
        const infoEvent = { type: "info", message: `🖼️ ${visionNote}` };
        newNode.uiEvents.push(infoEvent);
        broadcast(session.id, newNode.id, infoEvent);
      }
      const visionConfig = await resolveVisionConfig();
      const grantedDomains = await getGrantedDomains();
      const limits = await getLimits();
      const pageCacheConfig = await getPageCacheConfig();
      const trustedInputEnabled = await getTrustedInputEnabled();

      await drive(session, newNode, {
        tabId,
        task: effectiveTask,
        attachments: effectiveAttachments,
        initialHistory: ancestorHistory,
        agentContext: agent,
        config,
        visionConfig,
        grantedDomains,
        limits,
        pageCacheConfig,
        trustedInputEnabled,
        onEvent: (event) => persistAgentEvent(session, newNode, event),
      });
    })();
    sendResponse({ started: true });
    return true;
  }

  if (msg.type === "ANSWER_QUESTION") {
    (async () => {
      const session = await loadSession(msg.sessionId);
      if (!session) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: msg.sessionId, event: { type: "error", message: "This question is no longer waiting for an answer." } });
        return;
      }
      const node = Object.values(session.nodes).find((n) => n.pendingQuestion && n.pendingQuestion.toolUseId === msg.toolUseId);
      if (!node) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: session.id, event: { type: "error", message: "This question is no longer waiting for an answer." } });
        return;
      }

      const config = await getConfig(msg.providerId, msg.modelId);
      if (!config || !config.model) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: session.id, event: { type: "error", message: "No provider/model configured. Open Settings (⚙)." } });
        return;
      }

      let tabId = msg.tabId;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }

      const agent = await getAgent(msg.agentId || session.agentId);
      const answeredEvent = { type: "answered", id: msg.toolUseId, answer: msg.answer };
      node.uiEvents.push(answeredEvent);
      broadcast(session.id, node.id, answeredEvent);

      const pending = node.pendingQuestion;
      node.pendingQuestion = null;
      const visionConfig = await resolveVisionConfig();
      const grantedDomains = await getGrantedDomains();
      const limits = await getLimits();
      const pageCacheConfig = await getPageCacheConfig();
      const trustedInputEnabled = await getTrustedInputEnabled();

      await drive(session, node, {
        tabId,
        initialHistory: node.cumulativeHistory, // includes the paused, not-yet-resolved turn
        resume: { toolUseId: pending.toolUseId, answer: msg.answer, pendingToolResultBlocks: pending.pendingToolResultBlocks },
        agentContext: agent,
        config,
        visionConfig,
        grantedDomains,
        limits,
        pageCacheConfig,
        trustedInputEnabled,
        onEvent: (event) => persistAgentEvent(session, node, event),
      });
    })();
    sendResponse({ received: true });
    return true;
  }

  if (msg.type === "COMPACT_SESSION") {
    (async () => {
      const session = await loadSession(msg.sessionId);
      if (!session) return;
      const node = getActiveTipNode(session);
      if (!node || !node.cumulativeHistory || !node.cumulativeHistory.length) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: msg.sessionId, event: { type: "info", message: "Nothing to compact yet." } });
        return;
      }

      const config = await getConfig(msg.providerId, msg.modelId);
      if (!config || !config.model) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: msg.sessionId, event: { type: "error", message: "No provider/model configured. Open Settings (⚙)." } });
        return;
      }

      const beforeTokens = (node.usage?.inputTokens || 0) + (node.usage?.outputTokens || 0);
      let summary, compactUsage;
      try {
        ({ summary, usage: compactUsage } = await summarizeHistory(config, node.cumulativeHistory));
      } catch (err) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: msg.sessionId, event: { type: "error", message: `Could not compact this chat: ${err.message || err}` } });
        return;
      }

      // Compacting shrinks the ACTIVE context going forward, but it must
      // never make the chat's lifetime token total go down — that would
      // misrepresent money already spent. So before this node's own usage
      // gets cleared, fold it (plus the summarization call's own cost,
      // which would otherwise go untracked) into a running ledger on the
      // session that persists across every future compact too. sidepanel.js
      // adds this ledger on top of the per-node sum to show "total this
      // chat", while node.usage below becomes the "active" figure.
      const carry = session.compactedUsage || { inputTokens: 0, outputTokens: 0 };
      carry.inputTokens += (node.usage?.inputTokens || 0) + (compactUsage?.inputTokens || 0);
      carry.outputTokens += (node.usage?.outputTokens || 0) + (compactUsage?.outputTokens || 0);
      carry.model = node.usage?.model || carry.model;
      carry.provider = node.usage?.provider || carry.provider;
      session.compactedUsage = carry;

      // Collapsed to a clean two-turn exchange, not a partial trim — this
      // sidesteps the API's tool_use/tool_result pairing requirement
      // entirely (nothing here is a tool call), so there's no risk of
      // leaving a dangling tool_use with no matching result.
      node.cumulativeHistory = [
        { role: "user", content: [{ type: "text", text: `[Earlier conversation summarized to save context]\n\n${summary}` }] },
        { role: "assistant", content: [{ type: "text", text: "Got it - I have the summary of our conversation so far and will continue from there." }] },
      ];
      // The new "active" context isn't actually empty — it's this short
      // exchange — so estimate its size (~4 chars/token) rather than
      // showing 0. This estimate gets replaced by a real measured value the
      // moment the next message runs, since that turn's own agent run
      // reports real usage for node.usage as normal.
      const activeEstimate = Math.ceil(JSON.stringify(node.cumulativeHistory).length / 4);
      node.usage = { inputTokens: activeEstimate, outputTokens: 0, model: config.model, provider: config.provider };
      const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
      const infoEvent = {
        type: "info",
        message: `📦 Compacted this chat's context${beforeTokens ? ` (~${fmtK(beforeTokens)} → ~${fmtK(activeEstimate)} active tokens)` : ""} to save cost on future messages.`,
      };
      node.uiEvents.push(infoEvent);
      node.updatedAt = Date.now();
      session.updatedAt = Date.now();
      await saveSession(session);
      broadcast(session.id, node.id, infoEvent);
      chrome.runtime.sendMessage({ type: "SESSION_COMPACTED", sessionId: session.id });
    })();
    sendResponse({ received: true });
    return true;
  }

  if (msg.type === "STEP_LIMIT_RESPONSE") {
    (async () => {
      const session = await loadSession(msg.sessionId);
      if (!session) return;
      const node = session.nodes[msg.nodeId];
      if (!node || !node.pendingQuestion || node.pendingQuestion.kind !== "step_limit") {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: msg.sessionId, event: { type: "error", message: "This prompt is no longer active." } });
        return;
      }
      chrome.alarms.clear(stepLimitAlarmName(session.id, node.id));

      const resolvedEvent = { type: "continue_resolved", continue: !!msg.continue, timedOut: false };
      node.uiEvents.push(resolvedEvent);
      broadcast(session.id, node.id, resolvedEvent);
      node.pendingQuestion = null;

      if (!msg.continue) {
        const finalAnswer = "Stopped after reaching the step limit.";
        node.uiEvents.push({ type: "done", success: false, finalAnswer, alreadyShown: false });
        node.updatedAt = Date.now();
        session.updatedAt = Date.now();
        await saveSession(session);
        chrome.runtime.sendMessage({ type: "AGENT_DONE", sessionId: session.id, nodeId: node.id, finalAnswer, success: false, alreadyShown: false });
        return;
      }

      const config = await getConfig(msg.providerId, msg.modelId);
      if (!config || !config.model) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: session.id, event: { type: "error", message: "No provider/model configured. Open Settings (⚙)." } });
        return;
      }
      let tabId = msg.tabId;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }
      const agent = await getAgent(msg.agentId || session.agentId);
      const visionConfig = await resolveVisionConfig();
      const grantedDomains = await getGrantedDomains();
      const limits = await getLimits();
      const pageCacheConfig = await getPageCacheConfig();
      const trustedInputEnabled = await getTrustedInputEnabled();

      await drive(session, node, {
        tabId,
        initialHistory: node.cumulativeHistory,
        continueRun: true,
        agentContext: agent,
        config,
        visionConfig,
        grantedDomains,
        limits,
        pageCacheConfig,
        trustedInputEnabled,
        onEvent: (event) => persistAgentEvent(session, node, event),
      });
    })();
    sendResponse({ received: true });
    return true;
  }

  if (msg.type === "SITE_GATE_RESPONSE") {
    (async () => {
      const session = await loadSession(msg.sessionId);
      if (!session) return;
      const node = session.nodes[msg.nodeId];
      if (!node || !node.pendingQuestion || node.pendingQuestion.kind !== "site_category") {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: msg.sessionId, event: { type: "error", message: "This prompt is no longer active." } });
        return;
      }

      const { category, hostname } = node.pendingQuestion;
      const resolvedEvent = { type: "site_gate_resolved", approved: !!msg.approve, category, hostname };
      node.uiEvents.push(resolvedEvent);
      broadcast(session.id, node.id, resolvedEvent);
      node.pendingQuestion = null;

      if (!msg.approve) {
        const finalAnswer = `Stopped - ${hostname} looks like a ${category} site and wasn't confirmed.`;
        node.uiEvents.push({ type: "done", success: false, finalAnswer, alreadyShown: false });
        node.updatedAt = Date.now();
        session.updatedAt = Date.now();
        await saveSession(session);
        chrome.runtime.sendMessage({ type: "AGENT_DONE", sessionId: session.id, nodeId: node.id, finalAnswer, success: false, alreadyShown: false });
        return;
      }

      // Persist the grant — this domain won't be re-prompted again unless
      // revoked in Settings → Site access.
      const { siteAccessGrants = {} } = await chrome.storage.local.get(["siteAccessGrants"]);
      siteAccessGrants[hostname] = { category, grantedAt: Date.now() };
      await chrome.storage.local.set({ siteAccessGrants });

      const config = await getConfig(msg.providerId, msg.modelId);
      if (!config || !config.model) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: session.id, event: { type: "error", message: "No provider/model configured. Open Settings (⚙)." } });
        return;
      }
      let tabId = msg.tabId;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }
      const agent = await getAgent(msg.agentId || session.agentId);
      const visionConfig = await resolveVisionConfig();
      const grantedDomains = await getGrantedDomains();

      const limits = await getLimits();
      const pageCacheConfig = await getPageCacheConfig();
      const trustedInputEnabled = await getTrustedInputEnabled();

      // Both the pre-run and mid-run gate already left history in a clean,
      // nothing-pending state (see lib/agentLoop.js) — resuming either one is
      // just a plain continueRun, no branching needed on which gate fired.
      await drive(session, node, {
        tabId,
        initialHistory: node.cumulativeHistory,
        continueRun: true,
        agentContext: agent,
        config,
        visionConfig,
        grantedDomains,
        limits,
        pageCacheConfig,
        trustedInputEnabled,
        onEvent: (event) => persistAgentEvent(session, node, event),
      });
    })();
    sendResponse({ received: true });
    return true;
  }

  // Resumes one parallel_investigate branch that ran out of steps (its
  // status card shows a "Resume" button instead of just a dead-end failure
  // — see lib/agentLoop.js's resumeBranch for why this runs standalone
  // rather than feeding back into the original tool call's turn). Unlike
  // STEP_LIMIT_RESPONSE/SITE_GATE_RESPONSE this never touches
  // node.pendingQuestion or drive() — it's not resuming the main run, just
  // one still-open branch tab, so its events are persisted onto the same
  // node purely so the status card's final state survives a reload.
  if (msg.type === "RESUME_BRANCH") {
    (async () => {
      const session = await loadSession(msg.sessionId);
      const node = session && session.nodes[msg.nodeId];
      if (!session || !node) {
        sendResponse({ ok: false, error: "This chat is no longer available." });
        return;
      }
      const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
      if (!tab) {
        sendResponse({ ok: false, error: "That tab was closed - reopen it first, then resume." });
        return;
      }
      const config = await getConfig(msg.providerId, msg.modelId);
      if (!config || !config.model) {
        sendResponse({ ok: false, error: "No provider/model configured. Open Settings (⚙)." });
        return;
      }
      const visionConfig = await resolveVisionConfig();
      const grantedDomains = await getGrantedDomains();
      const limits = await getLimits();
      const pageCacheConfig = await getPageCacheConfig();
      // Same turn-counting rationale as runAgentTask's own ctx.turnIndex —
      // this resume isn't nested inside a runAgentTask call, so it has to be
      // computed here from the node's own persisted history instead.
      const turnIndex = (node.cumulativeHistory || []).filter((t) => t.role === "user").length;

      // A resume isn't nested inside drive() the way a fresh
      // parallel_investigate call is, but it should still respect Stop and
      // the per-card skip signal for THIS session if the user reaches for
      // either while a resume is running — reuse the same per-session
      // runState a live drive() call would use rather than inventing a
      // separate one. Reset skipSubtasks first in case a stale flag is still
      // set from an earlier, unrelated call; otherwise this resume could see
      // it immediately and skip itself before doing anything.
      let runState = activeRuns.get(session.id);
      if (!runState) {
        runState = { stop: false, skipSubtasks: false };
        activeRuns.set(session.id, runState);
      } else {
        runState.skipSubtasks = false;
      }
      beginKeepAlive();

      try {
        const result = await resumeBranch({
          tabId: msg.tabId,
          label: msg.label,
          url: msg.url,
          objective: msg.objective,
          callId: msg.callId,
          config,
          limits,
          visionConfig,
          grantedDomains,
          sessionId: session.id,
          pageCacheConfig,
          turnIndex,
          onEvent: (event) => persistAgentEvent(session, node, event),
          shouldStop: () => runState.stop === true,
          shouldSkipSubtasks: () => runState.skipSubtasks === true,
        });
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      } finally {
        if (activeRuns.get(session.id) === runState) activeRuns.delete(session.id);
        endKeepAlive();
      }
    })();
    return true;
  }

  // Scoped "skip remaining sub-tasks" — distinct from STOP_TASK below,
  // which aborts the entire run. This only flips a flag that
  // parallel_investigate branches / run_batch's sub-loop check (see
  // ctx.shouldSkip in lib/agentLoop.js); the main loop never looks at it,
  // so the conversation keeps going once the current sub-task(s) wrap up
  // with whatever they'd gathered. Scoped to msg.sessionId (see
  // findRunState) so this can never flip the flag for a DIFFERENT chat's run.
  if (msg.type === "SKIP_SUBTASKS") {
    const runState = findRunState(msg.sessionId);
    if (runState) runState.skipSubtasks = true;
    sendResponse({ ok: !!runState });
    return true;
  }

  if (msg.type === "DELETE_SESSION_CACHE") {
    // Sent by sidepanel.js right after it removes a chat from the "sessions"
    // array, so a deleted chat's cached page content (see lib/pageCache.js)
    // and cached attachment content (see lib/attachmentCache.js) don't linger
    // orphaned in storage indefinitely. Routed through background.js (rather
    // than sidepanel.js touching pagecache*/attcache* keys directly) because
    // sidepanel.js is a classic script, not an ES module, and can't import
    // either module's key-naming logic directly.
    deleteCacheForSession(msg.sessionId).catch((err) => console.log("[pageCache] deleteCacheForSession failed:", err?.message || err));
    deleteAttachmentCacheForSession(msg.sessionId).catch((err) => console.log("[attachmentCache] deleteCacheForSession failed:", err?.message || err));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "STOP_TASK") {
    const runState = findRunState(msg.sessionId);
    if (runState) runState.stop = true;
    sendResponse({ stopped: !!runState });
    return true;
  }

  if (msg.type === "RUN_SCHEDULED_TASK_NOW") {
    // Fire-and-forget from Settings' "Run now" button — options.js re-reads
    // the task's lastRun/runHistory from storage a few seconds later (or on
    // the next chrome.storage.onChanged event) rather than waiting on a
    // response here, since a run can take as long as any other agent task.
    // manual: true — this is a deliberate one-off click, not the scheduler,
    // so it must actually run (and report why if it can't) rather than
    // silently no-op just because the task happens to be toggled off or
    // (for a weekly schedule) today isn't one of its selected days.
    runScheduledTaskById(msg.id, { manual: true });
    sendResponse({ started: true });
    return true;
  }

  // "Run manually" from the needs_input review card — unlike RUN_SCHEDULED_
  // TASK_NOW (headless, background tab, nobody to answer ask_user), this
  // opens the task's URL as the active tab and the side panel alongside it,
  // with the composer pre-filled, so the user can actually answer whatever
  // the task got stuck on. The panel may not have a listener registered the
  // instant it opens, so this also stashes the same info in storage as a
  // fallback the panel checks on its own load.
  if (msg.type === "OPEN_SCHEDULED_TASK_MANUAL") {
    (async () => {
      try {
        const tab = await chrome.tabs.create({ url: normalizeTaskUrl(msg.url), active: true });
        const prefill = { taskId: msg.id, prompt: msg.prompt || "", notes: msg.notes || "", ts: Date.now() };
        await chrome.storage.local.set({ pendingScheduledTaskPrefill: prefill });
        if (tab.windowId) await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
        chrome.runtime.sendMessage({ type: "PREFILL_SCHEDULED_TASK", ...prefill }).catch(() => {});
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    })();
    return true;
  }

  if (msg.type === "FOCUS_TAB") {
    (async () => {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        await chrome.tabs.update(msg.tabId, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    })();
    return true;
  }

  // Re-opens a branch tab that was auto-closed after a parallel_investigate
  // finding was recorded — the "↻ reopen" affordance on a closed branch row.
  // Just a plain foreground tab open; the agent isn't re-run against it, this
  // is purely so the user can look at the page the finding came from.
  if (msg.type === "REOPEN_TAB") {
    (async () => {
      try {
        // Same schemeless-URL problem as scheduled tasks — an unqualified
        // "google.com" resolves relative to this extension's own origin
        // instead of the real site if not normalized first.
        const tab = await chrome.tabs.create({ url: normalizeTaskUrl(msg.url), active: true });
        sendResponse({ ok: true, tabId: tab.id });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    })();
    return true;
  }

  return false;
});
