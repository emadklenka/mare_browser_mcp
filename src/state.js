// Shared mutable state for the MCP server. Everything that used to be a
// module-level `let` in index.js lives here as a field on the `state` object
// so every consumer sees the same up-to-date value via object-property access.
//
// DO NOT destructure `state` in consumers — read fields as `state.page`,
// `state.context`, etc. Destructuring would freeze the reference at import
// time and miss later mutations.

import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const state = {
  browser: null,
  context: null,
  page: null,
  consoleLog: [],
  networkLog: [],
  dialogLog: [],
  pendingRequests: new Map(),
  currentEmulation: null,
  refMap: new Map(),
  refCounter: 0,
};

export const HEADLESS = process.env.HEADLESS === "true";
export const REAL_CHROME = process.env.REAL_CHROME === "true";
export const MAX_BODY_SIZE = 4096;
export const CHROME_PROFILE = process.env.CHROME_PROFILE || "Default";
export const PERSIST_STATE = process.env.PERSIST_STATE !== "false";
export const STATE_PATH = process.env.STATE_PATH || `${process.env.HOME}/.mare-browser-mcp/state.json`;

export async function saveState(context) {
  if (!PERSIST_STATE || !context) return;
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    await context.storageState({ path: STATE_PATH });
  } catch {}
}

export async function loadStateOptions() {
  if (!PERSIST_STATE || !existsSync(STATE_PATH)) return {};
  try {
    return { storageState: STATE_PATH };
  } catch {
    try {
      unlinkSync(STATE_PATH);
      process.stderr.write(`[mare-browser-mcp] Corrupted state file deleted: ${STATE_PATH}\n`);
    } catch {}
    return {};
  }
}

// Default desktop UA used both by ensureBrowser (no emulation path) and by
// the desktop-chrome preset in emulation.js.
export const UA_DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
