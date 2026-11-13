/**
 * Site proof, the wheel (spec 84), project "site-proof".
 * Plan: .claude/pipeline/2026-11-11-rovio-rebrand/test-plan.md, rows T3-T8.
 *
 *   T3  R3,R4  the wheel fits inside its box, at every size and checkpoint
 *   T4  R5     one pose and one lift weight (the camera's ratios are constant)
 *   T5  R6     names are never painted on the canvas; the legend and the keyboard carry them
 *   T6  R7     the words column is never empty
 *   T7  R8     nothing empty after the wheel
 *   T8  R9     a resize leaves the wheel as a fresh load would
 *
 * Signed out, local stack only (PLAYWRIGHT_BASE_URL=http://localhost:3001). The wheel is re-mounted
 * with snap off so a seek stays where it was put. Known-red cells on master ARE the bug reproduction:
 * nothing here is skipped or marked as an expected failure. Each test gathers every problem it finds
 * and asserts once, so one failure message lists each size and checkpoint that is wrong.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  BEATS,
  SIZES,
  blockAnalytics,
  drawCounts,
  frames,
  headerBottom,
  inside,
  nonEmpty,
  openHomeNoSnap,
  overlaps,
  rectOf,
  scrollWheelTo,
  seekWheel,
  settle,
  shownBoxes,
  sizeName,
  visibleShare,
  waitForArrival,
  waitForWheel,
  wheelBox,
  wheelCam,
  wheelEnd,
  type Box,
  type SiteProbe,
} from "./helpers/site-proof";

test.describe.configure({ mode: "parallel" });

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

type Size = { w: number; h: number };

// The 15 part names, typed once here as the oracle (spec R6): ten in the outer ring, five inside.
const OUTER_NAMES = [
  "Purchases",
  "Supplier bills",
  "Inventory",
  "Orders",
  "Routes",
  "Delivery",
  "Invoices",
  "Payments",
  "Customers",
  "Reports",
];
const INNER_NAMES = [
  "Box or piece",
  "Each buyer’s price",
  "Store ordering",
  "Counter sales",
  "Returns",
];
const ALL_NAMES = [...OUTER_NAMES, ...INNER_NAMES];

// Structural selectors the wheel and the home page already expose.
const WORDS_SEL =
  ".hx-copy h1, .hx-copy p, .hx-copy a, .rfw .rfw-h .rfw-title, .rfw .rfw-h .rfw-sub, .rfw .rfw-t .rfw-eye, .rfw .rfw-t .rfw-title, .rfw .rfw-t .rfw-sub";
const LEGEND_SEL = ".rfw .rfw-keys, .rfw .rfw-keyh";
const HEADING_SEL = ".hx-copy h1, .rfw .rfw-h .rfw-title, .rfw .rfw-t .rfw-title";

const OPEN_SHARES: readonly number[] = [0.36, 0.45];
const STOP_SHARES: readonly number[] = [0.54, 0.63, 0.72];
const f = (n: number) => n.toFixed(3);

// ─── shared predicates (T3, T5, T6, T8 all stand on these) ──────────────────

/** The part of the stage left for the wheel once the words and the legend have taken theirs. */
function freeRect(stage: Box, obstacles: Box[]): Box {
  if (!obstacles.length) return stage;
  const l = Math.min(...obstacles.map((o) => o.l));
  const r = Math.max(...obstacles.map((o) => o.r));
  const sideBySide = r - l < 0.6 * (stage.r - stage.l);
  if (sideBySide) {
    // words (and legend) in a column: the wheel takes everything to the right of it
    return { l: Math.min(stage.r, Math.max(stage.l, r)), t: stage.t, r: stage.r, b: stage.b };
  }
  // stacked: the wheel takes the band between what sits in the upper half and what sits in the lower
  const mid = (stage.t + stage.b) / 2;
  const upper = obstacles.filter((o) => (o.t + o.b) / 2 < mid);
  const lower = obstacles.filter((o) => (o.t + o.b) / 2 >= mid);
  return {
    l: stage.l,
    r: stage.r,
    t: upper.length ? Math.max(stage.t, ...upper.map((o) => o.b)) : stage.t,
    b: lower.length ? Math.min(stage.b, ...lower.map((o) => o.t)) : stage.b,
  };
}

/** T3's predicates at the wheel's current state. `fill` adds the open-wheel fill and centring bands. */
async function fitProblems(page: Page, tag: string, size: Size, fill: boolean): Promise<string[]> {
  const out: string[] = [];
  let box: Box;
  try {
    box = await wheelBox(page);
  } catch (e) {
    return [`${tag}: ${(e as Error).message}`];
  }
  const cv = await rectOf(page, "canvas.rfw-cv");
  if (!cv) return [`${tag}: no wheel canvas`];
  const edges = {
    left: box.l - cv.l,
    top: box.t - cv.t,
    right: cv.r - box.r,
    bottom: cv.b - box.b,
  };
  for (const [side, gap] of Object.entries(edges)) {
    if (gap < 8)
      out.push(
        `${tag}: wheel pixels come within ${gap.toFixed(1)}px of the canvas ${side} edge (need 8)`,
      );
  }
  const hb = await headerBottom(page);
  if (box.t < hb - 1)
    out.push(`${tag}: wheel top ${box.t.toFixed(0)} is under the header (bottom ${hb.toFixed(0)})`);

  const words = await shownBoxes(page, WORDS_SEL);
  const keys = await shownBoxes(page, LEGEND_SEL);
  words.forEach((w, i) => {
    if (overlaps(box, w, 2)) out.push(`${tag}: wheel crosses the words column (text box ${i})`);
  });
  keys.forEach((k, i) => {
    if (overlaps(box, k, 2)) out.push(`${tag}: wheel crosses the legend (list ${i})`);
  });

  if (fill) {
    const stageRaw = (await rectOf(page, ".rfw-tile")) ?? (await rectOf(page, ".rfw-pin"));
    if (!stageRaw) return [...out, `${tag}: no stage (.rfw-tile) to measure against`];
    const stage = { ...stageRaw, t: Math.max(stageRaw.t, hb), b: Math.min(stageRaw.b, size.h) };
    const free = freeRect(stage, [...words, ...keys]);
    const fw = free.r - free.l;
    const fh = free.b - free.t;
    if (fw <= 0 || fh <= 0) return [...out, `${tag}: no free area left for the wheel`];
    const bw = box.r - box.l;
    const bh = box.b - box.t;
    const limiting = Math.max(bw / fw, bh / fh);
    if (limiting < 0.8 || limiting > 1.005) {
      out.push(
        `${tag}: open wheel fills ${f(limiting)} of its box on the limiting side (need .80 to 1)`,
      );
    }
    const dx = Math.abs((box.l + box.r) / 2 - (free.l + free.r) / 2) / fw;
    const dy = Math.abs((box.t + box.b) / 2 - (free.t + free.b) / 2) / fh;
    if (dx > 0.06 || dy > 0.06) {
      out.push(`${tag}: open wheel is off centre by ${f(dx)} across, ${f(dy)} down (limit .06)`);
    }
  }
  return out;
}

/** T5(b): at the open point the legend is up, whole, inside the stage and clear of the wheel. */
async function legendProblems(page: Page, tag: string): Promise<string[]> {
  const out: string[] = [];
  const lists = await page.evaluate(() => {
    const sp = (window as unknown as { __sp: SiteProbe }).__sp;
    return Array.from(document.querySelectorAll(".rfw .rfw-keys")).map((el) => {
      const r = el.getBoundingClientRect();
      const items = Array.from(el.querySelectorAll("li"));
      const names = items.length
        ? items.map((li) => {
            const own = Array.from(li.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => n.textContent || "")
              .join("");
            return (own.trim() || li.textContent || "").trim();
          })
        : (el.textContent || "")
            .split("·")
            .map((s) => s.trim())
            .filter(Boolean);
      return {
        shown: sp.shown(el, 0.9),
        box: { l: r.left, t: r.top, r: r.right, b: r.bottom },
        names,
      };
    });
  });
  if (lists.length !== 2) {
    return [`${tag}: legend has ${lists.length} lists (need 2)`];
  }
  const sizes = lists.map((l) => l.names.length).sort((a, b) => a - b);
  if (sizes[0] !== 5 || sizes[1] !== 10)
    out.push(`${tag}: legend groups hold ${sizes.join(" and ")} names (need 5 and 10)`);
  const got = lists.flatMap((l) => l.names).sort();
  const want = [...ALL_NAMES].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    const missing = want.filter((n) => !got.includes(n));
    out.push(
      `${tag}: legend names differ from the 15 (missing: ${missing.join(", ") || "none"}; got ${got.length})`,
    );
  }
  lists.forEach((l, i) => {
    if (!l.shown) out.push(`${tag}: legend list ${i} is not visible`);
  });
  const stage = (await rectOf(page, ".rfw-tile")) ?? (await rectOf(page, ".rfw-pin"));
  const px = await wheelBox(page).catch(() => null);
  lists.forEach((l, i) => {
    if (stage && !inside(l.box, stage, 2))
      out.push(`${tag}: legend list ${i} sticks out of the stage`);
    if (px && overlaps(px, l.box, 2)) out.push(`${tag}: legend list ${i} overlaps the wheel`);
  });
  return out;
}

/** T5(c): at a stop the legend is gone and exactly one stop heading shows. */
async function stopProblems(page: Page, tag: string): Promise<string[]> {
  const out: string[] = [];
  const r = await page.evaluate(() => {
    const sp = (window as unknown as { __sp: SiteProbe }).__sp;
    return {
      legend: Array.from(document.querySelectorAll(".rfw .rfw-keys")).filter((e) =>
        sp.shown(e, 0.05),
      ).length,
      headings: Array.from(document.querySelectorAll(".rfw .rfw-t .rfw-title")).filter((e) =>
        sp.shown(e, 0.5),
      ).length,
    };
  });
  if (r.legend) out.push(`${tag}: ${r.legend} legend list(s) still show at a stop`);
  if (r.headings !== 1) out.push(`${tag}: ${r.headings} stop headings show (need exactly 1)`);
  return out;
}

/** T6: at least one heading in the words column is up (>= .5) and at or below the header. */
async function headingProblems(page: Page, tag: string): Promise<string[]> {
  const found = await page.evaluate((sel) => {
    const sp = (window as unknown as { __sp: SiteProbe }).__sp;
    const hdr = document.querySelector(".site-header");
    const hb = hdr ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
    return Array.from(document.querySelectorAll(sel))
      .filter((el) => sp.shown(el, 0.5))
      .filter((el) => {
        const t = el.getBoundingClientRect().top;
        return t >= hb - 1 && t < window.innerHeight;
      }).length;
  }, HEADING_SEL);
  return found ? [] : [`${tag}: no heading is up in the words column`];
}

// Counts the triggers that persist. A `once: true` reveal deletes itself when it is passed, so how
// many are left depends on how far, and at which window size, the page has scrolled before; a
// resize that leaks or duplicates triggers shows up in the persistent ones (WP0 baseline, T8 @1).
const triggerCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const ST = (
      window as unknown as {
        ScrollTrigger?: { getAll(): Array<{ vars?: { once?: boolean } }> };
      }
    ).ScrollTrigger;
    if (!ST) throw new Error("ScrollTrigger is not on the page");
    return ST.getAll().filter((t) => !t.vars?.once).length;
  });

// ─── T3 — the wheel fits inside its box ─────────────────────────────────────

test.describe("T3 R3,R4 wheel fits inside its box", () => {
  for (const size of SIZES) {
    test(`T3 R3,R4 wheel fits inside its box @${sizeName(size)}`, async ({ page }) => {
      test.setTimeout(240_000);
      await openHomeNoSnap(page, size);
      const problems: string[] = [];
      for (const share of nonEmpty(BEATS, "wheel checkpoints")) {
        await scrollWheelTo(page, share);
        problems.push(
          ...(await fitProblems(
            page,
            `${sizeName(size)} @${share}`,
            size,
            OPEN_SHARES.includes(share),
          )),
        );
      }
      expect(problems, `T3 ${sizeName(size)}: every size and checkpoint that is wrong`).toEqual([]);
    });
  }
});

// ─── T4 — one pose, one weight ──────────────────────────────────────────────

test("T4 R5 one pose and one lift weight on every size", async ({ page }) => {
  test.setTimeout(600_000);
  const problems: string[] = [];
  const opens: { size: string; ri: number; rh: number }[] = [];
  for (const size of nonEmpty(SIZES, "sizes")) {
    await test.step(`T4 ${sizeName(size)}`, async () => {
      await openHomeNoSnap(page, size);
      const samples: { share: number; zO: number; zI: number; zH: number }[] = [];
      for (let k = 0; k <= 24; k++) {
        const share = k / 24;
        await scrollWheelTo(page, share);
        await frames(page, 2);
        const c = await wheelCam(page);
        samples.push({ share, zO: c.zO, zI: c.zI, zH: c.zH });
      }
      const live = nonEmpty(
        samples.filter((s) => Math.abs(s.zO) > 1e-3),
        `samples with a lifted outer ring at ${sizeName(size)}`,
      );
      const first = live[0];
      for (const s of live) {
        const di = Math.abs(s.zI / s.zO - first.zI / first.zO);
        const dh = Math.abs(s.zH / s.zO - first.zH / first.zO);
        if (di > 0.001)
          problems.push(
            `${sizeName(size)} @${f(s.share)}: zI/zO ${f(s.zI / s.zO)} differs from ${f(first.zI / first.zO)}`,
          );
        if (dh > 0.001)
          problems.push(
            `${sizeName(size)} @${f(s.share)}: zH/zO ${f(s.zH / s.zO)} differs from ${f(first.zH / first.zO)}`,
          );
      }
      const open = live.reduce((a, b) => (Math.abs(b.zO) > Math.abs(a.zO) ? b : a));
      opens.push({ size: sizeName(size), ri: open.zI / open.zO, rh: open.zH / open.zO });
    });
  }
  const ref = nonEmpty(opens, "open poses")[0];
  for (const o of opens) {
    if (Math.abs(o.ri - ref.ri) > 0.001 || Math.abs(o.rh - ref.rh) > 0.001) {
      problems.push(
        `${o.size}: open zI/zO ${f(o.ri)}, zH/zO ${f(o.rh)} differ from ${ref.size} (${f(ref.ri)}, ${f(ref.rh)})`,
      );
    }
  }
  expect(problems, "T4: poses and weights that differ").toEqual([]);
});

// ─── T5 — names live in the legend, never on the canvas ─────────────────────

const T5_SIZES: Size[] = [
  { w: 1440, h: 900 },
  { w: 1288, h: 593 },
  { w: 390, h: 844 },
  { w: 844, h: 390 },
];

test.describe("T5 R6 names are not painted on the canvas", () => {
  for (const size of T5_SIZES) {
    test(`T5 R6 names are not painted on the canvas @${sizeName(size)}`, async ({ page }) => {
      test.setTimeout(240_000);
      await openHomeNoSnap(page, size, { spy: true });
      const problems: string[] = [];

      for (const share of nonEmpty(BEATS, "wheel checkpoints")) {
        await scrollWheelTo(page, share);
        const tag = `${sizeName(size)} @${share}`;
        if (OPEN_SHARES.includes(share)) problems.push(...(await legendProblems(page, tag)));
        if (STOP_SHARES.includes(share)) problems.push(...(await stopProblems(page, tag)));
      }

      // (a) not one text draw call across the whole scroll
      const drawn = await drawCounts(page);
      if (drawn.text !== 0)
        problems.push(
          `${sizeName(size)}: ${drawn.text} fillText/strokeText calls on the canvas (need 0)`,
        );

      // (d) arrow keys walk the 15 buttons and the name pill shows each name
      await scrollWheelTo(page, 0.4);
      const buttons = await page.locator(".rfw-b").count();
      if (buttons !== 15) problems.push(`${sizeName(size)}: ${buttons} tile buttons (need 15)`);
      await page.locator('.rfw-b[data-i="0"]').focus();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowLeft");
      for (let i = 0; i < ALL_NAMES.length; i++) {
        const shows = await page
          .waitForFunction(
            ([idx, name]) => {
              const tip = document.querySelector(".rfw-tip");
              const at = document.activeElement as HTMLElement | null;
              return (
                !!tip &&
                tip.classList.contains("on") &&
                (tip.textContent || "").trim() === name &&
                at?.getAttribute("data-i") === String(idx)
              );
            },
            [i, ALL_NAMES[i]] as const,
            { timeout: 4_000 },
          )
          .then(() => true)
          .catch(() => false);
        if (!shows)
          problems.push(
            `${sizeName(size)}: button ${i} does not focus with the name pill "${ALL_NAMES[i]}"`,
          );
        await page.keyboard.press("ArrowRight");
      }

      // (e) "If you deliver" stays on Routes and Delivery in "What each part does"
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".sy-parts li")).map((li) => ({
          name: (li.querySelector("b")?.textContent || "").trim(),
          text: (li.textContent || "").trim(),
        })),
      );
      nonEmpty(rows, "rows in .sy-parts");
      for (const name of ["Routes", "Delivery"]) {
        const row = rows.find((r) => r.name === name);
        if (!row) problems.push(`${sizeName(size)}: no "${name}" row in What each part does`);
        else if (!row.text.includes("If you deliver"))
          problems.push(`${sizeName(size)}: "${name}" row lacks "If you deliver"`);
      }

      expect(problems, `T5 ${sizeName(size)}: every checkpoint that is wrong`).toEqual([]);
    });
  }
});

// ─── T6 — the words column is never empty ───────────────────────────────────

test.describe("T6 R7 a heading is always up in the words column", () => {
  for (const size of SIZES) {
    test(`T6 R7 a heading is always up in the words column @${sizeName(size)}`, async ({
      page,
    }) => {
      test.setTimeout(300_000);
      await openHomeNoSnap(page, size);
      const end = await wheelEnd(page);
      const empty: string[] = [];
      const N = 120;
      for (let i = 0; i < N; i++) {
        const t = (end * i) / (N - 1);
        await seekWheel(page, t);
        const gap = await headingProblems(page, "");
        if (gap.length) empty.push(`t=${t.toFixed(2)} of ${end.toFixed(2)}`);
      }
      expect(
        empty,
        `T6 ${sizeName(size)}: timeline times with no heading up in the words column (${empty.length} of ${N})`,
      ).toEqual([]);
    });
  }
});

// ─── T7 — nothing empty after the wheel ─────────────────────────────────────

const T7_SIZES: Size[] = [
  { w: 1440, h: 900 },
  { w: 1288, h: 593 },
  { w: 390, h: 844 },
];

test.describe("T7 R8 no empty screen after the wheel", () => {
  for (const size of T7_SIZES) {
    test(`T7 R8 no empty screen after the wheel @${sizeName(size)}`, async ({ page }) => {
      test.setTimeout(240_000);
      await openHomeNoSnap(page, size);
      const problems: string[] = [];

      // at the end of the wheel a visible "Start free trial" link is inside .rfw
      await scrollWheelTo(page, 1);
      const cta = await page.evaluate(() => {
        const sp = (window as unknown as { __sp: SiteProbe }).__sp;
        return Array.from(document.querySelectorAll(".rfw a")).filter(
          (a) => /start free trial/i.test(a.textContent || "") && sp.shown(a, 0.99),
        ).length;
      });
      if (!cta)
        problems.push(`${sizeName(size)} @1: no visible "Start free trial" link inside the wheel`);

      const y0 = await page.evaluate(() => window.scrollY);
      const step = Math.round(size.h * 0.2);
      let windows = 0;
      for (let k = 0; k < 300; k++) {
        const y = y0 + k * step;
        const reached = await page.evaluate((to) => {
          window.scrollTo({ top: to, behavior: "instant" as ScrollBehavior });
          const parts = document.querySelector(".sy-parts");
          const hdr = document.querySelector(".site-header");
          const hb = hdr ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
          return {
            parts: parts ? parts.getBoundingClientRect().top <= hb : false,
            atEnd: Math.abs(window.scrollY - to) > 2,
          };
        }, y);
        if (reached.parts || reached.atEnd) break;
        await settle(page);
        await frames(page, 2);
        windows++;
        const tag = `${sizeName(size)} window ${k} (scrollY ${y})`;
        const px = await wheelBox(page).catch(() => null);
        const wheelShare = px ? visibleShare(px, size.w, size.h) : 0;
        const filled = await page.evaluate(() => {
          const sp = (window as unknown as { __sp: SiteProbe }).__sp;
          const hdr = document.querySelector(".site-header");
          const hb = hdr ? Math.max(0, hdr.getBoundingClientRect().bottom) : 0;
          const whole = (el: Element) => {
            const r = el.getBoundingClientRect();
            return (
              r.top >= hb - 1 &&
              r.bottom <= window.innerHeight &&
              r.left >= 0 &&
              r.right <= window.innerWidth
            );
          };
          const heading = Array.from(document.querySelectorAll("h1, h2, h3")).some(
            (h) => !h.closest(".site-header") && sp.shown(h, 0.99) && whole(h),
          );
          const button = Array.from(
            document.querySelectorAll("a.btn, .sy-go, button:not(.rfw-b)"),
          ).some((b) => !b.closest(".site-header") && sp.shown(b, 0.99) && whole(b));
          return heading && button;
        });
        if (wheelShare < 0.15 && !filled) {
          problems.push(
            `${tag}: neither the wheel (${f(wheelShare)} of the window) nor a heading with its button`,
          );
        }
      }
      if (!windows) throw new Error(`T7 ${sizeName(size)}: swept no windows after the wheel`);
      expect(problems, `T7 ${sizeName(size)}: windows that are empty`).toEqual([]);
    });
  }
});

// ─── T8 — a resize leaves the wheel as a fresh load would ───────────────────

const RESIZE_PATH: Size[] = [
  { w: 1440, h: 900 },
  { w: 1288, h: 593 },
  { w: 390, h: 844 },
  { w: 844, h: 390 },
  { w: 1440, h: 900 },
];

test.describe("T8 R9 resize leaves the wheel as a fresh load would", () => {
  for (const share of [0.4, 0.63, 1]) {
    test(`T8 R9 resize leaves the wheel as a fresh load would @share ${share}`, async ({
      page,
      context,
    }) => {
      test.setTimeout(300_000);
      await openHomeNoSnap(page, RESIZE_PATH[0]);
      const fresh = await context.newPage();
      const problems: string[] = [];

      for (let k = 0; k < RESIZE_PATH.length; k++) {
        const size = RESIZE_PATH[k];
        const tag = `${sizeName(size)} step ${k} @${share}`;
        if (k > 0) {
          // wait on ScrollTrigger's own refresh event, never on a sleep
          const refreshed = page.evaluate(
            () =>
              new Promise<void>((done, fail) => {
                const ST = (
                  window as unknown as {
                    ScrollTrigger?: {
                      addEventListener(n: string, f: () => void): void;
                      removeEventListener(n: string, f: () => void): void;
                    };
                  }
                ).ScrollTrigger;
                if (!ST) return fail(new Error("ScrollTrigger is not on the page"));
                const timer = setTimeout(
                  () => fail(new Error("no ScrollTrigger refresh after the resize")),
                  10_000,
                );
                const on = () => {
                  clearTimeout(timer);
                  ST.removeEventListener("refresh", on);
                  done();
                };
                ST.addEventListener("refresh", on);
              }),
          );
          await page.setViewportSize({ width: size.w, height: size.h });
          await refreshed;
          await waitForWheel(page);
          await waitForArrival(page);
        }
        await scrollWheelTo(page, share);
        await frames(page, 2);

        problems.push(...(await fitProblems(page, tag, size, share >= 0.36 && share <= 0.45)));
        if (share >= 0.36 && share <= 0.45) problems.push(...(await legendProblems(page, tag)));
        if (share >= 0.54 && share <= 0.72) problems.push(...(await stopProblems(page, tag)));
        problems.push(...(await headingProblems(page, tag)));

        // The fresh page goes through the same re-mount and scroll as the resized one: once:true
        // reveal triggers remove themselves on scroll, so an unscrolled fresh load counts more.
        await openHomeNoSnap(fresh, size);
        await scrollWheelTo(fresh, share);
        await frames(fresh, 2);
        const [after, base] = [await triggerCount(page), await triggerCount(fresh)];
        if (after !== base)
          problems.push(
            `${tag}: ${after} ScrollTriggers after the resize, ${base} on a fresh load`,
          );
      }
      expect(problems, `T8 @${share}: every step of the resize path that is wrong`).toEqual([]);
    });
  }
});
