# Tab Agent

[![Release](https://img.shields.io/github/v/release/VeeraChandu/tab-agent)](https://github.com/VeeraChandu/tab-agent/releases)

A Chrome (Manifest V3) extension that runs an agentic AI loop directly on your
browser - reading page content, clicking/typing/navigating, and hopping
between open tabs as needed - with no MCP server, no local proxy, and no
extra setup. You bring your own Anthropic or OpenAI-compatible API key(s);
the extension calls the provider directly from the browser.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `tab-agent` folder's `src` subfolder.
4. Click the extension icon to open the side panel, then click the ⚙ icon to
   open Settings and add a provider:
   - Click **+ Add provider**, pick **Anthropic** or **OpenAI-compatible**,
     paste your API key.
   - Click **Fetch models** - you'll see a loading spinner while it calls the
     provider's models endpoint, then a checklist of every model your key can
     access, all checked by default. Uncheck any you don't want showing up in
     the side panel. This checklist stays visible every time you reopen
     Settings. A search box and a **Selected / All** toggle above the
     checklist help narrow a long list down. Click **Fetch models** again
     anytime (e.g. after a new model release) - for an already-configured
     provider this merges the new list in without silently changing your
     enabled models: new/removed models show up in a small popup so you can
     opt in deliberately, and if nothing changed you just get a "no changes"
     status line, instead of every re-fetch requiring a new provider entry.
   - For a non-default OpenAI-compatible endpoint (self-hosted, Groq, etc.),
     set Base URL. This also works with local models - try
     `http://localhost:11434/v1` for Ollama or `http://localhost:1234/v1` for
     LM Studio; any text is accepted as the API key if your local server
     doesn't check one.
   - Add as many providers/keys as you like. Each provider card has its own
     **Enabled** switch - turn a provider off and its models disappear from
     the composer's model dropdown entirely, without losing its saved key or
     model checklist. The dropdown lists every enabled model from every
     enabled provider, and remembers whichever one you last picked.
5. Go to any tab, open the side panel, type a task, and hit **Enter** (or the
   send button).

### Updating

`manifest.json` pins a fixed extension id (via its `"key"` field), so the
extension keeps the same id no matter which folder path you load it from. To
update: replace the `src` folder's contents with the new version and click
the small ↻ **Reload** icon on `chrome://extensions` - your providers, agents,
and chat history all carry over automatically. See **Backup** below for an
extra safety net.

## How it works

- **content.js** scans the page for interactive elements (links, buttons,
  inputs, etc., including inside open shadow roots), tags each with a short
  id, and exposes the actions listed below (click, type, scroll, fill a
  form, drag, and more).
- **background.js** runs the agent loop: it asks the model what to do next,
  given the current page state and the running conversation, executes the
  tool call the model picks, and repeats until the model calls `finish` (or
  the step limit configured in Settings → Limits is hit - 20 by default).
  It also owns chat session persistence, agent presets, scheduled checks,
  and the vision fallback.
- **lib/providers.js** normalizes Anthropic's Messages API and any
  OpenAI-compatible Chat Completions API behind one interface (including a
  model-listing call for auto-detect and a single-image description call for
  the vision fallback), so the same agent loop works with either.
- The agent isn't locked to the tab it started on - it can list every open
  tab, switch to one, or open a new one, then keep acting there.
- Nothing is proxied through a third party - API calls go straight from your
  browser to the provider you configured.

## Tools the model can call

`read_page`, `read_page_chunk`, `list_frames`, `list_media_requests`, `recall_page`,
`read_attachment_chunk`, `click`, `type_text`, `select_option`, `fill_form`,
`press_key`, `hover`, `copy_to_clipboard`, `read_clipboard`, `drag`, `upload_file`,
`wait_for`, `find_in_page`, `scroll`,
`navigate`, `list_tabs`, `read_tabs`, `switch_tab`, `open_tab`, `close_tab`,
`view_image`, `filter_images`, `screenshot`, `extract_table`, `create_file`,
`parallel_investigate`, `run_batch`, `ask_user`, `finish` - see `lib/tools.js`
for the exact schema and system prompt. The system prompt instructs the model
to read the current page first and interpret short/ambiguous requests ("check
this", "summarize it") against what's actually on that page, rather than
treating them as generic standalone questions. It also pushes the model to
actually use a site's own filter/sort controls (and gather a proper set of
results) on search/browse tasks instead of settling for the first match it
happens to see, including expanding filter sections that start out collapsed.

Element scanning and every click/type-style action pierce **open shadow
roots** (Salesforce Lightning, most web-component design systems), so a page
built entirely out of custom elements is just as scannable/actionable as a
plain one - closed shadow roots stay invisible, the same limitation
Playwright has. `read_page` also reads the complete document out of a code
editor (CodeMirror, Monaco, Ace) rather than just whatever lines are
currently scrolled into view, and the page-by-page text of a rendered PDF
viewer.

A couple of the less obvious ones:

- **`fill_form`** fills several fields (text, checkboxes, dropdowns, sliders)
  in one step instead of one `type_text` per field - use it for any form with
  2+ fields (signup, checkout, filters). It never submits on its own.
- **`press_key`** sends a single key (or combo like `Control+a`) to an element
  or to whatever currently has focus - for Escape/Arrow/Tab-driven UI
  (closing an overlay, an ARIA combobox that only builds options on key
  events) that no other tool reaches. Doesn't insert text; `type_text` does.
- **`hover`** reveals hover-only content - mega-menus, tooltips holding a
  truncated value, row actions that render on mouseenter - that isn't in the
  DOM (and so isn't in `read_page`) until hovered.
- **`copy_to_clipboard`** / **`read_clipboard`** write/read the OS clipboard,
  same as a real Ctrl+C/Ctrl+V - useful for moving a value between tabs, or
  into/out of something the agent otherwise can't reach (a native dialog, a
  password manager). Only works while the target tab is focused/active.
- **`drag`** drags one element onto another - slider thumbs, sortable lists,
  kanban cards - dispatching both a pointer-sequence and the native HTML5
  drag-and-drop event family to cover most drag libraries.
- **`click`** also accepts `x`/`y` viewport coordinates (the only way to reach
  canvas/map content with no taggable element - every scanned element's `box`
  field gives a ready-made point), plus `click_type: "double"/"right"` and
  `modifiers` (Alt/Ctrl/Meta/Shift). `click`/`type_text` also accept
  `element_text` as a fallback target when a scanned id has gone stale.
- **`wait_for`** waits for text to appear or disappear (spinner, async
  search result) instead of polling `read_page` in a loop; capped at 10
  seconds.
- **`find_in_page`** searches the page for text/regex without spending a full
  scan just to locate one thing.
- **`upload_file`** puts a file already attached to the conversation into a
  page's `<input type="file">` - text-based attachments only (PDFs/images
  aren't retained as raw bytes). A synthetic click can't open the OS file
  picker, so this is the only way to get a file *into* a page.
- **`read_tabs`** reads several already-open tabs in one call (title, text,
  elements, images) - used for comparison tasks ("compare these 3 tabs")
  instead of switching between them one at a time.
- **`extract_table`** pulls a real `<table>` element (by id, from `read_page`)
  into clean structured rows - for "put this in a spreadsheet"-style asks,
  instead of eyeballing raw page text.
- **`create_file`** generates a downloadable file from text the agent writes
  itself (a CSV/JSON export, a converted document, a written report) and
  offers it in the chat with a Download button - built entirely client-side
  (`Blob` + a normal download link), so it needs no extra permission. For
  content the agent generates only; it can't save a file that already exists
  on a page as-is.
- **`list_frames`** / **`list_media_requests`** handle content `read_page`'s
  DOM scan can't see: `list_frames` lists embedded iframes (common for
  third-party video players and widgets) so a `frame_id` can target one
  directly; `list_media_requests` looks at recent network traffic for a
  direct video/audio stream URL, for players that never put one anywhere in
  the DOM at all.
- **`recall_page`** looks up a page already read earlier in the same chat
  without re-visiting it - see **Page recall cache** below.
- **`close_tab`** closes a tab this run opened earlier with `open_tab` (which
  can also open `background: true`, i.e. without stealing the browser's
  foreground tab) - any left open get offered for cleanup once the task ends.
- **`read_attachment_chunk`** fetches more of a large attached file that
  didn't fit in one piece - see **Composer** below.
- **`read_page_chunk`** fetches more of a `read_page` result that didn't fit
  in one piece - rare, since `read_page` returns a page's complete rendered
  text with no fixed size trim, but a genuinely huge page still needs
  splitting the same way a large attachment does. Kept as its own tool
  (rather than reusing `read_attachment_chunk`) purely so the model never
  mistakes page content it read for a file the user uploaded.

`read_page` also surfaces problems a plain scan can't tell apart from "the
click did nothing": recent console errors/unhandled rejections, native
`alert`/`confirm`/`prompt` dialogs (auto-resolved so the run never freezes
waiting for a human to click them), and failed network requests all show up
as notes on the result, and a failed navigation reports the real network
error instead of misreporting a DNS failure or refused connection as an
extension-restricted page.

**Trusted-input fallback (Settings → Limits, off by default)**: some sites'
own listeners check `event.isTrusted` and silently ignore any click that
isn't a real, OS-level input event (payment widgets, anti-bot form guards) -
reported back as an inert no-op with no explanation. Turning this on lets a
click that reported no effect retry once through `chrome.debugger`'s real
input pipeline, which the page can't tell apart from an actual click. The
`debugger` permission itself is requested upfront at install (Chrome doesn't
allow it to be requested/revoked at runtime like other optional permissions),
but actually using it stays off by default and only turns on when you flip
this toggle - Chrome also shows its own "being debugged" banner on the tab
while it's attached.

## Multi-source and batch tasks (parallel_investigate / run_batch)

Two tools exist for task shapes that don't fit the normal one-tab
read → act → finish loop:

- **`parallel_investigate`** checks several independent sources at once
  ("compare X across sites A, B, C"), each in its own background tab, run
  concurrently - much faster than switching between tabs one at a time. Each
  source gets a small, isolated sub-agent with its own step budget, so it
  can't act on the wrong tab or eat into the main conversation's steps.
  - If a branch runs out of steps before finishing, its tab is left open and
    the side panel shows a **▶ resume** button on that branch's status card
    to continue with a fresh budget on the same tab (rather than losing
    progress by starting over in a new tab).
- **`run_batch`** runs one repetitive task on the *current* tab across many
  steps ("process every row in this table"), with its own much larger step
  budget so it doesn't force a check-in every 20 actions. If it can't finish
  in one call, it reports what it got through and picks up where it left off
  on the next call.
- Both show live status cards in the chat (per-source progress for
  `parallel_investigate`, a single progress card for `run_batch`) with a
  **⏹ Skip remaining, continue** / **⏹ Stop here, continue** button - this
  ends just that sub-task and lets the rest of the conversation carry on,
  distinct from the global **Stop** button which ends the whole run.

## Page recall cache

Off by default - turn it on in Settings → **Limits** → **Page recall**. When
enabled, every page the agent reads this chat is kept (by content, not just
URL, so a page that changes in place - a filter re-applying, an infinite
scroll loading more - is tracked as an updated or additional entry rather
than losing the earlier view) so a later question about something already
checked can be answered via `recall_page` instead of a live re-visit - e.g.
"check these 10 profiles for X" followed by "now get Y from the same ones"
doesn't require reading all 10 pages twice. Recalled content is informational
only: its element ids are never valid for `click`/`type_text` on whatever is
currently on screen, and the agent is told to prefer a fresh read whenever
the answer could plausibly have changed since it was captured (price,
availability, stock). Capped at a configurable number of cached pages per
chat (oldest-turn entries dropped first once over the cap), and cleared
automatically when that chat is deleted. Scheduled checks never use this -
each run is meant to see fresh data, not a previous run's cached copy.

## Agents

Agents are reusable presets - a name, an optional target site, and extra
instructions layered on top of the base system prompt. They use the exact
same tools as the default assistant; only the instructions differ.

Agents are invoked with `@`, not `/` - `/` is reserved for the fixed
built-in commands below (see "Slash commands vs. agents"). This keeps the
two kinds of things unambiguous: a command runs a one-shot action right now,
an agent is a persistent preset that stays sticky for the rest of the chat.

- Manage them in Settings → **Agents**: add/edit/remove, set a name, an
  `@command`, a short description, an optional target URL, and free-form
  instructions. Edits are staged as you type and only written to storage when
  you click **Save** on that agent's card (a brief "Saved" confirmation
  flashes to confirm), so a half-finished edit can't accidentally overwrite a
  working agent.
- In the side panel, type `@` in the composer to open a filtered picker of
  your agents (arrow keys + Enter, or click). Picking one shows a chip above
  the input - every message in that chat goes to that agent until you
  clear the chip (✕) or start a new chat.
- You can also just type the whole command directly, e.g.
  `@research_agent find the latest earnings reports` - it's parsed the same
  way and becomes sticky for the rest of that chat too.
- No agents come pre-installed - Settings → Agents starts empty until you add
  your own.

## Ask-user prompts

Agents (and the default assistant) can call `ask_user` when they need
something only you can provide - a missing detail, a choice between options,
or confirmation before something risky. This pauses the run and shows an
inline form right in the chat (free text, single-choice, or multi-choice).
Fill it in and hit Submit to continue. The pause is saved with the
conversation, so if you close the side panel before answering, reopening the
side panel itself (not just navigating back to that chat from History) lands
you straight back on the same open question, waiting for you - along with
everything the agent already did before it paused.

## Vision fallback

Not every model can see images. In Settings → **Vision model**, you can
pick one vision-capable model to handle image attachments automatically:
if your currently selected chat model doesn't look vision-capable (a
name-based guess - Chrome extensions can't reliably query this from the
provider APIs), Tab Agent asks the fallback model to describe each attached
image first, then hands your chat model that description instead of the raw
image. A small info note appears in the chat when this happens. Leave it set
to "None" to disable and always send images as-is. A provider dropdown plus a
text filter next to the picker keep this manageable once you have several
providers configured - picking a provider restricts the list to that
provider's models, and the text filter then searches only within it.

## Vision on the page (view_image / filter_images / screenshot)

Beyond the vision fallback for attachments (above), Tab Agent can look at
what's actually rendered on the page:

- **`read_page`** also returns a list of sizable on-page images (roughly
  80×80px or larger), each with a short id like `img3`, alt text, and
  dimensions - the same way it lists clickable elements as `e12`, `e5`, etc.
- **`view_image`** hands one image, by id, to your configured Vision model
  and gets back a detailed description - useful for checking the result of
  an image the agent just generated on an AI image site, reading text baked
  into a graphic, or judging a single image against what was asked for. The
  side panel shows a thumbnail of the actual image alongside the description.
- **`filter_images`** checks a batch of images, by id, against a
  plain-language criteria (e.g. "shows a red item", "the person is wearing
  glasses") in as few model calls as possible, and reports which match -
  useful for filtering search results, product grids, or profile listings by
  a visual trait rather than checking one item at a time. The side panel
  shows every checked image as a thumbnail, grouped by match/no-match.
- **`screenshot`** captures everything actually visible in the viewport -
  canvas content, CSS background images, complex layouts - not just `<img>`
  tags. Use this when the other two can't see what's needed; the target tab
  must be the currently active/visible one. If your current chat model can
  see images directly, the screenshot is attached to the result for it to
  look at; otherwise it falls back to a text description from the
  separately-configured Vision model.
- `view_image`/`filter_images` require a **Vision model** to be set in
  Settings → Providers - if none is configured, the agent will tell you and
  stop rather than guessing. `screenshot` only needs one as a fallback for a
  chat model that can't see images itself.
- When asked to generate an image and refine it, the agent asks up front
  whether you want it to iterate on its own (up to 3 attempts, reporting
  every attempt) or show you each result and wait for your guidance before
  trying again.
- Image bytes are fetched directly by the extension's background process
  (the same `<all_urls>` permission that lets it read pages at all also
  covers this) - if a specific image can't be fetched (blocked by the site,
  requires page-only auth, etc.), the tool reports that plainly instead of
  the run failing silently.

## Slash commands vs. agents

Type `/` in the composer to open a picker of the fixed built-in commands
below, or `@` for a picker of your **Agents** - two separate, single-purpose
pickers rather than one merged list, since a command (a one-shot action) and
an agent (a persistent, sticky preset) behave differently enough that mixing
them together was easy to confuse. Either can also be typed out directly
without opening the picker at all (e.g. `/model gpt-4.1` or
`@research_agent find X`).

- **`/clear`** - reset the current chat in place: wipes its messages but keeps
  the same session/History entry. Different from the **+** icon, which starts
  a brand-new chat and leaves the current one untouched in History.
- **`/retry`** - regenerate the last response (branches from the last message
  with the same text, like clicking ✎ and resending unchanged).
- **`/compact`** - summarize this chat's context into a short briefing and
  replace the full history with it, so future messages in this chat cost
  less to send. Also triggers **automatically** once a chat's tracked usage
  passes ~250K tokens, right before your next message is sent.
- **`/stop`** - stop the current run (same as the Stop button).
- **`/model <name>`** - switch the active model by (partial) name without
  touching the dropdown, e.g. `/model claude` or `/model gpt-4.1`.
- **`/help`** - list all commands and your configured agents.

## Still working? (step-limit check-in)

Every kind of run - the main conversation, each `parallel_investigate`
branch, and `run_batch` - is capped at a step limit to guard against runaway
loops, configurable in Settings → **Limits** (main conversation, batch task,
max parallel tabs, and per-branch limits are all independent settings).
Instead of silently giving up at the cap, Tab Agent pauses and asks whether
to keep going, the same way it pauses for `ask_user`. Click **Continue** to
grant another full budget, or **Stop here** to end it. If you don't respond
within 10 minutes, it stops on its own (using `chrome.alarms`, so this still
works even if the extension's background process was suspended in the
meantime).

## Composer

- Type and hit **Enter** to send (Shift+Enter for a newline).
- 📎 attach up to 4 files per message: images (5MB each), PDFs (20MB, text
  extracted client-side), or plain-text-ish files - `.txt`, `.md`, `.csv`,
  `.tsv`, `.json`, `.log`, `.yaml`, `.xml`, `.html`, and common code files
  (10MB each). Nothing is ever trimmed: a large file is split into chunks
  behind the scenes, the first chunk rides along with your message for free,
  and the model calls `read_attachment_chunk` for the rest if it needs more -
  cached, static content that's always fetchable again later in the chat at
  no extra cost. Extracted text is given to the model as regular (untrusted)
  document content; images go through the vision fallback above if your chat
  model can't see them directly.
- 🎤 dictate instead of typing, if your browser supports it (Chrome's
  built-in speech recognition) - grant microphone access once in Settings →
  Privacy, since Chrome doesn't reliably show that prompt inside the side
  panel itself.
- Type `/` for built-in commands or `@` for an agent (see **Slash commands
  vs. agents** below).
- The model dropdown lists every *enabled* model from every *enabled*
  provider and switches which one handles the next run.
- While the agent is responding, a top progress bar and an animated "typing"
  bubble show it's working, and the log auto-scrolls to follow along; if you
  scroll up to read something, auto-scroll pauses for that response and
  resumes automatically the next time you send a task.
- The extension icon shows a small pulsing green dot in its bottom-right
  corner for as long as any task (this chat, a resumed branch, or a
  scheduled check) is running - so closing the side panel doesn't lose track
  of whether something's still working in the background. Clears the moment
  the last active run ends.
- Reopening the side panel while a task is still running lands you straight
  back on it - full history so far, tool calls included, and still live -
  instead of a blank new chat with no sign anything's happening. This only
  kicks in when exactly one task is actively running - with two side panel
  windows each mid-task, it won't guess which one this window used to be
  showing. If nothing's actively running but one or more chats are sitting
  on an unanswered question (see **Ask-user prompts** and **Still
  working?**), the most recently paused one reopens instead.
- Each tool call in the log shows a plain-language status ("Reading the
  page", "Investigating sources", "Running batch task", etc.) instead of the
  raw tool name.
- When the agent calls `list_tabs`, the result renders as a clickable list -
  click any row to jump straight to that tab (a manual shortcut, separate
  from the agent's own `switch_tab` tool use).
- Every message bubble (yours and the agent's final answer) has a copy
  button (⧉) alongside edit, for quickly pulling text out of the chat.
- Press **Escape** to stop a running task from anywhere in the panel; if
  nothing is running, Escape closes the History panel instead.

## History

- The clock icon opens a panel listing past conversations (title + relative
  time + an approximate token count for that conversation), newest first.
  A search box at the top filters the list by title as you type. Close it
  with **Escape**, the **✕**, or by clicking anywhere outside the panel.
- Click one to reload its full transcript into view and keep chatting - new
  messages continue that same conversation with full prior context sent back
  to the model, and any agent that chat was using is restored too.
- Each row has **duplicate** (⧉, clones the conversation so you can branch it
  without touching the original), **export** (⬇, downloads a readable
  `.md` transcript), and **delete** (✕) actions. The **+** icon starts a
  fresh chat. Up to 30 conversations are kept; older ones are pruned
  automatically.

## Site access (adult / financial confirmation)

Before acting on a site that looks like adult content or a financial
service (a curated hostname list, plus the page's own RTA/ICRA self-rating
meta tag if present), Tab Agent pauses and asks you to confirm once - then
remembers your answer per domain so it only asks that site again if you
revoke it. Manage what's been granted in Settings → **Privacy** → Site
access. This is best-effort detection, not a guarantee, and (see
**Scheduled checks** below) a check running unattended can't answer this
prompt itself.

## Scheduled checks

Settings → **Automation** lets you run a task automatically on a timer, with
no side panel open: Tab Agent opens the target page in a background tab,
runs the task using that check's own model, and closes the tab again,
recording the outcome (success/failure + a short summary) and optionally
firing a notification. Each check picks its model independently from a
provider dropdown plus a text filter, same as the vision-model picker above -
handy once you have several providers configured with a lot of models
between them. Since there's nobody to answer a mid-run question,
anything that would need `ask_user` - or a one-time site-access confirmation
it hasn't already been granted - pauses and reports back as unfinished
instead of actually prompting; confirm those sites manually in the side
panel first if a scheduled check needs one.

## Reliability

- Transient API errors (429 rate limits, 5xx, network blips) are retried
  automatically with backoff before giving up and showing an error.
- Progress is saved to storage after every step, not just at the start and
  end of a run - if the browser suspends the extension mid-task, reopening
  the panel shows everything that happened up to the last completed step
  instead of an empty gap.
- If a page re-renders and invalidates the element ids from the last
  `read_page` scan (common on dynamic/SPA sites), the next click/type_text
  failure automatically includes a fresh scan so the model can retry with
  corrected ids on its very next turn, instead of burning a whole extra turn
  on "error → re-scan → retry". `click`/`type_text` also accept `element_text`
  as an immediate fallback target (the element's visible text) when a scan
  hasn't run yet but the model still knows what the element says.
- A `parallel_investigate` branch that gets stuck reading/scrolling the same
  page without clicking or navigating anywhere is nudged, then stopped,
  instead of silently burning its whole step budget on one unproductive page.
  Separately, in the main run too: 5 actions in a row that genuinely change
  nothing (not just 5 identical ones - any mix) triggers a re-orient warning
  telling the model to stop guessing variations and re-check its assumptions.
- `read_page` returns a page's complete rendered text - there's no fixed
  character trim, the same way attached files are never trimmed (see
  **Composer** below). On the rare page too large for one result, the model
  gets the first chunk plus a note to fetch the rest via `read_page_chunk`
  (and `recall_page` supports the same chunking for cached pages), instead of
  silently losing whatever didn't fit.
- Only the most recent `read_page`/`list_tabs`/`read_attachment_chunk`/
  `read_page_chunk` result is kept in full in the conversation sent back to
  the model each turn; older ones are collapsed to a short placeholder so
  long tasks don't balloon in token cost or storage size. If the **Page
  recall cache** (below) is turned on, that placeholder points the model at
  `recall_page` instead of a live re-read; attached-file and page-text
  chunks always point back at `read_attachment_chunk`/`read_page_chunk`,
  since a cached chunk never goes stale.
- If a provider occasionally returns a genuinely empty response (no text, no
  tool call, no error - seen on some OpenAI-compatible backends), Tab Agent
  retries that same request a couple of times before giving up, instead of
  the run silently stalling.
- Every system prompt is stamped with today's actual date, so date-relative
  requests ("latest", "this year", "recent") resolve against the real
  calendar instead of the model's training-data assumptions about what year
  it is.
- Every message to a tab (click, type, scroll, navigate, read) is bounded by
  a hard timeout with the **Stop** button polled throughout - if a click
  triggers a navigation that tears down the page before it can respond, the
  run times out and reports it instead of hanging indefinitely with Stop
  appearing unresponsive.
- If you switch to a different tab mid-conversation, the next message you
  send tells the model the tab changed (and to re-check the page) instead of
  silently continuing to reason about the previous tab's content - the chat
  itself stays one continuous conversation either way.
- Page content, image descriptions, table data, and extracted PDF text are
  all treated by the model as untrusted data, never as instructions - the
  system prompt explicitly calls out prompt-injection attempts (e.g. text on
  a page saying "ignore previous instructions") as something to flag to you,
  not follow.

## Backup

Settings → **Export settings** / **Import settings** each open a popup
listing every section - providers (including API keys), agents, vision
model setting, site access grants, scheduled checks, and theme - so you
pick what to include before anything happens. Import reads the file first:
any section it doesn't contain shows up disabled ("not in file") in the
popup rather than being left out, so it's clear at a glance what won't be
touched. Only the sections left checked are written (export) or applied
(import) - anything unchecked keeps your current settings untouched.
Useful for moving to another machine, sharing just your agents or scheduled
checks without your API keys, or as a plain backup.

## Limitations

- One task runs at a time; starting a new one while another is running isn't
  supported.
- Can't act on `chrome://` pages, the Chrome Web Store, or other pages Chrome
  restricts extensions from touching - the agent will tell you when it hits
  one instead of failing silently.
- Step limits pause and ask whether to continue instead of ending the
  run - see **Still working?** above - but very long multi-page workflows
  may still be better split into smaller tasks or broken up with `ask_user`
  checkpoints.
- Vision-capability detection is a best-effort name heuristic, not a real
  capability lookup - the provider APIs don't reliably expose this.
- `view_image`/`filter_images`/`screenshot` fetch image/pixel data directly
  from the background process - this covers the vast majority of sites, but
  a site that gates images behind page-context-only auth (rather than normal
  cookies/headers a background fetch also carries) may fail; the tool
  reports this as a normal error rather than crashing the run.
- PDF attachments are handled as extracted text only - the model reads the
  text content of the PDF, not a visual rendering of its pages; a
  scanned/image-only PDF with no text layer won't yield anything useful.
  Attachments (images or files) are only sent with the message that starts a
  run, not with `ask_user` answers.
- The `click`/`press_key` (Enter)/`drag` tools refuse (and ask for
  confirmation) on elements/drop targets whose text looks irreversible or
  consequential (delete, purchase, payment, unsubscribe, etc.) - but this is
  a heuristic on the element's own text, not a guarantee, so it can miss
  risky actions worded unusually or wave through ones that aren't actually
  risky. Still review what the agent is about to do on pages with forms,
  purchases, or account settings.
- History is stored in `chrome.storage.local` (with the `unlimitedStorage`
  permission, so the default ~10MB cap doesn't apply), capped at 30
  conversations; older ones are pruned automatically.
- API keys are stored in `chrome.storage.local` (this browser profile only,
  unencrypted) - don't use this on a shared machine with a key you care
  about protecting.

## Security notes

Because the agent can click and type on your behalf (and can move between
tabs), the side panel logs every tool call and result as it happens, and
there's a **Stop** button to abort a run at any time (or, for
`parallel_investigate`/`run_batch` specifically, a **Skip** button that ends
just that sub-task and lets the rest of the conversation continue). Review
what it's about to do, especially on pages with forms, purchases, or account
settings.

The agent is instructed to treat CAPTCHAs, bot-detection interstitials, and
similar anti-automation measures as a stop-and-report signal, not something
to work around - and not to help circumvent another AI service's own safety
restrictions. See `lib/tools.js`'s system prompt ("Scope" section) for the
exact wording.

## Privacy & permissions

Tab Agent sends page content, screenshots, and tab details to the AI
provider **you configure, using your own API key** - never to this
extension's developer, since no server operated by the developer is
involved in that flow at all. Everything else (API keys, chat history,
agents, scheduled tasks, settings) lives only in this browser's local
extension storage (`chrome.storage.local`) and is never synced or
transmitted elsewhere. Full details: [`PRIVACY_POLICY.md`](./PRIVACY_POLICY.md),
also reachable from Settings → **Privacy** as a bundled, clickable "Privacy
Policy" link (`docs/privacy-policy.html`, shipped inside the extension so it
works offline and doesn't depend on GitHub Pages being live).

The side panel shows a one-time data-use notice on first run summarizing
the above, plus a persistent one-line reminder pinned directly above the
message box on every screen (not dismissible, unlike the one-time notice).
Settings → Privacy has the same summary at any time, permanently.

**If you're publishing this to the Chrome Web Store:**

- The privacy policy is already prepared as a standalone page at
  [`docs/privacy-policy.html`](./docs/privacy-policy.html), ready for
  GitHub Pages. Enable it once: on GitHub, go to this repo's **Settings →
  Pages**, set "Source" to "Deploy from a branch", pick the branch this
  content lives on (merge to your default branch first if it's currently
  only on a feature branch) and folder **`/docs`**, then Save. It goes
  live at `https://<your-github-username>.github.io/tab-agent/privacy-policy.html`,
  or for this repo's current remote (`VeeraChandu/tab-agent`), that's
  `https://veerachandu.github.io/tab-agent/privacy-policy.html`. Paste that
  URL into the store listing's privacy policy field. (`PRIVACY_POLICY.md`
  in the repo root has the same content in markdown, for reference.)
- The dashboard's permission-justification fields can be filled in directly
  from [`PERMISSION_JUSTIFICATIONS.md`](./PERMISSION_JUSTIFICATIONS.md).
- Enable the **"Mature content"** flag in the developer dashboard - the
  agent can navigate to and interact with adult-rated sites (behind a
  one-time confirmation gate; see "Site access" above), which Chrome's
  policy treats as requiring that flag even though it isn't the extension's
  primary purpose.
- Chrome Web Store policy changes take effect **August 1, 2026** tightening
  data-disclosure requirements and adding a new prohibition on extensions
  that circumvent AI safety guardrails - re-read the current
  [Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
  against this project's actual behavior before submitting, since policy
  text can change after this was written.

## Releases

Two channels, both cut from Conventional Commit history via semantic-release:

- **Full releases** come from `main` (e.g. `v1.4.0`) and are the only releases
  published to the Chrome Web Store, alongside a tagged GitHub Release with
  the extension zip attached. The badge above always tracks the latest full
  release.
- **Alpha releases** come from `dev` (e.g. `v1.4.0-alpha.1`) and are tagged as
  GitHub prereleases with a zip attached, for early testing via "Load
  unpacked" - they're never pushed to the Store. Cutting one is a manual step
  (repo maintainers only), not automatic.

`main` only ever advances by fast-forwarding to `dev`'s tip (no new commits),
so every commit that ships in a full release already shipped in an earlier
alpha first.

## License

This repo's source is public for transparency and review, but it is **not**
open-source - no MIT/Apache/GPL-style redistribution rights are granted.
Viewing, running locally, and contributing back via pull request are all
welcome; copying, redistributing, or publishing a modified/derivative
version elsewhere is not, without permission. Full terms: [`LICENSE`](./LICENSE).
