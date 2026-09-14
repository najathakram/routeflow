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
//   - a planKey that isn't in the published catalog at all ("planKey not in the published
//     catalog — manual decision") — distinct from a catalog-known plan priced at null,
//   - a planKey the published catalog prices at null, e.g. ENTERPRISE ("custom-priced (null
//     price) — skipped") — excluded from the re-flag predicate so a second run reports 0
//     changes.
// Only PRODUCTION and DEMO class tenants are in scope — TEST/INTERNAL tenants are never
// billed, so they're left alone.
//
// Usage:
//   node apps/api/scripts/backfill-subscription-reconciliation.mjs           # dry run
//   node apps/api/scripts/backfill-subscription-reconciliation.mjs --apply   # writes changes
//   ... --slug-prefix <prefix>  # scope the tenant scan/apply to slugs starting with <prefix> —
//   for a db spec or a one-tenant prod rehearsal — never let a spec run an unscoped --apply on a
//   shared DB.

import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveDatabaseUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

// Hoisted to module scope (not `main()`-local) so the top-level `.catch` below can scrub a
// connection string out of an error message even when the failure happens before or after
// `main()`'s own try/finally.
let databaseUrl;

// Parses the optional `--slug-prefix <prefix>` flag: value required, given at most once, and
// never empty — so a spec or rehearsal that scopes this platform-wide script cannot silently
// fall back to an unscoped scan/apply on a shared DB. Mirrors backfill-tenant-class.mjs's parser.
export function parseSlugPrefix(argv) {
  const idx = argv.indexOf("--slug-prefix");
  if (idx === -1) return undefined;
  if (argv.indexOf("--slug-prefix", idx + 1) !== -1) {
    throw new Error("--slug-prefix may be given only once");
  }
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) {
    throw new Error("--slug-prefix requires a non-empty value");
  }
  return value;
}

async function main() {
  const apply = process.argv.includes("--apply");
  let slugPrefix;
  try {
    slugPrefix = parseSlugPrefix(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
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
      where: {
        class: { in: ["PRODUCTION", "DEMO"] },
        deletedAt: null,
        ...(slugPrefix ? { slug: { startsWith: slugPrefix } } : {}),
      },
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
      if (!(planKey in priceByKey)) {
        // planKey isn't in the published catalog AT ALL — distinct from a catalog-known
        // plan priced at null (ENTERPRISE). We can't tell a typo from a retired key from a
        // key the catalog just hasn't caught up to yet, so this always needs a human, never
        // an idempotent skip.
        skipped.push({
          slug: t.slug,
          legacyPlan: t.plan,
          planKey,
          reason: "planKey not in the published catalog — manual decision",
        });
        continue;
      }
      const price = priceByKey[planKey];
      if (price == null) {
        // ENTERPRISE (or any plan the catalog prices at null) is custom-priced — skip
        // idempotently and keep it OUT of `rows` so a second run never re-flags it and
        // never emits a duplicate event.
        skipped.push({
          slug: t.slug,
          legacyPlan: t.plan,
          planKey,
          reason: "custom-priced (null price) — skipped",
        });
        continue;
      }
      rows.push({ tenantId: t.id, slug: t.slug, action: "backfill", planKey, price });
    }

    console.log(
      `${tenants.length} tenant(s) scanned, ${rows.length} change(s), ${skipped.length} skipped${
        slugPrefix ? ` (scoped to slug prefix "${slugPrefix}")` : ""
      }:`,
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
    let raced = 0;
    const skippedBeforeApply = skipped.length;
    for (const r of rows) {
      try {
        // Conditional write (review F7b): only write — and only emit a BillingEvent — if the
        // row still matches exactly what was scanned. `count === 0` means someone else
        // (the checkout webhook, another run) already changed this row between scan and
        // write; never overwrite a state we didn't observe, and never emit a duplicate event.
        const result = await prisma.tenantSubscription.updateMany({
          where: { tenantId: r.tenantId, planKey: r.planKey, basePriceSnapshot: null },
          data: { basePriceSnapshot: r.price, planVersionId: publishedVersion.id },
        });
        if (result.count === 1) {
          await prisma.billingEvent.create({
            data: {
              tenantId: r.tenantId,
              type: "reconciliation.snapshot_backfilled",
              payload: { planKey: r.planKey, price: r.price, scriptRun: new Date().toISOString() },
              amountDelta: null,
            },
          });
          applied++;
        } else {
          skipped.push({
            slug: r.slug,
            planKey: r.planKey,
            reason: "changed concurrently since scan — rerun",
          });
          raced++;
        }
      } catch (err) {
        console.error(`Failed to reconcile ${r.slug}: ${err.message}`);
        failed++;
      }
    }
    if (raced > 0) {
      console.log("\nRACED — changed concurrently since scan, rerun to pick these up:");
      console.table(skipped.slice(skippedBeforeApply));
    }
    console.log(
      `Applied ${applied} change(s), ${failed} failed, ${raced} raced (rerun to pick up).`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

// Only run the CLI when this file is the process entry point — never on import (mirrors
// backfill-tenant-class.mjs's guard).
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    const msg = err?.message ?? String(err);
    // Never print the raw error object — it can embed a connection string (password and
    // all). Scrub it through the same helper that builds `databaseUrl`, when we got far
    // enough to have one.
    console.error(databaseUrl ? scrubSecrets(msg, databaseUrl) : msg);
    process.exit(1);
  });
}
