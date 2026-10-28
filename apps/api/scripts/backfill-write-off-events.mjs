// apps/api/scripts/backfill-write-off-events.mjs
//
// SA-1050 PR-1 (rules 3, 4): give every WRITTEN_OFF invoice that predates the bad-debt ledger its one WRITE_OFF event, so the
// P&L reads the ledger and the legacy term in `fetchBadDebtExpense` can retire (PR-6) after a census of 0.
//
// This script runs NO SQL of its own and writes NOTHING itself: it loads the compiled service module
// (`dist/invoices/invoice-write-off-backfill.js`: plan, then `ensureWriteOffEvent` per invoice in its own transaction, the one
// writer of the ledger). Build first: `npm run build -w apps/api`.
//
// What it does, per invoice (WRITTEN_OFF, no event): amount = confirmedBalance, preTax = badDebtPreTax, at = writtenOffAt
// (null for an undated import: that row sits in no month), byId null, reason = writeOffReason ?? "Imported as written off".
// An invoice that owes nothing writes no row; an invoice with no tenant is refused, never guessed (both are counted).
//
// The DRY RUN (the default) prints: the WRITTEN_OFF count, per tenant how many rows `--apply` would write, and per tenant and
// month the OLD bad-debt figure (the live B456 formula, terms summed then rounded) beside the NEW one (per-invoice rounding,
// rule 4) so every month's half-cent move is visible BEFORE anything is written (owner question Q2). A test tenant is shown by
// slug, every other tenant anonymously ("tenant A", ...). It writes nothing.
//
// SAFETY (CLAUDE.md live-tenant policy, same mechanism as backfill-refund-tender.mjs):
//   - `--apply` scoped to an approved test tenant (`--tenant-id <id>`) proceeds. `--apply` scoped to a LIVE tenant also needs
//     `--live-tenant-override` AND `--confirm-tenant-id=<id>` (the id typed back), the owner's explicit request, and a FRESH
//     VALIDATED BACKUP. `--apply` with no `--tenant-id` touches every tenant, so it needs `--live-tenant-override`, and a
//     PROTECTED tenant (paying | Stripe-linked | listed) is HELD, run it per tenant with `--allow-protected <id>`.
//   - Idempotent: a rerun writes 0 (the writer skips an invoice that already has an event).
//   - The PROD run is the owner's.
//
// Usage:
//   node apps/api/scripts/backfill-write-off-events.mjs                                   # dry run, every tenant
//   node apps/api/scripts/backfill-write-off-events.mjs --tenant-id <id>                  # dry run, one tenant
//   node apps/api/scripts/backfill-write-off-events.mjs --apply --tenant-id <test tenant id>
//   node apps/api/scripts/backfill-write-off-events.mjs --apply --tenant-id <id> --live-tenant-override --confirm-tenant-id=<id>

import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { resolveDatabaseUrl, redactUrl, scrubSecrets } from "./lib/railway-db-url.mjs";
import guard from "./lib/live-target-guard.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";

const {
  assertWritableTenant,
  confirmProtectedOverride,
  filterWritableTenants,
  ProtectedTenantError,
} = guard;
const { loadProtectedSlugs } = protectedSlugsLib;
const HERE = dirname(fileURLToPath(import.meta.url));

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

const money = (n) => n.toFixed(2);

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
  let databaseUrl;
  try {
    databaseUrl = resolveDatabaseUrl(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  let protectedSlugs = null;
  if (apply) {
    try {
      protectedSlugs = loadProtectedSlugs(process.env, databaseUrl);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }
  const mod = await import(
    pathToFileURL(resolve(HERE, "../dist/invoices/invoice-write-off-backfill.js")).href
  );
  console.log(`Resolved database host: ${redactUrl(databaseUrl)}`);
  if (tenantId) console.log(`Scoped to tenant: ${tenantId}`);
  const pool = new Pool({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    if (apply) {
      if (tenantId) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true, slug: true, status: true, class: true, deletedAt: true },
        });
        if (!tenant) {
          console.error(`Tenant "${tenantId}" not found. Nothing was written.`);
          process.exit(1);
        }
        const sub = await prisma.tenantSubscription.findFirst({
          where: { tenantId },
          select: { planKey: true, stripeSubId: true, couponFull: true },
        });
        try {
          assertWritableTenant(tenant, sub, protectedSlugs);
        } catch (err) {
          if (!(err instanceof ProtectedTenantError)) throw err;
          try {
            const token = await confirmProtectedOverride({ tenantId, argv: process.argv.slice(2) });
            assertWritableTenant(tenant, sub, protectedSlugs, { allowProtected: token });
          } catch (e) {
            console.error(`${e.message}\nNothing was written.`);
            process.exit(1);
          }
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

    const plan = await mod.planWriteOffBackfill(prisma, tenantId ? { tenantId } : {});

    // A test tenant by slug, every other tenant anonymously.
    const tenantIds = [...new Set(plan.months.map((m) => m.tenantId))];
    const rows = tenantIds.length
      ? await prisma.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, slug: true, status: true, class: true, deletedAt: true },
        })
      : [];
    const slugOf = new Map(rows.map((r) => [r.id, r.slug]));
    const labelOf = new Map();
    let n = 0;
    for (const id of tenantIds) {
      const slug = slugOf.get(id);
      labelOf.set(id, isTestTenant(slug) ? slug : `tenant ${String.fromCharCode(65 + (n++ % 26))}`);
    }
    for (const [id, ids] of plan.idsByTenant) {
      console.log(`${labelOf.get(id)}: ${ids.length} write-off event(s) to write`);
    }
    for (const m of plan.months) {
      const moved = Math.round((m.newExpense - m.oldExpense) * 100) / 100;
      console.log(
        `  ${labelOf.get(m.tenantId)} ${m.month}: ${m.invoices} invoice(s), old ${money(m.oldExpense)}, new ${money(m.newExpense)}` +
          (moved !== 0 ? ` (moves ${money(moved)})` : ""),
      );
    }
    console.log(
      `${plan.scanned} WRITTEN_OFF invoice(s) scanned: ${plan.invoiceIds.length} to backfill, ` +
        `${plan.nothingDue} owing nothing (no row), ${plan.nullTenant} with no tenant (refused, not guessed).`,
    );
    if (!apply) {
      console.log("\nDry run only — pass --apply to write these events.");
      return;
    }

    // All-tenants apply: protected tenants are HELD, never written (counts per arm only, never a slug).
    let toWrite = plan.invoiceIds;
    if (!tenantId) {
      const withRows = rows.filter((r) => plan.idsByTenant.has(r.id));
      const subs = await prisma.tenantSubscription.findMany({
        where: { tenantId: { in: withRows.map((r) => r.id) } },
        select: { tenantId: true, planKey: true, stripeSubId: true, couponFull: true },
      });
      const subsById = new Map(
        subs.map((s) => [
          s.tenantId,
          {
            planKey: s.planKey,
            stripeSubId: s.stripeSubId,
            couponFull: s.planKey == null ? false : s.couponFull,
          },
        ]),
      );
      const { writable } = filterWritableTenants(withRows, subsById, protectedSlugs);
      const writableIds = new Set(writable.map((w) => w.id));
      toWrite = [...plan.idsByTenant]
        .filter(([id]) => writableIds.has(id))
        .flatMap(([, ids]) => ids);
      const held = plan.invoiceIds.length - toWrite.length;
      if (held > 0) {
        console.log(
          `${held} held: protected tenant, run per tenant with --allow-protected <tenantId> (TTY type-back) + --backup-taken`,
        );
      }
    }

    const result = await mod.applyWriteOffBackfill(prisma, toWrite);
    for (const f of result.failed) console.error(`Failed to backfill ${f.invoiceId}: ${f.message}`);
    console.log(
      `Applied ${result.written} event(s), ${result.failed.length} failed, ${result.skipped} already had one or owed nothing (rerun to confirm 0).`,
    );
    if (result.failed.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    const msg = err?.message ?? String(err);
    console.error(`backfill-write-off-events failed: ${scrubSecrets ? scrubSecrets(msg) : msg}`);
    process.exit(1);
  });
}
