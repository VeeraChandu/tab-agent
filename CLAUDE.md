# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tab Agent is a Chrome (Manifest V3) extension that runs an agentic read → decide → act loop directly
in the browser: it reads the current page, asks a model (Anthropic or any OpenAI-compatible API) what
to do next, executes the chosen tool (click, type, scroll, navigate, switch tabs, etc.), and repeats
until the model calls `finish`. No MCP server, no backend — API calls go straight from the browser to
whatever provider the user configured in Settings.

## Commands

There is no build step for development — this is a plain unpacked extension.

- **Load/reload in Chrome**: `chrome://extensions` → enable Developer mode → **Load unpacked** →
  select this folder. After editing background.js/lib files, click the ↻ reload icon on the
  extension card; after editing content.js, also reload any already-open tab you're testing on.
- **Lint**: `npm run lint` (ESLint flat config, `eslint.config.js`)
- **Test**: `npm test` (Jest). Run a single file with `npm test -- lib/pricing.test.js` or a single
  case with `npm test -- -t "name of test"`.
- **Build a release zip**: `npm run build` — writes `dist/tab-agent-<version>.zip` and syncs
  `manifest.json`'s `version` field to `package.json`'s version.
- **Release**: pushes to `main` trigger `.github/workflows/release.yml`, which runs lint → test →
  build → `semantic-release`. Version bumps and the published zip asset are entirely derived from
  Conventional Commits messages (`fix:`, `feat:`, `feat!:`/`BREAKING CHANGE:`, etc.) — there is no
  manual version bump.

## Architecture

### Three execution contexts, one message protocol

Chrome extension pages don't share a JS runtime, so the pieces talk over `chrome.runtime.onMessage` /
`chrome.tabs.sendMessage`, keyed by a `msg.type` string:

- **`background.js`** — the MV3 service worker (ES module) and the only long-lived coordinator. Owns
  session/chat persistence (`chrome.storage.local`), agent presets, the vision-fallback decision, and
  every `chrome.runtime.onMessage` handler (`RUN_TASK`, `ANSWER_QUESTION`, `COMPACT_SESSION`,
  `STEP_LIMIT_RESPONSE`, `SITE_GATE_RESPONSE`, `RESUME_BRANCH`, `SKIP_SUBTASKS`, `STOP_TASK`,
  `RUN_SCHEDULED_TASK_NOW`, `FOCUS_TAB`, `REOPEN_TAB`). It does not touch the DOM of any page directly
  — it drives `lib/agentLoop.js`, which in turn messages `content.js` on the target tab.
- **`content.js`** — injected into every page (`document_idle`). Scans interactive elements and tags
  each with a short id (`e12`, `e5`, ...) and sizable on-page images (`img3`, ...), and exposes the
  primitive actions the agent loop calls: click, type, scroll, extract table. Runs once per page load,
  so ids are only valid until the next scan (see stale-element recovery below).
- **`sidepanel.js`** / **`options.js`** — the two UI surfaces. Side panel is the chat; Options is
  provider/agent/limits/scheduled-task configuration. Both are plain scripts driven by
  `chrome.runtime.sendMessage` round-trips to background.js — neither talks to a provider API or a tab
  directly.

### The agent loop (`lib/agentLoop.js`)

`runAgentTask()` is the entry point for a normal turn: read page → call the model via
`lib/providers.js` → execute the returned tool call via `executeTool()` → repeat, capped by
`limits.mainMaxSteps` (default 20; background.js pauses and asks the user to continue rather than
silently stopping at the cap).

Three tools recurse back into the loop machinery rather than being simple one-shot actions, all
sharing `runSubLoop()`:

- **`parallel_investigate`** — fans out to multiple tabs (`runOneBranch()` per task, capped by
  `limits.maxParallelTabs`), each running its own bounded sub-loop with its own step budget
  (`limits.branchMaxSteps`). `resumeBranch()` (exported, called from background.js's `RESUME_BRANCH`
  handler) lets a branch that hit its step ceiling continue with a fresh budget on the *same* tab.
- **`run_batch`** — one long uninterrupted sub-loop (`limits.batchStepLimit`, default 150) for
  repetitive multi-page work (e.g. paginated scraping) that would blow the main loop's step budget.
- Both share two independent, differently-scoped abort signals threaded through `ctx`:
  `ctx.shouldStop` aborts the *entire* run (global Stop button) and is checked by the main loop too;
  `ctx.shouldSkip`/`ctx.shouldSkipSubtasks` ends only the current branch/batch sub-loop and is **never**
  read by the main loop's own iteration — this is what lets "skip remaining, continue" actually
  continue instead of ending the whole task. It's backed by `activeRun.skipSubtasks` in background.js
  and reset at the start of every `parallel_investigate`/`run_batch` call so a stale flag can't bleed
  into a later, unrelated call.

Two independent stuck-loop guards exist and must stay independent:

- `checkRepeatedAction()` — global (main loop + sub-loops), catches identical click/type_text calls
  producing no page change.
- `checkExplorationStreak()` — scoped **only** to `parallel_investigate` branches via
  `ctx.explorationGuard = true` (set in `runOneBranch`/`resumeBranch`, never in `runBatch` or the main
  loop). Catches a branch burning its whole step budget on read_page/scroll/extract_table/view_image/
  filter_images with no click/navigate in between (nudges at 7 consecutive steps, hard-stops at 12).
  It must **not** apply to `run_batch`, whose entire purpose is long uninterrupted scroll/extract
  sequences that this guard would otherwise false-positive on.

Other things worth knowing before touching this file:
- `ctx` is a single mutable object threaded through the whole run and into every sub-loop — it carries
  `tabId`, `config`, `limits`, `grantedDomains`, `visionConfig`, and the abort-signal closures above.
- Stale element ids after a page re-render are handled by `recoverStaleElement()`: a failed
  click/type_text automatically triggers a fresh `read_page` scan so the model gets corrected ids on
  its very next turn instead of burning a whole extra turn on error → re-scan → retry.
- `compactHistory()` collapses all but the most recent `read_page`/`list_tabs` result to a short
  placeholder before sending history back to the model, so long tasks don't balloon token cost.

### Providers (`lib/providers.js`)

Normalizes Anthropic's Messages API and any OpenAI-compatible Chat Completions API (OpenAI itself, or
self-hosted/local like Ollama/LM Studio via `baseUrl`) behind one interface: `callProvider()` for the
agent loop, `describeImage()`/`classifyImages()` for the vision fallback and `view_image`/
`filter_images` tools, `listModels()` for auto-detect in Settings, `summarizeHistory()` for `/compact`.
Adding a new tool means updating `lib/tools.js`'s `TOOLS` schema (and `SYSTEM_PROMPT` if it changes
model behavior expectations) *and* both provider adapters' tool-calling translation in this file.

### Module system is intentionally mixed — don't "fix" it

`background.js`, `lib/agentLoop.js`, `lib/providers.js`, `lib/tools.js`, `lib/vision.js`,
`lib/siteCategories.js`, and `options.js` are ES modules (`import`/`export`). `content.js`,
`sidepanel.js`, `lib/markdown.js`, and `lib/pricing.js` are classic scripts loaded via plain
`<script src=...>` tags (no `type="module"`) and attach their API to `window` via an IIFE
(`window.TabAgentMarkdown`, `window.TabAgentPricing`) instead of `export`. This split exists because
`sidepanel.html` loads `lib/markdown.js`/`lib/pricing.js`/`sidepanel.js` as plain scripts, not modules
— see the comment at the top of `lib/pricing.js`. Match whichever pattern the file you're editing
already uses.

### Data model

Chat state (`session` → tree of `node`s, supporting branch/retry/edit) lives entirely in
`chrome.storage.local`, capped at 30 sessions with automatic pruning (see `createEmptySession`,
`createNode`, `attachNode`, `migrateSessionIfNeeded` in background.js — `sidepanel.js` has a matching
`migrateSessionIfNeeded` for its own read path). Agent events (`tool_start`, `branch_step`,
`batch_done`, etc.) are both persisted (`persistAgentEvent`) and broadcast live to any open side panel
(`broadcast`) — the side panel's UI is driven by replaying/handling this same event stream in both the
live-broadcast and reload-from-storage paths, so a new event type generally needs a handler in both.

### Testing notes

Jest runs under `jest-environment-jsdom` with Babel transforming ES modules for the test runner only
(source files are untouched — Chrome loads them as raw ESM/classic scripts, unaffected by Babel).
Classic-script `lib/` files (`markdown.js`, `pricing.js`) are tested by `require()`-ing them for their
side effect of setting `window.TabAgent*`, since they don't use `export`. There's no meaningful way to
unit-test `content.js`'s DOM scanning, `background.js`'s message routing, or `lib/agentLoop.js`'s tab
orchestration without a real Chrome environment — tests here are limited to the pure-logic `lib/`
modules (pricing, markdown rendering, vision-capability heuristic, site-category detection, tool
schema shape).
