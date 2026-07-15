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
const DEFAULT_LIMITS = { mainMaxSteps: 20, batchStepLimit: 150, maxParallelTabs: 5, branchMaxSteps: 20 };
const limitMainStepsInput = document.getElementById("limitMainSteps");
const limitBatchStepsInput = document.getElementById("limitBatchSteps");
const limitMaxParallelTabsInput = document.getElementById("limitMaxParallelTabs");
const limitBranchStepsInput = document.getElementById("limitBranchSteps");
const limitsSavedHint = document.getElementById("limitsSavedHint");

const exportSettingsBtn = document.getElementById("exportSettingsBtn");
const importSettingsBtn = document.getElementById("importSettingsBtn");
const importFileInput = document.getElementById("importFileInput");
const backupStatus = document.getElementById("backupStatus");

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
    micStatus.textContent = "✓ Microphone access granted — voice input will now work in the side panel. If it still shows an error there, close and reopen the panel.";
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
    confirmOkBtn.focus();

    const cleanup = (result) => {
      confirmOverlay.classList.add("hidden");
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
      if (e.key === "Escape") cleanup(false);
    };

    confirmOkBtn.addEventListener("click", onOk);
    confirmCancelBtn.addEventListener("click", onCancel);
    confirmOverlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
  });
}

// --- version indicator -------------------------------------------------

const appVersionEl = document.getElementById("appVersion");
if (appVersionEl) appVersionEl.textContent = `v${chrome.runtime.getManifest().version}`;

async function persistProviders() {
  await chrome.storage.local.set({ providers, activeProviderId });
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

  renderProviders();
  renderAgents();
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

// --- providers ------------------------------------------------------

function renderProviders() {
  providerListEl.innerHTML = "";

  if (!providers.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No providers yet — add one below to get started.";
    providerListEl.appendChild(empty);
    return;
  }

  providers.forEach((p) => {
    const node = providerTemplate.content.firstElementChild.cloneNode(true);

    const labelInput = node.querySelector(".label-input");
    const defaultRadio = node.querySelector(".default-radio input");
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

    labelInput.value = p.label || "";
    typeSelect.value = p.type;
    apiKeyInput.value = p.apiKey || "";
    baseUrlInput.value = p.baseUrl || "";
    defaultRadio.checked = p.id === activeProviderId;
    baseUrlInput.placeholder = p.type === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com";

    const updateSummary = setupCollapsible(node, p.id, expandedProviderIds, () => {
      const typeLabel = p.type === "anthropic" ? "Anthropic" : "OpenAI-compatible";
      const enabledCount = (p.enabledModelIds || []).length;
      const modelPart = p.models && p.models.length ? `${enabledCount}/${p.models.length} models` : "no models fetched";
      const keyPart = p.apiKey ? "" : " · no API key";
      const defaultPart = p.id === activeProviderId ? " · Default" : "";
      return { text: `${p.label || "Untitled provider"} — ${typeLabel} · ${modelPart}${keyPart}${defaultPart}` };
    });

    // The model checklist is persistent — show whatever was fetched last
    // time, every time this page is opened, not just right after fetching.
    renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary);
    if (p.models && p.models.length) modelsSection.classList.remove("hidden");

    modelSearchInput.addEventListener("input", () => {
      applyModelFilter(checklistEl, modelSearchInput.value, modelSearchEmpty);
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
        renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary);
        modelsSection.classList.add("hidden");
        setStatus(statusEl, "Provider API changed — fetch models again for this API.");
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
    defaultRadio.addEventListener("change", () => {
      activeProviderId = p.id;
      persistProviders();
      // Every card's summary line shows "· Default" only for the active
      // one, so a full re-render is the simplest way to keep them all in
      // sync (expand/collapse state survives via expandedProviderIds).
      renderProviders();
    });
    removeBtn.addEventListener("click", async () => {
      const ok = await showConfirm(`Remove provider "${p.label || p.type}"? This deletes its saved API key and model choices. This can't be undone.`);
      if (!ok) return;
      providers = providers.filter((x) => x.id !== p.id);
      if (activeProviderId === p.id) activeProviderId = providers[0]?.id || null;
      persistProviders();
      renderProviders();
      renderVisionFallbackOptions();
      renderScheduledList();
    });

    // Scoped to whatever the search box currently matches (all models, if
    // it's empty) — so searching "gpt-4" then hitting All/None only touches
    // the gpt-4 variants, not the provider's entire model list.
    selectAllBtn.addEventListener("click", () => {
      const set = new Set(p.enabledModelIds || []);
      getFilteredModelIds(p, modelSearchInput).forEach((id) => set.add(id));
      p.enabledModelIds = Array.from(set);
      renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary);
      updateSummary();
      persistProviders();
    });
    selectNoneBtn.addEventListener("click", () => {
      const visible = new Set(getFilteredModelIds(p, modelSearchInput));
      p.enabledModelIds = (p.enabledModelIds || []).filter((id) => !visible.has(id));
      renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary);
      updateSummary();
      persistProviders();
    });

    // Always available — re-fetching merges into the existing checklist
    // instead of replacing it, so a new model release just shows up
    // (checked by default) without needing to recreate the provider.
    fetchBtn.addEventListener("click", async () => {
      if (!apiKeyInput.value.trim()) {
        setStatus(statusEl, "Enter an API key first.", "error");
        return;
      }
      fetchBtn.disabled = true;
      spinnerEl.classList.remove("hidden");
      setStatus(statusEl, "");

      try {
        const fetched = await listModels({ provider: p.type, apiKey: p.apiKey, baseUrl: p.baseUrl });

        if (!fetched.length) {
          // A genuinely-zero-model response looks identical here to a
          // transient hiccup (rate limit, a base URL that still answers 200
          // with nothing, etc.) — don't wipe a previously fetched list on
          // the strength of one empty response.
          if (p.models && p.models.length) {
            setStatus(statusEl, "Got an empty model list from this key — keeping your previously fetched models. Try again if that seems wrong.");
          } else {
            setStatus(statusEl, "No models found for this key.", "error");
          }
          return;
        }

        const previousIds = new Set((p.models || []).map((m) => m.id));
        const previousEnabled = new Set(p.enabledModelIds || []);

        const enabled = new Set();
        let newCount = 0;
        for (const m of fetched) {
          if (previousIds.has(m.id)) {
            if (previousEnabled.has(m.id)) enabled.add(m.id); // keep the user's prior choice
          } else {
            enabled.add(m.id); // newly discovered model — on by default
            newCount += 1;
          }
        }

        p.models = fetched;
        p.enabledModelIds = Array.from(enabled);
        renderChecklist(p, checklistEl, statusEl, modelSearchInput, modelSearchEmpty, updateSummary);
        modelsSection.classList.remove("hidden");

        setStatus(statusEl, `${fetched.length} model${fetched.length === 1 ? "" : "s"} available${newCount ? ` (${newCount} new, enabled by default)` : ""}.`, "ok");
        updateSummary();
        await persistProviders();
        renderVisionFallbackOptions();
        renderScheduledList();
      } catch (err) {
        setStatus(statusEl, `Could not fetch models: ${err.message || err}`, "error");
      } finally {
        fetchBtn.disabled = false;
        spinnerEl.classList.add("hidden");
      }
    });

    providerListEl.appendChild(node);
  });
}

// Live-filters an already-rendered checklist by hiding non-matching rows
// (rather than rebuilding the DOM), so typing in the search box doesn't
// disturb checkbox state or scroll position. Matches against the row's full
// visible text (label and/or id, whichever was rendered).
function applyModelFilter(checklistEl, query, emptyEl) {
  const q = query.trim().toLowerCase();
  const rows = checklistEl.querySelectorAll(".model-row-item");
  let anyVisible = false;
  rows.forEach((row) => {
    const match = !q || row.textContent.toLowerCase().includes(q);
    row.classList.toggle("hidden", !match);
    if (match) anyVisible = true;
  });
  if (emptyEl) emptyEl.classList.toggle("hidden", anyVisible || rows.length === 0);
}

// The model ids currently matching the search box (or every model, if it's
// empty) — used to scope the All/None bulk actions to what's actually
// visible instead of the provider's whole list.
function getFilteredModelIds(p, searchInputEl) {
  const q = (searchInputEl?.value || "").trim().toLowerCase();
  const models = p.models || [];
  if (!q) return models.map((m) => m.id);
  return models.filter((m) => `${m.label || ""} ${m.id}`.toLowerCase().includes(q)).map((m) => m.id);
}

function renderChecklist(p, checklistEl, statusEl, searchInputEl, emptyEl, onToggle) {
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
      persistProviders();
    });
    const span = document.createElement("span");
    span.textContent = m.label || m.id;
    row.appendChild(checkbox);
    row.appendChild(span);
    checklistEl.appendChild(row);
  });

  applyModelFilter(checklistEl, searchInputEl ? searchInputEl.value : "", emptyEl);
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

function renderVisionFallbackOptions() {
  visionFallbackSelect.innerHTML = "";
  const noneOpt = document.createElement("option");
  noneOpt.value = "";
  noneOpt.textContent = "None (send images as-is)";
  visionFallbackSelect.appendChild(noneOpt);

  providers.forEach((p) => {
    (p.models || []).forEach((m) => {
      const opt = document.createElement("option");
      opt.value = `${p.id}::${m.id}`;
      opt.textContent = `${p.label || p.type} · ${m.label || m.id}`;
      visionFallbackSelect.appendChild(opt);
    });
  });

  if (visionFallback?.providerId) {
    const val = `${visionFallback.providerId}::${visionFallback.modelId}`;
    if (Array.from(visionFallbackSelect.options).some((o) => o.value === val)) {
      visionFallbackSelect.value = val;
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
    empty.textContent = "No agents yet — add one below, or use /agent_name in the side panel once you have.";
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

    nameInput.value = a.name || "";
    slugInput.value = a.slug || "";
    descInput.value = a.description || "";
    urlInput.value = a.targetUrl || "";
    instructionsInput.value = a.instructions || "";

    const updateSummary = setupCollapsible(node, a.id, expandedAgentIds, () => ({
      text: `${a.name || "Untitled agent"} — /${a.slug || "no-slug"}`,
    }));

    nameInput.addEventListener("input", () => {
      a.name = nameInput.value;
      a.updatedAt = Date.now();
      updateSummary();
      persistAgents();
    });
    nameInput.addEventListener("blur", () => {
      if (!slugInput.value.trim()) {
        slugInput.value = slugify(nameInput.value);
        a.slug = slugInput.value;
        updateSummary();
        persistAgents();
      }
    });
    slugInput.addEventListener("input", () => {
      const clean = slugify(slugInput.value);
      const conflict = agents.some((other) => other !== a && other.slug === clean);
      if (conflict) {
        setStatus(statusEl, `/${clean} is already used by another agent.`, "error");
        return;
      }
      setStatus(statusEl, "");
      a.slug = clean;
      a.updatedAt = Date.now();
      updateSummary();
      persistAgents();
    });
    descInput.addEventListener("input", () => {
      a.description = descInput.value;
      a.updatedAt = Date.now();
      persistAgents();
    });
    urlInput.addEventListener("input", () => {
      a.targetUrl = urlInput.value;
      a.updatedAt = Date.now();
      persistAgents();
    });
    instructionsInput.addEventListener("input", () => {
      a.instructions = instructionsInput.value;
      a.updatedAt = Date.now();
      persistAgents();
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
    info.innerHTML = `<strong>${hostname}</strong> — ${categoryLabel}${dateLabel ? ` · ${dateLabel}` : ""}`;
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
const MIN_INTERVAL_MINUTES = 5; // floor well above Chrome's 1-minute alarm minimum, to avoid hammering a page/API

async function persistScheduledTasks() {
  await chrome.storage.local.set({ scheduledTasks });
}

// Interval: fires every N minutes starting N minutes from now.
// Daily: fires once at the next occurrence of hour:minute (today if that
// time hasn't passed yet, otherwise tomorrow), then every 24h after that.
function computeAlarmSchedule(schedule) {
  if (schedule?.kind === "daily") {
    const now = new Date();
    const next = new Date(now);
    next.setHours(schedule.hour ?? 9, schedule.minute ?? 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return { delayInMinutes: Math.max(1, (next.getTime() - now.getTime()) / 60000), periodInMinutes: 1440 };
  }
  const minutes = Math.max(MIN_INTERVAL_MINUTES, schedule?.minutes || MIN_INTERVAL_MINUTES);
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
  const minutes = schedule?.minutes || MIN_INTERVAL_MINUTES;
  return minutes % 60 === 0 && minutes >= 60 ? `Every ${minutes / 60}h` : `Every ${minutes}m`;
}

function lastRunLabel(lastRun) {
  if (!lastRun) return { text: "Never run yet.", cls: "" };
  const when = new Date(lastRun.finishedAt).toLocaleString();
  const summary = (lastRun.summary || "").replace(/\s+/g, " ").trim().slice(0, 140);
  const text = `${lastRun.success ? "✓" : "✗"} ${when}${summary ? ` — ${summary}` : ""}`;
  return { text, cls: lastRun.success ? "ok" : "fail" };
}

function populateScheduledModelSelect(select, task) {
  select.innerHTML = "";
  providers.forEach((p) => {
    (p.models || []).forEach((m) => {
      const opt = document.createElement("option");
      opt.value = `${p.id}::${m.id}`;
      opt.textContent = `${p.label || p.type} · ${m.label || m.id}`;
      select.appendChild(opt);
    });
  });

  if (!select.options.length) {
    // Otherwise this just renders as an empty, unlabeled dropdown that
    // looks broken rather than explaining why there's nothing to pick.
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "No models available — add a provider first";
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    select.disabled = true;
    return;
  }
  select.disabled = false;

  const val = task.providerId ? `${task.providerId}::${task.modelId}` : "";
  if (val && Array.from(select.options).some((o) => o.value === val)) {
    select.value = val;
  } else {
    select.value = select.options[0].value;
    const [providerId, modelId] = select.value.split("::");
    task.providerId = providerId;
    task.modelId = modelId;
  }
}

function renderScheduledList() {
  scheduledListEl.innerHTML = "";

  if (!providers.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Add a provider above first — scheduled checks need a model to run with.";
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
    const modelSelect = node.querySelector(".sched-model-select");
    const kindSelect = node.querySelector(".sched-kind-select");
    const intervalInput = node.querySelector(".sched-interval-input");
    const intervalUnit = node.querySelector(".sched-interval-unit");
    const timeInput = node.querySelector(".sched-time-input");
    const notifyInput = node.querySelector(".sched-notify-input");
    const runNowBtn = node.querySelector(".sched-run-now-btn");
    const statusEl = node.querySelector(".sched-status");

    nameInput.value = task.name || "";
    enabledInput.checked = task.enabled !== false;
    urlInput.value = task.url || "";
    promptInput.value = task.prompt || "";
    notifyInput.checked = task.notify !== false;
    populateScheduledModelSelect(modelSelect, task);

    const schedule = task.schedule || { kind: "interval", minutes: 60 };
    kindSelect.value = schedule.kind || "interval";
    intervalInput.value = schedule.minutes || 60;
    timeInput.value = `${String(schedule.hour ?? 9).padStart(2, "0")}:${String(schedule.minute ?? 0).padStart(2, "0")}`;

    const updateSummary = setupCollapsible(node, task.id, expandedScheduledIds, () => {
      const disabledPart = task.enabled === false ? " · disabled" : "";
      return { text: `${task.name || "Untitled check"} — ${scheduleDescription(task.schedule)}${disabledPart}` };
    });

    const applyScheduleVisibility = () => {
      const isDaily = kindSelect.value === "daily";
      intervalInput.classList.toggle("hidden", isDaily);
      intervalUnit.classList.toggle("hidden", isDaily);
      timeInput.classList.toggle("hidden", !isDaily);
      node.querySelector(".sched-schedule-row").title = scheduleDescription(task.schedule);
      updateSummary();
    };
    applyScheduleVisibility();

    const { text: statusText, cls: statusCls } = lastRunLabel(task.lastRun);
    statusEl.textContent = statusText;
    statusEl.className = `sched-status ${statusCls}`;

    const persistAndResync = async () => {
      task.updatedAt = Date.now();
      await persistScheduledTasks();
      await syncAlarmForTask(task);
    };

    nameInput.addEventListener("input", () => {
      task.name = nameInput.value;
      updateSummary();
      persistScheduledTasks();
    });
    enabledInput.addEventListener("change", () => {
      task.enabled = enabledInput.checked;
      updateSummary();
      persistAndResync();
    });
    urlInput.addEventListener("input", () => {
      task.url = urlInput.value;
      persistScheduledTasks();
    });
    promptInput.addEventListener("input", () => {
      task.prompt = promptInput.value;
      persistScheduledTasks();
    });
    modelSelect.addEventListener("change", () => {
      const [providerId, modelId] = modelSelect.value.split("::");
      task.providerId = providerId;
      task.modelId = modelId;
      persistScheduledTasks();
    });
    kindSelect.addEventListener("change", () => {
      task.schedule = task.schedule || {};
      task.schedule.kind = kindSelect.value;
      applyScheduleVisibility();
      persistAndResync();
    });
    intervalInput.addEventListener("change", () => {
      task.schedule = task.schedule || { kind: "interval" };
      task.schedule.minutes = Math.max(MIN_INTERVAL_MINUTES, parseInt(intervalInput.value, 10) || MIN_INTERVAL_MINUTES);
      intervalInput.value = task.schedule.minutes;
      updateSummary();
      persistAndResync();
    });
    timeInput.addEventListener("change", () => {
      const [h, m] = (timeInput.value || "09:00").split(":").map((n) => parseInt(n, 10));
      task.schedule = task.schedule || { kind: "daily" };
      task.schedule.hour = h;
      task.schedule.minute = m;
      updateSummary();
      persistAndResync();
    });
    notifyInput.addEventListener("change", () => {
      task.notify = notifyInput.checked;
      persistScheduledTasks();
    });
    runNowBtn.addEventListener("click", () => {
      runNowBtn.disabled = true;
      statusEl.textContent = "Running…";
      statusEl.className = "sched-status";
      chrome.runtime.sendMessage({ type: "RUN_SCHEDULED_TASK_NOW", id: task.id }, () => {
        // The actual result lands via chrome.storage.onChanged (scheduledTasks)
        // once background.js's run finishes — re-enable the button after a
        // beat so a slow run doesn't leave it stuck disabled indefinitely.
        setTimeout(() => { runNowBtn.disabled = false; }, 3000);
      });
    });
    removeBtn.addEventListener("click", async () => {
      const ok = await showConfirm(`Remove scheduled check "${task.name || "Untitled"}"? This can't be undone.`);
      if (!ok) return;
      await chrome.alarms.clear(`${SCHEDULED_TASK_ALARM_PREFIX}${task.id}`);
      scheduledTasks = scheduledTasks.filter((t) => t.id !== task.id);
      await persistScheduledTasks();
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
    providerId: null,
    modelId: null,
    schedule: { kind: "interval", minutes: 60, hour: 9, minute: 0 },
    enabled: false, // starts off — needs a URL/prompt filled in before it's useful
    notify: true,
    lastRun: null,
    createdAt: now,
    updatedAt: now,
  };
  scheduledTasks.push(task);
  expandedScheduledIds.add(task.id);
  await persistScheduledTasks();
  renderScheduledList();
});

// Background.js writes lastRun back into storage when a run (scheduled or
// manual "Run now") finishes — refresh the list so status lines update live
// even though this page didn't trigger the write itself.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.scheduledTasks) {
    scheduledTasks = changes.scheduledTasks.newValue || [];
    renderScheduledList();
  }
});

// --- backup: export / import settings -----------------------------------
// A belt-and-suspenders safety net independent of the extension-ID fix in
// manifest.json's "key" field — useful for moving to another machine, or as
// a plain backup, regardless of why storage might otherwise not carry over.

exportSettingsBtn?.addEventListener("click", async () => {
  const { siteAccessGrants = {}, themePreference = null } = await chrome.storage.local.get(["siteAccessGrants", "themePreference"]);
  const data = {
    version: 2, // bumped: v1 exports didn't include scheduledTasks/themePreference
    exportedAt: new Date().toISOString(),
    providers,
    activeProviderId,
    agents,
    visionFallback,
    siteAccessGrants,
    scheduledTasks,
    themePreference,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `tab-agent-settings-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  backupStatus.textContent = `Exported ${providers.length} provider${providers.length === 1 ? "" : "s"}, ${agents.length} agent${agents.length === 1 ? "" : "s"}, and ${scheduledTasks.length} scheduled check${scheduledTasks.length === 1 ? "" : "s"}.`;
});

importSettingsBtn?.addEventListener("click", () => importFileInput.click());

importFileInput?.addEventListener("change", async () => {
  const file = importFileInput.files?.[0];
  importFileInput.value = "";
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || (!Array.isArray(data.providers) && !Array.isArray(data.agents))) {
      backupStatus.textContent = "That doesn't look like a Tab Agent settings export.";
      return;
    }
    const ok = await showConfirm(
      "This replaces your current providers, agents, vision model setting, scheduled checks, and theme with the ones in this file. This can't be undone. Continue?",
      "Import"
    );
    if (!ok) return;

    providers = Array.isArray(data.providers) ? data.providers : [];
    activeProviderId = data.activeProviderId || providers[0]?.id || null;
    agents = Array.isArray(data.agents) ? data.agents : [];
    visionFallback = data.visionFallback || null;
    scheduledTasks = Array.isArray(data.scheduledTasks) ? data.scheduledTasks : [];

    await persistProviders();
    await persistAgents();
    await persistVisionFallback();
    await persistScheduledTasks();
    // Alarms aren't part of chrome.storage, so importing the task list alone
    // wouldn't actually schedule anything — resync each one explicitly (this
    // also clears any alarm for a check the import just disabled).
    for (const task of scheduledTasks) await syncAlarmForTask(task);

    if (data.siteAccessGrants && typeof data.siteAccessGrants === "object") {
      await chrome.storage.local.set({ siteAccessGrants: data.siteAccessGrants });
    }
    if (data.themePreference === "light" || data.themePreference === "dark" || data.themePreference === null) {
      await chrome.storage.local.set({ themePreference: data.themePreference });
    }

    renderProviders();
    renderAgents();
    renderVisionFallbackOptions();
    renderScheduledList();
    renderSiteAccessList();
    backupStatus.textContent = `Imported ${providers.length} provider${providers.length === 1 ? "" : "s"}, ${agents.length} agent${agents.length === 1 ? "" : "s"}, and ${scheduledTasks.length} scheduled check${scheduledTasks.length === 1 ? "" : "s"}.`;
  } catch (err) {
    backupStatus.textContent = `Could not import: ${err.message || err}`;
  }
});

load();
