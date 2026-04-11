// Non-emulation MCP tool handlers. Each function does `await ensureBrowser()`
// first, then drives the Playwright page. All mutable state goes through
// `state` from state.js so concurrent access (there isn't any — MCP is
// single-threaded) sees consistent values.

import { state, MAX_BODY_SIZE } from "./state.js";
import { ensureBrowser, teardown } from "./browser.js";
import sharp from "sharp";

export async function browserSnapshot({ max_depth }) {
  await ensureBrowser();
  state.refMap.clear();
  state.refCounter = 0;

  const page = state.page;
  const snapshot = await page.evaluate((maxDepth) => {
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

    const counter = { value: 0 };
    const refs = [];

    function walk(el, depth) {
      if (!el || depth > maxDepth || el === document.body) return null;
      const role = getRole(el);
      if (!role) {
        if (el.children) {
          const ch = [];
          for (const c of el.children) { const r = walk(c, depth + 1); if (r) ch.push(r); }
          return ch.length ? { role: el.tagName.toLowerCase(), children: ch } : null;
        }
        return null;
      }
      const name = getName(el);
      const node = { role };
      if (name) node.name = name;
      if (INTERACTIVE.has(role)) {
        counter.value++;
        const ref = `e${counter.value}`;
        node.ref = ref;
        refs.push({ ref, selector: getSelector(el), role, name });
      }
      if (el.children && el.children.length) {
        const ch = [];
        for (const c of el.children) { const r = walk(c, depth + 1); if (r) ch.push(r); }
        if (ch.length) node.children = ch;
      }
      return node;
    }

    const children = [];
    for (const c of document.body.children) { const r = walk(c, 0); if (r) children.push(r); }
    return { snapshot: children, refs };
  }, max_depth || 10);

  for (const { ref, selector, role, name } of snapshot.refs) {
    state.refMap.set(ref, { selector, role, name });
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
  const { selector } = resolveRef(ref);
  return page.locator(selector).first();
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
          await loc.first().click({ timeout: 5000 });
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

export async function browserScreenshot({ quality }) {
  await ensureBrowser();
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

export async function browserWaitForUrl({ pattern, timeout }) {
  await ensureBrowser();
  const ms = timeout || 10000;
  try {
    await state.page.waitForURL(url => url.toString().includes(pattern), { timeout: ms });
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
