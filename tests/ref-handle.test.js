import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { state } from "../src/state.js";
import { browserSnapshot, browserAct } from "../src/tools.js";

// These tests drive the REAL browserSnapshot/browserAct against a live page.
// ensureBrowser() is a no-op when state.page is already alive, so we inject our
// own page into `state` and exercise the actual ref-resolution code path.

let browser, context, page;

beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
  state.browser = browser;
  state.context = context;
  state.page = page;
  state.refMap.clear();
  state.refCounter = 0;
});

afterEach(async () => {
  state.page = null;
  state.context = null;
  state.browser = null;
  await context?.close();
  await browser?.close();
});

// The core regression: an interactive element WITHOUT an id resolves through a
// positional (nth-of-type) selector. If the DOM reflows between snapshot and
// action, that selector silently points at a DIFFERENT element. A ref must stay
// pinned to the exact element it was captured on.
test("ref stays pinned to its original element after the DOM reflows", async () => {
  await page.setContent(`
    <ul id="list">
      <li><button onclick="window.__clicked='A'">Item</button></li>
      <li><button onclick="window.__clicked='B'">Item</button></li>
      <li><button onclick="window.__clicked='C'">Item</button></li>
    </ul>
  `);

  await browserSnapshot({});
  // Three interactive buttons in DOM order → e1, e2, e3. e3 is Button C.

  // Reflow: prepend a new item, shifting every positional selector down by one.
  await page.evaluate(() => {
    const li = document.createElement("li");
    li.innerHTML = `<button onclick="window.__clicked='X'">Item</button>`;
    document.getElementById("list").prepend(li);
  });

  const res = await browserAct({ commands: [{ action: "click", ref: "e3" }] });
  assert.equal(res.results[0].success, true, JSON.stringify(res.results[0]));

  const clicked = await page.evaluate(() => window.__clicked);
  assert.equal(clicked, "C", `ref e3 must still hit the original Button C, got "${clicked}"`);
});

// When the captured element is removed/replaced (e.g. a framework re-render),
// the ref must fail loudly instead of silently clicking whatever now sits there.
test("ref fails loudly when its element is replaced, never silently mis-clicks", async () => {
  await page.setContent(`<button onclick="window.__hit='real'">Real</button>`);
  await browserSnapshot({});

  await page.evaluate(() => {
    document.body.innerHTML = `<button onclick="window.__hit='other'">Other</button>`;
  });

  const res = await browserAct({ commands: [{ action: "click", ref: "e1" }] });
  assert.equal(
    res.results[0].success,
    false,
    "clicking a replaced ref must fail, not silently hit the replacement"
  );

  const hit = await page.evaluate(() => window.__hit);
  assert.notEqual(hit, "other", "must not silently click the replacement element");
});
