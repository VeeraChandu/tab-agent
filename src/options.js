import { listModels } from "./lib/providers.js";

// Mirror whatever theme the user picked in the side panel (manual toggle
// there, stored in chrome.storage.local) so Settings doesn't look jarringly
// different — this page has no toggle of its own, it just follows.
async function applyStoredTheme() {
  const { themePreference } = await chrome.storage.local.get(["themePreference"]);
  if (themePreference === "light" || themePreference === "dark") {
    document.documentElement.setAttribute("data-theme", themePreference);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}
applyStoredTheme();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.themePreference) applyStoredTheme();
});

const providerListEl = document.getElementById("providerList");
const addProviderBtn = document.getElementById("addProviderBtn");
const providerTemplate = document.getElementById("providerCardTemplate");

const agentListEl = document.getElementById("agentList");
const addAgentBtn = document.getElementById("addAgentBtn");
const agentTemplate = document.getElementById("agentCardTemplate");

const visionFallbackSelect = document.getElementById("visionFallbackSelect");
const visionProviderFilterSelect = document.getElementById("visionProviderFilterSelect");
const visionModelFilterInput = document.getElementById("visionModelFilterInput");

const siteAccessListEl = document.getElementById("siteAccessList");

const enableMicBtn = document.getElementById("enableMicBtn");
const openMicSettingsBtn = document.getElementById("openMicSettingsBtn");
const micStatus = document.getElementById("micStatus");

const scheduledListEl = document.getElementById("scheduledList");
const addScheduledBtn = document.getElementById("addScheduledBtn");
const scheduledTemplate = document.getElementById("scheduledCardTemplate");

// --- limits (Settings → Limits tab) --------------------------------------
// Defaults mirror lib/agentLoop.js's DEFAULT_LIMITS — kept in sync by hand
// since options.js and the service worker don't share a module here.
const DEFAULT_LIMITS = { mainMaxSteps: 20, batchStepLimit: 150, maxParallelTabs: 5, branchMaxSteps: 20, maxSourcesPerTask: 15 };
const limitMainStepsInput = document.getElementById("limitMainSteps");
const limitBatchStepsInput = document.getElementById("limitBatchSteps");
const limitMaxParallelTabsInput = document.getElementById("limitMaxParallelTabs");
const limitBranchStepsInput = document.getElementById("limitBranchSteps");
const limitMaxSourcesInput = document.getElementById("limitMaxSources");
const limitsSavedHint = document.getElementById("limitsSavedHint");

// --- page recall cache (Settings → Limits → Page recall) -----------------
// Defaults mirror background.js's DEFAULT_PAGE_CACHE — same manual-sync
// reasoning as DEFAULT_LIMITS above (options.js and the service worker
// don't share a module here).
const DEFAULT_PAGE_CACHE = { enabled: true, maxEntries: 15 };
const pageCacheEnabledInput = document.getElementById("pageCacheEnabled");
const pageCacheMaxEntriesInput = document.getElementById("pageCacheMaxEntries");
const pageCacheSavedHint = document.getElementById("pageCacheSavedHint");

// --- trusted-input fallback (Settings → Limits → Trusted input fallback) --
const trustedInputEnabledInput = document.getElementById("trustedInputEnabled");
const trustedInputSavedHint = document.getElementById("trustedInputSavedHint");

const exportSettingsBtn = document.getElementById("exportSettingsBtn");
const importSettingsBtn = document.getElementById("importSettingsBtn");
const importFileInput = document.getElementById("importFileInput");
const backupStatus = document.getElementById("backupStatus");

const backupSectionsOverlay = document.getElementById("backupSectionsOverlay");
const backupSectionsTitle = document.getElementById("backupSectionsTitle");
const backupSectionsList = document.getElementById("backupSectionsList");
const backupSectionsCancelBtn = document.getElementById("backupSectionsCancelBtn");
const backupSectionsOkBtn = document.getElementById("backupSectionsOkBtn");

// Human-readable label (+ optional note, e.g. "includes API keys") for each
// section, in the order shown in the picker popup — also used to build the
// "Exported/Imported: ..." status line from whichever sections were actually
// included, instead of a fixed sentence.
const BACKUP_SECTION_LABELS = {
  providers: "providers",
  agents: "agents",
  visionFallback: "vision model",
  siteAccessGrants: "site access grants",
  scheduledTasks: "scheduled checks",
  themePreference: "theme",
};
const BACKUP_SECTION_NOTES = { providers: "includes API keys" };

// --- overlay stack --------------------------------------------------------
// Several popups on this page can legitimately be open at once (most often:
// a delete confirmation opened from inside the history or run-detail
// popup). Each one used to register its own independent document-level
// Escape listener, so pressing Escape once fired ALL of them simultaneously
// — closing the confirm dialog AND the popup underneath it in a single
// keystroke. Every show*/close* function below pushes/pops its own name
// here, and every Escape handler checks isTopOverlay() first so only the
// actual topmost popup responds to a single Escape press.
const openOverlayStack = [];
function pushOverlay(name) {
  openOverlayStack.push(name);
}
function popOverlay(name) {
  const idx = openOverlayStack.lastIndexOf(name);
  if (idx !== -1) openOverlayStack.splice(idx, 1);
}
function isTopOverlay(name) {
  return openOverlayStack.length > 0 && openOverlayStack[openOverlayStack.length - 1] === name;
}

// Shows the section-picker popup (used by both Export and Import) and
// resolves with the Set of section keys the user left checked, or null if
// they cancelled. `sections` is an array of { key, disabled } — disabled
// sections (import-only: not present in the file being imported) are shown
// unchecked and un-clickable rather than omitted, so it's visible at a
// glance what the file simply doesn't have.
function showBackupSectionsPicker(title, okLabel, sections) {
  return new Promise((resolve) => {
    backupSectionsTitle.textContent = title;
    backupSectionsOkBtn.textContent = okLabel;
    backupSectionsList.innerHTML = "";

    const checkboxes = sections.map(({ key, disabled }) => {
      const row = document.createElement("label");
      row.className = "backup-section-row" + (disabled ? " disabled" : "");

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !disabled;
      cb.disabled = disabled;
      cb.dataset.sectionKey = key;
      row.appendChild(cb);

      const text = document.createElement("span");
      text.textContent = BACKUP_SECTION_LABELS[key];
      row.appendChild(text);

      if (BACKUP_SECTION_NOTES[key] && !disabled) {
        const note = document.createElement("span");
        note.className = "optional";
        note.textContent = ` (${BACKUP_SECTION_NOTES[key]})`;
        row.appendChild(note);
      }
      if (disabled) {
        const note = document.createElement("span");
        note.className = "not-in-file";
        note.textContent = "not in file";
        row.appendChild(note);
      }

      backupSectionsList.appendChild(row);
      return cb;
    });

    const updateOkState = () => {
      backupSectionsOkBtn.disabled = !checkboxes.some((cb) => cb.checked);
    };
    checkboxes.forEach((cb) => cb.addEventListener("change", updateOkState));
    updateOkState();

    backupSectionsOverlay.classList.remove("hidden");
    pushOverlay("backupSections");

    const cleanup = (result) => {
      backupSectionsOverlay.classList.add("hidden");
      popOverlay("backupSections");
      backupSectionsOkBtn.removeEventListener("click", onOk);
      backupSectionsCancelBtn.removeEventListener("click", onCancel);
      backupSectionsOverlay.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup(new Set(checkboxes.filter((cb) => cb.checked).map((cb) => cb.dataset.sectionKey)));
    const onCancel = () => cleanup(null);
    const onOverlay = (e) => {
      if (e.target === backupSectionsOverlay) cleanup(null);
    };
    const onKey = (e) => {
      if (e.key === "Escape" && isTopOverlay("backupSections")) cleanup(null);
    };

    backupSectionsOkBtn.addEventListener("click", onOk);
    backupSectionsCancelBtn.addEventListener("click", onCancel);
    backupSectionsOverlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}

let providers = [];
let activeProviderId = null;
let agents = [];
let visionFallback = null; // { providerId, modelId } | null
let scheduledTasks = [];

// Which cards are expanded — UI-only, not persisted. Anything already saved
// starts collapsed (summary row only); newly-added items are pre-expanded
// via addToSet below since there's nothing useful to summarize yet.
const expandedProviderIds = new Set();
const expandedAgentIds = new Set();
const expandedScheduledIds = new Set();

// Shared collapse/expand wiring for provider/agent/scheduled cards — the
// summary text itself is supplied by the caller (each list's own summary
// format differs) and re-run on demand whenever a field that affects it
// changes, via the returned updateSummary function.
function setupCollapsible(cardEl, itemId, expandedSet, summaryFn) {
  const toggleBtn = cardEl.querySelector(".expand-toggle");
  const summaryEl = cardEl.querySelector(".card-summary");

  const updateSummary = () => {
    const { text, title } = summaryFn();
    summaryEl.textContent = text;
    summaryEl.title = title || text;
  };
  updateSummary();
  cardEl.classList.toggle("expanded", expandedSet.has(itemId));

  const toggle = () => {
    const nowExpanded = !cardEl.classList.contains("expanded");
    cardEl.classList.toggle("expanded", nowExpanded);
    if (nowExpanded) expandedSet.add(itemId);
    else expandedSet.delete(itemId);
  };
  toggleBtn.addEventListener("click", toggle);
  summaryEl.addEventListener("click", toggle);

  return updateSummary;
}

function uid(prefix) {
  return `${prefix}_` + Math.random().toString(36).slice(2, 10);
}

// Shared status-line helper (provider fetch status, agent slug conflicts,
// etc.) — sets one of the conditional color classes instead of leaving a
// status paragraph permanently colored the same way regardless of whether
// its current message is actually an error.
function setStatus(el, text, kind = "") {
  el.textContent = text;
  el.classList.remove("error", "ok");
  if (kind) el.classList.add(kind);
}

// --- microphone permission (for the side panel's voice input) -----------
// Chrome's permission prompt for getUserMedia doesn't reliably appear inside
// a side panel — it can come back denied with nothing for the user to click
// on. Requesting it from THIS page instead works normally (it's a regular
// tab), and the grant carries over to the side panel automatically since
// both are the same chrome-extension:// origin. We only need the prompt to
// fire, not the audio itself — the stream is stopped immediately.
enableMicBtn?.addEventListener("click", async () => {
  micStatus.textContent = "Requesting…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    micStatus.textContent = "✓ Microphone access granted - voice input will now work in the side panel. If it still shows an error there, close and reopen the panel.";
  } catch (err) {
    if (err.name === "NotAllowedError") {
      micStatus.textContent = 'Blocked. Click "Open Chrome mic settings" below, find this extension in the list, switch it to Allow, then try again.';
    } else if (err.name === "NotFoundError") {
      micStatus.textContent = "No microphone was found on this device.";
    } else {
      micStatus.textContent = `Could not get microphone access: ${err.message || err}`;
    }
  }
});

openMicSettingsBtn?.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://settings/content/microphone" });
});

// --- tabs ------------------------------------------------------------
// Full WAI-ARIA tabs pattern: aria-selected + a roving tabindex (only the
// active tab is in the natural tab order; arrow keys move both focus and
// selection between the others) instead of just a cosmetic role="tab".

const tabBtns = Array.from(document.querySelectorAll(".tab-btn"));

function activateTab(btn) {
  tabBtns.forEach((b) => {
    const active = b === btn;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
}

tabBtns.forEach((btn, i) => {
  btn.addEventListener("click", () => activateTab(btn));
  btn.addEventListener("keydown", (e) => {
    let target = null;
    if (e.key === "ArrowRight") target = tabBtns[(i + 1) % tabBtns.length];
    else if (e.key === "ArrowLeft") target = tabBtns[(i - 1 + tabBtns.length) % tabBtns.length];
    else if (e.key === "Home") target = tabBtns[0];
    else if (e.key === "End") target = tabBtns[tabBtns.length - 1];
    if (target) {
      e.preventDefault();
      activateTab(target);
      target.focus();
    }
  });
});

// --- info-icon tooltips (replace always-visible explanatory paragraphs) -

let openTooltipEl = null;
let openTooltipBtn = null;

function closeTooltip() {
  if (openTooltipEl) openTooltipEl.remove();
  openTooltipEl = null;
  openTooltipBtn = null;
}

document.querySelectorAll(".info-icon").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpenForThis = openTooltipBtn === btn;
    closeTooltip();
    if (wasOpenForThis) return;

    const tip = document.createElement("div");
    tip.className = "info-tooltip";
    tip.textContent = btn.dataset.tooltip || "";
    document.body.appendChild(tip);

    const rect = btn.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - tipRect.width - 12));
    tip.style.top = `${rect.bottom + 6}px`;
    tip.style.left = `${left}px`;

    openTooltipEl = tip;
    openTooltipBtn = btn;
  });
});
document.addEventListener("click", () => closeTooltip());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeTooltip();
});

// --- confirm dialog (replaces native confirm(), matches the page's theme) -

const confirmOverlay = document.getElementById("confirmOverlay");
const confirmMessageEl = document.getElementById("confirmMessage");
const confirmCancelBtn = document.getElementById("confirmCancelBtn");
const confirmOkBtn = document.getElementById("confirmOkBtn");

function showConfirm(message, okLabel = "Remove") {
  return new Promise((resolve) => {
    confirmMessageEl.textContent = message;
    confirmOkBtn.textContent = okLabel;
    confirmOverlay.classList.remove("hidden");
    pushOverlay("confirm");
    confirmOkBtn.focus();

    const cleanup = (result) => {
      confirmOverlay.classList.add("hidden");
      popOverlay("confirm");
      confirmOkBtn.removeEventListener("click", onOk);
      confirmCancelBtn.removeEventListener("click", onCancel);
      confirmOverlay.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => {
      if (e.target === confirmOverlay) cleanup(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape" && isTopOverlay("confirm")) cleanup(false);
    };

    confirmOkBtn.addEventListener("click", onOk);
    confirmCancelBtn.addEventListener("click", onCancel);
    confirmOverlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}

// --- model diff popup (re-fetching an existing provider) -----------------
// See the fetch-models handler below: shown only when a re-fetch actually
// changes the model list (something added or removed) — purely
// informational, so a single dismiss button rather than confirm/cancel.

const modelDiffOverlay = document.getElementById("modelDiffOverlay");
const modelDiffTitleEl = document.getElementById("modelDiffTitle");
const modelDiffAddedHeading = document.querySelector(".model-diff-added-heading");
const modelDiffAddedList = document.querySelector(".model-diff-added-list");
const modelDiffRemovedHeading = document.querySelector(".model-diff-removed-heading");
const modelDiffRemovedList = document.querySelector(".model-diff-removed-list");
const modelDiffOkBtn = document.getElementById("modelDiffOkBtn");

function populateModelDiffList(listEl, headingEl, models) {
  listEl.innerHTML = "";
  models.forEach((m) => {
    const li = document.createElement("li");
    li.textContent = m.label || m.id;
    listEl.appendChild(li);
  });
  const has = models.length > 0;
  headingEl.classList.toggle("hidden", !has);
  listEl.classList.toggle("hidden", !has);
}

function showModelDiffPopup(providerLabel, added, removed) {
  return new Promise((resolve) => {
    modelDiffTitleEl.textContent = `Model list updated for "${providerLabel}"`;
    populateModelDiffList(modelDiffAddedList, modelDiffAddedHeading, added);
    populateModelDiffList(modelDiffRemovedList, modelDiffRemovedHeading, removed);

    modelDiffOverlay.classList.remove("hidden");
    pushOverlay("modelDiff");
    modelDiffOkBtn.focus();

    const cleanup = () => {
      modelDiffOverlay.classList.add("hidden");
      popOverlay("modelDiff");
      modelDiffOkBtn.removeEventListener("click", onOk);
      modelDiffOverlay.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve();
    };
    const onOk = () => cleanup();
    const onOverlay = (e) => {
      if (e.target === modelDiffOverlay) cleanup();
    };
    const onKey = (e) => {
      if (e.key === "Escape" && isTopOverlay("modelDiff")) cleanup();
    };

    modelDiffOkBtn.addEventListener("click", onOk);
    modelDiffOverlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}

// --- version indicator -------------------------------------------------

const appVersionEl = document.getElementById("appVersion");
if (appVersionEl) appVersionEl.textContent = `v${chrome.runtime.getManifest().version}`;

async function persistProviders() {
  await chrome.storage.local.set({ providers, activeProviderId });
  renderVisionProviderFilterOptions();
  renderVisionFallbackOptions();
}

async function persistAgents() {
  await chrome.storage.local.set({ agents });
}

async function persistVisionFallback() {
  await chrome.storage.local.set({ visionFallback });
}

async function load() {
  const stored = await chrome.storage.local.get([
    "providers",
    "activeProviderId",
    "provider",
    "apiKey",
    "model",
    "baseUrl",
    "agents",
    "visionFallback",
    "scheduledTasks",
    "limits",
  ]);

  if (stored.providers !== undefined) {
    // "providers" has been saved before — even an empty array here is a
    // real, intentional state (the user deleted every provider), not a
    // signal to migrate old keys back in.
    providers = stored.providers;
    activeProviderId = stored.activeProviderId || providers[0]?.id || null;
  } else if (stored.apiKey) {
    // Migrate from the older single-provider settings format — only when
    // "providers" has never been saved at all.
    const p = {
      id: uid("p"),
      label: stored.provider === "anthropic" ? "Anthropic" : "OpenAI",
      type: stored.provider || "anthropic",
      apiKey: stored.apiKey,
      baseUrl: stored.baseUrl || "",
      models: stored.model ? [{ id: stored.model, label: stored.model }] : [],
      enabledModelIds: stored.model ? [stored.model] : [],
    };
    providers = [p];
    activeProviderId = p.id;
    await persistProviders();
  } else {
    providers = [];
  }

  agents = stored.agents || [];
  visionFallback = stored.visionFallback || null;
  scheduledTasks = stored.scheduledTasks || [];

  const limits = { ...DEFAULT_LIMITS, ...(stored.limits || {}) };
  limitMainStepsInput.value = limits.mainMaxSteps;
  limitBatchStepsInput.value = limits.batchStepLimit;
  limitMaxParallelTabsInput.value = limits.maxParallelTabs;
  limitBranchStepsInput.value = limits.branchMaxSteps;
  limitMaxSourcesInput.value = limits.maxSourcesPerTask;

  const pageCache = { ...DEFAULT_PAGE_CACHE, ...(stored.pageCache || {}) };
  pageCacheEnabledInput.checked = pageCache.enabled;
  pageCacheMaxEntriesInput.value = pageCache.maxEntries;

  // Reflects the ACTUAL granted permission, not just the stored preference —
  // the user can revoke an optional permission from chrome://extensions at
  // any time without going through this toggle, and that should win.
  const wantsTrustedInput = !!stored.trustedInputFallback?.enabled;
  const hasDebuggerPermission = await chrome.permissions.contains({ permissions: ["debugger"] });
  trustedInputEnabledInput.checked = wantsTrustedInput && hasDebuggerPermission;
  if (wantsTrustedInput && !hasDebuggerPermission) {
    // The permission was revoked out from under a saved "on" preference —
    // correct the stored state to match reality instead of silently lying
    // about it on the next drive() call.
    await chrome.storage.local.set({ trustedInputFallback: { enabled: false } });
  }

  renderProviders();
  renderAgents();
  renderVisionProviderFilterOptions();
  renderVisionFallbackOptions();
  renderScheduledList();
}

// Clamps to the input's own min/max (already set in options.html) and
// persists the full limits object — never partial, so a stored value is
// always complete even if only one field was ever touched.
async function saveLimitField(key, inputEl) {
  const min = Number(inputEl.min);
  const max = Number(inputEl.max);
  let value = Math.round(Number(inputEl.value));
  if (Number.isNaN(value)) value = DEFAULT_LIMITS[key];
  value = Math.min(max, Math.max(min, value));
  inputEl.value = value;

  const { limits: current = {} } = await chrome.storage.local.get(["limits"]);
  const updated = { ...DEFAULT_LIMITS, ...current, [key]: value };
  await chrome.storage.local.set({ limits: updated });

  limitsSavedHint.textContent = "Saved.";
  setTimeout(() => {
    if (limitsSavedHint.textContent === "Saved.") limitsSavedHint.textContent = "";
  }, 1500);
}

limitMainStepsInput.addEventListener("change", () => saveLimitField("mainMaxSteps", limitMainStepsInput));
limitBatchStepsInput.addEventListener("change", () => saveLimitField("batchStepLimit", limitBatchStepsInput));
limitMaxParallelTabsInput.addEventListener("change", () => saveLimitField("maxParallelTabs", limitMaxParallelTabsInput));
limitBranchStepsInput.addEventListener("change", () => saveLimitField("branchMaxSteps", limitBranchStepsInput));
limitMaxSourcesInput.addEventListener("change", () => saveLimitField("maxSourcesPerTask", limitMaxSourcesInput));

async function savePageCacheField(key, value) {
  const { pageCache: current = {} } = await chrome.storage.local.get(["pageCache"]);
  const updated = { ...DEFAULT_PAGE_CACHE, ...current, [key]: value };
  await chrome.storage.local.set({ pageCache: updated });

  pageCacheSavedHint.textContent = "Saved.";
  setTimeout(() => {
    if (pageCacheSavedHint.textContent === "Saved.") pageCacheSavedHint.textContent = "";
  }, 1500);
}

pageCacheEnabledInput.addEventListener("change", () => savePageCacheField("enabled", pageCacheEnabledInput.checked));
pageCacheMaxEntriesInput.addEventListener("change", () => {
  const min = Number(pageCacheMaxEntriesInput.min);
  const max = Number(pageCacheMaxEntriesInput.max);
  let value = Math.round(Number(pageCacheMaxEntriesInput.value));
  if (Number.isNaN(value)) value = DEFAULT_PAGE_CACHE.maxEntries;
  value = Math.min(max, Math.max(min, value));
  pageCacheMaxEntriesInput.value = value;
  savePageCacheField("maxEntries", value);
});

// chrome.permissions.request/remove must be called from a foreground
// extension page in direct response to a user gesture - this handler IS
// that gesture, which is why the permission dance lives here rather than in
// background.js (a service worker can't call chrome.permissions.request).
trustedInputEnabledInput.addEventListener("change", async () => {
  const wantsEnabled = trustedInputEnabledInput.checked;
  if (wantsEnabled) {
    const granted = await chrome.permissions.request({ permissions: ["debugger"] });
    if (!granted) {
      trustedInputEnabledInput.checked = false; // user declined the permission prompt
      return;
    }
  } else {
    await chrome.permissions.remove({ permissions: ["debugger"] }).catch(() => {});
  }
  await chrome.storage.local.set({ trustedInputFallback: { enabled: wantsEnabled } });
  trustedInputSavedHint.textContent = "Saved.";
  setTimeout(() => {
    if (trustedInputSavedHint.textContent === "Saved.") trustedInputSavedHint.textContent = "";
  }, 1500);
});

// --- providers ------------------------------------------------------

function renderProviders() {
  providerListEl.innerHTML = "";

  if (!providers.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No providers yet - add one below to get started.";
    providerListEl.appendChild(empty);
    return;
  }

  providers.forEach((p) => {
    const node = providerTemplate.content.firstElementChild.cloneNode(true);

    const labelInput = node.querySelector(".label-input");
    const providerEnabledInput = node.querySelector(".provider-enabled-input");
    const removeBtn = node.querySelector(".remove-btn");
    const typeSelect = node.querySelector(".type-select");
    const apiKeyInput = node.querySelector(".apikey-input");
    const apiKeyToggle = node.querySelector(".apikey-toggle");
    const eyeOpen = node.querySelector(".eye-open");
    const eyeClosed = node.querySelector(".eye-closed");
    const baseUrlInput = node.querySelector(".baseurl-input");
    const fetchBtn = node.querySelector(".fetch-models-btn");
    const spinnerEl = node.querySelector(".fetch-spinner");
    const modelsSection = node.querySelector(".models-section");
    const checklistEl = node.querySelector(".model-checklist");
    const selectAllBtn = node.querySelector(".select-all-btn");
    const selectNoneBtn = node.querySelector(".select-none-btn");
    const statusEl = node.querySelector(".model-status");
    const modelSearchInput = node.querySelector(".model-search-input");
    const modelSearchEmpty = node.querySelector(".model-search-empty");
    const modelViewButtons = node.querySelectorAll(".model-view-btn");

    // Resets to "all" on every full re-render of this card (same as the
    // search box's own value doing the same on a type change) — a
    // deliberately transient view preference, not something worth
    // persisting to storage.
    let modelViewMode = "all";
    const getModelViewMode = () => modelViewMode;

    labelInput.value = p.label || "";
    typeSelect.value = p.type;
    apiKeyInput.value = p.apiKey || "";
    baseUrlInput.value = p.baseUrl || "";
    // Back-compat default: providers saved before this switch existed have
    // no `enabled` field at all, and should keep behaving as enabled.
    providerEnabledInput.checked = p.enabled !== false;
    baseUrlInput.placeholder = p.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";

    const updateSummary = setupCollapsible(node, p.id, expandedProviderIds, () => {
      const typeLabel = p.type === "anthropic" ? "Anthropic" : "OpenAI-compatible";
      const enabledCount = (p.enabledModelIds || []).length;
      const modelPart = p.models && p.models.length ? `${enabledCount}/${p.models.length} models` : "no models fetched";
      const keyPart = p.apiKey ? "" : " · no API key";
      const disabledPart = p.enabled === false ? " · Disabled" : "";
      return { text: `${p.label || "Untitled provider"} · ${typeLabel} · ${modelPart}${keyPart}${disabledPart}` };
    });

    // The model checklist is persistent — show whatever was fetched last
    // time, every time this page is opened, not just right after fetching.
    renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary, getModelViewMode);
    if (p.models && p.models.length) modelsSection.classList.remove("hidden");

    modelSearchInput.addEventListener("input", () => {
      applyModelFilter(checklistEl, modelSearchInput.value, modelSearchEmpty, modelViewMode);
    });

    // All/Selected — filters which rows are shown, distinct from the
    // select-all-btn/select-none-btn pair below which act ON the checkboxes
    // themselves. Composes with the search box (see applyModelFilter).
    modelViewButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.view === modelViewMode) return;
        modelViewMode = btn.dataset.view;
        modelViewButtons.forEach((b) => b.classList.toggle("active", b === btn));
        applyModelFilter(checklistEl, modelSearchInput.value, modelSearchEmpty, modelViewMode);
      });
    });

    labelInput.addEventListener("input", () => {
      p.label = labelInput.value;
      updateSummary();
      persistProviders();
    });
    typeSelect.addEventListener("change", () => {
      p.type = typeSelect.value;
      baseUrlInput.placeholder = p.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";
      // The fetched model list belongs to the OLD provider type's API — a
      // model id from Anthropic means nothing to an OpenAI-compatible
      // endpoint and vice versa. Clear it so the checklist can't silently
      // carry over ids that don't exist for the newly selected type.
      if (p.models && p.models.length) {
        p.models = [];
        p.enabledModelIds = [];
        modelSearchInput.value = ""; // old search terms won't mean anything for the new API's model names
        renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary, getModelViewMode);
        modelsSection.classList.add("hidden");
        setStatus(statusEl, "Provider API changed - fetch models again for this API.");
      }
      updateSummary();
      persistProviders();
    });
    apiKeyInput.addEventListener("input", () => {
      p.apiKey = apiKeyInput.value;
      updateSummary();
      persistProviders();
    });
    apiKeyToggle.addEventListener("click", () => {
      const showing = apiKeyInput.type === "text";
      apiKeyInput.type = showing ? "password" : "text";
      eyeOpen.classList.toggle("hidden", !showing);
      eyeClosed.classList.toggle("hidden", showing);
    });
    baseUrlInput.addEventListener("input", () => {
      p.baseUrl = baseUrlInput.value;
      persistProviders();
    });
    providerEnabledInput.addEventListener("change", () => {
      p.enabled = providerEnabledInput.checked;
      updateSummary();
      persistProviders();
    });
    removeBtn.addEventListener("click", async () => {
      const ok = await showConfirm(`Remove provider "${p.label || p.type}"? This deletes its saved API key and model choices. This can't be undone.`);
      if (!ok) return;
      providers = providers.filter((x) => x.id !== p.id);
      if (activeProviderId === p.id) activeProviderId = providers[0]?.id || null;
      persistProviders();
      renderProviders();
      renderVisionProviderFilterOptions();
      renderVisionFallbackOptions();
      renderScheduledList();
    });

    // Scoped to whatever the search box AND the All/Selected toggle
    // currently match — so searching "gpt-4" then hitting All/None only
    // touches the gpt-4 variants, not the provider's entire model list, and
    // switching to "Selected" first scopes a bulk action to just what's
    // already enabled (e.g. None there is a quick "clear my selections").
    selectAllBtn.addEventListener("click", () => {
      const set = new Set(p.enabledModelIds || []);
      getFilteredModelIds(p, modelSearchInput, modelViewMode).forEach((id) => set.add(id));
      p.enabledModelIds = Array.from(set);
      renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary, getModelViewMode);
      updateSummary();
      persistProviders();
    });
    selectNoneBtn.addEventListener("click", () => {
      const visible = new Set(getFilteredModelIds(p, modelSearchInput, modelViewMode));
      p.enabledModelIds = (p.enabledModelIds || []).filter((id) => !visible.has(id));
      renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary, getModelViewMode);
      updateSummary();
      persistProviders();
    });

    // Always available — re-fetching merges into the existing checklist
    // instead of replacing it, so a new model release just shows up without
    // needing to recreate the provider. On a genuine RE-fetch (this
    // provider already had models), newly discovered models are added
    // UNCHECKED rather than auto-enabled — see the diff popup below, which
    // reports what changed instead of silently flipping checkboxes on your
    // behalf. A brand-new provider's very first fetch has nothing to diff
    // against, so it keeps the simpler "enable everything, get started"
    // behavior — requiring a manual click per model on initial setup would
    // just be friction with no real benefit.
    fetchBtn.addEventListener("click", async () => {
      if (!apiKeyInput.value.trim()) {
        setStatus(statusEl, "Enter an API key first.", "error");
        return;
      }
      fetchBtn.disabled = true;
      spinnerEl.classList.remove("hidden");
      setStatus(statusEl, "");

      let diff = null; // { added, removed } — only set on a re-fetch; checked after finally below

      try {
        const fetched = await listModels({ provider: p.type, apiKey: p.apiKey, baseUrl: p.baseUrl });

        if (!fetched.length) {
          // A genuinely-zero-model response looks identical here to a
          // transient hiccup (rate limit, a base URL that still answers 200
          // with nothing, etc.) — don't wipe a previously fetched list on
          // the strength of one empty response.
          if (p.models && p.models.length) {
            setStatus(statusEl, "Got an empty model list from this key - keeping your previously fetched models. Try again if that seems wrong.");
          } else {
            setStatus(statusEl, "No models found for this key.", "error");
          }
          return;
        }

        const previousModels = p.models || [];
        const isRefetch = previousModels.length > 0;
        const previousIds = new Set(previousModels.map((m) => m.id));
        const previousEnabled = new Set(p.enabledModelIds || []);
        const fetchedIds = new Set(fetched.map((m) => m.id));

        const enabled = new Set();
        const added = [];
        for (const m of fetched) {
          if (previousIds.has(m.id)) {
            if (previousEnabled.has(m.id)) enabled.add(m.id); // keep the user's prior choice
          } else if (isRefetch) {
            added.push(m); // newly discovered on a re-fetch — reported below, not auto-enabled
          } else {
            enabled.add(m.id); // first-ever fetch for this provider — nothing to compare against
          }
        }
        const removed = isRefetch ? previousModels.filter((m) => !fetchedIds.has(m.id)) : [];

        p.models = fetched;
        p.enabledModelIds = Array.from(enabled);
        renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary, getModelViewMode);
        modelsSection.classList.remove("hidden");

        if (isRefetch) {
          diff = { added, removed };
          setStatus(
            statusEl,
            added.length || removed.length ? `${fetched.length} model${fetched.length === 1 ? "" : "s"} available.` : "No changes - models are already up to date.",
            "ok"
          );
        } else {
          setStatus(statusEl, `${fetched.length} model${fetched.length === 1 ? "" : "s"} available.`, "ok");
        }

        updateSummary();
        await persistProviders();
        renderVisionProviderFilterOptions();
        renderVisionFallbackOptions();
        renderScheduledList();
      } catch (err) {
        setStatus(statusEl, `Could not fetch models: ${err.message || err}`, "error");
      } finally {
        fetchBtn.disabled = false;
        spinnerEl.classList.add("hidden");
      }

      // Outside try/finally on purpose — the button/spinner should already
      // be back to normal before this modal shows, since the fetch itself
      // is done at this point; the popup is a follow-up notice, not part of
      // the "fetching" state.
      if (diff && (diff.added.length || diff.removed.length)) {
        await showModelDiffPopup(p.label || p.type, diff.added, diff.removed);
      }
    });

    providerListEl.appendChild(node);
  });
}

// Live-filters an already-rendered checklist by hiding non-matching rows
// (rather than rebuilding the DOM), so typing in the search box doesn't
// disturb checkbox state or scroll position. Matches against the row's full
// visible text (label and/or id, whichever was rendered). viewMode
// "selected" ANDs in a second condition — the row's own checkbox must be
// checked — on top of the text match, so the All/Selected toggle composes
// with the search box instead of replacing it.
function applyModelFilter(checklistEl, query, emptyEl, viewMode = "all") {
  const q = query.trim().toLowerCase();
  const rows = checklistEl.querySelectorAll(".model-row-item");
  let anyVisible = false;
  rows.forEach((row) => {
    const textMatch = !q || row.textContent.toLowerCase().includes(q);
    const viewMatch = viewMode !== "selected" || row.querySelector("input[type=checkbox]")?.checked;
    const match = textMatch && viewMatch;
    row.classList.toggle("hidden", !match);
    if (match) anyVisible = true;
  });
  if (emptyEl) {
    emptyEl.textContent = viewMode === "selected" && q ? "No selected models match your search." : viewMode === "selected" ? "No models are selected yet." : "No models match your search.";
    emptyEl.classList.toggle("hidden", anyVisible || rows.length === 0);
  }
}

// The model ids currently matching the search box AND the current
// All/Selected view (or every model, if the search is empty and the view is
// "all") — used to scope the All/None bulk-action buttons to what's
// actually visible instead of the provider's whole list, the same principle
// the view toggle itself follows.
function getFilteredModelIds(p, searchInputEl, viewMode = "all") {
  const q = (searchInputEl?.value || "").trim().toLowerCase();
  const enabled = new Set(p.enabledModelIds || []);
  let models = p.models || [];
  if (viewMode === "selected") models = models.filter((m) => enabled.has(m.id));
  if (!q) return models.map((m) => m.id);
  return models.filter((m) => `${m.label || ""} ${m.id}`.toLowerCase().includes(q)).map((m) => m.id);
}

// getViewMode is a closure reading the per-card view-toggle state live —
// passed in rather than a snapshotted value, since the toggle can be
// clicked after this render already ran and the checkbox handler below
// needs to always re-filter against whatever's CURRENTLY selected, not
// whatever it was when the checklist was last rebuilt.
function renderChecklist(p, checklistEl, statusEl, searchInputEl, emptyEl, onToggle, getViewMode) {
  checklistEl.innerHTML = "";
  const models = p.models || [];
  const enabled = new Set(p.enabledModelIds || []);

  if (!models.length) {
    if (emptyEl) emptyEl.classList.add("hidden");
    return;
  }

  models.forEach((m) => {
    const row = document.createElement("label");
    row.className = "model-row-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = enabled.has(m.id);
    checkbox.addEventListener("change", () => {
      const set = new Set(p.enabledModelIds || []);
      if (checkbox.checked) set.add(m.id);
      else set.delete(m.id);
      p.enabledModelIds = Array.from(set);
      if (statusEl) setStatus(statusEl, `${p.enabledModelIds.length} of ${models.length} model${models.length === 1 ? "" : "s"} enabled.`);
      if (onToggle) onToggle();
      // Keeps the "Selected" view live — unchecking a row while it's the
      // only reason a currently-visible row matches should make it
      // disappear immediately, not just after the next full re-render.
      applyModelFilter(checklistEl, searchInputEl ? searchInputEl.value : "", emptyEl, getViewMode ? getViewMode() : "all");
      persistProviders();
    });
    const span = document.createElement("span");
    span.textContent = m.label || m.id;
    row.appendChild(checkbox);
    row.appendChild(span);
    checklistEl.appendChild(row);
  });

  applyModelFilter(checklistEl, searchInputEl ? searchInputEl.value : "", emptyEl, getViewMode ? getViewMode() : "all");
}

addProviderBtn.addEventListener("click", () => {
  const p = {
    id: uid("p"),
    label: `Provider ${providers.length + 1}`,
    type: "anthropic",
    apiKey: "",
    baseUrl: "",
    models: [],
    enabledModelIds: [],
  };
  providers.push(p);
  if (!activeProviderId) activeProviderId = p.id;
  expandedProviderIds.add(p.id); // new card starts expanded — nothing to summarize yet
  persistProviders();
  renderProviders();
});

// --- vision model (standalone) -----------------------------------------
// Deliberately NOT filtered by p.enabledModelIds (the chat checklist) — the
// vision model is its own independent assignment, not a "pick from your
// chat models" fallback. It just needs to be one of a provider's fetched
// models; whether that same model is also enabled for chat is unrelated.
// The main agent defers to this model only when it needs to understand an
// attached image and its own selected chat model doesn't look vision
// capable — see background.js's applyVisionFallback().

// Keeps the provider-filter dropdown's own option list in sync with
// `providers` — separate from renderVisionFallbackOptions() below since this
// one only needs to run when providers themselves change, not on every
// filter keystroke/change.
function renderVisionProviderFilterOptions() {
  const prevValue = visionProviderFilterSelect.value;
  visionProviderFilterSelect.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All providers";
  visionProviderFilterSelect.appendChild(allOpt);
  providers.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label || p.type;
    visionProviderFilterSelect.appendChild(opt);
  });
  // Keep whatever was selected if that provider still exists, otherwise
  // fall back to "All providers" rather than silently resolving to
  // whichever provider happens to be first in the list.
  if (Array.from(visionProviderFilterSelect.options).some((o) => o.value === prevValue)) {
    visionProviderFilterSelect.value = prevValue;
  }
}

// The provider filter narrows which provider's models are even considered;
// the text filter then searches only by model name/id WITHIN that scope
// (never against provider names) — so picking a provider is a hard scope
// restriction, and the text box is just a search inside it, not a second
// independent way to jump across providers.
function renderVisionFallbackOptions() {
  const providerFilter = visionProviderFilterSelect.value;
  const textFilter = visionModelFilterInput.value.trim().toLowerCase();
  const currentVal = visionFallback?.providerId ? `${visionFallback.providerId}::${visionFallback.modelId}` : "";

  visionFallbackSelect.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "None (send images as-is)";
  visionFallbackSelect.appendChild(noneOpt);

  const addedValues = new Set();
  const addOption = (p, m) => {
    const val = `${p.id}::${m.id}`;
    if (addedValues.has(val)) return;
    addedValues.add(val);
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = `${p.label || p.type} · ${m.label || m.id}`;
    visionFallbackSelect.appendChild(opt);
  };

  providers.forEach((p) => {
    if (providerFilter && p.id !== providerFilter) return;
    (p.models || []).forEach((m) => {
      const label = (m.label || m.id).toLowerCase();
      if (textFilter && !label.includes(textFilter) && !m.id.toLowerCase().includes(textFilter)) return;
      addOption(p, m);
    });
  });

  // Filters only control what's browsable, not what's actually set — if the
  // saved selection's provider/model doesn't match the current filters, pin
  // it back into the list anyway rather than letting the native <select>
  // silently lose it (there'd be no matching <option> left otherwise, and
  // the browser would just fall through to whatever option is first).
  if (currentVal && !addedValues.has(currentVal)) {
    const [pid, mid] = currentVal.split("::");
    const p = providers.find((x) => x.id === pid);
    const m = p?.models?.find((x) => x.id === mid);
    if (p && m) addOption(p, m);
  }

  if (visionFallback?.providerId) {
    if (addedValues.has(currentVal)) {
      visionFallbackSelect.value = currentVal;
    } else {
      // The provider was removed, or the model dropped out of a re-fetch —
      // don't just reset the dropdown's displayed value, actually clear the
      // stale reference. Otherwise getConfig() would silently fall back to
      // a DIFFERENT provider/model than what the UI implies is configured.
      visionFallback = null;
      visionFallbackSelect.value = "";
      persistVisionFallback();
    }
  } else {
    visionFallbackSelect.value = "";
  }
}

visionFallbackSelect.addEventListener("change", () => {
  if (!visionFallbackSelect.value) {
    visionFallback = null;
  } else {
    const [providerId, modelId] = visionFallbackSelect.value.split("::");
    visionFallback = { providerId, modelId };
  }
  persistVisionFallback();
});

// Filters only ever change what's rendered into visionFallbackSelect above
// (see renderVisionFallbackOptions) — they never touch visionFallback
// itself, so browsing around with them can't accidentally change or clear
// the actual saved setting.
visionProviderFilterSelect.addEventListener("change", renderVisionFallbackOptions);
visionModelFilterInput.addEventListener("input", renderVisionFallbackOptions);

// --- agents ------------------------------------------------------

function slugify(name) {
  return (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "agent";
}

function renderAgents() {
  agentListEl.innerHTML = "";

  if (!agents.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No agents yet - add one below, or use @agent_name in the side panel once you have.";
    agentListEl.appendChild(empty);
    return;
  }

  agents.forEach((a) => {
    const node = agentTemplate.content.firstElementChild.cloneNode(true);

    const nameInput = node.querySelector(".agent-name-input");
    const removeBtn = node.querySelector(".remove-btn");
    const slugInput = node.querySelector(".agent-slug-input");
    const descInput = node.querySelector(".agent-desc-input");
    const urlInput = node.querySelector(".agent-url-input");
    const instructionsInput = node.querySelector(".agent-instructions-input");
    const statusEl = node.querySelector(".agent-status");
    const saveBtn = node.querySelector(".agent-save-btn");

    nameInput.value = a.name || "";
    slugInput.value = a.slug || "";
    descInput.value = a.description || "";
    urlInput.value = a.targetUrl || "";
    instructionsInput.value = a.instructions || "";

    const updateSummary = setupCollapsible(node, a.id, expandedAgentIds, () => ({
      text: `${a.name || "Untitled agent"} · @${a.slug || "no-slug"}`,
    }));

    // Staged edits committed only via Save (or blur, for the auto-slug fill
    // below) — same reasoning as scheduled checks' saveTask(): a field that
    // wrote to storage on every keystroke gave no visible confirmation that
    // an edit had actually stuck, and there was no Save button to signal
    // "this is the moment it's committed."
    const saveAgent = async () => {
      a.name = nameInput.value;
      const clean = slugify(slugInput.value);
      const conflict = agents.some((other) => other !== a && other.slug === clean);
      if (conflict) {
        setStatus(statusEl, `@${clean} is already used by another agent.`, "error");
        return false;
      }
      setStatus(statusEl, "");
      a.slug = clean;
      slugInput.value = clean;
      a.description = descInput.value;
      a.targetUrl = urlInput.value;
      a.instructions = instructionsInput.value;
      a.updatedAt = Date.now();
      updateSummary();
      await persistAgents();
      return true;
    };

    const flashSaved = () => {
      const original = saveBtn.textContent;
      saveBtn.textContent = "Saved ✓";
      saveBtn.disabled = true;
      setTimeout(() => {
        saveBtn.textContent = original;
        saveBtn.disabled = false;
      }, 1200);
    };

    // Live UI feedback as you type — no persistence, just keeps the
    // collapsed summary and slug-conflict warning in sync while editing, the
    // same split scheduled checks use between "input" (live, unsaved) and
    // the explicit Save click (persisted).
    nameInput.addEventListener("input", updateSummary);
    nameInput.addEventListener("blur", () => {
      if (!slugInput.value.trim()) slugInput.value = slugify(nameInput.value);
    });
    slugInput.addEventListener("input", () => {
      const clean = slugify(slugInput.value);
      const conflict = agents.some((other) => other !== a && other.slug === clean);
      setStatus(statusEl, conflict ? `@${clean} is already used by another agent.` : "", conflict ? "error" : "");
      updateSummary();
    });

    saveBtn.addEventListener("click", async () => {
      const ok = await saveAgent();
      if (ok) flashSaved();
    });

    removeBtn.addEventListener("click", async () => {
      const ok = await showConfirm(`Remove agent "${a.name || a.slug}"? This can't be undone.`);
      if (!ok) return;
      agents = agents.filter((x) => x.id !== a.id);
      persistAgents();
      renderAgents();
    });

    agentListEl.appendChild(node);
  });
}

addAgentBtn.addEventListener("click", () => {
  const now = Date.now();
  const a = {
    id: uid("agent"),
    name: `Agent ${agents.length + 1}`,
    slug: slugify(`agent_${agents.length + 1}`),
    description: "",
    targetUrl: "",
    instructions: "",
    createdAt: now,
    updatedAt: now,
  };
  agents.push(a);
  expandedAgentIds.add(a.id);
  persistAgents();
  renderAgents();
});

// --- site access grants (adult/financial confirm-gate) -------------------

async function renderSiteAccessList() {
  const { siteAccessGrants = {} } = await chrome.storage.local.get(["siteAccessGrants"]);
  const entries = Object.entries(siteAccessGrants).sort((a, b) => (b[1].grantedAt || 0) - (a[1].grantedAt || 0));
  siteAccessListEl.innerHTML = "";

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No sites confirmed yet.";
    siteAccessListEl.appendChild(empty);
    return;
  }

  entries.forEach(([hostname, grant]) => {
    const row = document.createElement("div");
    row.className = "site-access-row";

    const info = document.createElement("span");
    info.className = "site-access-info";
    const categoryLabel = grant.category === "adult" ? "adult content" : "financial";
    const dateLabel = grant.grantedAt ? new Date(grant.grantedAt).toLocaleDateString() : "";
    info.innerHTML = `<strong>${hostname}</strong> · ${categoryLabel}${dateLabel ? ` · ${dateLabel}` : ""}`;
    row.appendChild(info);

    const revokeBtn = document.createElement("button");
    revokeBtn.type = "button";
    revokeBtn.className = "site-access-revoke";
    revokeBtn.textContent = "Revoke";
    revokeBtn.addEventListener("click", async () => {
      const { siteAccessGrants: current = {} } = await chrome.storage.local.get(["siteAccessGrants"]);
      delete current[hostname];
      await chrome.storage.local.set({ siteAccessGrants: current });
      renderSiteAccessList();
    });
    row.appendChild(revokeBtn);

    siteAccessListEl.appendChild(row);
  });
}

renderSiteAccessList();

// --- scheduled / recurring checks ----------------------------------------
// Storage + chrome.alarms scheduling live here (any extension page can call
// chrome.alarms with the "alarms" permission) — the actual run, when an
// alarm fires, happens in background.js since that's the context guaranteed
// to still be around (or get woken back up) even with Settings closed.
const SCHEDULED_TASK_ALARM_PREFIX = "scheduledTask|"; // must match background.js's copy of this constant
const MIN_INTERVAL_MINUTES = 1; // Chrome's own alarms floor for packed extensions — anything below this is silently clamped up to it regardless of what's configured, so there's no point allowing sub-minute values in the UI
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_ICON = { ok: "✓", error: "✗", needs_input: "⚠" };
const STATUS_CLASS = { ok: "ok", error: "fail", needs_input: "needs-input" };

// This page and background.js run in separate processes with no shared
// memory, so background.js's withStorageLock queue (see its comment) can't
// protect a write made from here — there's no equivalent lock this page can
// join. A scheduled run finishing (background.js writing runHistory/
// totalUsage/lastRun for some task) can land in the gap between this page
// loading its in-memory `scheduledTasks` snapshot and calling set(), and a
// blind `set({ scheduledTasks })` from that stale snapshot would silently
// revert whatever background.js just wrote — to the SAME task (its own
// run result gets clobbered) or a completely different one (an unrelated
// task's history/tokens vanish because this page never even saw them).
//
// Pass the id of the single task this page actually changed (save, enable
// toggle, add, remove, history/run-detail delete) and this re-reads storage
// right before writing, replacing ONLY that task in the fresh copy — so a
// concurrent background write to any other task, or to fields of this same
// task this page didn't touch, survives. Call with no id for a genuine bulk
// replace (import), where overwriting everything is the intended behavior.
async function persistScheduledTasks(touchedId) {
  if (!touchedId) {
    await chrome.storage.local.set({ scheduledTasks });
    return;
  }
  const { scheduledTasks: fresh = [] } = await chrome.storage.local.get(["scheduledTasks"]);
  const mine = scheduledTasks.find((t) => t.id === touchedId);
  const idx = fresh.findIndex((t) => t.id === touchedId);
  let merged;
  if (mine && idx !== -1) {
    merged = fresh.slice();
    merged[idx] = mine; // this page's edits to the touched task win outright
  } else if (mine && idx === -1) {
    merged = [...fresh, mine]; // a task this page just added
  } else {
    merged = fresh.filter((t) => t.id !== touchedId); // this page just deleted it
  }
  scheduledTasks = merged;
  await chrome.storage.local.set({ scheduledTasks: merged });
}

// A schemeless URL like "google.com" passed straight to chrome.tabs.create
// resolves relative to the extension itself (chrome-extension://<id>/...)
// instead of the real site — normalize on save so this never gets stored in
// the first place. background.js also normalizes defensively when it uses
// a task's URL, for anything saved before this existed or edited via import.
function normalizeTaskUrl(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) return trimmed;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

// Interval: fires every N minutes starting N minutes from now.
// Daily: fires once at the next occurrence of hour:minute (today if that
// time hasn't passed yet, otherwise tomorrow), then every 24h after that.
// Weekly: uses that same daily alarm as its underlying cadence — a single
// chrome.alarms period can't natively express "just these weekdays", so
// background.js's runScheduledTaskById checks schedule.days itself each
// time this fires and silently skips (not even counted as a run) on a day
// that isn't selected.
function computeAlarmSchedule(schedule) {
  if (schedule?.kind === "daily" || schedule?.kind === "weekly") {
    const now = new Date();
    const next = new Date(now);
    next.setHours(schedule.hour ?? 9, schedule.minute ?? 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return { delayInMinutes: Math.max(1, (next.getTime() - now.getTime()) / 60000), periodInMinutes: 1440 };
  }
  const minutes = Math.max(MIN_INTERVAL_MINUTES, schedule?.minutes || 60);
  return { delayInMinutes: minutes, periodInMinutes: minutes };
}

async function syncAlarmForTask(task) {
  const name = `${SCHEDULED_TASK_ALARM_PREFIX}${task.id}`;
  await chrome.alarms.clear(name);
  if (!task.enabled) return;
  const { delayInMinutes, periodInMinutes } = computeAlarmSchedule(task.schedule);
  await chrome.alarms.create(name, { delayInMinutes, periodInMinutes });
}

function scheduleDescription(schedule) {
  if (schedule?.kind === "daily") {
    const h = String(schedule.hour ?? 9).padStart(2, "0");
    const m = String(schedule.minute ?? 0).padStart(2, "0");
    return `Daily at ${h}:${m}`;
  }
  if (schedule?.kind === "weekly") {
    const h = String(schedule.hour ?? 9).padStart(2, "0");
    const m = String(schedule.minute ?? 0).padStart(2, "0");
    const days = Array.isArray(schedule.days) && schedule.days.length
      ? [...schedule.days].sort((a, b) => a - b).map((d) => DAY_LABELS[d]).join("/")
      : "no days selected";
    return `Weekly (${days}) at ${h}:${m}`;
  }
  const minutes = schedule?.minutes || 60;
  if (minutes % 1440 === 0 && minutes >= 1440) return `Every ${minutes / 1440}d`;
  if (minutes % 60 === 0 && minutes >= 60) return `Every ${minutes / 60}h`;
  return `Every ${minutes}m`;
}

// The interval UI lets you pick minutes/hours/days for convenience, but the
// only thing ever stored is schedule.minutes — these two just convert
// between that and whatever unit displays most naturally.
function minutesToDisplay(minutes) {
  const m = minutes || 60;
  if (m % 1440 === 0 && m >= 1440) return { value: m / 1440, unit: "days" };
  if (m % 60 === 0 && m >= 60) return { value: m / 60, unit: "hours" };
  return { value: m, unit: "minutes" };
}
function displayToMinutes(value, unit) {
  const n = Math.max(1, parseInt(value, 10) || 1);
  if (unit === "days") return n * 1440;
  if (unit === "hours") return n * 60;
  return Math.max(MIN_INTERVAL_MINUTES, n);
}

function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

// Back-compat: a task saved before runHistory/status existed only has
// task.lastRun with a boolean `success`, not a `status` string or an `id` —
// convert it into the same shape on the fly (marked synthetic so the
// history popup knows not to treat it as a real, deletable runHistory
// entry) rather than showing broken/inconsistent data for old tasks.
//
// Also backfills a missing `id` on real runHistory entries — any run
// recorded before id tracking was added to background.js lacks one, and
// several such entries all being `undefined` collapses to a single value in
// a Set, which is exactly what made the history popup's selection count get
// stuck at 1 no matter how many were checked. Mutates the entries in place
// (they're the actual stored objects, not copies) so the id sticks and the
// same value is used for both selecting AND deleting.
function getTaskHistory(task) {
  if (Array.isArray(task.runHistory)) {
    task.runHistory.forEach((entry) => {
      if (!entry.id) entry.id = `legacy_${entry.startedAt || Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    });
    return task.runHistory;
  }
  if (!task.lastRun) return [];
  return [{
    ...task.lastRun,
    id: task.lastRun.id || "legacy_last_run",
    status: task.lastRun.status || (task.lastRun.success === false ? "error" : "ok"),
    synthetic: true,
  }];
}

// --- scheduled-task history popup ----------------------------------------
// Replaces the old inline expand panel: for a task that can run every
// minute, an ever-growing panel embedded in the card was unusable, and it
// duplicated the latest run (shown both as its own block AND as the first
// history row). One popup, one list, each row expands in place for its full
// (markdown-rendered) text instead of a separate "latest" block.

const historyOverlay = document.getElementById("historyOverlay");
const historyTitleEl = document.getElementById("historyTitle");
const historyTotalTokensEl = document.getElementById("historyTotalTokens");
const historyCloseBtn = document.getElementById("historyCloseBtn");
const historySelectAll = document.getElementById("historySelectAll");
const historyDeleteSelectedBtn = document.getElementById("historyDeleteSelectedBtn");
const historyListEl = document.getElementById("historyList");
const historyRowTemplate = document.getElementById("historyRowTemplate");

let historySelectedIds = new Set();
let historyOpenTaskId = null;

function updateHistoryDeleteButtonState() {
  historyDeleteSelectedBtn.disabled = historySelectedIds.size === 0;
  historyDeleteSelectedBtn.textContent = historySelectedIds.size
    ? `Delete selected (${historySelectedIds.size})`
    : "Delete selected";
}

function buildHistoryRow(entry) {
  const li = historyRowTemplate.content.firstElementChild.cloneNode(true);
  const checkbox = li.querySelector(".history-row-checkbox");
  const toggleBtn = li.querySelector(".history-row-toggle");
  const iconEl = li.querySelector(".history-row-icon");
  const whenEl = li.querySelector(".history-row-when");
  const durationEl = li.querySelector(".history-row-duration");
  const tokensEl = li.querySelector(".history-row-tokens");
  const bodyEl = li.querySelector(".history-row-body");
  const markdownEl = li.querySelector(".history-row-markdown");

  li.classList.add(STATUS_CLASS[entry.status] || "");
  iconEl.textContent = STATUS_ICON[entry.status] || "?";
  iconEl.title = entry.status === "needs_input" ? "Needs input" : entry.status === "error" ? "Error" : "OK";
  whenEl.textContent = new Date(entry.finishedAt).toLocaleString();
  const durationSec = Math.max(0, Math.round(((entry.finishedAt || 0) - (entry.startedAt || 0)) / 1000));
  durationEl.textContent = durationSec >= 60 ? `${Math.round(durationSec / 60)}m` : `${durationSec}s`;
  const tok = (entry.usage?.inputTokens || 0) + (entry.usage?.outputTokens || 0);
  tokensEl.textContent = tok ? `${formatTokens(tok)} tok` : "-";

  checkbox.checked = historySelectedIds.has(entry.id);
  if (entry.synthetic) {
    // Predates the runHistory array (only task.lastRun exists) — nothing
    // real to delete here, so don't offer a checkbox for it.
    checkbox.disabled = true;
    checkbox.title = "This run predates history tracking and can't be individually deleted.";
  }
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) historySelectedIds.add(entry.id);
    else historySelectedIds.delete(entry.id);
    updateHistoryDeleteButtonState();
  });

  // Expand in place for the full (markdown-rendered) message — no separate
  // "latest run" block duplicating whatever the top row already shows.
  toggleBtn.addEventListener("click", () => {
    const stillHidden = bodyEl.classList.toggle("hidden");
    if (!stillHidden && !markdownEl.dataset.rendered) {
      markdownEl.innerHTML = window.TabAgentMarkdown.renderMarkdown(entry.summary || "_(no message)_");
      markdownEl.dataset.rendered = "1";
    }
  });

  return li;
}

function renderHistoryModal(task) {
  historyTitleEl.textContent = task.name || "Untitled check";
  const total = task.totalUsage || { inputTokens: 0, outputTokens: 0 };
  const totalTok = (total.inputTokens || 0) + (total.outputTokens || 0);
  const runCount = task.totalRunCount || (Array.isArray(task.runHistory) ? task.runHistory.length : 0);
  historyTotalTokensEl.textContent = totalTok
    ? `${formatTokens(totalTok)} tokens across ${runCount} run${runCount === 1 ? "" : "s"} total (includes runs deleted from the list below)`
    : `${runCount} run${runCount === 1 ? "" : "s"} total - no token usage recorded yet`;

  const history = getTaskHistory(task);
  historyListEl.innerHTML = "";
  if (!history.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No runs in history.";
    historyListEl.appendChild(empty);
  } else {
    history.forEach((entry) => historyListEl.appendChild(buildHistoryRow(entry)));
  }
  updateHistoryDeleteButtonState();
}

function closeHistoryModal() {
  historyOverlay.classList.add("hidden");
  popOverlay("history");
  historySelectedIds = new Set();
  historyOpenTaskId = null;
}

function showHistoryModal(task) {
  historyOpenTaskId = task.id;
  historySelectedIds = new Set();
  historySelectAll.checked = false;
  renderHistoryModal(task);
  historyOverlay.classList.remove("hidden");
  pushOverlay("history");
  historyCloseBtn.focus();
}

historyCloseBtn.addEventListener("click", closeHistoryModal);
historyOverlay.addEventListener("click", (e) => {
  if (e.target === historyOverlay) closeHistoryModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isTopOverlay("history")) closeHistoryModal();
});
historySelectAll.addEventListener("change", () => {
  Array.from(historyListEl.querySelectorAll(".history-row-checkbox")).forEach((cb) => {
    cb.checked = historySelectAll.checked;
    cb.dispatchEvent(new Event("change"));
  });
});
historyDeleteSelectedBtn.addEventListener("click", async () => {
  if (!historySelectedIds.size || !historyOpenTaskId) return;
  const n = historySelectedIds.size;
  const ok = await showConfirm(
    `Delete ${n} run${n === 1 ? "" : "s"} from this check's history? This can't be undone. (The automation's total token count isn't affected - it keeps counting deleted runs too.)`,
    "Delete"
  );
  if (!ok) return;
  // Re-fetch the live task by id rather than trusting whatever reference the
  // popup was opened with — a 1-minute-interval task could easily have
  // completed another run (or been edited) while this modal was open.
  const current = scheduledTasks.find((t) => t.id === historyOpenTaskId);
  if (!current) {
    closeHistoryModal();
    return;
  }
  const toDelete = historySelectedIds;
  current.runHistory = (current.runHistory || []).filter((entry) => !toDelete.has(entry.id));
  current.lastRun = current.runHistory[0] || null;
  await persistScheduledTasks(current.id);
  renderScheduledList();
  historySelectedIds = new Set();
  historySelectAll.checked = false;
  renderHistoryModal(current);
});

// --- single-run detail popup ---------------------------------------------
// Opened by clicking one of a card's 3 recent-run rows — a focused view of
// just that one run's full response, with its own delete action, instead of
// having to open the full history list for the common case of "what did the
// most recent run actually say."

const runDetailOverlay = document.getElementById("runDetailOverlay");
const runDetailTitleEl = document.getElementById("runDetailTitle");
const runDetailMetaEl = document.getElementById("runDetailMeta");
const runDetailMarkdownEl = document.getElementById("runDetailMarkdown");
const runDetailCloseBtn = document.getElementById("runDetailCloseBtn");
const runDetailDeleteBtn = document.getElementById("runDetailDeleteBtn");

let runDetailOpen = null; // { taskId, entryId }

function closeRunDetailPopup() {
  runDetailOverlay.classList.add("hidden");
  popOverlay("runDetail");
  runDetailOpen = null;
}

function showRunDetailPopup(entry, task) {
  runDetailOpen = { taskId: task.id, entryId: entry.id };
  runDetailTitleEl.textContent = task.name || "Untitled check";
  const when = new Date(entry.finishedAt).toLocaleString();
  const tok = (entry.usage?.inputTokens || 0) + (entry.usage?.outputTokens || 0);
  const statusWord = entry.status === "needs_input" ? "Needs input" : entry.status === "error" ? "Error" : "OK";
  runDetailMetaEl.textContent = `${statusWord} · ${when}${tok ? ` · ${formatTokens(tok)} tokens` : ""}`;
  runDetailMarkdownEl.innerHTML = window.TabAgentMarkdown.renderMarkdown(entry.summary || "_(no message)_");
  // The legacy synthetic entry (predates runHistory) isn't a real, separately
  // deletable record — same reasoning as the full history popup's checkbox.
  runDetailDeleteBtn.classList.toggle("hidden", !!entry.synthetic);
  runDetailOverlay.classList.remove("hidden");
  pushOverlay("runDetail");
  runDetailCloseBtn.focus();
}

runDetailCloseBtn.addEventListener("click", closeRunDetailPopup);
runDetailOverlay.addEventListener("click", (e) => {
  if (e.target === runDetailOverlay) closeRunDetailPopup();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isTopOverlay("runDetail")) closeRunDetailPopup();
});
runDetailDeleteBtn.addEventListener("click", async () => {
  if (!runDetailOpen) return;
  const ok = await showConfirm(
    "Delete this run from history? This can't be undone. (The automation's total token count isn't affected.)",
    "Delete"
  );
  if (!ok) return;
  const current = scheduledTasks.find((t) => t.id === runDetailOpen.taskId);
  if (!current) {
    closeRunDetailPopup();
    return;
  }
  const deletedId = runDetailOpen.entryId;
  current.runHistory = (current.runHistory || []).filter((entry) => entry.id !== deletedId);
  current.lastRun = current.runHistory[0] || null;
  await persistScheduledTasks(current.id);
  renderScheduledList();
  closeRunDetailPopup();
});

// Same provider-filter + model-filter narrowing as the standalone vision
// model picker above (renderVisionProviderFilterOptions/
// renderVisionFallbackOptions) — each scheduled task gets its own pair of
// filter controls rather than sharing one global pair, since each task has
// its own independent model assignment.
function renderSchedProviderFilterOptions(select) {
  const prevValue = select.value;
  select.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value = "";
  allOpt.textContent = "All providers";
  select.appendChild(allOpt);
  providers.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.label || p.type;
    select.appendChild(opt);
  });
  if (Array.from(select.options).some((o) => o.value === prevValue)) {
    select.value = prevValue;
  }
}

function renderSchedModelOptions(modelSelect, providerFilterSelect, modelFilterInput, task) {
  const providerFilter = providerFilterSelect.value;
  const textFilter = modelFilterInput.value.trim().toLowerCase();
  const currentVal = task.providerId ? `${task.providerId}::${task.modelId}` : "";

  modelSelect.innerHTML = "";
  const addedValues = new Set();
  const addOption = (p, m) => {
    const val = `${p.id}::${m.id}`;
    if (addedValues.has(val)) return;
    addedValues.add(val);
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = `${p.label || p.type} · ${m.label || m.id}`;
    modelSelect.appendChild(opt);
  };

  providers.forEach((p) => {
    if (providerFilter && p.id !== providerFilter) return;
    (p.models || []).forEach((m) => {
      const label = (m.label || m.id).toLowerCase();
      if (textFilter && !label.includes(textFilter) && !m.id.toLowerCase().includes(textFilter)) return;
      addOption(p, m);
    });
  });

  // Pin the task's current selection into the list even if the filters
  // above would otherwise hide it — narrowing the provider/text filter is
  // just browsing, and should never silently change what's actually saved
  // on this task (mirrors the vision picker's same guarantee).
  if (currentVal && !addedValues.has(currentVal)) {
    const [pid, mid] = currentVal.split("::");
    const p = providers.find((x) => x.id === pid);
    const m = p?.models?.find((x) => x.id === mid);
    if (p && m) addOption(p, m);
  }

  if (!modelSelect.options.length) {
    // Otherwise this just renders as an empty, unlabeled dropdown that
    // looks broken rather than explaining why there's nothing to pick.
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "No models available - add a provider first";
    placeholder.disabled = true;
    placeholder.selected = true;
    modelSelect.appendChild(placeholder);
    modelSelect.disabled = true;
    return;
  }
  modelSelect.disabled = false;

  if (currentVal && addedValues.has(currentVal)) {
    modelSelect.value = currentVal;
  } else {
    // The saved provider/model was actually removed (not just filtered out
    // by the two boxes above) - fall back to whatever's first in the
    // currently visible list, same as this used to do unconditionally.
    modelSelect.value = modelSelect.options[0].value;
    const [providerId, modelId] = modelSelect.value.split("::");
    task.providerId = providerId;
    task.modelId = modelId;
  }
}

function renderScheduledList() {
  scheduledListEl.innerHTML = "";

  if (!providers.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Add a provider above first - scheduled checks need a model to run with.";
    scheduledListEl.appendChild(empty);
  }

  if (!scheduledTasks.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No scheduled checks yet.";
    scheduledListEl.appendChild(empty);
    return;
  }

  scheduledTasks.forEach((task) => {
    const node = scheduledTemplate.content.firstElementChild.cloneNode(true);

    const nameInput = node.querySelector(".sched-name-input");
    const enabledInput = node.querySelector(".sched-enabled-input");
    const removeBtn = node.querySelector(".remove-btn");
    const urlInput = node.querySelector(".sched-url-input");
    const promptInput = node.querySelector(".sched-prompt-input");
    const notesInput = node.querySelector(".sched-notes-input");
    const providerFilterSelect = node.querySelector(".sched-provider-filter-select");
    const modelFilterInput = node.querySelector(".sched-model-filter-input");
    const modelSelect = node.querySelector(".sched-model-select");
    const kindSelect = node.querySelector(".sched-kind-select");
    const intervalInput = node.querySelector(".sched-interval-input");
    const intervalUnitSelect = node.querySelector(".sched-interval-unit-select");
    const timeInput = node.querySelector(".sched-time-input");
    const daysRow = node.querySelector(".sched-days-row");
    const dayInputs = Array.from(node.querySelectorAll(".sched-day-input"));
    const notifyInput = node.querySelector(".sched-notify-input");
    const runNowBtn = node.querySelector(".sched-run-now-btn");
    const saveBtn = node.querySelector(".sched-save-btn");
    const historyBtn = node.querySelector(".sched-history-btn");
    const recentRunsEl = node.querySelector(".sched-recent-runs");
    const runManuallyBtn = node.querySelector(".sched-run-manually-btn");

    // Name/URL/task/notes/model/schedule are staged edits, committed only
    // when Save (or Run now/Run manually, which save first) is clicked —
    // autosaving every keystroke here is what caused the focus-loss bug
    // fixed earlier, and it also meant a half-edited schedule could resync
    // the alarm mid-edit. Enabled stays immediate: it's a standalone toggle
    // switch, not "content" being edited, same as flipping any other switch.
    nameInput.value = task.name || "";
    enabledInput.checked = task.enabled !== false;
    urlInput.value = task.url || "";
    promptInput.value = task.prompt || "";
    notesInput.value = task.notes || "";
    notifyInput.checked = task.notify !== false;
    renderSchedProviderFilterOptions(providerFilterSelect);
    renderSchedModelOptions(modelSelect, providerFilterSelect, modelFilterInput, task);

    // Filters only ever change what's rendered into modelSelect above —
    // they never touch task.providerId/modelId themselves (see
    // renderSchedModelOptions' pin-back logic), same guarantee as the
    // vision model picker's own provider/text filters.
    providerFilterSelect.addEventListener("change", () => {
      renderSchedModelOptions(modelSelect, providerFilterSelect, modelFilterInput, task);
    });
    modelFilterInput.addEventListener("input", () => {
      renderSchedModelOptions(modelSelect, providerFilterSelect, modelFilterInput, task);
    });

    const schedule = task.schedule || { kind: "interval", minutes: 60 };
    kindSelect.value = schedule.kind || "interval";
    const disp = minutesToDisplay(schedule.minutes);
    intervalInput.value = disp.value;
    intervalUnitSelect.value = disp.unit;
    timeInput.value = `${String(schedule.hour ?? 9).padStart(2, "0")}:${String(schedule.minute ?? 0).padStart(2, "0")}`;
    const selectedDays = new Set(Array.isArray(schedule.days) ? schedule.days : []);
    dayInputs.forEach((el) => { el.checked = selectedDays.has(parseInt(el.value, 10)); });

    const updateSummary = setupCollapsible(node, task.id, expandedScheduledIds, () => {
      const disabledPart =
        task.enabled === false ? (task.disabledReason === "needs_input" ? " · needs input" : " · disabled") : "";
      return { text: `${task.name || "Untitled check"} · ${scheduleDescription(task.schedule)}${disabledPart}` };
    });

    const applyScheduleVisibility = () => {
      const kind = kindSelect.value;
      const isInterval = kind === "interval";
      const showTime = kind === "daily" || kind === "weekly";
      intervalInput.classList.toggle("hidden", !isInterval);
      intervalUnitSelect.classList.toggle("hidden", !isInterval);
      timeInput.classList.toggle("hidden", !showTime);
      daysRow.classList.toggle("hidden", kind !== "weekly");
      node.querySelector(".sched-schedule-row").title = scheduleDescription(task.schedule);
    };
    applyScheduleVisibility();

    // Live UI feedback as you type/select — no persistence, just keeps the
    // collapsed summary and field visibility in sync while editing.
    nameInput.addEventListener("input", updateSummary);
    kindSelect.addEventListener("change", applyScheduleVisibility);

    // Shows the 3 most recent runs directly in the card — no click needed
    // just to see recent activity. Each row opens the focused single-run
    // popup; the separate "History" button opens the full list (with
    // multi-select delete) for anything beyond these 3.
    const renderRecentRuns = () => {
      const liveTask = scheduledTasks.find((t) => t.id === task.id) || task;
      const history = getTaskHistory(liveTask);
      const latest = history[0] || null;
      runManuallyBtn.classList.toggle("hidden", !(latest && (latest.status === "needs_input" || latest.status === "error")));

      recentRunsEl.innerHTML = "";
      if (!history.length) {
        const li = document.createElement("li");
        li.className = "sched-recent-run-empty";
        li.textContent = "Never run yet.";
        recentRunsEl.appendChild(li);
        return;
      }
      history.slice(0, 3).forEach((entry) => {
        const li = document.createElement("li");
        li.className = `sched-recent-run ${STATUS_CLASS[entry.status] || ""}`;
        const icon = document.createElement("span");
        icon.className = "sched-recent-run-icon";
        icon.textContent = STATUS_ICON[entry.status] || "?";
        const when = document.createElement("span");
        when.className = "sched-recent-run-when";
        when.textContent = new Date(entry.finishedAt).toLocaleString();
        li.appendChild(icon);
        li.appendChild(when);
        li.addEventListener("click", () => {
          showRunDetailPopup(entry, scheduledTasks.find((t) => t.id === task.id) || task);
        });
        recentRunsEl.appendChild(li);
      });
    };
    renderRecentRuns();

    historyBtn.addEventListener("click", () => {
      // Re-find the live task rather than trusting this closure's reference
      // — it may be stale if storage changed since this card last rendered.
      showHistoryModal(scheduledTasks.find((t) => t.id === task.id) || task);
    });

    // Reads every staged field back into the task object and commits it —
    // shared by the Save button and by Run now/Run manually, so those
    // always act on exactly what's on screen rather than whatever was last
    // saved.
    const saveTask = async () => {
      task.name = nameInput.value;
      task.url = normalizeTaskUrl(urlInput.value);
      urlInput.value = task.url; // reflect the normalized (e.g. https:// prepended) form back to the field
      task.prompt = promptInput.value;
      task.notes = notesInput.value;
      task.notify = notifyInput.checked;
      const [providerId, modelId] = (modelSelect.value || "").split("::");
      if (providerId) {
        task.providerId = providerId;
        task.modelId = modelId;
      }
      task.schedule = task.schedule || {};
      task.schedule.kind = kindSelect.value;
      if (task.schedule.kind === "interval") {
        task.schedule.minutes = displayToMinutes(intervalInput.value, intervalUnitSelect.value);
      } else {
        const [h, m] = (timeInput.value || "09:00").split(":").map((n) => parseInt(n, 10));
        task.schedule.hour = h;
        task.schedule.minute = m;
        if (task.schedule.kind === "weekly") {
          task.schedule.days = dayInputs.filter((el) => el.checked).map((el) => parseInt(el.value, 10));
        }
      }
      task.updatedAt = Date.now();
      updateSummary();
      applyScheduleVisibility();
      await persistScheduledTasks(task.id);
      await syncAlarmForTask(task);
    };

    const flashSaved = () => {
      const original = saveBtn.textContent;
      saveBtn.textContent = "Saved ✓";
      saveBtn.disabled = true;
      setTimeout(() => {
        saveBtn.textContent = original;
        saveBtn.disabled = false;
      }, 1200);
    };

    saveBtn.addEventListener("click", async () => {
      await saveTask();
      flashSaved();
    });

    enabledInput.addEventListener("change", async () => {
      task.enabled = enabledInput.checked;
      if (task.enabled) delete task.disabledReason;
      task.updatedAt = Date.now();
      updateSummary();
      await persistScheduledTasks(task.id);
      await syncAlarmForTask(task);
    });

    runNowBtn.addEventListener("click", async () => {
      await saveTask();
      const originalLabel = runNowBtn.textContent;
      runNowBtn.disabled = true;
      runNowBtn.textContent = "Running…";
      chrome.runtime.sendMessage({ type: "RUN_SCHEDULED_TASK_NOW", id: task.id }, () => {
        // The actual result (and the recent-runs list refreshing to show it)
        // lands via chrome.storage.onChanged once background.js's run
        // finishes — re-enable the button after a beat so a slow run
        // doesn't leave it stuck disabled/mislabeled indefinitely.
        setTimeout(() => {
          runNowBtn.disabled = false;
          runNowBtn.textContent = originalLabel;
        }, 3000);
      });
    });

    runManuallyBtn.addEventListener("click", async () => {
      await saveTask();
      chrome.runtime.sendMessage({
        type: "OPEN_SCHEDULED_TASK_MANUAL",
        id: task.id,
        url: task.url,
        prompt: task.prompt,
        notes: task.notes,
      });
    });

    removeBtn.addEventListener("click", async () => {
      const ok = await showConfirm(`Remove scheduled check "${task.name || "Untitled"}"? This can't be undone.`);
      if (!ok) return;
      await chrome.alarms.clear(`${SCHEDULED_TASK_ALARM_PREFIX}${task.id}`);
      scheduledTasks = scheduledTasks.filter((t) => t.id !== task.id);
      await persistScheduledTasks(task.id);
      renderScheduledList();
    });

    scheduledListEl.appendChild(node);
  });
}

addScheduledBtn.addEventListener("click", async () => {
  const now = Date.now();
  const task = {
    id: uid("sched"),
    name: `Scheduled check ${scheduledTasks.length + 1}`,
    url: "",
    prompt: "",
    notes: "",
    providerId: null,
    modelId: null,
    schedule: { kind: "interval", minutes: 60, hour: 9, minute: 0, days: [] },
    enabled: false, // starts off — needs a URL/prompt filled in before it's useful
    notify: true,
    lastRun: null,
    runHistory: [],
    createdAt: now,
    updatedAt: now,
  };
  scheduledTasks.push(task);
  expandedScheduledIds.add(task.id);
  await persistScheduledTasks(task.id);
  renderScheduledList();
});

// Background.js writes lastRun back into storage when a run (scheduled or
// manual "Run now") finishes — refresh the list so status lines update live
// even though this page didn't trigger the write itself.
//
// This page ALSO writes scheduledTasks itself on every keystroke in a
// name/url/prompt field (see persistScheduledTasks() calls above), and
// chrome.storage.onChanged fires in the same context that made the write,
// not just other tabs. Without a guard, that self-triggered event would run
// renderScheduledList() after every single keypress, tearing down and
// rebuilding every input from scratch — which drops focus mid-word and is
// exactly what forces a re-click to keep typing. Since edit handlers here
// always mutate the in-memory `scheduledTasks` array before persisting it,
// a self-triggered event's newValue is just storage catching up to what we
// already have in memory — so only re-render when the incoming value is
// actually different, which means a genuine external change (another tab,
// or background.js updating lastRun).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.scheduledTasks) {
    const incoming = changes.scheduledTasks.newValue || [];
    const isExternalChange = JSON.stringify(incoming) !== JSON.stringify(scheduledTasks);
    scheduledTasks = incoming;
    if (isExternalChange) renderScheduledList();
  }
});

// --- backup: export / import settings -----------------------------------
// A belt-and-suspenders safety net independent of the extension-ID fix in
// manifest.json's "key" field — useful for moving to another machine, or as
// a plain backup, regardless of why storage might otherwise not carry over.

exportSettingsBtn?.addEventListener("click", async () => {
  const sections = await showBackupSectionsPicker(
    "Choose what to export",
    "Export",
    Object.keys(BACKUP_SECTION_LABELS).map((key) => ({ key, disabled: false }))
  );
  if (!sections) return; // cancelled

  const { siteAccessGrants = {}, themePreference = null } = await chrome.storage.local.get(["siteAccessGrants", "themePreference"]);
  const data = {
    version: 2, // bumped: v1 exports didn't include scheduledTasks/themePreference
    exportedAt: new Date().toISOString(),
  };
  // activeProviderId only means anything alongside providers, so it rides
  // along with that section rather than being its own checkbox.
  if (sections.has("providers")) {
    data.providers = providers;
    data.activeProviderId = activeProviderId;
  }
  if (sections.has("agents")) data.agents = agents;
  if (sections.has("visionFallback")) data.visionFallback = visionFallback;
  if (sections.has("siteAccessGrants")) data.siteAccessGrants = siteAccessGrants;
  if (sections.has("scheduledTasks")) data.scheduledTasks = scheduledTasks;
  if (sections.has("themePreference")) data.themePreference = themePreference;

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tab-agent-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  backupStatus.textContent = `Exported: ${Array.from(sections).map((s) => BACKUP_SECTION_LABELS[s]).join(", ")}.`;
});

importSettingsBtn?.addEventListener("click", () => importFileInput.click());

importFileInput?.addEventListener("change", async () => {
  const file = importFileInput.files?.[0];
  importFileInput.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const hasAnyKnownSection = data && typeof data === "object" && Object.keys(BACKUP_SECTION_LABELS).some((key) => key in data);
    if (!hasAnyKnownSection) {
      backupStatus.textContent = "That doesn't look like a Tab Agent settings export.";
      return;
    }

    // Every known section is always listed — ones this file doesn't have
    // show up disabled ("not in file") rather than being left out, so it's
    // obvious at a glance what won't be touched either way.
    const toApply = await showBackupSectionsPicker(
      "Choose what to import",
      "Import",
      Object.keys(BACKUP_SECTION_LABELS).map((key) => ({ key, disabled: !(key in data) }))
    );
    if (!toApply) return; // cancelled

    const ok = await showConfirm(
      `This replaces your current ${Array.from(toApply).map((s) => BACKUP_SECTION_LABELS[s]).join(", ")} with the ones in this file. This can't be undone. Continue?`,
      "Import"
    );
    if (!ok) return;

    if (toApply.has("providers")) {
      providers = Array.isArray(data.providers) ? data.providers : [];
      activeProviderId = data.activeProviderId || providers[0]?.id || null;
      await persistProviders();
    }
    if (toApply.has("agents")) {
      agents = Array.isArray(data.agents) ? data.agents : [];
      await persistAgents();
    }
    if (toApply.has("visionFallback")) {
      visionFallback = data.visionFallback || null;
      await persistVisionFallback();
    }
    if (toApply.has("scheduledTasks")) {
      // Alarms are keyed by task id and live outside chrome.storage, so
      // replacing the task list doesn't automatically clean them up. Diff
      // the old ids against the new file's ids BEFORE overwriting
      // scheduledTasks below, so an id that existed before the import but
      // isn't in the imported file gets its alarm cleared — otherwise it
      // would keep firing forever (harmlessly, since runScheduledTaskById
      // just no-ops when it can't find the task, but never cleaned up).
      const oldIds = new Set(scheduledTasks.map((t) => t.id));
      scheduledTasks = Array.isArray(data.scheduledTasks) ? data.scheduledTasks : [];
      const newIds = new Set(scheduledTasks.map((t) => t.id));
      await persistScheduledTasks();
      for (const oldId of oldIds) {
        if (!newIds.has(oldId)) await chrome.alarms.clear(`${SCHEDULED_TASK_ALARM_PREFIX}${oldId}`);
      }
      // Alarms aren't part of chrome.storage, so importing the task list
      // alone wouldn't actually schedule anything — resync each one
      // explicitly (this also clears any alarm for a check the import just
      // disabled).
      for (const task of scheduledTasks) await syncAlarmForTask(task);
    }
    if (toApply.has("siteAccessGrants") && data.siteAccessGrants && typeof data.siteAccessGrants === "object") {
      await chrome.storage.local.set({ siteAccessGrants: data.siteAccessGrants });
    }
    if (toApply.has("themePreference") && (data.themePreference === "light" || data.themePreference === "dark" || data.themePreference === null)) {
      await chrome.storage.local.set({ themePreference: data.themePreference });
    }

    renderProviders();
    renderAgents();
    renderVisionProviderFilterOptions();
    renderVisionFallbackOptions();
    renderScheduledList();
    renderSiteAccessList();
    backupStatus.textContent = `Imported: ${Array.from(toApply).map((s) => BACKUP_SECTION_LABELS[s]).join(", ")}.`;
  } catch (err) {
    backupStatus.textContent = `Could not import: ${err.message || err}`;
  }
});

load();
