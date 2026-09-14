// apps/api/scripts/backfill-subscription-reconciliation.mjs
//
// Reconciles the TenantSubscription set so MrrService.computeOverview() (which only counts
// rows with planKey set) sees every real tenant, WITHOUT ever inventing a subscription: the
// five free pilots (and any other PRODUCTION/DEMO tenant with no subscription row) must never
// become paying MRR just because this script ran. Only one failure mode is fixed here — a
// TenantSubscription row exists, already carries a planKey, but is missing basePriceSnapshot
// (Stripe-originated rows created before the checkout webhook set the price snapshot). Three
// things are deliberately never written and are only ever listed for a human:
//   - a tenant with no subscription row at all ("no subscription — manual decision"),
//   - a subscription row with no planKey set ("no planKey — manual decision"),
//   - a planKey the published catalog prices at null, e.g. ENTERPRISE ("custom-priced —
//     skipped") — excluded from the re-flag predicate so a second run reports 0 changes.
// Only PRODUCTION and DEMO class tenants are in scope — TEST/INTERNAL tenants are never
// billed, so they're left alone.
//
// Usage:
//   node apps/api/scripts/backfill-subscription-reconciliation.mjs           # dry run
//   node apps/api/scripts/backfill-subscription-reconciliation.mjs --apply   # writes changes

import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

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
  let databaseUrl;
  try {
    databaseUrl = resolveDatabaseUrl(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const pool = new Pool({ connectionString: databaseUrl });
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

    // The script NEVER invents a subscription and NEVER re-derives a planKey from the
    // legacy `plan` enum — every decision below reads only the subscription row that
    // already exists. Anything it can't safely fill in is LISTED for a human, never
    // written.
    for (const t of tenants) {
      if (!t.subscription) {
        skipped.push({
          slug: t.slug,
          legacyPlan: t.plan,
          reason: "no subscription — manual decision",
        });
        continue;
      }
      const { planKey, basePriceSnapshot } = t.subscription;
      if (!planKey) {
        skipped.push({ slug: t.slug, legacyPlan: t.plan, reason: "no planKey — manual decision" });
        continue;
      }
      if (basePriceSnapshot != null) {
        continue; // already snapshotted — nothing to do, not even worth listing
      }
      const price = priceByKey[planKey] ?? null;
      if (price == null) {
        // ENTERPRISE (or any plan the catalog prices at null) is custom-priced — skip
        // idempotently and keep it OUT of `rows` so a second run never re-flags it and
        // never emits a duplicate event.
        skipped.push({
          slug: t.slug,
          legacyPlan: t.plan,
          planKey,
          reason: "custom-priced — skipped",
        });
        continue;
      }
      rows.push({ tenantId: t.id, slug: t.slug, action: "backfill", planKey, price });
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
    // concurrent write (checkout webhook backfilling the row between scan and write, or
    // the tenant being deleted) must fail that one row, not roll back the whole run.
    let applied = 0;
    let failed = 0;
    for (const r of rows) {
      try {
        await prisma.tenantSubscription.update({
          where: { tenantId: r.tenantId },
          data: { basePriceSnapshot: r.price, planVersionId: publishedVersion.id },
        });
        await prisma.billingEvent.create({
          data: {
            tenantId: r.tenantId,
            type: "reconciliation.snapshot_backfilled",
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
