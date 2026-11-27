/**
 * Site proof, the story ring (spec 84), project "site-proof-wheel" (local lane only).
 * The home page's opening is one pinned story with one ring (`#story`, `.stx-svg`, `.rg-*`).
 * The canvas wheel this spec used to prove (T3-T10: fit, pose, painted names, snap, resize) is gone;
 * the facts that still have a subject are kept and pointed at the ring.
 *
 *   T0  the pill and the mess are hidden before any scroll (no black pill, no grey shape)
 *   T3  the ring fits inside the window and the page never scrolls sideways, at every checkpoint
 *   T4  the ring turns through Orders, Delivery, Invoices and Payments, in that order
 *   T5  the parts are named in words (the 15-item list), not painted into a picture
 *   T6  a heading is always up while the story is pinned
 *   T7  nothing empty after the story: the next band follows the pin
 *   T8  the ring's fills are the palette's, never black or the default
 *
 * Signed out. Nothing is skipped or marked as an expected failure.
 */
import { test, expect, type Page } from "@playwright/test";
import { blockAnalytics, collectPageErrors } from "./helpers/site-proof";

test.describe.configure({ mode: "parallel" });

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

const pageErrors = new Map<string, string[]>();
test.beforeEach(async ({ page }, info) => {
  pageErrors.set(info.testId, collectPageErrors(page));
});
test.afterEach(async ({}, info) => {
  const errors = pageErrors.get(info.testId) ?? [];
  pageErrors.delete(info.testId);
  expect(errors, `uncaught page errors in "${info.title}"`).toEqual([]);
});

const VIEWS = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const;

type Geo = { top: number; run: number };

async function open(page: Page, w: number, h: number): Promise<Geo> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/");
  await page.waitForFunction(() => document.documentElement.classList.contains("js-motion"));
  await page.waitForFunction(() => !!document.querySelector("#story .ringO"));
  await page.waitForTimeout(800);
  return page.evaluate((vh) => {
    const s = document.getElementById("story") as HTMLElement;
    return { top: s.getBoundingClientRect().top + window.scrollY, run: s.offsetHeight - vh };
  }, h);
}

async function seek(page: Page, geo: Geo, f: number): Promise<void> {
  await page.evaluate((y) => window.scrollTo(0, y), geo.top + geo.run * f);
  // the scrub trails the scroll by half a second
  await page.waitForTimeout(1100);
}

const POINTS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.72, 0.85, 0.98];

for (const { w, h } of VIEWS) {
  test(`T0 the pill and the mess are hidden before any scroll @${w}x${h}`, async ({ page }) => {
    await open(page, w, h);
    const seen = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#story .pill, #story .mess, #story .oshadow")).map(
        (e) => {
          const c = getComputedStyle(e);
          return `${e.getAttribute("class")}: ${c.opacity}/${c.visibility}`;
        },
      ),
    );
    expect(seen.length).toBeGreaterThan(0);
    const shown = seen.filter((s) => !/: 0\//.test(s) && !/\/hidden$/.test(s));
    expect(shown).toEqual([]);
  });

  test(`T3 the ring fits and the page never scrolls sideways @${w}x${h}`, async ({ page }) => {
    const geo = await open(page, w, h);
    const problems: string[] = [];
    for (const f of POINTS) {
      await seek(page, geo, f);
      const m = await page.evaluate(() => {
        const r = (document.querySelector("#story .stx-svg") as SVGElement).getBoundingClientRect();
        return {
          sw: document.documentElement.scrollWidth,
          iw: window.innerWidth,
          left: r.left,
          right: r.right,
        };
      });
      if (m.sw > m.iw) problems.push(`${f}: scrolls sideways (${m.sw} > ${m.iw})`);
      if (m.left < -1 || m.right > m.iw + 1)
        problems.push(
          `${f}: svg outside the window (${Math.round(m.left)}..${Math.round(m.right)})`,
        );
    }
    expect(problems).toEqual([]);
  });

  test(`T4 the ring turns through the four steps in order @${w}x${h}`, async ({ page }) => {
    const geo = await open(page, w, h);
    const rot: number[] = [];
    const steps: string[] = [];
    for (const f of POINTS) {
      await seek(page, geo, f);
      const s = await page.evaluate(() => ({
        ro: Number(
          (
            window as unknown as { gsap: { getProperty: (e: Element, p: string) => number } }
          ).gsap.getProperty(document.querySelector(".ringO") as Element, "rotation"),
        ),
        step: document.querySelector(".stx-steps li.on")?.textContent || "",
      }));
      rot.push(Math.round(s.ro));
      if (s.step && steps[steps.length - 1] !== s.step) steps.push(s.step);
    }
    expect(new Set(rot).size, `rotation by checkpoint: ${rot}`).toBeGreaterThan(3);
    const order = ["Order", "Deliver", "Invoice", "Get paid"].map((n) =>
      steps.findIndex((s) => s.includes(n)),
    );
    expect(order, `steps seen: ${steps}`).not.toContain(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test(`T5 the fifteen parts are named in words @${w}x${h}`, async ({ page }) => {
    await open(page, w, h);
    const names = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#story .stx-parts li > b")).map((b) => b.textContent),
    );
    expect(names).toHaveLength(15);
    expect(new Set(names).size, "each part once").toBe(15);
  });

  test(`T6 a heading is always up while the story is pinned @${w}x${h}`, async ({ page }) => {
    const geo = await open(page, w, h);
    const bare: number[] = [];
    for (const f of POINTS) {
      await seek(page, geo, f);
      const up = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll("#story .stx-cap")).filter(
            (c) => +getComputedStyle(c).opacity > 0.5,
          ).length,
      );
      if (up === 0) bare.push(f);
    }
    expect(bare, "checkpoints with no heading up").toEqual([]);
  });

  test(`T7 nothing empty after the story @${w}x${h}`, async ({ page }) => {
    const geo = await open(page, w, h);
    await page.evaluate((y) => window.scrollTo(0, y), geo.top + geo.run + h * 0.5);
    await page.waitForTimeout(900);
    const next = await page.evaluate(() => {
      const r = (document.getElementById("stores") as HTMLElement).getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
    });
    expect(next.top).toBeLessThan(next.vh);
    expect(next.bottom).toBeGreaterThan(0);
  });

  test(`T8 the ring's fills are the palette's @${w}x${h}`, async ({ page }) => {
    await open(page, w, h);
    const fills = await page.evaluate(() =>
      [".rg-top", ".rg-wall", ".rg-wall.i", ".rg-col", ".hub circle"].map((s) => [
        s,
        getComputedStyle(document.querySelector(s) as Element).fill,
      ]),
    );
    for (const [sel, fill] of fills) {
      expect(fill, sel).not.toBe("rgb(0, 0, 0)");
      expect(fill, sel).not.toBe("none");
    }
  });
}
