// tests for the context-aware tool filtering in lib/tools.js

import { filterTools } from "../src/lib/tools.js";

// Every tool name currently in TOOLS, for validating that filterTools never
// returns a tool that doesn't exist and always returns the right subset.
const ALL_TOOL_NAMES = [
  "read_page", "list_frames", "list_media_requests", "recall_page",
  "read_attachment_chunk", "read_page_chunk",
  "click", "type_text", "select_option", "fill_form", "press_key",
  "hover", "copy_to_clipboard", "read_clipboard",
  "scroll", "navigate", "list_tabs", "read_tabs", "switch_tab", "open_tab", "close_tab",
  "view_image", "filter_images", "screenshot", "extract_table", "create_file",
  "wait_for", "find_in_page", "drag", "upload_file",
  "parallel_investigate", "run_batch", "ask_user",   "finish",
  "save_session_state",
  "restore_session_state",
  "get_downloads",
  "capture_download",
  "get_queue_status",
  "clear_queue",
];

function toolNames(tools) {
  return (tools || []).map((t) => t.name);
}

describe("filterTools", () => {
  test("returns all tools with no filters active", () => {
    const result = filterTools({});
    const names = toolNames(result);
    // Should include all tools (no filters active) except:
    // - view_image/filter_images need visionConfig
    // - screenshot needs visionCapable or visionConfig
    // - upload_file needs hasAttachments
    ALL_TOOL_NAMES.forEach((n) => {
      if (n === "view_image" || n === "filter_images") {
        expect(names).not.toContain(n);
      } else if (n === "screenshot") {
        expect(names).not.toContain(n);
      } else if (n === "upload_file") {
        expect(names).not.toContain(n);
      } else {
        expect(names).toContain(n);
      }
    });
  });

  test("includes vision tools when visionConfig is present", () => {
    const result = filterTools({ visionConfig: { provider: "openai", model: "gpt-4o" }, hasAttachments: true });
    const names = toolNames(result);
    expect(names).toContain("view_image");
    expect(names).toContain("filter_images");
    expect(names).toContain("screenshot");
    expect(names).toContain("upload_file");
  });

  test("includes screenshot when visionCapable is true (no separate visionConfig)", () => {
    const result = filterTools({ visionCapable: true, hasAttachments: true });
    const names = toolNames(result);
    expect(names).toContain("screenshot");
    expect(names).toContain("upload_file");
    // view_image/filter_images still need visionConfig (separate model)
    expect(names).not.toContain("view_image");
    expect(names).not.toContain("filter_images");
  });

  test("excludes clipboard tools for sub-agents", () => {
    const result = filterTools({ isSubAgent: true, hasAttachments: true });
    const names = toolNames(result);
    expect(names).not.toContain("copy_to_clipboard");
    expect(names).not.toContain("read_clipboard");
    expect(names).toContain("upload_file");
  });

  test("includes clipboard tools for main loop", () => {
    const result = filterTools({ hasAttachments: true });
    const names = toolNames(result);
    expect(names).toContain("copy_to_clipboard");
    expect(names).toContain("read_clipboard");
    expect(names).toContain("upload_file");
  });

  test("excludes upload_file when no attachments present", () => {
    const result = filterTools({ hasAttachments: false });
    const names = toolNames(result);
    expect(names).not.toContain("upload_file");
  });

  test("includes upload_file when attachments are present", () => {
    const result = filterTools({ hasAttachments: true });
    const names = toolNames(result);
    expect(names).toContain("upload_file");
  });

  test("excludes sub-agent-restricted tools for isSubAgent", () => {
    const result = filterTools({ isSubAgent: true, hasAttachments: true });
    const names = toolNames(result);
    expect(names).not.toContain("parallel_investigate");
    expect(names).not.toContain("run_batch");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("screenshot");
    // But tab tools should still be there
    expect(names).toContain("click");
    expect(names).toContain("read_page");
  });

  test("excludes batch-restricted tools for isBatch", () => {
    const result = filterTools({ isBatch: true, hasAttachments: true });
    const names = toolNames(result);
    expect(names).not.toContain("open_tab");
    expect(names).not.toContain("switch_tab");
    expect(names).not.toContain("parallel_investigate");
    expect(names).not.toContain("run_batch");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("screenshot");
  });

  test("sub-agent with vision config gets vision tools", () => {
    const result = filterTools({ isSubAgent: true, visionConfig: { provider: "openai", model: "gpt-4o" }, hasAttachments: true });
    const names = toolNames(result);
    expect(names).toContain("view_image");
    expect(names).toContain("filter_images");
    // But not screenshot (sub-agent restriction)
    expect(names).not.toContain("screenshot");
    expect(names).not.toContain("parallel_investigate");
    expect(names).not.toContain("run_batch");
    expect(names).not.toContain("ask_user");
    expect(names).not.toContain("copy_to_clipboard");
    expect(names).not.toContain("read_clipboard");
  });

  test("sub-agent vision tools when visionCapable is true but no visionConfig", () => {
    const result = filterTools({ isSubAgent: true, visionCapable: true, hasAttachments: true });
    const names = toolNames(result);
    // view_image/filter_images need explicit visionConfig even when the main
    // model is vision-capable (they use singleTurnComplete, not the main call)
    expect(names).not.toContain("view_image");
    expect(names).not.toContain("filter_images");
    expect(names).not.toContain("screenshot");
  });

  test("returns only tools that actually exist in TOOLS", () => {
    const result = filterTools({ visionConfig: { provider: "openai", model: "gpt-4o" }, hasAttachments: true });
    const names = toolNames(result);
    for (const name of names) {
      expect(ALL_TOOL_NAMES).toContain(name);
    }
  });

  test("finish is always present", () => {
    const result = filterTools({ isSubAgent: true, isBatch: true, hasAttachments: true });
    const names = toolNames(result);
    expect(names).toContain("finish");
  });

  test("read_page is always present", () => {
    const result = filterTools({ isSubAgent: true, isBatch: true, hasAttachments: false });
    const names = toolNames(result);
    expect(names).toContain("read_page");
  });
});
