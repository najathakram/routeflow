/**
 * Plan catalog v12 definitions (WP4, lite-L2 — R1.5/R1.6/R1.9/R3b.6/R7.2/R7.4). v12 adds LITE
 * (invite-only, $99/mo, ranked below STARTER) and folds five new plan-flag keys —
 * flag.estimates, flag.recurring_invoices, flag.credit_notes, flag.suppliers, flag.messaging
 * (already added to FLAG_KEYS by WP1, plan-catalog.constants.ts — not new here) — into every
 * v11 plan definition's featureFlags. Addon SKUs are untouched from v11.
 *
 * Pure data — no DB/Prisma import, no side effects, safe to import from a unit test (see
 * plan-catalog-v12.spec.ts). publish-plan-catalog-v12.ts imports V12_DEFINITIONS/
 * V12_ADDON_SEEDS/buildV12Rows from here rather than declaring them inline, mirroring how
 * plan-catalog-v11.definitions.ts factors v11's target catalog out of its publisher.
 */
import { annualPrice } from "../src/billing/billing-math";
import { LITE_PLAN_DISPLAY_NAME } from "../src/billing/plan-catalog.constants";
import type { AddonSeed, DefinitionSeed } from "./plan-catalog-v11.definitions";
import { V11_ADDON_SEEDS, V11_DEFINITIONS } from "./plan-catalog-v11.definitions";

/**
 * LITE's own feature flags — empty for v12. The Q2 flip (deciding which flags LITE should
 * carry) is deferred to a future v13 publisher; add the keys here when that decision lands,
 * not by editing V12_DEFINITIONS below.
 */
export const LITE_FEATURE_FLAGS: string[] = []; // Q2 flip = add keys here in a v13 publisher

/**
 * customersIncluded/seatsIncluded = STARTER's v11 values (owner may lower them later).
 * routesConcurrent/scansIncluded/msgsIncluded all 0 — LITE ships with no route/scan/message
 * allowance. monthlyPrice 99 → annualPrice(99) === 990, computed by buildV12Rows below the
 * same way every other definition's annualPrice is (never hardcoded here).
 */
export const LITE_DEFINITION: DefinitionSeed = {
  planKey: "LITE",
  name: LITE_PLAN_DISPLAY_NAME,
  monthlyPrice: 99,
  isCustom: false,
  customersIncluded: 100,
  seatsIncluded: 3, // = STARTER's v11 values (owner may lower later)
  routesConcurrent: 0,
  scansIncluded: 0,
  msgsIncluded: 0,
  featureFlags: LITE_FEATURE_FLAGS,
  sortOrder: 0,
};

/**
 * The 5 keys v12 newly enforces across every existing (non-LITE) plan definition
 * (R1.9/R3b.6) — already present in FLAG_KEYS (WP1), not declared there by this file.
 */
export const NEW_PLAN_FLAGS: readonly string[] = [
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
] as const;

/**
 * LITE first (sortOrder 0), then v11's four definitions unchanged except featureFlags gains
 * NEW_PLAN_FLAGS (deduped via Set — a flag already present in a plan's v11 flags is never
 * listed twice) and sortOrder shifts +1 to make room for LITE at the front of the ladder.
 */
export const V12_DEFINITIONS: DefinitionSeed[] = [
  LITE_DEFINITION,
  ...V11_DEFINITIONS.map((d) => ({
    ...d,
    featureFlags: [...new Set([...d.featureFlags, ...NEW_PLAN_FLAGS])],
    sortOrder: d.sortOrder + 1,
  })),
];

/** Unchanged from v11 — v12 adds no new AddonSku and retires none. */
export const V12_ADDON_SEEDS: AddonSeed[] = V11_ADDON_SEEDS;

/**
 * The minimal shape buildV12Rows needs from the currently-PUBLISHED PlanVersion — just the
 * version number, for the DRAFT's notes string. Keeping this a plain structural type (not the
 * full Prisma include payload) is what keeps this file DB-import-free and its rows testable
 * with a bare `{ version: N }` fixture, no Prisma/pg import required.
 */
export interface PublishedVersionRef {
  version: number;
}

/** createMany-ready PlanDefinition row data, minus planVersionId (assigned by the caller). */
export interface V12DefinitionRow {
  planKey: DefinitionSeed["planKey"];
  name: string;
  monthlyPrice: number | null;
  annualPrice: number | null;
  isCustom: boolean;
  customersIncluded: number | null;
  seatsIncluded: number | null;
  routesConcurrent: number | null;
  scansIncluded: number | null;
  msgsIncluded: number;
  featureFlags: string[];
  sortOrder: number;
}

/** createMany-ready AddonSku row data, minus planVersionId (assigned by the caller). */
export interface V12AddonSkuRow {
  sku: AddonSeed["sku"];
  name: string;
  monthlyPrice: number;
  unit: AddonSeed["unit"];
  includedAtPlan: AddonSeed["includedAtPlan"];
  meteredKey: AddonSeed["meteredKey"];
  capacityPerUnit: number | null;
  stackable: boolean;
  grantsFlags: string[];
  sortOrder: number;
}

export interface V12Rows {
  notes: string;
  definitionRows: V12DefinitionRow[];
  addonSkuRows: V12AddonSkuRow[];
}

/**
 * Build the createMany-ready row data (minus planVersionId, assigned by the caller at insert
 * time) plus the DRAFT's notes string — a pure extraction of the mapping
 * publish-plan-catalog-v11.ts does inline in its main(), parametrized on the currently
 * PUBLISHED version (or null) exactly like v11's own `notes: published ? ... : ...` ternary.
 * Never touches a database — safe to call directly from a unit test.
 */
export function buildV12Rows(published: PublishedVersionRef | null): V12Rows {
  return {
    notes: published
      ? "v12: add LITE (invite-only) + enforce estimates/recurring_invoices/credit_notes/" +
        `suppliers/messaging flags, drafted from v${published.version}`
      : "v12: add LITE (invite-only) + enforce estimates/recurring_invoices/credit_notes/" +
        "suppliers/messaging flags",
    definitionRows: V12_DEFINITIONS.map((d) => ({
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
    addonSkuRows: V12_ADDON_SEEDS.map((s) => ({
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
