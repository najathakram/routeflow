/**
 * Type and alignment polish on the public site (T49-T53), project "site-type-alignment".
 * Plan: .claude/pipeline/2026-11-11-rovio-rebrand/ux-ledger-p12-p16.md. Signed out, desktop Chrome,
 * against a running stack (baseURL as in the other site specs).
 *
 * Which lane fixes which id, and in which wave:
 *   T49  P12  signup terms line          lane 2.6a (front door)        wave 1b  app/(auth)/signup/page.tsx
 *   T50  P13  pricing eyebrow pill       lane 2.1b (site css)          wave 2   css/site.css, css/mobile.css
 *   T51  P14  plan-table header baseline lane 2.1b (site css)          wave 2   css/site.css
 *   T52  P15  product headline last line lane 2.1b then 2.3-inner      wave 2 (.nb in site.css), wave 3 (product.html)
 *   T53  P16  product card top / eyebrow lane 2.1a (colour css)        wave 1b  css/product.css
 *
 * Each test is written to fail on the code as it stood before those lanes. Each gathers every
 * problem and asserts once. Last-line word counts come from Range client rects, never from
 * guessing at the wrap.
 */
import { test, expect, type Page } from "@playwright/test";
import { blockAnalytics, rectOf } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

async function open(page: Page, route: string, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(route, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
}

/** Words on the last rendered line of the first element matching `sel`, the line count, and text-align. */
async function lastLine(
  page: Page,
  sel: string,
): Promise<{ lines: number; lastWords: string[]; align: string }> {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`no element for ${s}`);
    const words: { text: string; bottom: number }[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? "";
      const re = /\S+/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (!/[\p{L}\p{N}]/u.test(m[0])) continue; // punctuation-only token is not a word
        const r = document.createRange();
        r.setStart(n, m.index);
        r.setEnd(n, m.index + m[0].length);
        const rects = r.getClientRects();
        if (!rects.length) continue;
        words.push({ text: m[0], bottom: Math.round(rects[rects.length - 1].bottom) });
      }
    }
    if (!words.length) throw new Error(`no words in ${s}`);
    // Group into lines with a 2px tolerance so a sub-pixel split cannot add a phantom line.
    const bottoms: number[] = [];
    for (const b of words.map((w) => w.bottom).sort((x, y) => x - y)) {
      if (!bottoms.length || b - bottoms[bottoms.length - 1] > 2) bottoms.push(b);
    }
    const last = bottoms[bottoms.length - 1];
    return {
      lines: bottoms.length,
      lastWords: words.filter((w) => Math.abs(w.bottom - last) <= 2).map((w) => w.text),
      align: getComputedStyle(el).textAlign,
    };
  }, sel);
}

test("P12 signup terms line left-aligned, no lone last word", async ({ page }) => {
  await open(page, "/signup", 1440, 900);
  const r = await lastLine(page, "p:has(a[href='/terms']):has(a[href='/privacy'])");
  const problems: string[] = [];
  if (r.align !== "left" && r.align !== "start") problems.push(`text-align is ${r.align}`);
  if (r.lastWords.length < 2) problems.push(`last line holds only "${r.lastWords.join(" ")}"`);
  expect(problems, `/signup terms @1440x900: ${problems.join("; ")}`).toEqual([]);
});

type Pill = { display: string; radius: number; padding: string; font: string; bg: string };

async function eyebrow(page: Page, w: number, h: number): Promise<Pill> {
  await open(page, "/pricing", w, h);
  return page.evaluate(() => {
    const el = document.querySelector(".pg-top .eyebrow");
    if (!el) throw new Error("no .pg-top .eyebrow");
    const s = getComputedStyle(el);
    return {
      display: s.display,
      radius: parseFloat(s.borderTopLeftRadius) || 0,
      padding: s.padding,
      font: s.fontSize,
      bg: s.backgroundColor,
    };
  });
}

test("P13 pricing eyebrow identical at 1440 and 393", async ({ page }) => {
  const wide = await eyebrow(page, 1440, 900);
  const narrow = await eyebrow(page, 393, 844);
  const problems: string[] = [];
  for (const k of ["display", "padding", "font"] as const) {
    if (wide[k] !== narrow[k]) problems.push(`${k}: 1440=${wide[k]} 393=${narrow[k]}`);
  }
  for (const [n, p] of [
    ["1440", wide],
    ["393", narrow],
  ] as const) {
    if (p.radius < 999) problems.push(`${n} border-radius ${p.radius}px, not a pill`);
    if (p.bg === "rgba(0, 0, 0, 0)" || p.bg === "transparent") {
      problems.push(`${n} background-color is ${p.bg}`);
    }
  }
  expect(problems, `/pricing eyebrow: ${problems.join("; ")}`).toEqual([]);
});

test("P14 plan-table headers share a bottom baseline at 393", async ({ page }) => {
  await open(page, "/pricing", 393, 844);
  const bottoms = await page.evaluate(() => {
    const out: { text: string; bottom: number }[] = [];
    for (const th of Array.from(document.querySelectorAll(".pl thead th"))) {
      const s = getComputedStyle(th);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const r = document.createRange();
      r.selectNodeContents(th);
      const rects = Array.from(r.getClientRects()).filter((x) => x.width && x.height);
      if (!rects.length) continue;
      out.push({
        text: (th.textContent ?? "").trim(),
        bottom: Math.max(...rects.map((x) => x.bottom)),
      });
    }
    return out;
  });
  expect(bottoms.length, "visible plan-table header cells at 393").toBe(4);
  const lo = Math.min(...bottoms.map((b) => b.bottom));
  const hi = Math.max(...bottoms.map((b) => b.bottom));
  expect(
    hi - lo,
    `header text bottoms differ by ${(hi - lo).toFixed(1)}px: ${JSON.stringify(bottoms)}`,
  ).toBeLessThanOrEqual(1);
});

test("P15 product headline has no one-word last line at 1440", async ({ page }) => {
  await open(page, "/product", 1440, 900);
  const r = await lastLine(page, "#pd-h");
  const fit = await page.evaluate(() => {
    const el = document.querySelector("#pd-h") as HTMLElement;
    return { sw: el.scrollWidth, cw: el.clientWidth };
  });
  const problems: string[] = [];
  if (r.lines > 2) problems.push(`${r.lines} lines, more than 2`);
  if (r.lastWords.length < 2) problems.push(`last line holds only "${r.lastWords.join(" ")}"`);
  if (fit.sw > fit.cw) problems.push(`headline overflows its column (${fit.sw} > ${fit.cw})`);
  expect(problems, `/product #pd-h @1440x900: ${problems.join("; ")}`).toEqual([]);
});

test("P16 product diagram card top aligns with eyebrow", async ({ page }) => {
  await open(page, "/product", 1440, 900);
  const card = await rectOf(page, ".lp");
  const kick = await rectOf(page, ".pd-copy .kick");
  expect(card, ".lp present").not.toBeNull();
  expect(kick, ".pd-copy .kick present").not.toBeNull();
  const diff = Math.abs(card!.t - kick!.t);
  expect(diff, `card top ${card!.t} vs eyebrow top ${kick!.t}`).toBeLessThanOrEqual(2);
});
