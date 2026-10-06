// lib/mcp-client.js — MCP bridge connector (runs inside background.js)
//
// Manages a single MCP bridge connection: SSE stream for receiving tool
// calls, HTTP POST for sending results back, domain validation, and
// user-in-the-loop prompting for sensitive tools.

// --- SENSITIVE tool list ------------------------------------------------
// Tools that require user confirmation before executing.
const SENSITIVE_TOOLS = new Set([
  "click",
  "type_text",
  "close_tab",
  "switch_tab",
  "execute_script",
  "get_cookies",
  "get_local_storage",
  "capture_screenshot",
]);

// --- Domain validation --------------------------------------------------

function compileDomainPattern(pattern) {
  // Normalize: strip protocol/path, lowercase
  let p = pattern.toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (p.startsWith("*.")) {
    // *.example.com matches example.com and a.example.com, b.example.com
    const suffix = p.slice(1); // .example.com
    return (hostname) => hostname === suffix.slice(1) || hostname.endsWith(suffix);
  }
  if (p.startsWith("*")) {
    // Wildcard prefix like *.example.com (already handled above) or just *
    return () => true; // bare wildcard = allow all
  }
  return (hostname) => hostname === p;
}

let domainMatchers = [() => false]; // deny-all by default until connected event

function setAllowedDomains(patterns) {
  if (!patterns || patterns.length === 0) {
    domainMatchers = [() => false];
    return;
  }
  domainMatchers = patterns.map(compileDomainPattern);
}

function isDomainAllowed(hostname) {
  const h = hostname.toLowerCase();
  return domainMatchers.some((m) => m(h));
}

// Extracts hostname from a URL string or URL object.
function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

// Returns { allowed: boolean, reason?: string } for a target URL.
function checkUrlAllowed(url) {
  const h = hostnameOf(url);
  if (!h) return { allowed: false, reason: `Invalid URL: ${url}` };
  if (isDomainAllowed(h)) return { allowed: true };
  return {
    allowed: false,
    reason: `Domain "${h}" is not in the allowed list. Configure MCP_ALLOWED_DOMAINS in your MCP host config.`,
  };
}

// Returns { allowed: boolean, reason?: string } for a tab, querying its current URL.
async function checkTabAllowed(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || tab.pendingUrl;
    if (!url || url === "about:blank" || url.startsWith("chrome://") || url.startsWith("chrome-extension://")) {
      return { allowed: true }; // internal pages are always allowed
    }
    return checkUrlAllowed(url);
  } catch {
    return { allowed: true }; // if we can't get the tab, allow and let the tool fail naturally
  }
}

// --- SSE Connection -----------------------------------------------------

let sseUrl = null;
let eventSource = null;
let authToken = "";
let currentPort = 0;
let isConnected = false;
let reconnectTimer = null;
const MAX_RECONNECT_DELAY = 30_000;

// Callbacks set by background.js to wire into the UI
let onStatusChange = null;   // (connected: boolean) => void
let onToolCallStart = null;  // (callId, tool, args) => void
let onToolCallEnd = null;    // (callId, result) => void
let needsUserConfirm = null; // (tool, args) => Promise<boolean>

function connect(port, token) {
  disconnect();
  currentPort = port;
  authToken = token;
  sseUrl = `http://127.0.0.1:${port}/events?token=${encodeURIComponent(token)}`;

  const es = new EventSource(sseUrl);
  eventSource = es;

  es.onopen = () => {
    isConnected = true;
    if (onStatusChange) onStatusChange(true);
    clearTimeout(reconnectTimer);
  };

  es.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "connected") {
        setAllowedDomains(data.allowedDomains || []);
        return;
      }
      if (data.type === "tool_call") {
        await handleToolCall(data);
      }
    } catch (err) {
      console.error("MCP: error handling SSE event:", err);
    }
  };

  es.onerror = () => {
    isConnected = false;
    es.close();
    if (onStatusChange) onStatusChange(false);
    scheduleReconnect();
  };
}

function disconnect() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  isConnected = false;
  sseUrl = null;
  clearTimeout(reconnectTimer);
  if (onStatusChange) onStatusChange(false);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  const delay = Math.min(1000 + Math.random() * 2000, MAX_RECONNECT_DELAY);
  reconnectTimer = setTimeout(() => {
    if (currentPort && authToken) {
      connect(currentPort, authToken);
    }
  }, delay);
}

// --- Tool Execution -----------------------------------------------------

async function handleToolCall(msg) {
  const { callId, tool, args } = msg;

  if (onToolCallStart) onToolCallStart(callId, tool, args);

  let result;
  let error = null;

  try {
    // Check if this tool requires user confirmation
    if (SENSITIVE_TOOLS.has(tool) && needsUserConfirm) {
      const confirmed = await needsUserConfirm(tool, args);
      if (!confirmed) {
        error = "Rejected by user";
        result = { ok: false, error };
        await postResult(callId, result, error);
        if (onToolCallEnd) onToolCallEnd(callId, result);
        return;
      }
    }

    // Execute the tool
    result = await executeMcpTool(tool, args);
  } catch (err) {
    error = err.message || String(err);
    result = { ok: false, error };
  }

  await postResult(callId, result, error);
  if (onToolCallEnd) onToolCallEnd(callId, { result, error });
}

async function postResult(callId, result, error) {
  try {
    const res = await fetch(`http://127.0.0.1:${currentPort}/result`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authToken,
      },
      body: JSON.stringify({ callId, result, error }),
    });
    if (!res.ok) {
      console.error("MCP: failed to post result:", res.status);
    }
  } catch (err) {
    console.error("MCP: failed to post result:", err.message);
  }
}

async function executeMcpTool(tool, args) {
  switch (tool) {
    case "read_page": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, error: "No active tab found" };

      const domainCheck = await checkTabAllowed(tab.id);
      if (!domainCheck.allowed) return { ok: false, error: domainCheck.reason };

      // Get interactive elements via SCAN
      let scan = null;
      try {
        const scanRes = await chrome.tabs.sendMessage(tab.id, { type: "SCAN" });
        if (scanRes?.ok) scan = scanRes.data;
      } catch { /* content script may not be loaded */ }

      // Get page text via script injection
      let pageText = "";
      try {
        const [{ result: text }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => document.body?.innerText || "",
        });
        pageText = text || "";
      } catch { /* may fail on restricted pages */ }

      return {
        ok: true,
        url: tab.url,
        title: tab.title,
        text: pageText.slice(0, 50_000), // limit to 50KB
        interactiveElements: scan,
      };
    }

    case "navigate": {
      const { url } = args;
      if (!url) return { ok: false, error: "URL required" };

      const domainCheck = checkUrlAllowed(url);
      if (!domainCheck.allowed) return { ok: false, error: domainCheck.reason };

      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, error: "No active tab found" };

      await chrome.tabs.update(tab.id, { url });
      // Wait for the page to load
      await new Promise((resolve) => {
        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId === tab.id && changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        // Timeout after 30s for heavy pages
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 30_000);
      });

      return { ok: true, url };
    }

    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return {
        ok: true,
        tabs: tabs.map((t) => ({
          id: t.id,
          windowId: t.windowId,
          title: t.title,
          url: t.url,
          active: t.active,
          pinned: t.pinned,
        })),
      };
    }

    case "get_tab_info": {
      const tab = await chrome.tabs.get(args.tabId);
      if (!tab) return { ok: false, error: "Tab not found" };
      return {
        ok: true,
        tab: {
          id: tab.id,
          windowId: tab.windowId,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          pinned: tab.pinned,
          status: tab.status,
        },
      };
    }

    case "scroll": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, error: "No active tab found" };

      const domainCheck = await checkTabAllowed(tab.id);
      if (!domainCheck.allowed) return { ok: false, error: domainCheck.reason };

      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: "SCROLL",
          direction: args.direction || "down",
          amount: args.amount || 500,
        });
        return res || { ok: true };
      } catch {
        return { ok: false, error: "Content script not available" };
      }
    }

    case "click": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, error: "No active tab found" };

      const domainCheck = await checkTabAllowed(tab.id);
      if (!domainCheck.allowed) return { ok: false, error: domainCheck.reason };

      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: "CLICK",
          id: args.id,
          targetText: args.targetText,
          targetTag: args.targetTag,
        });
        return res || { ok: true };
      } catch {
        return { ok: false, error: "Content script not available" };
      }
    }

    case "type_text": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, error: "No active tab found" };

      const domainCheck = await checkTabAllowed(tab.id);
      if (!domainCheck.allowed) return { ok: false, error: domainCheck.reason };

      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: "TYPE",
          id: args.id,
          text: args.text,
          submit: args.submit,
        });
        return res || { ok: true };
      } catch {
        return { ok: false, error: "Content script not available" };
      }
    }

    case "execute_script": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, error: "No active tab found" };

      const domainCheck = await checkTabAllowed(tab.id);
      if (!domainCheck.allowed) return { ok: false, error: domainCheck.reason };

      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          func: (code) => {
            try {
              // Use indirect eval to get the global scope
              const fn = new Function(code);
              return { ok: true, value: fn() };
            } catch (err) {
              return { ok: false, error: err.message };
            }
          },
          args: [args.code],
        });
        return result || { ok: false, error: "Script returned no result" };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case "capture_screenshot": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, error: "No active tab found" };

      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: args.format || "png",
        });
        return { ok: true, dataUrl, format: args.format || "png" };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case "hover": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, error: "No active tab found" };

      const domainCheck = await checkTabAllowed(tab.id);
      if (!domainCheck.allowed) return { ok: false, error: domainCheck.reason };

      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: "HOVER",
          id: args.id,
          targetText: args.targetText,
          targetTag: args.targetTag,
        });
        return res || { ok: true };
      } catch {
        return { ok: false, error: "Content script not available" };
      }
    }

    case "get_element_text": {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { ok: false, error: "No active tab found" };

      const domainCheck = await checkTabAllowed(tab.id);
      if (!domainCheck.allowed) return { ok: false, error: domainCheck.reason };

      try {
        const res = await chrome.tabs.sendMessage(tab.id, {
          type: "GET_ELEMENT_TEXT",
          id: args.id,
          targetText: args.targetText,
          targetTag: args.targetTag,
        });
        return res || { ok: false, error: "Element not found" };
      } catch {
        return { ok: false, error: "Content script not available" };
      }
    }

    default:
      return { ok: false, error: `Unknown MCP tool: ${tool}` };
  }
}

// --- Public API ---------------------------------------------------------

export default {
  connect,
  disconnect,
  get isConnected() { return isConnected; },
  get port() { return currentPort; },
  onStatusChange: (fn) => { onStatusChange = fn; },
  onToolCallStart: (fn) => { onToolCallStart = fn; },
  onToolCallEnd: (fn) => { onToolCallEnd = fn; },
  needsUserConfirm: (fn) => { needsUserConfirm = fn; },
  checkUrlAllowed,
  setAllowedDomains,
};