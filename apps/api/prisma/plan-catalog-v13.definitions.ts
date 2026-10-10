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
  buildV12Rows,
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

/** The shape of a PUBLISHED version's rows the precondition compares (Decimals arrive as objects). */
export interface PublishedCatalogRows {
  definitions: ReadonlyArray<Record<string, unknown> & { planKey: string }>;
  addonSkus: ReadonlyArray<Record<string, unknown> & { sku: string }>;
}

const DEF_FIELDS = [
  "name",
  "monthlyPrice",
  "annualPrice",
  "isCustom",
  "customersIncluded",
  "seatsIncluded",
  "routesConcurrent",
  "scansIncluded",
  "msgsIncluded",
  "featureFlags",
  "sortOrder",
] as const;
const SKU_FIELDS = [
  "name",
  "monthlyPrice",
  "unit",
  "includedAtPlan",
  "meteredKey",
  "capacityPerUnit",
  "stackable",
  "grantsFlags",
  "sortOrder",
] as const;

/** Prisma Decimal / number / null → a comparable JSON value. */
function norm(v: unknown): unknown {
  if (v == null) return null;
  if (
    typeof v === "object" &&
    !Array.isArray(v) &&
    typeof (v as { toString(): string }).toString === "function"
  ) {
    const n = Number((v as { toString(): string }).toString());
    return Number.isFinite(n) ? n : v;
  }
  return v;
}

/**
 * #2700 (lead F4 / SA-559d): v13 is "v12 + LITE ∋ flag.returns" ONLY IF the version actually
 * PUBLISHED in the target DB is v12. Diffs that published catalog against buildV12Rows, ignoring
 * LITE's featureFlags only — any other difference (a post-v12 Plans-editor edit, a missing or extra
 * plan or SKU) is listed, and the publisher REFUSES, so a live edit is never silently reverted by
 * publishing a v13 built from the v12 constants. `[]` = safe to publish.
 */
export function diffPublishedAgainstV12(published: PublishedCatalogRows): string[] {
  const v12 = buildV12RowsForDiff();
  const out: string[] = [];
  const pubDefs = new Map(published.definitions.map((d) => [d.planKey, d]));
  const wantDefs = new Map(v12.definitionRows.map((d) => [d.planKey as string, d]));
  for (const key of new Set([...pubDefs.keys(), ...wantDefs.keys()])) {
    const got = pubDefs.get(key);
    const want = wantDefs.get(key);
    if (!got) out.push(`PlanDefinition ${key}: missing from the published version`);
    else if (!want) out.push(`PlanDefinition ${key}: not in v12 (published has it)`);
    else
      for (const f of DEF_FIELDS) {
        if (key === "LITE" && f === "featureFlags") continue;
        const a = JSON.stringify(norm(got[f]));
        const b = JSON.stringify(norm((want as unknown as Record<string, unknown>)[f]));
        if (a !== b) out.push(`PlanDefinition ${key}.${f}: published ${a}, v12 ${b}`);
      }
  }
  const pubSkus = new Map(published.addonSkus.map((s) => [s.sku, s]));
  const wantSkus = new Map(v12.addonSkuRows.map((s) => [s.sku as string, s]));
  for (const sku of new Set([...pubSkus.keys(), ...wantSkus.keys()])) {
    const got = pubSkus.get(sku);
    const want = wantSkus.get(sku);
    if (!got) out.push(`AddonSku ${sku}: missing from the published version`);
    else if (!want) out.push(`AddonSku ${sku}: not in v12 (published has it)`);
    else
      for (const f of SKU_FIELDS) {
        const a = JSON.stringify(norm(got[f]));
        const b = JSON.stringify(norm((want as unknown as Record<string, unknown>)[f]));
        if (a !== b) out.push(`AddonSku ${sku}.${f}: published ${a}, v12 ${b}`);
      }
  }
  return out;
}

function buildV12RowsForDiff() {
  // The notes string is irrelevant to the diff; any published ref works.
  return buildV12Rows(null);
}
