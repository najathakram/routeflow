/**
 * Shared probes for the "site-proof" project (specs 84 and 85): the public site, signed out.
 * Plan: .claude/pipeline/2026-11-11-rovio-rebrand/test-plan.md.
 *
 * House rules these helpers enforce:
 *  - A sweep that finds nothing throws; it never passes or skips (L-202).
 *  - No sleeps: wait on the wheel's own scroll progress settling (L-165).
 *  - Select by structure the site already exposes (.rfw, .rfw-b, canvas.rfw-cv), never by a
 *    layout utility class (L-212).
 */
import { expect, type Page, type BrowserContext } from "@playwright/test";

/** The 12 window sizes every layout test walks (test-plan.md §1). */
export const SIZES = [
  { w: 1440, h: 900 },
  { w: 1288, h: 593 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
  { w: 1024, h: 768 },
  { w: 900, h: 600 },
  { w: 768, h: 1024 },
  { w: 844, h: 390 },
  { w: 390, h: 844 },
  { w: 430, h: 932 },
  { w: 360, h: 740 },
  { w: 320, h: 568 },
] as const;

/** Scroll shares of the wheel's range that every wheel test visits (test-plan.md §1). */
export const BEATS = [0, 0.1, 0.2, 0.3, 0.36, 0.45, 0.54, 0.63, 0.72, 0.76, 0.85, 0.93, 1] as const;

/** Every signed-out route the site serves. The static ten come from public/site; the rest are React. */
export const STATIC_ROUTES = [
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
] as const;
export const REACT_ROUTES = ["/privacy", "/terms"] as const;
export const PUBLIC_ROUTES = [...STATIC_ROUTES, ...REACT_ROUTES] as const;

export type Box = { l: number; t: number; r: number; b: number };

/** Visits from this project are never counted: block the analytics host and the site's counter. */
export async function blockAnalytics(ctx: BrowserContext): Promise<void> {
  await ctx.route(/cloud\.umami\.is|\/site\/analytics\.js/i, (r) => r.abort());
}

/**
 * Counts what the wheel's canvas draws, installed before any page script. Read it back with
 * drawCounts(). text = fillText/strokeText calls; gradient = gradients created; shadow = times a
 * blur above zero was set.
 */
export async function installDrawSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const n = ((window as unknown as { __rfDraw: Record<string, number> }).__rfDraw = {
      text: 0,
      gradient: 0,
      shadow: 0,
    });
    const P = CanvasRenderingContext2D.prototype as unknown as Record<string, unknown>;
    for (const m of ["fillText", "strokeText"]) {
      const o = P[m] as (...a: unknown[]) => unknown;
      P[m] = function (this: unknown, ...a: unknown[]) {
        n.text++;
        return o.apply(this, a);
      };
    }
    for (const m of ["createRadialGradient", "createLinearGradient"]) {
      const o = P[m] as (...a: unknown[]) => unknown;
      P[m] = function (this: unknown, ...a: unknown[]) {
        n.gradient++;
        return o.apply(this, a);
      };
    }
    const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, "shadowBlur");
    if (d && d.get && d.set) {
      Object.defineProperty(CanvasRenderingContext2D.prototype, "shadowBlur", {
        configurable: true,
        get: d.get,
        set(v: number) {
          if (v > 0) n.shadow++;
          d.set!.call(this, v);
        },
      });
    }
  });
}

export async function drawCounts(
  page: Page,
): Promise<{ text: number; gradient: number; shadow: number }> {
  return page.evaluate(
    () =>
      (window as unknown as { __rfDraw: { text: number; gradient: number; shadow: number } })
        .__rfDraw,
  );
}

/** Waits for the live wheel to be built. Throws if the page has no wheel or it never goes live. */
export async function waitForWheel(page: Page): Promise<void> {
  await expect(page.locator(".rfw")).toHaveCount(1);
  await page.waitForFunction(
    () => {
      const el = document.querySelector(".rfw") as
        (HTMLElement & { _rfw?: { live?: boolean; trig?: unknown } }) | null;
      return !!el?._rfw?.live && !!el._rfw.trig;
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Scrolls so the wheel's timeline sits at `share` (0..1) of its range, then waits for it to settle. */
export async function scrollWheelTo(page: Page, share: number): Promise<void> {
  await page.evaluate((s) => {
    const inst = (
      document.querySelector(".rfw") as HTMLElement & {
        _rfw: { trig: { start: number; end: number } };
      }
    )._rfw;
    const y = inst.trig.start + (inst.trig.end - inst.trig.start) * s;
    window.scrollTo({ top: Math.round(y), behavior: "instant" as ScrollBehavior });
  }, share);
  await settle(page);
}

/** Waits until the wheel's scrubbed progress is equal across two animation frames (no sleeps). */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((done) => {
        const inst = (
          document.querySelector(".rfw") as
            (HTMLElement & { _rfw?: { T?: { progress(): number } } }) | null
        )?._rfw;
        if (!inst?.T) return done(true);
        const a = inst.T.progress();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => done(Math.abs(inst.T!.progress() - a) < 1e-4)),
        );
      }),
    undefined,
    { timeout: 10_000, polling: 100 },
  );
}

/**
 * The box of what the wheel canvas shows, in window pixels: every pixel that differs from the
 * stage colour at the canvas's top-left corner. Throws when the canvas is blank.
 */
export async function wheelBox(page: Page): Promise<Box> {
  return page.evaluate(() => {
    const cv = document.querySelector<HTMLCanvasElement>("canvas.rfw-cv");
    if (!cv) throw new Error("no wheel canvas on the page");
    const r = cv.getBoundingClientRect();
    const w = cv.width;
    const h = cv.height;
    const ctx = cv.getContext("2d");
    if (!ctx || !w || !h) throw new Error("wheel canvas has no size or context");
    const px = ctx.getImageData(0, 0, w, h).data;
    let l = w;
    let t = h;
    let rt = -1;
    let b = -1;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        if (
          Math.abs(px[i] - px[0]) + Math.abs(px[i + 1] - px[1]) + Math.abs(px[i + 2] - px[2]) >
          24
        ) {
          if (x < l) l = x;
          if (x > rt) rt = x;
          if (y < t) t = y;
          if (y > b) b = y;
        }
      }
    }
    if (rt < 0) throw new Error("wheel canvas is blank");
    const sx = r.width / w;
    const sy = r.height / h;
    return { l: r.left + l * sx, t: r.top + t * sy, r: r.left + rt * sx, b: r.top + b * sy };
  });
}

/** Window-pixel box of an element, or null when it is not rendered. */
export async function boxOf(page: Page, selector: string): Promise<Box | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  }, selector);
}

export const overlaps = (a: Box, b: Box, pad = 0): boolean =>
  a.l < b.r - pad && b.l < a.r - pad && a.t < b.b - pad && b.t < a.b - pad;

export const inside = (a: Box, outer: Box, pad = 1): boolean =>
  a.l >= outer.l - pad && a.t >= outer.t - pad && a.r <= outer.r + pad && a.b <= outer.b + pad;

/** Bottom edge of the sticky site header in window pixels (0 when there is none). */
export async function headerBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const h = document.querySelector(".site-header");
    return h ? Math.max(0, h.getBoundingClientRect().bottom) : 0;
  });
}

/** Throws when a sweep found nothing to check (L-202). */
export function nonEmpty<T>(items: readonly T[], what: string): readonly T[] {
  if (!items.length) throw new Error(`site-proof: found no ${what} to check`);
  return items;
}

/** WCAG relative-luminance contrast of two CSS rgb()/rgba() colours. */
export function contrast(fg: string, bg: string): number {
  const lum = (c: string) => {
    const m = c.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) throw new Error(`unreadable colour ${c}`);
    const [r, g, b] = m.slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
