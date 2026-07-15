# Tab Agent

A Chrome (Manifest V3) extension that runs an agentic AI loop directly on your
browser — reading page content, clicking/typing/navigating, and hopping
between open tabs as needed — with no MCP server, no local proxy, and no
extra setup. You bring your own Anthropic or OpenAI-compatible API key(s);
the extension calls the provider directly from the browser.

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `tab-agent` folder.
4. Click the extension icon to open the side panel, then click the ⚙ icon to
   open Settings and add a provider:
   - Click **+ Add provider**, pick **Anthropic** or **OpenAI-compatible**,
     paste your API key.
   - Click **Fetch models** — you'll see a loading spinner while it calls the
     provider's models endpoint, then a checklist of every model your key can
     access, all checked by default. Uncheck any you don't want showing up in
     the side panel. This checklist stays visible every time you reopen
     Settings. Click **Fetch models** again anytime (e.g. after a new model
     release) — it merges the new list in, keeping your existing choices and
     enabling any newly-discovered model by default, instead of requiring a
     new provider entry.
   - For a non-default OpenAI-compatible endpoint (self-hosted, Groq, etc.),
     set Base URL. This also works with local models — try
     `http://localhost:11434/v1` for Ollama or `http://localhost:1234/v1` for
     LM Studio; any text is accepted as the API key if your local server
     doesn't check one.
   - Add as many providers/keys as you like and mark one **Default**. Switch
     between any of their enabled models from the dropdown in the composer.
5. Go to any tab, open the side panel, type a task, and hit **Enter** (or the
   send button).

### Updating to a new version

`manifest.json` pins a fixed extension id (via its `"key"` field), so unlike
a typical unpacked extension, the id no longer depends on which folder path
you loaded it from. To update: replace this folder's contents with the new
version (or unzip a new release over the same folder) and click the small ↻
**Reload** icon on `chrome://extensions` — your providers, agents, and chat
history all carry over automatically. Only avoid removing the extension and
re-adding it from a *different* folder path for a version that predates this
fixed id (anything before this note) — that one-time jump aside, updates
should now always be seamless. See **Backup** below for an extra safety net
regardless.

## How it works

- **content.js** scans the page for interactive elements (links, buttons,
  inputs, etc.), tags each with a short id, and exposes actions: click,
  type, scroll.
- **background.js** runs the agent loop: it asks the model what to do next,
  given the current page state and the running conversation, executes the
  tool call the model picks, and repeats until the model calls `finish` (or
  the step limit configured in Settings → Limits is hit — 20 by default).
  It also owns chat session persistence, agent presets, scheduled checks,
  and the vision fallback.
- **lib/providers.js** normalizes Anthropic's Messages API and any
  OpenAI-compatible Chat Completions API behind one interface (including a
  model-listing call for auto-detect and a single-image description call for
  the vision fallback), so the same agent loop works with either.
- The agent isn't locked to the tab it started on — it can list every open
  tab, switch to one, or open a new one, then keep acting there.
- Nothing is proxied through a third party — API calls go straight from your
  browser to the provider you configured.

## Tools the model can call

`read_page`, `click`, `type_text`, `scroll`, `navigate`, `list_tabs`,
`read_tabs`, `switch_tab`, `open_tab`, `view_image`, `filter_images`,
`screenshot`, `extract_table`, `parallel_investigate`, `run_batch`,
`ask_user`, `finish` — see `lib/tools.js` for the exact schema and system
prompt. The system prompt instructs the model to read the current page first
and interpret short/ambiguous requests ("check this", "summarize it")
against what's actually on that page, rather than treating them as generic
standalone questions. It also pushes the model to actually use a site's own
filter/sort controls (and gather a proper set of results) on search/browse
tasks instead of settling for the first match it happens to see.

A couple of the less obvious ones:

- **`read_tabs`** reads several already-open tabs in one call (title, text,
  elements, images) — used for comparison tasks ("compare these 3 tabs")
  instead of switching between them one at a time.
- **`extract_table`** pulls a real `<table>` element (by id, from `read_page`)
  into clean structured rows — for "put this in a spreadsheet"-style asks,
  instead of eyeballing raw page text.

## Multi-source and batch tasks (parallel_investigate / run_batch)

Two tools exist for task shapes that don't fit the normal one-tab
read → act → finish loop:

- **`parallel_investigate`** checks several independent sources at once
  ("compare X across sites A, B, C"), each in its own background tab, run
  concurrently — much faster than switching between tabs one at a time. Each
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
  **⏹ Skip remaining, continue** / **⏹ Stop here, continue** button — this
  ends just that sub-task and lets the rest of the conversation carry on,
  distinct from the global **Stop** button which ends the whole run.

## Agents

Agents are reusable presets — a name, an optional target site, and extra
instructions layered on top of the base system prompt. They use the exact
same tools as the default assistant; only the instructions differ.

- Manage them in Settings → **Agents**: add/edit/remove, set a name, a
  `/slash_slug`, a short description, an optional target URL, and free-form
  instructions.
- In the side panel, type `/` in the composer to open a filtered picker of
  your agents (arrow keys + Enter, or click). Picking one shows a chip above
  the input — every message in that chat now goes to that agent until you
  clear the chip (✕) or start a new chat.
- You can also just type the whole command directly, e.g.
  `/youtube_agent find the latest releases of telugu songs` — it's parsed
  the same way and becomes sticky for the rest of that chat too.
- Two agents come pre-installed: **LinkedIn Job Finder** (searches LinkedIn
  job listings for a role you give it) and **YouTube Agent** (searches
  YouTube and summarizes results). Edit or delete either one like any other.

## Ask-user prompts

Agents (and the default assistant) can call `ask_user` when they need
something only you can provide — a missing detail, a choice between options,
or confirmation before something risky. This pauses the run and shows an
inline form right in the chat (free text, single-choice, or multi-choice).
Fill it in and hit Submit to continue. The pause is saved with the
conversation, so if you close the side panel before answering, reopening it
(or reloading that chat from History) shows the same open question waiting
for you.

## Vision fallback

Not every model can see images. In Settings → **Vision model**, you can
pick one vision-capable model to handle image attachments automatically:
if your currently selected chat model doesn't look vision-capable (a
name-based guess — Chrome extensions can't reliably query this from the
provider APIs), Tab Agent asks the fallback model to describe each attached
image first, then hands your chat model that description instead of the raw
image. A small info note appears in the chat when this happens. Leave it set
to "None" to disable and always send images as-is.

## Vision on the page (view_image / filter_images / screenshot)

Beyond the vision fallback for attachments (above), Tab Agent can look at
what's actually rendered on the page:

- **`read_page`** also returns a list of sizable on-page images (roughly
  80×80px or larger), each with a short id like `img3`, alt text, and
  dimensions — the same way it lists clickable elements as `e12`, `e5`, etc.
- **`view_image`** hands one image, by id, to your configured Vision model
  and gets back a detailed description — useful for checking the result of
  an image the agent just generated on an AI image site, reading text baked
  into a graphic, or judging a single image against what was asked for. The
  side panel shows a thumbnail of the actual image alongside the description.
- **`filter_images`** checks a batch of images, by id, against a
  plain-language criteria (e.g. "shows a red item", "the person is wearing
  glasses") in as few model calls as possible, and reports which match —
  useful for filtering search results, product grids, or profile listings by
  a visual trait rather than checking one item at a time. The side panel
  shows every checked image as a thumbnail, grouped by match/no-match.
- **`screenshot`** captures everything actually visible in the viewport —
  canvas content, CSS background images, complex layouts — not just `<img>`
  tags. Use this when the other two can't see what's needed; the target tab
  must be the currently active/visible one.
- All three require a **Vision model** to be set in Settings → Providers —
  if none is configured, the agent will tell you and stop rather than
  guessing.
- When asked to generate an image and refine it, the agent asks up front
  whether you want it to iterate on its own (up to 3 attempts, reporting
  every attempt) or show you each result and wait for your guidance before
  trying again.
- Image bytes are fetched directly by the extension's background process
  (the same `<all_urls>` permission that lets it read pages at all also
  covers this) — if a specific image can't be fetched (blocked by the site,
  requires page-only auth, etc.), the tool reports that plainly instead of
  the run failing silently.

## Slash commands

Type `/` in the composer to open a picker of both your **Agents** and a
fixed set of built-in commands — pick one, or type the whole thing directly
(e.g. `/model gpt-4.1`) without opening the picker at all.

- **`/clear`** — start a new chat (same as the **+** icon).
- **`/retry`** — regenerate the last response (branches from the last message
  with the same text, like clicking ✎ and resending unchanged).
- **`/compact`** — summarize this chat's context into a short briefing and
  replace the full history with it, so future messages in this chat cost
  less to send. Also triggers **automatically** once a chat's tracked usage
  passes ~250K tokens, right before your next message is sent.
- **`/stop`** — stop the current run (same as the Stop button).
- **`/model <name>`** — switch the active model by (partial) name without
  touching the dropdown, e.g. `/model claude` or `/model gpt-4.1`.
- **`/help`** — list all commands and your configured agents.

## Still working? (step-limit check-in)

Every kind of run — the main conversation, each `parallel_investigate`
branch, and `run_batch` — is capped at a step limit to guard against runaway
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
- 📎 attach up to 4 files per message — images or PDFs, 5MB each. PDF text is
  extracted and given to the model as regular (untrusted) document content;
  images go through the vision fallback above if your chat model can't see
  them directly.
- 🎤 dictate instead of typing, if your browser supports it (Chrome's
  built-in speech recognition) — grant microphone access once in Settings →
  Privacy, since Chrome doesn't reliably show that prompt inside the side
  panel itself.
- Type `/` to pick an agent (see **Agents** above).
- The model dropdown lists every *enabled* model across all your providers
  and switches which one handles the next run.
- While the agent is responding, a top progress bar and an animated "typing"
  bubble show it's working, and the log auto-scrolls to follow along; if you
  scroll up to read something, auto-scroll pauses for that response and
  resumes automatically the next time you send a task.
- Each tool call in the log shows a plain-language status ("Reading the
  page", "Investigating sources", "Running batch task", etc.) instead of the
  raw tool name.
- When the agent calls `list_tabs`, the result renders as a clickable list —
  click any row to jump straight to that tab (a manual shortcut, separate
  from the agent's own `switch_tab` tool use).
- Every message bubble (yours and the agent's final answer) has a copy
  button (⧉) alongside edit, for quickly pulling text out of the chat.
- Press **Escape** to stop a running task from anywhere in the panel; if
  nothing is running, Escape closes the History panel instead.

## History

- The clock icon opens a panel listing past conversations (title + relative
  time + an approximate token count for that conversation), newest first.
  A search box at the top filters the list by title as you type.
- Click one to reload its full transcript into view and keep chatting — new
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
meta tag if present), Tab Agent pauses and asks you to confirm once — then
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
firing a notification. Since there's nobody to answer a mid-run question,
anything that would need `ask_user` — or a one-time site-access confirmation
it hasn't already been granted — pauses and reports back as unfinished
instead of actually prompting; confirm those sites manually in the side
panel first if a scheduled check needs one.

## Reliability

- Transient API errors (429 rate limits, 5xx, network blips) are retried
  automatically with backoff before giving up and showing an error.
- Progress is saved to storage after every step, not just at the start and
  end of a run — if the browser suspends the extension mid-task, reopening
  the panel shows everything that happened up to the last completed step
  instead of an empty gap.
- If a page re-renders and invalidates the element ids from the last
  `read_page` scan (common on dynamic/SPA sites), the next click/type_text
  failure automatically includes a fresh scan so the model can retry with
  corrected ids on its very next turn, instead of burning a whole extra turn
  on "error → re-scan → retry".
- A `parallel_investigate` branch that gets stuck reading/scrolling the same
  page without clicking or navigating anywhere is nudged, then stopped,
  instead of silently burning its whole step budget on one unproductive page.
- Only the most recent `read_page`/`list_tabs` result is kept in full in the
  conversation sent back to the model each turn; older ones are collapsed to
  a short placeholder so long tasks don't balloon in token cost or storage
  size.
- Every system prompt is stamped with today's actual date, so date-relative
  requests ("latest", "this year", "recent") resolve against the real
  calendar instead of the model's training-data assumptions about what year
  it is.
- If you switch to a different tab mid-conversation, the next message you
  send tells the model the tab changed (and to re-check the page) instead of
  silently continuing to reason about the previous tab's content — the chat
  itself stays one continuous conversation either way.
- Page content, image descriptions, table data, and extracted PDF text are
  all treated by the model as untrusted data, never as instructions — the
  system prompt explicitly calls out prompt-injection attempts (e.g. text on
  a page saying "ignore previous instructions") as something to flag to you,
  not follow.

## Backup

Settings → **Export settings** downloads your providers (including API
keys), agents, scheduled checks, vision model setting, and theme preference
as one JSON file; **Import settings** restores from that file, replacing
whatever's currently configured. Useful for moving to another machine, or as
a plain backup — independent of the extension-id fix above, which should
make this unnecessary for routine updates but is still worth having.

## Limitations (MVP)

- One task runs at a time; starting a new one while another is running isn't
  supported yet.
- Can't act on `chrome://` pages, the Chrome Web Store, or other pages Chrome
  restricts extensions from touching — the agent will tell you when it hits
  one instead of failing silently.
- Step limits now pause and ask whether to continue instead of ending the
  run — see **Still working?** above — but very long multi-page workflows
  may still be better split into smaller tasks or broken up with `ask_user`
  checkpoints.
- Vision-capability detection is a best-effort name heuristic, not a real
  capability lookup — the provider APIs don't reliably expose this.
- `view_image`/`filter_images`/`screenshot` fetch image/pixel data directly
  from the background process — this covers the vast majority of sites, but
  a site that gates images behind page-context-only auth (rather than normal
  cookies/headers a background fetch also carries) may fail; the tool
  reports this as a normal error rather than crashing the run.
- PDF attachments are handled as extracted text only — the model reads the
  text content of the PDF, not a visual rendering of its pages. Attachments
  (images or PDFs) are only sent with the message that starts a run, not
  with `ask_user` answers.
- The `click` tool refuses (and asks for confirmation) on elements whose
  text looks irreversible or consequential (delete, purchase, payment,
  unsubscribe, etc.) — but this is a heuristic on the element's own text, not
  a guarantee, so it can miss risky actions worded unusually or wave through
  ones that aren't actually risky. Still review what the agent is about to
  do on pages with forms, purchases, or account settings.
- History is stored in `chrome.storage.local` (with the `unlimitedStorage`
  permission, so the default ~10MB cap doesn't apply), capped at 30
  conversations; older ones are pruned automatically.
- API keys are stored in `chrome.storage.local` (this browser profile only,
  unencrypted) — don't use this on a shared machine with a key you care
  about protecting.

## Security notes

Because the agent can click and type on your behalf — and can move between
tabs — the side panel logs every tool call and result as it happens, and
there's a **Stop** button to abort a run at any time (or, for
`parallel_investigate`/`run_batch` specifically, a **Skip** button that ends
just that sub-task and lets the rest of the conversation continue). Review
what it's about to do, especially on pages with forms, purchases, or account
settings.
