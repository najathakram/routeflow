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

/** The 17 signed-out pages: the 12 public routes and the five sign-in pages. */
export const AUTH_ROUTES = [
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/admin-login",
] as const;
export const WALK_ROUTES = [...PUBLIC_ROUTES, ...AUTH_ROUTES] as const;
export const SIGN_IN_ROUTES: readonly string[] = AUTH_ROUTES;
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
export async function readWalk(page: Page): Promise<Walk> {
  await page.keyboard.press("Tab");
  return page.evaluate(() => {
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
    for (const e of all) {
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
    for (const e of body.querySelectorAll(".btn-primary, .btn-light")) {
      if (!sp.shown(e)) continue;
      const cs = getComputedStyle(e);
      buttons.push({
        el: sp.name(e),
        bg: rgb(parse(cs.backgroundColor)),
        fg: rgb(parse(cs.color)),
      });
    }

    const links: LinkRow[] = [];
    for (const e of body.querySelectorAll("a.link, .band-ink a:not(.btn)")) {
      if (!sp.shown(e)) continue;
      const behind = bgOf(e.parentElement);
      links.push({
        el: sp.name(e),
        color: rgb(parse(getComputedStyle(e).color)),
        dark: behind ? lum(behind) < 0.2 : null,
      });
    }

    const BANDS = [".price", ".pb", ".end", ".pcard.featured", ".band-ink", ".cta-band", ".risk"];
    const rings: RingRow[] = [];
    const focusable = body.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
    );
    for (const e of focusable) {
      if (!sp.shown(e) || (e as HTMLButtonElement).disabled) continue;
      e.focus({ focusVisible: true } as FocusOptions);
      if (document.activeElement !== e) continue;
      const cs = getComputedStyle(e);
      const behind = bgOf(e.parentElement);
      rings.push({
        el: sp.name(e),
        band: BANDS.find((b) => e.closest(b)) ?? "light",
        style: cs.outlineStyle,
        width: parseFloat(cs.outlineWidth),
        color: rgb(parse(cs.outlineColor)),
        bg: behind ? rgb(behind) : null,
      });
      e.blur();
    }

    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--rf-ring)";
    body.appendChild(probe);
    const ringShadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    const shadows: { el: string; shadow: string }[] = [];
    for (const e of [document.documentElement, body, ...all]) {
      const s = getComputedStyle(e).boxShadow;
      if (s !== "none") shadows.push({ el: sp.name(e), shadow: s });
    }
    return { texts, buttons, links, rings, shadows, ringShadow };
  });
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
