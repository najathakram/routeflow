/**
 * Wave 3, lane 2.3-home (the home page), project "site-waves": T20 (home's 14 bands hold the white, bone or ink role at
 * 1440x900 and 390x844), T15 (every opaque background covering a quarter of the window is white, bone or ink), T47 (the
 * problem section: its invoice box sits inside its frame at 1440x900, P05; and the hand-over of the picture to the big
 * line, SA-1191: the no-harm contrast rule, A1-K1 the line stays in the window, A1-K2 the line keeps a 24 px gutter from
 * every painted picture box). Signed out, desktop Chrome, against a running stack (baseURL as in the other site specs).
 * The three colours are read from the page's own token style (--brand-white, --brand-bone, --brand-ink), never typed;
 * every colour, opacity and box of T47's hand-over is read from the page at the beat. Each test gathers every problem
 * and asserts once; a sweep that finds nothing throws (L-202); nothing sleeps.
 */
import { test, expect, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { blockAnalytics, frames, nonEmpty } from "./helpers/site-proof";
import {
  SEEN,
  flatFaults,
  floorFor,
  judgeRead,
  missedWindows,
  overlapRatios,
  parseRgb,
  rectGap,
  scrubOff,
  scrubSettled,
  verdict,
  type BoxRead,
  type JudgeOptions,
  type ProblemRead,
  type Rect,
  type Rgb,
  type TextRead,
  type Tokens,
  type TriggerLike,
} from "./helpers/site-overlap";

test.beforeEach(async ({ context }) => {
  await blockAnalytics(context);
});

const SCREENS = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
] as const;

type Role = "white" | "bone" | "ink";
type Colours = Record<Role, string>;

/** The band table of ux-spec section 5, Home: selector -> the role its background holds. 14 rows. */
const BANDS: ReadonlyArray<readonly [string, Role]> = [
  ["#top", "white"],
  ["#one-system", "white"],
  ["#problem", "ink"],
  ["#journey", "bone"],
  ["#shot", "white"],
  ["#sell", "bone"],
  ["#stores", "white"],
  ["#counter", "bone"],
  ["#use-cases", "white"],
  ["#founder", "white"],
  ["#pricing", "bone"],
  ["#faq", "white"],
  ["#start", "ink"],
  ["footer.site-footer", "bone"],
];

/** App-picture frames: a phone's body is the device, not a band (listed, so an exemption is never silent). */
const FRAME_EXEMPT = [".pb-phone", ".st-phone", ".dv"] as const;

async function open(page: Page, w: number, h: number): Promise<void> {
  await page.setViewportSize({ width: w, height: h });
  await page.goto("/", { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
}

/** The three roles as the page's token style defines them, as the rgb() strings the browser computes. */
async function roles(page: Page): Promise<Colours> {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const rgb = (key: string): string => {
      const v = cs.getPropertyValue(`--brand-${key}`).trim();
      const m = /^#([0-9a-f]{6})$/i.exec(v);
      if (!m)
        throw new Error(`--brand-${key} is not a hex colour in the page's token style: "${v}"`);
      const n = parseInt(m[1] as string, 16);
      return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
    };
    return { white: rgb("white"), bone: rgb("bone"), ink: rgb("ink") };
  });
}

// ─── T20 ────────────────────────────────────────────────────────────────────

for (const { w, h } of SCREENS) {
  test(`T20 home's 14 bands hold their role @${w}x${h}`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, w, h);
    const want = await roles(page);
    const seen = await page.evaluate(
      (rows) => {
        return rows.map(([sel, role]) => {
          const el = document.querySelector(sel);
          if (!el) return { sel, role, found: false, shown: false, bg: "" };
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            sel,
            role,
            found: true,
            shown: cs.display !== "none" && r.height > 0,
            bg: cs.backgroundColor,
          };
        });
      },
      BANDS as unknown as Array<[string, Role]>,
    );

    const problems: string[] = [];
    for (const row of seen) {
      if (!row.found) problems.push(`${row.sel}: not on the page`);
      // the app window picture is not shown on a phone (home.css: #shot is display:none under 900px)
      else if (!row.shown && !(row.sel === "#shot" && w < 900))
        problems.push(`${row.sel}: not shown`);
      else if (row.shown && row.bg !== want[row.role as Role])
        problems.push(`${row.sel}: want ${row.role} ${want[row.role as Role]}, got ${row.bg}`);
    }
    expect(
      nonEmpty(
        seen.filter((r) => r.shown),
        "home bands",
      ).length,
    ).toBeGreaterThanOrEqual(13);
    expect(seen).toHaveLength(14);
    expect(problems).toEqual([]);
  });
}

// ─── T15 ────────────────────────────────────────────────────────────────────

for (const { w, h } of SCREENS) {
  test(`T15 every opaque background of a quarter of the window is white, bone or ink @${w}x${h}`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await open(page, w, h);
    const want = await roles(page);
    const allowed = Object.values(want);
    const bad = new Set<string>();
    let big = 0;
    for (let y = 0, guard = 0; guard < 80; guard++) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await frames(page, 2);
      const found = await page.evaluate(
        ({ ok, exempt }) => {
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const out: { count: number; bad: string[]; max: number } = { count: 0, bad: [], max: 0 };
          for (const el of Array.from(document.querySelectorAll("body *"))) {
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden") continue;
            const r = el.getBoundingClientRect();
            const share =
              (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) *
                Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) /
              (vw * vh);
            if (share < 0.25) continue;
            const m = /^rgba?\(([^)]+)\)$/.exec(cs.backgroundColor);
            const parts = m ? (m[1] as string).split(",").map((v) => parseFloat(v)) : [];
            const alpha = parts.length === 4 ? (parts[3] as number) : 1;
            const gradient = /gradient/.test(cs.backgroundImage);
            const opaque = (m !== null && alpha > 0.95) || gradient;
            if (!opaque) continue;
            if (exempt.some((s) => el.closest(s))) continue;
            out.count++;
            out.max = Math.max(out.max, share);
            const rgb = m ? `rgb(${parts.slice(0, 3).join(", ")})` : cs.backgroundColor;
            if (gradient || !ok.includes(rgb)) {
              const id = el.id ? `#${el.id}` : "";
              out.bad.push(
                `${el.tagName.toLowerCase()}${id}.${String(el.className).split(" ")[0]} ${gradient ? "gradient" : rgb}`,
              );
            }
          }
          return out;
        },
        { ok: allowed, exempt: [...FRAME_EXEMPT] },
      );
      big += found.count;
      for (const b of found.bad) bad.add(`y=${y}: ${b}`);
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      if (y + h >= total) break;
      y += Math.round(h * 0.8);
    }
    expect(big, "no opaque background of a quarter of the window was found").toBeGreaterThan(0);
    expect([...bad]).toEqual([]);
  });
}

// ─── T47 (P05) ──────────────────────────────────────────────────────────────

test("T47 the invoice box of the problem picture sits inside its frame @1440x900", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await open(page, 1440, 900);
  // Bring the pinned section to the beat where all three objects are in: past two lines of the three, before the fade.
  const top = await page.evaluate(() => {
    const s = document.querySelector("#problem") as HTMLElement | null;
    if (!s) throw new Error("no #problem section");
    return s.getBoundingClientRect().top + window.scrollY;
  });
  await page.evaluate(({ top: t, vh }) => window.scrollTo(0, t + vh * 1.7 * 0.6), { top, vh: 900 });
  // the scrub settles on the paper and the picture being fully drawn, never on a timer
  await page.waitForFunction(() => {
    const paper = document.querySelector(".pb-paper");
    const art = document.querySelector(".pb-art");
    return (
      !!paper &&
      !!art &&
      Number(getComputedStyle(paper).opacity) >= 0.99 &&
      Number(getComputedStyle(art).opacity) >= 0.99
    );
  });
  const m = await page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    };
    const paper = document.querySelector(".pb-paper") as HTMLElement | null;
    const head = document.querySelector(".pb-paper .pp-h") as HTMLElement | null;
    const art = document.querySelector(".pb-art") as HTMLElement | null;
    const big = document.querySelector(".pb-big") as HTMLElement | null;
    if (!paper || !head || !art || !big) throw new Error("the problem picture is missing a part");
    const bb = big.getBoundingClientRect();
    const pr = paper.getBoundingClientRect();
    const bigOverPaper =
      bb.left < pr.right && bb.right > pr.left && bb.top < pr.bottom && bb.bottom > pr.top;
    const bigOpacity = Number(getComputedStyle(big).opacity);
    const hr = head.getBoundingClientRect();
    const covered = [hr.left + 4, hr.left + hr.width / 2, hr.right - 4]
      .map((x) => document.elementFromPoint(x, hr.top + hr.height / 2))
      .filter((e) => !e || !e.closest(".pb-paper")).length;
    return {
      paper: box(paper),
      head: box(head),
      art: box(art),
      vw: window.innerWidth,
      vh: window.innerHeight,
      headClipped: head.scrollWidth > head.clientWidth + 1,
      covered,
      bigOverPaper,
      bigOpacity,
      text: (head.textContent ?? "").trim(),
    };
  });
  const within = (a: { l: number; t: number; r: number; b: number }, o: typeof a, pad: number) =>
    a.l >= o.l - pad && a.t >= o.t - pad && a.r <= o.r + pad && a.b <= o.b + pad;
  const problems: string[] = [];
  if (!/^invoice/i.test(m.text)) problems.push(`the heading reads "${m.text}"`);
  if (!within(m.head, m.paper, 2)) problems.push("the heading leaves the invoice box");
  if (!within(m.paper, m.art, 10)) problems.push("the invoice box leaves its frame");
  if (!within(m.paper, { l: 0, t: 0, r: m.vw, b: m.vh }, 0))
    problems.push("the invoice box leaves the window");
  if (m.headClipped) problems.push("the heading is wider than its line");
  if (m.covered > 0) problems.push(`something else covers the heading at ${m.covered} of 3 points`);
  if (m.bigOverPaper && m.bigOpacity > 0.05)
    problems.push(`the big line paints over the invoice box (opacity ${m.bigOpacity})`);
  expect(problems).toEqual([]);
});

/**
 * What T47 reads at one beat, evaluated in the page (SA-1191 K2). Every colour, opacity, size and box comes from
 * getComputedStyle, getBoundingClientRect or Range rects at that beat, never from a table. Text is found by walking
 * #problem, not from a selector list; the line's boxes are its glyph rects. Self-contained: it is injected as source
 * (addInitScript), so the page never builds code at run time (the production policy has no unsafe-eval).
 */
function t47Read(): ProblemRead {
  const q = (sel: string): HTMLElement => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error("the problem picture is missing " + sel);
    return el;
  };
  const sec = q("#problem");
  const round = (v: number) => Math.round(v * 100) / 100;
  const box = (r: DOMRect | DOMRectReadOnly): Rect => ({
    left: round(r.left),
    top: round(r.top),
    right: round(r.right),
    bottom: round(r.bottom),
  });
  // an element's effective opacity: its own times every ancestor's, up to and including the section
  const chain = (from: Element | null): number => {
    let o = 1;
    for (let e = from; e; e = e.parentElement) {
      o *= Number(getComputedStyle(e).opacity);
      if (e === sec) break;
    }
    return o;
  };
  const painted = (e: Element): boolean => {
    const m = /^rgba?\(([^)]*)\)$/.exec(getComputedStyle(e).backgroundColor);
    if (!m) return false;
    const parts = (m[1] as string).split(",");
    return parts.length < 4 || Number(parts[3]) > 0;
  };
  // the first painted background at or above an element: what a text is painted on
  const paint = (from: Element | null): string => {
    for (let e = from; e; e = e.parentElement) {
      if (painted(e)) return getComputedStyle(e).backgroundColor;
      if (e === sec) break;
    }
    throw new Error("no painted background above a text of the problem section");
  };
  // the nearest block-level ancestor, by computed display; a span or other inline tag that the stylesheet made a block
  // or a flex item is still its paragraph's line layout, so the climb passes it
  const inlineTags = " span a b i em strong s u small sub sup code mark abbr cite q label ";
  const blocks: Element[] = [];
  const blockId = (el: Element): number => {
    let found: Element = sec;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const d = getComputedStyle(e).display;
      if (d.indexOf("inline") === 0 || d === "contents") continue;
      if (inlineTags.indexOf(" " + e.tagName.toLowerCase() + " ") >= 0) continue;
      found = e;
      break;
    }
    const at = blocks.indexOf(found);
    if (at >= 0) return at;
    blocks.push(found);
    return blocks.length - 1;
  };
  const texts: TextRead[] = [];
  const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const name = (n.textContent || "").trim();
    const el = n.parentElement;
    if (!name || !el) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width >= 1 && r.height >= 1)
      .map(box);
    if (rects.length === 0) continue; // display:none, or collapsed: nothing painted
    const cs = getComputedStyle(el);
    texts.push({
      name: name.slice(0, 28),
      inArt: !!el.closest(".pb-art"),
      inBig: !!el.closest(".pb-big"),
      block: blockId(el),
      color: cs.color,
      backdrop: paint(el),
      opacity: chain(el),
      fontPx: parseFloat(cs.fontSize),
      weight: Number(cs.fontWeight),
      rects,
    });
  }
  const bigs = texts.filter((t) => t.inBig);
  if (bigs.length === 0) throw new Error("the big line has no glyph rects");
  // the line is one text with one look; its glyph rects are every rect of its text nodes (no spread: this is injected as source)
  const first = bigs[0] as TextRead;
  const lineRects: Rect[] = [];
  for (const t of bigs) for (const r of t.rects) lineRects.push(r);
  const line: TextRead = {
    name: "the big line",
    inArt: first.inArt,
    inBig: true,
    block: first.block,
    color: first.color,
    backdrop: first.backdrop,
    opacity: first.opacity,
    fontPx: first.fontPx,
    weight: first.weight,
    rects: lineRects,
  };
  // every painted box of the picture: the bezel, the screen, the bubbles, the notes, the paper
  const art = q(".pb-art");
  const boxes: BoxRead[] = [];
  for (const e of Array.from(art.querySelectorAll("*"))) {
    if (!painted(e)) continue;
    const r = e.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    boxes.push({
      name: e.tagName.toLowerCase() + "." + String(e.className).trim().split(/\s+/).join("."),
      bg: getComputedStyle(e).backgroundColor,
      opacity: chain(e),
      rect: box(r),
    });
  }
  // each heading of the picture against its own box
  const structural: string[] = [];
  const pairs: Array<[string, string, string]> = [
    ["phone", ".pb-ph", ".pb-ph .pb-from"],
    ["invoice", ".pb-paper", ".pb-paper .pp-h"],
  ];
  for (const [name, boxSel, headSel] of pairs) {
    const b = q(boxSel).getBoundingClientRect();
    const headEl = q(headSel);
    const h = headEl.getBoundingClientRect();
    if (!(
      h.left >= b.left - 2 &&
      h.right <= b.right + 2 &&
      h.top >= b.top - 2 &&
      h.bottom <= b.bottom + 2
    ))
      structural.push(name + " heading leaves its box");
    if (headEl.scrollWidth > headEl.clientWidth + 1) structural.push(name + " heading is clipped");
  }
  const inv = q(".pb-paper .pp-h");
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    panel: paint(art.parentElement),
    line,
    texts: texts.filter((t) => !t.inBig),
    boxes,
    structural,
    roles: {
      invoiceText: getComputedStyle(inv).color,
      invoiceCard: paint(inv),
      fromText: getComputedStyle(q(".pb-ph .pb-from")).color,
    },
  };
}

/**
 * The pinned timeline of the problem section, reached from the page the way the settle check reaches its triggers:
 * ScrollTrigger.getAll(), the one scrubbed trigger whose element is inside #problem, and its animation. No test hook is
 * needed in home-up.js. Self-contained, injected as source.
 */
function t47Find(): { st?: any; tl?: any; error?: string } {
  const w = window as unknown as Record<string, any>;
  if (!w.ScrollTrigger) return { error: "window.ScrollTrigger is missing" };
  const sec = document.querySelector("#problem");
  if (!sec) return { error: "no #problem section" };
  const hits = (w.ScrollTrigger.getAll() as any[]).filter(
    (t) => t.animation && t.vars && t.vars.scrub && t.trigger && sec.contains(t.trigger),
  );
  if (hits.length !== 1)
    return {
      error: `${hits.length} scrubbed triggers inside #problem, expected the one pinned timeline`,
    };
  return { st: hits[0], tl: hits[0].animation };
}

/** A brand token as the page's token style defines it, as channels. */
async function token(page: Page, key: string): Promise<Rgb> {
  return parseRgb(
    await page.evaluate(
      (k) => getComputedStyle(document.documentElement).getPropertyValue(`--brand-${k}`).trim(),
      key,
    ),
  );
}

async function tokens(page: Page): Promise<Tokens> {
  return {
    white: await token(page, "white"),
    ink: await token(page, "ink"),
    steel: await token(page, "steel"),
  };
}

/**
 * Every fault at one beat of a real scroll: the structural ones, the colour roles the maths assumes (checked against the
 * page's tokens, not assumed), and the no-harm rule and the two guards over what the page reports at that beat.
 */
async function beatFaults(
  page: Page,
  w: number,
  k: string,
  opts: JudgeOptions = {},
): Promise<string[]> {
  const tok = await tokens(page);
  const read = await page.evaluate(() =>
    (window as unknown as { __t47Read: () => ProblemRead }).__t47Read(),
  );
  const f = judgeRead(read, tok, opts);
  console.log(
    `T47 beat ${w} ${k}: line ${read.line.opacity.toFixed(3)}, ${read.texts.length} texts, ${read.boxes.length} boxes, ${f.harm.length} harm, ${f.window.length} window, ${f.gutter.length} gutter`,
  );
  return flatFaults(f, k);
}

/** Wait until the pinned timeline is there, then say where it runs: the scroll positions and its length. */
async function pinInfo(page: Page): Promise<{ start: number; end: number }> {
  const find = () =>
    page.evaluate(() => {
      const f = (window as unknown as { __t47Find: () => ReturnType<typeof t47Find> }).__t47Find();
      return f.error
        ? { error: f.error }
        : { start: f.st.start as number, end: f.st.end as number, error: "" };
    });
  try {
    await page.waitForFunction(
      () => {
        const f = (window as unknown as { __t47Find?: () => ReturnType<typeof t47Find> }).__t47Find;
        return typeof f === "function" && !f().error;
      },
      undefined,
      { timeout: 20_000 },
    );
  } catch (e) {
    const r = await find();
    throw new Error(
      `the problem timeline cannot be reached from the page: ${r.error} (${String(e)})`,
    );
  }
  const r = await find();
  if (r.error) throw new Error(r.error);
  return { start: r.start as number, end: r.end as number };
}

/** Wait until the timeline's progress has not moved for `ms`, by the page's own clock (SCRUB 0.8 is a lag, not a delay). */
async function stillFor(page: Page, ms: number): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__t47Still = null;
  });
  await page.waitForFunction(
    (hold) => {
      const w = window as unknown as {
        __t47Find: () => ReturnType<typeof t47Find>;
        __t47Still: { v: number; since: number } | null;
      };
      const f = w.__t47Find();
      if (f.error) throw new Error(f.error);
      const v = f.tl.progress() as number;
      const now = performance.now();
      if (!w.__t47Still || w.__t47Still.v !== v) {
        w.__t47Still = { v, since: now };
        return false;
      }
      return now - w.__t47Still.since >= hold;
    },
    ms,
    { polling: "raf", timeout: 20_000 },
  );
}

/**
 * What the page reports about its own settling, evaluated in the page. Self-contained: it is injected as source
 * (addInitScript), so the page never builds code at run time (the production policy has no unsafe-eval).
 */
function t47Probe(sel: string): { missing: string | null; off: unknown[]; busy: number } {
  const w = window as unknown as Record<string, any>;
  const none = (missing: string) => ({ missing, off: [], busy: 0 });
  if (typeof w.__scrubOff !== "function") return none("the settle script was not injected");
  if (!w.gsap) return none("window.gsap is missing");
  if (!w.ScrollTrigger) return none("window.ScrollTrigger is missing");
  const scope = document.querySelector(sel);
  if (!scope) return none(`no ${sel} element to scope the settle check to`);
  const off = w.__scrubOff(w.ScrollTrigger.getAll(), 0.005, scope) as unknown[];
  // a tween on the line that runs on the clock (a phone's, or a reveal) has to finish too; the pin's own scrubbed
  // children belong to a timeline, which the scrub check covers
  const busy = (w.gsap.getTweensOf(".pb-big") as any[]).filter(
    (t) => t.parent === w.gsap.globalTimeline && t.isActive(),
  ).length;
  return { missing: null, off, busy };
}

/**
 * Put the settle check, the page reader and the timeline finder into every page this test opens. Call before the first
 * navigation. All four are self-contained functions injected as source.
 */
async function installSettle(page: Page): Promise<void> {
  await page.addInitScript({
    content:
      "window.__scrubOff=" +
      String(scrubOff) +
      ";window.__t47Probe=" +
      String(t47Probe) +
      ";window.__t47Read=" +
      String(t47Read) +
      ";window.__t47Find=" +
      String(t47Find) +
      ";",
  });
}

/** Wait until every scrubbed trigger in the section has caught up and the line's clock tweens are done. */
async function settle(page: Page, sectionSel: string): Promise<void> {
  try {
    await page.waitForFunction(
      (sel) => {
        const p = (window as unknown as { __t47Probe?: (s: string) => ReturnType<typeof t47Probe> })
          .__t47Probe;
        if (typeof p !== "function") return false;
        const r = p(sel);
        return !r.missing && r.off.length === 0 && r.busy === 0;
      },
      sectionSel,
      { timeout: 20_000 },
    );
  } catch (e) {
    const r = await page.evaluate((sel) => {
      const p = (window as unknown as { __t47Probe?: (s: string) => ReturnType<typeof t47Probe> })
        .__t47Probe;
      return typeof p === "function" ? p(sel) : null;
    }, sectionSel);
    const why = !r
      ? "the settle script was not injected into the page (call installSettle before open)"
      : r.missing
        ? r.missing
        : r.off.length > 0
          ? "scrubbed triggers that did not catch up: " + JSON.stringify(r.off)
          : `${r.busy} clock tween(s) on .pb-big still running`;
    throw new Error(`the problem section did not settle in 20 s: ${why} (${String(e)})`);
  }
}

test("T47 settle check: scrub-only, and it names the trigger that lags (no browser)", () => {
  const once = {
    vars: { scrub: undefined },
    progress: 0.3,
    animation: { progress: () => 1 },
    trigger: { id: "once" },
  };
  const caught = {
    vars: { scrub: 0.8 },
    progress: 0.5,
    animation: { progress: () => 0.5 },
    trigger: { className: "pb-pin" },
  };
  const lag = { ...caught, animation: { progress: () => 0.2 } };
  // the former check: every trigger. A play-once trigger never tracks the scroll, so it never succeeded.
  const former = (ts: TriggerLike[]) =>
    ts.every((t) => !t.animation || Math.abs(t.animation.progress() - t.progress) < 0.005);
  expect(former([once, caught])).toBe(false);
  expect(scrubSettled([once, caught])).toBe(true);
  expect(scrubSettled([once, lag])).toBe(false);
  expect(scrubOff([once, lag])).toEqual([{ trigger: ".pb-pin", progress: 0.5, animation: 0.2 }]);

  // the scope is the section under test: another section's scrubbed scene that lags is not this section's business
  const inside = { id: "in" };
  const outside = { id: "out" };
  const scope = { contains: (n: unknown) => n === inside };
  const pin = { ...caught, trigger: inside };
  const pinLag = { ...pin, animation: { progress: () => 0.2 } };
  const elsewhere = {
    vars: { scrub: 0.8 },
    progress: 0,
    animation: { progress: () => 0.5156 },
    trigger: outside,
  };
  // the unscoped scrub-only check waits forever on the lagging scene elsewhere (the timeout seen on the slot)
  expect(scrubSettled([pin, elsewhere])).toBe(false);
  expect(scrubSettled([pin, elsewhere], 0.005, scope)).toBe(true);
  expect(scrubSettled([pinLag, elsewhere], 0.005, scope)).toBe(false);
});

/**
 * The palette file's colours, never typed: the three the model uses (ink, white, steel).
 */
function paletteLooks() {
  const pal = (
    JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../../packages/types/brand/palette.json"),
        "utf8",
      ),
    ) as { color: Record<string, string> }
  ).color;
  return {
    ink: parseRgb(pal.ink as string),
    white: parseRgb(pal.white as string),
    steel: parseRgb(pal.steel as string),
  };
}

test("T47 no-harm rule: the model's fail rows R1-R6, pass rows G1-G4 and E1 (no browser)", () => {
  const { ink, white, steel } = paletteLooks();
  const on = (text: Rgb) => ({ text, card: white, panel: ink, white });
  // Golden rows, SA-1191 K3 (A2-a): printed by local-assets/lead-2026-11-14/sa/SA-1191-composite-model.cjs (blob 631c3ac9e0;
  // reprint with `node <file>`). They are an independent oracle for overlapRatios and verdict, so the model is never
  // imported here. Compared at 2 dp; do not tighten. Changing the palette or the formula reprints them under a new SA
  // amendment. INVOICE and the
  // sender heading are texts on a white card; "line" is the big line over the white paper (solo: over the panel alone).
  // null: the record gives only "below 3" for that row, so the test pins the verdict and the floor.
  type Row = [
    string,
    "invoice" | "line" | "from",
    number,
    number,
    number,
    number | null,
    number | null,
    boolean,
    boolean,
  ];
  const rows: Row[] = [
    // id, who, floor, p, l, solo, comp, held, harmed
    ["R1 INVOICE", "invoice", 3, 0.559, 0.395, 6.25, 2.66, true, true],
    ["R2 line over the paper", "line", 3, 0.559, 0.395, 3.74, 1.59, true, true],
    ["R3 INVOICE", "invoice", 3, 0.42, 0.53, 4.07, 1.71, true, true],
    ["R4 line over the paper", "line", 3, 0.42, 0.53, 5.74, 2.41, true, true],
    ["R5 line over the paper (white on white)", "line", 3, 1, 0.5, 5.25, 1.0, true, true],
    ["R6 sender heading", "from", 4.5, 1, 0.3, 5.85, 3.07, true, true],
    ["G1 INVOICE", "invoice", 3, 0.69, 0.236, 8.94, 5.02, true, false],
    ["G1 line (not held)", "line", 3, 0.69, 0.236, 2.13, 1.2, false, false],
    ["G2 line", "line", 3, 0.298, 0.647, 7.99, 3.91, true, false],
    ["G2 INVOICE (below 3, not held)", "invoice", 3, 0.298, 0.647, null, null, false, false],
    ["G3 INVOICE at 1440 (floor 3)", "invoice", 3, 1, 0.5, 17.96, 3.42, true, false],
    ["G3 INVOICE at 393 (floor 4.5)", "invoice", 4.5, 1, 0.5, 17.96, 3.42, true, true],
    ["G4 sender heading", "from", 4.5, 1, 0.1, 5.85, 4.66, true, false],
    ["E1 sender heading in its own fade", "from", 4.5, 0.72, 0, 4.41, 4.41, false, false],
  ];
  for (const [id, who, floor, p, l, solo, comp, held, harmed] of rows) {
    const r = overlapRatios(p, l, on(who === "from" ? steel : ink));
    const v =
      who === "line"
        ? verdict(r.lineSolo, r.line, floor)
        : verdict(r.headingSolo, r.heading, floor);
    if (solo !== null) expect(v.solo.toFixed(2), `${id} solo`).toBe(solo.toFixed(2));
    if (comp !== null) expect(v.comp.toFixed(2), `${id} comp`).toBe(comp.toFixed(2));
    expect(v.held, `${id} held`).toBe(held);
    expect(v.harmed, `${id} harmed`).toBe(harmed);
  }
  // the model's thresholds, on the 0.001 grid it scans
  const from = (fn: (x: number) => number, floor: number) => {
    for (let i = 0; i <= 1000; i++) if (fn(i / 1000) >= floor) return (i / 1000).toFixed(3);
    return "never";
  };
  const inv = (p: number) => overlapRatios(p, 0, on(ink)).headingSolo;
  expect(from(inv, 3)).toBe("0.331");
  expect(from(inv, 4.5)).toBe("0.452");
  expect(from((p) => overlapRatios(p, 0, on(steel)).headingSolo, 4.5)).toBe("0.738");
  expect(from((l) => overlapRatios(0, l, on(ink)).lineSolo, 3)).toBe("0.331");
  // large text starts at 24px, or 18.66px and bold (700)
  expect(floorFor(19, 700)).toBe(3);
  expect(floorFor(16, 700)).toBe(4.5);
  expect(floorFor(14, 650)).toBe(4.5);
  expect(floorFor(36, 650)).toBe(3);
});

test("T47 geometry and the judge over a page read (no browser)", () => {
  const { ink, white, steel } = paletteLooks();
  const css = (c: Rgb) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  const tok: Tokens = { white, ink, steel };
  const R = (left: number, top: number, right: number, bottom: number): Rect => ({
    left,
    top,
    right,
    bottom,
  });
  // the page reports the line at (1440x900) and a paper with its INVOICE heading; each case moves one thing
  const make = (l: number, p: number, lineRect: Rect): ProblemRead => ({
    vw: 1440,
    vh: 900,
    panel: css(ink),
    line: {
      name: "the big line",
      inArt: false,
      inBig: true,
      block: 0,
      color: css(white),
      backdrop: css(ink),
      opacity: l,
      fontPx: 66,
      weight: 650,
      rects: [lineRect],
    },
    texts: [
      {
        name: "Invoice",
        inArt: true,
        inBig: false,
        block: 2,
        color: css(ink),
        backdrop: css(white),
        opacity: p,
        fontPx: 19,
        weight: 700,
        rects: [R(1000, 600, 1080, 624)],
      },
    ],
    boxes: [
      { name: "div.pb-obj.pb-paper", bg: css(white), opacity: p, rect: R(980, 560, 1300, 800) },
    ],
    structural: [],
    roles: { invoiceText: css(ink), invoiceCard: css(white), fromText: css(steel) },
  });
  const clean = judgeRead(make(0.5, 1, R(120, 300, 640, 560)), tok);
  expect(clean).toEqual({ harm: [], window: [], gutter: [], other: [], cross: [] });
  // R5: the line over a blank part of the paper (no text under it) is white on white
  const blank = judgeRead(make(0.5, 1, R(1100, 650, 1280, 780)), tok);
  expect(blank.harm).toEqual([
    "the line is 1.00 over div.pb-obj.pb-paper, 5.25 alone, floor 3 (picture 1.000, line 0.500)",
  ]);
  // R1 and R2 together: the line over INVOICE and the paper at the model's beat
  const both = judgeRead(make(0.395, 0.559, R(990, 590, 1200, 640)), tok);
  expect(both.harm).toEqual([
    '"Invoice" is 2.66 under the line, 6.25 alone, floor 3 (picture 0.559, line 0.395)',
    "the line is 1.59 over div.pb-obj.pb-paper, 3.74 alone, floor 3 (picture 0.559, line 0.395)",
  ]);
  // E1: a text below its floor on its own is in its own fade; the line over it is not that text's harm
  const fade = judgeRead(make(0, 0.1, R(990, 590, 1200, 640)), tok);
  expect(fade.harm).toEqual([]);
  // A1-K1: a glyph rect left of the window at a visible line, not at 0.05 or below
  expect(judgeRead(make(0.3, 1, R(-12, 300, 500, 560)), tok).window).toEqual([
    '"the big line" leaves the window (left -12.0; opacity 0.300)',
  ]);
  expect(judgeRead(make(0.05, 1, R(-12, 300, 500, 560)), tok).window).toEqual([]);
  expect(judgeRead(make(0.3, 1, R(900, 300, 1445, 560)), tok).window).toHaveLength(1);
  expect(judgeRead(make(0.3, 1, R(0, 300, 500, 905)), tok).window).toHaveLength(1);
  expect(judgeRead(make(0.3, 1, R(0, 0, 1440, 900)), tok).window).toEqual([]);
  // A1-K2: 20 px clear of the paper is a fault, 24 is clear; at 0.05 or below nothing is held to the gutter
  const near = (gap: number) => make(0.3, 1, R(700, 600, 980 - gap, 700));
  expect(judgeRead(near(20), tok).gutter).toEqual([
    "the line is 20.0 px from div.pb-obj.pb-paper, needs 24 (line 0.300)",
  ]);
  expect(judgeRead(near(24), tok).gutter).toEqual([]);
  expect(judgeRead({ ...near(20), line: { ...near(20).line, opacity: 0.05 } }, tok).gutter).toEqual(
    [],
  );
  // the gap is the straight distance, so a corner counts
  expect(rectGap(R(0, 0, 10, 10), R(13, 14, 20, 20))).toBe(5);
  expect(rectGap(R(0, 0, 10, 10), R(5, 5, 20, 20))).toBe(0);
  // colour roles are checked against the page's own tokens
  const wrong = make(0.3, 1, R(120, 300, 640, 560));
  wrong.roles.fromText = css(ink);
  expect(judgeRead(wrong, tok).other).toEqual([
    "the sender heading is rgb(14, 23, 38), not the steel token",
  ]);
  // A2-d: text over text. The line crossing a heading that is readable alone is a fault; a heading in its own fade is not
  const heading = (
    opacity: number,
    rect: Rect,
    block: number = 1,
    name: string = "Prices in your head.",
  ): ProblemRead["texts"][number] => ({
    name,
    inArt: false,
    inBig: false,
    block,
    color: css(white),
    backdrop: css(ink),
    opacity,
    fontPx: 60,
    weight: 650,
    rects: [rect],
  });
  const crossing = (headingOpacity: number, lineOpacity: number, headRect: Rect) => ({
    ...make(lineOpacity, 1, R(100, 400, 600, 480)),
    texts: [heading(headingOpacity, headRect)],
  });
  const both2 = judgeRead(crossing(1, 0.4, R(100, 440, 560, 520)), tok, { cross: true }).cross;
  // both are readable alone (the line is held from 0.331), so each is crossed by the other
  expect(both2).toHaveLength(2);
  expect(both2[0]).toContain('"the big line" (');
  expect(both2[0]).toContain('is crossed by "Prices in your head."');
  expect(both2[1]).toContain('"Prices in your head." (');
  expect(both2[1]).toContain('is crossed by "the big line"');
  // the line is not held while it is below its floor alone (0.2 is under 3), so only the heading is held
  expect(
    judgeRead(crossing(1, 0.2, R(100, 440, 560, 520)), tok, { cross: true }).cross,
  ).toHaveLength(1);
  // the heading in its own fade (0.1) is not held, and the line below its floor is not held either
  expect(judgeRead(crossing(0.1, 0.2, R(100, 440, 560, 520)), tok, { cross: true }).cross).toEqual(
    [],
  );
  expect(judgeRead(crossing(1, 0.04, R(100, 440, 560, 520)), tok, { cross: true }).cross).toEqual(
    [],
  );
  // clear of the line is not a crossing; the rule is off unless asked for
  expect(judgeRead(crossing(1, 0.4, R(700, 440, 900, 520)), tok, { cross: true }).cross).toEqual(
    [],
  );
  // SA-1191 A3: what counts as a crossing. Two readable headings (the line is below SEEN, so it joins nothing); the
  // rects are the two rects under test. Texts of one block are its own line layout; between blocks 2 x 2 px counts.
  const pair = (a: Rect, blockA: number, b: Rect, blockB: number) => ({
    ...make(0.04, 1, R(100, 700, 600, 780)),
    texts: [
      heading(1, a, blockA, "Orders in texts."),
      heading(1, b, blockB, "Prices in your head."),
    ],
  });
  const crossesBetween = (a: Rect, blockA: number, b: Rect, blockB: number) =>
    judgeRead(pair(a, blockA, b, blockB), tok, { cross: true }).cross.length;
  // one block, leading of 1.12 on 60px type: the content boxes of consecutive lines share a 6 px sliver
  expect(crossesBetween(R(100, 100, 560, 167), 1, R(100, 161, 600, 228), 1)).toBe(0);
  // one block, a deep overlap: still the block's own layout, chosen by the author
  expect(crossesBetween(R(100, 100, 560, 167), 1, R(100, 130, 600, 197), 1)).toBe(0);
  // two blocks sharing 3 px by 3 px: a crossing, in both directions
  expect(crossesBetween(R(100, 100, 200, 167), 1, R(197, 164, 300, 231), 3)).toBe(2);
  // 1 px wide by 40 px high: antialiasing, not a crossing
  expect(crossesBetween(R(100, 100, 200, 167), 1, R(199, 120, 300, 160), 3)).toBe(0);
  // a descender graze: 6 px on a 70 px rect, under a quarter of it, between two blocks: a crossing
  expect(crossesBetween(R(100, 100, 560, 170), 1, R(100, 164, 560, 234), 3)).toBe(2);
  expect(judgeRead(crossing(1, 0.4, R(100, 440, 560, 520)), tok).cross).toEqual([]);
  // the calibration: a window no fault beat falls in is reported
  expect(
    missedWindows(
      [1.2185, 1.25],
      [
        [1.217, 1.223],
        [1.248, 1.252],
      ],
      0.002,
    ),
  ).toEqual([]);
  expect(
    missedWindows(
      [1.2185],
      [
        [1.217, 1.223],
        [1.248, 1.252],
      ],
      0.002,
    ),
  ).toEqual([[1.248, 1.252]]);
  expect(missedWindows([], [[1.217, 1.223]], 0.002)).toEqual([[1.217, 1.223]]);
});

test("T47 when home-up.js fails to load, the big line paints over neither heading @1440x900", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await installSettle(page);
  // the head script has set js-motion, the motion script never runs: the state of a reload or a deep link before GSAP
  await page.route("**/home-up.js*", (route) => route.abort());
  await open(page, 1440, 900);
  expect(await page.evaluate(() => document.documentElement.classList.contains("js-motion"))).toBe(
    true,
  );
  await page.evaluate(() => {
    const s = document.querySelector("#problem") as HTMLElement | null;
    if (!s) throw new Error("no #problem section");
    window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY);
  });
  expect(await beatFaults(page, 1440, "no-script", { window: false, gutter: 0 })).toEqual([]);
});

for (const { w, h } of [
  { w: 1440, h: 900 },
  { w: 393, h: 844 },
]) {
  test(`T47 from first paint to settle, at every beat of the problem section @${w}x${h}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await installSettle(page);
    await open(page, w, h);
    // the pin runs 170% of the window on a desktop; a phone has no pin, so the section's own height is the run
    const { top, run } = await page.evaluate(
      ([vh, desk]) => {
        const s = document.querySelector("#problem") as HTMLElement | null;
        if (!s) throw new Error("no #problem section");
        return {
          top: s.getBoundingClientRect().top + window.scrollY,
          run: desk ? 1.7 * vh : s.offsetHeight,
        };
      },
      [h, w >= 900] as [number, boolean],
    );
    const beats: string[] = [];
    const faults: string[] = [];
    // before the section, eleven even steps through it, and past its end (the fine hand-over steps are the seek tests)
    const steps = [
      -0.5 * h,
      ...Array.from({ length: 11 }, (_, i) => (i * run) / 10),
      run + 0.3 * h,
    ];
    for (const dy of steps) {
      const y = Math.max(0, Math.round(top + dy));
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForFunction((yy) => Math.abs(window.scrollY - yy) <= 1, y);
      // the pin scrubs (0.8 s), so wait until every scrubbed trigger's animation has caught up with its scroll progress
      await settle(page, "#problem");
      // one frame, so the layout has taken the settled state
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      const k = (dy / h).toFixed(2);
      beats.push(k);
      // the window rule is the seek tests' (a beat above or below the pin is not in the window); a phone has no gutter rule
      faults.push(
        ...(await beatFaults(page, w, k, { window: false, gutter: w >= 900 ? undefined : 0 })),
      );
    }
    expect(beats.length).toBeGreaterThanOrEqual(12);
    expect(faults).toEqual([]);
  });
}

// ─── SA-1191 K4: the timeline seek, the scroll spot check, the phone at rest ────────────────────────────────────────

/** The six motion sizes (SA-1190 A3-K2, kept). */
const MOTION_SIZES = [
  { w: 900, h: 700 },
  { w: 1024, h: 768 },
  { w: 1180, h: 800 },
  { w: 1280, h: 800 },
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
] as const;

/** K4 (i): progress 0.640 to 0.920 in 0.001 steps, 281 seeks (F5: the picture fades 0.642-0.789, the line 0.688-0.908). */
const SEEK_FROM = 640;
const SEEK_COUNT = 281;

/** The two hand-over windows known at 407f308294, 1440x900, in window heights (SA-1191 K4 i). */
const KNOWN_WINDOWS = [
  [1.217, 1.223],
  [1.248, 1.252],
] as const;

type SeekStep = { x: number; k: number; read: ProblemRead };

/**
 * Seek the pinned timeline through the page, one read per step. The page is parked at the pin's start with the scrub
 * settled, so no scroll event moves the timeline between a seek and its read; each seek is read back to prove that.
 */
async function seek(page: Page, w: number, h: number): Promise<{ steps: SeekStep[]; tok: Tokens }> {
  await installSettle(page);
  await open(page, w, h);
  const top = await page.evaluate(() => {
    const s = document.querySelector("#problem") as HTMLElement | null;
    if (!s) throw new Error("no #problem section");
    return s.getBoundingClientRect().top + window.scrollY;
  });
  const tok = await tokens(page);
  const pin = await pinInfo(page);
  const y = Math.ceil(pin.start);
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  await page.waitForFunction((yy) => Math.abs(window.scrollY - yy) <= 1, y);
  await settle(page, "#problem");
  const again = await pinInfo(page);
  if (Math.abs(again.start - pin.start) > 2)
    throw new Error(`the pin moved from ${pin.start} to ${again.start}`);
  const steps = await page.evaluate(
    ({ from, count, sectionTop, vh }) => {
      const win = window as unknown as {
        __t47Find: () => ReturnType<typeof t47Find>;
        __t47Read: () => ProblemRead;
      };
      const f = win.__t47Find();
      if (f.error) throw new Error(f.error);
      const out: SeekStep[] = [];
      for (let i = 0; i < count; i++) {
        const x = (from + i) / 1000;
        f.tl.progress(x);
        const back = f.tl.progress() as number;
        if (Math.abs(back - x) > 1e-6)
          throw new Error(`the scrub moved the timeline off ${x} (it reads ${back})`);
        const k = (f.st.start + x * (f.st.end - f.st.start) - sectionTop) / vh;
        out.push({ x, k, read: win.__t47Read() });
      }
      return out;
    },
    { from: SEEK_FROM, count: SEEK_COUNT, sectionTop: top, vh: h },
  );
  return { steps, tok };
}

/** A sweep that finds nothing proves nothing (L-202): the line, the picture's texts and its boxes are all there. */
function assertSweepSees(steps: SeekStep[], w: number): void {
  if (steps.length !== SEEK_COUNT)
    throw new Error(`${w}: ${steps.length} steps, expected ${SEEK_COUNT}`);
  const lit = steps.filter((s) => s.read.line.opacity > SEEN).length;
  if (lit < 200)
    throw new Error(
      `${w}: the line is above ${SEEN} at only ${lit} steps, the sweep tests nothing`,
    );
  for (const s of steps) {
    const art = s.read.texts.filter((t) => t.inArt).length;
    if (art < 10 || s.read.boxes.length < 6 || s.read.line.rects.length < 1)
      throw new Error(
        `${w} step ${s.x}: ${art} picture texts, ${s.read.boxes.length} boxes, ${s.read.line.rects.length} line rects`,
      );
  }
}

for (const { w, h } of MOTION_SIZES) {
  test(`T47 seek 0.640-0.920 in 0.001 steps: no harm, inside the window, 24 px clear @${w}x${h}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { steps, tok } = await seek(page, w, h);
    assertSweepSees(steps, w);
    const faults: string[] = [];
    let minLeft = Infinity;
    let maxRight = -Infinity;
    let minGap = Infinity;
    for (const s of steps) {
      faults.push(...flatFaults(judgeRead(s.read, tok), s.k.toFixed(3)));
      if (s.read.line.opacity > SEEN) {
        for (const r of s.read.line.rects) {
          minLeft = Math.min(minLeft, r.left);
          maxRight = Math.max(maxRight, r.right);
          for (const b of s.read.boxes) minGap = Math.min(minGap, rectGap(r, b.rect));
        }
      }
    }
    console.log(
      `T47 seek ${w}x${h}: ${steps.length} steps, ${faults.length} faults; the line above ${SEEN}: leftmost ${minLeft.toFixed(1)} px, rightmost ${maxRight.toFixed(1)} of ${w}, nearest picture box ${minGap.toFixed(1)} px`,
    );
    expect(faults).toEqual([]);
  });
}

// SA-1191 A2-d: text over text, at every seek step. Its own row, so a red here is not read as a contrast or window fault.
for (const { w, h } of MOTION_SIZES) {
  test(`T47 seek 0.640-0.920: no text crosses a text that is readable alone @${w}x${h}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { steps, tok } = await seek(page, w, h);
    assertSweepSees(steps, w);
    const faults: string[] = [];
    const ks: number[] = [];
    let pairs = 0;
    for (const s of steps) {
      const f = judgeRead(s.read, tok, { cross: true, window: false, gutter: 0 });
      pairs += s.read.texts.length;
      if (f.cross.length > 0) ks.push(s.k);
      faults.push(...f.cross.map((c) => `beat ${s.k.toFixed(3)}: ${c}`));
    }
    // the sweep must have had other texts to cross: the heading lines are under #problem, not only the picture
    if (pairs === 0) throw new Error(`${w}: no other texts were read`);
    console.log(
      `T47 cross ${w}x${h}: ${faults.length} crossings at ${ks.length} steps${
        ks.length ? `, k ${Math.min(...ks).toFixed(3)} to ${Math.max(...ks).toFixed(3)}` : ""
      }; first: ${faults[0] ?? "none"}`,
    );
    expect(faults).toEqual([]);
  });
}

// The step is valid only where it finds the two windows the records measured at 407f308294. Run with
// T47_CALIBRATION=1 against that placement (home.css from 407f308294); any other time this test skips.
test("T47 calibration: the 0.001 step finds both known windows at the old placement @1440x900", async ({
  page,
}) => {
  test.skip(!process.env.T47_CALIBRATION, "set T47_CALIBRATION=1 with home.css from 407f308294");
  test.setTimeout(180_000);
  const { steps, tok } = await seek(page, 1440, 900);
  assertSweepSees(steps, 1440);
  const harmKs = steps.filter((s) => judgeRead(s.read, tok).harm.length > 0).map((s) => s.k);
  if (harmKs.length === 0)
    throw new Error("the seek found no harm beat at all: the step is not valid");
  console.log(
    `T47 calibration: harm at ${harmKs.length} steps, k ${Math.min(...harmKs).toFixed(3)} to ${Math.max(...harmKs).toFixed(3)}; ${harmKs.map((k) => k.toFixed(3)).join(" ")}`,
  );
  // one step is 0.001 of the run, 0.0017 window heights
  expect(missedWindows(harmKs, KNOWN_WINDOWS, 0.002)).toEqual([]);
});

test("T47 scroll spot check: the two hand-over beats once the scrub has settled @1440x900", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const w = 1440;
  const h = 900;
  await installSettle(page);
  await open(page, w, h);
  const top = await page.evaluate(() => {
    const s = document.querySelector("#problem") as HTMLElement | null;
    if (!s) throw new Error("no #problem section");
    return s.getBoundingClientRect().top + window.scrollY;
  });
  const tok = await tokens(page);
  const pin = await pinInfo(page);
  const faults: string[] = [];
  let harm = 0;
  for (const k of [1.22, 1.25]) {
    const y = Math.round(top + k * h);
    const mapped = Math.min(1, Math.max(0, (y - pin.start) / (pin.end - pin.start)));
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForFunction((yy) => Math.abs(window.scrollY - yy) <= 1, y);
    // the scrub catches up; wait on the timeline's own progress, then until it has not moved for 300 ms
    await page.waitForFunction(
      (m) => {
        const f = (
          window as unknown as { __t47Find: () => ReturnType<typeof t47Find> }
        ).__t47Find();
        return !f.error && Math.abs(f.tl.progress() - m) <= 0.002;
      },
      mapped,
      { timeout: 20_000 },
    );
    await stillFor(page, 300);
    const got = await page.evaluate(() => {
      const win = window as unknown as {
        __t47Find: () => ReturnType<typeof t47Find>;
        __t47Read: () => ProblemRead;
      };
      return { progress: win.__t47Find().tl.progress() as number, read: win.__t47Read() };
    });
    expect(Math.abs(got.progress - mapped), `progress at ${k}`).toBeLessThanOrEqual(0.002);
    const f = judgeRead(got.read, tok);
    harm += f.harm.length;
    console.log(
      `T47 spot ${k}: progress ${got.progress.toFixed(4)} (mapped ${mapped.toFixed(4)}), line ${got.read.line.opacity.toFixed(3)}; harm: ${f.harm.join(" | ") || "none"}`,
    );
    faults.push(...flatFaults(f, k.toFixed(2)));
  }
  // with T47_CALIBRATION the old placement is the target: the real scroll must show the harm the seek found
  if (process.env.T47_CALIBRATION) expect(harm).toBeGreaterThan(0);
  else expect(faults).toEqual([]);
});

test("T47 a phone at rest: the big line overlaps no picture box @393x844", async ({ page }) => {
  test.setTimeout(120_000);
  await installSettle(page);
  await open(page, 393, 844);
  const tok = await tokens(page);
  // a phone has no pinned timeline (c.desk is false)
  const pinned = await page.evaluate(
    () => (window as unknown as { __t47Find: () => ReturnType<typeof t47Find> }).__t47Find().error,
  );
  expect(pinned, "a phone has no pinned problem timeline").toMatch(
    /expected the one pinned timeline/,
  );
  // walk down through the section so every reveal has fired, then rest on the big line
  const { top, bottom } = await page.evaluate(() => {
    const s = document.querySelector("#problem") as HTMLElement | null;
    if (!s) throw new Error("no #problem section");
    const r = s.getBoundingClientRect();
    return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY };
  });
  for (let y = Math.round(top); y < bottom; y += 300) {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForFunction((yy) => Math.abs(window.scrollY - yy) <= 1, y);
  }
  await page.evaluate(() => {
    const b = document.querySelector(".pb-big") as HTMLElement | null;
    if (!b) throw new Error("no .pb-big");
    const r = b.getBoundingClientRect();
    window.scrollTo(0, r.top + window.scrollY - (window.innerHeight - r.height) / 2);
  });
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".pb-obj, .pb-big")).every(
      (e) => Number(getComputedStyle(e).opacity) >= 0.99,
    ),
  );
  await settle(page, "#problem");
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  const read = await page.evaluate(() =>
    (window as unknown as { __t47Read: () => ProblemRead }).__t47Read(),
  );
  // a sweep that finds nothing proves nothing (L-202)
  expect(read.line.rects.length, "the line's glyph rects").toBeGreaterThan(0);
  expect(read.boxes.length, "the picture's painted boxes").toBeGreaterThanOrEqual(6);
  // no overlap: every glyph rect of the line is clear of every painted box by at least a pixel
  const f = judgeRead(read, tok, { window: false, gutter: 1 });
  console.log(
    `T47 phone at rest: line ${read.line.opacity.toFixed(3)}, ${read.line.rects.length} rects, nearest box ${Math.min(
      ...read.boxes.flatMap((b) => read.line.rects.map((r) => rectGap(r, b.rect))),
    ).toFixed(1)} px`,
  );
  expect([...f.other, ...f.harm, ...f.gutter]).toEqual([]);
});
