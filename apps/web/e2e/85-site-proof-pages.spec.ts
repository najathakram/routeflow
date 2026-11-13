/**
 * Site proof, the pages (spec 85), project "site-proof".
 * Plan: .claude/pipeline/2026-11-13-site-wheel-print/README.md, rows T1, T2, T9, T12.
 *
 *   T1  R1   print shows the whole page, and screen is restored afterwards
 *   T2  R2   headings below the fold are not waiting for a scroll to appear
 *   T9  R10  no heading sits on top of the next block while the page rises into view
 *   T12 R12  nothing is lost: links, buttons, controls, anchors and the 15 tiles (parity diff)
 *
 * Signed out. The post-deploy job runs this project, so every cell here is green on master
 * (review S9). Nothing is marked as an expected failure; the one clause not yet asserted, T1's
 * wheel clause, is gated by WHEEL_PRINT_CLAUSE with its owner (WP1.2, B1321) in the report. Each
 * test gathers every problem and asserts once, with the page and size in every line.
 *
 * T12 baseline: run once against master's build, `SITE_PARITY_WRITE=1`, then commit the JSON.
 */
import * as fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import {
  PUBLIC_ROUTES,
  blockAnalytics,
  contrast,
  frames,
  installProbes,
  nonEmpty,
  sizeName,
  waitForWheel,
  type SiteProbe,
} from "./helpers/site-proof";
import {
  PARITY_BASELINE_PATH,
  PARITY_SIZES,
  captureParity,
  diffParity,
  parityKey,
  readChanges,
  readParityFile,
  type ParityMap,
} from "./helpers/site-parity";

test.describe.configure({ mode: "parallel" });

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

type Size = { w: number; h: number };

/** Load a public route at a size with the probes in place; the home page also waits for its wheel. */
async function openRoute(page: Page, route: string, size: Size): Promise<void> {
  await installProbes(page);
  await page.setViewportSize({ width: size.w, height: size.h });
  await page.goto(route, { waitUntil: "load" });
  if (route === "/") await waitForWheel(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await frames(page, 2);
}

const trigCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const ST = (window as unknown as { ScrollTrigger?: { getAll(): unknown[] } }).ScrollTrigger;
    return ST ? ST.getAll().length : 0;
  });

// ─── T1 — print shows the whole page ────────────────────────────────────────

const PRINT_SIZES: Size[] = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
];

/**
 * T1's wheel clause (R1: "the wheel as its still picture") is WP1.2's (B1321): the wheel's own
 * matchMedia gains a print branch that puts the still back and shows the words the wheel drives.
 * Until WP1.2 sets this to true, the clause is skipped with that reason in the report: the
 * `.rfw` still/canvas checks, and the effective (ancestor) opacity, visibility and sticky sweeps over
 * everything inside WHEEL_SCOPE (the wheel and the words column it is mounted with, `copy: ".hx-copy"`).
 * Inside `.hx-copy` (outside `.rfw`) each element's own computed opacity and visibility stay asserted.
 */
const WHEEL_PRINT_CLAUSE = false;
const WHEEL_SCOPE = ".rfw, .hx-copy";

test.describe("T1 R1 print shows the whole page", () => {
  for (const route of PUBLIC_ROUTES) {
    for (const size of PRINT_SIZES) {
      test(`T1 R1 print shows the whole page @${route} ${sizeName(size)}`, async ({
        page,
        context,
      }) => {
        test.setTimeout(120_000);
        const tag = `${route} ${sizeName(size)}`;
        const problems: string[] = [];
        await openRoute(page, route, size);
        const skipWheel = !WHEEL_PRINT_CLAUSE && (await page.locator(WHEEL_SCOPE).count()) > 0;
        if (skipWheel) {
          test.info().annotations.push({
            type: "skipped-clause",
            description: `T1 wheel clause on ${tag}: the wheel's still in print and the words it drives are WP1.2's (B1321)`,
          });
        }

        // mid-page, so a scroll-driven page has had to move
        const y = await page.evaluate(() => {
          const to = Math.max(
            0,
            Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2),
          );
          window.scrollTo({ top: to, behavior: "instant" as ScrollBehavior });
          return to;
        });
        await frames(page, 2);
        const before = await page.evaluate(() => ({
          motion: document.documentElement.classList.contains("js-motion"),
          y: window.scrollY,
        }));

        await page.emulateMedia({ media: "print" });
        await frames(page, 3);

        const print = await page.evaluate(
          ({ skip, scope }) => {
            const sp = (window as unknown as { __sp: SiteProbe }).__sp;
            const probs: string[] = [];
            const some = (list: string[], what: string) => {
              if (list.length)
                probs.push(`${list.length} ${what}: ${list.slice(0, 6).join(" | ")}`);
            };
            if (document.documentElement.classList.contains("js-motion"))
              probs.push("html still has js-motion in print");
            // the gated wheel clause: its elements are left out of the sweeps until WP1.2
            const outOfScope = (e: Element) => skip && !!e.closest(scope);
            // only an empty fixed layer (a toast viewport: no text, no child elements) prints nothing (WP0 HF5)
            const emptyLayer = (e: Element) =>
              !(e.textContent || "").trim() && e.children.length === 0;

            const text = Array.from(document.querySelectorAll("h1, h2, h3, p, li, a")).filter((e) =>
              sp.rendered(e),
            );
            const swept = text.filter((e) => !outOfScope(e));
            some(
              swept.filter((e) => sp.eff(e) < 0.99).map(sp.name),
              "elements are not at opacity 1 in print",
            );
            some(
              swept.filter((e) => getComputedStyle(e).visibility !== "visible").map(sp.name),
              "elements are hidden in print",
            );
            some(
              Array.from(document.querySelectorAll("body *"))
                .filter(
                  (e) =>
                    sp.rendered(e) &&
                    !outOfScope(e) &&
                    /^(sticky|fixed)$/.test(getComputedStyle(e).position) &&
                    !emptyLayer(e),
                )
                .map(sp.name),
              "elements are sticky or fixed in print",
            );

            // inside .hx-copy each element's OWN opacity and visibility are still checked (the page's own motion must
            // not leave a word faded); only the ancestors' effect there, and everything inside .rfw, wait for WP1.2
            const own = skip
              ? text.filter((e) => !!e.closest(".hx-copy") && !e.closest(".rfw"))
              : [];
            some(
              own.filter((e) => parseFloat(getComputedStyle(e).opacity) < 0.99).map(sp.name),
              "elements in .hx-copy have their own opacity under 1 in print",
            );
            some(
              own.filter((e) => getComputedStyle(e).visibility !== "visible").map(sp.name),
              "elements in .hx-copy are hidden in print",
            );

            const wheel = skip ? null : document.querySelector(".rfw");
            if (wheel) {
              if (!wheel.classList.contains("rfw--static"))
                probs.push(".rfw lacks rfw--static in print");
              const svg = Array.from(wheel.querySelectorAll("svg")).filter((e) =>
                sp.shown(e, 0.99),
              );
              if (!svg.length) probs.push(".rfw shows no svg in print");
              const cv = Array.from(wheel.querySelectorAll("canvas")).filter((e) =>
                sp.shown(e, 0.05),
              );
              if (cv.length) probs.push(".rfw still shows a canvas in print");
            }

            // first-screen text: foreground and the first opaque background above it
            const pairs: { name: string; fg: string; bg: string }[] = [];
            for (const e of text) {
              const top = e.getBoundingClientRect().top + window.scrollY;
              if (top >= window.innerHeight) continue;
              const own = Array.from(e.childNodes).some(
                (n) => n.nodeType === 3 && (n.textContent || "").trim(),
              );
              if (!own) continue;
              let bg = "rgb(255, 255, 255)";
              let known = true;
              for (let n: Element | null = e; n; n = n.parentElement) {
                const s = getComputedStyle(n);
                if (s.backgroundImage !== "none") {
                  known = false;
                  break;
                }
                const m = s.backgroundColor.match(/[\d.]+/g);
                if (
                  m &&
                  (m.length < 4 || parseFloat(m[3]) > 0.9) &&
                  s.backgroundColor !== "rgba(0, 0, 0, 0)"
                ) {
                  bg = s.backgroundColor;
                  break;
                }
              }
              if (known) pairs.push({ name: sp.name(e), fg: getComputedStyle(e).color, bg });
            }

            // no heading's box on top of the next sibling's
            const clash: string[] = [];
            for (const h of Array.from(document.querySelectorAll("h1, h2, h3")).filter(
              (e) => sp.rendered(e) && !outOfScope(e),
            )) {
              const nx = h.nextElementSibling;
              if (!nx || !sp.rendered(nx)) continue;
              const a = h.getBoundingClientRect();
              const b = nx.getBoundingClientRect();
              if (
                a.left < b.right - 1 &&
                b.left < a.right - 1 &&
                a.top < b.bottom - 1 &&
                b.top < a.bottom - 1
              ) {
                clash.push(`${sp.name(h)} over ${sp.name(nx)}`);
              }
            }
            some(clash, "headings sit on their next sibling in print");
            return { probs, pairs };
          },
          { skip: skipWheel, scope: WHEEL_SCOPE },
        );
        problems.push(...print.probs.map((p) => `${tag}: ${p}`));
        nonEmpty(print.pairs, `first-screen text elements on ${tag}`);
        for (const p of print.pairs) {
          try {
            const c = contrast(p.fg, p.bg);
            if (c < 4.5)
              problems.push(
                `${tag}: first-screen text ${p.name} has contrast ${c.toFixed(2)} (need 4.5)`,
              );
          } catch {
            // a colour the parser cannot read is not a pass or a fail; the contrast walk of T16 covers it
          }
        }

        // back to screen: motion as it was, same place, triggers equal to a fresh load
        await page.emulateMedia({ media: "screen" });
        await frames(page, 3);
        const after = await page.evaluate(() => ({
          motion: document.documentElement.classList.contains("js-motion"),
          y: window.scrollY,
        }));
        if (after.motion !== before.motion)
          problems.push(
            `${tag}: js-motion was ${before.motion} before print, ${after.motion} after`,
          );
        if (Math.abs(after.y - before.y) > 1)
          problems.push(`${tag}: scrollY ${before.y} before print, ${after.y} after`);
        const restored = await trigCount(page);

        const fresh = await context.newPage();
        await fresh.setViewportSize({ width: size.w, height: size.h });
        await fresh.goto(route, { waitUntil: "load" });
        if (route === "/") await waitForWheel(fresh);
        await fresh.evaluate(
          (to) => window.scrollTo({ top: to, behavior: "instant" as ScrollBehavior }),
          y,
        );
        await frames(fresh, 3);
        const base = await trigCount(fresh);
        await fresh.close();
        if (restored !== base)
          problems.push(
            `${tag}: ${restored} ScrollTriggers after print, ${base} on a fresh load at the same place`,
          );
        if (route === "/" && restored === 0)
          problems.push(`${tag}: no ScrollTriggers at all after print`);

        expect(problems, `T1 ${tag}: everything wrong in print and after it`).toEqual([]);
      });
    }
  }
});

// ─── T2 — headings are not waiting for a scroll ─────────────────────────────

test.describe("T2 R2 headings show without a scroll", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`T2 R2 headings show without a scroll @${route}`, async ({ page }) => {
      test.setTimeout(90_000);
      await openRoute(page, route, { w: 1440, h: 900 });
      const scan = () =>
        page.evaluate(() => {
          const sp = (window as unknown as { __sp: SiteProbe }).__sp;
          const heads = Array.from(document.querySelectorAll("h1, h2")).filter(
            (e) => !e.closest(".rfw-live") && sp.rendered(e),
          );
          return {
            checked: heads.length,
            hidden: heads.filter((e) => !sp.shown(e, 0.99)).map(sp.name),
          };
        });
      const first = await scan();
      expect(
        first.checked,
        `T2 ${route}: h1/h2 outside the live wheel that were checked (need 3)`,
      ).toBeGreaterThanOrEqual(3);
      // a first-load fade may still be running; a heading held at opacity 0 never gets there
      await expect
        .poll(async () => (await scan()).hidden, {
          timeout: 6_000,
          message: `T2 ${route} 1440x900, never scrolled: headings not fully shown`,
        })
        .toEqual([]);
    });
  }
});

// ─── T9 — no heading on top of the next block during the rise ───────────────
// L-377: the WP0 version measured only after the headings settled and only pairs with BOTH boxes
// in the window, so it passed on master with the bug present (WP0 HF3): the phone rise holds each
// unscrolled h2 22 px low over a 12 px gap, and while a heading rises its next block is still
// below the window. R10 says "at any scroll position", so each step now reads on the first frame
// after the scroll and again once settled, every h2 still to come (rising in the window or held
// below it) against its next block, wherever that block is.

const T9_PAGES = ["/", "/product", "/pricing"] as const;
const T9_SIZES: Size[] = [
  { w: 390, h: 844 },
  { w: 320, h: 568 },
];

test.describe("T9 R10 no heading overlaps the next block while rising", () => {
  for (const route of T9_PAGES) {
    for (const size of T9_SIZES) {
      test(`T9 R10 no heading overlaps the next block while rising @${route} ${sizeName(size)}`, async ({
        page,
      }) => {
        test.setTimeout(300_000);
        const tag = `${route} ${sizeName(size)}`;
        await openRoute(page, route, size);
        const max = await page.evaluate(
          () => document.documentElement.scrollHeight - window.innerHeight,
        );
        const step = Math.round(size.h * 0.1);
        // Worst overlap per heading, so a held heading is reported once with its largest value.
        const worst = new Map<string, { by: number; y: number; where: string }>();
        let pairs = 0;
        const measure = async (to: number) => {
          const r = await page.evaluate(() => {
            const sp = (window as unknown as { __sp: SiteProbe }).__sp;
            let n = 0;
            const bad: { pair: string; by: number; where: string }[] = [];
            for (const h of Array.from(document.querySelectorAll("h2"))) {
              const nx = h.nextElementSibling;
              if (!nx || !sp.shown(h, 0.05) || !sp.shown(nx, 0.05)) continue;
              const a = h.getBoundingClientRect();
              const b = nx.getBoundingClientRect();
              // every heading still to come: in the window (rising) or below it (held before its
              // rise). The next block may be anywhere; it is below the window while its heading rises.
              if (a.bottom <= 0) continue;
              n++;
              if (
                a.left < b.right - 1 &&
                b.left < a.right - 1 &&
                a.top < b.bottom - 1 &&
                b.top < a.bottom - 1
              ) {
                bad.push({
                  pair: `${sp.name(h)} over ${sp.name(nx)}`,
                  by: Math.round(Math.min(a.bottom - b.top, b.bottom - a.top)),
                  where: a.top < window.innerHeight ? "in the window" : "below the window",
                });
              }
            }
            return { n, bad };
          });
          pairs += r.n;
          for (const b of r.bad) {
            const w = worst.get(b.pair);
            if (!w || b.by > w.by) worst.set(b.pair, { by: b.by, y: to, where: b.where });
          }
        };
        for (let y = 0; ; y += step) {
          const to = Math.min(y, max);
          await page.evaluate(
            (v) => window.scrollTo({ top: v, behavior: "instant" as ScrollBehavior }),
            to,
          );
          // during the rise: the first frame after the scroll, no settle wait (L-377, WP0 HF3)
          await frames(page, 1);
          await measure(to);
          // and again once the headings and their neighbours stop moving (equal across two frames)
          await page
            .waitForFunction(
              () =>
                new Promise<boolean>((done) => {
                  const snap = () =>
                    Array.from(document.querySelectorAll("h2"))
                      .flatMap((h) => [h, h.nextElementSibling])
                      .filter((e): e is Element => !!e)
                      .map((e) => {
                        const r = e.getBoundingClientRect();
                        return `${r.top.toFixed(1)},${r.bottom.toFixed(1)}`;
                      })
                      .join(";");
                  const a = snap();
                  requestAnimationFrame(() => requestAnimationFrame(() => done(snap() === a)));
                }),
              undefined,
              { timeout: 4_000, polling: 100 },
            )
            .catch(() => undefined); // still moving after 4 s: measure what is on screen, that is the finding
          await measure(to);
          if (to >= max) break;
        }
        if (!pairs) throw new Error(`T9 ${tag}: swept no heading and next-block pairs`);
        const problems = [...worst].map(
          ([pair, w]) => `${tag}: ${pair} by ${w.by}px (scrollY ${w.y}, heading ${w.where})`,
        );
        expect(problems, `T9 ${tag}: headings on their next block during the rise`).toEqual([]);
      });
    }
  }
});

// ─── T12 — nothing is lost ──────────────────────────────────────────────────

test.describe("T12 R12 nothing is lost", () => {
  // One serial test: the baseline is a single file, so the capture must be one writer.
  test("T12 R12 nothing is lost: parity against the baseline from master", async ({ page }) => {
    test.setTimeout(600_000);
    const now: ParityMap = {};
    for (const size of nonEmpty(PARITY_SIZES, "parity sizes")) {
      for (const route of nonEmpty(PUBLIC_ROUTES, "public routes")) {
        await test.step(`capture ${route} ${size.cls}`, async () => {
          await openRoute(page, route, size);
          const rows = await captureParity(page);
          nonEmpty(rows, `reachable items on ${route} ${size.cls}`);
          if (route === "/") {
            const tiles = rows.filter((r) => r.startsWith("tile|")).length;
            expect(tiles, `T12 / ${size.cls}: wheel tile buttons captured (need 15)`).toBe(15);
          }
          now[parityKey(route, size.cls)] = rows;
        });
      }
    }

    if (process.env.SITE_PARITY_WRITE === "1") {
      fs.writeFileSync(
        PARITY_BASELINE_PATH,
        `${JSON.stringify({ version: 1, pages: now }, null, 2)}\n`,
      );
      return;
    }

    const base = readParityFile(PARITY_BASELINE_PATH);
    nonEmpty(Object.keys(base.pages), "pages in the parity baseline");
    const diff = diffParity(base.pages, now, readChanges());
    expect(diff, "T12: differences from the baseline that no changes row explains").toEqual([]);
  });
});
