// Non-emulation MCP tool handlers. Each function does `await ensureBrowser()`
// first, then drives the Playwright page. All mutable state goes through
// `state` from state.js so concurrent access (there isn't any — MCP is
// single-threaded) sees consistent values.

import { state, MAX_BODY_SIZE } from "./state.js";
import { ensureBrowser, teardown } from "./browser.js";

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

  for (const cmd of commands) {
    try {
      switch (cmd.action) {
        case "click":
          await page.locator(cmd.selector).first().click({ button: cmd.button || "left", timeout: 5000 });
          results.push({ action: "click", selector: cmd.selector, button: cmd.button || "left", success: true });
          break;

        case "hover":
          await page.locator(cmd.selector).first().hover({ timeout: 5000 });
          results.push({ action: "hover", selector: cmd.selector, success: true });
          break;

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
          await loc.first().click({ timeout: 5000 });
          results.push({ action: "clicklink", text: cmd.text, success: true });
          break;
        }

        case "fill":
          await page.fill(cmd.selector, cmd.value);
          results.push({ action: "fill", selector: cmd.selector, success: true });
          break;

        case "select":
          await page.locator(cmd.selector).first().selectOption(cmd.value, { timeout: 5000 });
          results.push({ action: "select", selector: cmd.selector, value: cmd.value, success: true });
          break;

        case "keypress":
          await page.keyboard.press(cmd.key);
          results.push({ action: "keypress", key: cmd.key, success: true });
          break;

        case "waitfor":
          await page.waitForSelector(cmd.selector, { timeout: cmd.timeout || 5000 });
          results.push({ action: "waitfor", selector: cmd.selector, success: true });
          break;

        case "scrollto":
          await page.locator(cmd.selector).scrollIntoViewIfNeeded();
          results.push({ action: "scrollto", selector: cmd.selector, success: true });
          break;

        case "wait":
          await page.waitForTimeout(cmd.ms || 1000);
          results.push({ action: "wait", ms: cmd.ms, success: true });
          break;

        case "drag": {
          const source = page.locator(cmd.selector).first();
          if (cmd.target) {
            await source.dragTo(page.locator(cmd.target).first(), { timeout: 5000 });
            results.push({ action: "drag", selector: cmd.selector, target: cmd.target, success: true });
          } else if (cmd.offsetX !== undefined || cmd.offsetY !== undefined) {
            const box = await source.boundingBox();
            if (!box) throw new Error(`Element not visible: ${cmd.selector}`);
            const startX = box.x + box.width / 2;
            const startY = box.y + box.height / 2;
            await page.mouse.move(startX, startY);
            await page.mouse.down();
            await page.mouse.move(startX + (cmd.offsetX || 0), startY + (cmd.offsetY || 0), { steps: 10 });
            await page.mouse.up();
            results.push({ action: "drag", selector: cmd.selector, offsetX: cmd.offsetX, offsetY: cmd.offsetY, success: true });
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

export async function browserDebug({ url_filter, method_filter, console_types, last_n }) {
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
    network: network.slice(-n),
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

export async function browserScreenshot() {
  await ensureBrowser();
  const buffer = await state.page.screenshot();
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType: "image/png",
  };
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

  const response = await state.page.waitForResponse(
    res => {
      const matches_url = url_pattern ? res.url().includes(url_pattern) : true;
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
