/**
 * #2700 (SA-559(1)) — plan catalog v13 is v12 with ONLY LITE's featureFlags ∪ {flag.returns}.
 * Pure: no DB. The publisher's DB mechanics are publish-plan-catalog-v13.db.spec.ts (F2's lane).
 */
import {
  V12_ADDON_SEEDS,
  V12_DEFINITIONS,
  buildV12Rows,
  LITE_FEATURE_FLAGS,
} from "../../prisma/plan-catalog-v12.definitions";
import {
  V13_ADDON_SEEDS,
  V13_DEFINITIONS,
  V13_LITE_ADDED_FLAGS,
  buildV13Rows,
  liteCarriesV13Flags,
} from "../../prisma/plan-catalog-v13.definitions";
import { FLAG_KEYS } from "./plan-catalog.constants";

const byKey = <T extends { planKey: string }>(defs: T[], key: string) =>
  defs.find((d) => d.planKey === key)!;

describe("plan-catalog-v13.definitions (#2700)", () => {
  it("adds exactly one flag, flag.returns — a real FLAG_KEYS key", () => {
    expect([...V13_LITE_ADDED_FLAGS]).toEqual(["flag.returns"]);
    expect(FLAG_KEYS).toContain("flag.returns");
  });

  it("LITE carries flag.returns", () => {
    expect(byKey(V13_DEFINITIONS, "LITE").featureFlags).toContain("flag.returns");
  });

  it("LITE is otherwise deep-equal to v12's LITE", () => {
    const { featureFlags: v13Flags, ...v13Rest } = byKey(V13_DEFINITIONS, "LITE");
    const { featureFlags: v12Flags, ...v12Rest } = byKey(V12_DEFINITIONS, "LITE");
    expect(v13Rest).toEqual(v12Rest);
    expect(v13Flags).toEqual([...v12Flags, "flag.returns"]);
  });

  it("every other definition is deep-equal to v12's, in the same order", () => {
    expect(V13_DEFINITIONS.map((d) => d.planKey)).toEqual(V12_DEFINITIONS.map((d) => d.planKey));
    for (const d of V13_DEFINITIONS.filter((x) => x.planKey !== "LITE")) {
      expect(d).toEqual(byKey(V12_DEFINITIONS, d.planKey));
    }
  });

  it("every addon SKU is v12's (none added, none retired)", () => {
    expect(V13_ADDON_SEEDS).toEqual(V12_ADDON_SEEDS);
  });

  it("v12 stays history: its module and its LITE `[]` pin are untouched", () => {
    expect(LITE_FEATURE_FLAGS).toEqual([]);
    expect(byKey(V12_DEFINITIONS, "LITE").featureFlags).toEqual([]);
  });

  it("buildV13Rows = buildV12Rows except LITE's featureFlags and the notes", () => {
    const v13 = buildV13Rows({ version: 12 });
    const v12 = buildV12Rows({ version: 11 });
    expect(v13.addonSkuRows).toEqual(v12.addonSkuRows);
    expect(
      v13.definitionRows.map((r) => (r.planKey === "LITE" ? { ...r, featureFlags: [] } : r)),
    ).toEqual(v12.definitionRows);
    expect(v13.notes).toBe("v13: LITE gains flag.returns (owner 2026-09-28), drafted from v12");
    expect(buildV13Rows(null).notes).toBe("v13: LITE gains flag.returns (owner 2026-09-28)");
  });

  it("liteCarriesV13Flags is the noop / resume marker: v13 yes, v12 no, no LITE no", () => {
    expect(liteCarriesV13Flags(V13_DEFINITIONS)).toBe(true);
    expect(liteCarriesV13Flags(V12_DEFINITIONS)).toBe(false);
    expect(liteCarriesV13Flags(V12_DEFINITIONS.filter((d) => d.planKey !== "LITE"))).toBe(false);
  });
});
