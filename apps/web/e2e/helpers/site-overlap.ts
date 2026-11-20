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

// ─── overlap readability (SA-1190, K1/K2) ────────────────────────────────────

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

export type OverlapRatios = { invoice: number; line: number };

/**
 * The two ratios at one beat where the big line's box overlaps INVOICE's box. The panel and the heading are ink, the
 * picture's card is white at opacity p over the panel, the big line is white at opacity l on top.
 * invoice: the heading against its card, both under the line. line: the line's colour against the card under it.
 */
export function overlapRatios(p: number, l: number, ink: Rgb, white: Rgb): OverlapRatios {
  const card = mix(white, ink, p);
  const text = ink; // ink on the panel, at any picture opacity
  const bg = mix(white, card, l);
  const fg = mix(white, text, l);
  return { invoice: contrast(fg, bg), line: contrast(mix(white, card, l), card) };
}

/**
 * K1. Faults for one beat at which the big line overlaps INVOICE. floor is 3 at 1440 (19px bold, large) and 4.5 at 393
 * (16px bold). Picture at or above 0.5: INVOICE must meet the floor. Line at or above 0.5: the line must meet 3.
 * Both below 0.5 is a transition beat, no assertion.
 */
export function overlapFaults(p: number, l: number, floor: number, ink: Rgb, white: Rgb): string[] {
  const r = overlapRatios(p, l, ink, white);
  const out: string[] = [];
  if (p >= 0.5 && r.invoice < floor)
    out.push(
      `INVOICE contrast ${r.invoice.toFixed(2)} is under ${floor} (picture ${p}, line ${l})`,
    );
  if (l >= 0.5 && r.line < 3)
    out.push(`the big line contrast ${r.line.toFixed(2)} is under 3 (picture ${p}, line ${l})`);
  return out;
}
