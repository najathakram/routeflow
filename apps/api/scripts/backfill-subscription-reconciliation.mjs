// apps/api/scripts/backfill-subscription-reconciliation.mjs
//
// Reconciles the TenantSubscription set so MrrService.computeOverview() (which only counts
// rows with planKey set) sees every real tenant, WITHOUT ever inventing a subscription: the
// five free pilots (and any other PRODUCTION tenant with no subscription row) must never
// become paying MRR just because this script ran. Only one failure mode is fixed here — a
// TenantSubscription row exists, already carries a planKey and a real Stripe subscription
// (stripeSubId), but is missing basePriceSnapshot. NOTE: `onCheckoutCompleted`
// (billing.service.ts) never sets planKey itself, so a row Stripe's OWN checkout webhook
// created never reaches this fixable population — it's excluded below at "no planKey". The
// rows this script can actually write are legacy/hand-written ones that already carry a
// planKey (e.g. a manual activation later given a stripeSubId) but were never snapshotted.
// Five things are deliberately never written and are only ever listed for a human:
//   - a tenant with no subscription row at all ("no subscription — manual decision"),
//   - a subscription row with no planKey set ("no planKey — manual decision"),
//   - a subscription row with a planKey but no stripeSubId, i.e. a manually-activated free
//     pilot ("no Stripe subscription — manual decision" — B327: never remove this filter),
//   - a planKey that isn't in the resolved PlanVersion's catalog at all ("planKey not in the
//     resolved catalog version — manual decision") — distinct from a catalog-known plan priced
//     at null,
//   - a planKey that version prices at null, e.g. ENTERPRISE ("custom-priced (null price) —
//     skipped") — excluded from the re-flag predicate so a second run reports 0 changes.
// Only PRODUCTION-class, ACTIVE-status tenants are in scope — DEMO/TEST/INTERNAL and any
// non-ACTIVE PRODUCTION tenant (TRIAL/CANCELLED/READ_ONLY/SUSPENDED) are never billed, so
// they're left alone entirely.
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
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";

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
  console.log(`Resolved database host: ${redactUrl(databaseUrl)}`);
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    // Fetched but no longer trusted as the ONLY version rows can price from (F3) — a
    // resolvable-but-unpublished pin still wins over falling back to this.
    const publishedVersion = await prisma.planVersion.findFirst({
      where: { status: "PUBLISHED" },
    });

    // F5: PRODUCTION + ACTIVE only. DEMO is never billed (out of scope entirely, not just
    // excluded from MRR); CANCELLED/READ_ONLY/SUSPENDED/TRIAL PRODUCTION tenants are listed
    // nowhere here and never written — reconciliation only touches a tenant currently paying.
    const tenants = await prisma.tenant.findMany({
      where: {
        class: "PRODUCTION",
        status: "ACTIVE",
        deletedAt: null,
        ...(slugPrefix ? { slug: { startsWith: slugPrefix } } : {}),
      },
      select: { id: true, slug: true, plan: true, planVersionId: true, subscription: true },
    });

    // F3: price from the row's OWN pinned PlanVersion when it has one — never always PUBLISHED,
    // which would silently re-price a tenant pinned to an older (possibly ARCHIVED) version.
    // Collect every version id any in-scope tenant could resolve to and load their definitions
    // in ONE query, never per-row.
    const candidateVersionIds = new Set();
    for (const t of tenants) {
      if (t.subscription?.planVersionId) candidateVersionIds.add(t.subscription.planVersionId);
      if (t.planVersionId) candidateVersionIds.add(t.planVersionId);
    }
    if (publishedVersion) candidateVersionIds.add(publishedVersion.id);
    const versions = candidateVersionIds.size
      ? await prisma.planVersion.findMany({
          where: { id: { in: [...candidateVersionIds] } },
          include: { definitions: true },
        })
      : [];
    // A Map, not a plain object (review finding): planKey is a free-text column, and
    // `"constructor" in {}` / `{}.toString` are real values on a plain object — a stray
    // catalog-data planKey matching an Object.prototype member must never resolve to a
    // function instead of hitting the "not in the resolved catalog version" bucket.
    const definitionsByVersion = new Map(
      versions.map((v) => [v.id, new Map(v.definitions.map((d) => [d.planKey, d.monthlyPrice]))]),
    );

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
      const {
        planKey,
        basePriceSnapshot,
        stripeSubId,
        planVersionId: subPlanVersionId,
      } = t.subscription;
      if (!planKey) {
        skipped.push({ slug: t.slug, legacyPlan: t.plan, reason: "no planKey — manual decision" });
        continue;
      }
      // F4: a planKey with a null snapshot and NO Stripe subscription is exactly what a
      // manually-activated free pilot looks like — never price it. Never drop this filter
      // (standing B327 rule): the only rows this script may ever write are Stripe-originated.
      if (!stripeSubId) {
        skipped.push({
          slug: t.slug,
          legacyPlan: t.plan,
          planKey,
          reason: "no Stripe subscription — manual decision",
        });
        continue;
      }
      if (basePriceSnapshot != null) {
        continue; // already snapshotted — nothing to do, not even worth listing
      }
      const targetVersionId = subPlanVersionId ?? t.planVersionId ?? publishedVersion?.id;
      if (!targetVersionId) {
        skipped.push({
          slug: t.slug,
          legacyPlan: t.plan,
          planKey,
          reason: "no resolvable plan version — manual decision",
        });
        continue;
      }
      const defs = definitionsByVersion.get(targetVersionId);
      if (!defs || !defs.has(planKey)) {
        // planKey isn't in the resolved version's catalog AT ALL — distinct from a
        // catalog-known plan priced at null (ENTERPRISE). We can't tell a typo from a
        // retired key from a key that version's catalog just never had, so this always
        // needs a human, never an idempotent skip.
        skipped.push({
          slug: t.slug,
          legacyPlan: t.plan,
          planKey,
          reason: "planKey not in the resolved catalog version — manual decision",
        });
        continue;
      }
      const price = defs.get(planKey);
      if (price == null) {
        // ENTERPRISE (or any plan that version prices at null) is custom-priced — skip
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
      rows.push({
        tenantId: t.id,
        slug: t.slug,
        action: "backfill",
        planKey,
        price,
        targetVersionId,
        // F3/N3: never overwrite an already-non-null pin — only set one that was null at
        // scan time. Subscription and tenant pins are independent; both get checked. The
        // WRITE'S where-clause re-asserts this exact scanned value (null or a specific id),
        // not just a boolean — a concurrent pin change between scan and write (e.g. a
        // checkout webhook) must fail this row's conditional write, not be silently
        // overwritten by it (review finding: a boolean alone can't express "still exactly
        // what I scanned" when the scanned value is itself non-null).
        scannedSubPlanVersionId: subPlanVersionId ?? null,
        subPlanVersionWasNull: subPlanVersionId == null,
        tenantPlanVersionWasNull: t.planVersionId == null,
      });
    }

    console.log(
      `${tenants.length} tenant(s) scanned, ${rows.length} change(s), ${skipped.length} skipped${
        slugPrefix ? ` (scoped to slug prefix "${slugPrefix}")` : ""
      }:`,
    );
    console.table(
      rows.map((r) => ({
        slug: r.slug,
        action: r.action,
        planKey: r.planKey,
        price: r.price,
        planVersionId: r.targetVersionId,
      })),
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
        // F3: planVersionId is set ONLY when it was null at scan time — never overwrite a
        // pin this row already carried. The where-clause re-asserts the EXACT scanned
        // planVersionId (null or a specific id) rather than just re-checking
        // basePriceSnapshot: a webhook that pins planVersionId (with the snapshot still
        // null) between scan and write must fail this conditional write, never be silently
        // overwritten by it.
        const subData = { basePriceSnapshot: r.price };
        if (r.subPlanVersionWasNull) subData.planVersionId = r.targetVersionId;
        // Review finding (fix round #2): this write moves the tenant's MrrService
        // contribution from $0 to r.price (basePriceSnapshot null -> set, inside
        // payingWhere) exactly like reconcilePriceLedger()/updateTenantPriceOverride()'s
        // own null-snapshot backfill do — both of those emit the signed delta in the SAME
        // transaction as the write, and this one must too, or ledgerMrr never learns about
        // the move: a later churn on this tenant then emits a real -r.price with no matching
        // +r.price ever booked, permanently under-counting ledgerMrr. The three writes
        // (subscription, event, tenant pin) are wrapped in ONE per-row transaction so a
        // failure between them can never book a price with no ledger row (or vice versa) —
        // this does NOT reintroduce the one-failed-row-rolls-back-the-run risk the file
        // header warns against, since each row still gets its OWN transaction.
        const result = await prisma.$transaction(async (tx) => {
          const updated = await tx.tenantSubscription.updateMany({
            where: {
              tenantId: r.tenantId,
              planKey: r.planKey,
              basePriceSnapshot: null,
              stripeSubId: { not: null },
              planVersionId: r.scannedSubPlanVersionId,
            },
            data: subData,
          });
          if (updated.count === 1) {
            await tx.billingEvent.create({
              data: {
                tenantId: r.tenantId,
                type: "reconciliation.snapshot_backfilled",
                payload: {
                  planKey: r.planKey,
                  price: r.price,
                  planVersionId: r.targetVersionId,
                  scriptRun: new Date().toISOString(),
                },
                amountDelta: r.price,
              },
            });
            // N3: the Tenant's own planVersionId pin is separate from the subscription's —
            // backfill it too when null, never overwriting one that's already set.
            if (r.tenantPlanVersionWasNull) {
              await tx.tenant.updateMany({
                where: { id: r.tenantId, planVersionId: null },
                data: { planVersionId: r.targetVersionId },
              });
            }
          }
          return updated;
        });
        if (result.count === 1) {
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
