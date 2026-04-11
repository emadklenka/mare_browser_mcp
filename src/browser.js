// Browser lifecycle: lazy init, teardown, and the Playwright event listeners
// that feed the module-level console/network/dialog logs.
//
// All mutable browser references live on `state` from state.js — this module
// reads and writes `state.browser`, `state.context`, `state.page` directly so
// every other module that imports state sees the current values.

import { chromium } from "playwright";
import { state, HEADLESS, REAL_CHROME, MAX_BODY_SIZE, CHROME_PROFILE, UA_DESKTOP_CHROME, saveState, loadStateOptions } from "./state.js";

export async function isPageAlive() {
  if (!state.page) return false;
  try {
    await state.page.evaluate(() => true);
    return true;
  } catch {
    return false;
  }
}

export async function teardown() {
  const ctx = state.context;
  state.page = null;
  await saveState(ctx);
  try { await ctx?.close(); } catch {}
  try { await state.browser?.close(); } catch {}
  state.context = null;
  state.browser = null;
}

export async function ensureBrowser() {
  if (state.page && await isPageAlive()) return;

  // Dead session — clean up before reinitialising
  if (state.page) await teardown();

  if (REAL_CHROME) {
    const userDataDir = `${process.env.HOME}/Library/Application Support/Google/Chrome-MCP`;
    state.context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chrome",
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--start-maximized",
        `--profile-directory=${CHROME_PROFILE}`,
        "--disable-blink-features=AutomationControlled",
      ],
    });
  } else {
    state.browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    const baseContextOptions = state.currentEmulation
      ? { ...state.currentEmulation }
      : { viewport: null, userAgent: UA_DESKTOP_CHROME };
    const persisted = await loadStateOptions();
    state.context = await state.browser.newContext({ ...baseContextOptions, ...persisted });
  }
  state.page = await state.context.newPage();

  // Hide automation signals from Cloudflare / bot-detection
  await state.context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  state.page.on("console", msg => {
    state.consoleLog.push({ type: msg.type(), text: msg.text(), ts: new Date().toISOString() });
    if (state.consoleLog.length > 100) state.consoleLog.shift();
  });

  state.page.on("pageerror", err => {
    state.consoleLog.push({ type: "pageerror", text: err.message, ts: new Date().toISOString() });
    if (state.consoleLog.length > 100) state.consoleLog.shift();
  });

  // ── Network: capture request start + body ──
  state.page.on("request", req => {
    const url = req.url();
    // Skip static assets and CORS preflight
    if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico)(\?|$)/.test(url)) return;
    if (req.method() === "OPTIONS") return;

    const entry = {
      url,
      method: req.method(),
      startTime: Date.now(),
      ts: new Date().toISOString(),
    };

    // Parse query params into object
    try {
      const parsed = new URL(url);
      const params = Object.fromEntries(parsed.searchParams);
      if (Object.keys(params).length) entry.params = params;
    } catch {}

    // Capture request body
    const postData = req.postData();
    if (postData) {
      const contentType = (req.headers()["content-type"] || "").toLowerCase();
      if (contentType.includes("json")) {
        try {
          entry.requestBody = postData.length <= MAX_BODY_SIZE
            ? JSON.parse(postData)
            : `[truncated: ${postData.length} bytes]`;
        } catch {
          entry.requestBody = postData.length <= MAX_BODY_SIZE ? postData : `[truncated: ${postData.length} bytes]`;
        }
      } else if (contentType.includes("x-www-form-urlencoded")) {
        try {
          entry.requestBody = Object.fromEntries(new URLSearchParams(postData));
        } catch {
          entry.requestBody = postData.slice(0, MAX_BODY_SIZE);
        }
      } else if (contentType.includes("multipart")) {
        entry.requestBody = "[multipart/form-data]";
      } else if (postData.length <= MAX_BODY_SIZE) {
        entry.requestBody = postData;
      } else {
        entry.requestBody = `[binary: ${postData.length} bytes]`;
      }
    }

    // Capture filtered request headers
    const headers = req.headers();
    const filteredHeaders = {};
    if (headers["content-type"]) filteredHeaders["content-type"] = headers["content-type"];
    if (headers["authorization"]) filteredHeaders["authorization"] = headers["authorization"].replace(/^(Bearer\s+).+/, "$1***");
    if (headers["cookie"]) filteredHeaders["cookie"] = "[present]";
    if (Object.keys(filteredHeaders).length) entry.requestHeaders = filteredHeaders;

    state.pendingRequests.set(req, entry);
  });

  // ── Network: capture response + timing ──
  state.page.on("response", async res => {
    const req = res.request();
    const entry = state.pendingRequests.get(req);
    if (!entry) return; // was filtered (static asset / OPTIONS)
    state.pendingRequests.delete(req);

    entry.status = res.status();
    entry.duration_ms = Date.now() - entry.startTime;
    delete entry.startTime;

    try {
      const contentType = res.headers()["content-type"] || "";
      if (contentType.includes("json")) {
        const buf = await res.body();
        if (buf.length <= MAX_BODY_SIZE) {
          entry.responseBody = JSON.parse(buf.toString("utf-8"));
        } else {
          entry.responseBody = `[truncated: ${buf.length} bytes]`;
        }
      }
    } catch {
      // body may not be available (e.g. redirects)
    }

    state.networkLog.push(entry);
    if (state.networkLog.length > 200) state.networkLog.shift();
  });

  // ── Network: capture failed requests ──
  state.page.on("requestfailed", req => {
    const entry = state.pendingRequests.get(req) || {
      url: req.url(),
      method: req.method(),
      ts: new Date().toISOString(),
    };
    state.pendingRequests.delete(req);

    entry.failed = true;
    entry.error = req.failure()?.errorText;
    if (entry.startTime) {
      entry.duration_ms = Date.now() - entry.startTime;
      delete entry.startTime;
    }

    state.networkLog.push(entry);
    if (state.networkLog.length > 200) state.networkLog.shift();
  });

  state.page.on("dialog", async dialog => {
    state.dialogLog.push({
      type: dialog.type(),
      message: dialog.message(),
      default_value: dialog.defaultValue() || null,
      ts: new Date().toISOString(),
    });
    if (state.dialogLog.length > 50) state.dialogLog.shift();
    await dialog.accept();
  });

  state.page.on("framenavigated", () => { state.refMap.clear(); state.refCounter = 0; });
}

process.on("SIGTERM", async () => { await teardown(); process.exit(0); });
process.on("SIGINT", async () => { await teardown(); process.exit(0); });
