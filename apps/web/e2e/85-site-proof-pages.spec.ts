/**
 * Site proof, the pages (spec 85), project "site-proof".
 * Plan: .claude/pipeline/2026-11-13-site-wheel-print/README.md, rows T1, T2, T9, T12.
 *
 *   T1  R1   print shows the whole page, and screen is restored afterwards
 *   T2  R2   headings below the fold are not waiting for a scroll to appear
 *   T9  R10  no heading sits on top of the next block while the page rises into view
 *   T16 R16  button and link colours, the focus ring on every band, text contrast
 *   T18c R18 every element's box-shadow is none or the ring (one walk, helpers/site-colour-walk.ts)
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
import {
  WALK_ROUTES,
  WALK_SIZES,
  judgeColours,
  judgeShadows,
  openForWalk,
  readWalk,
} from "./helpers/site-colour-walk";

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
 * The clause is on (WP1.2 owns it now): the
 * `.rfw` still/canvas checks, and the effective (ancestor) opacity, visibility and sticky sweeps over
 * everything inside WHEEL_SCOPE (the wheel and the words column it is mounted with, `copy: ".hx-copy"`).
 * Inside `.hx-copy` (outside `.rfw`) each element's own computed opacity and visibility stay asserted.
 */
const WHEEL_PRINT_CLAUSE = true;
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

            // inside .hx-copy every element is checked (not only text tags), from the element up to but not including .hx-copy
            // itself (the wheel hides that column until WP1.2): the page's own motion must not leave anything faded or hidden
            const copyRoot = document.querySelector(".hx-copy");
            const inner =
              skip && copyRoot
                ? Array.from(copyRoot.querySelectorAll("*")).filter(
                    (e) => !e.closest(".rfw") && sp.rendered(e),
                  )
                : [];
            const chain = (e: Element) => {
              const out: Element[] = [];
              for (let n: Element | null = e; n && n !== copyRoot; n = n.parentElement) out.push(n);
              return out;
            };
            some(
              inner
                .filter(
                  (e) =>
                    chain(e).reduce((a, n) => a * parseFloat(getComputedStyle(n).opacity), 1) <
                    0.99,
                )
                .map(sp.name),
              "elements in .hx-copy are not at opacity 1 in print",
            );
            some(
              inner
                .filter((e) =>
                  chain(e).some((n) => {
                    // visibility inherits: a node hid itself only if it is hidden while its parent (below .hx-copy) is visible
                    const up = n.parentElement;
                    if (!up || up === copyRoot) return false;
                    return (
                      getComputedStyle(n).visibility !== "visible" &&
                      getComputedStyle(up).visibility === "visible"
                    );
                  }),
                )
                .map(sp.name),
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

// A section reached through a ScrollTrigger refresh (a load, an anchor arrival, a print return) does not play: its animation never
// starts, so nothing may have changed its text or hidden it at build time. It shows the figures of the served page, fully visible,
// within three frames. (A plain scroll plays the animation and ends right too; only the refresh path leaves the build-time state.)
const JUMP_SELECTORS = [".sl-tiers .tier", ".ct-vis", ".uc-i"] as const;

test.describe("T2 R2 a section reached through a refresh shows its final figures", () => {
  for (const size of PRINT_SIZES) {
    test(`T2 R2 a section reached through a refresh shows its final figures @/ ${sizeName(size)}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await openRoute(page, "/", size);
      const norm = (t: string | null) => (t || "").replace(/\s+/g, " ").trim();
      let checked = 0;
      const wrong: string[] = [];
      for (const sel of JUMP_SELECTORS) {
        const count = await page.locator(sel).count();
        for (let i = 0; i < count; i++) {
          const rendered = await page.evaluate(
            ([q, k]) =>
              document.querySelectorAll(q as string)[k as number].getClientRects().length > 0,
            [sel, i],
          );
          if (!rendered) continue;
          // one evaluate: the jump and the refresh, so the section's trigger is passed inside the refresh
          await page.evaluate(
            ([q, k]) => {
              const el = document.querySelectorAll(q as string)[k as number];
              const r = el.getBoundingClientRect();
              const top = Math.max(0, r.top + window.scrollY - (window.innerHeight - r.height) / 2);
              window.scrollTo({ top, behavior: "instant" });
              (window as unknown as { ScrollTrigger: { refresh(): void } }).ScrollTrigger.refresh();
            },
            [sel, i],
          );
          await frames(page, 3);
          const got = await page.evaluate(
            async ([q, k]) => {
              const html = await (await fetch(location.pathname)).text();
              const served = new DOMParser().parseFromString(html, "text/html");
              const live = document.querySelectorAll(q as string)[k as number];
              const src = served.querySelectorAll(q as string)[k as number];
              let opacity = 1;
              for (let n: Element | null = live; n; n = n.parentElement)
                opacity *= parseFloat(getComputedStyle(n).opacity);
              return { live: live.textContent, src: src ? src.textContent : null, opacity };
            },
            [sel, i],
          );
          checked++;
          if (norm(got.live) !== norm(got.src))
            wrong.push(
              `${sel}[${i}] shows "${norm(got.live).slice(0, 60)}" not "${norm(got.src).slice(0, 60)}"`,
            );
          if (got.opacity < 0.99)
            wrong.push(`${sel}[${i}] is at opacity ${got.opacity.toFixed(2)}`);
        }
      }
      if (!checked)
        throw new Error("T2 R2 refresh: none of .sl-tiers .tier, .ct-vis, .uc-i was rendered");
      expect(wrong, `T2 ${sizeName(size)}: figures differ from the served page`).toEqual([]);
    });
  }
});

// A section reached at rest (a load at its anchor) counts as played: scrolled away from and back to with real scroll steps, its
// timeline must not play again (the content would blink to opacity 0 and the counted sums would count up from their start).
// The section is #counter: its counter window (.ct-vis) is driven by a `go` timeline and carries counted sums.
test("T2 R2 a section reached at rest does not replay @/#counter 1440x900", async ({ page }) => {
  test.setTimeout(180_000);
  await installProbes(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#counter", { waitUntil: "load" });
  await waitForWheel(page);
  await frames(page, 30);
  // Precondition: this cell proves nothing unless #counter was reached AT REST on load. If the anchor landing ever made the
  // section play, it would be mid-play or already played by a scroll update, and the replay check below would pass for the wrong
  // reason. So before any scrolling its .ct-vis must be fully opaque and read exactly as the served page does.
  const atRest = await page.evaluate(async () => {
    const norm = (t: string | null) => (t || "").replace(/\s+/g, " ").trim();
    const html = await (await fetch("/")).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const src = doc.querySelector("#counter .ct-vis");
    const live = document.querySelector("#counter .ct-vis");
    if (!live || !src) return null;
    let opacity = 1;
    for (let n: Element | null = live; n; n = n.parentElement)
      opacity *= parseFloat(getComputedStyle(n).opacity);
    return { opacity, live: norm(live.textContent), src: norm(src.textContent) };
  });
  if (!atRest) throw new Error("T2 R2 replay: no #counter .ct-vis on load");
  expect(atRest.opacity, "#counter .ct-vis opacity on load at the anchor").toBeGreaterThanOrEqual(
    0.99,
  );
  expect(atRest.live, "#counter .ct-vis text on load at the anchor").toBe(atRest.src);
  // everything else is reached once, by a plain jump, and left to settle
  await page.evaluate(() =>
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }),
  );
  await frames(page, 150);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await frames(page, 60);
  const served = await page.evaluate(async () => {
    const html = await (await fetch("/")).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll(".ct-vis")).map((e) =>
      (e.textContent || "").replace(/\s+/g, " ").trim(),
    );
  });
  if (!served.length) throw new Error("T2 R2 replay: no .ct-vis in the served page");
  await page.evaluate((finals) => {
    const w = window as unknown as { __rp: { minOpacity: number; bad: string[]; frames: number } };
    w.__rp = { minOpacity: 1, bad: [], frames: 0 };
    const tick = () => {
      w.__rp.frames++;
      Array.from(document.querySelectorAll(".ct-vis")).forEach((e, i) => {
        let o = 1;
        for (let n: Element | null = e; n; n = n.parentElement)
          o *= parseFloat(getComputedStyle(n).opacity);
        w.__rp.minOpacity = Math.min(w.__rp.minOpacity, o);
        const text = (e.textContent || "").replace(/\s+/g, " ").trim();
        if (text !== finals[i] && w.__rp.bad.length < 4)
          w.__rp.bad.push(`.ct-vis[${i}] reads "${text.slice(0, 50)}"`);
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, served);
  // back down to the section with real scroll steps
  const target = await page.evaluate(
    () => document.querySelector("#counter")!.getBoundingClientRect().top + window.scrollY,
  );
  for (let y = 0; y < target + 600; y += 400) {
    await page.mouse.wheel(0, 400);
    await frames(page, 2);
  }
  await frames(page, 90);
  const got = await page.evaluate(
    () =>
      (window as unknown as { __rp: { minOpacity: number; bad: string[]; frames: number } }).__rp,
  );
  expect(got.frames, "T2 replay: the probe ran").toBeGreaterThan(30);
  expect(got.bad, "T2 replay: figures read other than the served page").toEqual([]);
  expect(got.minOpacity, "T2 replay: the section blinked").toBeGreaterThanOrEqual(0.99);
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

// ─── T16 + T18c — one colour walk over the 17 signed-out pages ─────────────────

/** A band the focus ring can sit on, and a page that must show it: a missing band is a red, not a skip. */
const RING_BANDS: Record<string, string> = {
  "/": ".end",
  "/landing": ".price",
  "/pricing": ".pcard.featured",
};

/** Does a band label (tag#id.class.class) carry every class of a simple selector like .pcard.featured? */
const bandHas = (label: string, sel: string): boolean =>
  sel
    .split(".")
    .filter(Boolean)
    .every((c) => label.includes(`.${c}`));

test.describe("T16 T18c colour walk", () => {
  test("the walk covers 17 pages", () => {
    expect(new Set(WALK_ROUTES).size).toBe(17);
    expect(WALK_ROUTES).toHaveLength(17);
  });

  for (const route of nonEmpty(WALK_ROUTES, "walk routes")) {
    for (const size of WALK_SIZES) {
      test(`T16 T18c colour walk ${route} ${sizeName(size)}`, async ({ page }) => {
        test.setTimeout(240_000);
        const label = `${route} ${sizeName(size)}`;
        await openForWalk(page, route, size);
        const walk = await readWalk(page, route, size);
        const { problems, report } = judgeColours(walk, label);
        await test.info().attach("T16 focusable table", {
          body: report.join(String.fromCharCode(10)),
          contentType: "text/plain",
        });
        for (const line of report)
          test.info().annotations.push({
            type: "focus-ring",
            description: `${route} ${sizeName(size)} ${line}`,
          });
        const band = RING_BANDS[route];
        if (band)
          expect(
            walk.rings.filter((r) => r.bands.some((b) => bandHas(b, band))).length,
            `T16 ${route} ${sizeName(size)}: focusable elements measured inside ${band}`,
          ).toBeGreaterThan(0);
        expect.soft(problems, `T16 ${route} ${sizeName(size)}`).toEqual([]);
        expect.soft(judgeShadows(walk), `T18c ${route} ${sizeName(size)}`).toEqual([]);
      });
    }
  }
});
