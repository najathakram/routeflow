// apps/api/scripts/backfill-subscription-reconciliation.mjs
//
// Reconciles the TenantSubscription set so MrrService.computeOverview() (which only counts
// rows with planKey set) sees every real tenant. Two failure modes fixed:
//   1. A TenantSubscription row exists but is missing planKey/basePriceSnapshot/planVersionId
//      (Stripe-originated rows created before the checkout webhook set these fields).
//   2. No TenantSubscription row exists at all (self-signup seeds none).
// Only PRODUCTION and DEMO class tenants are in scope — TEST/INTERNAL tenants are never
// billed, so they're left alone. A tenant whose legacy `plan` enum has no entry in
// LEGACY_PLAN_TO_CATALOG_KEY is skipped and listed separately — never guessed at.
//
// Usage:
//   node apps/api/scripts/backfill-subscription-reconciliation.mjs           # dry run
//   node apps/api/scripts/backfill-subscription-reconciliation.mjs --apply   # writes changes

import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

// Hand-checked mapping, not inferred — see Phase 0 spec Section 3. GROWTH/SCALE map to
// themselves (Phase 0 Task 10 made them direct TenantPlan enum values, not only legacy
// aliases); TEAM/BUSINESS/PROFESSIONAL keep mapping to their v8-rename targets.
export const LEGACY_PLAN_TO_CATALOG_KEY = {
  STARTER: "STARTER",
  TEAM: "GROWTH",
  BUSINESS: "SCALE",
  PROFESSIONAL: "SCALE",
  GROWTH: "GROWTH",
  SCALE: "SCALE",
  ENTERPRISE: "ENTERPRISE",
};

export function resolveCatalogKey(legacyPlan) {
  return LEGACY_PLAN_TO_CATALOG_KEY[legacyPlan] ?? null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (!process.env.DATABASE_URL) {
    console.error("Missing env: DATABASE_URL");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const publishedVersion = await prisma.planVersion.findFirst({
      where: { status: "PUBLISHED" },
      include: { definitions: true },
    });
    if (!publishedVersion) {
      console.error("No PUBLISHED PlanVersion found — publish a catalog before running this.");
      process.exitCode = 1;
      return;
    }
    const priceByKey = Object.fromEntries(
      publishedVersion.definitions.map((d) => [d.planKey, d.monthlyPrice]),
    );

    const tenants = await prisma.tenant.findMany({
      where: { class: { in: ["PRODUCTION", "DEMO"] }, deletedAt: null },
      select: { id: true, slug: true, plan: true, subscription: true },
    });

    const rows = [];
    const skipped = [];

    for (const t of tenants) {
      const catalogKey = resolveCatalogKey(t.plan);
      if (!catalogKey) {
        skipped.push({ slug: t.slug, legacyPlan: t.plan, reason: "no catalog mapping" });
        continue;
      }
      const price = priceByKey[catalogKey] ?? null;

      if (!t.subscription) {
        rows.push({ tenantId: t.id, slug: t.slug, action: "create", planKey: catalogKey, price });
      } else if (!t.subscription.planKey || t.subscription.basePriceSnapshot == null) {
        rows.push({
          tenantId: t.id,
          slug: t.slug,
          action: "backfill",
          planKey: catalogKey,
          price,
        });
      }
    }

    console.log(
      `${tenants.length} tenant(s) scanned, ${rows.length} change(s), ${skipped.length} skipped:`,
    );
    console.table(
      rows.map((r) => ({ slug: r.slug, action: r.action, planKey: r.planKey, price: r.price })),
    );
    if (skipped.length) {
      console.log("\nSKIPPED — needs manual decision:");
      console.table(skipped);
    }

    if (!apply) {
      console.log("\nDry run only — pass --apply to write these changes.");
      return;
    }

    // Every tenant is its own statement (never one enclosing transaction) — a raced
    // concurrent write (checkout webhook creating the row between scan and write, or the
    // tenant being deleted) must fail that one row, not roll back the whole run.
    let applied = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        if (r.action === "create") {
          await prisma.tenantSubscription.create({
            data: {
              tenantId: r.tenantId,
              planKey: r.planKey,
              basePriceSnapshot: r.price,
              planVersionId: publishedVersion.id,
            },
          });
        } else {
          await prisma.tenantSubscription.update({
            where: { tenantId: r.tenantId },
            data: {
              planKey: r.planKey,
              basePriceSnapshot: r.price,
              planVersionId: publishedVersion.id,
            },
          });
        }
        await prisma.billingEvent.create({
          data: {
            tenantId: r.tenantId,
            type:
              r.action === "create"
                ? "reconciliation.subscription_created"
                : "reconciliation.snapshot_backfilled",
            payload: { planKey: r.planKey, price: r.price, scriptRun: new Date().toISOString() },
            amountDelta: null,
          },
        });
        applied++;
      } catch (err) {
        console.error(`Failed to reconcile ${r.slug}: ${err.message}`);
        failed++;
      }
    }
    console.log(`Applied ${applied} change(s), ${failed} failed.`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Only run the CLI when this file is the process entry point — never on import (mirrors
// backfill-tenant-class.mjs's guard, so the DB-lane spec can import resolveCatalogKey
// without opening a real Postgres connection as an unawaited side effect).
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
