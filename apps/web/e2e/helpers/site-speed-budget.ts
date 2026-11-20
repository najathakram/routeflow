/**
 * Speed budget for the public site (spec-delta 2026-11-14, section 4). One place for the numbers:
 * T43 (static Jest, app/(marketing)/site-speed-budget.static.test.ts) reads the weight caps,
 * T44 (e2e/87-site-speed.spec.ts) and scripts/site-speed-baseline.mjs read the timing caps.
 * Weights are gzip kilobytes (1 KB = 1024 bytes); times are milliseconds.
 */

/** T43: total gzip weight of a page (html + linked css, js, images, fonts), in KB. */
export const GZIP_TOTAL_KB = { home: 175, inner: 115, landing: 45 } as const;
/** T43: the html alone, gzip KB, every page. */
export const HTML_GZIP_KB = 20;
/** T43: all linked scripts together, gzip KB. */
export const SCRIPT_GZIP_KB = { home: 90, inner: 57, landing: 2 } as const;
/** T43: one raster icon (png/jpg/webp), gzip KB. */
export const RASTER_ICON_GZIP_KB = 15;
/** T43: the one Geist woff2, gzip KB. */
export const FONT_GZIP_KB = 25;

export type SiteViewport = "desktop" | "phone";

export interface TimingBudget {
  /** Largest Contentful Paint, ms. */
  lcpMs: number;
  /** Cumulative Layout Shift, unitless. */
  cls: number;
  /** Total Blocking Time, ms. */
  tbtMs: number;
}

/** T44: median of 3 runs per page and viewport. */
export const TIMING_BUDGET: Record<SiteViewport, TimingBudget> = {
  // 1440x900, no throttle.
  desktop: { lcpMs: 1200, cls: 0.02, tbtMs: 100 },
  // 390x844, 4x CPU throttle, 10 Mb/s down, 40 ms latency.
  phone: { lcpMs: 2500, cls: 0.05, tbtMs: 300 },
};

/** T44: Event Timing `duration` of the first `.menu-btn` click at the phone viewport, ms. */
export const MENU_TAP_DURATION_MS = 200;

export const VIEWPORTS: Record<SiteViewport, { width: number; height: number }> = {
  desktop: { width: 1440, height: 900 },
  phone: { width: 390, height: 844 },
};

/** Phone network and CPU conditions (CDP): 10 Mb/s down, 40 ms latency, 4x CPU slowdown. */
export const PHONE_THROTTLE = {
  cpuRate: 4,
  downloadBytesPerSec: (10 * 1000 * 1000) / 8,
  uploadBytesPerSec: (10 * 1000 * 1000) / 8,
  latencyMs: 40,
} as const;

/** Runs per page and viewport; the median is what is compared. */
export const SPEED_RUNS = 3;
