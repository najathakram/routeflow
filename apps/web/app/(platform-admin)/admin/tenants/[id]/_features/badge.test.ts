import { deriveBadge } from "./badge";
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
