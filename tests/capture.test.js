import { after, test } from "node:test";
import assert from "node:assert/strict";
import { access, rm, stat } from "node:fs/promises";

process.env.HEADLESS = "true";
process.env.PERSIST_STATE = "false";

const { state } = await import("../src/state.js");
const { teardown } = await import("../src/browser.js");
const { browserAct, browserNavigate, browserSaveScreenshot, browserVideo } = await import("../src/tools.js");

const created = [];

after(async () => {
  state.videoRecording = null;
  state.recordVideoDir = null;
  state.recordVideoSize = null;
  await teardown();
  await Promise.all(created.map(path => rm(path, { force: true })));
});

test("browser_save_screenshot writes an artifact and returns its path", async () => {
  await browserNavigate({ url: "data:text/html,<h1>Capture test</h1>" });
  const result = await browserSaveScreenshot({ filename: "mare-capture-test", format: "png" });
  created.push(result.path);

  assert.equal(result.ok, true);
  assert.match(result.path, /mare-capture-test\.png$/);
  assert.equal(result.mime_type, "image/png");
  assert.ok(result.bytes > 0);
  assert.ok(result.size.width > 0);
  assert.ok(result.size.height > 0);
  assert.ok(result.viewport.width > 0);
  assert.ok(result.viewport.height > 0);
  assert.ok(result.device_pixel_ratio > 0);
  assert.equal(result.recording_pointer_hidden, true);
  await access(result.path);
});

test("browser_save_screenshot hides a stale recording pointer by default", async () => {
  await browserNavigate({ url: "data:text/html,<h1>Clean screenshot</h1>" });
  await state.page.evaluate(() => {
    const pointer = document.createElement("div");
    pointer.id = "mare-recording-pointer";
    pointer.style.opacity = "1";
    pointer.className = "mare-pointer-down mare-pointer-pulse";
    document.documentElement.append(pointer);
  });

  const result = await browserSaveScreenshot({ filename: "mare-clean-pointer-test", format: "png" });
  created.push(result.path);

  assert.equal(result.recording_pointer_hidden, true);
  assert.equal(await state.page.locator("#mare-recording-pointer").evaluate(el => getComputedStyle(el).opacity), "0");
  assert.equal(await state.page.locator("#mare-recording-pointer").evaluate(el => el.className), "");
});

test("browser_video records WebM, returns its path, and restores the page", async () => {
  const url = "data:text/html,<button id='demo'>Record me</button>";
  await browserNavigate({ url });
  await state.page.evaluate(() => { window.__mareCaptureSentinel = "preserved"; });

  const started = await browserVideo({ action: "start", filename: "mare-video-test" });
  assert.equal(started.recording, true);
  assert.equal(started.mode, "screencast");
  assert.equal(started.page_restored, true);
  assert.ok(started.size.width > 0);
  assert.ok(started.size.height > 0);
  assert.equal(await state.page.evaluate(() => window.__mareCaptureSentinel), "preserved");

  const action = await browserAct({ commands: [{ action: "click", selector: "#demo" }] });
  assert.equal(action.results[0].success, true);
  assert.equal(await state.page.locator("#mare-recording-pointer").isVisible(), true);
  await state.page.waitForTimeout(150);

  const stopped = await browserVideo({ action: "stop" });
  created.push(stopped.path);
  const file = await stat(stopped.path);

  assert.equal(stopped.ok, true);
  assert.equal(stopped.recording, false);
  assert.equal(stopped.mode, "screencast");
  assert.equal(stopped.mime_type, "video/webm");
  assert.equal(stopped.page_restored, true);
  assert.equal(stopped.version, "1.7.1");
  assert.equal(stopped.recording_pointer_hidden, true);
  assert.equal(await state.page.evaluate(() => window.__mareCaptureSentinel), "preserved");
  assert.equal(await state.page.locator("#mare-recording-pointer").evaluate(el => getComputedStyle(el).opacity), "0");
  assert.deepEqual(stopped.size, started.size);
  assert.ok(file.size > 0);
  assert.match(stopped.path, /mare-video-test\.webm$/);
});

test("browser_video exports a Mac-compatible MP4 on request", async () => {
  await browserNavigate({ url: "data:text/html,<button id='demo'>MP4 export</button>" });

  const started = await browserVideo({
    action: "start",
    filename: "mare-video-mp4-test",
    format: "mp4",
  });
  assert.equal(started.mode, "screencast");
  assert.equal(started.format, "mp4");

  await browserAct({ commands: [{ action: "click", selector: "#demo" }] });
  await state.page.waitForTimeout(150);

  const stopped = await browserVideo({ action: "stop" });
  created.push(stopped.path);

  assert.equal(stopped.ok, true);
  assert.equal(stopped.mime_type, "video/mp4");
  assert.equal(stopped.format, "mp4");
  assert.match(stopped.path, /mare-video-mp4-test\.mp4$/);
  assert.ok((await stat(stopped.path)).size > 0);
});

test("browser_video capture_click records one bounded click and cleans up the pointer", async () => {
  await browserNavigate({
    url: "data:text/html,<button id='demo' onclick=\"location.hash='done'\">Atomic capture</button>",
  });

  const captured = await browserVideo({
    action: "capture_click",
    filename: "mare-atomic-click-test",
    selector: "#demo",
    wait_for_url: "#done",
    timeout: 2000,
    post_click_ms: 100,
  });
  created.push(captured.path);

  assert.equal(captured.ok, true);
  assert.equal(captured.action, "capture_click");
  assert.equal(captured.action_succeeded, true);
  assert.equal(captured.url_matched, true);
  assert.match(captured.destination_url, /#done$/);
  assert.equal(captured.recording, false);
  assert.equal(captured.recording_pointer_hidden, true);
  assert.ok(captured.duration_ms < 4000);
  assert.ok((await stat(captured.path)).size > 0);
  assert.equal(await state.page.locator("#mare-recording-pointer").evaluate(el => getComputedStyle(el).opacity), "0");
});
