# mare-browser-mcp

A lean, LLM-first browser automation MCP server. Gives Claude (or any MCP client) a real Chromium browser to navigate, interact with, and debug web apps — without the overhead of raw Playwright APIs.

Built with [Playwright](https://playwright.dev) + [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk). One server = one browser session = one LLM.

**Free to use.** If it saves you time, [buy me a coffee](https://buymeacoffee.com/emadomar) ☕

---

## Install

**Prerequisites:** Node.js 18+, pnpm

```bash
git clone https://github.com/emadklenka/mare-browser-mcp
cd mare-browser-mcp
pnpm install
npx playwright install chromium
```

---

## Register with Claude Code

```bash
pnpm run setup
```

That's it. The script detects the correct path automatically and registers the MCP with Claude Code. Restart Claude Code and the browser tools are ready.

**Manual config** — if you prefer to do it yourself, add this to your `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "mare-browser": {
      "command": "node",
      "args": ["/absolute/path/to/mare-browser-mcp/src/index.js"],
      "env": { "HEADLESS": "false" }
    }
  }
}
```

---

## Tools

### `browser_navigate(url, clear_logs?)`
Navigate to a URL. Pass `clear_logs: true` when starting a new task to wipe stale console/network history.

### `browser_act(commands[])`
Run a sequence of actions in one call. Supported actions:

| action | required params | what it does |
|---|---|---|
| `click` | `selector` | Click an element |
| `clicklink` | `text` | Click a link by its visible text |
| `fill` | `selector`, `value` | Type into an input |
| `select` | `selector`, `value` | Select a dropdown option |
| `keypress` | `key` | Press a key (e.g. `Enter`, `Tab`) |
| `waitfor` | `selector`, `timeout?` | Wait until element appears |
| `scrollto` | `selector` | Scroll element into view |
| `wait` | `ms` | Pause for N milliseconds |
| `clearconsole` | — | Clear console log buffer |

### `browser_debug()`
**Start here when something goes wrong.** Returns current URL, page title, console logs, and network requests (with JSON response bodies) in one call. Filter by `url_filter`, `method_filter`, `console_types`, or `last_n`.

### `browser_query(selector, all?, fields?)`
Read the DOM without a screenshot. Query any element by CSS selector. Extract `text`, `value`, `visible`, `disabled`, `className`, `href`, or `innerHTML`.

### `browser_eval(code)`
Execute JavaScript in the page and return the result. Useful for reading JS state, calling APIs via `fetch`, or manipulating the DOM directly.

### `browser_scroll(direction?, pixels?, selector?)`
Scroll the page up/down by pixels, or scroll a specific element into view.

### `browser_wait_for_network(url_pattern?, method?, timeout?)`
Wait for a specific network response after triggering an action — smarter than guessing with `wait`.

### `browser_screenshot()`
Returns a PNG screenshot. **Use as a last resort** — prefer `browser_debug` and `browser_query` first.

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
4. browser_debug({ console_types: ["error"] })   ← check for login errors
5. browser_query(".dashboard-title")              ← confirm we're logged in
```

---

## Environment

| Variable | Default | Description |
|---|---|---|
| `HEADLESS` | `false` | Run browser headless (`true`) or visible (`false`) |

The browser launches lazily — it won't open until the first tool call.

---

## License

MIT — free to use, modify, and distribute.

If this project helps you, [buy me a coffee](https://buymeacoffee.com/emadomar) ☕
