#!/usr/bin/env node
// MCP server entry point. Imports handlers from tools.js + emulation.js,
// registers them with the MCP SDK, and starts the stdio transport.
//
// All logic lives in sibling modules:
//   state.js     — shared mutable state + env/config constants
//   browser.js   — Playwright lifecycle + page event listeners
//   tools.js     — non-emulation tool handlers
//   emulation.js — presets, resolver, verification, browserEmulateDevice

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";

import {
  browserNavigate,
  browserAct,
  browserDebug,
  browserQuery,
  browserScreenshot,
  browserEval,
  browserScroll,
  browserRestart,
  browserUpload,
  browserWaitForNetwork,
  browserFetch,
  browserSnapshot,
  browserWaitForUrl,
} from "./tools.js";
import { browserEmulateDevice } from "./emulation.js";

dotenv.config();

const server = new Server(
  { name: "mare-browser-mcp", version: "1.5.1" },
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
        `Perform one or more browser actions in sequence. Batch multiple steps into one call.

Two ways to target an element — use whichever is more stable:
• ref — accessibility ref from browser_snapshot (preferred). LLM-friendly: no selector guessing, survives CSS class churn, resistant to obfuscated build output. Call browser_snapshot first to get refs like "e9", "e42", then pass them to actions: { action: "click", ref: "e9" }.
• selector — raw CSS selector. Use when you already know it, or for elements not in the a11y tree.

Example ref flow:
  1. browser_snapshot()              → { snapshot, refs: [{ref: "e9", role: "button", name: "Sign in"}] }
  2. browser_act({ commands: [{ action: "click", ref: "e9" }] })

Available actions:
• click — click an element (supports left/right/middle button). Use button:'right' for context menus
• hover — hover over an element for tooltips, dropdown menus, hover states
• drag — drag an element to a target selector (column reorder, kanban) OR by pixel offset (column resize, sliders). Use target for element-to-element, offsetX/offsetY for precise pixel drag
• clicklink — click a link/button by visible text (text-based; does not use ref/selector)
• fill — fill an input field (clears first)
• select — select a dropdown option
• keypress — press a key (Enter, Tab, Escape, etc.) — keyboard action, no ref/selector needed
• waitfor — wait for an element to appear
• scrollto — scroll an element into view
• wait — pause for N milliseconds (no target)
• clearconsole — clear captured console logs (no target)

click, hover, drag, fill, select, waitfor, scrollto all accept either 'ref' or 'selector'. If both are provided, 'ref' wins. Refs are invalidated on navigation — re-snapshot if the page has changed.`,
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
                  enum: ["click", "hover", "drag", "clicklink", "fill", "select", "keypress", "waitfor", "scrollto", "wait", "clearconsole"],
                },
                selector: { type: "string", description: "CSS selector (for click, hover, drag, fill, waitfor, scrollto)" },
                ref: { type: "string", description: "Accessibility ref from browser_snapshot (alternative to selector for click, hover, drag, fill, select, waitfor, scrollto)" },
                button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button for click (default: left). Use 'right' for context menus" },
                target: { type: "string", description: "CSS selector of drop target (for drag — element-to-element drag)" },
                offsetX: { type: "number", description: "Horizontal pixels to drag (for drag — precise pixel drag, e.g. column resize)" },
                offsetY: { type: "number", description: "Vertical pixels to drag (for drag — precise pixel drag, e.g. slider)" },
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
        `PREFERRED DEBUGGING TOOL. Returns current URL, page title, console logs, dialogs (alert/confirm/prompt), and rich network requests in one call. Always call this before browser_screenshot.
Network entries include: method, URL, query params (parsed), request body (JSON/form), request headers (auth masked), status code, response body (JSON), and duration_ms for performance analysis.
Use url_filter and method_filter to focus on specific API calls. Use console_types to filter log levels.`,
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
        "Query DOM elements by CSS selector. Use to check element state, text, visibility, or values without taking a screenshot. Use visible_only and limit to avoid huge result sets on broad selectors.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector" },
          all: { type: "boolean", description: "Return all matching elements (default false = first only)" },
          count_only: { type: "boolean", description: "Just return the count of matching elements — no element data. Fast way to check 'how many rows?', 'how many errors?'. Combines with visible_only." },
          visible_only: { type: "boolean", description: "Only return/count visible elements — filters out hidden/offscreen elements (default false). Recommended for broad selectors." },
          limit: { type: "number", description: "Max number of elements to return when using all:true (e.g. 10, 20). Prevents huge payloads on broad selectors." },
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
      name: "browser_fetch",
      description:
        "Execute an authenticated fetch() request inside the page context. Inherits the page's cookies and session — same-origin requests work automatically, cross-origin requires CORS. Returns status, headers, and parsed body. Appears in browser_debug network log.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch (relative or absolute)" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method (default: GET)" },
          body: { description: "Request body — auto-JSON-encoded if object" },
          headers: { type: "object", description: "Additional request headers (merged over defaults)" },
          parse: { type: "string", enum: ["json", "text", "status"], description: "Response parse mode (default: json, falls back to text on parse error)" },
        },
        required: ["url"],
      },
    },
    {
      name: "browser_snapshot",
      description:
        `Return the accessibility tree of the current page with refs attached to interactive elements (buttons, links, textboxes, checkboxes, etc.). Use this INSTEAD of guessing CSS selectors from a screenshot — selectors break on class-name churn, refs don't.

Returns { url, snapshot: [...tree], refs: [{ref, selector, role, name}, ...] }.

Each ref like "e9" maps internally to a stable selector. Pass refs to browser_act:
  browser_act({ commands: [
    { action: "fill", ref: "e42", value: "user@example.com" },
    { action: "click", ref: "e9" }
  ]})

Refs are invalidated automatically on navigation — re-snapshot after any browser_navigate or URL change. max_depth defaults to 10.`,
      inputSchema: {
        type: "object",
        properties: {
          max_depth: { type: "number", description: "Max tree depth (default: 10)" },
        },
      },
    },
    {
      name: "browser_wait_for_url",
      description:
        "Wait for the page URL to change and match a substring pattern. Use after actions that trigger redirects (JS redirects, auth redirects, SPA route changes). Returns current URL on timeout.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "URL substring to match" },
          timeout: { type: "number", description: "Max wait time in ms (default: 10000)" },
        },
        required: ["pattern"],
      },
    },
    {
      name: "browser_screenshot",
      description:
        "LAST RESORT. Returns a screenshot as base64. Expensive and unstructured. Only use when the problem is purely visual (layout, rendering glitch). Always try browser_debug and browser_query first.",
      inputSchema: {
        type: "object",
        properties: {
          quality: { type: "string", enum: ["thumbnail", "normal", "fullres"], description: "thumbnail: ~400px JPEG, small/fast. normal: full viewport PNG (default). fullres: full-page PNG." },
        },
      },
    },
    {
      name: "browser_eval",
      description:
        `Execute JavaScript in the page context and return the result. This is your ESCAPE HATCH for anything the other tools don't cover. Common use cases:
• Read computed styles: getComputedStyle(el).backgroundColor
• Append text to inputs without clearing: el.value += '...'; el.dispatchEvent(new Event('input', {bubbles:true}))
• Type character-by-character for autocomplete: use dispatchEvent with input events per character
• Drag-and-drop: create and dispatch mousedown/mousemove/mouseup or dragstart/drop events
• Read JS app state: window.__store__, React devtools, etc.
• Check visibility via CSS: getComputedStyle(el).display, opacity, visibility
• Scroll inside a container: document.querySelector('.container').scrollTop += 500
The code is evaluated as an expression — use an IIFE for multi-statement code.`,
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
        "Scroll the page, scroll within a specific container element (e.g. AG-Grid viewport, chat panel, sidebar), or scroll an element into view. Use 'container' to scroll inside scrollable divs instead of the page.",
      inputSchema: {
        type: "object",
        properties: {
          direction: { type: "string", enum: ["up", "down"], description: "Scroll direction (default: down)" },
          pixels: { type: "number", description: "Pixels to scroll (default: 500). Use large values like 99999 to scroll to top/bottom." },
          selector: { type: "string", description: "CSS selector to scroll into view (overrides direction/pixels)" },
          container: { type: "string", description: "CSS selector of a scrollable container to scroll within (e.g. '.ag-body-viewport', '.chat-messages')" },
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
    {
      name: "browser_emulate_device",
      description:
        `Switch the browser session into a device emulation profile (iPhone / iPad / Android tablet / desktop reset / custom). Emulation lives on the browser context — it persists across browser_navigate calls until you swap to another device or call browser_restart.

IMPORTANT behaviors:
• Swapping devices recreates the browser context but cookies + localStorage are PRESERVED (via persistent storageState). Pages behind auth stay logged in across swaps. The tool auto-navigates back to the URL you were on. IndexedDB is not preserved — PWAs that store auth tokens there may require re-login.
• innerWidth: 980 on a mobile emulation is NOT a bug. It means the current page has no <meta name="viewport"> and is using Chrome's legacy fallback. Check verified.layout_mode — it will be "legacy-980-fallback" in this case. The authoritative signals that emulation is working are: userAgent, pointer_coarse, hasTouch, devicePixelRatio.
• browser_restart always clears emulation (back to desktop).
• Not supported in REAL_CHROME mode (returns an error).

Presets and natural viewports (portrait):
• iphone-15-pro-max (430×932), iphone-15-pro (393×852), iphone-15 (393×852), iphone-se (375×667)
• galaxy-s24 (360×800)
• ipad-pro-13 (1024×1366), ipad-pro-11 (834×1194), ipad-mini (768×1024)
• galaxy-tab-s9 (800×1280)
• desktop-chrome (1280×800, DPR 1, no touch — use this to reset)
• custom — requires custom.userAgent + custom.viewport.{width,height}

Returns { ok, active, previous_url, previous_url_restored, verified }. On failure: { ok: false, error, verified? }.`,
      inputSchema: {
        type: "object",
        properties: {
          device: {
            type: "string",
            enum: [
              "iphone-15-pro-max", "iphone-15-pro", "iphone-15", "iphone-se",
              "galaxy-s24",
              "ipad-pro-13", "ipad-pro-11", "ipad-mini", "galaxy-tab-s9",
              "desktop-chrome",
              "custom",
            ],
            description: "Device preset key, or 'custom' to supply your own options.",
          },
          orientation: {
            type: "string",
            enum: ["portrait", "landscape"],
            description: "Optional. Defaults to the device's natural orientation. Swaps viewport + screen width/height.",
          },
          custom: {
            type: "object",
            description: "Required iff device === 'custom'. Must include userAgent and viewport.{width,height}.",
            properties: {
              userAgent: { type: "string" },
              viewport: {
                type: "object",
                properties: {
                  width: { type: "number" },
                  height: { type: "number" },
                },
                required: ["width", "height"],
              },
              deviceScaleFactor: { type: "number", description: "Default 2" },
              isMobile: { type: "boolean", description: "Default true when custom is provided" },
              hasTouch: { type: "boolean", description: "Default true when custom is provided" },
            },
            required: ["userAgent", "viewport"],
          },
        },
        required: ["device"],
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
      case "browser_screenshot":       result = await browserScreenshot(args ?? {}); break;
      case "browser_eval":             result = await browserEval(args); break;
      case "browser_scroll":           result = await browserScroll(args ?? {}); break;
      case "browser_restart":          result = await browserRestart(args ?? {}); break;
      case "browser_upload":           result = await browserUpload(args); break;
      case "browser_wait_for_network": result = await browserWaitForNetwork(args); break;
      case "browser_fetch":            result = await browserFetch(args); break;
      case "browser_snapshot":         result = await browserSnapshot(args ?? {}); break;
      case "browser_wait_for_url":     result = await browserWaitForUrl(args); break;
      case "browser_emulate_device":   result = await browserEmulateDevice(args); break;
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

const transport = new StdioServerTransport();
await server.connect(transport);
