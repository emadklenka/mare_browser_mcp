// Shared mutable state for the MCP server. Everything that used to be a
// module-level `let` in index.js lives here as a field on the `state` object
// so every consumer sees the same up-to-date value via object-property access.
//
// DO NOT destructure `state` in consumers — read fields as `state.page`,
// `state.context`, etc. Destructuring would freeze the reference at import
// time and miss later mutations.

export const state = {
  browser: null,
  context: null,
  page: null,
  consoleLog: [],
  networkLog: [],
  dialogLog: [],
  pendingRequests: new Map(), // Playwright request → entry
  currentEmulation: null,     // resolved Playwright options, null = desktop
};

// Environment config that multiple modules need. These are read once at
// module load; re-imports are fine.
export const HEADLESS = process.env.HEADLESS === "true";
export const REAL_CHROME = process.env.REAL_CHROME === "true";
export const MAX_BODY_SIZE = 4096;
export const CHROME_PROFILE = process.env.CHROME_PROFILE || "Default";

// Default desktop UA used both by ensureBrowser (no emulation path) and by
// the desktop-chrome preset in emulation.js.
export const UA_DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
