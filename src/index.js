#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium } from "playwright";
import dotenv from "dotenv";

dotenv.config();

// ─── State ────────────────────────────────────────────────────────────────────
let browser = null;
let context = null;
let page = null;
let consoleLog = [];
let networkLog = [];

const HEADLESS = process.env.HEADLESS === "true";
const REAL_CHROME = process.env.REAL_CHROME === "true";
const CHROME_PROFILE = process.env.CHROME_PROFILE || "Default";
const MAX_BODY_SIZE = 16 * 1024; // 16KB max captured response body

// ─── Lazy init ────────────────────────────────────────────────────────────────
async function isPageAlive() {
  if (!page) return false;
  try {
    await page.evaluate(() => true);
    return true;
  } catch {
    return false;
  }
}

async function teardown() {
  page = null;
  try { await context?.close(); } catch {}
  try { await browser?.close(); } catch {}
  context = null;
  browser = null;
}

async function ensureBrowser() {
  if (page && await isPageAlive()) return;

  // Dead session — clean up before reinitialising
  if (page) await teardown();

  if (REAL_CHROME) {
     const userDataDir = `${process.env.HOME}/Library/Application Support/Google/Chrome-MCP`;
    context = await chromium.launchPersistentContext(userDataDir, {
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
    browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        "--start-maximized",
        "--disable-blink-features=AutomationControlled",
      ],
    });
    context = await browser.newContext({
      viewport: null,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    });
  }
  page = await context.newPage();

  // Hide automation signals from Cloudflare / bot-detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    window.chrome = { runtime: {} };
  });

  page.on("console", msg => {
    consoleLog.push({ type: msg.type(), text: msg.text(), ts: new Date().toISOString() });
    if (consoleLog.length > 100) consoleLog.shift();
  });

  page.on("pageerror", err => {
    consoleLog.push({ type: "pageerror", text: err.message, ts: new Date().toISOString() });
    if (consoleLog.length > 100) consoleLog.shift();
  });

  page.on("response", async res => {
    const url = res.url();
    // Only capture API/XHR responses, skip static assets
    if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico)(\?|$)/.test(url)) return;

    const entry = {
      url,
      method: res.request().method(),
      status: res.status(),
      ts: new Date().toISOString(),
    };

    try {
      const contentType = res.headers()["content-type"] || "";
      if (contentType.includes("json")) {
        const buf = await res.body();
        if (buf.length <= MAX_BODY_SIZE) {
          entry.body = JSON.parse(buf.toString("utf-8"));
        } else {
          entry.body = `[truncated: ${buf.length} bytes]`;
        }
      }
    } catch {
      // body may not be available (e.g. redirects)
    }

    networkLog.push(entry);
    if (networkLog.length > 200) networkLog.shift();
  });

  page.on("requestfailed", req => {
    networkLog.push({
      url: req.url(),
      method: req.method(),
      failed: true,
      error: req.failure()?.errorText,
      ts: new Date().toISOString(),
    });
    if (networkLog.length > 200) networkLog.shift();
  });
}

// ─── Tool handlers ────────────────────────────────────────────────────────────
async function browserNavigate({ url, clear_logs }) {
  await ensureBrowser();
  if (clear_logs) {
    consoleLog = [];
    networkLog = [];
  }
  await page.goto(url);
  return { url, title: await page.title() };
}

async function browserAct({ commands }) {
  await ensureBrowser();
  const results = [];

  for (const cmd of commands) {
    try {
      switch (cmd.action) {
        case "click":
          await page.locator(cmd.selector).first().click({ timeout: 5000 });
          results.push({ action: "click", selector: cmd.selector, success: true });
          break;

        case "clicklink": {
          let loc;
          // 1. Role-based, partial match, visible
          loc = page.getByRole("link", { name: cmd.text, exact: false })
                    .locator(':visible');
          // 2. Any visible <a> containing the text
          if ((await loc.count()) === 0)
            loc = page.locator('a:visible').filter({ hasText: cmd.text });
          // 3. Broaden to any visible interactive element (buttons, tabs, etc.)
          if ((await loc.count()) === 0)
            loc = page.locator('a:visible, button:visible, [role="button"]:visible, [role="tab"]:visible')
                      .filter({ hasText: cmd.text });
          if ((await loc.count()) === 0)
            throw new Error(`No visible element found with text "${cmd.text}"`);
          await loc.first().click({ timeout: 5000 });
          results.push({ action: "clicklink", text: cmd.text, success: true });
          break;
        }

        case "fill":
          await page.fill(cmd.selector, cmd.value);
          results.push({ action: "fill", selector: cmd.selector, success: true });
          break;

        case "select":
          await page.locator(cmd.selector).first().selectOption(cmd.value, { timeout: 5000 });
          results.push({ action: "select", selector: cmd.selector, value: cmd.value, success: true });
          break;

        case "keypress":
          await page.keyboard.press(cmd.key);
          results.push({ action: "keypress", key: cmd.key, success: true });
          break;

        case "waitfor":
          await page.waitForSelector(cmd.selector, { timeout: cmd.timeout || 5000 });
          results.push({ action: "waitfor", selector: cmd.selector, success: true });
          break;

        case "scrollto":
          await page.locator(cmd.selector).scrollIntoViewIfNeeded();
          results.push({ action: "scrollto", selector: cmd.selector, success: true });
          break;

        case "wait":
          await page.waitForTimeout(cmd.ms || 1000);
          results.push({ action: "wait", ms: cmd.ms, success: true });
          break;

        case "clearconsole":
          consoleLog = [];
          await page.evaluate(() => console.clear());
          results.push({ action: "clearconsole", success: true });
          break;

        default:
          results.push({ action: cmd.action, success: false, error: "Unknown action" });
      }
    } catch (err) {
      results.push({ action: cmd.action, success: false, error: err.message });
    }
  }

  return { results };
}

async function browserDebug({ url_filter, method_filter, console_types, last_n }) {
  await ensureBrowser();

  const url = page.url();
  const title = await page.title();

  let logs = consoleLog;
  if (console_types?.length) logs = logs.filter(l => console_types.includes(l.type));

  let network = networkLog;
  if (url_filter) network = network.filter(r => r.url.includes(url_filter));
  if (method_filter) network = network.filter(r => r.method === method_filter.toUpperCase());

  const n = last_n || 50;

  return {
    current_url: url,
    title,
    console: logs.slice(-n),
    network: network.slice(-n),
  };
}

async function browserQuery({ selector, all, fields }) {
  await ensureBrowser();

  const data = await page.evaluate(
    ({ sel, all, fields }) => {
      const extract = el => {
        if (!el) return null;
        if (fields?.length) {
          const out = {};
          for (const f of fields) {
            if (f === "text") out.text = el.textContent?.trim() || "";
            if (f === "value") out.value = el.value ?? null;
            if (f === "visible") out.visible = el.offsetParent !== null;
            if (f === "disabled") out.disabled = !!el.disabled;
            if (f === "className") out.className = el.className || null;
            if (f === "href") out.href = el.href || null;
            if (f === "innerHTML") out.innerHTML = el.innerHTML || null;
          }
          return out;
        }
        return {
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim() || "",
          visible: el.offsetParent !== null,
        };
      };
      if (all) return Array.from(document.querySelectorAll(sel)).map(extract);
      return extract(document.querySelector(sel));
    },
    { sel: selector, all, fields }
  );

  return { selector, result: data };
}

async function browserScreenshot() {
  await ensureBrowser();
  const buffer = await page.screenshot();
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType: "image/png",
  };
}

async function browserEval({ code }) {
  await ensureBrowser();
  const result = await page.evaluate(code);
  return { result };
}

async function browserScroll({ direction, pixels, selector }) {
  await ensureBrowser();

  if (selector) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    return { scrolled_to: selector };
  }

  const px = pixels || 500;
  const dy = direction === "up" ? -px : px;

  await page.evaluate(dy => window.scrollBy(0, dy), dy);

  const position = await page.evaluate(() => ({
    scrollTop: document.documentElement.scrollTop || document.body.scrollTop,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));

  return { scrolled_by: dy, ...position };
}

async function browserRestart({ url }) {
  await teardown();
  consoleLog = [];
  networkLog = [];
  await ensureBrowser();
  if (url) {
    await page.goto(url);
    return { restarted: true, url, title: await page.title() };
  }
  return { restarted: true };
}

async function browserUpload({ selector, files }) {
  await ensureBrowser();
  await page.setInputFiles(selector, files);
  return { selector, files, success: true };
}

async function browserWaitForNetwork({ url_pattern, method, timeout }) {
  await ensureBrowser();
  const ms = timeout || 10000;

  const response = await page.waitForResponse(
    res => {
      const matches_url = url_pattern ? res.url().includes(url_pattern) : true;
      const matches_method = method ? res.request().method().toUpperCase() === method.toUpperCase() : true;
      return matches_url && matches_method;
    },
    { timeout: ms }
  );

  const result = {
    url: response.url(),
    method: response.request().method(),
    status: response.status(),
  };

  try {
    const contentType = response.headers()["content-type"] || "";
    if (contentType.includes("json")) {
      const buf = await response.body();
      if (buf.length <= MAX_BODY_SIZE) {
        result.body = JSON.parse(buf.toString("utf-8"));
      } else {
        result.body = `[truncated: ${buf.length} bytes]`;
      }
    }
  } catch {
    // body may not be available
  }

  return result;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
const server = new Server(
  { name: "mare-browser-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "browser_navigate",
      description:
        "Navigate the browser to a URL. Optionally clear console and network logs before navigating (recommended when starting a new task).",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to navigate to" },
          clear_logs: {
            type: "boolean",
            description: "Clear console and network logs before navigating",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "browser_act",
      description:
        "Perform one or more browser actions in sequence: click, fill, keypress, scroll, wait. Batch multiple steps into one call.",
      inputSchema: {
        type: "object",
        properties: {
          commands: {
            type: "array",
            description: "Ordered list of actions to execute",
            items: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: ["click", "clicklink", "fill", "select", "keypress", "waitfor", "scrollto", "wait", "clearconsole"],
                },
                selector: { type: "string", description: "CSS selector (for click, fill, waitfor, scrollto)" },
                text: { type: "string", description: "Link text (for clicklink)" },
                value: { type: "string", description: "Text to fill (for fill)" },
                key: { type: "string", description: "Key to press e.g. Enter, Tab (for keypress)" },
                timeout: { type: "number", description: "Timeout ms (for waitfor)" },
                ms: { type: "number", description: "Milliseconds to wait (for wait)" },
              },
              required: ["action"],
            },
          },
        },
        required: ["commands"],
      },
    },
    {
      name: "browser_debug",
      description:
        "PREFERRED DEBUGGING TOOL. Returns current URL, page title, console logs, and network requests (with status codes and JSON response bodies) in one call. Always call this before browser_screenshot. Filters available for focused debugging.",
      inputSchema: {
        type: "object",
        properties: {
          url_filter: { type: "string", description: "Filter network requests by URL substring" },
          method_filter: { type: "string", description: "Filter network requests by method e.g. POST, GET" },
          console_types: {
            type: "array",
            items: { type: "string" },
            description: "Filter console by type: error, warning, log, pageerror",
          },
          last_n: { type: "number", description: "Return last N entries (default 50)" },
        },
      },
    },
    {
      name: "browser_query",
      description:
        "Query DOM elements by CSS selector. Use to check element state, text, visibility, or values without taking a screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector" },
          all: { type: "boolean", description: "Return all matching elements (default false = first only)" },
          fields: {
            type: "array",
            items: { type: "string" },
            description: "Fields to extract: text, value, visible, disabled, className, href, innerHTML. Default: tag + text + visible",
          },
        },
        required: ["selector"],
      },
    },
    {
      name: "browser_screenshot",
      description:
        "LAST RESORT. Returns a PNG screenshot as base64. Expensive and unstructured. Only use when the problem is purely visual (layout, rendering glitch). Always try browser_debug and browser_query first.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "browser_eval",
      description:
        "Execute JavaScript in the page context and return the result. Use for calling APIs (fetch), reading JS variables, manipulating the DOM, or anything that needs to run in the browser. The code is evaluated as an expression — use an IIFE for multi-statement code.",
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "JavaScript code to evaluate in the page. For async code use: (async () => { ... })(). Return value is serialized as JSON.",
          },
        },
        required: ["code"],
      },
    },
    {
      name: "browser_scroll",
      description:
        "Scroll the page. Either scroll by pixels (up/down) or scroll to a specific element. Returns scroll position info.",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction (default: down)" },
          pixels: { type: "number", description: "Pixels to scroll (default: 500). Use large values like 99999 to scroll to top/bottom." },
          selector: { type: "string", description: "CSS selector to scroll into view (overrides direction/pixels)" },
        },
      },
    },
    {
      name: "browser_restart",
      description:
        "Close and reopen the browser session. Use when the page is dead, crashed, or stuck after navigating to an external site. Optionally navigate to a URL immediately after restart.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to navigate to after restart (optional)" },
        },
      },
    },
    {
      name: "browser_upload",
      description: "Upload one or more files to a file input element. Use the CSS selector to target the input and provide absolute file paths.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector for the file input element" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute path(s) to the file(s) to upload",
          },
        },
        required: ["selector", "files"],
      },
    },
    {
      name: "browser_wait_for_network",
      description:
        "Wait for a specific network response matching URL pattern and/or method. Returns the response with status and JSON body. Use after triggering an action to wait for its API call to complete instead of guessing with wait times.",
      inputSchema: {
        type: "object",
        properties: {
          url_pattern: { type: "string", description: "URL substring to match (e.g. '/api/documents')" },
          method: { type: "string", description: "HTTP method to match e.g. GET, POST" },
          timeout: { type: "number", description: "Max wait time in ms (default: 10000)" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params;

  try {
    let result;

    switch (name) {
      case "browser_navigate":         result = await browserNavigate(args); break;
      case "browser_act":              result = await browserAct(args); break;
      case "browser_debug":            result = await browserDebug(args ?? {}); break;
      case "browser_query":            result = await browserQuery(args); break;
      case "browser_screenshot":       result = await browserScreenshot(); break;
      case "browser_eval":             result = await browserEval(args); break;
      case "browser_scroll":           result = await browserScroll(args ?? {}); break;
      case "browser_restart":          result = await browserRestart(args ?? {}); break;
      case "browser_upload":           result = await browserUpload(args); break;
      case "browser_wait_for_network": result = await browserWaitForNetwork(args); break;
      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }

    if (name === "browser_screenshot") {
      return { content: [{ type: "image", data: result.data, mimeType: result.mimeType }] };
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
