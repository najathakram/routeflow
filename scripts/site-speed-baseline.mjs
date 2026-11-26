#!/usr/bin/env node
// Speed baseline for the public site (spec-delta 2026-11-14, section 4, T44 wave-0 baseline).
//
//   node scripts/heavy-slot.mjs run --label site-speed-baseline -- node scripts/site-speed-baseline.mjs
//   node scripts/heavy-slot.mjs run --label site-speed-baseline -- node scripts/site-speed-baseline.mjs --base-url http://localhost:3001 --out local-assets/runs/2026-11-14-wave0/speed-baseline.json
//
// Needs the stack up (npm run local:up) or `next dev` on :3001. Run it under the heavy slot (one heavy
// job per host; `node scripts/heavy-slot.mjs --help` prints its usage). It loads each of the 10 site
// pages at 1440x900 (no throttle) and 390x844 (CDP: 4x CPU, 10 Mb/s down/up, 40 ms latency), 3 runs
// each, and prints the MEDIAN of the three per page: LCP, CLS, TBT and (390 only) the Event Timing
// duration of the first `.menu-btn` click. The JSON goes to --out (the dir is git-ignored).
//
// TBT is approximated: the sum of (duration - 50 ms) of every `longtask` entry that starts after the
// first contentful paint and before WINDOW_MS after the load event (a stand-in for time-to-interactive).
// Refuses any base URL that is not localhost unless --allow-remote is passed. Uses the `playwright`
// package already installed for @playwright/test (no new dependency).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";

const PAGES = [
  "/",
  "/pricing",
  "/product",
  "/landing",
  "/company",
  "/contact",
  "/getting-started",
  "/does-and-doesnt",
  "/data-in-and-out",
  "/security",
];
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, throttle: false },
  phone: { width: 390, height: 844, throttle: true },
};
const RUNS = 3;
/** How long after the load event the probes keep listening (settle + stand-in for TTI). */
const WINDOW_MS = 3000;
const PHONE = { cpuRate: 4, bytesPerSec: (10 * 1000 * 1000) / 8, latencyMs: 40 };

function parseArgs(argv) {
  const opts = {
    baseUrl: "http://localhost:3001",
    out: "local-assets/runs/2026-11-14-wave0/speed-baseline.json",
    allowRemote: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base-url") opts.baseUrl = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--allow-remote") opts.allowRemote = true;
    else throw new Error(`unknown argument ${JSON.stringify(a)}`);
  }
  if (!opts.baseUrl || !opts.out) throw new Error("--base-url and --out need a value");
  return opts;
}

function isLocalUrl(url) {
  const { hostname } = new URL(url);
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Runs in the page before any script: collects the raw entries onto window.__speed. */
function installProbes() {
  const s = { lcp: 0, cls: 0, fcp: null, longtasks: [], events: [] };
  window.__speed = s;
  const observe = (type, cb, extra = {}) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(cb)).observe({
        type,
        buffered: true,
        ...extra,
      });
    } catch {
      // entry type not supported in this browser build
    }
  };
  observe("largest-contentful-paint", (e) => {
    s.lcp = e.startTime;
  });
  observe("layout-shift", (e) => {
    if (!e.hadRecentInput) s.cls += e.value;
  });
  observe("paint", (e) => {
    if (e.name === "first-contentful-paint") s.fcp = e.startTime;
  });
  observe("longtask", (e) => s.longtasks.push({ start: e.startTime, duration: e.duration }));
  observe(
    "event",
    (e) => {
      if (e.name === "click" || e.name === "pointerup") {
        s.events.push({ name: e.name, start: e.startTime, duration: e.duration });
      }
    },
    { durationThreshold: 16 },
  );
}

async function onePageRun(browser, base, route, key) {
  const vp = VIEWPORTS[key];
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: key === "phone",
    isMobile: key === "phone",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  // The site's own visit counter is not part of the page weight under test. Blocked at the CDP
  // network layer (not context.route, whose Fetch interception can disturb the throttling).
  await cdp.send("Network.setBlockedURLs", { urls: ["*cloud.umami.is*", "*/site/analytics.js*"] });
  if (vp.throttle) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: PHONE.cpuRate });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: PHONE.latencyMs,
      downloadThroughput: PHONE.bytesPerSec,
      uploadThroughput: PHONE.bytesPerSec,
    });
  }
  await page.addInitScript(installProbes);
  await page.goto(new URL(route, base).toString(), { waitUntil: "load" });
  await page.waitForTimeout(WINDOW_MS);
  const m = await page.evaluate(() => {
    const s = window.__speed;
    const fcp = s.fcp ?? 0;
    const tbt = s.longtasks
      .filter((t) => t.start >= fcp)
      .reduce((n, t) => n + Math.max(0, t.duration - 50), 0);
    return { lcpMs: s.lcp, cls: s.cls, tbtMs: tbt };
  });
  let menuTapMs = null;
  if (key === "phone") {
    const btn = page.locator(".menu-btn").first();
    if (await btn.count()) {
      await btn.tap().catch(() => btn.click());
      await page.waitForTimeout(600);
      menuTapMs = await page.evaluate(() => {
        const ev = window.__speed.events.filter(
          (e) => e.name === "click" || e.name === "pointerup",
        );
        const last = ev.filter((e) => e.name === "click").pop() ?? ev.pop();
        return last ? last.duration : 0;
      });
    }
  }
  await context.close();
  return { ...m, menuTapMs };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.allowRemote && !isLocalUrl(opts.baseUrl)) {
    console.error(
      `refusing ${opts.baseUrl}: not localhost. Pass --allow-remote only if you mean to load a hosted site.`,
    );
    process.exit(2);
  }
  const browser = await chromium.launch();
  const result = {
    baseUrl: opts.baseUrl,
    runs: RUNS,
    takenAt: new Date().toISOString(),
    pages: {},
  };
  try {
    for (const route of PAGES) {
      result.pages[route] = {};
      for (const key of Object.keys(VIEWPORTS)) {
        const samples = [];
        for (let i = 0; i < RUNS; i++)
          samples.push(await onePageRun(browser, opts.baseUrl, route, key));
        const med = {
          lcpMs: median(samples.map((s) => s.lcpMs)),
          cls: median(samples.map((s) => s.cls)),
          tbtMs: median(samples.map((s) => s.tbtMs)),
          ...(key === "phone" ? { menuTapMs: median(samples.map((s) => s.menuTapMs)) } : {}),
        };
        result.pages[route][key] = { median: med, samples };
        const f = (n, d = 0) => (n == null ? "n/a" : n.toFixed(d));
        console.log(
          `${route.padEnd(18)} ${key.padEnd(7)} LCP ${f(med.lcpMs)} ms  CLS ${f(med.cls, 3)}  TBT ${f(med.tbtMs)} ms` +
            (key === "phone" ? `  menu tap ${f(med.menuTapMs)} ms` : ""),
        );
      }
    }
  } finally {
    await browser.close();
  }
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify(result, null, 2));
  console.log(`wrote ${opts.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
