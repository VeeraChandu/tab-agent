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

const MAX_SESSIONS = 30;

const DEFAULT_AGENTS = [
  {
    id: "agent_linkedin_default",
    name: "LinkedIn Job Finder",
    slug: "linkedin_agent",
    description: "Finds job listings on LinkedIn for a role you give it.",
    targetUrl: "https://www.linkedin.com/jobs/",
    instructions:
      "You help the user find relevant job listings on LinkedIn for a given role. If the user hasn't specified " +
      "a role/title (and optionally a location or remote preference), use ask_user (input_type 'text') to ask for " +
      "it before doing anything else. Navigate to LinkedIn's job search, search for that role, then read the " +
      "results and summarize the top listings for the user: job title, company, location, and a link for each. " +
      "If LinkedIn shows a login wall or otherwise blocks access, tell the user clearly and stop rather than " +
      "guessing at results.",
  },
  {
    id: "agent_youtube_default",
    name: "YouTube Agent",
    slug: "youtube_agent",
    description: "Searches YouTube and summarizes what it finds.",
    targetUrl: "https://www.youtube.com",
    instructions:
      "You help the user find and understand content on YouTube based on their request (e.g. 'find the latest " +
      "releases of telugu songs'). Navigate to YouTube, use the search box for the user's query, then read the " +
      "results and summarize the top relevant ones for the user: title, channel, and a link. If the request is " +
      "ambiguous (unclear genre, language, or time range), use ask_user (input_type 'text') to clarify before " +
      "searching rather than guessing.",
  },
];

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  const { agents } = await chrome.storage.local.get(["agents"]);
  if (!agents) {
    const now = Date.now();
    await chrome.storage.local.set({
      agents: DEFAULT_AGENTS.map((a) => ({ ...a, createdAt: now, updatedAt: now })),
    });
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

// Simple single-run state (MVP: one task at a time).
// skipSubtasks is the scoped "skip remaining sub-tasks, keep the
// conversation going" flag from the investigate/batch card's own skip
// button — distinct from stop (which aborts the whole run). It's reset at
// the start of every parallel_investigate/run_batch call (see
// lib/agentLoop.js's resetSkipSubtasks) so a stale click can't bleed into
// a later, unrelated call within the same run.
let activeRun = null; // { stop: boolean, skipSubtasks: boolean }

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
const DEFAULT_LIMITS = { mainMaxSteps: 20, batchStepLimit: 150, maxParallelTabs: 5, branchMaxSteps: 20 };
async function getLimits() {
  const { limits = {} } = await chrome.storage.local.get(["limits"]);
  return { ...DEFAULT_LIMITS, ...limits };
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

// --- PDF attachments -------------------------------------------------

// Text was already extracted client-side in the side panel (via pdf.js) —
// this just folds it into the task text the MODEL sees, the same "sent to
// model, not shown in the user's chat bubble" split used for tabSwitchNote
// above. Wrapped the same way read_page wraps untrusted page content in
// lib/agentLoop.js, since a PDF's text can carry an injection attempt just
// as easily as a web page's.
function buildPdfBlocks(pdfAttachments) {
  if (!pdfAttachments || !pdfAttachments.length) return { taskAddition: "", note: null };

  const blocks = pdfAttachments
    .map((a) => {
      const safeName = String(a.name || "document.pdf").replace(/"/g, "'");
      const body = a.text && a.text.trim() ? a.text : "(no extractable text — likely a scanned/image-only PDF)";
      return `<document_content_untrusted name="${safeName}">\n${body}\n</document_content_untrusted>`;
    })
    .join("\n\n");

  const note = `Attached ${pdfAttachments.length} PDF${pdfAttachments.length === 1 ? "" : "s"}: ${pdfAttachments
    .map((a) => `${a.name}${a.pageCount ? ` (${a.pageCount}p${a.truncated ? ", truncated" : ""})` : ""}`)
    .join(", ")}`;

  return { taskAddition: `\n\n${blocks}`, note };
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

async function loadSession(sessionId) {
  if (!sessionId) return null;
  const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
  const found = sessions.find((s) => s.id === sessionId);
  return found ? migrateSessionIfNeeded(found) : null;
}

async function saveSession(session) {
  const { sessions = [] } = await chrome.storage.local.get(["sessions"]);
  const idx = sessions.findIndex((s) => s.id === session.id);
  if (idx >= 0) sessions[idx] = session;
  else sessions.push(session);
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  await chrome.storage.local.set({ sessions: sessions.slice(0, MAX_SESSIONS) });
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
    const finalAnswer = "Ended — no response within 10 minutes of reaching the step limit.";
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

// Runs the agent loop (fresh or resumed) for a specific node and handles
// the two ways it can end: a normal finish/stop/error, or a pause on
// ask_user.
async function drive(session, node, runOpts) {
  activeRun = { stop: false, skipSubtasks: false };
  try {
    const result = await runAgentTask({
      ...runOpts,
      shouldStop: () => activeRun?.stop === true,
      shouldSkipSubtasks: () => activeRun?.skipSubtasks === true,
      resetSkipSubtasks: () => { if (activeRun) activeRun.skipSubtasks = false; },
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
    node.uiEvents.push({ type: "done", success: result.success, finalAnswer: result.finalAnswer, alreadyShown: result.alreadyShown === true });
    node.cumulativeHistory = result.history || node.cumulativeHistory;
    node.usage = result.usage || node.usage;
    node.updatedAt = Date.now();
    session.updatedAt = Date.now();
    await saveSession(session);
    chrome.runtime.sendMessage({ type: "AGENT_DONE", sessionId: session.id, nodeId: node.id, finalAnswer: result.finalAnswer, success: result.success, alreadyShown: result.alreadyShown === true });
  } catch (err) {
    node.pendingQuestion = null;
    node.uiEvents.push({ type: "done", success: false, finalAnswer: `Unexpected error: ${err.message || err}`, alreadyShown: false });
    node.updatedAt = Date.now();
    session.updatedAt = Date.now();
    await saveSession(session);
    chrome.runtime.sendMessage({ type: "AGENT_DONE", sessionId: session.id, nodeId: node.id, finalAnswer: `Unexpected error: ${err.message || err}`, success: false, alreadyShown: false });
  } finally {
    activeRun = null;
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

async function runScheduledTaskById(id) {
  const tasks = await loadScheduledTasks();
  const task = tasks.find((t) => t.id === id);
  // Guards a narrow race: the alarm can fire moments after the task was
  // deleted or disabled in Settings, since clearing the alarm there isn't
  // perfectly atomic with the alarm queue.
  if (!task || !task.enabled) return;

  const startedAt = Date.now();
  let tabId = null;
  let outcome;
  try {
    const config = await getConfig(task.providerId, task.modelId, { requireEnabled: false });
    if (!config || !config.model) throw new Error("No API key/model configured for this scheduled check — check Settings.");

    const tab = await chrome.tabs.create({ url: task.url, active: false });
    tabId = tab.id;
    await waitForTabLoad(tabId, 25000);

    const grantedDomains = await getGrantedDomains();
    const visionConfig = await resolveVisionConfig();
    const limits = await getLimits();
    const runResult = await runAgentTask({
      tabId,
      task: task.prompt,
      initialHistory: [],
      config,
      visionConfig,
      grantedDomains,
      limits,
      onEvent: () => {},
      shouldStop: () => false,
    });

    if (runResult.paused) {
      // A scheduled run has nobody to answer ask_user or a site-category
      // gate — treat "stopped waiting on input" as a soft failure rather
      // than hanging. Surfacing this in the run's summary tells the user
      // why (e.g. "needs your confirmation for an adult/financial site" or
      // "the model asked a question it needed a human for").
      const reason =
        runResult.pendingQuestion?.kind === "site_category"
          ? `Paused: this page needs one-time confirmation (${runResult.pendingQuestion.category}) — open it manually once in the side panel to grant access, then re-enable this check.`
          : "Paused: the task asked a question only a person can answer, so it couldn't finish unattended.";
      outcome = { success: false, finalAnswer: reason };
    } else {
      outcome = { success: runResult.success !== false, finalAnswer: runResult.finalAnswer || "" };
    }
  } catch (err) {
    outcome = { success: false, finalAnswer: `Error: ${err.message || err}` };
  } finally {
    if (tabId) chrome.tabs.remove(tabId).catch(() => {});
  }

  const finishedAt = Date.now();
  const freshTasks = await loadScheduledTasks();
  const idx = freshTasks.findIndex((t) => t.id === id);
  if (idx !== -1) {
    freshTasks[idx].lastRun = {
      startedAt,
      finishedAt,
      success: outcome.success,
      summary: (outcome.finalAnswer || "").slice(0, 800),
    };
    await chrome.storage.local.set({ scheduledTasks: freshTasks });
  }

  if (task.notify) {
    chrome.notifications
      .create(`scheduledTask-${id}-${finishedAt}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: `Tab Agent — ${task.name}${outcome.success ? "" : " (failed)"}`,
        message: (outcome.finalAnswer || (outcome.success ? "Done." : "Failed.")).slice(0, 250),
      })
      .catch(() => {});
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(SCHEDULED_TASK_ALARM_PREFIX)) return;
  const id = alarm.name.slice(SCHEDULED_TASK_ALARM_PREFIX.length);
  runScheduledTaskById(id);
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
        ...(msg.pdfAttachments || []).map((a) => ({ kind: "pdf", name: a.name, pageCount: a.pageCount })),
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

      const { taskAddition: pdfAddition, note: pdfNote } = buildPdfBlocks(msg.pdfAttachments);
      if (pdfAddition) taskForModel += pdfAddition;

      const { task: effectiveTask, attachments: effectiveAttachments, note: visionNote } = await applyVisionFallback(config, taskForModel, msg.attachments);
      if (tabSwitchNote) {
        const infoEvent = { type: "info", message: `🔀 ${tabSwitchNote}` };
        newNode.uiEvents.push(infoEvent);
        broadcast(session.id, newNode.id, infoEvent);
      }
      if (pdfNote) {
        const infoEvent = { type: "info", message: `📄 ${pdfNote}` };
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

      await drive(session, node, {
        tabId,
        initialHistory: node.cumulativeHistory, // includes the paused, not-yet-resolved turn
        resume: { toolUseId: pending.toolUseId, answer: msg.answer, pendingToolResultBlocks: pending.pendingToolResultBlocks },
        agentContext: agent,
        config,
        visionConfig,
        grantedDomains,
        limits,
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
      let summary;
      try {
        summary = await summarizeHistory(config, node.cumulativeHistory);
      } catch (err) {
        chrome.runtime.sendMessage({ type: "AGENT_EVENT", sessionId: msg.sessionId, event: { type: "error", message: `Could not compact this chat: ${err.message || err}` } });
        return;
      }

      // Collapsed to a clean two-turn exchange, not a partial trim — this
      // sidesteps the API's tool_use/tool_result pairing requirement
      // entirely (nothing here is a tool call), so there's no risk of
      // leaving a dangling tool_use with no matching result.
      node.cumulativeHistory = [
        { role: "user", content: [{ type: "text", text: `[Earlier conversation summarized to save context]\n\n${summary}` }] },
        { role: "assistant", content: [{ type: "text", text: "Got it — I have the summary of our conversation so far and will continue from there." }] },
      ];
      node.usage = { inputTokens: 0, outputTokens: 0 };
      const infoEvent = {
        type: "info",
        message: `📦 Compacted this chat's context${beforeTokens ? ` (was tracking ~${Math.round(beforeTokens / 1000)}k tokens)` : ""} to save cost on future messages.`,
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

      await drive(session, node, {
        tabId,
        initialHistory: node.cumulativeHistory,
        continueRun: true,
        agentContext: agent,
        config,
        visionConfig,
        grantedDomains,
        limits,
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
        const finalAnswer = `Stopped — ${hostname} looks like a ${category} site and wasn't confirmed.`;
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
        sendResponse({ ok: false, error: "That tab was closed — reopen it first, then resume." });
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

      // A resume isn't nested inside drive()/activeRun the way a fresh
      // parallel_investigate call is, but it should still respect the same
      // global Stop and per-card skip signals if the user reaches for
      // either while a resume is running — reuse the same activeRun object
      // rather than inventing a separate one. Reset skipSubtasks first in
      // case a stale flag is still set from an earlier, unrelated call;
      // otherwise this resume could see it immediately and skip itself
      // before doing anything.
      if (!activeRun) activeRun = { stop: false, skipSubtasks: false };
      else activeRun.skipSubtasks = false;

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
          onEvent: (event) => persistAgentEvent(session, node, event),
          shouldStop: () => activeRun?.stop === true,
          shouldSkipSubtasks: () => activeRun?.skipSubtasks === true,
        });
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    })();
    return true;
  }

  // Scoped "skip remaining sub-tasks" — distinct from STOP_TASK below,
  // which aborts the entire run. This only flips a flag that
  // parallel_investigate branches / run_batch's sub-loop check (see
  // ctx.shouldSkip in lib/agentLoop.js); the main loop never looks at it,
  // so the conversation keeps going once the current sub-task(s) wrap up
  // with whatever they'd gathered.
  if (msg.type === "SKIP_SUBTASKS") {
    if (activeRun) activeRun.skipSubtasks = true;
    sendResponse({ ok: !!activeRun });
    return true;
  }

  if (msg.type === "STOP_TASK") {
    if (activeRun) activeRun.stop = true;
    sendResponse({ stopped: true });
    return true;
  }

  if (msg.type === "RUN_SCHEDULED_TASK_NOW") {
    // Fire-and-forget from Settings' "Run now" button — options.js re-reads
    // the task's lastRun field from storage a few seconds later (or on the
    // next chrome.storage.onChanged event) rather than waiting on a
    // response here, since a run can take as long as any other agent task.
    runScheduledTaskById(msg.id);
    sendResponse({ started: true });
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
        const tab = await chrome.tabs.create({ url: msg.url, active: true });
        sendResponse({ ok: true, tabId: tab.id });
      } catch (err) {
        sendResponse({ ok: false, error: String(err.message || err) });
      }
    })();
    return true;
  }

  return false;
});
