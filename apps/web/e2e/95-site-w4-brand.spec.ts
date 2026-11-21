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

/** The signed-out front door: the 404 asks for a path nothing serves. Every one wears the site frame. */
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

/** The footer line's element: the frame's `.foot-bottom` span, or the landing page's `footer.foot`. */
const FOOT_LINE = ".foot-bottom > span:first-child, footer.foot .w > span:first-child";

/**
 * Strings that hold the previous name in another case on purpose (SA-1203 allow-list): the origins, the
 * mailboxes and the legal entity, all read from brand.json. Taken out before the old-name check.
 */
const KEPT_STRINGS = [
  brandFile.origin,
  brandFile.oldOrigin,
  brandFile.origin.replace(/^https?:\/\//, ""),
  brandFile.oldOrigin.replace(/^https?:\/\//, ""),
  brandFile.email,
  brandFile.securityEmail,
  brandFile.legalEntity,
];

const squash = (v: string): string => v.replace(/\s+/g, " ").trim();
const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Open a page and wait until it has hydrated: the header name, and on the front door the card heading. */
async function openPage(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: "load" });
  await page.locator(".brand").first().waitFor({ state: "visible" });
  if ((FRONT_DOOR as readonly string[]).includes(route))
    await page.locator("h1").first().waitFor({ state: "visible" });
}

/** What a reader sees and hears, with the footer line (checked to be exactly footerLine()) taken out. */
async function readNames(page: Page) {
  const raw = await page.evaluate((sel) => {
    const attr = (s: string, name: string) =>
      [...document.querySelectorAll(s)].map((e) => e.getAttribute(name) ?? "");
    return {
      title: document.title,
      body: document.body.innerText,
      foot: [...document.querySelectorAll<HTMLElement>(sel)].map((e) => e.innerText),
      labels: [...attr("[alt]", "alt"), ...attr("[aria-label]", "aria-label")],
      // text-like tags only: a URL value (og:image, og:url) is not read by anyone
      metas: attr(
        'meta[name="description"], meta[property="og:title"], meta[property="og:description"], meta[property="og:site_name"], meta[property="og:image:alt"], meta[name^="twitter:"]',
        "content",
      ).filter((c) => !/^(https?:)?\//.test(c)),
      header: document.querySelector(".brand")?.textContent ?? "",
    };
  }, FOOT_LINE);
  const line = squash(footerLine());
  const body = squash(raw.body);
  const rest = [body.split(line).join(" "), ...raw.labels, ...raw.metas, raw.title].join("\n");
  const kept = KEPT_STRINGS.reduce(
    (t, k) => t.split(new RegExp(escapeRe(k), "gi")).join(" "),
    rest,
  );
  return {
    ...raw,
    body,
    foot: raw.foot.map(squash),
    line,
    lineCount: body.split(line).length - 1,
    kept,
  };
}

function nameProblems(tag: string, r: Awaited<ReturnType<typeof readNames>>): string[] {
  const out: string[] = [];
  if (!r.title.endsWith(brandFile.name))
    out.push(`${tag}: title "${r.title}" does not end in the name`);
  if (r.foot.length !== 1 || r.foot[0] !== r.line || r.lineCount !== 1)
    out.push(
      `${tag}: the footer line is not exactly footerLine() once (${JSON.stringify(r.foot)})`,
    );
  if (new RegExp(escapeRe(brandFile.formerly), "i").test(r.kept))
    out.push(`${tag}: the previous name shows outside the footer line and the kept strings`);
  if (r.kept.includes(brandFile.officialName)) out.push(`${tag}: the official name shows`);
  if (squash(r.header) !== brandFile.name) out.push(`${tag}: header name is "${squash(r.header)}"`);
  if (!r.body.includes(brandFile.name)) out.push(`${tag}: the visible text never shows the name`);
  return out;
}

// T24 browser half, SA-1203: title, header name, labels and share tags on all 17 pages.
// 17 cold `next dev` compiles on Windows: 600 s for the walk.
test("T24 browser: every page shows the everyday name, the old name only in the footer line", async ({
  page,
}) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const problems: string[] = [];
  for (const route of ALL_PAGES) {
    await openPage(page, route);
    problems.push(...nameProblems(route, await readNames(page)));
  }
  expect(ALL_PAGES.length, "17 pages are walked").toBe(17);
  expect(problems, problems.join("\n")).toEqual([]);
});

// T26 name half, SA-1203: the signed-out front door at 1440x900 and 390x844 (logo half is switch day).
// 7 cold compiles at a size: 300 s.
for (const { w, h } of [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const) {
  test(`T26 name: the front door follows the brand file at ${w}x${h}`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: w, height: h });
    const problems: string[] = [];
    for (const route of FRONT_DOOR) {
      await openPage(page, route);
      problems.push(...nameProblems(`${route} ${w}x${h}`, await readNames(page)));
    }
    // the reset page needs a link token; with none it shows its own invalid-link state
    await openPage(page, "/reset-password");
    await expect(page.getByText("This reset link is invalid or incomplete")).toBeVisible();
    expect(problems, problems.join("\n")).toEqual([]);
  });
}

// T36, SA-1203: the header logo and name box fits its row (padding included), its siblings and the
// viewport; it reads boxes only, never the mark, so switch day re-runs it unedited. 12 pages: 300 s.
for (const w of [320, 390, 1440] as const) {
  test(`T36: the header logo and name do not overflow at ${w}`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: w, height: 800 });
    const problems: string[] = [];
    for (const route of PUBLIC_ROUTES) {
      await openPage(page, route);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const m = await page.evaluate(() => {
        const brand = document.querySelector<HTMLElement>(".brand");
        if (!brand) return null;
        const row = brand.closest<HTMLElement>(".wrap.nav") ?? brand.parentElement ?? brand;
        const cs = getComputedStyle(row);
        const b = brand.getBoundingClientRect();
        const c = row.getBoundingClientRect();
        const inner = [...brand.children].map((e) => e.getBoundingClientRect());
        const shown = (e: Element) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden";
        };
        const sibs = [...row.children]
          .filter((e) => e !== brand && shown(e))
          .flatMap((e) => [e, ...e.querySelectorAll("a, button")].filter(shown))
          .map((e) => {
            const r = e.getBoundingClientRect();
            const name = typeof e.className === "string" && e.className ? e.className : e.tagName;
            return { name, l: r.left, r: r.right, t: r.top, b: r.bottom };
          });
        return {
          scroll: brand.scrollWidth,
          client: brand.clientWidth,
          b: { l: b.left, r: b.right, t: b.top, b: b.bottom },
          // the row's content box: its box less its own padding
          c: { l: c.left + parseFloat(cs.paddingLeft), r: c.right - parseFloat(cs.paddingRight) },
          vw: window.innerWidth,
          innerRight: Math.max(0, ...inner.map((i) => i.right)),
          sibs,
        };
      });
      const at = `${route} @${w}`;
      if (!m) {
        problems.push(`${at}: no .brand box found`);
        continue;
      }
      if (m.scroll > m.client + 1)
        problems.push(`${at}: scrollWidth ${m.scroll} > clientWidth ${m.client}`);
      if (m.b.l < m.c.l - 0.5 || m.b.r > m.c.r + 0.5) problems.push(`${at}: box leaves its row`);
      if (m.b.l < -0.5 || m.b.r > m.vw + 0.5) problems.push(`${at}: box leaves the viewport`);
      if (m.innerRight > m.b.r + 0.5) problems.push(`${at}: logo or name spills out of the box`);
      for (const s of m.sibs) {
        const across = Math.min(m.b.r, s.r) - Math.max(m.b.l, s.l);
        const down = Math.min(m.b.b, s.b) - Math.max(m.b.t, s.t);
        if (across > 0.5 && down > 0.5) problems.push(`${at}: box meets "${s.name}"`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
}
