import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeviceOptions } from "../src/emulation.js";

test("desktop-chrome preset returns desktop options with DPR 1 and no touch", () => {
  const opts = resolveDeviceOptions("desktop-chrome");
  assert.equal(opts.isMobile, false);
  assert.equal(opts.hasTouch, false);
  assert.equal(opts.deviceScaleFactor, 1);
  assert.equal(opts.viewport.width, 1280);
  assert.equal(opts.viewport.height, 800);
  assert.match(opts.userAgent, /Macintosh/);
});

test("ipad-pro-13 preset returns tablet portrait viewport 1024x1366", () => {
  const opts = resolveDeviceOptions("ipad-pro-13");
  assert.equal(opts.viewport.width, 1024);
  assert.equal(opts.viewport.height, 1366);
  assert.equal(opts.screen.width, 1024);
  assert.equal(opts.screen.height, 1366);
  assert.equal(opts.isMobile, true);
  assert.equal(opts.hasTouch, true);
  assert.match(opts.userAgent, /iPad/);
});

test("ipad-pro-13 landscape swaps width and height on both viewport and screen", () => {
  const opts = resolveDeviceOptions("ipad-pro-13", "landscape");
  assert.equal(opts.viewport.width, 1366);
  assert.equal(opts.viewport.height, 1024);
  assert.equal(opts.screen.width, 1366);
  assert.equal(opts.screen.height, 1024);
});

test("ipad-pro-13 portrait on already-portrait preset is a no-op", () => {
  const opts = resolveDeviceOptions("ipad-pro-13", "portrait");
  assert.equal(opts.viewport.width, 1024);
  assert.equal(opts.viewport.height, 1366);
});

test("iphone-15-pro-max preset exists and is mobile", () => {
  const opts = resolveDeviceOptions("iphone-15-pro-max");
  assert.equal(opts.isMobile, true);
  assert.equal(opts.hasTouch, true);
  assert.match(opts.userAgent, /iPhone/);
});

test("galaxy-tab-s9 preset uses tablet UA without 'Mobile' token", () => {
  const opts = resolveDeviceOptions("galaxy-tab-s9");
  assert.match(opts.userAgent, /Android 14/);
  assert.doesNotMatch(opts.userAgent, / Mobile /);
});

test("galaxy-s24 preset uses phone UA with 'Mobile' token", () => {
  const opts = resolveDeviceOptions("galaxy-s24");
  assert.match(opts.userAgent, /Android 14/);
  assert.match(opts.userAgent, / Mobile /);
});

test("custom device uses provided options verbatim with screen defaulted to viewport", () => {
  const opts = resolveDeviceOptions("custom", undefined, {
    userAgent: "FakeUA/1.0",
    viewport: { width: 500, height: 900 },
  });
  assert.equal(opts.userAgent, "FakeUA/1.0");
  assert.equal(opts.viewport.width, 500);
  assert.equal(opts.viewport.height, 900);
  assert.equal(opts.screen.width, 500);
  assert.equal(opts.screen.height, 900);
  assert.equal(opts.isMobile, true);  // default when custom is provided
  assert.equal(opts.hasTouch, true);  // default when custom is provided
  assert.equal(opts.deviceScaleFactor, 2);  // default
});

test("custom device honors explicit isMobile/hasTouch/deviceScaleFactor overrides", () => {
  const opts = resolveDeviceOptions("custom", undefined, {
    userAgent: "FakeUA/1.0",
    viewport: { width: 500, height: 900 },
    isMobile: false,
    hasTouch: false,
    deviceScaleFactor: 1.5,
  });
  assert.equal(opts.isMobile, false);
  assert.equal(opts.hasTouch, false);
  assert.equal(opts.deviceScaleFactor, 1.5);
});

test("custom device with landscape orientation flips viewport", () => {
  const opts = resolveDeviceOptions("custom", "landscape", {
    userAgent: "FakeUA/1.0",
    viewport: { width: 500, height: 900 },
  });
  assert.equal(opts.viewport.width, 900);
  assert.equal(opts.viewport.height, 500);
});

test("device='custom' without custom object throws with helpful error", () => {
  assert.throws(
    () => resolveDeviceOptions("custom"),
    /custom device selected but 'custom' object not provided/
  );
});

test("device='custom' with custom missing viewport throws", () => {
  assert.throws(
    () => resolveDeviceOptions("custom", undefined, { userAgent: "x" }),
    /custom\.viewport is required/
  );
});

test("device='custom' with custom missing userAgent throws", () => {
  assert.throws(
    () => resolveDeviceOptions("custom", undefined, { viewport: { width: 500, height: 900 } }),
    /custom\.userAgent is required/
  );
});

test("unknown device key throws listing valid values", () => {
  assert.throws(
    () => resolveDeviceOptions("nexus-9000"),
    /Unknown device 'nexus-9000'/
  );
});
