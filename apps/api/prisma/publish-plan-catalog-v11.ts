/**
 * Publish plan catalog v11 — retires five unenforced add-on SKUs.
 *
 * Production already has PlanVersion v10 PUBLISHED (adds SALES_AGENTS — see
 * publish-plan-catalog-v10.ts). This script does NOT reseed the ladder: it opens a
 * new DRAFT version carrying the same plan definitions unchanged, and PUBLISHES it
 * through the same lifecycle the platform-admin Plans editor uses
 * (PlanCatalogService.createDraft/publish) — so the prior published version is marked
 * SUPERSEDED and existing tenants keep whatever planVersionId they were already pinned
 * to (grandfathering; see plan-catalog.service.ts `publish()`). No tenant is re-pinned.
 *
 * Retirement rule (owner decision 2026-08-24): BUYER_PORTAL, SEAT_EXTRA, OCR_PACK_250,
 * ROUTE_EXTRA, and MSG_BUNDLE_500 are dropped from this version's AddonSku rows because
 * none of them has real enforcement behind it today — BUYER_PORTAL gates nothing (the
 * module is unbuilt), and the four metered add-ons (SEAT_EXTRA/OCR_PACK_250/ROUTE_EXTRA/
 * MSG_BUNDLE_500) have no cap-check wired to their meter. Selling a SKU with no
 * enforcement behind it is the bug this retires. Re-adding any of these five requires
 * its cap check (or, for BUYER_PORTAL, the module itself) to ship FIRST — do not
 * resurrect a SKU here without that.
 *
 * Grandfathering note: dropping a SKU from this version's AddonSku rows does not touch
 * any TenantAddon row, and does not touch plan-level feature flags. A plan's
 * featureFlags (e.g. GROWTH's `addon.buyer_portal`) are granted BY THE PLAN DEFINITION,
 * independent of whether a matching AddonSku row exists — those are untouched here,
 * same as every other field in DEFINITIONS. Any tenant with an active TenantAddon row
 * for a retired SKU keeps the row; EntitlementsService.compute() resolves active
 * TenantAddon rows against the tenant's pinned (or, as a fallback, the published)
 * version's AddonSku set — a row whose SKU is absent from both logs a warning and
 * grants nothing (entitlements.service.ts), it does not throw and it does not delete
 * the row. Cleaning up existing TenantAddon rows for retired SKUs is a separate,
 * orchestrator-run script — out of scope here.
 *
 * The 5 remaining SKUs (CUSTOMER_PACK_100, FORECASTING, REGULATED_ITEMS, MSRP,
 * SALES_AGENTS) carry forward from v10 unchanged.
 *
 * This file mirrors prisma/seed.ts's connection setup (raw PrismaClient over the pg
 * adapter, driven by DATABASE_URL) rather than booting a Nest application context just
 * to call one service method — the same tradeoff seed.ts and publish-plan-catalog-v8.ts
 * already make for scripts under apps/api/prisma/. The writes below are a deliberate
 * line-for-line mirror of PlanCatalogService.createDraft() and
 * PlanCatalogService.publish(); keep them in lock-step if those methods' field writes
 * ever change.
 *
 * Idempotent: if the currently PUBLISHED version's AddonSku rows already lack all five
 * retired SKUs, this exits 0 without writing anything. Safe to re-run (including after a
 * partial failure — see the DRAFT-resume note below). Never deletes anything — it never
 * touches an existing PlanVersion's rows; SUPERSEDED versions and their AddonSku rows are
 * left in place for history.
 *
 * Local:   ts-node -r tsconfig-paths/register prisma/publish-plan-catalog-v11.ts (from apps/api)
 * Railway: railway run --service postgres ts-node -r tsconfig-paths/register prisma/publish-plan-catalog-v11.ts
 * (Wired up as `npm run db:publish:catalog:v11` in apps/api/package.json — run it in every
 * environment to retire the five dead SKUs from the self-service and platform-admin catalog
 * reads. NOT run by this pipeline — the orchestrator runs it in prod post-merge.)
 */
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { annualPrice } from "../src/billing/billing-math";
import { ADDON_SKUS, FLAG_KEYS } from "../src/billing/plan-catalog.constants";
import type { AddonSkuCode, PlanKey } from "../src/billing/plan-catalog.constants";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const WITH_CATALOG = {
  definitions: { orderBy: { sortOrder: "asc" } },
  addonSkus: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.PlanVersionInclude;
type CatalogVersion = Prisma.PlanVersionGetPayload<{ include: typeof WITH_CATALOG }>;

/** Strip credentials from a Postgres connection string for safe logging. */
function maskDbUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

// The five SKUs this version retires — see the header for the rule. Kept as one
// list so the idempotency check, the DRAFT-resume detection, and the seed sanity
// check below all agree on exactly what "already migrated" means.
const RETIRED_SKUS: readonly AddonSkuCode[] = [
  "BUYER_PORTAL",
  "SEAT_EXTRA",
  "OCR_PACK_250",
  "ROUTE_EXTRA",
  "MSG_BUNDLE_500",
] as const;

// ─── Target catalog (same ladder as v10, minus the five retired AddonSku rows) ────

type Unit = "FLAT" | "PER_USER" | "PER_ROUTE";
type Meter = "SEATS" | "ROUTES" | "SCANS" | "MSGS" | "CUSTOMERS";

interface DefinitionSeed {
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

interface AddonSeed {
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

// Unchanged from v10 — plan definitions are not touched by this retirement. Note
// GROWTH_FLAGS still lists `addon.buyer_portal`: that flag is granted BY THE PLAN
// DEFINITION, independent of the BUYER_PORTAL AddonSku row this version drops (see
// the grandfathering note in the header). `flag.sales_agents` stays excluded from
// every plan's featureFlags, same treatment as `flag.msrp` and `flag.dispatch_live`.
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
const ENTERPRISE_FLAGS = FLAG_KEYS.filter(
  (f) => f !== "flag.dispatch_live" && f !== "flag.msrp" && f !== "flag.sales_agents",
);

const DEFINITIONS: DefinitionSeed[] = [
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
// deliberately absent — see RETIRED_SKUS and the header.
const ADDON_SEEDS: AddonSeed[] = [
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

// Sanity-check our own seed data against the vocabulary this script imports —
// catches a typo'd SKU code (or a forgotten retirement) before it ever reaches the
// database. Unlike v10, the seeded set is ADDON_SKUS MINUS RETIRED_SKUS, not all of
// ADDON_SKUS — this version deliberately does not seed every known SKU.
const targetSkus = new Set(ADDON_SEEDS.map((s) => s.sku));
const expectedSkus = new Set(ADDON_SKUS.filter((sku) => !RETIRED_SKUS.includes(sku)));
for (const sku of expectedSkus) {
  if (!targetSkus.has(sku)) {
    throw new Error(`publish-plan-catalog-v11: missing a seed row for AddonSku "${sku}"`);
  }
}
if (targetSkus.size !== expectedSkus.size) {
  throw new Error(
    "publish-plan-catalog-v11: ADDON_SEEDS has an entry not in ADDON_SKUS minus RETIRED_SKUS",
  );
}
for (const sku of RETIRED_SKUS) {
  if (targetSkus.has(sku)) {
    throw new Error(
      `publish-plan-catalog-v11: retired SKU "${sku}" must not appear in ADDON_SEEDS`,
    );
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — refusing to run.");
  }
  console.log(`publish-plan-catalog-v11 target: ${maskDbUrl(process.env.DATABASE_URL)}`);

  const published = await prisma.planVersion.findFirst({
    where: { status: "PUBLISHED" },
    orderBy: { version: "desc" },
    include: WITH_CATALOG,
  });

  const alreadyPublished = published
    ? RETIRED_SKUS.every((sku) => !published.addonSkus.some((s) => s.sku === sku))
    : false;
  if (alreadyPublished) {
    console.log(
      `already published: v${published!.version} already lacks all five retired SKUs — nothing to do.`,
    );
    return;
  }

  // Reuse a leftover DRAFT from a previously interrupted run of THIS script
  // (identified by its AddonSku rows matching our target set exactly) instead of
  // failing on PlanCatalogService.createDraft()'s "one draft at a time" rule or
  // leaving orphaned rows behind. A DRAFT that does NOT match is left alone — it may
  // be in-progress admin work — and the script fails loudly rather than touching it.
  let draft: CatalogVersion | null = await prisma.planVersion.findFirst({
    where: { status: "DRAFT" },
    include: WITH_CATALOG,
  });

  if (draft) {
    const isOurDraft =
      draft.addonSkus.length === targetSkus.size &&
      draft.addonSkus.every((s) => targetSkus.has(s.sku as AddonSkuCode));
    if (!isOurDraft) {
      throw new Error(
        `A DRAFT plan version (v${draft.version}) already exists and doesn't match the v11 ` +
          "catalog this script publishes. Resolve or discard it via the platform-admin Plans " +
          "editor first, then re-run.",
      );
    }
    console.log(`resuming existing DRAFT v${draft.version} from an interrupted prior run`);
  } else {
    const maxVer = await prisma.planVersion.aggregate({ _max: { version: true } });
    const nextVersion = (maxVer._max.version ?? 0) + 1;

    draft = await prisma.$transaction(async (tx) => {
      const created = await tx.planVersion.create({
        data: {
          version: nextVersion,
          status: "DRAFT",
          notes: published
            ? `v11: retire ${RETIRED_SKUS.join(", ")} add-on SKUs (no enforcement behind ` +
              `any of them), drafted from v${published.version}`
            : `v11: retire ${RETIRED_SKUS.join(", ")} add-on SKUs (no enforcement behind any of them)`,
        },
      });
      await tx.planDefinition.createMany({
        data: DEFINITIONS.map((d) => ({
          planVersionId: created.id,
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
      });
      await tx.addonSku.createMany({
        data: ADDON_SEEDS.map((s) => ({
          planVersionId: created.id,
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
      });
      return tx.planVersion.findUniqueOrThrow({ where: { id: created.id }, include: WITH_CATALOG });
    });
  }

  for (const d of draft.definitions) {
    console.log(
      `  + PlanDefinition ${d.planKey} "${d.name}" ` +
        `${d.monthlyPrice != null ? `$${d.monthlyPrice}/mo` : "custom"} ` +
        `(customersIncluded=${d.customersIncluded ?? "unlimited"})`,
    );
  }
  for (const s of draft.addonSkus) {
    console.log(`  + AddonSku ${s.sku} "${s.name}" $${s.monthlyPrice}/mo`);
  }

  // Publish: a line-for-line mirror of PlanCatalogService.publish()'s writes (see the
  // file header). Never re-pins existing tenants — grandfathering is deliberate; they
  // move to v11 only when they next change plan.
  const now = new Date();
  const publishedVersion = await prisma.$transaction(async (tx) => {
    await tx.planVersion.updateMany({
      where: { status: "PUBLISHED" },
      data: { status: "SUPERSEDED" },
    });
    return tx.planVersion.update({
      where: { id: draft!.id },
      data: { status: "PUBLISHED", publishedAt: now, effectiveAt: now },
      include: WITH_CATALOG,
    });
  });

  console.log(
    `published v${publishedVersion.version}: ${publishedVersion.definitions.length} plan ` +
      `definitions, ${publishedVersion.addonSkus.length} addon SKUs. Prior published version ` +
      `(if any) marked SUPERSEDED. Existing tenants keep their pinned planVersionId.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
