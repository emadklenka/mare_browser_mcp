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
} from "./tools.js";
import { browserEmulateDevice } from "./emulation.js";

dotenv.config();

const server = new Server(
  { name: "mare-browser-mcp", version: "1.4.2" },
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
        `Perform one or more browser actions in sequence. Batch multiple steps into one call. Available actions:
• click — click an element (supports left/right/middle button). Use button:'right' for context menus
• hover — hover over an element for tooltips, dropdown menus, hover states
• drag — drag an element to a target selector (column reorder, kanban) OR by pixel offset (column resize, sliders). Use target for element-to-element, offsetX/offsetY for precise pixel drag
• clicklink — click a link/button by visible text
• fill — fill an input field (clears first)
• select — select a dropdown option
• keypress — press a key (Enter, Tab, Escape, etc.)
• waitfor — wait for an element to appear
• scrollto — scroll an element into view
• wait — pause for N milliseconds
• clearconsole — clear captured console logs`,
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
        `Execute JavaScript in the page context and return the result. This is your ESCAPE HATCH for anything the other tools don't cover. Common use cases:
• Read computed styles: getComputedStyle(el).backgroundColor
• Append text to inputs without clearing: el.value += '...'; el.dispatchEvent(new Event('input', {bubbles:true}))
• Type character-by-character for autocomplete: use dispatchEvent with input events per character
• Drag-and-drop: create and dispatch mousedown/mousemove/mouseup or dragstart/drop events
• Call fetch() to hit APIs directly and return JSON
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
• Swapping devices tears down and recreates the browser context. Cookies and localStorage are LOST. After the swap the tool auto-navigates back to the URL you were on, but pages behind auth may land on a login page — this is expected, not a bug.
• innerWidth: 980 on a mobile emulation is NOT a bug. It means the current page has no <meta name="viewport"> and is using Chrome's legacy fallback. The authoritative signals that emulation is working are: userAgent, pointer_coarse, hasTouch, devicePixelRatio.
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
      case "browser_screenshot":       result = await browserScreenshot(); break;
      case "browser_eval":             result = await browserEval(args); break;
      case "browser_scroll":           result = await browserScroll(args ?? {}); break;
      case "browser_restart":          result = await browserRestart(args ?? {}); break;
      case "browser_upload":           result = await browserUpload(args); break;
      case "browser_wait_for_network": result = await browserWaitForNetwork(args); break;
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
