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

describe("#2700 F4 / SA-559d: v13 publishes only over a PUBLISHED v12", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { diffPublishedAgainstV12 } = require("../../prisma/plan-catalog-v13.definitions");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { publishV13 } = require("../../prisma/publish-plan-catalog-v13");
  /** A Prisma-Decimal-like value (what a real read returns for money columns). */
  const dec = (n: number | null) => (n == null ? null : { toString: () => String(n) });
  const publishedV12 = () => {
    const rows = buildV12Rows(null);
    return {
      version: 12,
      definitions: rows.definitionRows.map((d) => ({
        ...d,
        monthlyPrice: dec(d.monthlyPrice),
        annualPrice: dec(d.annualPrice),
      })),
      addonSkus: rows.addonSkuRows.map((s) => ({ ...s, monthlyPrice: dec(s.monthlyPrice) })),
    };
  };

  it("an untouched published v12 has no drift (Decimals compared by value)", () => {
    expect(diffPublishedAgainstV12(publishedV12())).toEqual([]);
  });

  it("LITE's featureFlags are the one thing ignored", () => {
    const p = publishedV12();
    p.definitions.find((d) => d.planKey === "LITE")!.featureFlags = ["flag.returns", "flag.x"];
    expect(diffPublishedAgainstV12(p)).toEqual([]);
  });

  it("a post-v12 edit is named: a price, another plan's flags, a missing SKU, an extra plan", () => {
    const p = publishedV12();
    p.definitions.find((d) => d.planKey === "STARTER")!.monthlyPrice = dec(1);
    p.definitions.find((d) => d.planKey === "GROWTH")!.featureFlags = [];
    p.addonSkus.pop();
    p.definitions.push({
      ...p.definitions[0],
      planKey: "EXTRA" as (typeof p.definitions)[number]["planKey"],
    });
    const drift: string[] = diffPublishedAgainstV12(p);
    expect(drift).toHaveLength(4);
    expect(drift.join("\n")).toMatch(/STARTER\.monthlyPrice: published 1/);
    expect(drift.join("\n")).toMatch(/GROWTH\.featureFlags/);
    expect(drift.join("\n")).toMatch(/AddonSku .*: missing from the published version/);
    expect(drift.join("\n")).toMatch(/PlanDefinition EXTRA: not in v12/);
  });

  it("publishV13 REFUSES over a drifted published version and writes nothing", async () => {
    const p = publishedV12();
    p.definitions.find((d) => d.planKey === "STARTER")!.monthlyPrice = dec(1);
    const writes: string[] = [];
    const prisma = {
      planVersion: {
        findFirst: jest.fn().mockResolvedValue(p),
        create: jest.fn(() => writes.push("create")),
        update: jest.fn(() => writes.push("update")),
        updateMany: jest.fn(() => writes.push("updateMany")),
      },
      $transaction: jest.fn(() => writes.push("$transaction")),
    };
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(publishV13(prisma)).rejects.toThrow(
      /not v12 .*refusing:\n {2}PlanDefinition STARTER\.monthlyPrice/s,
    );
    log.mockRestore();
    expect(writes).toEqual([]);
  });
});
