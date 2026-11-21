/**
 * Wave 4, lane 2.5a, project "site-waves": K4 (the plan buttons line up). On /pricing every plan card's button
 * sits right after its price and its "for" line, so within one grid row all `.pcard .pbtn` tops are equal within
 * 1 px, at 1440x900, 1100x900 (where the "for" lines wrap unevenly) and 393x844 (the table shows, no cards).
 * SA-1200 A4 kept this order over the list-then-button wrapper. Signed out, desktop Chrome, against a running
 * stack. A sweep that finds nothing throws (L-202).
 *
 * Lane 2.5b adds the page-name rows (SA-1203): T24 browser half, T26 name half, T36 header fit. Every
 * name is read from brand.json; the one allowed mention of the previous name is footerLine()'s.
 */
import { test, expect, type Page } from "@playwright/test";
import brandFile from "../../../packages/types/brand/brand.json";
import { footerLine } from "../../../packages/types/brand/index";
import { PUBLIC_ROUTES, blockAnalytics } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

const SCREENS = [
  { w: 1440, h: 900 },
  { w: 1100, h: 900 },
  { w: 393, h: 844 },
] as const;

for (const { w, h } of SCREENS) {
  test(`K4: plan buttons share one top per grid row at ${w}x${h}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/pricing", { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);

    const all = await page.evaluate(() =>
      [...document.querySelectorAll(".pgrid--4 .pcard")].map((card) => {
        const btn = card.querySelector(".pbtn");
        const pfor = card.querySelector(".pfor");
        const list = card.querySelector(".checks");
        const box = card.getBoundingClientRect();
        const shown = getComputedStyle(card).display !== "none" && box.width > 0 && box.height > 0;
        const top = (el: Element | null) =>
          el ? Math.round(el.getBoundingClientRect().top * 100) / 100 : null;
        return {
          shown,
          cardTop: top(card),
          btnTop: top(btn),
          forTop: top(pfor),
          listTop: top(list),
        };
      }),
    );
    if (all.length === 0) throw new Error("no plan cards found on /pricing");
    const cards = all.filter((c) => c.shown);

    if (w < 900) {
      // Phones read the plan table instead of the four cards, so there is nothing to measure here.
      expect(cards, "no plan card is shown on a phone").toHaveLength(0);
      await expect(page.locator(".pl-wrap")).toBeVisible();
      return;
    }
    expect(cards.length, "the four plan cards are shown").toBeGreaterThanOrEqual(4);
    const problems: string[] = [];
    const rows = new Map<number, number[]>();
    cards.forEach((c, i) => {
      if (c.btnTop === null || c.forTop === null || c.listTop === null) {
        problems.push(`card ${i}: missing button, price line or list`);
        return;
      }
      // price, then button, then list
      if (!(c.forTop < c.btnTop && c.btnTop < c.listTop)) {
        problems.push(`card ${i}: order is not price, button, list`);
      }
      const row = Math.round((c.cardTop ?? 0) / 4);
      rows.set(row, [...(rows.get(row) ?? []), c.btnTop]);
    });
    for (const [row, tops] of rows) {
      const spread = Math.max(...tops) - Math.min(...tops);
      if (spread > 1)
        problems.push(`row ${row}: button tops differ by ${spread}px (${tops.join(", ")})`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}

// ─── page names and header fit (SA-1203) ─────────────────────────────────────────────────────

/** The signed-out front door: the 404 asks for a path nothing serves. */
const FRONT_DOOR = [
  "/privacy",
  "/terms",
  "/this-page-does-not-exist",
  "/login",
  "/signup",
  "/reset-password",
  "/buyer/login",
] as const;
/** T24's 17 pages: the 12 site pages plus the five front-door pages not already among them. */
const ALL_PAGES = [...new Set<string>([...PUBLIC_ROUTES, ...FRONT_DOOR])];

const squash = (v: string): string => v.replace(/\s+/g, " ").trim();

/** What a reader sees and hears on the page, with the allowed footer line taken out. */
async function readNames(page: Page) {
  const raw = await page.evaluate(() => {
    const attr = (sel: string, name: string) =>
      [...document.querySelectorAll(sel)].map((e) => e.getAttribute(name) ?? "");
    return {
      title: document.title,
      body: document.body.innerText,
      labels: [...attr("[alt]", "alt"), ...attr("[aria-label]", "aria-label")],
      metas: attr(
        'meta[name="description"], meta[property^="og:"], meta[name^="twitter:"]',
        "content",
      ),
      header: document.querySelector(".brand")?.textContent ?? "",
    };
  });
  const line = squash(footerLine());
  const rest = [squash(raw.body).split(line).join(" "), ...raw.labels, ...raw.metas, raw.title];
  return { ...raw, rest: rest.join("\n") };
}

function nameProblems(tag: string, r: Awaited<ReturnType<typeof readNames>>): string[] {
  const out: string[] = [];
  if (!r.title.endsWith(brandFile.name))
    out.push(`${tag}: title "${r.title}" does not end in the name`);
  if (r.rest.includes(brandFile.formerly))
    out.push(`${tag}: the previous name shows outside the footer line`);
  if (r.rest.includes(brandFile.officialName)) out.push(`${tag}: the official name shows`);
  return out;
}

// T24 browser half, SA-1203: title, header name, labels and share tags on all 17 pages.
test("T24 browser: every page shows the everyday name, the old name only in the footer line", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const problems: string[] = [];
  for (const route of ALL_PAGES) {
    await page.goto(route, { waitUntil: "load" });
    const r = await readNames(page);
    problems.push(...nameProblems(route, r));
    if ((PUBLIC_ROUTES as readonly string[]).includes(route) && squash(r.header) !== brandFile.name)
      problems.push(`${route}: header name is "${squash(r.header)}"`);
  }
  expect(ALL_PAGES.length, "17 pages are walked").toBe(17);
  expect(problems, problems.join("\n")).toEqual([]);
});

// T26 name half, SA-1203: the signed-out front door at 1440x900 and 390x844 (logo half is switch day).
for (const { w, h } of [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const) {
  test(`T26 name: the front door follows the brand file at ${w}x${h}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: w, height: h });
    const problems: string[] = [];
    for (const route of FRONT_DOOR) {
      await page.goto(route, { waitUntil: "load" });
      const r = await readNames(page);
      problems.push(...nameProblems(`${route} ${w}x${h}`, r));
      if (route !== "/signup" && route !== "/reset-password" && !r.body.includes(brandFile.name))
        problems.push(`${route} ${w}x${h}: the visible text never shows the name`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}

// T36, SA-1203: the header logo and name box fits its container and the viewport; re-run on switch day.
for (const w of [320, 390, 1440] as const) {
  test(`T36: the header logo and name do not overflow at ${w}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: w, height: 800 });
    const problems: string[] = [];
    for (const route of PUBLIC_ROUTES) {
      await page.goto(route, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const m = await page.evaluate(() => {
        const brand = document.querySelector<HTMLElement>(".brand");
        if (!brand) return null;
        const box = brand.closest("header") ?? brand.parentElement ?? brand;
        const b = brand.getBoundingClientRect();
        const c = box.getBoundingClientRect();
        const inner = [...brand.children].map((e) => e.getBoundingClientRect());
        return {
          scroll: brand.scrollWidth,
          client: brand.clientWidth,
          b: { l: b.left, r: b.right },
          c: { l: c.left, r: c.right },
          vw: window.innerWidth,
          innerRight: Math.max(0, ...inner.map((i) => i.right)),
        };
      });
      if (!m) {
        problems.push(`${route} @${w}: no .brand box found`);
        continue;
      }
      const at = `${route} @${w}`;
      if (m.scroll > m.client + 1)
        problems.push(`${at}: scrollWidth ${m.scroll} > clientWidth ${m.client}`);
      if (m.b.l < m.c.l - 0.5 || m.b.r > m.c.r + 0.5) problems.push(`${at}: box leaves its header`);
      if (m.b.l < -0.5 || m.b.r > m.vw + 0.5) problems.push(`${at}: box leaves the viewport`);
      if (m.innerRight > m.b.r + 0.5) problems.push(`${at}: logo or name spills out of the box`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
