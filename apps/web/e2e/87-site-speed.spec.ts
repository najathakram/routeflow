/**
 * Site speed budget (T44), spec-delta 2026-11-14 section 4. Budgets: e2e/helpers/site-speed-budget.ts.
 * Home, product and pricing at 1440x900 (no throttle) and at 390x844 (4x CPU, 10 Mb/s, 40 ms), the
 * MEDIAN of 3 runs compared to the budget; plus the Event Timing duration of the first `.menu-btn`
 * click at 390. Signed out, localhost only (skips on a remote base URL). Baseline numbers for all ten
 * pages: scripts/site-speed-baseline.mjs.
 *
 * Run: `node scripts/heavy-slot.mjs run --label site-speed -- npx playwright test --project=site-speed --workers=1`
 * (from apps/web). The project entry does not exist yet: the W5 proof lane adds
 * `{ name: "site-speed", testMatch: /87-site-speed\.spec\.ts/, dependencies: [], use: { ...devices["Desktop Chrome"] } }`
 * to playwright.config.ts (a G1 file, so not edited here).
 */
import { test, expect, type Browser } from "@playwright/test";
import {
  MENU_TAP_DURATION_MS,
  PHONE_THROTTLE,
  SPEED_RUNS,
  TIMING_BUDGET,
  VIEWPORTS,
  type SiteViewport,
} from "./helpers/site-speed-budget";

const ROUTES = ["/", "/product", "/pricing"] as const;
/** Time the probes keep listening after the load event, a stand-in for time-to-interactive. */
const WINDOW_MS = 3000;

interface Sample {
  lcpMs: number;
  cls: number;
  tbtMs: number;
  menuTapMs: number | null;
}

/** Same guard as scripts/site-speed-baseline.mjs. */
function isLocalUrl(url: string): boolean {
  const { hostname } = new URL(url);
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

const median = (values: number[]): number => {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

async function sampleOnce(
  browser: Browser,
  baseURL: string,
  route: string,
  vp: SiteViewport,
): Promise<Sample> {
  const { width, height } = VIEWPORTS[vp];
  const context = await browser.newContext({
    baseURL,
    viewport: { width, height },
    hasTouch: vp === "phone",
    isMobile: vp === "phone",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  // Blocked at the CDP network layer (context.route's Fetch interception can disturb throttling).
  await cdp.send("Network.setBlockedURLs", { urls: ["*cloud.umami.is*", "*/site/analytics.js*"] });
  if (vp === "phone") {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: PHONE_THROTTLE.cpuRate });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: PHONE_THROTTLE.latencyMs,
      downloadThroughput: PHONE_THROTTLE.downloadBytesPerSec,
      uploadThroughput: PHONE_THROTTLE.uploadBytesPerSec,
    });
  }
  await page.addInitScript(() => {
    type W = Window & {
      __speed: {
        lcp: number;
        cls: number;
        fcp: number | null;
        longtasks: { start: number; duration: number }[];
        clicks: number[];
      };
    };
    const s: W["__speed"] = { lcp: 0, cls: 0, fcp: null, longtasks: [], clicks: [] };
    (window as unknown as W).__speed = s;
    const observe = (
      type: string,
      cb: (e: PerformanceEntry & Record<string, number | boolean | string>) => void,
      extra: Record<string, number> = {},
    ) => {
      try {
        new PerformanceObserver((list) =>
          list.getEntries().forEach((e) => cb(e as PerformanceEntry & Record<string, never>)),
        ).observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      } catch {
        // entry type not supported
      }
    };
    observe("largest-contentful-paint", (e) => {
      s.lcp = e.startTime;
    });
    observe("layout-shift", (e) => {
      if (!e.hadRecentInput) s.cls += e.value as number;
    });
    observe("paint", (e) => {
      if (e.name === "first-contentful-paint") s.fcp = e.startTime;
    });
    observe("longtask", (e) => s.longtasks.push({ start: e.startTime, duration: e.duration }));
    observe(
      "event",
      (e) => {
        if (e.name === "click") s.clicks.push(e.duration);
      },
      { durationThreshold: 16 },
    );
  });
  await page.goto(route, { waitUntil: "load" });
  await page.waitForTimeout(WINDOW_MS);
  const m = await page.evaluate(() => {
    // (lcpMs > 0 is asserted below, outside the page)
    const s = (
      window as unknown as {
        __speed: {
          lcp: number;
          cls: number;
          fcp: number | null;
          longtasks: { start: number; duration: number }[];
        };
      }
    ).__speed;
    const fcp = s.fcp ?? 0;
    const tbt = s.longtasks
      .filter((t) => t.start >= fcp)
      .reduce((n, t) => n + Math.max(0, t.duration - 50), 0);
    return { lcpMs: s.lcp, cls: s.cls, tbtMs: tbt };
  });
  expect(m.lcpMs, `${route} ${vp}: no LCP entry was recorded`).toBeGreaterThan(0);
  let menuTapMs: number | null = null;
  if (vp === "phone") {
    const btn = page.locator(".menu-btn").first();
    await expect(btn, `${route} has a .menu-btn at 390`).toBeVisible();
    await btn.tap();
    // A missed tap must not score 0 ms: the menu has to actually have opened.
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(600);
    menuTapMs = await page.evaluate(
      () => (window as unknown as { __speed: { clicks: number[] } }).__speed.clicks.pop() ?? 0,
    );
  }
  await context.close();
  return { ...m, menuTapMs };
}

test.describe("T44 site speed budget (median of 3) @site-speed", () => {
  // Timing proof: run with --workers=1 so pages do not compete for the CPU. Not serial mode: one
  // failing route must not hide the others.
  test.beforeEach(({ baseURL }) => {
    test.skip(
      !!baseURL && !isLocalUrl(baseURL),
      `T44 loads pages hard and throttles; it runs on localhost only (base URL ${baseURL})`,
    );
  });

  for (const vp of ["desktop", "phone"] as const) {
    for (const route of ROUTES) {
      test(`T44 ${route} at ${VIEWPORTS[vp].width}px: LCP, CLS, TBT${vp === "phone" ? ", menu tap" : ""}`, async ({
        browser,
        baseURL,
      }) => {
        test.setTimeout(180_000);
        if (!baseURL) throw new Error("T44: no baseURL in the Playwright config");
        const samples: Sample[] = [];
        for (let i = 0; i < SPEED_RUNS; i++)
          samples.push(await sampleOnce(browser, baseURL, route, vp));
        const med = {
          lcpMs: median(samples.map((s) => s.lcpMs)),
          cls: median(samples.map((s) => s.cls)),
          tbtMs: median(samples.map((s) => s.tbtMs)),
        };
        const b = TIMING_BUDGET[vp];
        const tag = `${route} ${VIEWPORTS[vp].width}px`;
        const over: string[] = [];
        if (med.lcpMs > b.lcpMs) over.push(`${tag} LCP ${med.lcpMs.toFixed(0)} ms > ${b.lcpMs}`);
        if (med.cls > b.cls) over.push(`${tag} CLS ${med.cls.toFixed(3)} > ${b.cls}`);
        if (med.tbtMs > b.tbtMs) over.push(`${tag} TBT ${med.tbtMs.toFixed(0)} ms > ${b.tbtMs}`);
        if (vp === "phone") {
          const tap = median(samples.map((s) => s.menuTapMs ?? Number.POSITIVE_INFINITY));
          if (tap > MENU_TAP_DURATION_MS) {
            over.push(`${tag} menu tap ${tap.toFixed(0)} ms > ${MENU_TAP_DURATION_MS}`);
          }
        }
        expect(over, `over budget (median of ${SPEED_RUNS}):\n${over.join("\n")}`).toEqual([]);
      });
    }
  }
});
