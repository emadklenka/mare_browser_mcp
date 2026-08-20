// Read-only dry run for browser_emulate_device design.
// Not imported by src/. Delete after validating the approach.
//
// Spins up ephemeral Playwright Chromium contexts with different
// emulation options, visits example.com, reads the probe payload,
// then navigates again to confirm emulation persists across page loads.
//
// Run: node scripts/probe-emulation.js

import { chromium, devices } from 'playwright';

const probe = `({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  dpr: window.devicePixelRatio,
  userAgent: navigator.userAgent,
  hasTouch: 'ontouchstart' in window,
  maxTouchPoints: navigator.maxTouchPoints,
  mq: {
    mobile_max768: matchMedia('(max-width: 768px)').matches,
    tablet_max1024: matchMedia('(max-width: 1024px)').matches,
    desktop_min1024: matchMedia('(min-width: 1024px)').matches,
    portrait: matchMedia('(orientation: portrait)').matches,
    landscape: matchMedia('(orientation: landscape)').matches,
    pointer_coarse: matchMedia('(pointer: coarse)').matches,
    pointer_fine: matchMedia('(pointer: fine)').matches,
    hover_none: matchMedia('(hover: none)').matches,
    hover_hover: matchMedia('(hover: hover)').matches
  }
})`;

const cases = [
  {
    name: 'desktop-baseline',
    opts: { viewport: { width: 1280, height: 800 } },
  },
  {
    name: 'ipad-pro-13-custom',
    opts: {
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 1024, height: 1366 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      screen: { width: 1024, height: 1366 },
    },
  },
  {
    name: 'ipad-pro-11-playwright-preset',
    opts: { ...devices['iPad Pro 11'] },
  },
  {
    name: 'iphone-15-pro-max-via-preset',
    opts: { ...(devices['iPhone 15 Pro Max'] || devices['iPhone 14 Pro Max']) },
  },
  {
    name: 'galaxy-tab-s9-custom',
    opts: {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 800, height: 1280 },
      deviceScaleFactor: 2.5,
      isMobile: true,
      hasTouch: true,
      screen: { width: 800, height: 1280 },
    },
  },
  {
    name: 'ipad-landscape-orientation-flip',
    opts: {
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 1366, height: 1024 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      screen: { width: 1366, height: 1024 },
    },
  },
];

console.log('Playwright devices available sample:');
console.log('  iPad Pro 11 ->', devices['iPad Pro 11'] ? 'yes' : 'missing');
console.log('  iPhone 15 Pro Max ->', devices['iPhone 15 Pro Max'] ? 'yes' : 'missing');
console.log('  iPhone 14 Pro Max ->', devices['iPhone 14 Pro Max'] ? 'yes' : 'missing');
console.log('  Galaxy Tab S4 ->', devices['Galaxy Tab S4'] ? 'yes' : 'missing');
console.log('  Galaxy S9+ ->', devices['Galaxy S9+'] ? 'yes' : 'missing');
console.log('');

const browser = await chromium.launch({ headless: true });

// A responsive test page we control — has viewport meta, so it honors
// the emulated viewport width instead of falling back to 980px.
const responsiveHtml =
  'data:text/html,' +
  encodeURIComponent(
    '<!doctype html><html><head>' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>responsive</title></head><body><h1>responsive page</h1></body></html>'
  );

// A non-responsive page (no viewport meta) — mobile emulation will render
// it at the legacy 980px fallback width, which is correct browser behavior.
const legacyHtml = 'data:text/html,<h1>legacy page (no viewport meta)</h1>';

// Identity fields — these are emulation state, they should NEVER drift on navigate.
// innerWidth/innerHeight are page-layout state and can legitimately change on
// non-responsive pages due to the 980px legacy fallback.
function identity(p) {
  return {
    userAgent: p.userAgent,
    dpr: p.dpr,
    hasTouch: p.hasTouch,
    maxTouchPoints: p.maxTouchPoints,
    pointer_coarse: p.mq.pointer_coarse,
    hover_none: p.mq.hover_none,
  };
}

function identityMatch(a, b) {
  return JSON.stringify(identity(a)) === JSON.stringify(identity(b));
}

for (const c of cases) {
  const ctx = await browser.newContext(c.opts);
  const page = await ctx.newPage();

  await page.goto('https://example.com');
  const onExample = await page.evaluate(probe);

  await page.goto(responsiveHtml);
  const onResponsive = await page.evaluate(probe);

  await page.goto(legacyHtml);
  const onLegacy = await page.evaluate(probe);

  await page.goto(responsiveHtml);
  const onResponsiveAgain = await page.evaluate(probe);

  console.log(`\n=== ${c.name} ===`);
  console.log('example.com        :', JSON.stringify(identity(onExample)));
  console.log('  innerWidth=' + onExample.innerWidth);
  console.log('responsive page    :', JSON.stringify(identity(onResponsive)));
  console.log('  innerWidth=' + onResponsive.innerWidth);
  console.log('legacy (no meta)   :', JSON.stringify(identity(onLegacy)));
  console.log('  innerWidth=' + onLegacy.innerWidth);
  console.log('responsive again   :', JSON.stringify(identity(onResponsiveAgain)));
  console.log('  innerWidth=' + onResponsiveAgain.innerWidth);

  const identityStable =
    identityMatch(onExample, onResponsive) &&
    identityMatch(onResponsive, onLegacy) &&
    identityMatch(onLegacy, onResponsiveAgain);

  const responsiveViewportMatchesContext =
    c.opts.viewport ? onResponsive.innerWidth === c.opts.viewport.width : 'n/a (preset)';

  console.log(
    `identity-stable-across-navs: ${identityStable ? 'YES' : 'NO'}`
  );
  console.log(
    `responsive-page-honors-viewport-width: ${responsiveViewportMatchesContext}`
  );

  await ctx.close();
}

// ─── Test: does Playwright warn/error on isMobile without viewport? ───────────
console.log('\n=== edge case: isMobile:true without viewport ===');
try {
  const ctx = await browser.newContext({
    isMobile: true,
    hasTouch: true,
    userAgent: 'test',
  });
  const page = await ctx.newPage();
  await page.goto('https://example.com');
  const result = await page.evaluate(probe);
  console.log('no error thrown. result innerWidth =', result.innerWidth);
  console.log('identity:', JSON.stringify(identity(result)));
  await ctx.close();
} catch (e) {
  console.log('Playwright threw:', e.message);
}

// ─── Test: does Playwright warn/error on hasTouch without viewport? ───────────
console.log('\n=== edge case: hasTouch:true only, no viewport ===');
try {
  const ctx = await browser.newContext({
    hasTouch: true,
    userAgent: 'test',
  });
  const page = await ctx.newPage();
  await page.goto('https://example.com');
  const result = await page.evaluate(probe);
  console.log('no error thrown. innerWidth =', result.innerWidth, 'hasTouch =', result.hasTouch);
  await ctx.close();
} catch (e) {
  console.log('Playwright threw:', e.message);
}

// ─── Test: screen.width/height on mobile context ──────────────────────────────
// Does Playwright's `screen` option actually make window.screen.width report
// the device screen size (not just the viewport)? This matters for code that
// reads screen.* to detect device size.
console.log('\n=== screen.* readback on iPad Pro 13 custom ===');
{
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 1024, height: 1366 },
    screen: { width: 1024, height: 1366 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(responsiveHtml);
  const result = await page.evaluate(`({
    screenWidth: screen.width,
    screenHeight: screen.height,
    availWidth: screen.availWidth,
    availHeight: screen.availHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight
  })`);
  console.log(JSON.stringify(result, null, 2));
  await ctx.close();
}

// ─── Real-site test: responsive layouts + screenshots ────────────────────────
// example.com is a blank page and proves nothing about real layouts.
// This block navigates real sites on real devices and saves screenshots
// to scripts/probe-screens/ so we can visually confirm the layout changes.

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const screenDir = resolve('.tmp-test');
mkdirSync(screenDir, { recursive: true });

const realSiteCases = [
  { name: 'desktop-1280', opts: { viewport: { width: 1280, height: 800 } } },
  {
    name: 'iphone-15-pro-max',
    opts: { ...devices['iPhone 15 Pro Max'] },
  },
  {
    name: 'ipad-pro-13-custom-portrait',
    opts: {
      userAgent:
        'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 1024, height: 1366 },
      screen: { width: 1024, height: 1366 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    },
  },
  {
    name: 'galaxy-tab-s9-custom-portrait',
    opts: {
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 800, height: 1280 },
      screen: { width: 800, height: 1280 },
      deviceScaleFactor: 2.5,
      isMobile: true,
      hasTouch: true,
    },
  },
];

// Sites chosen for real responsive behavior:
//  - m.youtube.com: UA-sniffs and serves mobile shell if it sees mobile UA
//  - github.com: classic CSS-breakpoint responsive, no UA sniffing
//  - en.wikipedia.org: serves m.wikipedia.org on mobile UA (UA sniff)
const sites = [
  { tag: 'youtube', url: 'https://www.youtube.com' },
  { tag: 'github',  url: 'https://github.com' },
  { tag: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Responsive_web_design' },
];

console.log('\n──── REAL SITE TESTS ────');

for (const c of realSiteCases) {
  console.log(`\n=== ${c.name} ===`);
  const ctx = await browser.newContext(c.opts);
  const page = await ctx.newPage();

  for (const site of sites) {
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500); // let layout settle
      const landedUrl = page.url();

      const snapshot = await page.evaluate(`({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        dpr: window.devicePixelRatio,
        userAgent: navigator.userAgent,
        hasTouch: 'ontouchstart' in window,
        maxTouchPoints: navigator.maxTouchPoints,
        pointer_coarse: matchMedia('(pointer: coarse)').matches,
        hover_none: matchMedia('(hover: none)').matches,
        mobile_max768: matchMedia('(max-width: 768px)').matches,
        has_viewport_meta: !!document.querySelector('meta[name=viewport]'),
        viewport_meta_content: document.querySelector('meta[name=viewport]')?.getAttribute('content') || null,
        body_client_width: document.body?.clientWidth ?? null,
        doc_client_width: document.documentElement.clientWidth
      })`);

      const shotPath = `${screenDir}/${c.name}__${site.tag}.png`;
      await page.screenshot({ path: shotPath, fullPage: false });

      console.log(`  ${site.tag}: landed=${landedUrl}`);
      console.log(`    innerWidth=${snapshot.innerWidth} docClientWidth=${snapshot.doc_client_width} has_viewport_meta=${snapshot.has_viewport_meta}`);
      console.log(`    mobile_max768=${snapshot.mobile_max768} pointer_coarse=${snapshot.pointer_coarse} hover_none=${snapshot.hover_none}`);
      console.log(`    screenshot → ${shotPath}`);
    } catch (e) {
      console.log(`  ${site.tag}: ERROR ${e.message}`);
    }
  }

  await ctx.close();
}

await browser.close();
console.log('\nprobe complete.');
