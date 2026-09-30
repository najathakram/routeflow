/**
 * Publish plan catalog v9 — adds the MSRP add-on SKU.
 *
 * Production already has PlanVersion v8 PUBLISHED (Starter/Growth/Scale/Enterprise —
 * see publish-plan-catalog-v8.ts). This script does NOT reseed the ladder: it opens a
 * new DRAFT version carrying the same plan definitions unchanged, adds ONE new AddonSku
 * (MSRP, granting `flag.msrp`), and PUBLISHES it through the same lifecycle the
 * platform-admin Plans editor uses (PlanCatalogService.createDraft/publish) — so the
 * prior published version is marked SUPERSEDED and existing tenants keep whatever
 * planVersionId they were already pinned to (grandfathering; see plan-catalog.service.ts
 * `publish()`). No tenant is re-pinned.
 *
 * `flag.msrp` is granted by NO plan definition — MSRP on invoices ships OFF for every
 * tenant by default. A tenant only gets it when a platform admin enables the "msrp"
 * add-on via the existing audited enable/disable endpoint (AVAILABLE_ADDONS in
 * apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx), which grants the MSRP SKU.
 *
 * This file mirrors prisma/seed.ts's connection setup (raw PrismaClient over the pg
 * adapter, driven by DATABASE_URL) rather than booting a Nest application context just
 * to call one service method — the same tradeoff seed.ts and publish-plan-catalog-v8.ts
 * already make for scripts under apps/api/prisma/. The writes below are a deliberate
 * line-for-line mirror of PlanCatalogService.createDraft() and
 * PlanCatalogService.publish(); keep them in lock-step if those methods' field writes
 * ever change.
 *
 * Idempotent: if the currently PUBLISHED version already has an MSRP AddonSku, this
 * exits 0 without writing anything. Safe to re-run (including after a partial failure —
 * see the DRAFT-resume note below). Never deletes anything.
 *
 * Local:   ts-node -r tsconfig-paths/register prisma/publish-plan-catalog-v9.ts (from apps/api)
 * Railway: railway run --service postgres ts-node -r tsconfig-paths/register prisma/publish-plan-catalog-v9.ts
 * (Wired up as `npm run db:publish:catalog:v9` in apps/api/package.json — run it in every
 * environment BEFORE enabling the msrp addon on any tenant, or the addon grants no flag.)
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

// ─── Target catalog (same ladder as v8, plus one new AddonSku) ────────────────

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

// Unchanged from v8 — `flag.msrp` is deliberately excluded from every plan's
// featureFlags, same treatment as `flag.dispatch_live`: MSRP on invoices ships OFF
// for every tenant until a platform admin enables the add-on below.
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
const ENTERPRISE_FLAGS = FLAG_KEYS.filter((f) => f !== "flag.dispatch_live" && f !== "flag.msrp");

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

// The 8 existing SKUs carry forward from v8 unchanged. MSRP is the one new SKU this
// version adds: `includedAtPlan: null` and no plan's featureFlags list `flag.msrp`, so
// it is OFF for every tenant until a platform admin enables it via the addon toggle.
const ADDON_SEEDS: AddonSeed[] = [
  {
    sku: "SEAT_EXTRA",
    name: "Extra seat",
    monthlyPrice: 12,
    unit: "PER_USER",
    includedAtPlan: null,
    meteredKey: "SEATS",
    capacityPerUnit: 1,
    stackable: true,
    grantsFlags: [],
    sortOrder: 0,
  },
  {
    sku: "BUYER_PORTAL",
    name: "Buyer portal",
    monthlyPrice: 49,
    unit: "FLAT",
    includedAtPlan: "GROWTH",
    meteredKey: null,
    capacityPerUnit: null,
    stackable: false,
    grantsFlags: ["addon.buyer_portal"],
    sortOrder: 1,
  },
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
    sortOrder: 2,
  },
  {
    sku: "OCR_PACK_250",
    name: "OCR pack",
    monthlyPrice: 19,
    unit: "FLAT",
    includedAtPlan: null,
    meteredKey: "SCANS",
    capacityPerUnit: 250,
    stackable: true,
    grantsFlags: [],
    sortOrder: 3,
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
    sortOrder: 4,
  },
  {
    sku: "ROUTE_EXTRA",
    name: "Extra route",
    monthlyPrice: 15,
    unit: "PER_ROUTE",
    includedAtPlan: null,
    meteredKey: "ROUTES",
    capacityPerUnit: 1,
    stackable: true,
    grantsFlags: [],
    sortOrder: 5,
  },
  {
    sku: "MSG_BUNDLE_500",
    name: "Message bundle",
    monthlyPrice: 10,
    unit: "FLAT",
    includedAtPlan: null,
    meteredKey: "MSGS",
    capacityPerUnit: 500,
    stackable: true,
    grantsFlags: [],
    sortOrder: 6,
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
    sortOrder: 7,
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
    sortOrder: 8,
  },
];

// Sanity-check our own seed data against the vocabulary this script imports —
// catches a typo'd SKU code before it ever reaches the database.
const seededSkus = new Set(ADDON_SEEDS.map((s) => s.sku));
for (const sku of ADDON_SKUS) {
  if (!seededSkus.has(sku)) {
    throw new Error(`publish-plan-catalog-v9: missing a seed row for AddonSku "${sku}"`);
  }
}
if (seededSkus.size !== ADDON_SKUS.length) {
  throw new Error("publish-plan-catalog-v9: ADDON_SEEDS has an entry not in ADDON_SKUS");
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — refusing to run.");
  }
  console.log(`publish-plan-catalog-v9 target: ${maskDbUrl(process.env.DATABASE_URL)}`);

  const published = await prisma.planVersion.findFirst({
    where: { status: "PUBLISHED" },
    orderBy: { version: "desc" },
    include: WITH_CATALOG,
  });

  const alreadyPublished = published?.addonSkus.some((s) => s.sku === "MSRP");
  if (alreadyPublished) {
    console.log(
      `already published: v${published!.version} already has an MSRP AddonSku — nothing to do.`,
    );
    return;
  }

  // Reuse a leftover DRAFT from a previously interrupted run of THIS script
  // (identified by already carrying our target MSRP SKU) instead of failing on
  // PlanCatalogService.createDraft()'s "one draft at a time" rule or leaving orphaned
  // rows behind. A DRAFT that does NOT match is left alone — it may be in-progress
  // admin work — and the script fails loudly rather than touching it.
  let draft: CatalogVersion | null = await prisma.planVersion.findFirst({
    where: { status: "DRAFT" },
    include: WITH_CATALOG,
  });

  if (draft) {
    const isOurDraft = draft.addonSkus.some((s) => s.sku === "MSRP");
    if (!isOurDraft) {
      throw new Error(
        `A DRAFT plan version (v${draft.version}) already exists and doesn't match the v9 ` +
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
            ? `v9: add MSRP add-on SKU (flag.msrp, off by default), drafted from v${published.version}`
            : "v9: add MSRP add-on SKU (flag.msrp, off by default)",
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
  // move to v9 only when they next change plan.
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
