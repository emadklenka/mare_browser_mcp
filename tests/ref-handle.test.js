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

// The dispatch action must fire a real CustomEvent carrying its detail payload,
// bubbling by default — this is how web-component inputs (LWC/Stencil) receive
// value changes when native value-setting is ignored.
test("dispatch action fires a CustomEvent with detail that bubbles", async () => {
  await page.setContent(`<div id="host"><button id="b">x</button></div>`);
  await page.evaluate(() => {
    window.__caught = null;
    document.addEventListener("mychange", (e) => { window.__caught = e.detail; });
  });

  const res = await browserAct({ commands: [
    { action: "dispatch", selector: "#b", event: "mychange", detail: { name: "email", value: "a@b.com" } },
  ] });
  assert.equal(res.results[0].success, true, JSON.stringify(res.results[0]));

  const caught = await page.evaluate(() => window.__caught);
  assert.deepEqual(caught, { name: "email", value: "a@b.com" }, "listener must receive the dispatched detail via bubbling");
});

// composed:true (the default) is what lets the event cross a shadow boundary —
// without it, a listener on the host outside the shadow root never sees it.
test("dispatch action crosses shadow boundaries with composed default", async () => {
  await page.setContent(`<div id="host"></div>`);
  await page.evaluate(() => {
    window.__crossed = false;
    const host = document.getElementById("host");
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="inner">x</button>`;
    document.addEventListener("crossed", () => { window.__crossed = true; });
  });

  const res = await browserAct({ commands: [
    { action: "dispatch", selector: "#inner", event: "crossed" },
  ] });
  assert.equal(res.results[0].success, true, JSON.stringify(res.results[0]));

  const crossed = await page.evaluate(() => window.__crossed);
  assert.equal(crossed, true, "composed event must escape the shadow root to the document listener");
});
