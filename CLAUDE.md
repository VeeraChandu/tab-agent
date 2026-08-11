# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Comments

Comments say why, not what - the constraint, the bug prevented, the reason a non-obvious choice is
the right one. One to three lines is the norm; longer only when the mechanism genuinely needs it.
Cut restatements of the code, war stories about how a bug was found, and rationale for paths not
taken. See the `concise-comments` skill for the full version.

## What this is

Tab Agent is a Chrome (Manifest V3) extension that runs an agentic read → decide → act loop directly
in the browser: it reads the current page, asks a model (Anthropic or any OpenAI-compatible API) what
to do next, executes the chosen tool (click, type, scroll, navigate, switch tabs, etc.), and repeats
until the model calls `finish`. No MCP server, no backend - API calls go straight from the browser to
whatever provider the user configured in Settings.

## Repo layout

`src/` is the loadable extension - every file `chrome://extensions` → Load unpacked needs
(`manifest.json`, `background.js`, `content.js`, `consoleCapture.js`, `options.*`, `sidepanel.*`,
`lib/`, `icons/`) and nothing else. Everything at the repo root is dev tooling, config, or docs: `test/`, `scripts/`,
`config/` (`eslint.config.js`, `jest.config.js`), `babel.config.js` (stays at the repo root - it's
Jest-only and auto-discovery finding it there just works, not worth wiring a `configFile` override
for), `.github/workflows/` (the two workflow files plus `.releaserc.json`/`release.alpha.config.json`,
each living next to its one and only consumer rather than in `config/`, since neither is used outside
its own workflow), `docs/` (the GitHub Pages privacy policy site - see the `src/docs/` note below),
`README.md`/`CLAUDE.md`/etc. All four config files above need an explicit `--config`/`--extends`/`-c`
flag pointed at them (see the `package.json` scripts and the two release workflows) since none of these
tools auto-discover config outside the repo root - and for the two under `.github/workflows/`, that
path has to be spelled out in full from the repo root even inside the workflow file that lives right
next to it, since GitHub Actions `run:` steps always execute with cwd = the repo root. References to
source files elsewhere in this doc (`background.js`, `lib/agentLoop.js`, ...) are relative to `src/`
unless said otherwise.

`src/docs/privacy-policy.html` is a deliberate hand-kept **duplicate** of the root
`docs/privacy-policy.html` - not a symlink, not generated. The root copy is the GitHub Pages source
(`docs/index.html` redirects to it, per README's "Enable it once" Pages setup); the `src/` copy exists
because Options' Privacy tab links to `docs/privacy-policy.html` relatively, so it has to physically
live inside `src/` to resolve both from a local "Load unpacked" pointed at `src/` and from
`scripts/build.js`'s zip. If you edit one, edit the other to match - nothing currently catches drift
between them.

## Commands

There is no build step for development - this is a plain unpacked extension.

- **Load/reload in Chrome**: `chrome://extensions` → enable Developer mode → **Load unpacked** →
  select the `src` folder (not the repo root). After editing background.js/lib files, click the ↻
  reload icon on the extension card; after editing content.js, also reload any already-open tab you're
  testing on.
- **Lint**: `npm run lint` (ESLint flat config, `config/eslint.config.js`)
- **Test**: `npm test` (Jest). Run a single file with `npm test -- test/pricing.test.js` or a single
  case with `npm test -- -t "name of test"`.
- **Build a release zip**: `npm run build` - writes `dist/tab-agent-<version>.zip` from `src/` and
  syncs `src/manifest.json`'s `version` field to `package.json`'s version. `scripts/build.js`'s
  `INCLUDE` list (paths relative to `src/`) is the source of truth for what ships - it's the whole
  `src/` tree, so nothing needs excluding the way dev tooling at the repo root does.
  `node scripts/build.js <version> --store` writes to
  `dist/store/tab-agent-<version>.zip` instead, with `manifest.json`'s `key` field stripped from the
  copy in the archive - that field pins a stable extension id for local "Load unpacked" installs, but
  the Chrome Web Store rejects any upload whose manifest contains one. `scripts/publishToChromeStore.js`
  runs this `--store` build itself before uploading, so the GitHub Release zip (with `key`) and the
  Store upload (without it) are always built separately from the same source.
- **Release**: pushes to `main` trigger `.github/workflows/release.yml`, which runs lint → test →
  build → `semantic-release`. Version bumps and the published zip asset are entirely derived from
  Conventional Commits messages (`fix:`, `feat:`, `feat!:`/`BREAKING CHANGE:`, etc.) - there is no
  manual version bump.

## Architecture

### Three execution contexts, one message protocol

Chrome extension pages don't share a JS runtime, so the pieces talk over `chrome.runtime.onMessage` /
`chrome.tabs.sendMessage`, keyed by a `msg.type` string:

- **`background.js`** - the MV3 service worker (ES module) and the only long-lived coordinator. Owns
  session/chat persistence (`chrome.storage.local`), agent presets, the vision-fallback decision, and
  every `chrome.runtime.onMessage` handler (`RUN_TASK`, `ANSWER_QUESTION`, `COMPACT_SESSION`,
  `STEP_LIMIT_RESPONSE`, `SITE_GATE_RESPONSE`, `RESUME_BRANCH`, `SKIP_SUBTASKS`, `STOP_TASK`,
  `RUN_SCHEDULED_TASK_NOW`, `FOCUS_TAB`, `REOPEN_TAB`, `DELETE_SESSION_CACHE`, `GET_RUNNING_SESSION`). It
  does not touch the DOM of any page directly,
  instead it drives `lib/agentLoop.js`, which in turn messages `content.js` on the target tab.
- **`content.js`** - injected into every frame of every page (`document_idle`, `all_frames: true` -
  including cross-origin iframes, since third-party embeds like video players are almost always their
  own iframe). Scans interactive elements and tags each with a short id (`e12`, `e5`, ...) and sizable
  on-page images (`img3`, ...), and exposes the primitive actions the agent loop calls: `click`,
  `type_text`, `select_option`, `press_key`, `hover`, `fill_form`, `drag`, `upload_file`, `scroll`,
  `find_in_page`, `wait_for`, `extract_table`, `copy_to_clipboard`/`read_clipboard` (via
  `navigator.clipboard`, only reliable while the tab is focused/active). Runs once per page/frame load, so ids are only valid
  until the next scan (see stale-element recovery below) and are scoped to the frame they came from.
  `lib/agentLoop.js`'s `sendToTab()` always targets an explicit `frameId` (default `0`, the main frame)
  so a broadcast-style `chrome.tabs.sendMessage` never has to guess which of several frames' content.js
  instances should answer - `read_page`/`click`/`type_text` accept an optional `frame_id` (from the
  `list_frames` tool) to deliberately target a specific iframe instead. `click`/`type_text` also accept
  `element_text` (+ optional `element_tag`) as a fallback target when a scanned id has gone stale -
  matched against the current page's own tagged elements, erroring if more than one matches. Element
  scanning, `findByAgentId`, and click/type targeting all walk into **open shadow roots** (a manual
  stack-based traversal since `querySelectorAll`/`querySelector` never descend into them) - this is what
  makes web-component UIs (Salesforce Lightning, most design systems) scannable at all; closed shadow
  roots stay invisible, the same limitation Playwright has. Every scanned element also carries
  `box: [x, y, width, height]` (viewport-relative), which `click` accepts directly as `x`/`y` in place of
  `element_id` for canvas/map content with nothing to tag. `click` additionally takes `click_type`
  (`"double"`/`"right"`) and `modifiers` (`Alt`/`Ctrl`/`Meta`/`Shift`). Two content sources a plain DOM
  scan can't see are folded into `read_page`'s text: a rendered PDF's `.textLayer` spans (`scanPdfViewer()`
  in content.js) and, via a separate `world: "MAIN"` `chrome.scripting.executeScript` call
  (`readEditorText()` in `lib/agentLoop.js`, since the document lives in the page's own JS heap, not the
  DOM), a code editor's complete document - CodeMirror 6/5, Monaco, or Ace - rather than just whatever
  lines its virtualized viewport happens to have rendered.
- **`consoleCapture.js`** - a second, separate content script registered in `manifest.json` with
  `"world": "MAIN"` and `run_at: "document_start"` (`content.js` itself runs in the isolated world, which
  shares the DOM but not the JS heap - `window.console`/`window.alert` there are different objects than
  the page's own, so wrapping them from `content.js` would never see the page's real calls). Wraps
  `console.error`/`console.warn` and the `error`/`unhandledrejection` window events into an in-page ring
  buffer (`window.__tabAgentConsoleBuffer`, capped at 50 entries), and replaces `window.alert`/`confirm`/
  `prompt` outright (not forwarded) so a native dialog can never block the page's JS thread waiting for a
  human click - which would otherwise also block `content.js`'s response to whatever action triggered it,
  freezing the run at the `sendToTab` timeout with no way for an extension to dismiss a native dialog.
  `confirm()` auto-accepts, `prompt()` auto-cancels, both logged to `window.__tabAgentDialogBuffer` -
  the same auto-accept default Playwright and Chrome DevTools use. `readCapturedEvents()` in
  `lib/agentLoop.js` drains both buffers via its own `world: "MAIN"` `chrome.scripting.executeScript` call
  (same isolated/MAIN-world split, same reason) and folds them into `read_page`'s `console_note`/
  `dialog_note`; failed XHR/fetch requests captured separately via `chrome.webRequest` surface as
  `failed_requests`. Together these mean a page that "looks unchanged" after an action and a page that's
  actually erroring are no longer indistinguishable to the model.
- **`lib/navErrors.js`** - `chrome.webNavigation`-based per-tab tracking of the actual network failure
  (DNS failure, connection refused, ...) behind a failed top-level navigation. A `navigate`/`click` that
  lands on Chrome's own net-error page looks identical to a genuinely extension-restricted page from
  `ensureContentScript()`'s point of view (content scripts can't run on either), so without this
  `lib/agentLoop.js` misreports a real network failure as "restricted page" - a wrong diagnosis pointing
  the model away from the actual problem. `startNavErrorTracking()` must be called synchronously at
  service worker load (background.js does this at module top level), same MV3 listener-registration
  constraint as `mediaSniffer.js` above.
- **`lib/trustedInput.js`** - a `chrome.debugger` + CDP `Input.*` fallback for dispatching a real,
  OS-level trusted click, for sites whose own listeners check `event.isTrusted` and silently ignore every
  synthetic DOM event `content.js` normally dispatches (payment widgets, anti-bot form guards) - reported
  back as an inert `page_changed: false` with no diagnosis of why. `debugger` is a required permission
  (in manifest.json's `permissions`, granted at install) because Chrome does not allow it to be listed as
  optional at all - it's rejected from `optional_permissions` at load with a console warning and silently
  dropped, so `chrome.permissions.request`/`remove` were never viable for it the way they are for other
  toggleable features. Actually USING it is still gated behind a Settings → Limits toggle (off by
  default), since it shows Chrome's own "being debugged" infobar on the tab while attached regardless of
  when the underlying permission was granted; `getTrustedInputEnabled()` in background.js just reads that
  stored preference; there's no permission-revocation check to reconcile since a required permission
  can't be individually revoked from `chrome://extensions` the way an optional one can. Only ever retried
  once, only from the main loop, only main-frame, only for `click` when the normal dispatch reported
  `page_changed: false` (see the one call site in `lib/agentLoop.js`'s `"click"` case) - always detaches
  in a `finally`, even on failure, so a rejected attach/command never leaves the infobar stuck on.
- **`lib/mediaSniffer.js`** - passive `chrome.webRequest`-based capture of network requests that look
  like a direct media stream (HLS/DASH manifests/segments, or a plain video/audio file), per tab, cleared
  on every top-level navigation. Exists because some players never put their stream URL anywhere in the
  DOM at all (fetched by the player's own JS straight into `MediaSource`) - no amount of `read_page`/
  `list_frames` DOM scanning can find that; only watching the actual network traffic can. Backs the
  `list_media_requests` tool. `startMediaSniffer()` must be called synchronously at service worker load
  (background.js does this at module top level) - MV3 only allows registering these listeners during a
  service worker's initial evaluation, not lazily inside an async callback.
- **`lib/pageCache.js`** / **`lib/attachmentCache.js`** - session-scoped `chrome.storage.local` caches
  that back the `recall_page` and `read_attachment_chunk` tools, respectively. Each uses its own key
  family (`pagecacheIndex_*`/`pagecacheEntry_*`, `attcacheIndex_*`/`attcacheEntry_*`) kept separate from
  the `session`/`node` tree, and is cleaned up via `DELETE_SESSION_CACHE` when a chat is deleted -
  neither is ever exported/imported with a session. `pageCache.js` is user-toggleable (Settings → Limits → Page
  recall, **on by default** - see `getPageCacheConfig()`/`DEFAULT_PAGE_CACHE` in background.js; note
  `options.js` keeps a hand-synced copy of that default, and `options.html`'s tooltip states it in
  prose, so all three change together). It defaulted to off originally, but `compactHistory` collapses
  all but the most recent `read_page` result, and with the cache off the placeholder it leaves can only
  say "call read_page again" - i.e. re-visit live. That drove the agent to re-investigate sources it had
  already finished with, since a fresh visit was the only recovery route on offer; with the cache on the
  placeholder points at `recall_page` instead. Because a page's content can change between reads, it
  needs signature-based dedup, refresh/supersede logic,
  and a write lock (`withLock`) to stay correct under concurrent `parallel_investigate` branches.
  `attachmentCache.js` is always on (fixes silent data loss - see "Nothing the model reads is silently
  truncated" below - rather than an opt-in feature) and needs none of that: an attachment is immutable
  from the moment it's uploaded, written once before the agent loop starts, and only ever read after, so
  there's no lock and no dedup logic. `pageCache.js` is scoped out for scheduled-task runs entirely
  (`RUN_SCHEDULED_TASK_NOW` never passes a `pageCacheConfig`, so `recordPageRead`/`recallPage` both stay
  no-ops regardless of `sessionId`), since a recurring check should always see fresh state, never a
  previous run's cached page.
  `readPage()` in `lib/agentLoop.js` also writes into `attachmentCache.js` (under a synthetic `pg...`
  id, same key family) whenever a page's rendered text is too big for one `read_page` result - the
  chunk store isn't attachment-specific, so a real page read reuses it rather than growing a second
  parallel mechanism. It's surfaced back through its own `read_page_chunk` tool (not
  `read_attachment_chunk`) purely so the model never confuses page content it read with a file the user
  uploaded - the wrapper tag (`page_content_untrusted` vs `document_content_untrusted`) carries the same
  distinction. `recall_page` chunks the same way but from `pageCache.js`'s already-cached text via
  `chunkText()` directly, without a second write into `attachmentCache.js`.
  Unlike `pageCache.js`, `attachmentCache.js` is NOT scoped out for scheduled-task runs -
  `runScheduledTaskById()` (background.js) passes a per-run synthetic `sessionId`
  (`sched_<taskId>_<startedAt>`) specifically so `readPage()`'s chunk store above still works headless;
  omitting it would silently cut an oversized page to its first chunk with nobody around to notice. That
  synthetic session's attachment-cache entries are deleted in the same function's `finally` block after
  every run (recomputing the same id, rather than a separate `DELETE_SESSION_CACHE` message - there's no
  session/node tree entry to key off here) so they don't pile up.
- **`lib/statusBadge.js`** - draws a small pulsing green dot in the toolbar icon's bottom-right corner
  for as long as any task is running, via `chrome.action.setIcon` + `OffscreenCanvas` redrawn on a
  200ms interval, not `chrome.action.setBadgeText` - the text-badge API draws a colored box sized to
  fit its text, which covers roughly a third of the icon for even one character and can't animate at
  all. `startRunningBadge()`/`stopRunningBadge()` are called from `background.js`'s
  `beginKeepAlive`/`endKeepAlive` (the existing 0→1/1→0 reference-counted choke point already shared by
  every run - interactive, resumed branch, and scheduled), so it needed no new state of its own. Guards
  against one specific race: `startRunningBadge()` is async (awaits fetching/decoding the icon PNGs
  before it can start the interval) but called fire-and-forget, so a task fast enough to finish before
  that load resolves could otherwise leave the dot stuck on forever - a `running` flag set synchronously
  (unlike `pulseTimer`, only set after the await) lets a stop that lands mid-load cancel the pending
  start instead.
- **`sidepanel.js`** / **`options.js`** - the two UI surfaces. Side panel is the chat; Options is
  provider/agent/limits/scheduled-task configuration. Both are plain scripts driven by
  `chrome.runtime.sendMessage` round-trips to background.js - neither talks to a provider API or a tab
  directly.

### Composer trigger characters: `/` vs `@` (`sidepanel.js`)

The composer's popover picker is keyed on which trigger character opened it: `/` shows only
`BUILTIN_COMMANDS` (one-shot actions - clear/retry/compact/stop/model/help), `@` shows only the
user's Agents (persistent, sticky presets applied via a chip until cleared or a new chat starts). The
two namespaces are kept structurally disjoint on purpose - an agent slug can no longer collide with a
built-in command name, since they're never matched against the same list. Direct-typing without the
picker follows the same split (`/model gpt-4.1` vs `@research_agent ...`); there is no legacy
`/agent_slug` fallback.

### Staged-edit + explicit Save (`options.js`)

Agent and scheduled-task cards update an in-memory object on every `input` event (for live UI feedback
like slug-conflict checks or a summary line), but nothing is written to `chrome.storage.local` until
the card's own **Save** button is clicked, which also flashes a brief "Saved" confirmation
(`flashSaved()`). This is deliberate - it replaced an earlier per-keystroke autosave that could
persist a half-finished edit. New editable-card UI in Settings should follow the same pattern rather
than reintroducing autosave-on-input.

### The agent loop (`lib/agentLoop.js`)

`runAgentTask()` is the entry point for a normal turn: read page → call the model via
`lib/providers.js` → execute the returned tool call via `executeTool()` → repeat, capped by
`limits.mainMaxSteps` (default 20; background.js pauses and asks the user to continue rather than
silently stopping at the cap).

Three tools recurse back into the loop machinery rather than being simple one-shot actions, all
sharing `runSubLoop()`:

- **`parallel_investigate`** - fans out to multiple tabs (`runOneBranch()` per task, capped by
  `limits.maxParallelTabs`), each running its own bounded sub-loop with its own step budget
  (`limits.branchMaxSteps`). `resumeBranch()` (exported, called from background.js's `RESUME_BRANCH`
  handler) lets a branch that hit its step ceiling continue with a fresh budget on the *same* tab.
- **`run_batch`** - one long uninterrupted sub-loop (`limits.batchStepLimit`, default 150) for
  repetitive multi-page work (e.g. paginated scraping) that would blow the main loop's step budget.
- Both share two independent, differently-scoped abort signals threaded through `ctx`:
  `ctx.shouldStop` aborts the *entire* run (global Stop button) and is checked by the main loop too;
  `ctx.shouldSkip`/`ctx.shouldSkipSubtasks` ends only the current branch/batch sub-loop and is **never**
  read by the main loop's own iteration - this is what lets "skip remaining, continue" actually
  continue instead of ending the whole task. It's backed by `activeRun.skipSubtasks` in background.js
  and reset at the start of every `parallel_investigate`/`run_batch` call so a stale flag can't bleed
  into a later, unrelated call.

Three independent stuck-loop guards exist and must stay independent:

- `checkRepeatedAction()` - global (main loop + sub-loops), catches identical click/type_text calls
  producing no page change.
- `checkExplorationStreak()` - scoped **only** to `parallel_investigate` branches via
  `ctx.explorationGuard = true` (set in `runOneBranch`/`resumeBranch`, never in `runBatch` or the main
  loop). Catches a branch burning its whole step budget on read_page/scroll/extract_table/view_image/
  filter_images with no click/navigate in between (nudges at 7 consecutive steps, hard-stops at 12).
  It must **not** apply to `run_batch`, whose entire purpose is long uninterrupted scroll/extract
  sequences that this guard would otherwise false-positive on.
- `checkNoProgress()` - global, and independent of the identity-based streak above on purpose: a fresh
  scan rides along with every action result (`attachPageState`), so clicking the *same* button ten times
  produces ten distinct signatures in `checkRepeatedAction()` and never trips it. This one tracks
  *outcomes* instead of identity via `noteActionProgress()`/`didSomethingHappen()` - it resets the streak
  counter (`ctx._noProgressStreak`) whenever an action actually changed something (`page_changed`,
  `navigated`, or `scrolled_by`) and fails the call with a re-orient message once 5 actions in a row did
  nothing, regardless of whether those 5 actions were all identical or all different. Exported for tests
  (`test/noProgress.test.js`), same as `compactHistory`.

Three unrelated things can pause a run mid-task (`result.paused` from `runAgentTask()`), and all three
resume through the same path - background.js's `drive()` (see its `if (result.paused)` branch) saves
`node.pendingQuestion`/`pendingOpenedTabIds`/`pendingIncompleteBranchTabIds` and waits for the matching
response message to call `drive()` again on the same node:
- **`ask_user`** - the model calls this tool directly to ask the user a clarifying or confirmation
  question; resumed via `ANSWER_QUESTION`. Not in `SUB_AGENT_ALLOWED_TOOLS` - branches/batches have
  nobody to answer it, so `executeTool()` rejects the call there instead of pausing.
- **Site-category gate** - `lib/siteCategories.js` flags a hostname as adult/financial content (via a
  curated hostname list plus the page's own RTA/ICRA self-rating meta tag, folded into `read_page`'s
  result as `meta_category`); `navigate`/`click`/`type_text` targeting an ungated-but-flagged hostname
  pauses for a one-time "confirm before proceeding" prompt instead of silently acting. Resumed via
  `SITE_GATE_RESPONSE`; a confirmed hostname is written into `chrome.storage.local`'s
  `siteAccessGrants` (see `getGrantedDomains()` in background.js) so it never re-prompts again on any
  tab, until revoked in Settings. This is deliberately not a blocklist - the goal is ask-once-and-
  remember, not prevent access.
- **Step limit** - the main loop hitting `limits.mainMaxSteps` pauses rather than stopping outright;
  resumed via `STEP_LIMIT_RESPONSE`. Unlike the other two, this also sets a 10-minute
  `chrome.alarms` reminder (`stepLimitAlarmName()`) in case the user never comes back to it.

The side panel is a page, not a persistent background surface - closing it destroys its whole JS state,
so `sidepanel.js` has no memory of what it was showing on its own. On every fresh load it asks
background.js's `GET_RUNNING_SESSION` handler whether exactly one interactive run is currently in
`activeRuns` (deliberately silent if zero or more than one - with two windows each mid-task, there's no
way to know which one this panel used to be showing) and, if so, loads that session and flips the UI
into "running" state, the same way clicking "Continue" on a step-limit prompt already resumes a known
node. A **paused** run is the other half of this: it's removed from `activeRuns` the instant it pauses
(same moment the icon badge below goes dark), so there's no live state to ask for - instead
`findMostRecentPausedSession()` in `sidepanel.js` reads `sessions` straight from storage and walks each
one's active path for a `node.pendingQuestion` still sitting unresolved, tie-breaking on `updatedAt`.
Either way, no special "paused" rendering is needed - `loadSessionIntoView()`'s normal replay of
`node.uiEvents` already reconstructs the exact `ask_user`/`confirm_continue`/`confirm_site_category` form
a manual History visit would show.

Separately (not a pause), `isRiskyText()` in `lib/agentLoop.js` pattern-matches a `click`/`type_text`
target's visible text against `RISKY_ACTION_PATTERNS`/`RISKY_ACTION_KEYWORDS_INTL` (submit/delete/pay/
confirm-order-style wording, English and a few other languages) *before* executing the action. A match
fails the tool call with an error telling the model to call `ask_user` to confirm first, then retry the
exact same call with `confirmed: true` - this is a synchronous one-tool-call round trip within the
running loop, not a `result.paused` pause like the three above.

Other things worth knowing before touching this file:
- `ctx` is a single mutable object threaded through the whole run and into every sub-loop - it carries
  `tabId`, `config`, `limits`, `grantedDomains`, `visionConfig`, `sessionId`, `pageCacheConfig`,
  `trustedInputEnabled`, `turnIndex`, and the abort-signal closures above. `lockedHostname` is set only in
  branch/batch `ctx`s (never the main loop's), and hard-blocks `navigate`/`recall_page` from leaving that
  domain.
- Stale element ids after a page re-render are handled by `recoverStaleElement()`: a failed
  click/type_text automatically triggers a fresh `read_page` scan so the model gets corrected ids on
  its very next turn instead of burning a whole extra turn on error → re-scan → retry.
- `compactHistory()` collapses all but the most recent result of each tool in `COMPACTABLE_TOOLS`
  (`read_page`, `list_tabs`, `read_attachment_chunk`, `read_page_chunk`) to a short placeholder before
  sending history back to the model, so long tasks don't balloon token cost. When the page recall cache
  is enabled, a discarded `read_page` result's placeholder points at `recall_page` by name instead of a
  generic "re-read it"; a discarded `read_attachment_chunk`/`read_page_chunk` result always does the
  same for itself (see "Page & attachment caches" above), since re-fetching either is cheap and the
  underlying content never changes mid-conversation. A chunked `read_page` result's placeholder also
  points at `read_page_chunk` (with its `chunk_id`/`total_chunks`) alongside the `recall_page` pointer,
  since the chunk store is always on regardless of whether the recall cache is enabled.
- `attachPageState()` folds a full fresh `readPage()` scan into the *action's own* result (`page`) for
  every tool in `PAGE_EMBEDDING_TOOLS` (`click`, `type_text`, `navigate`, `select_option`, `fill_form`,
  `press_key`, `hover`, `wait_for`, `drag`, `upload_file`, `scroll`, `switch_tab`, `open_tab`) whenever
  the action changed the page, after waiting out any navigation it triggered — so acting and observing
  cost one step instead of the act-then-`read_page` pair the system prompt used to require (the prompt's
  "Other rules" now say to use the scan that rode along). It also stamps `url`/`title` (and
  `navigated: true`) on every one of those results. Because of this, `compactHistory` tracks all of
  `PAGE_EMBEDDING_TOOLS` under the same freshest-scan key as `read_page` (`PAGE_SCAN_KEY`): a scan riding
  along with any of them makes an earlier `read_page` just as stale as a new `read_page` would, and only
  the newest survives in full — a superseded one has just its `page` field replaced (the action's own
  `ok`/`page_changed`/`url` stay). An action that changed nothing carries no scan and so can never evict
  a real `read_page` result. `compactHistory` is the one function here exported purely for tests
  (`test/compactHistory.test.js`).
- `SUB_AGENT_ALLOWED_TOOLS` (a `parallel_investigate`/`run_batch` sub-loop's full tool set) is `read_page`,
  `click`, `type_text`, `select_option`, `fill_form`, `press_key`, `hover`, `wait_for`, `find_in_page`,
  `drag`, `scroll`, `navigate`, `extract_table`, `view_image`, `filter_images`, `recall_page`,
  `read_attachment_chunk`, and `read_page_chunk`, plus `open_tab`/`switch_tab` gated separately via
  `ctx.allowTabTools` (granted to `parallel_investigate` branches, withheld from `run_batch` since
  `batchCtx` has no `openedTabIds` to auto-close what it opens - see the comment above `TAB_TOOLS` in
  `lib/agentLoop.js`). `upload_file`, `close_tab`, `copy_to_clipboard`, `read_clipboard`, and
  `create_file` are deliberately absent - anything outside this set gets a clear refusal instead of
  being silently ignored. `recall_page`, `read_attachment_chunk`, and
  `read_page_chunk` being in this set is what lets a branch use content the main loop (or another branch)
  already read/was given even though the branch's own sub-loop history is discarded once it finishes.
- `callProviderRetryingEmpty()` wraps `callProvider()` in the main loop and in `runSubLoop()`: some
  OpenAI-compatible backends occasionally return a genuinely empty completion (no text, no tool calls,
  normal "stop" finish reason - not a `max_tokens`/`length` truncation) most often right after a tool
  result lands in history. It retries the same request up to `MAX_EMPTY_RESPONSE_RETRIES` (2) times
  rather than ending the run on nothing, which is what manually sending "continue" was previously
  papering over.
- `sendToTab()` (and `ensureContentScript()`/`readPage()`, which call it) wrap every
  `chrome.tabs.sendMessage` in a `SEND_TO_TAB_TIMEOUT_MS` (12s) hard timeout plus a 250ms
  `shouldStop()` poll, both passed in as an optional last argument. This exists because
  `chrome.tabs.sendMessage` has no built-in timeout: if a click/type_text triggers navigation and the
  target frame is torn down before it calls `sendResponse`, the callback can hang forever with no
  error, freezing the whole loop at that one `await` with the Stop button appearing unresponsive (no
  code left running to notice a stop request). Any new call site that awaits `sendToTab`/
  `ensureContentScript`/`readPage` should thread `ctx.shouldStop` through for the same reason.

### Nothing the model reads is silently truncated (`sidepanel.js`, `background.js`, `content.js`, `lib/agentLoop.js`)

Attachments accepted beyond images: PDF (`lib/pdf.min.js`, text layer only - no OCR) and a fixed set of
plain-text-ish extensions (`.txt`/`.md`/`.csv`/`.tsv`/`.json`/`.log`/`.yaml`/`.xml`/`.html`/common code
files, read via `file.text()`). Extraction in `sidepanel.js` never caps content - a per-file byte ceiling
at attach time (`MAX_PDF_BYTES`, `MAX_TEXT_ATTACHMENT_BYTES`) rejects a file outright if it's too large
to safely read into memory, which is a different thing from trimming an accepted file's content. The
full extracted text is sent once to `background.js`, whose `buildDocBlocks()` (see also "Page &
attachment caches" above) chunks it via `lib/attachmentCache.js` and folds only chunk 1 into that turn's
task text; if there's more than one chunk, the wrapper tells the model to call `read_attachment_chunk`
for the rest. This replaced an earlier flat `MAX_PDF_CHARS` cap that silently dropped anything past
~40k characters - don't reintroduce a similar cap without routing it through the same chunk-and-fetch
pattern instead.

The same principle now applies to page reads: `content.js`'s `scanPage()` used to cap `bodyText` at a
flat 6000 characters as a content budget. It doesn't anymore - the model is meant to see the complete
text actually rendered on a page, the same as a person would, not a pre-guessed "enough" slice of it.
Every numeric cap left in `scanPage()`/`extractTable()` (`MAX_IMAGES` 300, the 2000-element interactive
cap, the 100-table cap, `MAX_TABLE_ROWS` 5000, per-cell text at 2000 chars, `MAX_BODY_TEXT_CHARS` 2M) is
a pathological-safety ceiling only, sized to never realistically trigger on real content - not a budget
meant to shave down normal pages. `readPage()` in `lib/agentLoop.js` is what actually decides whether a
page's text fits in one result or needs chunking (via `chunkText()`/`recordAttachment()` from
`lib/attachmentCache.js` - see "Page & attachment caches" above), the same chunk-and-fetch pattern as
attachments, surfaced through the `read_page_chunk` tool. `recall_page` chunks its cached text the same
way via a `chunk_index` argument. Don't reintroduce a flat character cap in `content.js` or `readPage()`
without routing overflow through this chunking path instead.

### Providers (`lib/providers.js`)

Normalizes Anthropic's Messages API and any OpenAI-compatible Chat Completions API (OpenAI itself, or
self-hosted/local like Ollama/LM Studio via `baseUrl`) behind one interface: `callProvider()` for the
agent loop, `describeImage()`/`classifyImages()` for the vision fallback and `view_image`/
`filter_images` tools, `listModels()` for auto-detect in Settings, `summarizeHistory()` for `/compact`.
Adding a new tool means updating `lib/tools.js`'s `TOOLS` schema (and `SYSTEM_PROMPT` if it changes
model behavior expectations) plus an `executeTool` case in `lib/agentLoop.js`; both adapters here map
over `TOOLS` generically (see the two `TOOLS.map` calls) and need no per-tool edit. Don't forget
`SUB_AGENT_ALLOWED_TOOLS` if branches should get it, and `sidepanel.js`'s `TOOL_LABELS`/`toolIcon`/
`summarizeInput` so the transcript doesn't fall back to raw JSON.

### Module system is intentionally mixed - don't "fix" it

`background.js`, `lib/agentLoop.js`, `lib/providers.js`, `lib/tools.js`, `lib/vision.js`,
`lib/siteCategories.js`, `lib/mediaSniffer.js`, `lib/navErrors.js`, `lib/trustedInput.js`,
`lib/pageCache.js`, `lib/attachmentCache.js`, `lib/statusBadge.js`, and `options.js` are ES modules
(`import`/`export`).
`content.js`, `sidepanel.js`, `lib/markdown.js`, and `lib/pricing.js` are classic scripts loaded via
plain `<script src=...>` tags (no `type="module"`) and attach their API to `window` via an IIFE
(`window.TabAgentMarkdown`, `window.TabAgentPricing`) instead of `export`. This split exists because
`sidepanel.html` loads `lib/markdown.js`/`lib/pricing.js`/`sidepanel.js` as plain scripts, not modules;
see the comment at the top of `lib/pricing.js`. Match whichever pattern the file you're editing
already uses. `consoleCapture.js` is also a classic script (declared directly in `manifest.json`'s
`content_scripts`, not loaded via `<script>` at all) but attaches nothing to `window.TabAgent*` - its
job is done entirely by its side effects on `window.console`/`alert`/`confirm`/`prompt` in the page's
MAIN world, read back by `lib/agentLoop.js` via `chrome.scripting.executeScript`, not by any exported
function.

### Data model

Chat state (`session` → tree of `node`s, supporting branch/retry/edit) lives entirely in
`chrome.storage.local`, capped at 30 sessions with automatic pruning (see `createEmptySession`,
`createNode`, `attachNode`, `migrateSessionIfNeeded` in background.js - `sidepanel.js` has a matching
`migrateSessionIfNeeded` for its own read path). Agent events (`tool_start`, `branch_step`,
`batch_done`, etc.) are both persisted (`persistAgentEvent`) and broadcast live to any open side panel
(`broadcast`) - the side panel's UI is driven by replaying/handling this same event stream in both the
live-broadcast and reload-from-storage paths, so a new event type generally needs a handler in both.
Page/attachment cache content (see "Page & attachment caches" above) is deliberately NOT part of this
tree - own key families, own cleanup path - so it never rides along with session export/import.

### Testing notes

Jest runs under `jest-environment-jsdom` with Babel transforming ES modules for the test runner only
(source files are untouched - Chrome loads them as raw ESM/classic scripts, unaffected by Babel).
Classic-script `lib/` files (`markdown.js`, `pricing.js`) are tested by `require()`-ing them for their
side effect of setting `window.TabAgent*`, since they don't use `export`. There's no meaningful way to
unit-test `content.js`'s DOM scanning, `consoleCapture.js`'s MAIN-world wrapping, `background.js`'s
message routing, or `lib/agentLoop.js`'s tab orchestration (including `lib/navErrors.js`'s
`chrome.webNavigation` listeners and `lib/trustedInput.js`'s `chrome.debugger` calls) without a real
Chrome environment - tests here are limited to the pure-logic `lib/` modules (pricing, markdown
rendering, vision-capability heuristic, site-category detection, tool schema shape, page/attachment
cache chunking and eviction logic - the latter two fake `chrome.storage.local` with an in-memory `Map`
rather than mocking the whole extension) plus the two exported-for-tests pieces of `lib/agentLoop.js`
noted above: `compactHistory` (`test/compactHistory.test.js`) and the no-progress guard
(`test/noProgress.test.js`).

### Release pipeline: one-time manual setup required

The dev → main → Chrome Web Store pipeline (`.github/workflows/ci.yml`, `release-alpha.yml`,
`promote-to-main.yml`, `release.yml`, `quality-test.yml`, `.releaserc.json`,
`release.alpha.config.json`, `scripts/publishToChromeStore.js` - the first six all live in
`.github/workflows/`) is fully written, but several pieces
can only be configured by a human with repo admin/owner access and a Chrome Web Store developer
account - none of it is reachable from an agent session. If the pipeline doesn't fire end-to-end,
check this list before assuming it's a bug:

1. **`dev` branch must exist.** `main` doesn't exist yet as of this writing either - bootstrap both
   manually (e.g. `git checkout -b dev && git push -u origin dev`, then `git checkout -b main && git
   push -u origin main` once dev has real history worth releasing).
2. **`main` needs ruleset protection with a bypass actor.** Two separate pushes need to get past it,
   both authenticated with `MAIN_PUSH_TOKEN` (see below) instead of the default `GITHUB_TOKEN`:
   `promote-to-main.yml`'s own fast-forward, and - easy to miss, since it happens inside a dependency's
   code rather than this repo's own workflow YAML - `@semantic-release/git`'s "prepare" step inside
   `release.yml`'s `npx semantic-release` run, which pushes the version-bump commit and tag straight to
   `main`. `release.yml` passes `MAIN_PUSH_TOKEN` as that step's own `GITHUB_TOKEN` env var specifically
   so semantic-release's git plugin picks it up instead of the default token, which isn't a bypass actor
   and gets a GH013 rule violation. Set this up under Settings → Rules → Rulesets: protect `main`
   (require PRs, block force-pushes/deletions as desired), then add the identity that owns
   `MAIN_PUSH_TOKEN` as a bypass actor - confirmed working here as a `RepositoryRole` bypass actor
   (Admin role, `bypass_mode: "always"`) rather than a per-identity bypass, i.e. `MAIN_PUSH_TOKEN` needs
   to belong to an account with Admin access to this repo, not just any PAT with `contents: write`.
3. **Repo secrets to add** (Settings → Secrets and variables → Actions):
   - `MAIN_PUSH_TOKEN` - PAT (or GitHub App installation token) for the bypass identity from step 2;
     needs `contents: write` on this repo (covers both its own git push and, since `release.yml` now
     reuses it as `@semantic-release/github`'s auth token too, that plugin's Release-creation API call -
     Releases fall under the "contents" permission).
   - `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN` - OAuth credentials for the
     Chrome Web Store API, obtained via a Google Cloud OAuth client (see Chrome Web Store API docs for
     the `chrome-webstore-upload` auth flow this project uses).
   - `CHROME_EXTENSION_ID` - the Store listing's item ID (only exists after step 4).
   - `CHROME_PUBLISHER_ID` - your Chrome Web Store *developer account* identifier (not the extension
     ID) - visible in the Developer Dashboard's URL when logged in.
   - `GITHUB_TOKEN` is automatic and already covers `ci.yml`'s and `release.yml`'s own needs (tags,
     GitHub Releases, back-merge push to the unprotected `dev` branch).
4. **First Chrome Web Store listing must be created and submitted manually** through the [developer
   dashboard](https://chrome.google.com/webstore/devconsole) - there's no API for the very first
   upload/listing creation. `scripts/publishToChromeStore.js` only handles updating an *existing*
   listing (`uploadExisting` + `publish`) on every subsequent main release.
   `CHROME_STORE_UPLOAD_ONLY=true` can be set temporarily to validate credentials/packaging (uploads a
   draft without publishing) before wiring the real publish step.
5. **Release channels, once the above is done:** push Conventional Commits to `dev` as normal; run
   `release-alpha.yml` manually (Actions tab → Run workflow) whenever an alpha is wanted; run
   `promote-to-main.yml` manually to fast-forward `main` and kick off `release.yml`, which does the
   full release, Chrome Web Store publish, and back-merges the version/changelog commit into `dev`.
   See the README's "Releases" section for the user-facing explanation of the two channels.

### What happens when the Chrome Web Store step fails on main

Confirmed by reading semantic-release's own source (`node_modules/semantic-release/index.js` and
`lib/plugins/pipeline.js`), not assumed:

- The version-bump commit (`@semantic-release/git`) and the git tag are pushed to `main`
  **unconditionally**, before any `publish`-step plugin runs at all. A failure later in the `publish`
  step never rolls either of those back - `main` will already be one commit ahead with a real tag on
  it, even on a run that ultimately fails.
- The `publish` step runs its plugins in the order listed in `.github/workflows/.releaserc.json`, and it is **fail-fast**
  (unlike `success`/`fail`, it does not set `settleAll: true`) - the first plugin to throw stops every
  plugin after it from running for that run.
- Because of this, `.github/workflows/.releaserc.json` deliberately lists `@semantic-release/github` (creates the
  Release, uploads the zip asset) *before* the second `@semantic-release/exec` entry (Chrome Web Store
  publish). This way a Chrome failure can only ever block the Chrome step - the GitHub Release and its
  downloadable zip are already created by the time Chrome is attempted. Don't reorder these back.
- `release.yml`'s back-merge-to-dev step has `if: ${{ !cancelled() }}` specifically so it still runs
  and folds the version-bump commit into `dev` even when the semantic-release step above it fails.
- One thing this can't fix: semantic-release decides whether to release by checking for commits since
  the **last tag**. Once a version's tag exists on `main`, re-running the same workflow (even after
  fixing whatever failed) will find "no relevant changes" and no-op - it will not retry publishing
  that same version. If a release ever gets stuck with a tag already created but the GitHub
  Release/zip or Chrome Store step still missing, the fix is a one-time manual catch-up for that
  specific version, not a re-run:
  - Create the missing GitHub Release by hand for the existing tag (Releases → Draft a new release →
    pick the tag → attach the matching `dist/tab-agent-<version>.zip`, rebuilding it locally with
    `node scripts/build.js <version>` if needed), and/or
  - Run `node scripts/publishToChromeStore.js <version>` by hand (locally, with the Chrome secrets as
    env vars, once they're set up) to push that already-tagged version to the Store.
  - Separately, back-merge `main` into `dev` by hand if the automatic step didn't run for that commit:
    `git fetch origin && git checkout dev && git merge --no-edit origin/main && git push origin dev`
    (falls back to `git merge` automatically if a fast-forward isn't possible either).
