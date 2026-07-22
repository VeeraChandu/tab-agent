# Permission justifications (for the Chrome Web Store submission form)

Chrome Web Store's developer dashboard requires a written justification for
each permission declared in `manifest.json`. The text below is written to be
pasted directly into those fields - one paragraph per permission, explaining
what it's used for and why a narrower permission wouldn't work. Update the
wording if the feature set changes before you submit.

## `activeTab`

Used so the agent can act on the tab the user is currently looking at the
moment they send a task, without needing standing access to every tab ahead
of time. This is the narrowest permission for "let the user's current task
touch their current tab" and is requested alongside `tabs` only because the
agent also needs to read tab titles/URLs across windows for multi-tab
workflows (see `tabs` below) and to act on tabs the user explicitly directs
it to via `switch_tab`/`open_tab`, not just the one active when a message is
sent.

## `scripting`

Used to inject `content.js` into a page on demand when it isn't already
present (e.g. a tab that existed before install/update, or one that reloaded
mid-task) so the agent can read page content and interact with it. This is
the standard, narrowest API for programmatic content-script injection under
Manifest V3.

## `storage`

Used to persist chat history, user-configured AI provider settings and API
keys, custom agents, scheduled tasks, and preferences locally in the
browser via `chrome.storage.local`. Nothing is synced or transmitted to any
server operated by the developer.

## `tabs`

Used to let the agent list open tabs, read their titles/URLs, switch
between them, and open new ones - core to its purpose as a
multi-tab browsing agent (e.g. comparing several product pages, or
following a link that opens in a new tab). Only tab metadata (title, URL,
loading state) is read via this permission; page content itself is read
separately via the content script.

## `sidePanel`

Used to render the extension's primary UI (the chat interface) in Chrome's
side panel, which is the intended surface for this kind of persistent,
conversational assistant UI rather than a transient popup.

## `unlimitedStorage`

Used because chat history (including page content and tool results
recorded during a task) can exceed the default `chrome.storage.local` quota
for an active user with many saved conversations. Without this, users would
hit silent storage failures and lose chat history.

## `alarms`

Used for two features: (1) resuming a long-running agent task's "still
working?" prompt reliably even if the Manifest V3 service worker is killed
and restarted while waiting, and (2) firing user-created scheduled/recurring
checks (Settings → Scheduled tasks) at their configured time. `alarms` is
the only API that survives a service worker being unloaded, which
`setTimeout` does not.

## `notifications`

Used to show a system notification when a user-configured scheduled task
finishes running in the background, so the user doesn't have to keep the
side panel open to know a check completed (this is opt-in per scheduled
task, off by default).

## `webRequest`

Used passively (no blocking/modification of any request) to detect direct
media stream URLs (HLS/DASH manifests and segments) that a page's own
JavaScript player fetches and pipes straight into a `<video>` element
without ever writing the URL into the page's visible DOM - content the
agent's page-reading tools have no way to see otherwise. Only requests
matching known media file extensions or content-types are recorded, and
only in memory for the current browser session; nothing is logged
persistently or sent anywhere by this permission.

## `webNavigation`

Used to detect when a tab navigates to a genuinely different site (by
hostname), so the media-request buffer above can be cleared for that tab -
without this, a stale stream URL from a previous page could be reported as
if it belonged to the current one.

## Host permissions (`<all_urls>`)

Used because Tab Agent is a general-purpose browsing agent whose entire
value proposition is working with whatever site the user is on at the time -
there is no fixed set of domains to scope this to ahead of time, the same
way a general-purpose ad blocker or password manager needs broad host
access to function on arbitrary sites. `content_scripts` also match
`<all_urls>` with `all_frames: true` for the same reason: a task may
require reading or acting inside an iframe (e.g. an embedded video player or
payment widget) whose origin isn't known in advance.

---

**Note on the "narrowest permission" principle**: every permission above
gates a specific, disclosed feature (see `PRIVACY_POLICY.md`), and none of
them are used for analytics, advertising, or any purpose beyond the
single stated purpose of "let a user-directed AI agent read and act on
browser tabs on the user's behalf."
