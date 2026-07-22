# Tab Agent - Privacy Policy

_Last updated: 2026-07-19_

This document explains what Tab Agent does with your data. It's written to be
pasted (or linked, once hosted at a public URL) into the Chrome Web Store
listing's privacy policy field, and to match exactly what the extension's
code does - nothing here is aspirational or marketing language.

## The short version

Tab Agent reads and acts on the pages you ask it to work with, and sends
that information to the AI provider (Anthropic, OpenAI, or an
OpenAI-compatible endpoint) **you configure yourself, using your own API
key**. That data goes from your browser directly to that provider - never
to Tab Agent's developer, and never to any server the developer operates,
because no such server exists. Everything else (your API keys, chat
history, settings, scheduled tasks) is stored locally in your browser via
`chrome.storage.local` and is never transmitted anywhere except to the AI
provider, and only as much of it as a given task actually needs.

## What Tab Agent accesses, and when

Tab Agent only reads or acts on a page when you (or a scheduled task you
created) ask it to do something involving that page. It does not run in the
background scanning every page you browse. When it does run, depending on
what the task needs, it may access:

- **Page content**: visible text, interactive elements (buttons, links, form
  fields), tables, and images on the current tab or a tab you direct it to.
- **Screenshots**: only when the `screenshot` tool is used, and only of the
  active tab.
- **Tab metadata**: titles and URLs of your open tabs, when a task asks it
  to list, read, or switch between tabs.
- **Network request metadata**: Tab Agent passively watches for media
  (video/audio stream) requests on tabs it's actively working with, so it
  can report direct stream URLs back to you - it does not log or transmit
  general browsing/network activity, and this data is kept only in memory
  for the current browser session, never written to storage.
- **Attachments you provide**: images or PDFs you attach to a message.

## Where that data goes

When a task runs, the relevant page content, screenshots, or attachments are
sent as part of the conversation to whichever AI provider and model you've
configured in Settings - using the API key you supplied. Tab Agent's
developer never receives this data, has no server that intercepts or logs
it, and has no way to see your conversations, browsing activity, or API
keys. Your data's handling once it reaches the AI provider is governed by
that provider's own privacy policy and terms (e.g. Anthropic's or OpenAI's),
not by this one.

If you configure a custom/self-hosted OpenAI-compatible endpoint, data goes
to that endpoint instead - the same principle applies: it's your
configuration, and the data goes directly there, not through anything Tab
Agent's developer operates.

## What's stored locally, and where

Everything below lives in `chrome.storage.local`, sandboxed to your browser
profile, and is never synced to Google's servers or any third party:

- API keys and provider/model configuration
- Chat history (including page content and tool results from past tasks)
- Agents (custom slash-command presets) you've created
- Scheduled/recurring task definitions and their run history
- Site-access grants (domains you've confirmed for adult/financial content)
- Theme preference and other UI settings

**API keys are stored in plain text**, not encrypted - this is standard for
"bring your own key" extensions, but it means anyone with access to your
browser profile's local storage (e.g. via other software on a compromised
device) could read them. Keep your device secure accordingly.

**Export/backup files** (from Settings → Backup) contain whatever you
select to export in plain, unencrypted JSON, including API keys if you
include that section. Store exported files as carefully as you would a
password.

## What Tab Agent does NOT do

- It does not collect analytics, telemetry, or usage statistics.
- It does not send your data to Tab Agent's developer or any server the
  developer operates - none exists.
- It does not sell or share your data with advertisers or data brokers.
- It does not sync your data to any account or cloud service on its own.

## Data retention and deletion

Chat history, scheduled tasks, and settings persist until you delete them
yourself (via the chat history panel, Settings, or by uninstalling the
extension - uninstalling wipes all locally stored extension data
automatically, per Chrome's standard behavior for uninstalled extensions).

## Changes to this policy

If a future update changes what data Tab Agent accesses or where it goes,
that change will be called out in the extension's release notes, and the
in-product data-use notice (shown on first run, and re-shown after a
material change) will be updated to match.

## Children's privacy

Tab Agent is not directed at children and is not intended for use by
anyone under the age required by their local law to consent to data
processing without a parent/guardian.

## Contact

Veera Chandu - [📧 Email](mailto:veerachandu1693@gmail.com)
