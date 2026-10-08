# @tab-agent/mcp-bridge

[MCP](https://modelcontextprotocol.io) bridge for [Tab Agent](https://github.com/VeeraChandu/tab-agent) — connects MCP hosts (Cursor, Claude Desktop, Cline) to the Tab Agent Chrome extension.

## Usage

### 1. Install

```bash
npm install -g @tab-agent/mcp-bridge
```

Or use directly with `npx` (no install needed).

### 2. Configure Tab Agent

Open Tab Agent Settings → MCP and enable the bridge. Copy the config JSON shown there.

### 3. Add to your MCP host

Paste the config into your host's MCP config file:

| Host | Config file |
|---|---|
| **Claude Desktop** | `claude_desktop_config.json` |
| **Cursor** | Settings → MCP Servers |
| **Cline** | `cline_mcp_settings.json` |

The config auto-generates with a secure token — just paste the whole block.

## How it works

```
MCP Host ──stdin/stdout (JSON-RPC)──▶ mcp-bridge ──SSE──▶ Tab Agent extension
                                      (this package)
```

The bridge is spawned by the MCP host and proxies tool calls to the extension via an HTTP/SSE channel.
