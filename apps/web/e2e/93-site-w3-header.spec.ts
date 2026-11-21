/**
 * Wave 3, header lane, project "site-waves": T48a (one trial button on a phone screen), T48b (no header trial button
 * on /signup), T48c (Sign in and the trial button reachable in the open phone menu), T48d (the header does not move,
 * with a self-check), P01 (plan cards of a row end together) and the top band's line. Signed out, desktop Chrome,
 * against a running stack. Each test gathers every problem and asserts once; a sweep that finds nothing throws (L-202).
 */
import * as fs from "fs";
import * as path from "path";
import { test, expect, type Page } from "@playwright/test";
import { SCRIPT_GZIP_KB } from "./helpers/site-speed-budget";
import { readPillSettled, settleMotion } from "./helpers/header-pill";
import { blockAnalytics, nonEmpty } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

async function open(page: Page, route: string, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(route, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
}

// ─── T48a ───────────────────────────────────────────────────────────────────

test("T48a at 390x844, while another trial button is on screen, the header pill is not", async ({
  page,
}) => {
  // Every scroll step settles (SA-1200 A1 M2: a 150ms floor, then 10 calm frames), about 0.3s a step over the whole page.
  test.setTimeout(180_000);
  await open(page, "/", 390, 844);
  const { total, step } = await page.evaluate(() => ({
    total: document.documentElement.scrollHeight - innerHeight,
    step: 0.1 * innerHeight,
  }));
  const bad: string[] = [];
  let withOthers = 0;
  let withoutOthers = 0;
  for (let y = 0; y <= total + step; y += step) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), Math.min(y, total));
    const read = await readPillSettled(page); // settle, then poll (SA-1199 P3), live header box
    const state = { others: read.others, pill: read.pillShown };
    if (state.others > 0) {
      withOthers++;
      if (state.pill) bad.push(`scroll ${Math.round(y)}: ${state.others} other, pill shown`);
    } else {
      // The positive control: with no other trial button on screen the pill is there (a dead observer hides it for good).
      withoutOthers++;
      if (!state.pill) bad.push(`scroll ${Math.round(y)}: no other trial button, pill hidden`);
    }
  }
  expect(withOthers, "some sample had another trial button on screen").toBeGreaterThan(0);
  expect(withoutOthers, "some sample had none (the positive control ran)").toBeGreaterThan(0);
  expect(bad).toEqual([]);
});

// SA-1196 A3-1: on every chrome page the header pill shows exactly when no watched trial button is in view (a page with
// no watched button keeps it for good: chrome.js fails open). The pages are read from disk the way
// app/(marketing)/site-chrome.static.test.ts reads them: every public/site page whose script budget is not 0 (landing).
const SITE_DIR = path.resolve(__dirname, "../public/site");
const CHROME_ROUTES = fs
  .readdirSync(SITE_DIR)
  .filter((f) => f.endsWith(".html"))
  .map((f) => f.replace(/\.html$/, ""))
  .filter((name) => SCRIPT_GZIP_KB[name as keyof typeof SCRIPT_GZIP_KB] !== 0)
  .map((name) => (name === "home" ? "/" : "/" + name));

// The T48e rows run serially in one worker so the closing row reads what they recorded. A row that checked nothing in
// a state cannot pass the suite for that state: the closing row needs both.
const STATE_SHOWN = "shown, no watched button in view";
const STATE_HIDDEN = "hidden, one in view";
const SEEN_STATES = new Set<string>();

test.describe("T48e", () => {
  test.describe.configure({ mode: "serial" });

  test("the chrome pages are found", () => {
    expect(CHROME_ROUTES.length).toBe(9);
  });

  for (const route of CHROME_ROUTES) {
    test(
      "T48e at 393x844 the header pill shows exactly when no watched trial button is in view: " +
        route,
      async ({ page }) => {
        await open(page, route, 393, 844);
        const bad: string[] = [];
        for (const at of ["load", "end"] as const) {
          await page.evaluate((where) => {
            window.scrollTo({
              top: where === "end" ? document.documentElement.scrollHeight : 0,
              behavior: "instant",
            });
          }, at);
          const read = await readPillSettled(page); // settle, then poll (SA-1199 P3), live header box
          const state = { others: read.others, pill: read.pillShown };
          // Record the state this reading checked (A4-2), so the closing row can prove both were seen.
          SEEN_STATES.add(state.others === 0 ? STATE_SHOWN : STATE_HIDDEN);
          if (state.pill !== (state.others === 0)) {
            bad.push(
              at +
                ": " +
                state.others +
                " watched button(s) in view, pill " +
                (state.pill ? "shown" : "hidden") +
                ", pill box " +
                JSON.stringify(read.pillBox) +
                ", nav box " +
                JSON.stringify(read.navBox),
            );
          }
        }
        expect(bad).toEqual([]);
      },
    );
  }

  test("T48e saw both states: shown with no watched button in view, hidden with one in view", () => {
    // Serial in one worker, last in the file's T48e group, so it reads what every row above recorded.
    expect([...SEEN_STATES].sort()).toEqual([STATE_HIDDEN, STATE_SHOWN].sort());
  });
});

// ─── T48b ───────────────────────────────────────────────────────────────────

for (const { w, h } of [
  { w: 1440, h: 900 },
  { w: 393, h: 844 },
] as const) {
  test(`T48b /signup has no trial button in the header @${w}x${h}`, async ({ page }) => {
    await open(page, "/signup", w, h);
    const found = await page.evaluate(
      () => Array.from(document.querySelectorAll('.site-header a[href^="/signup"]')).length,
    );
    const signIn = await page.locator(".site-header a.nav-signin").count();
    expect(signIn, "the header still carries Sign in").toBe(1);
    expect(found).toBe(0);
  });
}

// ─── T48c ───────────────────────────────────────────────────────────────────

for (const route of ["/company", "/privacy"]) {
  test(`T48c at 393x740 the open menu shows Sign in and the trial button: ${route}`, async ({
    page,
  }) => {
    await open(page, route, 393, 740);
    await page.locator(".menu-btn").click();
    await expect(page.locator("#mobile-menu")).toHaveClass(/open/);
    const rows = await page.evaluate(() => {
      const out: { what: string; top: number; bottom: number; shown: boolean }[] = [];
      for (const a of Array.from(document.querySelectorAll("#mobile-menu a"))) {
        const t = (a.textContent ?? "").trim();
        if (t !== "Sign in" && t !== "Open dashboard" && t !== "Start free trial") continue;
        const r = a.getBoundingClientRect();
        out.push({ what: t, top: r.top, bottom: r.bottom, shown: r.width > 0 });
      }
      return { out, h: innerHeight };
    });
    nonEmpty(rows.out, "menu actions");
    const hidden = rows.out.filter((r) => !r.shown || r.top < 0 || r.bottom > rows.h);
    expect(hidden, JSON.stringify(rows.out)).toEqual([]);
    const names = rows.out.map((r) => r.what);
    expect(names).toContain("Start free trial");
    expect(
      names.some((n) => n === "Sign in" || n === "Open dashboard"),
      "Sign in is in the menu",
    ).toBe(true);
  });
}

// ─── T48d ───────────────────────────────────────────────────────────────────

type Box = { top: number; height: number };
const headerBox = (page: Page): Promise<Box> =>
  page.evaluate(() => {
    const r = document.querySelector(".site-header")!.getBoundingClientRect();
    return { top: r.top, height: r.height };
  });

async function headerDrift(page: Page): Promise<string[]> {
  const first = await headerBox(page);
  const bad: string[] = [];
  const check = async (what: string) => {
    const b = await headerBox(page);
    if (Math.abs(b.top - first.top) > 1 || Math.abs(b.height - first.height) > 1) {
      bad.push(`${what}: top ${b.top} height ${b.height} (was ${first.top}, ${first.height})`);
    }
  };
  for (const y of [300, 900, 1800, 0]) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
    await check(`scroll ${y}`);
  }
  await page.locator(".menu-btn").click();
  await check("menu open");
  await page.locator(".menu-btn").click();
  await check("menu closed");
  return bad;
}

test("T48d the header keeps its height and top while scrolling and opening the menu", async ({
  page,
}) => {
  await open(page, "/pricing", 393, 844);
  expect(await headerDrift(page)).toEqual([]);
});

test("T48d self-check: a static header turns the guard red", async ({ page }) => {
  await open(page, "/pricing", 393, 844);
  await page.addStyleTag({ content: ".site-header{position:static!important}" });
  const bad = await headerDrift(page);
  expect(bad.length, "the guard saw the header move").toBeGreaterThan(0);
});

// ─── P01 and the band line ──────────────────────────────────────────────────

for (const { route, scope } of [
  { route: "/pricing", scope: "#pricing" },
  { route: "/", scope: "#pricing" },
] as const) {
  test(`P01 the plan cards of a row end together: ${route} ${scope} @1440x900`, async ({
    page,
  }) => {
    await open(page, route, 1440, 900);
    const cards = await page.evaluate((root) => {
      const base = document.querySelector(root);
      if (!base) throw new Error(`no ${root}`);
      return Array.from(base.querySelectorAll(".pgrid .pcard"))
        .filter((c) => c.getBoundingClientRect().height > 0)
        .map((c) => ({
          name: (c.querySelector("h2,h3")?.textContent ?? "plan").trim(),
          top: Math.round(c.getBoundingClientRect().top + scrollY),
          bottom: c.getBoundingClientRect().bottom + scrollY,
        }));
    }, scope);
    nonEmpty(cards, `plan cards on ${route}`);
    expect(cards.length).toBeGreaterThanOrEqual(4);
    const rows = new Map<number, typeof cards>();
    for (const c of cards) rows.set(c.top, [...(rows.get(c.top) ?? []), c]);
    const bad: string[] = [];
    for (const row of rows.values()) {
      const lo = Math.min(...row.map((c) => c.bottom));
      const hi = Math.max(...row.map((c) => c.bottom));
      if (hi - lo > 1) bad.push(row.map((c) => `${c.name} ${c.bottom.toFixed(0)}`).join(", "));
    }
    expect(bad).toEqual([]);
  });
}

// SA-1200 A3 (owner answer A): the K3 empty-band row is retired. Its intent (no hole inside a plan card) is carried
// by exact checks: the list tops of a row start level (K1, below), each list starts right after its own button (A4,
// below), and the buttons of a row share one top (spec 95, K4). SA-1200 A4: the card order is .pfor, the button, then
// the list, every child a row of the card's subgrid.

// SA-1200 K1 / A1 M1: the card rows come from the grid (css/site.css, .pgrid--4 .pcard subgrid), so a row reads across: the
// lists of the four cards start at one top. Only the list tops are pinned. The prices cannot see a wrapping description
// (every card's price row is as tall as its tallest card either way); the button tops are spec 95's K4 row. Two widths,
// both four columns (the grid is two columns at 1080 and under):
// 1440, where every description wraps to 2 lines, and 1100, where they wrap unevenly. Measured (A1): the wrap is
// 3-2-2-2 lines from 1084 to 1108 and 2-2-2-2 from 1120, so 1100 is uneven (Starter's .pfor takes 3 lines, the others 2)
// and 1440 is even. Without the grid rows (a planted no-subgrid) Starter's list starts lower at 1100 and this goes red.
// "List top": the first li of ul.checks on /pricing. Home has no li (its cards hold a .pm meter, not a list), so on "/" the
// .pm block's top is the list top.
const PLAN_ALIGN_WIDTHS = [1440, 1100] as const;
for (const route of ["/pricing", "/"] as const) {
  for (const w of PLAN_ALIGN_WIDTHS) {
    test(`K1 the lists of a plan row start at one top: ${route} @${w}x900`, async ({ page }) => {
      await open(page, route, w, 900);
      const listSel = route === "/" ? ".pm" : "ul.checks > li:first-child";
      const read = await page.evaluate((sel) => {
        const cards = Array.from(document.querySelectorAll("#pricing .pgrid--4 .pcard")).filter(
          (c) => c.getBoundingClientRect().height > 0,
        );
        return cards.map((c) => {
          const el = c.querySelector(sel);
          if (!el) throw new Error(`no ${sel} in a plan card`);
          return {
            name: (c.querySelector("h2,h3")?.textContent ?? "plan").trim(),
            list: el.getBoundingClientRect().top + scrollY,
            forHeight: c.querySelector(".pfor")?.getBoundingClientRect().height ?? 0,
          };
        });
      }, listSel);
      nonEmpty(read, `plan cards on ${route}`);
      expect(read.length).toBe(4);
      if (w === 1100) {
        // The uneven width is what gives this row teeth (a planted no-subgrid moves the longer card's list). If the
        // descriptions all wrap alike here (other fonts, a copy edit), the row would pass on anything: re-measure the width.
        const heights = read.map((c) => Math.round(c.forHeight));
        expect(
          new Set(heights).size > 1,
          "descriptions wrap alike @1100: " + heights.join(", "),
        ).toBe(true);
      }
      const tops = read.map((c) => c.list);
      const msg =
        "list tops: " +
        read
          .map((c) => `${c.name} ${c.list.toFixed(1)} (text ${c.forHeight.toFixed(0)}px)`)
          .join(", ");
      expect(Math.max(...tops) - Math.min(...tops) <= 1, msg).toBe(true);
    });
  }
}

// SA-1200 A4-4: each plan card's list starts right after its own button. The gap from the button's border box bottom
// to the list's top is the designed one, read from the page's own computed style (the card's row-gap, the button's
// margin-bottom, the list's margin-top), +-1px. This is what catches a hole between a button and its list (a button row
// taller than its buttons, or a pushed list). The list is ul.checks on /pricing and the .pm meter on "/". The cards are
// hidden under 900px (the plan table shows), so this runs at the K1 widths.
for (const route of ["/pricing", "/"] as const) {
  for (const w of PLAN_ALIGN_WIDTHS) {
    test(`A4 the list starts right after its own button: ${route} @${w}x900`, async ({ page }) => {
      await open(page, route, w, 900);
      const listSel = route === "/" ? ".pm" : "ul.checks";
      const read = await page.evaluate((sel) => {
        const cards = Array.from(document.querySelectorAll("#pricing .pgrid--4 .pcard")).filter(
          (c) => c.getBoundingClientRect().height > 0,
        );
        return cards.map((c) => {
          const list = c.querySelector(sel);
          const btn = c.querySelector(".pbtn");
          if (!list || !btn) throw new Error(`no ${sel} or .pbtn in a plan card`);
          if (btn.parentElement !== c || list.parentElement !== c)
            throw new Error(`the button and ${sel} must be the card's own rows`);
          const px = (v: string) => parseFloat(v) || 0;
          const designed =
            px(getComputedStyle(c).rowGap) +
            px(getComputedStyle(btn).marginBottom) +
            px(getComputedStyle(list).marginTop);
          return {
            name: (c.querySelector("h2,h3")?.textContent ?? "plan").trim(),
            actual: list.getBoundingClientRect().top - btn.getBoundingClientRect().bottom,
            designed,
          };
        });
      }, listSel);
      nonEmpty(read, `plan cards on ${route}`);
      expect(read.length).toBe(4);
      const bad = read
        .filter((c) => Math.abs(c.actual - c.designed) > 1)
        .map((c) => `${c.name} gap ${c.actual.toFixed(1)}px, designed ${c.designed.toFixed(1)}px`);
      expect(bad, bad.join("; ")).toEqual([]);
    });
  }
}

// SA-1200 A1 M2: settleMotion waits a floor first, so a tween that a delayed call creates later is still seen. The
// fixture starts a CSS animation at 60ms (like the hero's gsap.delayedCall(0.06)) and makes animation frames fast
// (about 4ms), so ten quiet frames alone take less than 60ms: only the floor keeps the wait from returning before the
// animation exists. Without the floor this goes red; with it the animation is running when the wait ends or is over.
test("settleMotion waits past a tween that starts at 60ms", async ({ page }) => {
  await page.setContent(`<div id="fx" style="width:20px;height:20px"></div>`);
  await page.evaluate(() => {
    window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
    const el = document.getElementById("fx") as HTMLElement;
    (window as unknown as { __started: boolean }).__started = false;
    window.setTimeout(() => {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600 });
      (window as unknown as { __started: boolean }).__started = true;
    }, 60);
  });
  await settleMotion(page, { watched: "#fx", pill: "#fx-none" });
  const got = await page.evaluate(() => ({
    started: (window as unknown as { __started: boolean }).__started,
    running: (document.getElementById("fx") as HTMLElement)
      .getAnimations()
      .filter((a) => a.playState !== "finished").length,
  }));
  expect(got.started, "the fixture animation was created before the wait ended").toBe(true);
  expect(got.running, "nothing is still animating after settleMotion").toBe(0);
});

for (const { w, h } of [
  { w: 1440, h: 900 },
  { w: 393, h: 844 },
] as const) {
  test(`the pricing top band is closed by the page's line @${w}x${h}`, async ({ page }) => {
    await open(page, "/pricing", w, h);
    const got = await page.evaluate(() => {
      const band = document.querySelector(".band-line");
      if (!band) throw new Error("no .band-line on /pricing");
      const probe = document.createElement("i");
      document.body.appendChild(probe);
      probe.style.borderBottom = "1px solid var(--rf-line)";
      const want = getComputedStyle(probe).borderBottomColor;
      probe.remove();
      const s = getComputedStyle(band);
      return { width: s.borderBottomWidth, color: s.borderBottomColor, want };
    });
    expect(got.width).toBe("1px");
    expect(got.color).toBe(got.want);
  });
}
