import { checkNoProgress, didSomethingHappen, noteActionProgress } from "../src/lib/agentLoop.js";

// The identity-based repeat guard is keyed on element_id, and ids are reissued
// on every scan — so an agent clicking the same button over and over produces a
// different signature each time and that guard never fires. This one counts
// outcomes instead, which is what survives id churn.

function runActions(ctx, outcomes) {
  const blocks = [];
  for (const changed of outcomes) {
    blocks.push(checkNoProgress(ctx));
    noteActionProgress(ctx, changed);
  }
  return blocks;
}

test("stays quiet while actions are actually changing the page", () => {
  const ctx = {};
  const blocks = runActions(ctx, [true, true, true, true, true, true, true, true]);
  expect(blocks.every((b) => b === null)).toBe(true);
});

test("fires after 5 consecutive actions that changed nothing", () => {
  const ctx = {};
  const blocks = runActions(ctx, [false, false, false, false, false, false]);
  expect(blocks.slice(0, 5).every((b) => b === null)).toBe(true);
  expect(blocks[5]).toMatchObject({ ok: false });
  expect(blocks[5].error).toMatch(/left the page unchanged/);
});

test("a single successful action resets the streak", () => {
  const ctx = {};
  // Four dead actions, one that works, then four more dead ones: never 5 in a row.
  const blocks = runActions(ctx, [false, false, false, false, true, false, false, false, false]);
  expect(blocks.every((b) => b === null)).toBe(true);
});

// Every tool reports "it worked" differently, and reading only page_changed
// counts a run of real navigations or scrolls as dead actions.
describe("didSomethingHappen", () => {
  test("a click that changed the page counts", () => {
    expect(didSomethingHappen({ page_changed: true }, true)).toBe(true);
  });

  test("a click that changed nothing does not", () => {
    expect(didSomethingHappen({ page_changed: false }, false)).toBe(false);
  });

  test("navigate/switch_tab/open_tab count — they carry no page_changed at all", () => {
    expect(didSomethingHappen({ tab_id: 7 }, true)).toBe(true);
    expect(didSomethingHappen({ tab_id: 7, navigated: true }, false)).toBe(true);
  });

  test("a scroll that moved counts even when the page content is static", () => {
    expect(didSomethingHappen({ page_changed: false, scrolled_by: 800 }, false)).toBe(true);
    expect(didSomethingHappen({ page_changed: false, scrolled_by: 0 }, false)).toBe(false);
  });
});

test("warns once per streak rather than wedging the run", () => {
  const ctx = {};
  const blocks = runActions(ctx, Array(12).fill(false));
  expect(blocks.filter((b) => b !== null)).toHaveLength(2);
});
