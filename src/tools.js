// Non-emulation MCP tool handlers. Each function does `await ensureBrowser()`
// first, then drives the Playwright page. All mutable state goes through
// `state` from state.js so concurrent access (there isn't any — MCP is
// single-threaded) sees consistent values.

import { state, MAX_BODY_SIZE, MARE_BROWSER_VERSION } from "./state.js";
import { ensureBrowser, rebuildBrowser, teardown } from "./browser.js";
import { hideRecordingPointer, installRecordingPointer } from "./recording-pointer.js";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

const CAPTURE_DIR = process.env.CAPTURE_DIR || join(tmpdir(), "mare-browser-mcp");
const execFileAsync = promisify(execFile);

function evenDimension(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export function networkEntryForDebug(entry, { includeBodies = false } = {}) {
  const safe = { ...entry };
  if (!includeBodies) {
    delete safe.requestBody;
    delete safe.responseBody;
  }
  return safe;
}

function captureName(name, fallback, extension) {
  const input = basename(name || fallback, extname(name || fallback));
  const safe = input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || fallback;
  return `${safe}.${extension}`;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function convertVideoToMp4(inputPath, outputPath) {
  try {
    await execFileAsync("ffmpeg", [
      "-y", "-loglevel", "error", "-i", inputPath,
      "-c:v", "libx264", "-preset", "medium", "-crf", "16",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
      "-an", outputPath,
    ]);
  } catch (error) {
    const reason = error.code === "ENOENT"
      ? "ffmpeg is not installed or is not available on PATH"
      : error.stderr?.trim() || error.message;
    throw new Error(`MP4 export failed: ${reason}. The WebM source remains at ${inputPath}`);
  }
}

async function moveRecordingPointer(page, locator) {
  if (!state.videoRecording) return;
  await installRecordingPointer(page);
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
  await page.waitForTimeout(220);
}

export async function browserSnapshot({ max_depth, compact }) {
  await ensureBrowser();
  state.refMap.clear();
  state.refCounter = 0;

  const page = state.page;
  const snapshot = await page.evaluate(({ maxDepth, compact }) => {
    function getRole(el) {
      if (el.role && el.role !== "presentation" && el.role !== "none") return el.role;
      const tag = el.tagName;
      if (tag === "A") return "link";
      if (tag === "BUTTON" || tag === "SUMMARY") return "button";
      if (tag === "INPUT") {
        const t = el.type?.toLowerCase();
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "submit" || t === "reset") return "button";
        if (t === "search") return "searchbox";
        if (t === "hidden" || t === "file") return null;
        return "textbox";
      }
      if (tag === "SELECT") return "combobox";
      if (tag === "TEXTAREA") return "textbox";
      return null;
    }

    // innerText respects CSS visibility — <style>, <script>, and display:none
    // content is excluded. textContent would bleed inline styles and hidden
    // elements into the name string. Fall back to textContent if innerText
    // is unavailable (detached nodes).
    function cleanText(el) {
      const raw = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      return raw.length > 100 ? raw.slice(0, 100) + "…" : raw;
    }

    function getName(el) {
      if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
      const lb = el.getAttribute("aria-labelledby");
      if (lb) { const r = document.getElementById(lb); if (r) return cleanText(r); }
      if (el.tagName === "BUTTON" || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
        if (el.type === "submit") return el.value || "Submit";
        if (el.type === "reset") return el.value || "Reset";
        if (el.placeholder) return el.placeholder;
        const label = el.closest("label");
        if (label) return cleanText(label);
        if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return cleanText(l); }
        if (el.title) return el.title;
        return cleanText(el);
      }
      if (el.tagName === "A" || el.tagName === "SUMMARY") {
        const t = cleanText(el);
        if (t) return t;
        if (el.title) return el.title;
      }
      return cleanText(el);
    }

    function getSelector(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const path = [];
      let cur = el;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        let sel = cur.tagName.toLowerCase();
        if (cur.id) { sel = `#${CSS.escape(cur.id)}`; path.unshift(sel); break; }
        const p = cur.parentElement;
        if (p) {
          const sibs = Array.from(p.children).filter(c => c.tagName === cur.tagName);
          if (sibs.length > 1) sel += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
        }
        path.unshift(sel);
        cur = p;
      }
      return path.join(" > ");
    }

    const INTERACTIVE = new Set([
      "link", "button", "textbox", "searchbox", "combobox", "listbox",
      "checkbox", "radio", "switch", "slider", "spinbutton", "tab",
      "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
    ]);

    function getTestId(el) {
      return el.getAttribute("data-testid")
          || el.getAttribute("data-test")
          || el.getAttribute("data-qa")
          || null;
    }

    // Clear any data-mare-ref tags left over from a previous snapshot so refs
    // never collide across snapshots.
    for (const el of document.querySelectorAll("[data-mare-ref]")) {
      el.removeAttribute("data-mare-ref");
    }

    const counter = { value: 0 };
    const refs = [];

    // walk() returns either a single node or an array of nodes.
    // Returning an array signals "hoist me into the parent's children"
    // — used in compact mode to flatten out non-semantic wrapper divs.
    function walk(el, depth) {
      if (!el || depth > maxDepth || el === document.body) return null;
      const role = getRole(el);

      // Walk all children first so we have a flat list for hoisting.
      const childResults = [];
      if (el.children) {
        for (const c of el.children) {
          const r = walk(c, depth + 1);
          if (!r) continue;
          if (Array.isArray(r)) childResults.push(...r);
          else childResults.push(r);
        }
      }

      const testId = getTestId(el);

      if (!role) {
        // Non-semantic wrapper (div/span/section without a role).
        if (compact) {
          // Flatten: only keep this wrapper if it has a testId worth surfacing,
          // otherwise hoist children up to the parent.
          if (testId && childResults.length) {
            return { role: el.tagName.toLowerCase(), testId, children: childResults };
          }
          return childResults.length ? childResults : null;
        }
        // Non-compact: preserve the wrapper so structure is visible.
        if (childResults.length) {
          const node = { role: el.tagName.toLowerCase(), children: childResults };
          if (testId) node.testId = testId;
          return node;
        }
        return null;
      }

      const name = getName(el);
      const node = { role };
      if (name) node.name = name;
      if (testId) node.testId = testId;
      if (INTERACTIVE.has(role)) {
        counter.value++;
        const ref = `e${counter.value}`;
        node.ref = ref;
        // Pin the ref to THIS exact element via a unique attribute. Resolution
        // at action time targets the tagged node directly, so a ref can never
        // silently drift to a different element when the DOM reflows. The
        // generated CSS selector is kept only as human-readable context.
        el.setAttribute("data-mare-ref", ref);
        refs.push({ ref, selector: getSelector(el), role, name, testId });
      }
      if (childResults.length) node.children = childResults;
      return node;
    }

    const children = [];
    for (const c of document.body.children) {
      const r = walk(c, 0);
      if (!r) continue;
      if (Array.isArray(r)) children.push(...r);
      else children.push(r);
    }
    return { snapshot: children, refs };
  }, { maxDepth: max_depth || 10, compact: !!compact });

  for (const { ref, selector, role, name, testId } of snapshot.refs) {
    state.refMap.set(ref, { selector, role, name, testId });
  }
  state.refCounter = snapshot.refs.length;

  return {
    url: page.url(),
    snapshot: snapshot.snapshot,
  };
}

function resolveRef(ref) {
  if (!state.refMap.has(ref)) throw new Error(`Stale or unknown ref: ${ref}. Run browser_snapshot to get fresh refs.`);
  return state.refMap.get(ref);
}

function refToLocator(page, ref) {
  // resolveRef throws a friendly "stale ref" error if the ref isn't in the map.
  // Resolution targets the data-mare-ref tag set during the snapshot, pinning
  // the action to the exact element that was captured. If a re-render replaced
  // that element the tag is gone, so the locator matches nothing and the action
  // fails loudly instead of clicking whatever now occupies the position.
  resolveRef(ref);
  return page.locator(`[data-mare-ref="${ref}"]`).first();
}

export async function browserNavigate({ url, clear_logs }) {
  await ensureBrowser();
  if (clear_logs) {
    state.consoleLog = [];
    state.networkLog = [];
    state.dialogLog = [];
    state.pendingRequests.clear();
  }
  await state.page.goto(url);
  return { url, title: await state.page.title() };
}

export async function browserAct({ commands }) {
  await ensureBrowser();
  const results = [];
  const page = state.page;

  function getLocator(cmd) {
    if (cmd.ref) return refToLocator(page, cmd.ref);
    if (cmd.selector) return page.locator(cmd.selector).first();
    throw new Error(`Action '${cmd.action}' requires 'selector' or 'ref'`);
  }

  for (const cmd of commands) {
    try {
      switch (cmd.action) {
        case "click": {
          const loc = cmd.ref ? refToLocator(page, cmd.ref) : page.locator(cmd.selector).first();
          await moveRecordingPointer(page, loc);
          await loc.click({ button: cmd.button || "left", timeout: 5000 });
          results.push({ action: "click", ...(cmd.ref ? { ref: cmd.ref } : { selector: cmd.selector }), button: cmd.button || "left", success: true });
          break;
        }

        case "hover": {
          const loc = cmd.ref ? refToLocator(page, cmd.ref) : page.locator(cmd.selector).first();
          await loc.hover({ timeout: 5000 });
          results.push({ action: "hover", ...(cmd.ref ? { ref: cmd.ref } : { selector: cmd.selector }), success: true });
          break;
        }

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
          const target = loc.first();
          await moveRecordingPointer(page, target);
          await target.click({ timeout: 5000 });
          results.push({ action: "clicklink", text: cmd.text, success: true });
          break;
        }

        case "fill": {
          const loc = cmd.ref ? refToLocator(page, cmd.ref) : page.locator(cmd.selector).first();
          await loc.fill(cmd.value);
          results.push({ action: "fill", ...(cmd.ref ? { ref: cmd.ref } : { selector: cmd.selector }), success: true });
          break;
        }

        case "select": {
          const loc = cmd.ref ? refToLocator(page, cmd.ref) : page.locator(cmd.selector).first();
          await loc.selectOption(cmd.value, { timeout: 5000 });
          results.push({ action: "select", ...(cmd.ref ? { ref: cmd.ref } : { selector: cmd.selector }), value: cmd.value, success: true });
          break;
        }

        case "dispatch": {
          // Fire a DOM event on an element. For web-component apps (LWC/Stencil)
          // that only react to composed CustomEvents — e.g. a custom input that
          // ignores native value-setting and listens for `change` with a detail
          // payload. Defaults bubbles + composed true so the event crosses shadow
          // boundaries like a real user interaction.
          if (!cmd.event) throw new Error("dispatch requires 'event' (the event type name, e.g. 'change')");
          const loc = cmd.ref ? refToLocator(page, cmd.ref) : page.locator(cmd.selector).first();
          await loc.evaluate((el, { event, detail, bubbles, composed }) => {
            const init = { bubbles: bubbles !== false, composed: composed !== false };
            el.dispatchEvent(detail !== undefined ? new CustomEvent(event, { ...init, detail }) : new Event(event, init));
          }, { event: cmd.event, detail: cmd.detail, bubbles: cmd.bubbles, composed: cmd.composed });
          results.push({ action: "dispatch", ...(cmd.ref ? { ref: cmd.ref } : { selector: cmd.selector }), event: cmd.event, success: true });
          break;
        }

        case "keypress":
          await page.keyboard.press(cmd.key);
          results.push({ action: "keypress", key: cmd.key, success: true });
          break;

        case "waitfor": {
          const loc = cmd.ref ? refToLocator(page, cmd.ref) : page.locator(cmd.selector).first();
          await loc.waitFor({ timeout: cmd.timeout || 5000 });
          results.push({ action: "waitfor", ...(cmd.ref ? { ref: cmd.ref } : { selector: cmd.selector }), success: true });
          break;
        }

        case "scrollto": {
          const loc = cmd.ref ? refToLocator(page, cmd.ref) : page.locator(cmd.selector).first();
          await loc.scrollIntoViewIfNeeded();
          results.push({ action: "scrollto", ...(cmd.ref ? { ref: cmd.ref } : { selector: cmd.selector }), success: true });
          break;
        }

        case "wait":
          await page.waitForTimeout(cmd.ms || 1000);
          results.push({ action: "wait", ms: cmd.ms, success: true });
          break;

        case "drag": {
          const source = cmd.ref ? refToLocator(page, cmd.ref) : page.locator(cmd.selector).first();
          if (cmd.target) {
            await source.dragTo(page.locator(cmd.target).first(), { timeout: 5000 });
            results.push({ action: "drag", ...(cmd.ref ? { ref: cmd.ref } : { selector: cmd.selector }), target: cmd.target, success: true });
          } else if (cmd.offsetX !== undefined || cmd.offsetY !== undefined) {
            const box = await source.boundingBox();
            if (!box) throw new Error("Element not visible");
            const startX = box.x + box.width / 2;
            const startY = box.y + box.height / 2;
            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(startX + (cmd.offsetX || 0), startY + (cmd.offsetY || 0), { steps: 10 });
            await page.mouse.up();
            results.push({ action: "drag", ...(cmd.ref ? { ref: cmd.ref } : { selector: cmd.selector }), offsetX: cmd.offsetX, offsetY: cmd.offsetY, success: true });
          } else {
            throw new Error("drag requires either 'target' (CSS selector) or 'offsetX'/'offsetY' (pixels)");
          }
          break;
        }

        case "clearconsole":
          state.consoleLog = [];
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

export async function browserDebug({ url_filter, method_filter, console_types, last_n, include_bodies }) {
  await ensureBrowser();

  const url = state.page.url();
  const title = await state.page.title();

  let logs = state.consoleLog;
  if (console_types?.length) logs = logs.filter(l => console_types.includes(l.type));

  let network = state.networkLog;
  if (url_filter) network = network.filter(r => r.url.includes(url_filter));
  if (method_filter) network = network.filter(r => r.method === method_filter.toUpperCase());

  const n = last_n || 50;

  return {
    current_url: url,
    title,
    emulation: state.currentEmulation
      ? {
          device: state.currentEmulation._device || null,
          orientation: state.currentEmulation._orientation || "portrait",
        }
      : null,
    console: logs.slice(-n),
    network: network.slice(-n).map(entry => networkEntryForDebug(entry, { includeBodies: include_bodies === true })),
    dialogs: state.dialogLog.slice(-n),
  };
}

export async function browserQuery({ selector, all, fields, visible_only, limit, count_only }) {
  await ensureBrowser();

  if (count_only) {
    const count = await state.page.evaluate(({ sel, visible_only }) => {
      let elements = Array.from(document.querySelectorAll(sel));
      if (visible_only) elements = elements.filter(el => el.offsetParent !== null);
      return elements.length;
    }, { sel: selector, visible_only });
    return { selector, count };
  }

  const data = await state.page.evaluate(
    ({ sel, all, fields, visible_only, limit }) => {
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
      if (all) {
        let elements = Array.from(document.querySelectorAll(sel));
        if (visible_only) elements = elements.filter(el => el.offsetParent !== null);
        if (limit) elements = elements.slice(0, limit);
        return elements.map(extract);
      }
      return extract(document.querySelector(sel));
    },
    { sel: selector, all, fields, visible_only, limit }
  );

  return { selector, count: Array.isArray(data) ? data.length : undefined, result: data };
}

export async function browserScreenshot({ quality }) {
  await ensureBrowser();
  if (!state.videoRecording) await hideRecordingPointer(state.page);
  const mode = quality || "normal";

  if (mode === "thumbnail") {
    const buf = await state.page.screenshot({ type: "jpeg", quality: 60 });
    const resized = await sharp(buf).resize({ width: 400 }).jpeg({ quality: 60 }).toBuffer();
    return { type: "image", data: resized.toString("base64"), mimeType: "image/jpeg" };
  }

  if (mode === "fullres") {
    const buf = await state.page.screenshot({ fullPage: true });
    return { type: "image", data: buf.toString("base64"), mimeType: "image/png" };
  }

  const buf = await state.page.screenshot();
  return { type: "image", data: buf.toString("base64"), mimeType: "image/png" };
}

export async function browserSaveScreenshot({ filename, full_page, format, hide_recording_pointer }) {
  await ensureBrowser();
  await mkdir(CAPTURE_DIR, { recursive: true });

  const pointer = hide_recording_pointer === false
    ? await state.page.evaluate(() => {
        const present = !!document.getElementById("mare-recording-pointer");
        return { present, hidden: !present };
      })
    : await hideRecordingPointer(state.page);
  const viewport = await state.page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    device_pixel_ratio: window.devicePixelRatio || 1,
  }));

  const imageFormat = format === "jpeg" ? "jpeg" : "png";
  const extension = imageFormat === "jpeg" ? "jpg" : "png";
  const outputPath = join(
    CAPTURE_DIR,
    captureName(filename, `screenshot-${timestampSlug()}`, extension)
  );
  const options = imageFormat === "jpeg"
    ? { type: "jpeg", quality: 85, fullPage: !!full_page }
    : { type: "png", fullPage: !!full_page };

  await state.page.screenshot({ ...options, path: outputPath });
  const file = await stat(outputPath);
  const metadata = await sharp(outputPath).metadata();

  return {
    ok: true,
    path: outputPath,
    mime_type: imageFormat === "jpeg" ? "image/jpeg" : "image/png",
    bytes: file.size,
    size: { width: metadata.width, height: metadata.height },
    viewport: { width: viewport.width, height: viewport.height },
    device_pixel_ratio: viewport.device_pixel_ratio,
    recording_pointer_hidden: pointer.hidden,
    full_page: !!full_page,
    url: state.page.url(),
    title: await state.page.title(),
  };
}

export async function browserVideo({
  action,
  filename,
  format,
  capture_scale,
  selector,
  ref,
  wait_for_url,
  exact,
  timeout,
  post_click_ms,
}) {
  if (action === "capture_click") {
    if (!selector && !ref) throw new Error("browser_video capture_click requires 'selector' or 'ref'");
    if (state.videoRecording) throw new Error("A video recording is already active. Stop it before capture_click.");

    await ensureBrowser();
    const sourceUrl = state.page.url();
    const started = await browserVideo({ action: "start", filename, format, capture_scale });
    let actionResult = null;
    let urlResult = null;
    let captureError = null;

    try {
      const acted = await browserAct({
        commands: [{ action: "click", ...(ref ? { ref } : { selector }) }],
      });
      actionResult = acted.results[0] || null;
      if (!actionResult?.success) throw new Error(actionResult?.error || "Click failed");

      if (wait_for_url) {
        urlResult = await browserWaitForUrl({
          pattern: wait_for_url,
          exact,
          timeout: timeout || 2500,
        });
        if (!urlResult.ok) throw new Error(`Destination URL did not match '${wait_for_url}' before the clip timeout`);
      }

      const tailMs = Math.max(0, Math.min(post_click_ms ?? 450, 2000));
      if (tailMs) await state.page.waitForTimeout(tailMs);
    } catch (error) {
      captureError = error;
    }

    const stopped = state.videoRecording
      ? await browserVideo({ action: "stop" })
      : null;

    return {
      ...(stopped || started),
      ok: !captureError,
      action: "capture_click",
      source_url: sourceUrl,
      destination_url: state.page?.url() || null,
      action_succeeded: actionResult?.success === true,
      url_matched: wait_for_url ? urlResult?.ok === true : null,
      ...(captureError ? { error: captureError.message } : {}),
    };
  }

  if (action === "status") {
    return state.videoRecording
      ? {
          ok: true,
          version: MARE_BROWSER_VERSION,
          recording: true,
          started_at: state.videoRecording.startedAt,
          filename: state.videoRecording.filename,
          format: state.videoRecording.format,
          mode: state.videoRecording.mode,
          size: state.videoRecording.size,
          viewport: state.videoRecording.viewport,
          device_pixel_ratio: state.videoRecording.devicePixelRatio,
          capture_scale: state.videoRecording.captureScale,
          url: state.page?.url() || state.videoRecording.url,
        }
      : { ok: true, version: MARE_BROWSER_VERSION, recording: false };
  }

  if (action === "start") {
    if (state.videoRecording) {
      throw new Error("A video recording is already active. Stop it before starting another.");
    }

    await ensureBrowser();
    await mkdir(CAPTURE_DIR, { recursive: true });
    const currentUrl = state.page.url();
    const metrics = await state.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    }));
    const captureScale = capture_scale === "css" ? "css" : "device";
    const scale = captureScale === "device" ? metrics.devicePixelRatio : 1;
    const videoSize = {
      width: evenDimension(metrics.width * scale),
      height: evenDimension(metrics.height * scale),
    };
    const startedAt = new Date().toISOString();
    const requestedFormat = format === "mp4" ? "mp4" : "webm";
    const fallbackName = `recording-${timestampSlug()}`;
    const rawFilename = captureName(
      filename,
      fallbackName,
      "webm"
    );
    const outputFilename = captureName(filename, fallbackName, requestedFormat);
    const rawPath = join(CAPTURE_DIR, rawFilename);
    const outputPath = join(CAPTURE_DIR, outputFilename);
    let mode;

    if (typeof state.page.screencast?.start === "function") {
      await state.page.screencast.start({ path: rawPath, size: videoSize, quality: 100 });
      mode = "screencast";
    } else {
      await rebuildBrowser({ url: currentUrl, recordVideoDir: CAPTURE_DIR, recordVideoSize: videoSize });
      mode = "recordVideo";
    }

    state.videoRecording = {
      filename: outputFilename,
      startedAt,
      startedAtMs: Date.now(),
      url: currentUrl,
      size: videoSize,
      viewport: { width: metrics.width, height: metrics.height },
      devicePixelRatio: metrics.devicePixelRatio,
      captureScale,
      mode,
      format: requestedFormat,
      rawPath,
      outputPath,
    };

    return {
      ok: true,
      version: MARE_BROWSER_VERSION,
      recording: true,
      started_at: startedAt,
      filename: outputFilename,
      format: requestedFormat,
      mode,
      size: videoSize,
      viewport: { width: metrics.width, height: metrics.height },
      device_pixel_ratio: metrics.devicePixelRatio,
      capture_scale: captureScale,
      temp_directory: CAPTURE_DIR,
      url: state.page.url(),
      page_restored: state.page.url() === currentUrl,
    };
  }

  if (action === "stop") {
    if (!state.videoRecording) {
      throw new Error("No video recording is active. Start one before stopping.");
    }

    const recording = state.videoRecording;
    const currentUrl = state.page.url();
    const currentTitle = await state.page.title();

    if (recording.mode === "screencast") {
      await state.page.screencast.stop();
    } else {
      const video = state.page.video();
      if (!video) throw new Error("The active page has no Playwright video stream.");
      await rebuildBrowser({ url: currentUrl, recordVideoDir: null, recordVideoSize: null });
      const playwrightPath = await video.path();
      if (playwrightPath !== recording.rawPath) await rename(playwrightPath, recording.rawPath);
    }

    const pointer = await hideRecordingPointer(state.page);

    // Capture has ended at this point. Clear the active state before optional
    // post-processing so a failed MP4 conversion never leaves a phantom
    // recording that cannot be stopped again.
    state.videoRecording = null;

    let finalPath = recording.rawPath;
    let mimeType = "video/webm";
    if (recording.format === "mp4") {
      await convertVideoToMp4(recording.rawPath, recording.outputPath);
      await unlink(recording.rawPath);
      finalPath = recording.outputPath;
      mimeType = "video/mp4";
    }

    const file = await stat(finalPath);

    return {
      ok: true,
      version: MARE_BROWSER_VERSION,
      recording: false,
      path: finalPath,
      mime_type: mimeType,
      bytes: file.size,
      started_at: recording.startedAt,
      duration_ms: Date.now() - recording.startedAtMs,
      format: recording.format,
      mode: recording.mode,
      size: recording.size,
      viewport: recording.viewport,
      device_pixel_ratio: recording.devicePixelRatio,
      capture_scale: recording.captureScale,
      recording_pointer_hidden: pointer.hidden,
      url: currentUrl,
      title: currentTitle,
      page_restored: state.page.url() === currentUrl,
    };
  }

  throw new Error("browser_video action must be 'start', 'stop', 'status', or 'capture_click'.");
}

export async function browserEval({ code }) {
  await ensureBrowser();
  const result = await state.page.evaluate(code);
  return { result };
}

export async function browserScroll({ direction, pixels, selector, container }) {
  await ensureBrowser();
  const page = state.page;

  // Scroll to bring an element into view (no container context)
  if (selector && !container) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    return { scrolled_to: selector };
  }

  const px = pixels || 500;
  const dy = direction === "up" ? -px : px;

  // Scroll within a specific container element
  if (container) {
    const position = await page.evaluate(({ containerSel, dy }) => {
      const el = document.querySelector(containerSel);
      if (!el) throw new Error(`Container not found: ${containerSel}`);
      el.scrollTop += dy;
      return {
        container: containerSel,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    }, { containerSel: container, dy });

    return { scrolled_by: dy, ...position };
  }

  // Default: scroll the page
  await page.evaluate(dy => window.scrollBy(0, dy), dy);

  const position = await page.evaluate(() => ({
    scrollTop: document.documentElement.scrollTop || document.body.scrollTop,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
  }));

  return { scrolled_by: dy, ...position };
}

export async function browserRestart({ url }) {
  if (state.videoRecording) {
    throw new Error("A video recording is active. Stop it before restarting the browser.");
  }
  await teardown();
  state.consoleLog = [];
  state.networkLog = [];
  state.dialogLog = [];
  state.pendingRequests.clear();
  state.currentEmulation = null;
  await ensureBrowser();
  if (url) {
    await state.page.goto(url);
    return { restarted: true, url, title: await state.page.title() };
  }
  return { restarted: true };
}

export async function browserUpload({ selector, files }) {
  await ensureBrowser();
  await state.page.setInputFiles(selector, files);
  return { selector, files, success: true };
}

export async function browserWaitForNetwork({ url_pattern, method, timeout }) {
  await ensureBrowser();
  const ms = timeout || 10000;

  // url_pattern accepts either a single string or an array (any-of match).
  // Normalise to an array for a single branch in the matcher.
  const patterns = Array.isArray(url_pattern)
    ? url_pattern
    : (url_pattern ? [url_pattern] : null);

  const response = await state.page.waitForResponse(
    res => {
      const url = res.url();
      const matches_url = patterns ? patterns.some(p => url.includes(p)) : true;
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

export async function browserFetch({ url, method, body, headers, parse }) {
  await ensureBrowser();
  const result = await state.page.evaluate(async ({ url, method, body, headers, parse }) => {
    const opts = { credentials: "include", method: method || "GET" };
    if (body !== undefined) {
      opts.body = typeof body === "string" ? body : JSON.stringify(body);
      if (!headers) headers = {};
      if (typeof body !== "string" && !headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/json";
      }
    }
    if (headers) opts.headers = headers;

    const res = await fetch(url, opts);
    const contentType = res.headers.get("content-type") || "";
    let responseBody;
    if (parse === "status") {
      responseBody = null;
    } else if (parse === "text" || !contentType.includes("json")) {
      responseBody = await res.text();
    } else {
      const text = await res.text();
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
    }

    const resHeaders = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });

    return {
      status: res.status,
      ok: res.ok,
      url: res.url,
      headers: resHeaders,
      body: responseBody,
    };
  }, { url, method, body, headers, parse: parse || "json" });

  return result;
}

export async function browserWaitForUrl({ pattern, timeout, exact, wait_for }) {
  await ensureBrowser();
  const ms = timeout || 10000;
  const matcher = exact
    ? (url) => url.toString() === pattern
    : (url) => url.toString().includes(pattern);
  try {
    await state.page.waitForURL(matcher, { timeout: ms });
    // Optional readiness gate — URL change alone doesn't mean the new page
    // is interactive. Default "load" is what page.goto waits on; users can
    // escalate to "networkidle" or relax to "domcontentloaded".
    if (wait_for) {
      await state.page.waitForLoadState(wait_for, { timeout: ms });
    }
    return {
      url: state.page.url(),
      title: await state.page.title(),
      ok: true,
    };
  } catch {
    return {
      ok: false,
      error: "timeout",
      current_url: state.page.url(),
    };
  }
}
