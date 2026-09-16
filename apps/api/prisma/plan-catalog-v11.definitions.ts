/**
 * Plan catalog v11 definitions — extracted from publish-plan-catalog-v11.ts (WP4, lite-L2
 * R7.2) so plan-catalog-v12's publisher can import v11's plan/addon shapes instead of
 * re-typing them. Pure data — no DB/Prisma import, no side effects, safe to import from a
 * unit test.
 *
 * NON-BEHAVIORAL EXTRACTION ONLY: every value below is byte-for-byte identical to what
 * publish-plan-catalog-v11.ts declared inline before this split — same DEFINITIONS,
 * same ADDON_SEEDS, same comments explaining WHY. Do not change v11's DB rows or its
 * idempotency logic here (both stayed in publish-plan-catalog-v11.ts, which now imports
 * V11_DEFINITIONS/V11_ADDON_SEEDS from this file) — see that file's header for the full v11
 * retirement story (BUYER_PORTAL/SEAT_EXTRA/OCR_PACK_250/ROUTE_EXTRA/MSG_BUNDLE_500 dropped,
 * grandfathering rules, etc.).
 */
import type { AddonSkuCode, PlanKey } from "../src/billing/plan-catalog.constants";

export type Unit = "FLAT" | "PER_USER" | "PER_ROUTE";
export type Meter = "SEATS" | "ROUTES" | "SCANS" | "MSGS" | "CUSTOMERS";

export interface DefinitionSeed {
  planKey: PlanKey;
  name: string;
  monthlyPrice: number | null;
  isCustom: boolean;
  customersIncluded: number | null;
  seatsIncluded: number | null;
  routesConcurrent: number | null;
  scansIncluded: number | null;
  msgsIncluded: number;
  featureFlags: string[];
  sortOrder: number;
}

export interface AddonSeed {
  sku: AddonSkuCode;
  name: string;
  monthlyPrice: number;
  unit: Unit;
  includedAtPlan: PlanKey | null;
  meteredKey: Meter | null;
  capacityPerUnit: number | null;
  stackable: boolean;
  grantsFlags: string[];
  sortOrder: number;
}

// Unchanged from v10 — plan definitions are not touched by the v11 retirement. Note
// GROWTH_FLAGS still lists `addon.buyer_portal`: that flag is granted BY THE PLAN
// DEFINITION, independent of the BUYER_PORTAL AddonSku row v11 drops (see the
// grandfathering note in publish-plan-catalog-v11.ts's header). `flag.sales_agents` stays
// excluded from every plan's featureFlags, same treatment as `flag.msrp` and
// `flag.dispatch_live`.
const STARTER_FLAGS = ["flag.returns"];
const GROWTH_FLAGS = [
  ...STARTER_FLAGS,
  "flag.reports",
  "flag.ap_bills",
  "flag.credit_limits",
  "flag.pricing_tiers",
  "flag.analytics",
  "addon.buyer_portal",
];
const SCALE_FLAGS = [
  ...GROWTH_FLAGS,
  "flag.settlement",
  "flag.forecasting",
  "flag.import_integrations",
  "addon.regulated_items",
  "addon.ocr",
];
// FROZEN as of v11's actual publish. Do NOT re-derive from the live FLAG_KEYS array — that
// silently changed this from 13 to 18 flags when WP1 added 5 new Lite-plan flags to FLAG_KEYS
// (finding 3, Lite-L2 review). These are the exact 13 keys prod's v11 ENTERPRISE row carries.
const ENTERPRISE_FLAGS = [
  "flag.returns",
  "flag.ap_bills",
  "flag.reports",
  "flag.credit_limits",
  "flag.settlement",
  "flag.pricing_tiers",
  "flag.analytics",
  "flag.forecasting",
  "flag.import_integrations",
  "flag.api_sso",
  "addon.buyer_portal",
  "addon.regulated_items",
  "addon.ocr",
];

export const V11_DEFINITIONS: DefinitionSeed[] = [
  {
    planKey: "STARTER",
    name: "Starter",
    monthlyPrice: 99,
    isCustom: false,
    customersIncluded: 100,
    seatsIncluded: 3,
    routesConcurrent: 1,
    scansIncluded: 20,
    msgsIncluded: 200,
    featureFlags: STARTER_FLAGS,
    sortOrder: 0,
  },
  {
    planKey: "GROWTH",
    name: "Growth",
    monthlyPrice: 249,
    isCustom: false,
    customersIncluded: 250,
    seatsIncluded: 10,
    routesConcurrent: 3,
    scansIncluded: 100,
    msgsIncluded: 200,
    featureFlags: GROWTH_FLAGS,
    sortOrder: 1,
  },
  {
    planKey: "SCALE",
    name: "Scale",
    monthlyPrice: 499,
    isCustom: false,
    customersIncluded: 500,
    seatsIncluded: 25,
    routesConcurrent: 10,
    scansIncluded: 300,
    msgsIncluded: 200,
    featureFlags: SCALE_FLAGS,
    sortOrder: 2,
  },
  {
    planKey: "ENTERPRISE",
    name: "Enterprise",
    monthlyPrice: null,
    isCustom: true,
    customersIncluded: null,
    seatsIncluded: null,
    routesConcurrent: null,
    scansIncluded: null,
    msgsIncluded: 200,
    featureFlags: ENTERPRISE_FLAGS,
    sortOrder: 3,
  },
];

// The 5 surviving SKUs carry forward from v10 unchanged (same name/price/unit/
// grantsFlags), renumbered to a contiguous sortOrder 0-4 in their existing relative
// order. BUYER_PORTAL, SEAT_EXTRA, OCR_PACK_250, ROUTE_EXTRA, and MSG_BUNDLE_500 are
// deliberately absent — see RETIRED_SKUS and the header in publish-plan-catalog-v11.ts.
export const V11_ADDON_SEEDS: AddonSeed[] = [
  {
    sku: "REGULATED_ITEMS",
    name: "Regulated items",
    monthlyPrice: 39,
    unit: "FLAT",
    includedAtPlan: "SCALE",
    meteredKey: null,
    capacityPerUnit: null,
    stackable: false,
    grantsFlags: ["addon.regulated_items"],
    sortOrder: 0,
  },
  {
    sku: "FORECASTING",
    name: "Forecasting",
    monthlyPrice: 19,
    unit: "FLAT",
    includedAtPlan: "SCALE",
    meteredKey: null,
    capacityPerUnit: null,
    stackable: false,
    grantsFlags: ["flag.forecasting", "flag.analytics"],
    sortOrder: 1,
  },
  {
    sku: "CUSTOMER_PACK_100",
    name: "Customer pack (+100)",
    monthlyPrice: 50,
    unit: "FLAT",
    includedAtPlan: null,
    meteredKey: "CUSTOMERS",
    capacityPerUnit: 100,
    stackable: true,
    grantsFlags: [],
    sortOrder: 2,
  },
  {
    sku: "MSRP",
    name: "MSRP on invoices",
    monthlyPrice: 0,
    unit: "FLAT",
    includedAtPlan: null,
    meteredKey: null,
    capacityPerUnit: null,
    stackable: false,
    grantsFlags: ["flag.msrp"],
    sortOrder: 3,
  },
  {
    sku: "SALES_AGENTS",
    name: "Sales agents & commissions",
    monthlyPrice: 0,
    unit: "FLAT",
    includedAtPlan: null,
    meteredKey: null,
    capacityPerUnit: null,
    stackable: false,
    grantsFlags: ["flag.sales_agents"],
    sortOrder: 4,
  },
];
