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

const pool = new Pool({ connectionString: resolveDbUrl() });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const CI_TOBACCO = { equals: "Tobacco", mode: "insensitive" };

async function planForTenant(tenant) {
  const tobaccoCat = await prisma.trackedCategory.findFirst({
    where: { tenantId: tenant.id, name: CI_TOBACCO },
    select: { id: true, name: true, active: true },
  });
  const products = await prisma.product.findMany({
    where: {
      tenantId: tenant.id,
      OR: [{ isTobacco: true }, ...(tobaccoCat ? [{ trackedCategoryId: tobaccoCat.id }] : [])],
    },
    select: {
      id: true,
      name: true,
      isTobacco: true,
      trackedCategoryId: true,
      trackedCategory: { select: { name: true } },
    },
  });
  return {
    tenant,
    tobaccoCat,
    // Flagged but pointing nowhere → link into the Tobacco type.
    link: products.filter((p) => p.isTobacco && p.trackedCategoryId == null),
    // Flagged but assigned to a DIFFERENT type → NEVER auto-moved. Reported
    // for the owner to resolve by hand (moving could change invoice splitting
    // and filing attribution for that product).
    conflicts: products.filter(
      (p) => p.isTobacco && p.trackedCategoryId != null && p.trackedCategoryId !== tobaccoCat?.id,
    ),
    // Members of the Tobacco type missing the mirror flag → set it.
    flag: products.filter(
      (p) => !p.isTobacco && tobaccoCat && p.trackedCategoryId === tobaccoCat.id,
    ),
    // No Tobacco type yet AND there are link rows that need one → create it
    // (W1-seed values). Gated on link rows specifically: a tenant whose flagged
    // products are ALL conflicts (assigned elsewhere, never auto-moved) must not
    // get an empty "Tobacco" type it would then carry forever in the hub.
    createCategory: !tobaccoCat && products.some((p) => p.isTobacco && p.trackedCategoryId == null),
  };
}

async function executePlan(plan) {
  await prisma.$transaction(async (tx) => {
    let catId = plan.tobaccoCat?.id;
    if (plan.createCategory) {
      const created = await tx.trackedCategory.create({
        data: {
          tenantId: plan.tenant.id,
          name: "Tobacco",
          taxType: "NONE",
          requiresLicense: false,
          reportTemplate: "CA_CDTFA",
          reportCadence: "MONTHLY",
          invoiceTreatment: "SEPARATE_INVOICE",
          active: true,
        },
        select: { id: true },
      });
      catId = created.id;
    }
    if (plan.link.length > 0 && catId) {
      await tx.product.updateMany({
        where: { id: { in: plan.link.map((p) => p.id) } },
        data: { trackedCategoryId: catId },
      });
    }
    if (plan.flag.length > 0) {
      await tx.product.updateMany({
        where: { id: { in: plan.flag.map((p) => p.id) } },
        data: { isTobacco: true },
      });
    }
  });
}

// ─── Reporting ─────────────────────────────────────────────────────────────
function printPlan(plan) {
  const { tenant, link, conflicts, flag, createCategory } = plan;
  const writeCount = link.length + flag.length + (createCategory ? 1 : 0);

  console.log(`\nTenant: ${tenant.slug} (${tenant.status})`);
  if (writeCount === 0 && conflicts.length === 0) {
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

    let totalWrites = 0;
    let totalConflicts = 0;
    for (const tenant of tenants) {
      const plan = await planForTenant(tenant);
      printPlan(plan);
      totalWrites += plan.link.length + plan.flag.length + (plan.createCategory ? 1 : 0);
      totalConflicts += plan.conflicts.length;
    }

    console.log(`\n===== SUMMARY =====`);
    console.log(
      `${tenants.length} tenant(s) scanned · ${totalWrites} planned write(s) · ` +
        `${totalConflicts} conflict(s) needing manual review`,
    );
    console.log(
      `\nDRY-RUN complete — nothing written (--all-tenants is dry-run-only).\n` +
        `Execute per tenant: --tenant=<slug> --execute --confirm-tenant=<slug> [--live-tenant-override]\n`,
    );
    process.exit(0);
  }

  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, slug: true, status: true },
  });
  if (!tenant) {
    console.error(`Tenant "${tenantSlug}" not found. Nothing was written.`);
    process.exit(1);
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
