import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { state } from "../src/state.js";
import { browserEmulateDevice } from "../src/emulation.js";

// These tests drive the REAL browserEmulateDevice against a live page. We inject
// our own browser/context/page into `state` exactly as the other integration
// tests do; ensureBrowser() is a no-op while state.page is alive, so the handler
// runs its in-place CDP path against our page instead of rebuilding the context.
//
// The thing under test is the in-place swap: emulate via CDP WITHOUT tearing
// down the context, so the page's in-memory JS state survives. The fallback
// rebuild path is already covered indirectly (it's the old behavior); what was
// previously untested is (a) that the in-place path is actually taken, (b) that
// it preserves the page object/state, and (c) that the override SURVIVES a
// client-side navigation — the whole point of not reloading.

let browser, context, page;

beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
  state.browser = browser;
  state.context = context;
  state.page = page;
  state.currentEmulation = null;
});

afterEach(async () => {
  state.page = null;
  state.context = null;
  state.browser = null;
  state.currentEmulation = null;
  await context?.close();
  await browser?.close();
});

// A normal swap on a live page takes the in-place CDP path: identity verifies,
// the result reports in_place:true, and — critically — the SAME page object with
// its in-memory JS state survives (no context teardown, no reload).
test("emulate_device swaps in place, preserving the live page and its in-memory state", async () => {
  await page.goto("about:blank");
  // Plant state that only survives if the page is NOT reloaded/rebuilt.
  await page.evaluate(() => { window.__spaState = "survive-me"; });
  const pageRefBefore = state.page;

  const res = await browserEmulateDevice({ device: "galaxy-s24" });

  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.in_place, true, "a live-page swap must use the in-place CDP path, not a rebuild");
  assert.equal(state.page, pageRefBefore, "in-place swap must keep the same page object");

  const survived = await state.page.evaluate(() => window.__spaState);
  assert.equal(survived, "survive-me", "in-memory SPA state must survive an in-place swap");

  // Identity actually took: UA reports Android, touch is on, DPR matches.
  assert.match(res.verified.userAgent, /Android/, "UA override must be applied in place");
  assert.equal(res.verified.hasTouch, true, "touch override must be applied in place");
  assert.equal(res.verified.devicePixelRatio, 3, "DPR override must be applied in place");
});

// The open question this whole feature hinges on: does the CDP override stick
// across a client-side navigation? A real SPA route change (history.pushState +
// DOM swap, same document) must NOT lose the emulated UA / touch / DPR. If this
// regresses, an agent emulating a phone would silently revert to desktop the
// moment the app navigates.
test("in-place emulation survives a client-side (same-document) navigation", async () => {
  await page.goto("about:blank");
  const res = await browserEmulateDevice({ device: "galaxy-s24" });
  assert.equal(res.in_place, true, JSON.stringify(res));

  // SPA-style route change: no document reload, just pushState + content swap.
  await state.page.evaluate(() => {
    history.pushState({}, "", "/dashboard");
    document.body.innerHTML = "<main>dashboard</main>";
  });

  const after = await state.page.evaluate(() => ({
    ua: navigator.userAgent,
    touch: "ontouchstart" in window,
    dpr: window.devicePixelRatio,
  }));
  assert.match(after.ua, /Android/, "UA override must survive a client-side navigation");
  assert.equal(after.touch, true, "touch override must survive a client-side navigation");
  assert.equal(after.dpr, 3, "DPR override must survive a client-side navigation");
});

// Swapping back to desktop in place must clear the mobile signals — confirms the
// CDP override is re-applied, not just additive, on a second in-place swap.
test("a second in-place swap re-applies (desktop clears the prior mobile override)", async () => {
  await page.goto("about:blank");
  await browserEmulateDevice({ device: "galaxy-s24" });

  const res = await browserEmulateDevice({ device: "desktop-chrome" });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.in_place, true, "second swap on a live page must also be in-place");

  assert.match(res.verified.userAgent, /Macintosh/, "UA must flip back to desktop in place");
  assert.equal(res.verified.hasTouch, false, "touch must clear when swapping to a desktop device");
  assert.equal(res.verified.devicePixelRatio, 1, "DPR must reset to 1 for desktop");
});
