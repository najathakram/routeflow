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
import { blockAnalytics, nonEmpty } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

async function open(page: Page, route: string, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(route, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
}

const HEADER_PILL = '.site-header a[href^="/signup"].btn';

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
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
    const state = await page.evaluate((pill) => {
      const inView = (el: Element) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (
          s.display !== "none" &&
          s.visibility !== "hidden" &&
          r.width > 0 &&
          r.height > 0 &&
          r.bottom > 68 &&
          r.top < innerHeight
        );
      };
      // The wheel's own button counts once the wheel says it is clickable and on screen.
      const wheelLive = !!document.querySelector(".rfw.rfw-go-on.rfw-go-in");
      const others = Array.from(document.querySelectorAll('a.btn[href^="/signup"]')).filter(
        (b) =>
          !b.closest(".site-header, #mobile-menu") &&
          (wheelLive || !b.closest(".rfw")) &&
          inView(b),
      );
      const head = document.querySelector(pill);
      return { others: others.length, pill: !!head && inView(head) };
    }, HEADER_PILL);
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
        await page.evaluate(
          () =>
            new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
        );
        const state = await page.evaluate((pill) => {
          const inView = (el: Element) => {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return (
              s.display !== "none" &&
              s.visibility !== "hidden" &&
              r.width > 0 &&
              r.height > 0 &&
              r.bottom > 68 &&
              r.top < innerHeight
            );
          };
          const wheelLive = !!document.querySelector(".rfw.rfw-go-on.rfw-go-in");
          const others = Array.from(document.querySelectorAll('a.btn[href^="/signup"]')).filter(
            (b) =>
              !b.closest(".site-header, #mobile-menu") &&
              (wheelLive || !b.closest(".rfw")) &&
              inView(b),
          );
          const head = document.querySelector(pill);
          return { others: others.length, pill: !!head && inView(head) };
        }, HEADER_PILL);
        if (state.pill !== (state.others === 0)) {
          bad.push(
            at +
              ": " +
              state.others +
              " watched button(s) in view, pill " +
              (state.pill ? "shown" : "hidden"),
          );
        }
      }
      expect(bad).toEqual([]);
    },
  );
}

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
      // One row definition, scoped by breakpoint (SA-1196 A3-2): each plan card at 900 and up; under 900 the grid is hidden
      // (css/site.css .pgrid--4) and the phone plan block, .pl-wrap through .pl-more (the notes and the trial button
      // where a page has them), is one scope. Both go through the same empty-band helper.
      const bands = await emptyBands(
        page,
        w < 900
          ? {
              name: "phone plan block",
              union: [".pl-wrap", ".pg-notes", ".pl-why", ".pl-more", ".pl-go"]
                .map((s) => scope + " " + s)
                .join(", "),
            }
          : { each: scope + " .pcard" },
      );
      nonEmpty(bands, "plan blocks on " + route);
      const bad = bands.filter((g) => g.gap > 32);
      expect(bad, bad.map((g) => g.where + " " + g.gap.toFixed(0) + "px").join("; ")).toEqual([]);
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
