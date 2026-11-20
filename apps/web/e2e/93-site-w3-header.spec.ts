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
import { emptyBands } from "./helpers/empty-bands";
import { readPillSettled } from "./helpers/header-pill";
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

/**
 * The element that paints a plan card (SA-1200 K2), the one row definition for K3.
 * 900 and up: .pcard. Under 900 the grid is hidden (css/site.css .pgrid--4) and the phone card is .pl-wrap: it alone
 * carries the white background and the ring (css/site.css, the max-width:899.98px block: `.pl-wrap{... background:var(--rf-white);box-shadow:var(--rf-ring)}`);
 * table.pl inside it paints nothing.
 */
const planCardBox = (w: number): string => (w < 900 ? ".pl-wrap" : ".pcard");

// SA-1189 K3: no empty band anywhere inside a plan card (the leftover space of a row sits under the shorter cards).
for (const { route, scope } of [
  { route: "/pricing", scope: "#pricing" },
  { route: "/", scope: "#pricing" },
] as const) {
  for (const { w, h } of [
    { w: 1440, h: 900 },
    { w: 393, h: 844 },
  ] as const) {
    test(`K3 no empty band over 32px inside a plan: ${route} ${scope} @${w}x${h}`, async ({
      page,
    }) => {
      await open(page, route, w, h);
      // SA-1200 K2: the scope is each plan card's own box at every width. Content outside the card (.pl-why, .pg-notes,
      // .pl-go, .pl-more) is page rhythm and outside K3.
      const bands = await emptyBands(page, { each: scope + " " + planCardBox(w) });
      nonEmpty(bands, "plan cards on " + route);
      const bad = bands.filter((g) => g.gap > 32);
      expect(bad, bad.map((g) => g.where + " " + g.gap.toFixed(0) + "px").join("; ")).toEqual([]);
    });
  }
}

// SA-1200 K1: the card rows come from the grid (css/site.css, .pgrid--4 .pcard subgrid), so a row reads across: the price
// and the button of the four cards sit at one top. Two widths, both four columns (the grid is two columns at 1080 and under):
// 1440, where every description wraps to 2 lines, and a width where the descriptions wrap unevenly. The uneven width is
// computed, not measured: text column = (w - 96) / 4 - 48 = 203px at 1100; the longest description (50 characters, 17px,
// about 8.5px a character) needs about 425px, which is over two lines of 203px, so it takes 3 lines while the others take 2.
// UNPROVEN until a browser run: change PLAN_ALIGN_WIDTHS here, nowhere else, if the descriptions do not wrap unevenly.
const PLAN_ALIGN_WIDTHS = [1440, 1100] as const;
for (const route of ["/pricing", "/"] as const) {
  for (const w of PLAN_ALIGN_WIDTHS) {
    test(`K1 the prices and buttons of a plan row share one top: ${route} @${w}x900`, async ({
      page,
    }) => {
      await open(page, route, w, 900);
      const read = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#pricing .pgrid--4 .pcard")).filter(
          (c) => c.getBoundingClientRect().height > 0,
        );
        const top = (c: Element, sel: string) => {
          const el = c.querySelector(sel);
          if (!el) throw new Error(`no ${sel} in a plan card`);
          return el.getBoundingClientRect().top + scrollY;
        };
        return cards.map((c) => ({
          name: (c.querySelector("h2,h3")?.textContent ?? "plan").trim(),
          price: top(c, ".pprice"),
          button: top(c, ".pbtn"),
          forHeight: c.querySelector(".pfor")?.getBoundingClientRect().height ?? 0,
        }));
      });
      nonEmpty(read, `plan cards on ${route}`);
      expect(read.length).toBe(4);
      const bad: string[] = [];
      for (const key of ["price", "button"] as const) {
        const tops = read.map((c) => c[key]);
        if (Math.max(...tops) - Math.min(...tops) > 1) {
          bad.push(
            `${key} tops: ` +
              read
                .map((c) => `${c.name} ${c[key].toFixed(1)} (text ${c.forHeight.toFixed(0)}px)`)
                .join(", "),
          );
        }
      }
      expect(bad).toEqual([]);
    });
  }
}

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
