/**
 * Wave 3, lane 2.3-inner, project "site-waves": the seven inner pages hold to the role tokens.
 *   T20  the band table: each band of each page paints the role the table names, at 1440x900 and 390x844
 *   T15  every element with an opaque background that covers 25% or more of the window is white, bone or ink
 *   tiles carry no typed colour and sit white on a line or ink on bone; prices.js loads only with [data-plan]
 * Signed out, desktop Chrome, against a running stack (baseURL as in the other site specs). Role colours are read
 * from the page's own token style, never typed here. Each test gathers every problem and asserts once; a sweep
 * that finds nothing throws (L-202). No sleeps.
 */
import { test, expect, type Page } from "@playwright/test";
import { blockAnalytics, nonEmpty } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

type Role = "white" | "bone" | "ink";
const ROLE_TOKEN: Record<Role, string> = {
  white: "--rf-white",
  bone: "--rf-soft",
  ink: "--rf-panel",
};

/** [selector, role the band paints]. A band with no background of its own shows the page: white. */
const BANDS: Record<string, ReadonlyArray<readonly [string, Role]>> = {
  "/product": [
    [".pd-top", "white"],
    [".pd-all", "white"],
    [".pd-how", "bone"],
    [".pd-uses", "white"],
    [".pd-who", "bone"],
    [".pd-grow", "white"],
    [".pd-deep", "ink"],
    [".pd-end", "white"],
    [".cta-band", "ink"],
  ],
  "/company": [
    [".pd-top", "white"],
    [".co-story", "white"],
    [".co-ask", "bone"],
  ],
  "/contact": [
    [".pd-top", "white"],
    [".co-where", "white"],
  ],
  "/getting-started": [
    [".pd-top", "white"],
    [".gs-steps", "white"],
    [".pd-how", "bone"],
    [".pd-grow", "white"],
    [".pd-who", "bone"],
    [".gs-people", "white"],
    [".pd-deep", "ink"],
    [".pd-end", "white"],
    [".cta-band", "ink"],
  ],
  "/does-and-doesnt": [
    [".pd-top", "white"],
    [".pd-all", "white"],
    [".pd-deep", "ink"],
    [".pd-who", "bone"],
    [".pd-grow", "white"],
    [".pd-end", "white"],
    [".cta-band", "ink"],
  ],
  "/data-in-and-out": [
    [".pd-top", "white"],
    [".pd-grow", "white"],
    [".pd-deep", "ink"],
    [".pd-end", "white"],
    [".cta-band", "ink"],
  ],
  "/security": [
    [".pd-top", "white"],
    [".pd-all", "white"],
    [".pd-how", "bone"],
    [".pd-grow", "white"],
    [".pd-deep", "ink"],
    [".pd-end", "white"],
    [".cta-band", "ink"],
  ],
};

/** The pages that carry icon tiles (company and contact have none). */
const TILE_PAGES = new Set([
  "/product",
  "/getting-started",
  "/does-and-doesnt",
  "/data-in-and-out",
  "/security",
]);

const SCREENS = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const;

async function open(page: Page, route: string, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(route, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
}

/** The three role colours as the browser computes them, taken from the page's token style. */
async function roleColours(page: Page): Promise<Record<Role, string>> {
  return page.evaluate((tokens) => {
    const probe = document.createElement("i");
    document.body.appendChild(probe);
    const out: Record<string, string> = {};
    for (const [role, token] of Object.entries(tokens)) {
      probe.style.background = `var(${token})`;
      out[role] = getComputedStyle(probe).backgroundColor;
    }
    probe.remove();
    return out;
  }, ROLE_TOKEN) as Promise<Record<Role, string>>;
}

for (const [route, bands] of Object.entries(BANDS)) {
  for (const { w, h } of SCREENS) {
    test(`T20 band table: ${route} @${w}x${h}`, async ({ page }) => {
      await open(page, route, w, h);
      const roles = await roleColours(page);
      const seen = await page.evaluate(
        (rows) =>
          rows.map(([sel]) => {
            const el = document.querySelector(sel);
            if (!el) return { sel, found: false, bg: "", image: "" };
            // A band with no colour of its own shows the nearest opaque ancestor behind it.
            let bg = "";
            for (let p: Element | null = el; p; p = p.parentElement) {
              const c = getComputedStyle(p).backgroundColor;
              const m = c.match(/[\d.]+/g);
              if (m && m.length >= 3 && (m.length < 4 || Number(m[3]) > 0.95)) {
                bg = c;
                break;
              }
            }
            return { sel, found: true, bg, image: getComputedStyle(el).backgroundImage };
          }),
        bands.map(([sel]) => [sel]),
      );
      nonEmpty(seen, `bands on ${route}`);
      const problems: string[] = [];
      bands.forEach(([sel, role], i) => {
        const s = seen[i];
        if (!s.found) problems.push(`${sel} missing`);
        else if (s.bg !== roles[role])
          problems.push(`${sel} paints ${s.bg}, table says ${role} ${roles[role]}`);
        if (s.found && s.image !== "none")
          problems.push(`${sel} has a background image ${s.image}`);
      });
      expect(problems, `${route} @${w}x${h}: ${problems.join("; ")}`).toEqual([]);
    });

    test(`T15 no opaque area of 25% or more outside white, bone or ink: ${route} @${w}x${h}`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      await open(page, route, w, h);
      const roles = await roleColours(page);
      const allowed = new Set(Object.values(roles));
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      const found: string[] = [];
      let checked = 0;
      for (let y = 0; y < total; y += Math.round(h / 2)) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
        const rows = await page.evaluate(() => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const out: { name: string; bg: string; share: number }[] = [];
          for (const el of Array.from(document.body.querySelectorAll("*"))) {
            const bg = getComputedStyle(el).backgroundColor;
            const m = bg.match(/[\d.]+/g);
            if (!m || m.length < 3 || (m.length >= 4 && Number(m[3]) < 0.95)) continue;
            const r = el.getBoundingClientRect();
            const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
            const ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            const share = (iw * ih) / (vw * vh);
            if (share >= 0.25) {
              out.push({
                name: `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : ""}`,
                bg,
                share,
              });
            }
          }
          return out;
        });
        for (const r of rows) {
          checked++;
          if (!allowed.has(r.bg))
            found.push(`${r.name} ${r.bg} at ${Math.round(r.share * 100)}%, scroll ${y}`);
        }
      }
      expect(checked, "the sweep met at least one large opaque area").toBeGreaterThan(0);
      expect(found, `${route} @${w}x${h}: ${found.join("; ")}`).toEqual([]);
    });
  }

  test(`tiles carry no typed colour and prices.js loads only with [data-plan]: ${route}`, async ({
    page,
  }) => {
    await open(page, route, 1440, 900);
    const roles = await roleColours(page);
    const r = await page.evaluate(() => ({
      typed: Array.from(document.querySelectorAll('[style*="--pc"], [style*="--pi"]')).length,
      tiles: Array.from(document.querySelectorAll(".pd-ic")).map((el) => ({
        own: getComputedStyle(el).backgroundColor,
      })),
      loadsPrices: !!document.querySelector('script[src$="/prices.js"]'),
      hasPlans: !!document.querySelector("[data-plan]"),
    }));
    const problems: string[] = [];
    if (r.typed) problems.push(`${r.typed} elements still carry --pc or --pi`);
    if (TILE_PAGES.has(route)) nonEmpty(r.tiles, `.pd-ic tiles on ${route}`);
    for (const t of r.tiles) {
      if (t.own !== roles.white && t.own !== roles.bone) problems.push(`tile paints ${t.own}`);
    }
    if (r.loadsPrices !== r.hasPlans) {
      problems.push(`prices.js loaded=${r.loadsPrices}, [data-plan] present=${r.hasPlans}`);
    }
    expect(problems, `${route}: ${problems.join("; ")}`).toEqual([]);
  });
}

test("P15 markup: the last two words of #pd-h sit in one no-break span", async ({ page }) => {
  await open(page, "/product", 1440, 900);
  const h = await page.evaluate(() => {
    const el = document.querySelector("#pd-h");
    const nb = el?.querySelector(".nb");
    return {
      words: (el?.textContent ?? "").trim().split(/\s+/).length,
      nbWords: (nb?.textContent ?? "").trim().split(/\s+/).length,
      nbTail: !!nb && el?.lastElementChild === nb && nb.nextSibling === null,
      wrap: nb ? getComputedStyle(nb).whiteSpace : "",
    };
  });
  const problems: string[] = [];
  if (h.nbWords !== 2) problems.push(`.nb holds ${h.nbWords} words, not 2`);
  if (!h.nbTail) problems.push(".nb is not the tail of the headline");
  if (h.wrap !== "nowrap") problems.push(`.nb white-space is "${h.wrap}"`);
  expect(problems, `#pd-h: ${problems.join("; ")}`).toEqual([]);
});
