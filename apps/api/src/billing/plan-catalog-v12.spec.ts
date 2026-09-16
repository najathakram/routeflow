/**
 * Pure unit spec for plan-catalog-v12.definitions.ts (WP4, lite-L2 — R1.5/R1.6/R1.9/R3b.6/
 * R7.2/R7.4). No DB, no Prisma client — every export under test is plain data or a pure
 * function. The DB-backed publish flow (publishV12 against a real Postgres) is covered
 * separately by publish-plan-catalog-v12.db.spec.ts (npm run local:test:db).
 */
import { annualPrice } from "./billing-math";
import { FLAG_KEYS } from "./plan-catalog.constants";
import { V11_ADDON_SEEDS, V11_DEFINITIONS } from "../../prisma/plan-catalog-v11.definitions";
import {
  LITE_DEFINITION,
  LITE_FEATURE_FLAGS,
  NEW_PLAN_FLAGS,
  V12_ADDON_SEEDS,
  V12_DEFINITIONS,
  buildV12Rows,
} from "../../prisma/plan-catalog-v12.definitions";

describe("plan-catalog-v12.definitions", () => {
  describe("NEW_PLAN_FLAGS", () => {
    it("is exactly the 5 keys the brief names, each already present in FLAG_KEYS (WP1)", () => {
      expect(NEW_PLAN_FLAGS).toEqual([
        "flag.estimates",
        "flag.recurring_invoices",
        "flag.credit_notes",
        "flag.suppliers",
        "flag.messaging",
      ]);
      for (const flag of NEW_PLAN_FLAGS) {
        expect(FLAG_KEYS).toContain(flag);
      }
    });
  });

  describe("LITE_DEFINITION", () => {
    it("matches the exact shape the brief specifies", () => {
      expect(LITE_DEFINITION).toEqual({
        planKey: "LITE",
        name: "Lite",
        monthlyPrice: 99,
        isCustom: false,
        customersIncluded: 100,
        seatsIncluded: 3,
        routesConcurrent: 0,
        scansIncluded: 0,
        msgsIncluded: 0,
        featureFlags: LITE_FEATURE_FLAGS,
        sortOrder: 0,
      });
    });

    it("customersIncluded/seatsIncluded mirror STARTER's v11 values", () => {
      const starter = V11_DEFINITIONS.find((d) => d.planKey === "STARTER");
      expect(starter).toBeDefined();
      expect(LITE_DEFINITION.customersIncluded).toBe(starter!.customersIncluded);
      expect(LITE_DEFINITION.seatsIncluded).toBe(starter!.seatsIncluded);
    });

    it("LITE_FEATURE_FLAGS is empty — the Q2 flip is deferred to a v13 publisher", () => {
      expect(LITE_FEATURE_FLAGS).toEqual([]);
    });
  });

  describe("V12_DEFINITIONS", () => {
    it("has one more entry than V11_DEFINITIONS (LITE added, nothing removed)", () => {
      expect(V12_DEFINITIONS).toHaveLength(V11_DEFINITIONS.length + 1);
    });

    it("puts LITE first at sortOrder 0", () => {
      expect(V12_DEFINITIONS[0]).toEqual(LITE_DEFINITION);
      expect(V12_DEFINITIONS[0].sortOrder).toBe(0);
    });

    it("carries every v11 definition forward with sortOrder shifted +1 and no other field changed", () => {
      const v11ByKey = new Map(V11_DEFINITIONS.map((d) => [d.planKey, d]));
      const carried = V12_DEFINITIONS.slice(1);
      expect(carried).toHaveLength(V11_DEFINITIONS.length);
      for (const d of carried) {
        const original = v11ByKey.get(d.planKey);
        expect(original).toBeDefined();
        expect(d.sortOrder).toBe(original!.sortOrder + 1);
        expect(d.name).toBe(original!.name);
        expect(d.monthlyPrice).toBe(original!.monthlyPrice);
        expect(d.isCustom).toBe(original!.isCustom);
        expect(d.customersIncluded).toBe(original!.customersIncluded);
        expect(d.seatsIncluded).toBe(original!.seatsIncluded);
        expect(d.routesConcurrent).toBe(original!.routesConcurrent);
        expect(d.scansIncluded).toBe(original!.scansIncluded);
        expect(d.msgsIncluded).toBe(original!.msgsIncluded);
      }
    });

    it("preserves STARTER/GROWTH/SCALE/ENTERPRISE relative order after LITE", () => {
      expect(V12_DEFINITIONS.map((d) => d.planKey)).toEqual([
        "LITE",
        "STARTER",
        "GROWTH",
        "SCALE",
        "ENTERPRISE",
      ]);
      expect(V12_DEFINITIONS.map((d) => d.sortOrder)).toEqual([0, 1, 2, 3, 4]);
    });

    it("folds NEW_PLAN_FLAGS into every non-LITE definition's featureFlags, deduped, without dropping any v11 flag", () => {
      const v11ByKey = new Map(V11_DEFINITIONS.map((d) => [d.planKey, d]));
      for (const d of V12_DEFINITIONS.slice(1)) {
        const original = v11ByKey.get(d.planKey)!;
        // Every original flag survives.
        for (const flag of original.featureFlags) {
          expect(d.featureFlags).toContain(flag);
        }
        // Every new flag was added.
        for (const flag of NEW_PLAN_FLAGS) {
          expect(d.featureFlags).toContain(flag);
        }
        // No duplicates.
        expect(new Set(d.featureFlags).size).toBe(d.featureFlags.length);
        // Nothing extra beyond the union of the two sets.
        expect(d.featureFlags.length).toBe(
          new Set([...original.featureFlags, ...NEW_PLAN_FLAGS]).size,
        );
      }
    });

    it("LITE's featureFlags are untouched by the NEW_PLAN_FLAGS fold", () => {
      expect(V12_DEFINITIONS[0].featureFlags).toEqual(LITE_FEATURE_FLAGS);
    });
  });

  describe("V12_ADDON_SEEDS", () => {
    it("is identical to V11_ADDON_SEEDS — v12 adds no new SKU and retires none", () => {
      expect(V12_ADDON_SEEDS).toEqual(V11_ADDON_SEEDS);
      expect(V12_ADDON_SEEDS).toHaveLength(V11_ADDON_SEEDS.length);
    });
  });

  describe("buildV12Rows", () => {
    it("builds one definitionRow per V12_DEFINITIONS entry and one addonSkuRow per V12_ADDON_SEEDS entry", () => {
      const rows = buildV12Rows(null);
      expect(rows.definitionRows).toHaveLength(V12_DEFINITIONS.length);
      expect(rows.addonSkuRows).toHaveLength(V12_ADDON_SEEDS.length);
    });

    it("computes LITE's annualPrice via the shared annualPrice() helper (99 -> 990)", () => {
      const rows = buildV12Rows(null);
      const lite = rows.definitionRows.find((d) => d.planKey === "LITE");
      expect(lite).toBeDefined();
      expect(lite!.monthlyPrice).toBe(99);
      expect(lite!.annualPrice).toBe(annualPrice(99));
      expect(lite!.annualPrice).toBe(990);
    });

    it("gives ENTERPRISE (null monthlyPrice) a null annualPrice, never a computed one", () => {
      const rows = buildV12Rows(null);
      const enterprise = rows.definitionRows.find((d) => d.planKey === "ENTERPRISE");
      expect(enterprise).toBeDefined();
      expect(enterprise!.monthlyPrice).toBeNull();
      expect(enterprise!.annualPrice).toBeNull();
    });

    it("preserves definitionRow/addonSkuRow field shape and values from the seed arrays", () => {
      const rows = buildV12Rows(null);
      const lite = rows.definitionRows[0];
      expect(lite).toMatchObject({
        planKey: "LITE",
        name: "Lite",
        isCustom: false,
        customersIncluded: 100,
        seatsIncluded: 3,
        routesConcurrent: 0,
        scansIncluded: 0,
        msgsIncluded: 0,
        sortOrder: 0,
      });
      const firstAddon = rows.addonSkuRows[0];
      const firstSeed = V12_ADDON_SEEDS[0];
      expect(firstAddon).toEqual({
        sku: firstSeed.sku,
        name: firstSeed.name,
        monthlyPrice: firstSeed.monthlyPrice,
        unit: firstSeed.unit,
        includedAtPlan: firstSeed.includedAtPlan,
        meteredKey: firstSeed.meteredKey,
        capacityPerUnit: firstSeed.capacityPerUnit,
        stackable: firstSeed.stackable,
        grantsFlags: firstSeed.grantsFlags,
        sortOrder: firstSeed.sortOrder,
      });
    });

    it("notes has no 'drafted from' clause when published is null", () => {
      const rows = buildV12Rows(null);
      expect(rows.notes).toBe(
        "v12: add LITE (invite-only) + enforce estimates/recurring_invoices/credit_notes/" +
          "suppliers/messaging flags",
      );
      expect(rows.notes).not.toContain("drafted from");
    });

    it("notes cites the published version's number when given one", () => {
      const rows = buildV12Rows({ version: 11 });
      expect(rows.notes).toBe(
        "v12: add LITE (invite-only) + enforce estimates/recurring_invoices/credit_notes/" +
          "suppliers/messaging flags, drafted from v11",
      );
    });

    it("is a pure function — calling it twice with equivalent input produces deep-equal output", () => {
      const a = buildV12Rows({ version: 7 });
      const b = buildV12Rows({ version: 7 });
      expect(a).toEqual(b);
    });
  });
});
