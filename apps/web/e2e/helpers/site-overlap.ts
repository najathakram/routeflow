/**
 * Pure helpers for the home page's scroll tests (spec 90). No browser, no imports, so a plain node run or a page-less
 * Playwright test can check them. `scrubOff` is serialised into the page (page.waitForFunction), so it must stay
 * self-contained: it may use nothing outside its own body.
 */

/** The part of a ScrollTrigger the settle check reads. */
export type TriggerLike = {
  vars?: { scrub?: unknown } | null;
  progress: number;
  animation?: { progress(): number } | null;
  trigger?: { id?: string; className?: unknown } | null;
};

export type TriggerOff = { trigger: string; progress: number; animation: number };

/**
 * The scrubbed triggers whose animation has not caught up with the scroll. Triggers without a scrub (play-once or
 * toggleActions) are not tied to the scroll, so their animation progress never tracks the trigger's and they are skipped.
 * Self-contained: it is passed into the page as source text.
 */
export function scrubOff(
  triggers: TriggerLike[],
  tolerance: number = 0.005,
  scope: { contains(n: unknown): boolean } | null = null,
): TriggerOff[] {
  const off: TriggerOff[] = [];
  for (const t of triggers) {
    const scrub = t.vars ? t.vars.scrub : undefined;
    if (!scrub || !t.animation) continue;
    // with a scope (the section under test), a trigger whose element is outside it is another section's scene
    if (scope && !(t.trigger && scope.contains(t.trigger))) continue;
    const a = t.animation.progress();
    if (Math.abs(a - t.progress) < tolerance) continue;
    const el = t.trigger || null;
    const cls = el && typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
    off.push({
      trigger: el ? (el.id ? "#" + el.id : cls ? "." + cls : "(element)") : "(none)",
      progress: t.progress,
      animation: a,
    });
  }
  return off;
}

/** True when every scrubbed trigger has caught up. */
export function scrubSettled(
  triggers: TriggerLike[],
  tolerance: number = 0.005,
  scope: { contains(n: unknown): boolean } | null = null,
): boolean {
  return scrubOff(triggers, tolerance, scope).length === 0;
}

// ─── overlap readability (SA-1191 K1, the no-harm rule) ──────────────────────

export type Rgb = [number, number, number];

/** "rgb(r, g, b)" or "#rrggbb" to channels. */
export function parseRgb(s: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(s.trim());
  if (hex) {
    const n = parseInt(hex[1] as string, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s.trim());
  if (!m) throw new Error(`not a colour: "${s}"`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Source-over of a on b at opacity o, in sRGB (the browser default). */
function mix(a: Rgb, b: Rgb, o: number): Rgb {
  return [0, 1, 2].map((i) => (a[i] as number) * o + (b[i] as number) * (1 - o)) as Rgb;
}

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The colours of one text and of what it sits on, as the page computes them. */
export type HeadingLook = { text: Rgb; card: Rgb; panel: Rgb; white: Rgb };

export type OverlapRatios = {
  /** the text against its own card, the line absent (a picture text at opacity p over the panel) */
  headingSolo: number;
  /** the same pair with the line (white at opacity l) over both */
  heading: number;
  /** the line against the panel alone */
  lineSolo: number;
  /** the line against the card under it */
  line: number;
};

/**
 * The four ratios of SA-1191's model at one beat. The picture (a text on its card) sits at opacity p over the panel,
 * and the big line is white at opacity l on top of both. For a picture text, headingSolo is solo and heading is comp.
 * For the line over a card, lineSolo is solo (over the panel) and line is comp (over that card).
 */
export function overlapRatios(p: number, l: number, look: HeadingLook): OverlapRatios {
  const card = mix(look.card, look.panel, p);
  const text = mix(look.text, look.panel, p);
  const bg = mix(look.white, card, l);
  const fg = mix(look.white, text, l);
  return {
    headingSolo: contrast(text, card),
    heading: contrast(fg, bg),
    lineSolo: contrast(mix(look.white, look.panel, l), look.panel),
    line: contrast(mix(look.white, card, l), card),
  };
}

/** WCAG 1.4.3 large text: 24px, or 18.66px and bold (700). The floor is 3 for large text, 4.5 for the rest. */
export function floorFor(fontPx: number, weight: number): number {
  return fontPx >= 24 || (fontPx >= 18.66 && weight >= 700) ? 3 : 4.5;
}

/**
 * SA-1191 K1, the no-harm rule. A text is held to its floor only where it passes it on its own (solo). Where it is held,
 * the other layer must not take it below the floor (comp). A text below its floor alone is in its own fade: not held.
 */
export type Verdict = { solo: number; comp: number; held: boolean; harmed: boolean };

export function verdict(solo: number, comp: number, floor: number): Verdict {
  const held = solo >= floor;
  return { solo, comp, held, harmed: held && comp < floor };
}

// ─── geometry (SA-1191 A1) ───────────────────────────────────────────────────

export type Rect = { left: number; top: number; right: number; bottom: number };

/** True when the two boxes share area. Boxes that only touch do not overlap. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** The distance between two boxes in px: 0 when they overlap or touch. */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(a.left - b.right, b.left - a.right, 0);
  const dy = Math.max(a.top - b.bottom, b.top - a.bottom, 0);
  return Math.hypot(dx, dy);
}

/** Half a pixel is layout rounding, not a fault; the faults this guards are tens of pixels. */
const SLACK = 0.5;

/** A1-K1: which side of the window the box leaves, or null when it is inside. */
export function leavesWindow(r: Rect, vw: number, vh: number): string | null {
  const sides: string[] = [];
  if (r.left < -SLACK) sides.push(`left ${r.left.toFixed(1)}`);
  if (r.right > vw + SLACK) sides.push(`right ${r.right.toFixed(1)} of ${vw}`);
  if (r.top < -SLACK) sides.push(`top ${r.top.toFixed(1)}`);
  if (r.bottom > vh + SLACK) sides.push(`bottom ${r.bottom.toFixed(1)} of ${vh}`);
  return sides.length ? sides.join(", ") : null;
}

/** An opacity at or under this is not painted: nothing to read, nothing to clip. */
export const SEEN = 0.05;
/** A1-K2: the page gutter, `100% - 48px` in home.css. */
export const GUTTER = 24;

// ─── what the page reports ───────────────────────────────────────────────────

/** One text node's element as the page computes it: colours, type, effective opacity and the glyph rects. */
export type TextRead = {
  name: string;
  inArt: boolean;
  inBig: boolean;
  color: string;
  /** the nearest painted ancestor's background: the picture's card, or the panel when nothing in the picture is painted */
  backdrop: string;
  /** the product of this element's opacity and every ancestor's up to the section */
  opacity: number;
  fontPx: number;
  weight: number;
  rects: Rect[];
};

/** A painted box of the picture: an element under .pb-art with a background of its own. */
export type BoxRead = { name: string; bg: string; opacity: number; rect: Rect };

export type ProblemRead = {
  vw: number;
  vh: number;
  panel: string;
  /** the big line, its glyph rects joined */
  line: TextRead;
  /** every other text under .pb */
  texts: TextRead[];
  boxes: BoxRead[];
  /** structural faults the page found itself (a heading leaving its box, clipped) */
  structural: string[];
  roles: { invoiceText: string; invoiceCard: string; fromText: string };
};

export type Tokens = { white: Rgb; ink: Rgb; steel: Rgb };

export type Faults = {
  /** SA-1191 K1: a text readable alone, taken below its floor by the other layer */
  harm: string[];
  /** A1-K1: a visible text with a glyph rect outside the window */
  window: string[];
  /** A1-K2: the line closer than the gutter to a painted picture box */
  gutter: string[];
  /** structure and colour roles */
  other: string[];
};

const same = (a: Rgb, b: Rgb) => a.every((v, i) => v === b[i]);

const fmt = (v: number) => v.toFixed(2);

/** K1 over every text of the picture and over the line (SA-1191). Every input comes from the page read. */
export function harmFaults(read: ProblemRead): string[] {
  const out: string[] = [];
  const panel = parseRgb(read.panel);
  const white = parseRgb(read.line.color);
  const l = read.line.opacity;
  for (const t of read.texts) {
    if (!t.inArt) continue;
    const floor = floorFor(t.fontPx, t.weight);
    const r = overlapRatios(t.opacity, l, {
      text: parseRgb(t.color),
      card: parseRgb(t.backdrop),
      panel,
      white,
    });
    // comp counts only where the line is over this text; elsewhere the text is as it is alone
    const under = l > 0 && t.rects.some((a) => read.line.rects.some((b) => rectsOverlap(a, b)));
    const v = verdict(r.headingSolo, under ? r.heading : r.headingSolo, floor);
    if (v.harmed)
      out.push(
        `"${t.name}" is ${fmt(v.comp)} under the line, ${fmt(v.solo)} alone, floor ${floor} (picture ${t.opacity.toFixed(3)}, line ${l.toFixed(3)})`,
      );
  }
  // the line: its own backdrop is the panel; over the picture it is the minimum over every painted box it covers
  const floor = floorFor(read.line.fontPx, read.line.weight);
  for (const b of read.boxes) {
    if (!read.line.rects.some((r) => rectsOverlap(r, b.rect))) continue;
    const r = overlapRatios(b.opacity, l, {
      text: white,
      card: parseRgb(b.bg),
      panel,
      white,
    });
    const v = verdict(r.lineSolo, r.line, floor);
    if (v.harmed)
      out.push(
        `the line is ${fmt(v.comp)} over ${b.name}, ${fmt(v.solo)} alone, floor ${floor} (picture ${b.opacity.toFixed(3)}, line ${l.toFixed(3)})`,
      );
  }
  return out;
}

/** A1-K1: every text of .pb above SEEN keeps all its glyph rects inside the window. */
export function windowFaults(read: ProblemRead): string[] {
  const out: string[] = [];
  for (const t of [...read.texts, read.line]) {
    if (t.opacity <= SEEN) continue;
    for (const r of t.rects) {
      const side = leavesWindow(r, read.vw, read.vh);
      if (side) {
        out.push(`"${t.name}" leaves the window (${side}; opacity ${t.opacity.toFixed(3)})`);
        break;
      }
    }
  }
  return out;
}

/** A1-K2: while the line is above SEEN, its glyph rects stay `need` px from every painted picture box. */
export function gutterFaults(read: ProblemRead, need: number = GUTTER): string[] {
  const out: string[] = [];
  if (read.line.opacity <= SEEN) return out;
  for (const b of read.boxes) {
    let gap = Infinity;
    for (const r of read.line.rects) gap = Math.min(gap, rectGap(r, b.rect));
    if (gap < need - SLACK)
      out.push(
        `the line is ${gap.toFixed(1)} px from ${b.name}, needs ${need} (line ${read.line.opacity.toFixed(3)})`,
      );
  }
  return out;
}

/** Structure and the colour roles the maths assumes, checked against the page's tokens. */
export function roleFaults(read: ProblemRead, tokens: Tokens): string[] {
  const out = [...read.structural];
  if (!same(parseRgb(read.panel), tokens.ink))
    out.push(`the panel is ${read.panel}, not the ink token`);
  if (!same(parseRgb(read.line.color), tokens.white))
    out.push(`the big line is ${read.line.color}, not the white token`);
  if (!same(parseRgb(read.roles.invoiceCard), tokens.white))
    out.push(`the invoice card is ${read.roles.invoiceCard}, not white`);
  if (!same(parseRgb(read.roles.invoiceText), tokens.ink))
    out.push(`INVOICE is ${read.roles.invoiceText}, not ink`);
  if (!same(parseRgb(read.roles.fromText), tokens.steel))
    out.push(`the sender heading is ${read.roles.fromText}, not the steel token`);
  return out;
}

export type JudgeOptions = {
  /** run A1-K1 (default true) */
  window?: boolean;
  /** run A1-K2 with this many px (default 24); 0 skips it */
  gutter?: number;
};

/** Every rule at one beat. */
export function judgeRead(read: ProblemRead, tokens: Tokens, opts: JudgeOptions = {}): Faults {
  const gutter = opts.gutter === undefined ? GUTTER : opts.gutter;
  return {
    harm: harmFaults(read),
    window: opts.window === false ? [] : windowFaults(read),
    gutter: gutter > 0 ? gutterFaults(read, gutter) : [],
    other: roleFaults(read, tokens),
  };
}

export function flatFaults(f: Faults, k: string): string[] {
  return [...f.other, ...f.harm, ...f.window, ...f.gutter].map((s) => `beat ${k}: ${s}`);
}

/**
 * The step's calibration (SA-1191 K4 i): the windows from `windows` ([lo, hi] in window heights) that no fault beat
 * falls in or within `tol` of. The seek is valid only where this is empty at the placement the windows were found at.
 */
export function missedWindows(
  faultKs: number[],
  windows: ReadonlyArray<readonly [number, number]>,
  tol: number,
): Array<readonly [number, number]> {
  return windows.filter(([lo, hi]) => !faultKs.some((k) => k >= lo - tol && k <= hi + tol));
}
