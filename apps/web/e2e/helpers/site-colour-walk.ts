/**
 * One in-page walk for two rows (SA-1203, lead condition A5(a)):
 *   T16   button and link colours, the focus ring, and text contrast (>= 4.5, or >= 3 for large text)
 *   T18c  every element's computed box-shadow is none or the ring
 *
 * The page does the reading (computed styles, effective backgrounds, focus); the spec does the judging.
 * Nothing here samples at random and nothing skips a failure: an element whose background cannot be
 * resolved (a picture behind it) is counted as "unresolved", never as passing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, type Page } from "@playwright/test";
import { PUBLIC_ROUTES, contrast, frames, installProbes } from "./site-proof";

/** The 17 signed-out pages: the 12 public routes, four sign-in pages and one 404 path. Mirrors the 2.5b T24 walk, so the two can share one list after the lanes merge. */
export const SIGN_IN_PAGES = ["/login", "/signup", "/reset-password", "/buyer/login"] as const;
export const NOT_FOUND_PAGE = "/this-page-does-not-exist";
export const WALK_ROUTES = [...PUBLIC_ROUTES, ...SIGN_IN_PAGES, NOT_FOUND_PAGE] as const;
export const SIGN_IN_ROUTES: readonly string[] = SIGN_IN_PAGES;
export const WALK_SIZES = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const;
/** At least this many text elements are walked on every page and size. */
export const MIN_TEXT_ELEMENTS = 50;

const PALETTE = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../../packages/types/brand/palette.json"), "utf8"),
) as { color: Record<string, string> };
const rgbOf = (hex: string): string => {
  const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${n.join(", ")})`;
};
export const INK = rgbOf(PALETTE.color.ink);
export const WHITE = rgbOf(PALETTE.color.white);
export const LINK_ON_LIGHT = rgbOf(PALETTE.color["copper-dark"]);
export const LINK_ON_DARK = rgbOf(PALETTE.color["copper-light"]);

type TextRow = { el: string; fg: string; bg: string | null; size: number; weight: number };
type ButtonRow = { el: string; bg: string; fg: string };
type LinkRow = { el: string; color: string; dark: boolean | null };
type RingRow = {
  el: string;
  band: string;
  bands: string[];
  style: string;
  width: number;
  color: string;
  bg: string | null;
};
export type Walk = {
  texts: TextRow[];
  buttons: ButtonRow[];
  links: LinkRow[];
  rings: RingRow[];
  focus: { found: number; measured: number; skipped: { el: string; reason: string }[] };
  bandsOnPage: { band: string; focusables: number }[];
  shadows: { el: string; shadow: string }[];
  ringShadow: string;
};

/** Opens a route at a size and waits until it has rendered (a visible .brand; an h1 on sign-in pages). */
export async function openForWalk(
  page: Page,
  route: string,
  size: { w: number; h: number },
): Promise<void> {
  await installProbes(page);
  await page.setViewportSize({ width: size.w, height: size.h });
  await page.goto(route, { waitUntil: "load", timeout: 120_000 });
  await page.locator(".brand").first().waitFor({ state: "visible", timeout: 120_000 });
  if (SIGN_IN_ROUTES.includes(route))
    await page.locator("h1").first().waitFor({ state: "visible", timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await frames(page, 2);
}

/** Reads everything both rows need, in one pass. Keyboard modality first, so a focus() shows the ring. */
type Part = { part: "page" | "menu"; menuShown: boolean };

/** Brings what is hidden into view: every <details> open, the whole page scrolled through once (so reveals run). */
async function prepare(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("details")) d.open = true;
  });
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.max(200, Math.floor((page.viewportSize()?.height ?? 800) * 0.8));
  for (let y = 0; y < total; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await frames(page, 2);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await frames(page, 2);
}

async function walkPart(page: Page, arg: Part): Promise<Walk> {
  return page.evaluate(async (arg: Part) => {
    type Rgba = [number, number, number, number];
    const parse = (c: string): Rgba => {
      const m = c.match(/[\d.]+/g) ?? ["0", "0", "0", "0"];
      return [Number(m[0]), Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])];
    };
    const rgb = (c: Rgba) => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
    const over = (top: Rgba, under: Rgba): Rgba => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const f = (i: 0 | 1 | 2) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
      return [f(0), f(1), f(2), a];
    };
    /** The opaque colour behind an element, or null when a picture or gradient sits behind it. */
    const bgOf = (start: Element | null): Rgba | null => {
      const layers: Rgba[] = [];
      for (let e = start; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage !== "none") return null;
        const c = parse(cs.backgroundColor);
        if (c[3] > 0) layers.push(c);
        if (c[3] === 1) break;
      }
      let acc: Rgba = [255, 255, 255, 1];
      for (const l of layers.reverse()) acc = over(l, acc);
      return acc;
    };
    const lum = (c: Rgba) => {
      const [r, g, b] = [c[0], c[1], c[2]].map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const sp = (
      window as unknown as { __sp: { shown(e: Element): boolean; name(e: Element): string } }
    ).__sp;
    const body = document.body;
    const SKIP = /^(script|style|noscript|svg|canvas|template|head|title|meta|link)$/i;
    const inSvg = (e: Element) => !!e.closest("svg, canvas");
    const all = [...body.querySelectorAll("*")].filter((e) => !SKIP.test(e.tagName) && !inSvg(e));

    const texts: TextRow[] = [];
    for (const e of arg.part === "page" ? all : []) {
      const own = [...e.childNodes].some(
        (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
      );
      if (!own || !sp.shown(e)) continue;
      const cs = getComputedStyle(e);
      const bg = bgOf(e);
      let fg = parse(cs.color);
      if (bg && fg[3] < 1) fg = over(fg, bg);
      texts.push({
        el: sp.name(e),
        fg: rgb(fg),
        bg: bg ? rgb(bg) : null,
        size: parseFloat(cs.fontSize),
        weight: Number(cs.fontWeight),
      });
    }

    const buttons: ButtonRow[] = [];
    for (const e of arg.part === "page" ? body.querySelectorAll(".btn-primary, .btn-light") : []) {
      if (!sp.shown(e)) continue;
      const cs = getComputedStyle(e);
      buttons.push({
        el: sp.name(e),
        bg: rgb(parse(cs.backgroundColor)),
        fg: rgb(parse(cs.color)),
      });
    }

    const links: LinkRow[] = [];
    for (const e of arg.part === "page"
      ? body.querySelectorAll("a.link, .band-ink a:not(.btn)")
      : []) {
      if (!sp.shown(e)) continue;
      const behind = bgOf(e.parentElement);
      links.push({
        el: sp.name(e),
        color: rgb(parse(getComputedStyle(e).color)),
        dark: behind ? lum(behind) < 0.2 : null,
      });
    }

    // Every band the page paints with the panel, so a missing measurement inside one is found (SA-1203 A10).
    const BANDS = [
      ".price",
      ".pb",
      ".end",
      ".pcard.featured",
      ".band-ink",
      ".cta-band",
      ".risk",
      ".carry",
      ".pd-deep",
      "#founder .fd-in",
      ".site-header.on-dark",
    ];
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const rings: RingRow[] = [];
    const skipped: { el: string; reason: string }[] = [];
    let found = 0;
    const menu = document.getElementById("mobile-menu");
    const focusable = [
      ...body.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((e) => {
      const inMenu = !!menu && menu.contains(e);
      if (arg.part === "menu") return inMenu;
      return !(inMenu && arg.menuShown);
    });
    for (const e of focusable) {
      found++;
      const reason = ((): string | null => {
        if ((e as HTMLButtonElement).disabled) return "disabled";
        if (e.closest("[inert]")) return "inert";
        if (e.closest("dialog:not([open])")) return "closed-dialog";
        return null;
      })();
      if (reason) {
        skipped.push({ el: sp.name(e), reason });
        continue;
      }
      // Bring it into view; an element that only shows on focus (the skip link) is focused first.
      e.scrollIntoView({ block: "center" });
      e.focus({ focusVisible: true } as FocusOptions);
      await frame();
      await frame();
      if (e.getClientRects().length === 0 || getComputedStyle(e).visibility === "hidden") {
        skipped.push({ el: sp.name(e), reason: "not-rendered" });
        continue;
      }
      if (document.activeElement !== e) {
        skipped.push({ el: sp.name(e), reason: "focus-refused" });
        continue;
      }
      const cs = getComputedStyle(e);
      const behind = bgOf(e.parentElement);
      rings.push({
        el: sp.name(e),
        bands: BANDS.filter((b) => e.closest(b)),
        band: BANDS.find((b) => e.closest(b)) ?? "light",
        style: cs.outlineStyle,
        width: parseFloat(cs.outlineWidth),
        color: rgb(parse(cs.outlineColor)),
        bg: behind ? rgb(behind) : null,
      });
      e.blur();
    }
    // A band on the page with a focusable element inside it, and how many of those were measured.
    const bandsOnPage = BANDS.filter((b) => body.querySelector(b)).map((b) => ({
      band: b,
      focusables: focusable.filter((e) => e.closest(b)).length,
    }));

    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--rf-ring)";
    body.appendChild(probe);
    const ringShadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    const shadows: { el: string; shadow: string }[] = [];
    for (const e of arg.part === "page" ? [document.documentElement, body, ...all] : []) {
      const s = getComputedStyle(e).boxShadow;
      if (s !== "none") shadows.push({ el: sp.name(e), shadow: s });
    }
    return {
      texts,
      buttons,
      links,
      rings,
      shadows,
      ringShadow,
      focus: { found, measured: rings.length, skipped },
      bandsOnPage,
    };
  }, arg);
}

const isLarge = (r: TextRow) => r.size >= 24 || (r.size >= 18.66 && r.weight >= 700);

/** T16: gathers every problem; the caller asserts once. Returns the per-band ring report too. */
export function judgeColours(walk: Walk): { problems: string[]; report: string[] } {
  const problems: string[] = [];
  const walked = walk.texts.filter((t) => t.bg !== null);
  if (walked.length < MIN_TEXT_ELEMENTS)
    problems.push(`only ${walked.length} text elements walked (need ${MIN_TEXT_ELEMENTS})`);
  for (const t of walked) {
    const need = isLarge(t) ? 3 : 4.5;
    const got = contrast(t.fg, t.bg as string);
    if (got < need) problems.push(`text ${t.el}: ${got.toFixed(2)} < ${need} (${t.fg} on ${t.bg})`);
  }
  for (const b of walk.buttons) {
    const ok = (b.bg === INK && b.fg === WHITE) || (b.bg === WHITE && b.fg === INK);
    if (!ok) problems.push(`button ${b.el}: ${b.fg} on ${b.bg}, not white on ink or ink on white`);
  }
  for (const l of walk.links) {
    if (l.dark === null) continue;
    const want = l.dark ? LINK_ON_DARK : LINK_ON_LIGHT;
    if (l.color !== want)
      problems.push(
        `link ${l.el}: ${l.color} on a ${l.dark ? "dark" : "light"} band, want ${want}`,
      );
  }
  for (const k of walk.focus.skipped)
    if (!(ALLOWED_SKIPS as readonly string[]).includes(k.reason))
      problems.push(`focusable ${k.el} not measured: ${k.reason}`);
  if (walk.focus.measured + walk.focus.skipped.length !== walk.focus.found)
    problems.push(
      `focusables: found ${walk.focus.found}, measured ${walk.focus.measured}, skipped ${walk.focus.skipped.length}`,
    );
  for (const b of walk.bandsOnPage) {
    const n = walk.rings.filter((r) => r.bands.includes(b.band)).length;
    if (b.focusables > 0 && n === 0)
      problems.push(`band ${b.band}: ${b.focusables} focusables, none measured`);
  }
  const perBand = new Map<string, { min: number; n: number }>();
  for (const r of walk.rings) {
    if (r.style === "none" || r.width <= 0) {
      problems.push(`ring ${r.el}: no outline when focused`);
      continue;
    }
    if (r.bg === null) {
      problems.push(`ring ${r.el}: band behind it unresolved (picture)`);
      continue;
    }
    const got = contrast(r.color, r.bg);
    const cur = perBand.get(r.band) ?? { min: Infinity, n: 0 };
    perBand.set(r.band, { min: Math.min(cur.min, got), n: cur.n + 1 });
    if (got < 3)
      problems.push(`ring ${r.el} on ${r.band}: ${got.toFixed(2)} < 3 (${r.color} on ${r.bg})`);
  }
  const report = [...perBand].map(
    ([band, v]) => `${band}: min ${v.min.toFixed(2)}:1 over ${v.n} focusable elements`,
  );
  report.push(
    `focusables: found ${walk.focus.found}, measured ${walk.focus.measured}, skipped ${walk.focus.skipped.length}` +
      (walk.focus.skipped.length ? ` (${walk.focus.skipped.map((k) => k.reason).join(", ")})` : ""),
  );
  return { problems, report };
}

/** T18c: every element's box-shadow is none or the ring. */
export function judgeShadows(walk: Walk): string[] {
  const out: string[] = [];
  expect(walk.ringShadow).not.toBe("none");
  for (const s of walk.shadows)
    if (s.shadow !== walk.ringShadow) out.push(`${s.el}: ${s.shadow} is not the ring`);
  return out;
}

/** Why a focusable element may go unmeasured. Anything else is a red, never a skip. */
export const ALLOWED_SKIPS = ["disabled", "inert", "closed-dialog", "not-rendered"] as const;

/** Reads everything both rows need. Keyboard modality first, so a focus() shows the ring; the mobile menu is opened for its own pass. */
export async function readWalk(page: Page): Promise<Walk> {
  await page.keyboard.press("Tab");
  await prepare(page);
  const menuBtn = page.locator(".menu-btn").first();
  const menuShown = (await menuBtn.count()) > 0 && (await menuBtn.isVisible());
  const main = await walkPart(page, { part: "page", menuShown });
  if (!menuShown) return main;
  await menuBtn.click();
  await frames(page, 3);
  const menu = await walkPart(page, { part: "menu", menuShown });
  return {
    ...main,
    rings: [...main.rings, ...menu.rings],
    focus: {
      found: main.focus.found + menu.focus.found,
      measured: main.focus.measured + menu.focus.measured,
      skipped: [...main.focus.skipped, ...menu.focus.skipped],
    },
    bandsOnPage: main.bandsOnPage.map((b) => ({
      band: b.band,
      focusables: b.focusables + (menu.bandsOnPage.find((m) => m.band === b.band)?.focusables ?? 0),
    })),
  };
}
