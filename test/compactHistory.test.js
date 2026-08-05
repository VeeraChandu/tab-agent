import { compactHistory } from "../src/lib/agentLoop.js";

// click/type_text/navigate results carry a full page scan inline (see
// attachPageState), so they now share the "freshest page scan" slot with
// read_page. Getting that wrong either balloons every long run's token cost
// (nothing compacted) or throws away the only current view of the page.

const PAGE = { url: "https://example.com/list", title: "List", visible_text: "x".repeat(400), interactive_elements: [] };

function scanResult(extra = {}) {
  return JSON.stringify({ ok: true, ...PAGE, ...extra });
}

// tool_use blocks live in assistant turns; their results in the next user turn.
function history(...calls) {
  const turns = [];
  calls.forEach(({ name, result }, i) => {
    turns.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name }] });
    turns.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: result }] });
  });
  return turns;
}

const resultAt = (h, i) => JSON.parse(h[i * 2 + 1].content[0].content);

describe("compactHistory with page scans embedded in actions", () => {
  test("a click's embedded scan supersedes an earlier read_page", () => {
    const h = history(
      { name: "read_page", result: scanResult() },
      { name: "click", result: JSON.stringify({ ok: true, page_changed: true, url: PAGE.url, page: PAGE }) }
    );
    compactHistory(h, false);

    expect(resultAt(h, 0).note).toMatch(/Earlier read_page result omitted/);
    expect(resultAt(h, 1).page).toEqual(PAGE); // freshest scan kept in full
  });

  test("a later read_page strips an earlier click's embedded scan but keeps the outcome", () => {
    const h = history(
      { name: "click", result: JSON.stringify({ ok: true, page_changed: true, url: PAGE.url, page: PAGE }) },
      { name: "read_page", result: scanResult() }
    );
    compactHistory(h, false);

    const click = resultAt(h, 0);
    expect(typeof click.page).toBe("string");
    expect(click.page).toMatch(/omitted to save context/);
    expect(click.page_changed).toBe(true); // what the action DID stays in history
    expect(click.url).toBe(PAGE.url);
    expect(resultAt(h, 1).visible_text).toBe(PAGE.visible_text);
  });

  test("with the recall cache on, a stripped scan points at recall_page by url", () => {
    const h = history(
      { name: "navigate", result: JSON.stringify({ ok: true, page: PAGE }) },
      { name: "click", result: JSON.stringify({ ok: true, page_changed: true, page: PAGE }) }
    );
    compactHistory(h, true);

    expect(resultAt(h, 0).page).toContain(`recall_page with url "${PAGE.url}"`);
  });

  test("an action that changed nothing can't evict a real read_page", () => {
    const noChange = JSON.stringify({
      ok: true,
      page_changed: false,
      note: "Nothing changed, and the click point is covered by <div.banner> ".repeat(4),
    });
    const h = history({ name: "read_page", result: scanResult() }, { name: "click", result: noChange });
    compactHistory(h, false);

    expect(resultAt(h, 0).visible_text).toBe(PAGE.visible_text); // still the freshest scan
    expect(resultAt(h, 1).note).toMatch(/covered by/); // untouched
  });

  test("only the newest of several embedded scans survives", () => {
    const click = () => JSON.stringify({ ok: true, page_changed: true, page: PAGE });
    const h = history({ name: "click", result: click() }, { name: "type_text", result: click() }, { name: "click", result: click() });
    compactHistory(h, false);

    expect(typeof resultAt(h, 0).page).toBe("string");
    expect(typeof resultAt(h, 1).page).toBe("string");
    expect(resultAt(h, 2).page).toEqual(PAGE);
  });
});
