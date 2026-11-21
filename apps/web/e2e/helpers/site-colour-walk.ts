/**
 * One in-page walk for two rows (SA-1203, lead condition A5(a), coverage spec A11):
 *   T16   button and link colours, the focus ring, and text contrast (>= 4.5, or >= 3 for large text)
 *   T18c  every element's computed box-shadow is none or the ring
 *
 * The page does the reading (computed styles, effective backgrounds, focus); the spec does the judging.
 * Nothing here samples at random and nothing skips a failure:
 *   - a focusable element that is not rendered passes only through an equivalent element that IS measured at
 *     the same page and size (C1), or a reviewed T16_SIZE_ONLY entry (C2, empty);
 *   - every element is settled before it is read (C3): animations finished, and its rect, opacity and
 *     visibility unchanged for 3 consecutive frames (3 s cap per page part). One still changing is "unsettled", red;
 *   - the menu pass runs every check through the same code as the page pass (C4);
 *   - dark bands are found by colour, at every scroll position, not by a typed list (C6).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, type Page } from "@playwright/test";
import { PUBLIC_ROUTES, contrast, frames, installProbes } from "./site-proof";
import {
  T16_SIZE_ONLY,
  notRenderedProblems,
  otherSkipProblems,
  type FocusInfo,
  type Skip,
} from "./site-colour-walk-pure";

export { T16_SIZE_ONLY } from "./site-colour-walk-pure";

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
/** The settle cap per page part, in milliseconds (C3). */
export const SETTLE_CAP_MS = 3000;

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
type RingRow = FocusInfo & {
  band: string;
  bands: string[];
  style: string;
  width: number;
  color: string;
  bg: string | null;
};
type BandRow = { band: string; focusables: number; tokenOk: boolean };
export type Walk = {
  texts: TextRow[];
  buttons: ButtonRow[];
  links: LinkRow[];
  rings: RingRow[];
  focus: { found: number; measured: number; skipped: Skip[] };
  bandsOnPage: BandRow[];
  shadows: { el: string; shadow: string }[];
  ringShadow: string;
};

/** Optional steps a plant run uses to inject a defect without touching a site file (SA-1203 A11 plants). */
export type OpenHooks = {
  beforeGoto?: (page: Page) => Promise<void>;
  afterLoad?: (page: Page) => Promise<void>;
};

/** Opens a route at a size and waits until it has rendered (a visible .brand; an h1 on sign-in pages). */
export async function openForWalk(
  page: Page,
  route: string,
  size: { w: number; h: number },
  hooks: OpenHooks = {},
): Promise<void> {
  await installProbes(page);
  await page.setViewportSize({ width: size.w, height: size.h });
  await hooks.beforeGoto?.(page);
  await page.goto(route, { waitUntil: "load", timeout: 120_000 });
  await page.locator(".brand").first().waitFor({ state: "visible", timeout: 120_000 });
  if (SIGN_IN_ROUTES.includes(route))
    await page.locator("h1").first().waitFor({ state: "visible", timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await frames(page, 2);
  await hooks.afterLoad?.(page);
}

type Part = {
  part: "page" | "menu";
  menuShown: boolean;
  /** CSS selectors of T16_SIZE_ONLY entries for this page and size. */
  sizeOnly: string[];
  settleCapMs: number;
};

/** Collects, into window.__t16Bands, every element painted with the resolved --rf-panel at this scroll position. */
async function collectBands(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __t16Bands?: Set<Element> };
    const set = (w.__t16Bands ??= new Set<Element>());
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--rf-panel)";
    document.body.appendChild(probe);
    const panel = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const SKIP = /^(script|style|noscript|svg|canvas|template|head|title|meta|link)$/i;
    for (const e of document.body.querySelectorAll("*")) {
      if (SKIP.test(e.tagName) || e.closest("svg, canvas")) continue;
      if (getComputedStyle(e).backgroundColor === panel && e.getClientRects().length > 0)
        set.add(e);
    }
  });
}

/** Brings what is hidden into view: every <details> open, the whole page scrolled through once (so reveals run). */
async function prepare(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("details")) d.open = true;
  });
  await collectBands(page);
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const step = Math.max(200, Math.floor((page.viewportSize()?.height ?? 800) * 0.8));
  for (let y = 0; y < total; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await frames(page, 2);
    await collectBands(page);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await frames(page, 2);
}

async function walkPart(page: Page, arg: Part): Promise<Walk> {
  await collectBands(page);
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
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const body = document.body;
    const SKIP = /^(script|style|noscript|svg|canvas|template|head|title|meta|link)$/i;
    const inSvg = (e: Element) => !!e.closest("svg, canvas");
    const menu = document.getElementById("mobile-menu");
    // The part chooses which ELEMENTS are read; every check below runs for whichever it chose (C4).
    const inScope = (e: Element) => {
      const inMenu = !!menu && menu.contains(e);
      return arg.part === "menu" ? inMenu : !(inMenu && arg.menuShown);
    };
    const all = [...body.querySelectorAll("*")].filter(
      (e) => !SKIP.test(e.tagName) && !inSvg(e) && inScope(e),
    );
    const focusable = [
      ...body.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(inScope);

    // ── settle (C3): animations finished, then rect, opacity and visibility unchanged for 3 frames ──
    const deadline = performance.now() + arg.settleCapMs;
    await Promise.race([
      Promise.all(
        document.getAnimations().map((a) =>
          a.finished.then(
            () => 0,
            () => 0,
          ),
        ),
      ),
      new Promise<void>((r) => setTimeout(r, arg.settleCapMs)),
    ]);
    const sig = (e: Element) => {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return [r.x, r.y, r.width, r.height, cs.opacity, cs.visibility].join(",");
    };
    const last = new Map<Element, string>();
    const run = new Map<Element, number>();
    const stable = new Set<Element>();
    while (performance.now() < deadline && stable.size < focusable.length) {
      await frame();
      for (const e of focusable) {
        if (stable.has(e)) continue;
        const s = sig(e);
        if (last.get(e) === s) {
          const n = (run.get(e) ?? 1) + 1;
          run.set(e, n);
          if (n >= 3) stable.add(e);
        } else {
          last.set(e, s);
          run.set(e, 1);
        }
      }
    }

    // ── what is a focusable element, for the equivalence rule (C1) ──
    const nameOf = (e: HTMLElement): string => {
      const aria = e.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      const t = (e.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) return t;
      return (e.getAttribute("title") ?? "") || (e as HTMLInputElement).value || "";
    };
    const infoOf = (e: HTMLElement) => ({
      el: sp.name(e),
      tag: e.tagName.toLowerCase(),
      href: e instanceof HTMLAnchorElement ? e.href : null,
      name: nameOf(e),
      target: [
        e.getAttribute("form") || (e as HTMLButtonElement).form?.id || "",
        e.getAttribute("aria-controls") || "",
        e.getAttribute("data-track") || "",
      ].join("|"),
    });

    // ── dark bands, by colour (C6): everything painted with the resolved --rf-panel at any scroll position ──
    const bandSet = (window as unknown as { __t16Bands?: Set<Element> }).__t16Bands ?? new Set();
    const bandEls = [...bandSet].filter((b) => b.isConnected);
    const bandName = (b: Element) =>
      `${b.tagName.toLowerCase()}${b.id ? `#${b.id}` : ""}${[...b.classList]
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join("")}`;
    const bandsOf = (e: Element) =>
      bandEls.filter((b) => b !== e && b.contains(e)).map((b) => bandName(b));

    // ── texts, buttons, links (every part) ──
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
      if (!inScope(e) || !sp.shown(e)) continue;
      const cs = getComputedStyle(e);
      buttons.push({
        el: sp.name(e),
        bg: rgb(parse(cs.backgroundColor)),
        fg: rgb(parse(cs.color)),
      });
    }
    const links: LinkRow[] = [];
    for (const e of body.querySelectorAll("a.link, .band-ink a:not(.btn)")) {
      if (!inScope(e) || !sp.shown(e)) continue;
      const behind = bgOf(e.parentElement);
      links.push({
        el: sp.name(e),
        color: rgb(parse(getComputedStyle(e).color)),
        dark: behind ? lum(behind) < 0.2 : null,
      });
    }

    // ── focusable elements: settle, bring into view, focus, measure ──
    const rings: RingRow[] = [];
    const skipped: Skip[] = [];
    const skip = (e: HTMLElement, reason: string) =>
      skipped.push({
        ...infoOf(e),
        reason,
        sizeOnly: arg.sizeOnly.some((s) => {
          try {
            return e.matches(s);
          } catch {
            return false;
          }
        }),
      });
    for (const e of focusable) {
      if ((e as HTMLButtonElement).disabled) {
        skip(e, "disabled");
        continue;
      }
      if (e.closest("[inert]")) {
        skip(e, "inert");
        continue;
      }
      if (e.closest("dialog:not([open])")) {
        skip(e, "closed-dialog");
        continue;
      }
      if (!stable.has(e)) {
        skip(e, "unsettled");
        continue;
      }
      // Bring it into view; an element that only shows on focus (the skip link) is focused first.
      e.scrollIntoView({ block: "center" });
      e.focus({ focusVisible: true } as FocusOptions);
      await frame();
      await frame();
      if (e.getClientRects().length === 0 || getComputedStyle(e).visibility === "hidden") {
        skip(e, "not-rendered");
        continue;
      }
      if (document.activeElement !== e) {
        skip(e, "focus-refused");
        continue;
      }
      const cs = getComputedStyle(e);
      const behind = bgOf(e.parentElement);
      const bands = bandsOf(e);
      rings.push({
        ...infoOf(e),
        bands,
        band: bands[0] ?? "light",
        style: cs.outlineStyle,
        width: parseFloat(cs.outlineWidth),
        color: rgb(parse(cs.outlineColor)),
        bg: behind ? rgb(behind) : null,
      });
      e.blur();
    }

    // A band found by colour that holds focusables, and whether it carries the on-panel ring token (A10).
    const rootOnPanel = getComputedStyle(document.documentElement)
      .getPropertyValue("--rf-on-panel")
      .trim()
      .toLowerCase();
    const bandRows = new Map<string, BandRow>();
    for (const b of bandEls) {
      const n = focusable.filter((e) => e !== b && b.contains(e)).length;
      if (n === 0) continue;
      const name = bandName(b);
      const ok =
        getComputedStyle(b).getPropertyValue("--rf-focus").trim().toLowerCase() === rootOnPanel;
      const cur = bandRows.get(name) ?? { band: name, focusables: 0, tokenOk: true };
      bandRows.set(name, {
        band: name,
        focusables: cur.focusables + n,
        tokenOk: cur.tokenOk && ok,
      });
    }

    // ── box-shadow (T18c), every part ──
    const probe = document.createElement("div");
    probe.style.boxShadow = "var(--rf-ring)";
    body.appendChild(probe);
    const ringShadow = getComputedStyle(probe).boxShadow;
    probe.remove();
    const shadows: { el: string; shadow: string }[] = [];
    const shadowEls = arg.part === "menu" ? all : [document.documentElement, body, ...all];
    for (const e of shadowEls) {
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
      focus: { found: focusable.length, measured: rings.length, skipped },
      bandsOnPage: [...bandRows.values()],
    };
  }, arg);
}

const isLarge = (r: TextRow) => r.size >= 24 || (r.size >= 18.66 && r.weight >= 700);

/** The found / measured / skipped-by-reason line for one page and size (the report, not a pin: C5). */
export function focusTable(label: string, walk: Walk): string {
  const byReason: Record<string, number> = {};
  for (const s of walk.focus.skipped) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  const reasons = Object.entries(byReason)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return `${label}: found ${walk.focus.found}, measured ${walk.focus.measured}, skipped ${walk.focus.skipped.length}${reasons ? ` (${reasons})` : ""}; text elements ${walk.texts.length}`;
}

/** T16: gathers every problem; the caller asserts once. `label` is "<page> <size>". */
export function judgeColours(
  walk: Walk,
  label: string,
): { problems: string[]; report: string[]; accepted: number } {
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
  // C1 over every not-rendered skip; every other reason (unsettled, focus-refused, ...) is red.
  problems.push(...otherSkipProblems(label, walk.focus.skipped));
  const nr = notRenderedProblems(label, walk.focus.skipped, walk.rings);
  problems.push(...nr.problems);
  // C6: a band found by colour holds focusables, all measured, and carries the on-panel ring token.
  for (const b of walk.bandsOnPage) {
    const n = walk.rings.filter((r) => r.bands.includes(b.band)).length;
    if (b.focusables > 0 && n === 0)
      problems.push(`band ${b.band}: ${b.focusables} focusables, none measured`);
    if (!b.tokenOk)
      problems.push(
        `band ${b.band} is painted with the panel colour but does not set --rf-focus to the on-panel token`,
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
  report.push(focusTable(label, walk));
  return { problems, report, accepted: nr.accepted };
}

/** T18c: every element's box-shadow is none or the ring. */
export function judgeShadows(walk: Walk): string[] {
  const out: string[] = [];
  expect(walk.ringShadow).not.toBe("none");
  for (const s of walk.shadows)
    if (s.shadow !== walk.ringShadow) out.push(`${s.el}: ${s.shadow} is not the ring`);
  return out;
}

/** Reads everything both rows need. Keyboard modality first, so a focus() shows the ring; the mobile menu is opened for its own pass, read by the same code. */
export async function readWalk(
  page: Page,
  route: string,
  size: { w: number; h: number },
): Promise<Walk> {
  const sizeKey = `${size.w}x${size.h}`;
  const sizeOnly = T16_SIZE_ONLY.filter((e) => e.page === route && e.size === sizeKey).map(
    (e) => e.selector,
  );
  await page.keyboard.press("Tab");
  await prepare(page);
  const menuBtn = page.locator(".menu-btn").first();
  const menuShown = (await menuBtn.count()) > 0 && (await menuBtn.isVisible());
  const base = { menuShown, sizeOnly, settleCapMs: SETTLE_CAP_MS };
  const main = await walkPart(page, { ...base, part: "page" });
  if (!menuShown) return main;
  await menuBtn.click();
  await frames(page, 3);
  const menu = await walkPart(page, { ...base, part: "menu" });
  const bands = new Map<string, BandRow>();
  for (const b of [...main.bandsOnPage, ...menu.bandsOnPage]) {
    const cur = bands.get(b.band);
    bands.set(b.band, {
      band: b.band,
      focusables: (cur?.focusables ?? 0) + b.focusables,
      tokenOk: (cur?.tokenOk ?? true) && b.tokenOk,
    });
  }
  return {
    texts: [...main.texts, ...menu.texts],
    buttons: [...main.buttons, ...menu.buttons],
    links: [...main.links, ...menu.links],
    rings: [...main.rings, ...menu.rings],
    shadows: [...main.shadows, ...menu.shadows],
    ringShadow: main.ringShadow,
    focus: {
      found: main.focus.found + menu.focus.found,
      measured: main.focus.measured + menu.focus.measured,
      skipped: [...main.focus.skipped, ...menu.focus.skipped],
    },
    bandsOnPage: [...bands.values()],
  };
}
