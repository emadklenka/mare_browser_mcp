# mare-browser-mcp

A lean, LLM-first browser automation MCP server. Gives Claude (or any MCP client) a real Chromium browser to navigate, interact with, and debug web apps — without the overhead of raw Playwright APIs.

Built with [Playwright](https://playwright.dev) + [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). One server = one browser session = one LLM.

**Free to use.** If it saves you time, [buy me a coffee](https://buymeacoffee.com/emadomar) ☕

---

## Install (recommended)

**Prerequisites:** Node.js 18+, pnpm

```bash
git clone https://github.com/emadklenka/mare_browser_mcp
cd mare_browser_mcp
pnpm install
npx playwright install chromium
```

This is the fastest way to run the server — starts instantly with no registry lookups.

---

## Alternative installs

**Global install** — no cloning, still fast:

```bash
pnpm add -g mare-browser-mcp
npx playwright install chromium
```

---

## Register with Claude Code

If you cloned the repo, the setup script does it for you:

```bash
pnpm run setup
```

That's it. The script detects the correct path automatically and registers the MCP with Claude Code. Restart Claude Code and the browser tools are ready.

**Manual config** — add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "mare-browser": {
      "command": "node",
      "args": ["/absolute/path/to/mare_browser_mcp/src/index.js"],
      "env": { "HEADLESS": "false" }
    }
  }
}
```

If installed globally:

```json
{
  "mcpServers": {
    "mare-browser": {
      "command": "mare-browser-mcp",
      "env": { "HEADLESS": "false" }
    }
  }
}
```

---

## Register with OpenCode

Add this to `~/.config/opencode/opencode.json` (global) or `opencode.json` (project root):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mare_browser_mcp": {
      "type": "local",
      "command": [
        "node",
        "/absolute/path/to/mare_browser_mcp/src/index.js"
      ]
    }
  }
}
```

If installed globally:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mare_browser_mcp": {
      "type": "local",
      "command": ["mare-browser-mcp"]
    }
  }
}
```

---

## Tools

### `browser_navigate(url, clear_logs?)`
Navigate to a URL. Pass `clear_logs: true` when starting a new task to wipe stale console/network/dialog history.

### `browser_act(commands[])`
Run a sequence of actions in one call. Supported actions:

| action | required params | optional params | what it does |
|---|---|---|---|
| `click` | `selector` | `button` (`left`/`right`/`middle`) | Click an element. Use `button: "right"` for context menus |
| `hover` | `selector` | | Hover over an element — triggers tooltips, dropdown menus, hover states |
| `drag` | `selector` | `target` or `offsetX`/`offsetY` | Drag an element to another element (`target`) or by pixel offset (for resizing, sliders) |
| `clicklink` | `text` | | Click a link/button by its visible text |
| `fill` | `selector`, `value` | | Type into an input (clears first) |
| `select` | `selector`, `value` | | Select a dropdown option |
| `keypress` | `key` | | Press a key (e.g. `Enter`, `Tab`, `Escape`) |
| `waitfor` | `selector` | `timeout` | Wait until element appears |
| `scrollto` | `selector` | | Scroll element into view |
| `wait` | `ms` | | Pause for N milliseconds |
| `clearconsole` | — | | Clear console log buffer |

### `browser_debug()`
**Start here when something goes wrong.** Returns in one call:
- Current URL and page title
- Console logs (filterable by type: `error`, `warning`, `log`, `pageerror`)
- Network request metadata with: method, URL, redacted query params, request headers (auth masked), status code, and `duration_ms` timing
- Dialog history (alert/confirm/prompt — auto-accepted, text captured)

Filter with `url_filter`, `method_filter`, `console_types`, or `last_n`.
Request and response bodies are omitted by default. Set `include_bodies: true` only when necessary; credential-like keys are recursively redacted in requests, responses, and query parameters.

### `browser_query(selector, all?, fields?, visible_only?, limit?, count_only?)`
Read the DOM without a screenshot. Query any element by CSS selector.

| param | what it does |
|---|---|
| `all` | Return all matching elements (default: first only) |
| `fields` | Pick fields: `text`, `value`, `visible`, `disabled`, `className`, `href`, `innerHTML` |
| `visible_only` | Filter to visible elements only — recommended for broad selectors |
| `limit` | Cap the number of results (e.g. `10`) to prevent huge payloads |
| `count_only` | Just return the count — fast way to check "how many rows?" without fetching data |

### `browser_eval(code)`
**Escape hatch** for anything the other tools don't cover:
- Read computed styles: `getComputedStyle(el).backgroundColor`
- Append text to inputs without clearing
- Type character-by-character for autocomplete
- Drag-and-drop via manual DOM events
- Call `fetch()` to hit APIs directly
- Read JS app state (`window.__store__`, etc.)
- Check CSS visibility (`display`, `opacity`, `visibility`)

### `browser_scroll(direction?, pixels?, selector?, container?)`
Three modes:
- **Page scroll:** `direction: "down", pixels: 500`
- **Scroll into view:** `selector: ".my-element"`
- **Scroll within a container:** `container: ".ag-body-viewport", direction: "down", pixels: 300` — for scrollable divs, grid viewports, chat panels

### `browser_wait_for_network(url_pattern?, method?, timeout?)`
Wait for a specific network response after triggering an action — smarter than guessing with `wait`.

### `browser_screenshot()`
Returns a PNG screenshot. **Use as a last resort** — prefer `browser_debug` and `browser_query` first.

### `browser_save_screenshot(filename?, full_page?, format?, hide_recording_pointer?)`
Save a screenshot as an artifact under the OS temp directory and return its absolute path, MIME type, byte size, physical pixel dimensions, CSS viewport, device-pixel ratio, URL, and page title. This is the preferred screenshot tool for QA evidence, documentation, and marketing assets because it avoids returning a large base64 payload.

Mare hides its recording pointer before saved screenshots by default, preventing a completed action clip from contaminating later clean or target stills. Set `hide_recording_pointer: false` only when intentionally documenting the pointer itself.

```text
browser_save_screenshot({ filename: "candidate-grid", full_page: true, format: "png" })
// -> { ok: true, path: "/tmp/mare-browser-mcp/candidate-grid.png", ... }
```

Set `CAPTURE_DIR` to override the default temp artifact directory.

### `browser_video(action, filename?, format?, ...)`
Record a precise Playwright screencast. `action` is `start`, `stop`, `status`, or `capture_click`; `format` is `webm` (default) or `mp4`. Screencast start and stop operate on the live page without recreating the browser context, so in-memory application state is preserved. While recording, click actions show a translucent yellow pointer and pulse. Mare now hides that pointer automatically after every stop.

The default `capture_scale: "device"` records at device-pixel dimensions so video and ordinary viewport PNGs share the same native canvas on high-DPI displays. Use `capture_scale: "css"` for a smaller CSS-pixel recording. Start/status/stop responses report the Mare version, CSS viewport, device-pixel ratio, capture scale, and output size.

```text
browser_video({ action: "start", filename: "candidate-walkthrough", format: "mp4" })
// perform browser actions
browser_video({ action: "stop" })
// -> { ok: true, path: "/tmp/mare-browser-mcp/candidate-walkthrough.mp4", mode: "screencast", ... }
```

For short product-storyboard actions, prefer the atomic form. It performs the start, one click, optional URL wait, short click-pulse tail, and stop inside one MCP call, avoiding static padding caused by model/tool round trips:

```text
browser_video({
  action: "capture_click",
  filename: "open-candidate",
  format: "mp4",
  selector: "[data-testid='candidate-link']",
  wait_for_url: "/cnd/",
  timeout: 2500,
  post_click_ms: 450
})
```

`capture_click` returns the source and destination URLs, action success, URL-match result, finalized artifact metadata, and pointer-cleanup result. MP4 output is automatically transcoded to high-quality H.264 and requires `ffmpeg` on `PATH`.

On Playwright versions older than 1.59, Mare retains the previous context-level WebM recorder as a compatibility fallback. Stop an active recording before calling `browser_restart`.

### `browser_upload(selector, files[])`
Upload files to a file input element.

### `browser_restart(url?)`
Kill the browser and start fresh. Clears all logs. Optionally navigate to a URL after restart.

### `browser_emulate_device(device, orientation?, custom?)`
Switch the browser into a device profile for responsive QA. Emulation persists across navigations until you swap devices or call `browser_restart`.

**Presets (natural portrait viewport):**
- `iphone-15-pro-max` (430×932), `iphone-15-pro` (393×852), `iphone-15` (393×852), `iphone-se` (375×667)
- `galaxy-s24` (360×800)
- `ipad-pro-13` (1024×1366), `ipad-pro-11` (834×1194), `ipad-mini` (768×1024)
- `galaxy-tab-s9` (800×1280)
- `desktop-chrome` (1280×800) — resets to desktop
- `custom` — requires `custom.userAgent` + `custom.viewport.{width, height}`

Swapping devices recreates the browser context, so cookies and localStorage are lost and auth'd pages may land on login. `innerWidth: 980` on a mobile emulation viewing a page without `<meta name="viewport">` is Chrome's legacy fallback, not a bug — `pointer_coarse`, `hasTouch`, and `userAgent` are the authoritative signals. `browser_debug` surfaces the active emulation under an `emulation` field.

---

## Example workflow

```
1. browser_navigate("https://myapp.com", clear_logs: true)
2. browser_act([
     { action: "fill", selector: "#email", value: "user@example.com" },
     { action: "fill", selector: "#password", value: "secret" },
     { action: "click", selector: "button[type=submit]" }
   ])
3. browser_wait_for_network({ url_pattern: "/api/session", method: "POST" })
4. browser_debug({ console_types: ["error"] })   <- check for login errors
5. browser_query(".dashboard-title")              <- confirm we're logged in
```

### Hover + tooltip example
```
1. browser_act([{ action: "hover", selector: ".info-icon" }])
2. browser_query(".tooltip", { fields: ["text", "visible"] })
```

### Drag-and-drop example
```
// Reorder columns
browser_act([{ action: "drag", selector: ".col-name", target: ".col-age" }])

// Resize a column by 100px
browser_act([{ action: "drag", selector: ".resize-handle", offsetX: 100, offsetY: 0 }])
```

### Right-click context menu
```
1. browser_act([{ action: "click", selector: ".grid-row", button: "right" }])
2. browser_query(".context-menu-item", { all: true, fields: ["text"] })
```

### Scroll inside a container
```
browser_scroll({ container: ".ag-body-viewport", direction: "down", pixels: 500 })
```

### Count elements quickly
```
browser_query({ selector: ".ag-row", count_only: true })
// -> { selector: ".ag-row", count: 47 }
```

### Emulate a mobile device
```
1. browser_emulate_device({ device: "iphone-15-pro-max" })
2. browser_navigate({ url: "https://www.youtube.com" })
   // redirects to m.youtube.com because of the iPhone UA
3. browser_screenshot()                     // mobile layout
4. browser_emulate_device({ device: "ipad-pro-13", orientation: "landscape" })
5. browser_emulate_device({ device: "desktop-chrome" })  // reset
```

---

## Environment

| Variable | Default | Description |
|---|---|---|
| `HEADLESS` | `false` | Run browser headless (`true`) or visible (`false`) |
| `REAL_CHROME` | `false` | Use your installed Chrome instead of Playwright's Chromium |
| `CHROME_PROFILE` | `Default` | Chrome profile name (when `REAL_CHROME=true`) |
| `CAPTURE_DIR` | OS temp + `mare-browser-mcp` | Screenshot and video artifact directory |

The browser launches lazily — it won't open until the first tool call.

---

## License

MIT — free to use, modify, and distribute.

If this project helps you, [buy me a coffee](https://buymeacoffee.com/emadomar) ☕
