// apps/api/scripts/backfill-refund-tender.mjs
//
// SA-740r2 item 7: one-time catch-up of `Return.refundTender` (PaymentMethod) for the inline refunds recorded BEFORE the column
// existed. The tender of such a refund lives only in the awaited `inline_return.refund` audit row meta; this copies it into the
// column so today's sales can subtract a cash refund from the drawer.
//
// Scope (the pure rules are scripts/lib/refund-tender-backfill.mjs `planRefundTenderBackfill`):
//   - ONLY REFUNDED EXTERNAL_REFUND returns whose refundTender IS NULL (idempotent: a rerun plans nothing);
//   - the audit row is joined by `AuditLog.entityId = Return.id` and its `tenantId` must be NULL or equal the return's
//     (never another tenant's row); the EARLIEST row per return, the way the replay reads it;
//   - the tender is mapped with the counter map (CARD -> CREDIT_CARD). An unknown or missing tender STAYS NULL: never CASH.
//
// SAFETY (CLAUDE.md live-tenant policy, same mechanism as backfill-check-dates.mjs):
//   - DRY-RUN by default: prints counts per tenant (a test tenant by slug, every other tenant anonymously as "tenant A", ...),
//     writes nothing.
//   - `--apply` scoped to an approved test tenant (`--tenant-id <id>`) proceeds. `--apply` scoped to a LIVE tenant also needs
//     `--live-tenant-override` AND `--confirm-tenant-id=<id>` (the id typed back), the owner's explicit request, and a FRESH
//     VALIDATED BACKUP. `--apply` with no `--tenant-id` touches every tenant, so it always needs `--live-tenant-override`.
//   - The ONE writer is `setRefundTender` (a pinned mirror of returns/refund-tender.ts): updateMany only where the column is null.
//
// Usage:
//   node apps/api/scripts/backfill-refund-tender.mjs                       # dry run
//   node apps/api/scripts/backfill-refund-tender.mjs --apply --tenant-id <test tenant id>
//   node apps/api/scripts/backfill-refund-tender.mjs --apply --tenant-id <id> --live-tenant-override --confirm-tenant-id=<id>

import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";
import { planRefundTenderBackfill, setRefundTender } from "./lib/refund-tender-backfill.mjs";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";

let databaseUrl;

/** `--tenant-id <id>`: value required, given at most once. */
export function parseTenantId(argv) {
  const idx = argv.indexOf("--tenant-id");
  if (idx === -1) return undefined;
  if (argv.indexOf("--tenant-id", idx + 1) !== -1) {
    throw new Error("--tenant-id may be given only once");
  }
  const value = argv[idx + 1];
  if (!value || value.startsWith("--")) throw new Error("--tenant-id requires a non-empty value");
  return value;
}

/** `--confirm-tenant-id=<id>` (type-back). Only the `=` form. */
export function parseConfirmTenantId(argv) {
  const hit = argv.find((a) => a.startsWith("--confirm-tenant-id="));
  return hit ? hit.slice("--confirm-tenant-id=".length) : undefined;
}

/** The candidate read: the return plus the EARLIEST refund audit row of THAT return whose tenant is NULL or the return's own. */
export const CANDIDATES_SQL = `
  SELECT r.id AS "returnId", r."tenantId", t.slug, r.status::text AS status, r."refundMethod",
         r."refundTender"::text AS "refundTender", a."tenantId" AS "auditTenantId", a.meta
    FROM "Return" r
    JOIN "Tenant" t ON t.id = r."tenantId"
    JOIN LATERAL (
      SELECT al."tenantId", al.meta
        FROM "AuditLog" al
       WHERE al."entityType" = 'Return' AND al."entityId" = r.id AND al.action = 'inline_return.refund'
         AND (al."tenantId" IS NULL OR al."tenantId" = r."tenantId")
       ORDER BY al."createdAt" ASC
       LIMIT 1
    ) a ON true
   WHERE r.kind = 'INLINE' AND r.status = 'REFUNDED' AND r."refundMethod" = 'EXTERNAL_REFUND'
     AND r."refundTender" IS NULL`;

async function main() {
  const apply = process.argv.includes("--apply");
  const liveOverride = process.argv.includes("--live-tenant-override");
  let tenantId;
  let confirmTenantId;
  try {
    tenantId = parseTenantId(process.argv);
    confirmTenantId = parseConfirmTenantId(process.argv);
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
  if (tenantId) console.log(`Scoped to tenant: ${tenantId}`);
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    if (apply) {
      if (tenantId) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { slug: true },
        });
        if (!tenant) {
          console.error(`Tenant "${tenantId}" not found. Nothing was written.`);
          process.exit(1);
        }
        if (!isTestTenant(tenant.slug) && (!liveOverride || confirmTenantId !== tenantId)) {
          console.error(
            `\nThat tenant is a LIVE tenant. Applying against it requires --live-tenant-override AND ` +
              `--confirm-tenant-id=${tenantId} (the id typed back exactly), the owner's explicit request, and a FRESH ` +
              `VALIDATED BACKUP taken first. Nothing was written.\n`,
          );
          process.exit(1);
        }
      } else if (!liveOverride) {
        console.error(
          `\n--apply with no --tenant-id writes EVERY tenant, live ones included. This requires ` +
            `--live-tenant-override, the owner's explicit request, and a FRESH VALIDATED BACKUP taken first. ` +
            `Nothing was written. Scope to one approved test tenant with --tenant-id <id> to skip this.\n`,
        );
        process.exit(1);
      }
    }

    const all = await prisma.$queryRawUnsafe(CANDIDATES_SQL);
    const rows = tenantId ? all.filter((r) => r.tenantId === tenantId) : all;
    const { plan, skipped } = planRefundTenderBackfill(rows);

    // counts per tenant: a test tenant by slug, every other tenant anonymously
    const slugOf = new Map(rows.map((r) => [r.tenantId, r.slug]));
    const perTenant = new Map();
    for (const p of plan) perTenant.set(p.tenantId, (perTenant.get(p.tenantId) ?? 0) + 1);
    let n = 0;
    for (const [id, count] of perTenant) {
      const slug = slugOf.get(id);
      const label = isTestTenant(slug) ? slug : `tenant ${String.fromCharCode(65 + (n++ % 26))}`;
      console.log(`${label}: ${count} refund(s) to backfill`);
    }
    console.log(
      `${rows.length} candidate refund(s) scanned: ${plan.length} to backfill, ` +
        `${skipped.unknownTender} with an unknown or missing tender (left null), ` +
        `${skipped.auditTenantMismatch} with another tenant's audit row (left null), ` +
        `${skipped.notEligible} not eligible.`,
    );
    if (!apply) {
      console.log("\nDry run only — pass --apply to write these changes.");
      return;
    }

    let applied = 0;
    let raced = 0;
    let failed = 0;
    for (const p of plan) {
      try {
        const written = await setRefundTender(prisma, {
          id: p.returnId,
          tenantId: p.tenantId,
          tender: p.tender,
        });
        if (written === 1) applied += 1;
        else raced += 1;
      } catch (err) {
        console.error(`Failed to backfill ${p.returnId}: ${err.message}`);
        failed += 1;
      }
    }
    console.log(
      `Applied ${applied} change(s), ${failed} failed, ${raced} already set (rerun to confirm 0).`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    const msg = err?.message ?? String(err);
    console.error(databaseUrl ? scrubSecrets(msg, databaseUrl) : msg);
    process.exit(1);
  });
}
