#!/usr/bin/env node
// src/mcp/mcp-bridge.mjs
//
// MCP stdio bridge between any MCP host (Cursor, Claude Desktop, Cline) and
// the Tab Agent Chrome extension.
//
//   MCP Host ──stdin/stdout (Content-Length JSON-RPC)──▶ mcp-bridge
//                                                            │
//                        ◀──── SSE (/events) ────────────────┤
//                        ──── POST (/result) ───────────────▶│
//                                                            ▼
//                                                     Extension (background.js)
//
// The bridge is SPAWNED BY THE MCP HOST, not by Chrome. When it starts it
// opens an HTTP server on a fixed localhost port so the extension can:
//   1. Open SSE to /events  (receives tool_call events)
//   2. POST to /result      (sends tool execution results back)
//
// The port, auth token, and allowed domains are all configured via env vars
// that the MCP host passes through (set in claude_desktop_config.json etc.).

import * as http from "node:http";
import { randomBytes } from "node:crypto";

// --- Config ------------------------------------------------------------

const MCP_VERSION = "2025-03-26";
const BRIDGE_VERSION = "1.0.0";
const TOOL_TIMEOUT_MS = 300_000; // 5 minutes
const HEARTBEAT_MS = 30_000;

const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const PORT = parseInt(process.env.MCP_PORT || "58732", 10);
const ALLOWED_DOMAINS = (process.env.MCP_ALLOWED_DOMAINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!AUTH_TOKEN) {
  console.error("MCP_BRIDGE: MCP_AUTH_TOKEN env var is required");
  process.exit(1);
}

// --- HTTP server -------------------------------------------------------
// Two endpoints:
//   GET /events?token=<token>   — SSE stream (extension receives tool calls)
//   POST /result                — tool result callback (extension sends back)
//   GET /status?token=<token>   — health check (for extension to discover us)

let sseClients = new Set();
const pendingCalls = new Map(); // callId -> { resolve, reject, timeout }

function auth(req) {
  // SSE uses query param; POST uses Authorization header
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const queryToken = url.searchParams.get("token");
  const headerToken = req.headers["authorization"];
  return queryToken === AUTH_TOKEN || headerToken === AUTH_TOKEN;
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // --- SSE endpoint ----------------------------------------------------
  if (url.pathname === "/events" && req.method === "GET") {
    if (!auth(req)) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send initial connection event with allowed domains
    res.write(
      `data: ${JSON.stringify({ type: "connected", allowedDomains: ALLOWED_DOMAINS })}\n\n`
    );
    sseClients.add(res);

    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  // --- Tool result callback -------------------------------------------
  if (url.pathname === "/result" && req.method === "POST") {
    if (!auth(req)) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const pending = pendingCalls.get(data.callId);
        if (pending) {
          pendingCalls.delete(data.callId);
          clearTimeout(pending.timeout);
          if (data.error) {
            pending.reject(new Error(data.error));
          } else {
            pending.resolve(data.result);
          }
          res.writeHead(200);
          res.end("ok");
        } else {
          res.writeHead(404);
          res.end("unknown callId");
        }
      } catch (err) {
        res.writeHead(400);
        res.end("invalid JSON");
      }
    });
    return;
  }

  // --- Health check ----------------------------------------------------
  if (url.pathname === "/status" && req.method === "GET") {
    if (!auth(req)) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        connected: sseClients.size > 0,
        pendingCalls: pendingCalls.size,
        allowedDomains: ALLOWED_DOMAINS,
      })
    );
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`MCP_BRIDGE: Listening on 127.0.0.1:${PORT}`);
  console.error(`MCP_BRIDGE: Token prefix: ${AUTH_TOKEN.slice(0, 8)}...`);
  console.error(
    `MCP_BRIDGE: Allowed domains: ${
      ALLOWED_DOMAINS.length ? ALLOWED_DOMAINS.join(", ") : "(none — all navigation blocked)"
    }`
  );
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`MCP_BRIDGE: Port ${PORT} is already in use. Set MCP_PORT to a different value.`);
  } else {
    console.error("MCP_BRIDGE:", err.message);
  }
  process.exit(1);
});

// --- MCP Protocol (stdin/stdout) ---------------------------------------
// Content-Length: <N>\r\n\r\n<JSON payload>

let stdinBuf = "";
process.stdin.on("data", (chunk) => {
  stdinBuf += chunk.toString();
  processStdin();
});

function processStdin() {
  const m = stdinBuf.match(/^Content-Length: (\d+)\r\n\r\n/);
  if (!m) return;

  const len = parseInt(m[1], 10);
  const offset = m[0].length;
  if (stdinBuf.length < offset + len) return;

  const raw = stdinBuf.slice(offset, offset + len);
  stdinBuf = stdinBuf.slice(offset + len);

  try {
    handleMCP(JSON.parse(raw));
  } catch (err) {
    console.error("MCP_BRIDGE: parse error:", err.message);
  }
  processStdin(); // recurse for pipelined messages
}

function sendMCP(msg) {
  const raw = JSON.stringify(msg);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(raw, "utf8")}\r\n\r\n${raw}`
  );
}

function sendError(id, code, message) {
  sendMCP({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleMCP(msg) {
  if (msg.jsonrpc !== "2.0") return;

  const { id, method, params } = msg;

  if (method === "initialize") {
    sendMCP({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "tab-agent", version: BRIDGE_VERSION },
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return; // no response expected
  }

  if (method === "tools/list") {
    sendMCP({
      jsonrpc: "2.0",
      id,
      result: { tools: toolDefs(ALLOWED_DOMAINS) },
    });
    return;
  }

  if (method === "tools/call") {
    handleToolCall(id, params?.name, params?.arguments || {});
    return;
  }

  sendError(id, -32601, `Unknown method: ${method}`);
}

async function handleToolCall(id, name, args) {
  if (sseClients.size === 0) {
    sendError(
      id,
      -32000,
      "Extension not connected. Open Tab Agent and try again."
    );
    return;
  }

  const callId = randomBytes(8).toString("hex");

  const event = { type: "tool_call", callId, tool: name, args, mcpId: id };
  for (const client of sseClients) {
    client.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingCalls.delete(callId);
        reject(new Error("Tool call timed out after 5 minutes"));
      }, TOOL_TIMEOUT_MS);
      pendingCalls.set(callId, { resolve, reject, timeout });
    });

    sendMCP({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(result) }] },
    });
  } catch (err) {
    sendError(id, -32000, err.message);
  }
}

// --- Tool definitions --------------------------------------------------

function toolDefs(domains) {
  const domainNote =
    domains.length
      ? `Allowed: ${domains.join(", ")}`
      : "No domains configured — navigation is blocked";

  return [
    {
      name: "read_page",
      description: `Get the full text content, URL, title, and interactive element map of the currently active page. Returns structured data the model can reason about. ${domainNote}`,
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "navigate",
      description: `Navigate the active tab to a URL. The domain must be in the allowed list. ${domainNote}`,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute URL to navigate to" },
        },
        required: ["url"],
      },
    },
    {
      name: "list_tabs",
      description: "List all open browser tabs with title, URL, tab ID, and window ID.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "get_tab_info",
      description: "Get details about a specific tab by its tab ID.",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "number", description: "The tab ID to inspect" },
        },
        required: ["tabId"],
      },
    },
    {
      name: "scroll",
      description: "Scroll the page in a direction.",
      inputSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Direction to scroll",
          },
        },
        required: ["direction"],
      },
    },
    {
      name: "click",
      description:
        "Click an interactive element identified by its numeric id from read_page's scan (shown in brackets). SENSITIVE — can submit forms and trigger mutations.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Numeric element id from scan" },
          targetText: { type: "string", description: "Optional text content for disambiguation" },
          targetTag: { type: "string", description: "Optional tag name" },
        },
        required: ["id"],
      },
    },
    {
      name: "type_text",
      description:
        "Type text into an input field. SENSITIVE — sends user-generated content to the page.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Numeric element id from scan" },
          text: { type: "string", description: "Text to type" },
          submit: { type: "boolean", description: "Submit the form after typing" },
        },
        required: ["id", "text"],
      },
    },
    {
      name: "execute_script",
      description:
        "Execute arbitrary JavaScript in the page context. CRITICAL — full access to page DOM and JS context.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript code to execute" },
        },
        required: ["code"],
      },
    },
    {
      name: "capture_screenshot",
      description:
        "Take a screenshot of the current page. SENSITIVE — captures visible content including potentially private information.",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["png", "jpeg"],
            default: "png",
          },
        },
      },
    },
    {
      name: "hover",
      description: "Hover over an element to reveal tooltips or popovers.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Numeric element id" },
          targetText: { type: "string" },
          targetTag: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "get_element_text",
      description: "Get the text content of a specific element by its scan id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Numeric element id" },
          targetText: { type: "string" },
          targetTag: { type: "string" },
        },
        required: ["id"],
      },
    },
  ];
}

// --- Cleanup -----------------------------------------------------------

function shutdown() {
  for (const c of sseClients) c.end();
  sseClients.clear();
  for (const [, p] of pendingCalls) {
    clearTimeout(p.timeout);
    p.reject(new Error("Bridge shutting down"));
  }
  pendingCalls.clear();
  server.close();
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });