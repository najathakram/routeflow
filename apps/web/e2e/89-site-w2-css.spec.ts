/**
 * Wave 2, lane 2.1b (the shared stylesheets), project "site-waves": T42 (focus ring contrast), T46a (the gap above a
 * plan button), P04 (no glow under the header on a phone home). Signed out, desktop Chrome, against a running stack
 * (baseURL as in the other site specs). Each test gathers every problem and asserts once; a sweep that finds nothing
 * throws (L-202).
 */
import { test, expect, type Page } from "@playwright/test";
import { blockAnalytics, contrast, nonEmpty } from "./helpers/site-proof";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

async function open(page: Page, route: string, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto(route, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
}

// ─── T42 ────────────────────────────────────────────────────────────────────

type Stop = {
  name: string;
  ring: string;
  style: string;
  width: number;
  bg: string;
  inWheel: boolean;
};

/** The element holding focus: its ring colour and the colour of the surface behind that ring. */
async function stopNow(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) return null;
    const s = getComputedStyle(el);
    const opaque = (c: string) => {
      const m = c.match(/[\d.]+/g);
      return !!m && m.length >= 3 && (m.length < 4 || Number(m[3]) > 0.95);
    };
    // The surface behind the ring is the nearest ancestor with an opaque background colour.
    let bg = "rgb(255, 255, 255)";
    for (let p = el.parentElement; p; p = p.parentElement) {
      const c = getComputedStyle(p).backgroundColor;
      if (opaque(c)) {
        bg = c;
        break;
      }
    }
    const label =
      el.getAttribute("aria-label") ||
      (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
    return {
      name: `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""} "${label}"`,
      ring: s.outlineColor,
      style: s.outlineStyle,
      width: parseFloat(s.outlineWidth) || 0,
      bg,
      inWheel: !!el.closest(".rfw"),
    };
  });
}

const PAGES = ["/", "/pricing", "/product"] as const;
const SCREENS = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const;

for (const route of PAGES) {
  for (const { w, h } of SCREENS) {
    test(`T42 every focus ring holds 3:1 against its surface: ${route} @${w}x${h}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await open(page, route, w, h);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const stops: Stop[] = [];
      let first = "";
      for (let i = 0; i < 160; i++) {
        await page.keyboard.press("Tab");
        const s = await stopNow(page);
        if (!s) break;
        if (i === 0) first = s.name;
        else if (s.name === first && stops.length > 5) break;
        stops.push(s);
      }
      nonEmpty(stops, `focusable controls on ${route}`);
      const problems: string[] = [];
      if (stops.length < 20)
        problems.push(`only ${stops.length} focusable controls, expected 20 or more`);
      for (const s of stops) {
        if (s.style === "none" || s.width < 2) {
          if (!s.inWheel) problems.push(`${s.name}: no ring (${s.style} ${s.width}px)`);
          continue;
        }
        const ratio = contrast(s.ring, s.bg);
        if (ratio < 3)
          problems.push(`${s.name}: ring ${s.ring} on ${s.bg} is ${ratio.toFixed(2)}:1`);
      }
      expect(problems, `${route} @${w}x${h}: ${problems.join("; ")}`).toEqual([]);
    });
  }
}

// ─── T46a ───────────────────────────────────────────────────────────────────

type Gap = { where: string; gap: number };

/** For each plan: the space between the last content block and the button under it, in px. */
async function planGaps(page: Page, scope: string): Promise<Gap[]> {
  return page.evaluate((root) => {
    const out: { where: string; gap: number }[] = [];
    const base = document.querySelector(root);
    if (!base) throw new Error(`no ${root}`);
    const shown = (el: Element) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };
    const lastBlockAbove = (btn: Element): Element | null => {
      for (let n = btn.previousElementSibling; n; n = n.previousElementSibling)
        if (shown(n)) return n;
      return null;
    };
    // The bottom of the last text line in a block (its box may stretch past the words), else the box.
    const textBottom = (el: Element): number => {
      let b = -Infinity;
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!(n.textContent ?? "").trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        for (const q of Array.from(r.getClientRects())) if (q.height > 0) b = Math.max(b, q.bottom);
      }
      // Painted leaves with no text of their own (an svg, an img, an empty bar) are seen too.
      for (const leaf of Array.from(el.querySelectorAll("*"))) {
        const isSvg = leaf.tagName.toLowerCase() === "svg";
        if (!isSvg && leaf.closest("svg")) continue;
        const empty = leaf.children.length === 0 && !(leaf.textContent ?? "").trim();
        if (!isSvg && leaf.tagName.toLowerCase() !== "img" && !empty) continue;
        const r = leaf.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) b = Math.max(b, r.bottom);
      }
      return b === -Infinity ? el.getBoundingClientRect().bottom : b;
    };
    // Cards (wide) first; the phone list's one button when no card shows.
    for (const card of Array.from(base.querySelectorAll(".pcard")).filter(shown)) {
      const btn = card.querySelector(".pbtn");
      if (!btn || !shown(btn)) continue;
      const above = lastBlockAbove(btn);
      if (!above) continue;
      const name = (card.querySelector("h2,h3")?.textContent ?? "plan").trim();
      out.push({
        where: name,
        gap: btn.getBoundingClientRect().top - textBottom(above),
      });
    }
    if (!out.length) {
      // A phone shows a list, not cards: each visible button in the section against the block just above it.
      for (const btn of Array.from(base.querySelectorAll(".btn")).filter(shown)) {
        let above: Element | null = null;
        for (let n: Element | null = btn; n && n !== base && !above; n = n.parentElement) {
          above = lastBlockAbove(n);
        }
        if (!above) continue;
        out.push({
          where: (btn.textContent ?? "button").trim(),
          gap: btn.getBoundingClientRect().top - textBottom(above),
        });
      }
    }
    return out;
  }, scope);
}

for (const { route, scope } of [
  { route: "/pricing", scope: "#pricing" },
  { route: "/", scope: "#pricing" },
] as const) {
  for (const { w, h } of [
    { w: 1440, h: 900 },
    { w: 393, h: 844 },
  ] as const) {
    test(`T46a the gap above a plan button is 32px or less: ${route} #pricing @${w}x${h}`, async ({
      page,
    }) => {
      await open(page, route, w, h);
      const gaps = nonEmpty(await planGaps(page, scope), `plan buttons on ${route}`);
      if (w === 1440) expect(gaps.length, "plan cards at 1440").toBeGreaterThanOrEqual(4);
      const bad = gaps.filter((g) => g.gap > 32);
      expect(
        bad,
        `${route} @${w}: ${gaps.map((g) => `${g.where} ${g.gap.toFixed(0)}px`).join(", ")}`,
      ).toEqual([]);
    });
  }
}

// ─── P04 ────────────────────────────────────────────────────────────────────

test("P04 no gradient under the header on the home hero at 393", async ({ page }) => {
  await open(page, "/", 393, 844);
  const layers = await page.evaluate(() => {
    const out: { sel: string; image: string }[] = [];
    for (const sel of [".hx-over", ".hx-up .hx-over", ".hx", ".hx-up", ".hx-lay"]) {
      for (const el of Array.from(document.querySelectorAll(sel))) {
        out.push({ sel, image: getComputedStyle(el).backgroundImage });
      }
    }
    return out;
  });
  nonEmpty(layers, "hero layers");
  expect(layers.some((l) => l.sel === ".hx-over")).toBe(true);
  const bad = layers.filter((l) => /gradient\(/.test(l.image));
  expect(bad, `gradient under the header: ${JSON.stringify(bad)}`).toEqual([]);
});
