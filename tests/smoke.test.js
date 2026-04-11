import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";

let browser, context, page, server;
const PORT = 18081;

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body id='root'></body></html>");
      } else if (req.url === "/api/me") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ user: "test", role: "admin" }));
      } else if (req.url === "/api/text") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("plain text response");
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.listen(PORT, () => resolve());
  });
}

function stopServer() {
  return new Promise((resolve) => { server.close(resolve); });
}

beforeEach(async () => {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  page = await context.newPage();
  await startServer();
});

afterEach(async () => {
  await stopServer();
  await context?.close();
  await browser?.close();
});

// ── browser_snapshot ──

test("browser_snapshot DOM walker returns refs for interactive elements", async () => {
  await page.goto(`http://localhost:${PORT}`);
  await page.evaluate(() => {
    document.getElementById("root").innerHTML = `
      <button id="btn1">Click me</button>
      <a href="/home">Home</a>
      <input type="text" placeholder="Email" aria-label="Email" />
      <p>Not interactive</p>
    `;
  });

  const result = await page.evaluate(() => {
    const INTERACTIVE = new Set([
      "link", "button", "textbox", "searchbox", "combobox",
      "checkbox", "radio", "switch", "slider", "spinbutton", "tab",
    ]);

    function getRole(el) {
      if (el.role && el.role !== "presentation") return el.role;
      const t = el.tagName;
      if (t === "A") return "link";
      if (t === "BUTTON" || t === "SUMMARY") return "button";
      if (t === "INPUT") {
        const tp = el.type?.toLowerCase();
        if (tp === "checkbox") return "checkbox";
        if (tp === "radio") return "radio";
        if (tp === "submit" || tp === "reset") return "button";
        if (tp === "search") return "searchbox";
        if (tp === "hidden" || tp === "file") return null;
        return "textbox";
      }
      if (t === "SELECT") return "combobox";
      if (t === "TEXTAREA") return "textbox";
      return null;
    }

    function getName(el) {
      if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
      if (el.tagName === "BUTTON" || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
        if (el.placeholder) return el.placeholder;
        const label = el.closest("label");
        if (label) return label.textContent?.trim() || "";
        if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return l.textContent?.trim() || ""; }
        return el.textContent?.trim() || "";
      }
      if (el.tagName === "A" || el.tagName === "SUMMARY") return el.textContent?.trim() || "";
      return el.textContent?.trim() || "";
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

    const counter = { value: 0 };
    const refs = [];

    function walk(el, depth) {
      if (!el || depth > 10 || el === document.body) return null;
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
        node.ref = `e${counter.value}`;
        refs.push({ ref: node.ref, selector: getSelector(el), role, name });
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
  });

  assert.ok(result.refs.length >= 3, `Expected at least 3 refs, got ${result.refs.length}`);

  const hasBtn = result.refs.some(r => r.role === "button");
  const hasLink = result.refs.some(r => r.role === "link");
  const hasTextbox = result.refs.some(r => r.role === "textbox");
  assert.ok(hasBtn, "Should have a button ref");
  assert.ok(hasLink, "Should have a link ref");
  assert.ok(hasTextbox, "Should have a textbox ref");

  const btnRef = result.refs.find(r => r.role === "button");
  assert.ok(btnRef.selector.startsWith("#btn1"), `Button selector should be #btn1, got ${btnRef.selector}`);
});

test("ref-based selector actually targets the correct element", async () => {
  await page.goto(`http://localhost:${PORT}`);
  await page.evaluate(() => {
    document.getElementById("root").innerHTML = `
      <button id="btn-a" onclick="window.__clicked='a'">Button A</button>
      <button id="btn-b" onclick="window.__clicked='b'">Button B</button>
    `;
  });

  const result = await page.evaluate(() => {
    const refs = [];
    function getSelector(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      return el.tagName.toLowerCase();
    }
    for (const btn of document.querySelectorAll("button")) {
      refs.push({ selector: getSelector(btn), name: btn.textContent.trim() });
    }
    return refs;
  });

  assert.equal(result.length, 2);

  await page.locator(result[1].selector).click();
  const clicked = await page.evaluate(() => window.__clicked);
  assert.equal(clicked, "b", "Clicking selector for Button B should set __clicked to 'b'");
});

// ── browser_fetch ──

test("browser_fetch can hit same-origin API and return JSON", async () => {
  await page.goto(`http://localhost:${PORT}`);

  const result = await page.evaluate(async () => {
    const res = await fetch("/api/me", { credentials: "include" });
    return { status: res.status, body: await res.json() };
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { user: "test", role: "admin" });
});

test("browser_fetch with JSON parse falls back to text on non-JSON response", async () => {
  await page.goto(`http://localhost:${PORT}`);

  const result = await page.evaluate(async () => {
    const res = await fetch("/api/text", { credentials: "include" });
    const contentType = res.headers.get("content-type") || "";
    let body;
    if (!contentType.includes("json")) {
      body = await res.text();
    } else {
      const text = await res.text();
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { body, status: res.status };
  });

  assert.equal(result.status, 200);
  assert.equal(result.body, "plain text response");
});

// ── browser_wait_for_url ──

test("browser_wait_for_url resolves when URL changes", async () => {
  await page.goto(`http://localhost:${PORT}`);
  await page.evaluate(() => {
    document.body.innerHTML = `<button id="go" onclick="window.location.hash='#section2'">Go</button>`;
  });

  const promise = page.waitForURL(url => url.toString().includes("#section2"), { timeout: 5000 });
  await page.click("#go");
  await promise;

  assert.ok(page.url().includes("#section2"));
});

test("browser_wait_for_url times out cleanly", async () => {
  await page.goto(`http://localhost:${PORT}`);

  try {
    await page.waitForURL(url => url.toString().includes("/never"), { timeout: 500 });
    assert.fail("Should have timed out");
  } catch (err) {
    assert.ok(
      err.message.includes("Timeout") || err.message.includes("timeout") || err.message.includes("500ms"),
      `Expected timeout error, got: ${err.message}`
    );
  }
});

// ── State persistence ──

test("storageState can be saved before context close and loaded after", async () => {
  const tmpDir = fs.mkdtempSync(os.tmpdir() + "/mare-test-");
  const statePath = `${tmpDir}/state.json`;

  await page.goto(`http://localhost:${PORT}`);
  await page.evaluate(() => { document.cookie = "session=abc123; path=/"; });
  await page.evaluate(() => { localStorage.setItem("token", "xyz789"); });

  await context.storageState({ path: statePath });
  assert.ok(fs.existsSync(statePath), "State file should exist after save");

  const content = JSON.parse(fs.readFileSync(statePath, "utf-8"));
  assert.ok(content.cookies.length > 0, "Should have saved cookies");
  const sessionCookie = content.cookies.find(c => c.name === "session");
  assert.ok(sessionCookie, "Should have saved the session cookie");
  assert.equal(sessionCookie.value, "abc123");

  assert.ok(Array.isArray(content.origins), "Should have origins array");
  if (content.origins.length > 0) {
    assert.equal(content.origins[0].localStorage.length, 1);
    assert.equal(content.origins[0].localStorage[0].name, "token");
  }

  const ctx2 = await browser.newContext({ storageState: statePath });
  const page2 = await ctx2.newPage();
  await page2.goto(`http://localhost:${PORT}`);
  const cookies = await ctx2.cookies();
  const restored = cookies.find(c => c.name === "session");
  assert.ok(restored, "Session cookie should be restored in new context");
  assert.equal(restored.value, "abc123");

  await ctx2.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Thumbnail screenshot ──

test("screenshot with JPEG type returns a valid JPEG buffer", async () => {
  await page.setContent(`<html><body><h1>Hello</h1></body></html>`);
  const buf = await page.screenshot({ type: "jpeg", quality: 60 });
  assert.ok(buf.length > 0, "Should produce a non-empty JPEG buffer");
  assert.ok(buf[0] === 0xFF && buf[1] === 0xD8, "Should start with JPEG magic bytes");
});

test("screenshot with fullPage captures full page", async () => {
  await page.setContent(`
    <html><body><style>body { margin: 0; } div { height: 2000px; }</style>
    <div>Tall page</div></body></html>
  `);
  const buf = await page.screenshot({ fullPage: true });
  assert.ok(buf.length > 0);
});
