/**
 * Plan catalog v13 definitions (#2700, SA-559/559b). The owner's 2026-09-28 decision ("Yes — add
 * Returns to Lite") supersedes the 2026-09-17 "Lite frozen" ruling for `flag.returns` ONLY: v13 is
 * v12 with LITE's featureFlags ∪ {"flag.returns"} and NOTHING else changed — every other plan
 * definition, every LITE field but featureFlags, and every addon SKU are v12's, deep-equal.
 *
 * A NEW version, never an amendment of v12 (PlanVersion rows are immutable history): v12's module
 * and its `LITE_FEATURE_FLAGS = []` pin stay as they are. Existing LITE tenants are NOT re-pinned —
 * they pick flag.returns up through "flags gain forward" (`effectivePlanFlags`,
 * plan-catalog.constants.ts), which reads the published version's plan flags.
 *
 * Pure data — no DB/Prisma import, no side effects, safe to import from a unit test (see
 * plan-catalog-v13.spec.ts). publish-plan-catalog-v13.ts imports from here.
 */
import { annualPrice } from "../src/billing/billing-math";
import type { AddonSeed, DefinitionSeed } from "./plan-catalog-v11.definitions";
import {
  V12_ADDON_SEEDS,
  V12_DEFINITIONS,
  type PublishedVersionRef,
  type V12AddonSkuRow,
  type V12DefinitionRow,
} from "./plan-catalog-v12.definitions";

/** The ONE flag v13 adds, to LITE only. */
export const V13_LITE_ADDED_FLAGS: readonly string[] = ["flag.returns"] as const;

/** V12_DEFINITIONS with ONLY LITE's featureFlags ∪ V13_LITE_ADDED_FLAGS (deduped, order kept). */
export const V13_DEFINITIONS: DefinitionSeed[] = V12_DEFINITIONS.map((d) =>
  d.planKey === "LITE"
    ? { ...d, featureFlags: [...new Set([...d.featureFlags, ...V13_LITE_ADDED_FLAGS])] }
    : d,
);

/** Unchanged from v12 — v13 adds no SKU and retires none. */
export const V13_ADDON_SEEDS: AddonSeed[] = V12_ADDON_SEEDS;

export interface V13Rows {
  notes: string;
  definitionRows: V12DefinitionRow[];
  addonSkuRows: V12AddonSkuRow[];
}

/** createMany-ready rows (minus planVersionId) + the DRAFT's notes — v12's buildV12Rows, for v13. */
export function buildV13Rows(published: PublishedVersionRef | null): V13Rows {
  return {
    notes: published
      ? `v13: LITE gains flag.returns (owner 2026-09-28), drafted from v${published.version}`
      : "v13: LITE gains flag.returns (owner 2026-09-28)",
    definitionRows: V13_DEFINITIONS.map((d) => ({
      planKey: d.planKey,
      name: d.name,
      monthlyPrice: d.monthlyPrice,
      annualPrice: d.monthlyPrice == null ? null : annualPrice(d.monthlyPrice),
      isCustom: d.isCustom,
      customersIncluded: d.customersIncluded,
      seatsIncluded: d.seatsIncluded,
      routesConcurrent: d.routesConcurrent,
      scansIncluded: d.scansIncluded,
      msgsIncluded: d.msgsIncluded,
      featureFlags: d.featureFlags,
      sortOrder: d.sortOrder,
    })),
    addonSkuRows: V13_ADDON_SEEDS.map((s) => ({
      sku: s.sku,
      name: s.name,
      monthlyPrice: s.monthlyPrice,
      unit: s.unit,
      includedAtPlan: s.includedAtPlan,
      meteredKey: s.meteredKey,
      capacityPerUnit: s.capacityPerUnit,
      stackable: s.stackable,
      grantsFlags: s.grantsFlags,
      sortOrder: s.sortOrder,
    })),
  };
}

/** A catalog's LITE definition carries every V13_LITE_ADDED_FLAGS key — v13's identity marker. */
export function liteCarriesV13Flags(
  definitions: readonly { planKey: string; featureFlags: readonly string[] }[],
): boolean {
  const lite = definitions.find((d) => d.planKey === "LITE");
  return !!lite && V13_LITE_ADDED_FLAGS.every((f) => lite.featureFlags.includes(f));
}
