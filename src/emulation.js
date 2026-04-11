// Device emulation: presets, pure resolver, verification helpers, and the
// browser_emulate_device handler. The resolver is exported for unit tests.

import { devices } from "playwright";
import { state, REAL_CHROME, UA_DESKTOP_CHROME } from "./state.js";
import { ensureBrowser, teardown } from "./browser.js";

// ─── Hardcoded UA strings ─────────────────────────────────────────────────────
// Captured 2026-04-11 for devices not in Playwright's built-in registry.
// Chrome version deliberately tracks real-device stable, not headless build
// (Playwright's chromium.version is a dead giveaway to UA sniffers).
const UA_GALAXY_S24 =
  "Mozilla/5.0 (Linux; Android 14; SM-S921U) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// Tablet Chrome drops "Mobile" from the UA — this is correct and affects
// UA sniffers that distinguish phone vs tablet.
const UA_GALAXY_TAB_S9 =
  "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const UA_IPAD_PRO_13 =
  "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

// ─── Preset table ─────────────────────────────────────────────────────────────
// Values are full newContext() options objects. Playwright's `devices` registry
// entries already include viewport/userAgent/deviceScaleFactor/isMobile/hasTouch.
// Custom entries (devices not in registry) must supply all of those explicitly
// plus a `screen` field so window.screen.* reflects the emulated dimensions.
const PRESETS = {
  "iphone-15-pro-max": devices["iPhone 15 Pro Max"],
  "iphone-15-pro":     devices["iPhone 15 Pro"],
  "iphone-15":         devices["iPhone 15"],
  "iphone-se":         devices["iPhone SE"],
  "ipad-pro-11":       devices["iPad Pro 11"],
  "ipad-mini":         devices["iPad Mini"],

  "ipad-pro-13": {
    userAgent: UA_IPAD_PRO_13,
    viewport: { width: 1024, height: 1366 },
    screen:   { width: 1024, height: 1366 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },

  "galaxy-s24": {
    userAgent: UA_GALAXY_S24,
    viewport: { width: 360, height: 800 },
    screen:   { width: 360, height: 800 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },

  "galaxy-tab-s9": {
    userAgent: UA_GALAXY_TAB_S9,
    viewport: { width: 800, height: 1280 },
    screen:   { width: 800, height: 1280 },
    deviceScaleFactor: 2.5,
    isMobile: true,
    hasTouch: true,
  },

  "desktop-chrome": {
    userAgent: UA_DESKTOP_CHROME,
    viewport: { width: 1280, height: 800 },
    screen:   { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

// Substring each device's resolved UA must contain, keyed by the user-facing
// preset key. Used by checkIdentity() to assert the context actually took.
const UA_SUBSTRINGS = {
  "iphone-15-pro-max": "iPhone",
  "iphone-15-pro":     "iPhone",
  "iphone-15":         "iPhone",
  "iphone-se":         "iPhone",
  "ipad-pro-11":       "iPad",
  "ipad-mini":         "iPad",
  "ipad-pro-13":       "iPad",
  "galaxy-s24":        "Android",
  "galaxy-tab-s9":     "Android",
  "desktop-chrome":    "Macintosh",
};

// ─── Pure option resolver ─────────────────────────────────────────────────────
// No Playwright calls. Takes user input, returns the options object to pass
// into browser.newContext(). Exported so it can be unit-tested without
// launching a browser.
export function resolveDeviceOptions(device, orientation, custom) {
  let base;

  if (device === "custom") {
    if (!custom) {
      throw new Error("custom device selected but 'custom' object not provided");
    }
    if (!custom.userAgent) {
      throw new Error("custom.userAgent is required");
    }
    if (!custom.viewport || typeof custom.viewport.width !== "number" || typeof custom.viewport.height !== "number") {
      throw new Error("custom.viewport is required (width + height)");
    }
    base = {
      userAgent: custom.userAgent,
      viewport: { width: custom.viewport.width, height: custom.viewport.height },
      screen:   { width: custom.viewport.width, height: custom.viewport.height },
      deviceScaleFactor: custom.deviceScaleFactor ?? 2,
      isMobile: custom.isMobile ?? true,
      hasTouch: custom.hasTouch ?? true,
    };
  } else {
    const preset = PRESETS[device];
    if (!preset) {
      const valid = Object.keys(PRESETS).concat("custom").join(", ");
      throw new Error(`Unknown device '${device}'. Valid: ${valid}`);
    }
    // Clone so orientation flipping can't mutate the shared PRESETS entry.
    // Playwright's devices[] entries don't include `screen`, so default it
    // to match viewport when missing.
    base = {
      userAgent: preset.userAgent,
      viewport: { width: preset.viewport.width, height: preset.viewport.height },
      screen: preset.screen
        ? { width: preset.screen.width, height: preset.screen.height }
        : { width: preset.viewport.width, height: preset.viewport.height },
      deviceScaleFactor: preset.deviceScaleFactor,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch,
    };
  }

  // Orientation flip: swap viewport + screen width/height if requested
  // orientation doesn't match the natural orientation of the base dimensions.
  // Square viewports (width === height) have no natural orientation and are
  // intentionally a no-op — both conditions use strict > comparisons.
  if (orientation === "landscape" && base.viewport.height > base.viewport.width) {
    base.viewport = { width: base.viewport.height, height: base.viewport.width };
    base.screen   = { width: base.screen.height,   height: base.screen.width };
  } else if (orientation === "portrait" && base.viewport.width > base.viewport.height) {
    base.viewport = { width: base.viewport.height, height: base.viewport.width };
    base.screen   = { width: base.screen.height,   height: base.screen.width };
  }

  return base;
}

// ─── Verification ─────────────────────────────────────────────────────────────
// Reads live identity + layout signals from the page. Does NOT decide ok/fail.
// That is checkIdentity's job, deliberately separated so layout_mode cannot
// leak into the success gate.
async function computeVerification(page, resolved) {
  const raw = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    hasTouch: "ontouchstart" in window,
    maxTouchPoints: navigator.maxTouchPoints,
    pointer_coarse: matchMedia("(pointer: coarse)").matches,
    hover_none: matchMedia("(hover: none)").matches,
    orientation_portrait: matchMedia("(orientation: portrait)").matches,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    has_viewport_meta: !!document.querySelector("meta[name=viewport]"),
  }));

  // Classify layout_mode (informational only — see checkIdentity).
  let layout_mode;
  if (raw.innerWidth === resolved.viewport.width) {
    layout_mode = "responsive";
  } else if (
    raw.innerWidth === 980 &&
    raw.has_viewport_meta === false &&
    resolved.isMobile === true
  ) {
    layout_mode = "legacy-980-fallback";
  } else {
    layout_mode = "unexpected";
  }

  return {
    ...raw,
    layout_mode,
    current_url: page.url(),
  };
}

// Per-field verification breakdown. Essentials (UA substring + DPR) decide
// ok/fail. Soft fields (hasTouch, pointer_coarse) surface as warnings only —
// Playwright sometimes reports these late on the first swap due to Chromium
// init ordering, but the core emulation is still applied. MUST NOT read
// layout_mode or innerWidth.
function checkIdentity(verified, resolved, device) {
  const expectedSubstring = UA_SUBSTRINGS[device] || null;
  const checks = {
    userAgent: {
      expected: expectedSubstring,
      got: verified.userAgent,
      match: !expectedSubstring || verified.userAgent.includes(expectedSubstring),
    },
    devicePixelRatio: {
      expected: resolved.deviceScaleFactor,
      got: verified.devicePixelRatio,
      match: verified.devicePixelRatio === resolved.deviceScaleFactor,
    },
    hasTouch: {
      expected: resolved.hasTouch,
      got: verified.hasTouch,
      match: verified.hasTouch === resolved.hasTouch,
    },
    pointer_coarse: {
      expected: resolved.isMobile,
      got: verified.pointer_coarse,
      match: verified.pointer_coarse === resolved.isMobile,
    },
  };

  const warnings = [];
  if (!checks.hasTouch.match) {
    warnings.push(`hasTouch mismatch: expected ${checks.hasTouch.expected}, got ${checks.hasTouch.got}`);
  }
  if (!checks.pointer_coarse.match) {
    warnings.push(`pointer_coarse mismatch: expected ${checks.pointer_coarse.expected}, got ${checks.pointer_coarse.got}`);
  }

  if (!checks.userAgent.match) {
    return {
      ok: false,
      reason: `userAgent missing expected substring '${expectedSubstring}' (got: ${verified.userAgent})`,
      checks,
      warnings,
    };
  }
  if (!checks.devicePixelRatio.match) {
    return {
      ok: false,
      reason: `devicePixelRatio mismatch: expected ${resolved.deviceScaleFactor}, got ${verified.devicePixelRatio}`,
      checks,
      warnings,
    };
  }

  return { ok: true, checks, warnings };
}

// ─── Handler ──────────────────────────────────────────────────────────────────
export async function browserEmulateDevice({ device, orientation, custom }) {
  if (REAL_CHROME) {
    return {
      ok: false,
      error:
        "browser_emulate_device is not supported in REAL_CHROME mode. " +
        "Unset REAL_CHROME or restart the MCP with REAL_CHROME=false.",
    };
  }

  let resolved;
  try {
    resolved = resolveDeviceOptions(device, orientation, custom);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // Need a live page so we can capture its URL before tearing down.
  await ensureBrowser();
  const previousUrl = state.page.url();

  // Set currentEmulation BEFORE teardown so the next ensureBrowser() picks it up.
  // Stash device + derived orientation on the options object so browser_debug
  // can report them later. Underscored keys won't collide with Playwright's
  // newContext() option names. Orientation is derived from actual dimensions
  // rather than the caller's argument to stay accurate when no arg is passed.
  resolved._device = device;
  resolved._orientation = resolved.viewport.width >= resolved.viewport.height ? "landscape" : "portrait";
  state.currentEmulation = resolved;
  await teardown();
  await ensureBrowser();

  let previous_url_restored = true;
  let previous_url_error;
  if (previousUrl && previousUrl !== "about:blank") {
    try {
      await state.page.goto(previousUrl);
    } catch (e) {
      previous_url_restored = false;
      previous_url_error = e.message;
    }
  }

  // First-call race: Chromium's touch/pointer-media reporting can lag the
  // initial context creation by 50-150ms on the very first swap of a session.
  // Retry once with a short wait if the first read produces soft-field drift.
  let verified = await computeVerification(state.page, resolved);
  let identityCheck = checkIdentity(verified, resolved, device);
  if (identityCheck.ok && identityCheck.warnings.length > 0) {
    await state.page.waitForTimeout(200);
    verified = await computeVerification(state.page, resolved);
    identityCheck = checkIdentity(verified, resolved, device);
  }
  if (!identityCheck.ok) {
    return { ok: false, error: identityCheck.reason, verified, checks: identityCheck.checks };
  }

  const { _device, _orientation, ...cleanResolved } = resolved;
  return {
    ok: true,
    active: {
      device,
      orientation: _orientation,
      ...cleanResolved,
    },
    previous_url: previousUrl,
    previous_url_restored,
    ...(previous_url_error ? { previous_url_error } : {}),
    verified,
    checks: identityCheck.checks,
    ...(identityCheck.warnings.length > 0 ? { warnings: identityCheck.warnings } : {}),
  };
}
