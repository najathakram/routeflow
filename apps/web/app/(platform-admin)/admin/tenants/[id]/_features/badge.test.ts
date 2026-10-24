import { BADGE_COLORS, deriveBadge, deriveReadout } from "./badge";
import type { EffectiveFeature } from "./types";

function feature(
  source: EffectiveFeature["source"],
  kind?: string,
): Pick<EffectiveFeature, "source" | "detail"> {
  return {
    source,
    detail: {
      planKey: "GROWTH",
      catalogVersionId: "catalog-v11",
      enforced: true,
      kind,
    },
  };
}

// design.md §2 Effective: source priority OVERRIDE_DENY → OVERRIDE_GRANT → ADDON_SKU →
// PRESET(term) → NONE maps 1:1 to badge removed/added/purchased/inherited/off, with
// "grandfathered" as the OVERRIDE_GRANT + kind:GRANDFATHER special case (brief D test 1).
describe("deriveBadge — source → badge, table-driven (brief D test 1)", () => {
  const cases: Array<[EffectiveFeature["source"], string | undefined, string]> = [
    ["OVERRIDE_DENY", undefined, "removed"],
    ["OVERRIDE_DENY", "SUPPORT", "removed"], // kind is irrelevant on the DENY side
    ["OVERRIDE_GRANT", "SUPPORT", "added"],
    ["OVERRIDE_GRANT", "PILOT", "added"],
    ["OVERRIDE_GRANT", "GRANDFATHER", "grandfathered"],
    ["ADDON_SKU", undefined, "purchased"],
    ["PRESET", undefined, "inherited"],
    ["NONE", undefined, "off"],
    ["UNKNOWN", undefined, "unknown"],
  ];

  for (const [source, kind, expected] of cases) {
    it(`${source}${kind ? ` (kind=${kind})` : ""} → ${expected}`, () => {
      expect(deriveBadge(feature(source, kind))).toBe(expected);
    });
  }
});

// A3 F6 residual: the "Off" pill was `text-slate-500` on slate-800 (3.07:1), the pair the console
// audit flagged everywhere. WCAG AA needs 4.5:1 for this 12 px text; the pills on a SOLID
// background are checked numerically against the Tailwind palette (the translucent ones sit on an
// alpha layer, so they are pinned by the "never slate-500/600" rule below).
describe("BADGE_COLORS contrast (WCAG AA 4.5:1)", () => {
  const HEX: Record<string, string> = {
    "slate-300": "#cbd5e1",
    "slate-400": "#94a3b8",
    "slate-500": "#64748b", // the failing colour, kept to prove the check can fail
    "slate-700": "#334155",
    "slate-800": "#1e293b",
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (fg: string, bg: string) => {
    const [a, b] = [lum(HEX[fg]), lum(HEX[bg])].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
  };

  it("the two solid-background pills (Inherited, Off) meet 4.5:1", () => {
    for (const key of ["inherited", "off"] as const) {
      const cls = BADGE_COLORS[key];
      const fg = /text-(slate-\d+)/.exec(cls)![1];
      const bg = /(?<![\w:-])bg-(slate-\d+)(?![/\w])/.exec(cls)![1];
      expect({ key, ok: ratio(fg, bg) >= 4.5 }).toEqual({ key, ok: true });
    }
  });

  it("the old failing pair really was below AA (the check can fail)", () => {
    expect(ratio("slate-500", "slate-800")).toBeLessThan(4.5);
  });

  it("no pill uses a slate-500/600 text colour", () => {
    for (const cls of Object.values(BADGE_COLORS))
      expect(cls).not.toMatch(/text-slate-(500|600)\b/);
  });
});

// BO-12: one state readout per row. The first rule that applies wins.
describe("deriveReadout: one readout, first rule wins", () => {
  const eff = (over: Partial<EffectiveFeature>): EffectiveFeature => ({
    key: "k",
    area: "a",
    serving: false,
    resolver: false,
    source: "NONE",
    detail: { planKey: "GROWTH", catalogVersionId: "catalog-v11", enforced: true },
    billing: { charged: false },
    ...over,
  });
  const enforced = { state: "enforced" as const };
  const dark = { state: "dark" as const };

  it("no effective data, or a resolver error, is Not reported", () => {
    expect(deriveReadout(enforced, undefined)).toEqual({
      kind: "not-reported",
      text: "Not reported",
    });
    expect(deriveReadout(dark, eff({ source: "UNKNOWN", serving: true })).kind).toBe(
      "not-reported",
    );
  });

  it("serving + dark gate + source none or an override that removes it is On, not enforced yet", () => {
    for (const source of ["NONE", "OVERRIDE_DENY"] as const) {
      expect(deriveReadout(dark, eff({ source, serving: true }))).toEqual({
        kind: "not-enforced",
        text: "On, not enforced yet",
      });
    }
    // not serving, or not dark, does not qualify
    expect(deriveReadout(dark, eff({ source: "NONE", serving: false })).kind).toBe("off");
    expect(deriveReadout(enforced, eff({ source: "NONE", serving: true })).kind).toBe("on");
  });

  it("folds the four source badges into one chip, and drops Inherited and Off", () => {
    const chip = (source: EffectiveFeature["source"], serving: boolean, kind?: string) =>
      deriveReadout(
        enforced,
        eff({ source, serving, detail: { ...eff({}).detail, ...(kind ? { kind } : {}) } }),
      );
    expect(chip("OVERRIDE_GRANT", true, "PILOT")).toEqual({
      kind: "chip",
      text: "On, added by override",
      badge: "added",
    });
    expect(chip("OVERRIDE_DENY", false)).toEqual({
      kind: "chip",
      text: "Off, removed by override",
      badge: "removed",
    });
    expect(chip("ADDON_SKU", true)).toEqual({
      kind: "chip",
      text: "On, paid add-on",
      badge: "purchased",
    });
    expect(chip("OVERRIDE_GRANT", true, "GRANDFATHER")).toEqual({
      kind: "chip",
      text: "On, kept from an earlier plan",
      badge: "grandfathered",
    });
    expect(chip("PRESET", true)).toEqual({ kind: "on", text: "On" });
    expect(chip("PRESET", false)).toEqual({ kind: "off", text: "Off" });
    expect(chip("NONE", false)).toEqual({ kind: "off", text: "Off" });
  });

  it("a chip that contradicts what the row is serving is not shown", () => {
    expect(deriveReadout(enforced, eff({ source: "OVERRIDE_GRANT", serving: false }))).toEqual({
      kind: "off",
      text: "Off",
    });
    expect(deriveReadout(enforced, eff({ source: "OVERRIDE_DENY", serving: true }))).toEqual({
      kind: "on",
      text: "On",
    });
  });
});
