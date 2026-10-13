/**
 * BACKFILL: reconcile Product.isTobacco with membership in the tenant's
 * "Tobacco" TrackedCategory (2026-08-24 tobacco→Regulated consolidation).
 *
 * Product.isTobacco is now a write-sync DERIVED MIRROR of category membership
 * (see apps/api/src/common/tobacco-category.ts) — every product write that
 * changes trackedCategoryId keeps the two in sync going forward. This script
 * reconciles data that predates that sync: for a tenant, the set
 * {Product.isTobacco = true} must equal the member set of the Tobacco type.
 *
 * For each candidate product (isTobacco=true OR a member of the Tobacco type)
 * this computes exactly one of:
 *
 *   link          isTobacco=true but trackedCategoryId is null (pointing
 *                 nowhere) → assign trackedCategoryId to the Tobacco type
 *                 (created with the Phase-4 W1 seed values if it doesn't
 *                 exist yet: taxType NONE, no license, CA_CDTFA, MONTHLY,
 *                 SEPARATE_INVOICE, active).
 *   flag          a member of the Tobacco type but isTobacco=false → set
 *                 isTobacco=true.
 *   CONFLICT      isTobacco=true but assigned to a DIFFERENT type → NEVER
 *                 auto-moved, only reported. Moving it could change invoice
 *                 splitting and filing attribution for that product — the
 *                 owner resolves these by hand via the product form.
 *
 *   recipe-locked  (SA-587b) a would-be link product that sits in a non-RETIRED
 *                 recipe (recipe product, family, or component) is SKIPPED, never
 *                 written: its tracked category is locked while the recipe is open.
 *                 Reported as a COUNT ONLY (never names, ids or slugs).
 *
 * link rows have trackedCategoryId == null, so they carry no subcategory and
 * no synced Product.category — this script deliberately touches ONLY
 * trackedCategoryId / isTobacco, never category / trackedSubcategoryId.
 *
 * SAFETY (per CLAUDE.md live-tenant policy):
 *   - DRY-RUN by default: prints the full plan, writes nothing.
 *   - Executing requires:  --execute --confirm-tenant=<slug>   (slug typed back)
 *   - A LIVE (non-test) tenant additionally requires  --live-tenant-override
 *     and this script must only ever run at the tenant's / owner's explicit
 *     request, AFTER a fresh validated backup.
 *   - --all-tenants is DRY-RUN-ONLY, for a global report across every tenant.
 *     Execution is strictly per-tenant: --all-tenants combined with --execute
 *     is rejected outright, nothing is written.
 *   - Idempotent: a clean tenant (nothing to link/flag/create, no conflicts)
 *     prints "clean — nothing to do" — running this a second time after an
 *     execute must reproduce that line.
 *
 * Run:
 *   railway run --service postgres node apps/api/scripts/backfill-tobacco-category.mjs --all-tenants
 *   railway run --service postgres node apps/api/scripts/backfill-tobacco-category.mjs --tenant=<slug>
 *   …review the dry-run…
 *   railway run --service postgres node apps/api/scripts/backfill-tobacco-category.mjs \
 *     --tenant=<slug> --execute --confirm-tenant=<slug> [--live-tenant-override]
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { applyTobaccoPlan, planTobaccoTenant, summarizePlans } from "./lib/recipe-locked.mjs";
import guard from "./lib/live-target-guard.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";

// Row 195: `--execute` never writes a PROTECTED tenant (paying | stripe-linked |
// PROTECTED_TENANT_SLUGS), with or without --live-tenant-override. Dry-run reads stay unrestricted.
const { assertWritableTenant, ProtectedTenantError } = guard;
const { loadProtectedSlugs } = protectedSlugsLib;

// ─── Connection (mirrors repair-receiving-units.mjs) ──────────────────────────
function resolveDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const e = process.env;
  const need = [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "RAILWAY_TCP_PROXY_DOMAIN",
    "RAILWAY_TCP_PROXY_PORT",
  ];
  const missing = need.filter((k) => !e[k]);
  if (missing.length) {
    console.error(
      `\nMissing env: ${missing.join(", ")}\n` +
        "Set DATABASE_URL, or run via: railway run --service postgres node apps/api/scripts/backfill-tobacco-category.mjs\n",
    );
    process.exit(1);
  }
  return (
    `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
    `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`
  );
}

const args = process.argv.slice(2);
const argVal = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const tenantSlug = argVal("tenant");
const allTenants = args.includes("--all-tenants");
const execute = args.includes("--execute");
const confirmSlug = argVal("confirm-tenant");
const liveOverride = args.includes("--live-tenant-override");

if (allTenants && execute) {
  console.error(
    "\n--all-tenants is DRY-RUN-ONLY — execution is strictly per-tenant.\n" +
      "Drop --execute for the global report, or drop --all-tenants and pass\n" +
      "--tenant=<slug> --execute --confirm-tenant=<slug> instead. Nothing was written.\n",
  );
  process.exit(1);
}
if (!allTenants && !tenantSlug) {
  console.error(
    "\nUsage: --tenant=<slug> [--execute --confirm-tenant=<slug> [--live-tenant-override]]\n" +
      "   or: --all-tenants                              (dry-run-only global report)\n",
  );
  process.exit(1);
}
if (execute) {
  if (confirmSlug !== tenantSlug) {
    console.error(
      `\n--execute requires --confirm-tenant=${tenantSlug} (type the slug back exactly). Nothing was written.\n`,
    );
    process.exit(1);
  }
  if (!isTestTenant(tenantSlug) && !liveOverride) {
    console.error(
      `\n"${tenantSlug}" is a LIVE tenant. Executing against it requires --live-tenant-override,\n` +
        `the tenant's explicit request, and a FRESH VALIDATED BACKUP taken first. Nothing was written.\n`,
    );
    process.exit(1);
  }
}

const dbUrl = resolveDbUrl();
// Loaded ONCE, against the URL this script dials, before connecting (only a write needs it).
let protectedSlugs = null;
if (execute) {
  try {
    protectedSlugs = loadProtectedSlugs(process.env, dbUrl);
  } catch (err) {
    console.error(`\n${err.message} Nothing was written.\n`);
    process.exit(1);
  }
}
const pool = new Pool({ connectionString: dbUrl });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const planForTenant = (tenant) => planTobaccoTenant(prisma, tenant);

async function executePlan(plan) {
  await prisma.$transaction((tx) => applyTobaccoPlan(tx, plan));
}

// ─── Reporting ─────────────────────────────────────────────────────────────
function printPlan(plan) {
  const { tenant, link, recipeLocked, conflicts, flag, createCategory } = plan;
  const writeCount = link.length + flag.length + (createCategory ? 1 : 0);

  console.log(`\nTenant: ${tenant.slug} (${tenant.status})`);
  if (writeCount === 0 && conflicts.length === 0 && recipeLocked.length === 0) {
    console.log(`  clean — nothing to do`);
    return;
  }

  if (createCategory) {
    console.log(
      `  CREATE TrackedCategory "Tobacco" (taxType NONE, no license, CA_CDTFA, MONTHLY, SEPARATE_INVOICE)`,
    );
  }
  if (link.length > 0) {
    console.log(`  link (${link.length}) — isTobacco=true, no category → assign to Tobacco:`);
    for (const p of link) {
      console.log(`    ${p.id} · ${p.name} · link`);
    }
  }
  if (recipeLocked.length > 0) {
    console.log(
      `  recipe-locked (${recipeLocked.length}) — in a non-retired recipe, skipped (count only)`,
    );
  }
  if (flag.length > 0) {
    console.log(`  flag (${flag.length}) — member of Tobacco type, isTobacco=false → set true:`);
    for (const p of flag) {
      console.log(`    ${p.id} · ${p.name} · flag`);
    }
  }
  if (conflicts.length > 0) {
    console.log(
      `  ⚠ CONFLICT (${conflicts.length}) — isTobacco=true but assigned to a DIFFERENT type.` +
        ` NEVER auto-moved, review by hand:`,
    );
    for (const p of conflicts) {
      console.log(
        `    ⚠ CONFLICT ${p.id} · ${p.name} · in "${p.trackedCategory?.name ?? "unknown"}" (not Tobacco)`,
      );
    }
  }
}

(async () => {
  if (allTenants) {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, slug: true, status: true },
      orderBy: { slug: "asc" },
    });

    console.log(`\n===== TOBACCO-CATEGORY BACKFILL (DRY-RUN, --all-tenants) =====`);
    console.log(`Tenants scanned: ${tenants.length}\n`);

    const plans = [];
    for (const tenant of tenants) {
      const plan = await planForTenant(tenant);
      printPlan(plan);
      plans.push(plan);
    }
    const { writes: totalWrites, conflicts: totalConflicts, recipeLocked } = summarizePlans(plans);

    console.log(`\n===== SUMMARY =====`);
    console.log(
      `${tenants.length} tenant(s) scanned · ${totalWrites} planned write(s) · ` +
        `${totalConflicts} conflict(s) needing manual review · ` +
        `${recipeLocked} recipe-locked total (skipped, count only)`,
    );
    console.log(
      `\nDRY-RUN complete — nothing written (--all-tenants is dry-run-only).\n` +
        `Execute per tenant: --tenant=<slug> --execute --confirm-tenant=<slug> [--live-tenant-override]\n`,
    );
    process.exit(0);
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, slug: true, status: true, class: true, deletedAt: true },
  });
  if (!tenant) {
    console.error(`Tenant "${tenantSlug}" not found. Nothing was written.`);
    process.exit(1);
  }
  if (execute) {
    const sub = await prisma.tenantSubscription.findUnique({
      where: { tenantId: tenant.id },
      select: { planKey: true, stripeSubId: true, couponFull: true },
    });
    try {
      assertWritableTenant(tenant, sub, protectedSlugs);
    } catch (err) {
      if (!(err instanceof ProtectedTenantError)) throw err;
      console.error(`\n${err.message} Nothing was written.\n`);
      process.exit(1);
    }
  }

  console.log(`\n===== TOBACCO-CATEGORY BACKFILL (${execute ? "EXECUTE" : "DRY-RUN"}) =====`);

  const plan = await planForTenant(tenant);
  printPlan(plan);

  const writeCount = plan.link.length + plan.flag.length + (plan.createCategory ? 1 : 0);

  if (!execute) {
    console.log(
      `\nDRY-RUN complete — nothing written.\n` +
        `To execute: add --execute --confirm-tenant=${tenantSlug}` +
        (isTestTenant(tenantSlug) ? "" : " --live-tenant-override (LIVE tenant — backup first!)") +
        "\n",
    );
    process.exit(0);
  }

  if (writeCount === 0) {
    console.log(`\nNothing to execute — already clean. Conflicts (if any) are never written.\n`);
    process.exit(0);
  }

  console.log(`\nEXECUTING against ${tenant.slug}…`);
  await executePlan(plan);
  console.log(
    `\n✅ Done — ${plan.createCategory ? "created Tobacco type, " : ""}${plan.link.length} linked, ` +
      `${plan.flag.length} flagged. ${plan.conflicts.length} conflict(s) left untouched for manual review.\n`,
  );
  process.exit(0);
})().catch((err) => {
  console.error("\nFAILED — transaction rolled back:", err.message);
  process.exit(1);
});
