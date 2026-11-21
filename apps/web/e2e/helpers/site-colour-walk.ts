/**
 * One Tab walk for two rows (SA-1203 A12, the panel record's S1-S15 and K1-K4):
 *   T16   button and link colours, the focus ring, and text contrast (>= 4.5, or >= 3 for large text)
 *   T18c  every element's computed box-shadow is none or the ring
 *
 * Every row means "this element, in the state a keyboard visitor creates":
 *   - S2  a real Tab walk from the top of the page; the browser picks the element and its own scroll;
 *   - S1  ONE reader, `settleThenRead`, reads every ring, text and button after that element has settled;
 *   - S3  settled = scrollY, the element and its ancestors, the ring and the backdrop equal for 3 frames, 1200 ms cap;
 *         nothing is paused, finished or sped up, and the site carries no test hook;
 *   - S5  a focus stop that is out of view or covered is `obscured` (red); the walk never writes scroll between a
 *         Tab and its read, and the drift is recorded;
 *   - S8  the header is read in both of its states, the dark one at stops found by colour in the live DOM;
 *   - S9  the phone menu is opened with Enter and walked with Tab;
 *   - S10 a focusable nothing reached passes only through an equivalent element that was measured (C1) or a
 *         reviewed T16_SIZE_ONLY entry that names its one state (C2, K3).
 * The page does the reading; the pure half (site-colour-walk-pure.ts) and this file's judge do the judging.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, devices, expect, test, type Page } from "@playwright/test";
import {
  PUBLIC_ROUTES,
  blockAnalytics,
  contrast,
  frames,
  installProbes,
  sizeName,
} from "./site-proof";
import {
  CROPS_PER_PAGE,
  CROPS_PER_RUN,
  HEADER_STRIP_TOP,
  BAND_WIDTH_SHARE,
  MIN_TEXT_ELEMENTS,
  SETTLE_CAP_MS,
  SETTLE_STABLE_FRAMES,
  T16_SIZE_ONLY,
  TAB_CAP_EXTRA,
  WALK_BUDGET_MS,
  WALK_PAGE_HARD_MS,
  WALK_RUN_HARD_MS,
  headerStateProblems,
  readProblems,
  redLine,
  reproOf,
  settleRecord,
  sizeOnlyEntryProblems,
  staleExemptions,
  unreachedProblems,
  type ButtonRow,
  type LinkRow,
  type Part,
  type RingRead,
  type Skip,
  type TextRow,
  type UnreadRow,
} from "./site-colour-walk-pure";

export {
  T16_SIZE_ONLY,
  MIN_TEXT_ELEMENTS,
  SETTLE_CAP_MS,
  WALK_PAGE_HARD_MS,
} from "./site-colour-walk-pure";

/** The 17 signed-out pages: the 12 public routes, four sign-in pages and one 404 path. Mirrors the 2.5b T24 walk, so the two can share one list after the lanes merge. */
export const SIGN_IN_PAGES = ["/login", "/signup", "/reset-password", "/buyer/login"] as const;
export const NOT_FOUND_PAGE = "/this-page-does-not-exist";
export const WALK_ROUTES = [...PUBLIC_ROUTES, ...SIGN_IN_PAGES, NOT_FOUND_PAGE] as const;
export const SIGN_IN_ROUTES: readonly string[] = SIGN_IN_PAGES;
export const WALK_SIZES = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const;

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

/** What the walk read for one page and size. */
export type Walk = {
  label: string;
  route: string;
  size: { w: number; h: number };
  /** The short sha of the checkout the walk ran from (S14). */
  sha: string;
  rows: RingRead[];
  texts: TextRow[];
  buttons: ButtonRow[];
  links: LinkRow[];
  unread: UnreadRow[];
  unreached: Skip[];
  shadows: { el: string; shadow: string }[];
  ringShadow: string;
  /** S8: one printed line per dark stop. */
  flips: string[];
  hasHeader: boolean;
  /** S8: full-width panel elements (bands) and narrower ones (cards). */
  bands: number;
  cards: number;
  tabbable: number;
  /** K3: for each T16_SIZE_ONLY entry of this page and size, how many reads or skips matched its state. */
  hits: number[];
  /** Entries of T16_SIZE_ONLY for this page and size, in the order `hits` counts them. */
  entries: { selector: string; state: string }[];
  /** Problems the driver itself found: focus-trap, budget-exceeded, a menu that did not open. */
  driver: string[];
  budget: { ms: number; exceeded: boolean; lastRow: string | null; rowMs: number[] };
  crops: string[];
};

/** Optional steps a plant run uses to inject a defect without touching a site file (SA-1203 A12 S12). */
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

// ── the in-page reader ──────────────────────────────────────────────────────────────────────────────
type ReaderCfg = {
  sizeOnly: { selector: string; state: string }[];
  settleCapMs: number;
  stableFrames: number;
  stripTop: number;
  bandShare: number;
};
type Ctx = { kind?: "focus" | "text"; tab: number | null; how: string };
type StepOut = { end: "body" | "cycle" | "left" | null; row?: RingRead | null };
type Reader = {
  start(): Promise<number>;
  step(ctx: Ctx): Promise<StepOut>;
  sweepStep(): Promise<{ done: boolean }>;
  bands(): { names: string[]; cards: number };
  stopTo(i: number): Promise<{ name: string; headerState: string; scrollY: number }>;
  headerReads(how: string): Promise<RingRead[]>;
  toTop(): Promise<void>;
  menuPrep(): { available: boolean; count: number };
  menuOpened(): Promise<boolean>;
  menuStep(ctx: Ctx): Promise<StepOut>;
  menuClosed(): Promise<boolean>;
  shadows(scope: "all" | "menu"): { ringShadow: string; shadows: { el: string; shadow: string }[] };
  hasHeader(): boolean;
  finalize(): {
    texts: TextRow[];
    buttons: ButtonRow[];
    links: LinkRow[];
    unread: UnreadRow[];
    unreached: Skip[];
    hits: number[];
    tabbable: number;
  };
};

/**
 * Defines window.__t16w, once per page, from the test side (never a site file). It holds the ONE reader,
 * `settleThenRead`, and the small steps the Node driver calls between key presses. Nothing here pauses,
 * finishes or speeds an animation, and nothing writes scroll inside `settleThenRead`.
 */
function installReader(cfg: ReaderCfg): void {
  type Rgba = [number, number, number, number];
  const sp = (
    window as unknown as { __sp: { shown(e: Element): boolean; name(e: Element): string } }
  ).__sp;
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
  const lum = (c: Rgba) => {
    const [r, g, b] = [c[0], c[1], c[2]].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: Rgba, b: Rgba) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  const SKIP = /^(script|style|noscript|svg|canvas|template|head|title|meta|link)$/i;
  const body = document.body;
  const skipEl = (e: Element) =>
    SKIP.test(e.tagName) || !!e.closest("svg, canvas") || e.hasAttribute("data-t16-probe");
  const FOCUSABLE =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';
  const tabbables = (): HTMLElement[] =>
    [...body.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => {
      const ti = e.getAttribute("tabindex");
      return !(ti !== null && Number(ti) < 0);
    });
  const bandName = (b: Element) =>
    `${b.tagName.toLowerCase()}${b.id ? `#${b.id}` : ""}${[...b.classList]
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join("")}`;
  const headerEl = () => document.querySelector<HTMLElement>(".site-header");
  const menuEl = () => document.getElementById("mobile-menu");
  const headerState = (): "light" | "dark" =>
    headerEl()?.classList.contains("on-dark") ? "dark" : "light";
  const partOf = (e: Element): "page" | "header" | "menu" =>
    e.closest("#mobile-menu") ? "menu" : e.closest(".site-header") ? "header" : "page";
  const plantOf = (e: Element): string | null =>
    e.closest("[data-t16-plant]")?.getAttribute("data-t16-plant") ?? null;
  const safeMatches = (e: Element, sel: string) => {
    try {
      return e.matches(sel);
    } catch {
      return false;
    }
  };

  // S4: a test-injected span (fixed, aria-hidden, not focusable) resolves the tokens live, so a token change is read.
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.setAttribute("data-t16-probe", "");
  probe.style.cssText =
    "position:fixed;left:-9999px;top:0;width:1px;height:1px;pointer-events:none;visibility:hidden";
  body.appendChild(probe);
  const resolveColor = (prop: "color" | "backgroundColor", value: string): string | null => {
    probe.style[prop] = "";
    probe.style[prop] = value;
    if (probe.style[prop] === "") return null;
    const c = parse(getComputedStyle(probe)[prop]);
    probe.style[prop] = "";
    return prop === "backgroundColor" && c[3] === 0 ? null : rgb(c);
  };
  const tokens = () => {
    const panel = resolveColor("backgroundColor", "var(--rf-panel)");
    const onPanel = resolveColor("color", "var(--rf-on-panel)");
    const text = resolveColor("color", "var(--rf-text)");
    const btn = resolveColor("backgroundColor", "var(--rf-btn)");
    if (!panel || !onPanel || !text || !btn)
      throw new Error("T16: --rf-panel, --rf-on-panel, --rf-text or --rf-btn does not resolve");
    return { panel, onPanel, text, btn };
  };

  /** The opaque colour behind an element, alpha composited, or null when a picture or gradient sits behind it. */
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

  const S = {
    visited: new Set<Element>(),
    menuVisited: new Set<Element>(),
    reached: new Set<Element>(),
    seenText: new Map<Element, Set<string>>(),
    seenBtn: new Map<Element, Set<string>>(),
    seenLink: new Map<Element, Set<string>>(),
    tried: new Set<Element>(),
    headerDone: new Set<string>(),
    texts: [] as TextRow[],
    buttons: [] as ButtonRow[],
    links: [] as LinkRow[],
    unread: [] as UnreadRow[],
    bandEls: [] as Element[],
    hits: cfg.sizeOnly.map(() => 0),
  };
  const once = (map: Map<Element, Set<string>>, e: Element, key: string): boolean => {
    const s = map.get(e) ?? new Set<string>();
    map.set(e, s);
    if (s.has(key)) return false;
    s.add(key);
    return true;
  };
  const hit = (e: Element, state: string): boolean => {
    let exempt = false;
    cfg.sizeOnly.forEach((en, i) => {
      if (en.state === state && safeMatches(e, en.selector)) {
        exempt = true;
        S.hits[i] = (S.hits[i] ?? 0) + 1;
      }
    });
    return exempt;
  };
  const infoOf = (e: HTMLElement) => {
    const aria = e.getAttribute("aria-label");
    const t = (e.textContent ?? "").replace(/\s+/g, " ").trim();
    const name =
      aria && aria.trim()
        ? aria.trim()
        : t || (e.getAttribute("title") ?? "") || (e as HTMLInputElement).value || "";
    return {
      el: sp.name(e),
      tag: e.tagName.toLowerCase(),
      href: e instanceof HTMLAnchorElement ? e.href : null,
      name,
      target: [
        e.getAttribute("form") || (e as HTMLButtonElement).form?.id || "",
        e.getAttribute("aria-controls") || "",
        e.getAttribute("data-track") || "",
      ].join("|"),
    };
  };

  // S3: the signature that must stay equal for 3 frames: scrollY, the header's class list, the element and every
  // ancestor (rect, opacity, visibility), and for a focus stop its computed ring and its backdrop.
  const sigOf = (el: Element, kind: "focus" | "text" | "plain"): string => {
    const parts: string[] = [String(window.scrollY), headerEl()?.className ?? ""];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      parts.push(`${r.x},${r.y},${r.width},${r.height},${cs.opacity},${cs.visibility}`);
    }
    if (kind !== "plain") {
      const cs = getComputedStyle(el);
      parts.push(`${cs.outlineColor}|${cs.outlineWidth}|${cs.outlineStyle}|${cs.outlineOffset}`);
      const b = bgOf(kind === "focus" ? el.parentElement : el);
      parts.push(b ? rgb(b) : "picture");
    }
    return parts.join(";");
  };
  const settle = async (el: Element, kind: "focus" | "text" | "plain") => {
    const t0 = performance.now();
    let frames = 0;
    let run = 0;
    let last = "";
    for (;;) {
      await frame();
      frames++;
      const s = sigOf(el, kind);
      run = s === last ? run + 1 : 1;
      last = s;
      const ms = performance.now() - t0;
      if (run >= cfg.stableFrames) return { settled: true, frames, ms };
      if (ms >= cfg.settleCapMs) return { settled: false, frames, ms };
    }
  };

  // Texts and buttons (S6): everything fully in view and not yet read, against its live backdrop. The playhead is never driven.
  let candCache: { n: number; els: HTMLElement[] } | null = null;
  const withText = (): HTMLElement[] => {
    const n = body.getElementsByTagName("*").length;
    if (candCache && candCache.n === n) return candCache.els;
    const out = new Set<HTMLElement>();
    const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      if (!(t.textContent ?? "").trim()) continue;
      const e = t.parentElement;
      if (!e || skipEl(e)) continue;
      out.add(e);
    }
    candCache = { n, els: [...out] };
    return candCache.els;
  };
  /** A text a visitor could see: rendered, and not visibility:hidden (opacity is left to the settle). */
  const visibleInPrinciple = (e: HTMLElement) =>
    e.getClientRects().length > 0 && getComputedStyle(e).visibility === "visible";
  const inView = (e: Element) => {
    const r = e.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.top >= 0 &&
      r.left >= 0 &&
      r.bottom <= window.innerHeight &&
      r.right <= window.innerWidth
    );
  };
  const uncovered = (e: Element) => {
    const r = e.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && (e.contains(h) || h.contains(e));
  };
  const seenAny = (e: Element) => (S.seenText.get(e)?.size ?? 0) > 0;
  const collectInView = (hs: "light" | "dark") => {
    for (const e of withText()) {
      const part = partOf(e);
      const key = part === "header" ? hs : "*";
      if (S.seenText.get(e)?.has(key)) continue;
      if (!inView(e) || !visibleInPrinciple(e) || !sp.shown(e) || !uncovered(e)) continue;
      once(S.seenText, e, key);
      const cs = getComputedStyle(e);
      const bg = bgOf(e);
      let fg = parse(cs.color);
      if (bg && fg[3] < 1) fg = over(fg, bg);
      S.texts.push({
        el: sp.name(e),
        fg: rgb(fg),
        bg: bg ? rgb(bg) : null,
        size: parseFloat(cs.fontSize),
        weight: Number(cs.fontWeight),
        part,
        headerState: hs,
        plant: plantOf(e),
      });
      const b = e.closest(".btn-primary, .btn-light");
      if (b && sp.shown(b) && once(S.seenBtn, b, partOf(b) === "header" ? hs : "*")) {
        const bs = getComputedStyle(b);
        S.buttons.push({
          el: sp.name(b),
          bg: rgb(parse(bs.backgroundColor)),
          fg: rgb(parse(bs.color)),
          part: partOf(b),
          headerState: hs,
          plant: plantOf(b),
        });
      }
      const l = e.closest("a.link, .band-ink a:not(.btn)");
      if (l && sp.shown(l) && once(S.seenLink, l, partOf(l) === "header" ? hs : "*")) {
        const behind = bgOf(l.parentElement);
        S.links.push({
          el: sp.name(l),
          color: rgb(parse(getComputedStyle(l).color)),
          dark: behind ? lum(behind) < 0.2 : null,
          part: partOf(l),
          headerState: hs,
          plant: plantOf(l),
        });
      }
    }
  };

  // S1: the ONE reader. It settles the element (S3), then reads it (S4, S5), then reads every text and button in view (S6).
  // It writes no scroll: whatever the browser or the site did to scrollY is recorded as drift (S5).
  const settleThenRead = async (el: HTMLElement, ctx: Ctx): Promise<RingRead | null> => {
    const kind = ctx.kind ?? "focus";
    const scrollY0 = window.scrollY;
    const st = await settle(el, kind);
    const scrollY1 = window.scrollY;
    const hs = headerState();
    let read: RingRead | null = null;
    if (kind === "focus") {
      const t = tokens();
      const cs = getComputedStyle(el);
      const offset = parseFloat(cs.outlineOffset) || 0;
      const backdrop = bgOf(offset < 0 ? el : el.parentElement);
      const col = parse(cs.outlineColor);
      const eff = backdrop && col[3] < 1 ? over(col, backdrop) : col;
      const drawn = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
      const rawTok = cs.getPropertyValue("--rf-focus").trim();
      const focusTok = resolveColor("color", rawTok) ?? `unparsed:${rawTok}`;
      const rr = el.getClientRects()[0] ?? el.getBoundingClientRect();
      const cx = rr.left + rr.width / 2;
      const cy = rr.top + rr.height / 2;
      const seen =
        (rr.width > 0 || rr.height > 0) &&
        cx >= 0 &&
        cy >= 0 &&
        cx <= window.innerWidth &&
        cy <= window.innerHeight;
      let obscuredBy: string | null = null;
      if (!seen) obscuredBy = "out of viewport";
      else {
        const top = document.elementFromPoint(cx, cy);
        if (!top || !(top === el || el.contains(top))) obscuredBy = top ? sp.name(top) : "nothing";
      }
      const state: RingRead["state"] =
        document.activeElement !== el
          ? "focus-refused"
          : !st.settled
            ? "unsettled"
            : obscuredBy
              ? "obscured"
              : "measured";
      const animating = (() => {
        let n = 0;
        for (let e: Element | null = el; e; e = e.parentElement)
          n += e.getAnimations({ subtree: false }).filter((a) => a.playState === "running").length;
        return n;
      })();
      read = {
        sel: sp.name(el),
        part: partOf(el),
        headerState: hs,
        state,
        tab: ctx.tab,
        how: ctx.how,
        info: infoOf(el),
        plant: plantOf(el),
        ring: {
          style: cs.outlineStyle,
          width: parseFloat(cs.outlineWidth) || 0,
          color: rgb(parse(cs.outlineColor)),
          offset,
        },
        backdrop: backdrop ? rgb(backdrop) : null,
        ringContrast: !drawn ? 0 : backdrop ? ratio(eff, backdrop) : null,
        bandDark: !!backdrop && [t.panel, t.text, t.btn].includes(rgb(backdrop)),
        focusTok,
        onPanel: t.onPanel,
        scrollY0,
        scrollY1,
        settleFrames: st.frames,
        settleMs: st.ms,
        stillAnimating: animating,
        inView: seen,
        obscuredBy,
        rect: { x: rr.left, y: rr.top, w: rr.width, h: rr.height },
        exempt: hit(el, state),
        stepMs: 0,
      };
      S.reached.add(el);
      if (read.part === "header") S.headerDone.add(`${read.sel}|${hs}`);
    }
    collectInView(hs);
    return read;
  };

  const R = {
    start: async () => {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
      (document.activeElement as HTMLElement | null)?.blur?.();
      await settle(body, "plain");
      return tabbables().length;
    },
    step: async (ctx: Ctx): Promise<StepOut> => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === body || el === document.documentElement) return { end: "body" };
      if (S.visited.has(el)) return { end: "cycle" };
      S.visited.add(el);
      return { end: null, row: await settleThenRead(el, ctx) };
    },
    // S7: scroll to the first text nobody has read, settle it, read it; one still unread is `text-unread`.
    sweepStep: async () => {
      const next = withText().find((e) => !seenAny(e) && !S.tried.has(e) && visibleInPrinciple(e));
      if (!next) return { done: true };
      S.tried.add(next);
      next.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      await settleThenRead(next, { kind: "text", tab: null, how: "sweep" });
      if (!seenAny(next))
        S.unread.push({
          el: sp.name(next),
          part: partOf(next),
          plant: plantOf(next),
          exempt: hit(next, "text-unread"),
        });
      return { done: false };
    },
    // S8: the dark stops, from the live DOM: every outermost element painted with the resolved --rf-panel.
    bands: () => {
      const panel = tokens().panel;
      const matched: Element[] = [];
      for (const e of body.querySelectorAll("*")) {
        // An ink button or link is painted with the panel colour, but it is a control, not a band.
        if (skipEl(e) || e.closest(`.site-header, #mobile-menu, ${FOCUSABLE}`)) continue;
        const cs = getComputedStyle(e);
        const c = parse(cs.backgroundColor);
        if (c[3] !== 1 || rgb(c) !== panel) continue;
        if (cs.position === "fixed" || cs.position === "sticky") continue;
        if (e.getClientRects().length === 0 || e.getBoundingClientRect().height < 40) continue;
        matched.push(e);
      }
      const outer = matched.filter((e) => !matched.some((o) => o !== e && o.contains(e)));
      const wide = outer.filter(
        (e) => e.getBoundingClientRect().width >= window.innerWidth * cfg.bandShare,
      );
      S.bandEls = outer;
      return { names: outer.map(bandName), cards: outer.length - wide.length };
    },
    stopTo: async (i: number) => {
      const b = S.bandEls[i] as HTMLElement;
      const top = window.scrollY + b.getBoundingClientRect().top - cfg.stripTop;
      window.scrollTo({ top: Math.max(0, top), left: 0, behavior: "instant" as ScrollBehavior });
      await settle(headerEl() ?? body, "plain");
      return {
        name: bandName(b),
        headerState: headerState(),
        scrollY: window.scrollY,
      };
    },
    headerReads: async (how: string) => {
      const out: RingRead[] = [];
      const h = headerEl();
      if (!h) return out;
      for (const el of tabbables().filter((e) => h.contains(e))) {
        if (el.getClientRects().length === 0 || getComputedStyle(el).visibility !== "visible")
          continue;
        const key = `${sp.name(el)}|${headerState()}`;
        if (S.headerDone.has(key)) continue;
        S.headerDone.add(key);
        el.focus({ focusVisible: true, preventScroll: true } as FocusOptions);
        const r = await settleThenRead(el, { tab: null, how });
        if (r) out.push(r);
        el.blur();
      }
      return out;
    },
    toTop: async () => {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
      await settle(headerEl() ?? body, "plain");
    },
    // S9: focus the menu button (no scroll); the key press that opens the menu comes from the driver.
    menuPrep: () => {
      const btn = document.querySelector<HTMLElement>(".menu-btn");
      const m = menuEl();
      if (!btn || !m || btn.getClientRects().length === 0) return { available: false, count: 0 };
      btn.focus({ focusVisible: true, preventScroll: true } as FocusOptions);
      return { available: true, count: tabbables().filter((e) => m.contains(e)).length };
    },
    menuOpened: async () => {
      const m = menuEl();
      if (!m) return false;
      await settle(m, "plain");
      return m.classList.contains("open");
    },
    menuStep: async (ctx: Ctx): Promise<StepOut> => {
      const el = document.activeElement as HTMLElement | null;
      const m = menuEl();
      if (!m || !el || !m.contains(el)) return { end: "left" };
      if (S.menuVisited.has(el)) return { end: "cycle" };
      S.menuVisited.add(el);
      return { end: null, row: await settleThenRead(el, ctx) };
    },
    menuClosed: async () => {
      const m = menuEl();
      if (m) await settle(m, "plain");
      return !m?.classList.contains("open");
    },
    // T18c: every element's box-shadow is none or the ring.
    shadows: (scope: "all" | "menu") => {
      probe.style.boxShadow = "var(--rf-ring)";
      const ringShadow = getComputedStyle(probe).boxShadow;
      probe.style.boxShadow = "";
      const m = menuEl();
      const els =
        scope === "menu"
          ? m
            ? [m, ...m.querySelectorAll("*")]
            : []
          : [document.documentElement, body, ...body.querySelectorAll("*")];
      const shadows: { el: string; shadow: string }[] = [];
      for (const e of els) {
        if (e !== document.documentElement && e !== body && skipEl(e)) continue;
        const s = getComputedStyle(e).boxShadow;
        if (s !== "none") shadows.push({ el: sp.name(e), shadow: s });
      }
      return { ringShadow, shadows };
    },
    hasHeader: () => !!headerEl(),
    // S10: everything the three passes never reached.
    finalize: () => {
      const unreached: Skip[] = [];
      const all = tabbables();
      for (const e of all) {
        if (S.reached.has(e)) continue;
        const reason = (e as HTMLButtonElement).disabled
          ? "disabled"
          : e.closest("[inert]")
            ? "inert"
            : e.closest("dialog:not([open])")
              ? "closed-dialog"
              : "unreached";
        const listed = reason === "unreached" && hit(e, "not-rendered");
        unreached.push({
          ...infoOf(e),
          reason,
          part: partOf(e),
          sizeOnly: listed,
          plant: plantOf(e),
        });
      }
      return {
        texts: S.texts,
        buttons: S.buttons,
        links: S.links,
        unread: S.unread,
        unreached,
        hits: S.hits,
        tabbable: all.length,
      };
    },
  };
  (window as unknown as { __t16w: typeof R }).__t16w = R;
}

// ── the Node driver ─────────────────────────────────────────────────────────────────────────────────
/** Calls one step of the in-page reader by name, so the Node side never holds a closure over the page. */
function call<K extends keyof Reader>(
  page: Page,
  key: K,
  ...args: Parameters<Reader[K]>
): Promise<Awaited<ReturnType<Reader[K]>>> {
  return page.evaluate(
    ({ key, args }) =>
      (
        (window as unknown as { __t16w: Record<string, (...a: unknown[]) => unknown> }).__t16w[
          key
        ] as (...a: unknown[]) => unknown
      )(...args),
    { key: key as string, args },
  ) as Promise<Awaited<ReturnType<Reader[K]>>>;
}

/** The short sha of the checkout, for the report (S14). */
function walkSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short=10", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}
const SHA = walkSha();

/** Crops go under the main checkout's local-assets (gitignored), never into git (S13). */
function cropRoot(): string {
  if (process.env.T16_CROP_DIR) return process.env.T16_CROP_DIR;
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: __dirname,
      encoding: "utf8",
    }).trim();
    return path.resolve(__dirname, common, "..", "local-assets", "t16-crops");
  } catch {
    return path.resolve(__dirname, "../../../../local-assets/t16-crops");
  }
}
const RUN_STAMP = new Date().toISOString().replace(/[:.]/g, "-");
let cropsThisRun = 0;
let runStart: number | null = null;

async function walkPage(
  page: Page,
  route: string,
  size: { w: number; h: number },
  hooks: OpenHooks,
): Promise<Walk> {
  const label = `${route} ${sizeName(size)}`;
  const entries = T16_SIZE_ONLY.filter((e) => e.page === route && e.size === sizeName(size)).map(
    (e) => ({ selector: e.selector, state: e.state as string }),
  );
  const t0 = Date.now();
  const rows: RingRead[] = [];
  const driver: string[] = [];
  const flips: string[] = [];
  const crops: string[] = [];
  const rowMs: number[] = [];
  const budget = { exceeded: false, lastRow: null as string | null };
  const over = () => {
    if (!budget.exceeded && Date.now() - t0 > WALK_BUDGET_MS) budget.exceeded = true;
    return budget.exceeded;
  };
  const trap = (part: "page" | "menu", presses: number, focusables: number, how: string) =>
    redLine({
      label,
      part,
      headerState: "-",
      tab: presses,
      settle: "-",
      kind: "focus-trap",
      detail: `${presses} Tab presses (${focusables} focusable elements + ${TAB_CAP_EXTRA}) and focus never ${part === "menu" ? "left the menu or cycled in it" : "returned to a visited element or to body"}`,
      raw: `last=${budget.lastRow ?? "-"} how=${how}`,
      repro:
        part === "menu"
          ? `open ${label}, open the menu with Enter, press Tab ${presses} times`
          : `open ${label}, scroll to the top, press Tab ${presses} times`,
      sha: SHA,
    });

  await openForWalk(page, route, size, hooks);
  await page.evaluate(() => {
    for (const d of document.querySelectorAll("details")) d.open = true;
  });
  const cfg: ReaderCfg = {
    sizeOnly: entries,
    settleCapMs: SETTLE_CAP_MS,
    stableFrames: SETTLE_STABLE_FRAMES,
    stripTop: HEADER_STRIP_TOP,
    bandShare: BAND_WIDTH_SHARE,
  };
  await page.evaluate(installReader, cfg);

  const accept = async (row: RingRead, ts: number) => {
    row.stepMs = Date.now() - ts;
    rowMs.push(row.stepMs);
    budget.lastRow = `${row.part} ${row.sel}`;
    rows.push(row);
    // S13: crops on red only, at most CROPS_PER_PAGE per page and size and CROPS_PER_RUN per run.
    if (readProblems(row).length === 0) return;
    if (crops.length >= CROPS_PER_PAGE || cropsThisRun >= CROPS_PER_RUN) return;
    cropsThisRun++;
    const dir = path.join(cropRoot(), RUN_STAMP);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      `${label.replace(/[^a-z0-9]+/gi, "_")}-${row.part}-${row.tab ?? "stop"}.png`,
    );
    const pad = 16;
    const vp = page.viewportSize() ?? { width: size.w, height: size.h };
    const x = Math.max(0, Math.floor(row.rect.x - pad));
    const y = Math.max(0, Math.floor(row.rect.y - pad));
    const clip = {
      x,
      y,
      width: Math.max(1, Math.min(vp.width - x, Math.ceil(row.rect.w + 2 * pad))),
      height: Math.max(1, Math.min(vp.height - y, Math.ceil(row.rect.h + 2 * pad))),
    };
    await page
      .screenshot({ path: file, clip, animations: "allow" })
      .then(() => crops.push(file))
      .catch((e: unknown) => crops.push(`crop failed: ${String(e)}`));
  };

  // S2: from the top, with nothing focused, press Tab until focus returns to an element already visited or to body.
  const total = await call(page, "start");
  const cap = total + TAB_CAP_EXTRA;
  let ended: string | null = null;
  for (let tab = 1; tab <= cap && !over(); tab++) {
    const ts = Date.now();
    await page.keyboard.press("Tab");
    const out = await call(page, "step", { tab, how: "tab" });
    if (out.end) {
      ended = out.end;
      break;
    }
    if (out.row) await accept(out.row, ts);
  }
  if (!ended && !budget.exceeded) driver.push(trap("page", cap, total, "tab"));

  // S7: every text still unread is scrolled to, settled and read.
  for (let i = 0; i < 4000 && !over(); i++) if ((await call(page, "sweepStep")).done) break;

  // S8: the header in its dark state, at stops found by colour; at the first dark stop the phone menu is opened (S9).
  const bandInfo = await call(page, "bands");
  let menuDone = false;
  let menuShadows: { el: string; shadow: string }[] = [];
  const menuPass = async (how: string) => {
    menuDone = true;
    const prep = await call(page, "menuPrep");
    if (!prep.available) return;
    await page.keyboard.press("Enter");
    if (!(await call(page, "menuOpened")))
      driver.push(
        redLine({
          label,
          part: "menu",
          headerState: "-",
          tab: null,
          settle: "-",
          kind: "menu-not-opened",
          detail: "Enter on the menu button did not open the menu",
          raw: `how=${how}`,
          repro: `open ${label}, focus the menu button, press Enter`,
          sha: SHA,
        }),
      );
    // S9: leaving the menu or cycling inside it is valid; only the cap with no end is a trap.
    const mcap = prep.count + TAB_CAP_EXTRA;
    let mEnded: string | null = null;
    for (let tab = 1; tab <= mcap && !over(); tab++) {
      const ts = Date.now();
      await page.keyboard.press("Tab");
      const out = await call(page, "menuStep", { tab, how: "menu-tab" });
      if (out.end) {
        mEnded = out.end;
        break;
      }
      if (out.row) await accept(out.row, ts);
    }
    if (!mEnded && !budget.exceeded) driver.push(trap("menu", mcap, prep.count, how));
    menuShadows = (await call(page, "shadows", "menu")).shadows;
    await call(page, "menuPrep");
    await page.keyboard.press("Enter");
    await call(page, "menuClosed");
  };
  for (let i = 0; i < bandInfo.names.length && !over(); i++) {
    const stop = await call(page, "stopTo", i);
    flips.push(
      `${label} header flip at ${stop.name} (scrollY ${stop.scrollY}): ${stop.headerState}`,
    );
    if (stop.headerState !== "dark") continue;
    const ts = Date.now();
    for (const row of await call(page, "headerReads", `header-stop:${stop.name}`))
      await accept(row, ts);
    if (!menuDone) await menuPass(`header-stop:${stop.name}`);
  }
  if (!menuDone && !over()) {
    await call(page, "toTop");
    await menuPass("top");
  }

  const fin = await call(page, "finalize");
  const all = await call(page, "shadows", "all");
  return {
    label,
    route,
    size,
    sha: SHA,
    rows,
    texts: fin.texts,
    buttons: fin.buttons,
    links: fin.links,
    unread: fin.unread,
    unreached: fin.unreached,
    shadows: [...all.shadows, ...menuShadows],
    ringShadow: all.ringShadow,
    flips,
    hasHeader: await call(page, "hasHeader"),
    bands: bandInfo.names.length - bandInfo.cards,
    cards: bandInfo.cards,
    tabbable: fin.tabbable,
    hits: fin.hits,
    entries,
    driver,
    budget: { ms: Date.now() - t0, ...budget, rowMs },
    crops,
  };
}

/**
 * Walks one page at one size in its own browser, closed in a `finally` and killed by a hard timer (S13).
 * Call it from inside a test; it reads the base URL from the project.
 */
export async function walkPageSize(
  route: string,
  size: { w: number; h: number },
  opts: { hooks?: OpenHooks; hardMs?: number } = {},
): Promise<Walk> {
  runStart ??= Date.now();
  if (Date.now() - runStart > WALK_RUN_HARD_MS)
    throw new Error(
      `T16 ${route} ${sizeName(size)}: the 15 minute hard timeout of the walk passed`,
    );
  const use = test.info().project.use;
  const browser = await chromium.launch({ headless: use.headless ?? true });
  const kill = setTimeout(
    () => void browser.close().catch(() => undefined),
    opts.hardMs ?? WALK_PAGE_HARD_MS,
  );
  try {
    const ctx = await browser.newContext({
      ...devices["Desktop Chrome"],
      baseURL: use.baseURL ?? process.env.PLAYWRIGHT_BASE_URL,
      viewport: { width: size.w, height: size.h },
    });
    await blockAnalytics(ctx);
    return await walkPage(await ctx.newPage(), route, size, opts.hooks ?? {});
  } finally {
    clearTimeout(kill);
    await browser.close().catch(() => undefined);
  }
}

// ── the judge ───────────────────────────────────────────────────────────────────────────────────────
const isLarge = (r: TextRow) => r.size >= 24 || (r.size >= 18.66 && r.weight >= 700);

/** T16: gathers every problem as one grep-able line each (S14); the caller asserts once. */
export function judgeColours(walk: Walk): {
  problems: string[];
  report: string[];
  accepted: number;
} {
  const { label, route, sha } = walk;
  const sizeLabel = sizeName(walk.size);
  const problems: string[] = [...walk.driver];
  const textLine = (
    t: { part: Part; headerState: string; el: string },
    kind: string,
    detail: string,
    raw: string,
  ) =>
    redLine({
      label,
      part: t.part,
      headerState: t.headerState,
      tab: null,
      settle: "-",
      kind,
      detail,
      raw,
      repro: reproOf(route, sizeLabel, { how: "sweep", tab: null, sel: t.el }),
      sha,
    });
  if (walk.budget.exceeded)
    problems.push(
      redLine({
        label,
        part: "page",
        headerState: "-",
        tab: null,
        settle: "-",
        kind: "budget-exceeded",
        detail: `${walk.budget.ms} ms against ${WALK_BUDGET_MS} ms; last row ${walk.budget.lastRow ?? "-"}`,
        raw: `rowMs=${walk.budget.rowMs.join(",")}`,
        repro: `run the walk for ${label}`,
        sha,
      }),
    );
  // K2: the floor of 50 counts TEXT rows.
  const walked = walk.texts.filter((t) => t.bg !== null);
  if (walked.length < MIN_TEXT_ELEMENTS)
    problems.push(
      textLine(
        { part: "page", headerState: "-", el: "-" },
        "text-floor",
        `only ${walked.length} text rows walked (need ${MIN_TEXT_ELEMENTS})`,
        `texts=${walk.texts.length}`,
      ),
    );
  for (const t of walked) {
    const need = isLarge(t) ? 3 : 4.5;
    const got = contrast(t.fg, t.bg as string);
    if (got < need)
      problems.push(
        textLine(
          t,
          "text-contrast",
          `text ${t.el}: ${got.toFixed(2)} < ${need}`,
          `${t.fg} on ${t.bg}`,
        ),
      );
  }
  for (const b of walk.buttons) {
    const ok = (b.bg === INK && b.fg === WHITE) || (b.bg === WHITE && b.fg === INK);
    if (!ok)
      problems.push(
        textLine(
          b,
          "button-colour",
          `button ${b.el}: not white on ink or ink on white`,
          `${b.fg} on ${b.bg}`,
        ),
      );
  }
  for (const l of walk.links) {
    if (l.dark === null) continue;
    const want = l.dark ? LINK_ON_DARK : LINK_ON_LIGHT;
    if (l.color !== want)
      problems.push(
        textLine(
          l,
          "link-colour",
          `link ${l.el} on a ${l.dark ? "dark" : "light"} band, want ${want}`,
          l.color,
        ),
      );
  }
  for (const u of walk.unread)
    if (!u.exempt)
      problems.push(
        textLine({ ...u, headerState: "-" }, "text-unread", `${u.el} could not be read`, "-"),
      );
  for (const r of walk.rows)
    for (const p of readProblems(r))
      problems.push(
        redLine({
          label,
          part: r.part,
          headerState: r.headerState,
          tab: r.tab,
          settle: settleRecord(r),
          kind: p.kind,
          detail: p.detail,
          raw: p.raw,
          repro: reproOf(route, sizeLabel, r),
          sha,
        }),
      );
  const measured = walk.rows.map((r) => r.info);
  const un = unreachedProblems(label, walk.unreached, measured, sha);
  problems.push(...un.problems);
  problems.push(...staleExemptions(label, walk.entries, walk.hits));
  problems.push(...sizeOnlyEntryProblems(T16_SIZE_ONLY).map((p) => `T16 ${label}: ${p}`));
  problems.push(
    ...headerStateProblems(label, {
      bands: walk.hasHeader ? walk.bands : 0,
      headerRows: walk.rows.filter((r) => r.part === "header"),
    }),
  );

  // S14: a table row per page, size and part, then one line for the page.
  const report: string[] = [];
  for (const part of ["page", "header", "menu"] as const) {
    const rs = walk.rows.filter((r) => r.part === part);
    if (rs.length === 0) continue;
    const ratios = rs.map((r) => r.ringContrast).filter((v): v is number => v !== null && v > 0);
    const min = ratios.length ? Math.min(...ratios) : 0;
    const count = (s: string) => rs.filter((r) => r.state === s).length;
    report.push(
      `${label} part=${part}: reads ${rs.length}, measured ${count("measured")}, obscured ${count("obscured")}, unsettled@cap ${count("unsettled")}, drift>0 ${rs.filter((r) => r.scrollY1 !== r.scrollY0).length}, min ring ${min.toFixed(2)}:1, light ${rs.filter((r) => r.headerState === "light").length}, dark ${rs.filter((r) => r.headerState === "dark").length}`,
    );
  }
  report.push(
    `${label}: tabbable ${walk.tabbable}, reached ${walk.rows.length}, unreached accepted(C1) ${un.accepted}, listed(C2) ${un.listed}, unreached-unlisted ${un.unlisted}; text rows ${walk.texts.length}, text-unread ${walk.unread.length}; dark stops ${walk.flips.filter((f) => f.endsWith(": dark")).length} of ${walk.flips.length}, bands ${walk.bands}, cards ${walk.cards}; ${walk.budget.ms} ms, walk ${sha}`,
  );
  report.push(...walk.flips);
  return { problems, report, accepted: un.accepted };
}

/** T18c: every element's box-shadow is none or the ring. */
export function judgeShadows(walk: Walk): string[] {
  const out: string[] = [];
  expect(walk.ringShadow).not.toBe("none");
  for (const s of walk.shadows)
    if (s.shadow !== walk.ringShadow) out.push(`${s.el}: ${s.shadow} is not the ring`);
  return out;
}
