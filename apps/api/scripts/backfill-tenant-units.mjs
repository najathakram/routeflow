// apps/api/scripts/backfill-tenant-units.mjs  (units U-6)
//
// Backfills the tenant unit-name list and the ladder links from the unit words a tenant already uses.
// INSERTS AND FK LINKS ONLY (SA-729:52): it never writes a Product column, a line snapshot, or any
// order / invoice table.
//   (a) distinct words: ProductUnit.label (ladder levels) + Product.unit (legacy pack word);
//   (b) one TenantUnit per distinct nameKey (= unitNameKey(name): NFC, then trim, then case-fold, the
//       same key the units service uses), named by the most common casing; > 30 chars are reported
//       and skipped; Piece synonyms (piece/pieces/each/unit/pcs) get no TenantUnit;
//       THE CAP (SA-810): a system writer never refuses and never takes a tenant past
//       MAX_ACTIVE_TENANT_UNITS (200) ACTIVE units. It adds the most-used names that fit, reports the
//       rest by name and count, and leaves their levels unlinked (they keep their label). A tenant
//       already over 200 keeps every row and gets none;
//   (c) ProductUnit.tenantUnitId linked by nameKey where NULL (archived units included: never a
//       second unit for a key; links to an archived unit are reported so it can be restored);
//   (d) ProductUnit.parentUnitId / perParent filled where NULL (SA-729a item 3): the parent is the
//       largest lower size of the product that divides this one: a level row (factor > 1), or the
//       pack (Product.unitsPerBox > 1, written as parentUnitId NULL + perParent = factor / pack),
//       else the base (parentUnitId NULL; a factor-1 row is never a parent, SA-728); perParent must
//       be an integer >= 2, otherwise the level is reported and skipped.
//
// SAFETY
//   - DRY-RUN by default: ONE `REPEATABLE READ, READ ONLY` transaction (checked read-only before any
//     read), with lock_timeout + statement_timeout. Writes ONLY with --apply.
//   - --tenant <tenantId> is required (the id, never a slug; nothing prints a slug).
//   - Target: --local reads DATABASE_URL and refuses anything not provably local. Without --local the
//     Railway proxy variables are required (`railway run --service postgres ...`) and DATABASE_URL is
//     never a fallback.
//   - --apply on a LIVE (non-test) tenant needs --live-tenant-override and --backup-taken.
//   - --apply on a PROTECTED tenant (paying, Stripe-linked, or in PROTECTED_TENANT_SLUGS) is refused
//     unless --allow-protected <tenantId> and --backup-taken are given AND "ALLOW PROTECTED <tenantId>"
//     is typed at a real terminal (lib/live-target-guard.cjs). Dry runs read any tenant.
//   - Writes go in small transactions (lib/tenant-units-apply.cjs), each with lock_timeout +
//     statement_timeout: one for the TenantUnit upserts, then one per batch of BACKFILL_BATCH_SIZE
//     products. Each batch re-reads its TenantUnits and parents FOR SHARE and writes compare-and-set,
//     so a row edited since planning is skipped and reported, never overwritten. Idempotent: a re-run
//     plans only what is still missing; a crash between batches keeps the finished batches.
//   - Output: counts, plus unit NAMES where a report needs one (archived units). Never a tenant name,
//     slug or row id.
//
// Sequencing: run this for a tenant BEFORE the Settings > Units UI / ladder editor is visible to it.
//
// Usage:
//   DATABASE_URL=postgresql://...@localhost:5432/db node apps/api/scripts/backfill-tenant-units.mjs --local --tenant <id>
//   ... --local --tenant <id> --apply
//   railway run --service postgres node apps/api/scripts/backfill-tenant-units.mjs --tenant <id>
//   ... --tenant <id> --apply --live-tenant-override --backup-taken [--allow-protected <id>]
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { requireLocalPgConfig } from "./lib/local-pg-config.mjs";
import { resolveDatabaseUrl } from "./lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");
const {
  assertWritableTenant,
  confirmProtectedOverride,
  hasBackupAttestation,
  refuseRetiredFlags,
} = require("./lib/live-target-guard.cjs");
const { protectedArm } = require("./lib/paying-tenant.cjs");
const {
  planTenantUnits,
  archivedLinkLines,
  overflowLines,
  MAX_ACTIVE_TENANT_UNITS,
} = require("./lib/tenant-units-plan.cjs");
const { applyTenantUnitsPlan, BACKFILL_BATCH_SIZE } = require("./lib/tenant-units-apply.cjs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv) {
  refuseRetiredFlags(argv);
  const idx = argv.indexOf("--tenant");
  if (idx === -1) throw new Error("--tenant <tenantId> is required");
  if (argv.indexOf("--tenant", idx + 1) !== -1) throw new Error("--tenant may be given only once");
  const tenantId = argv[idx + 1];
  if (!tenantId || tenantId.startsWith("--")) throw new Error("--tenant requires a tenant id");
  if (!UUID.test(tenantId)) throw new Error("--tenant takes the tenant id (a uuid), never a slug");
  return {
    apply: argv.includes("--apply"),
    local: argv.includes("--local"),
    liveOverride: argv.includes("--live-tenant-override"),
    backupTaken: hasBackupAttestation(argv),
    tenantId,
  };
}

/** Pre-connection target decision. Returns { url, cfg } or throws. */
export function resolveTarget({ local }, env = process.env) {
  if (local) {
    const url = env.DATABASE_URL;
    if (!url) throw new Error("--local requires DATABASE_URL");
    return { url, cfg: requireLocalPgConfig(url) };
  }
  const url = resolveDatabaseUrl(env, { requireProxy: true });
  return { url, cfg: { connectionString: url } };
}

/** The --apply gate for a LIVE (non-test) tenant. Throws unless the override and backup are present. */
export function assertLiveApplyAllowed(args, isTest) {
  if (isTest) return;
  if (!args.liveOverride || !args.backupTaken) {
    throw new Error(
      "Refusing: this is a LIVE tenant. --apply needs --live-tenant-override and --backup-taken " +
        "(the tenant's explicit request and a fresh backup first). Nothing was written.",
    );
  }
}

// One tenant's protection row (the live-target guard's own column set, couponFull included).
const TENANT_SQL = `SELECT t.id, t.slug, t.status, t.class, t."deletedAt",
    s."planKey", s."stripeSubId", s."couponFull"
  FROM "Tenant" t LEFT JOIN "TenantSubscription" s ON s."tenantId" = t.id
  WHERE t.id = $1`;

/** No plan = never paying, so couponFull is moot; otherwise the RAW value (unselected still throws). */
export const subOf = (r) => ({
  planKey: r.planKey,
  stripeSubId: r.stripeSubId,
  couponFull: r.planKey == null ? false : r.couponFull,
});

/**
 * Every read the plan needs, inside ONE REPEATABLE READ, READ ONLY transaction (one snapshot, no write
 * possible). Fails closed if the transaction is not actually read-only.
 */
export async function readSnapshot(prisma, tenantId) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '120s'");
    const [ro] = await tx.$queryRawUnsafe(
      "SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso",
    );
    if (ro?.ro !== "on" || ro?.iso !== "repeatable read") {
      throw new Error("internal: the dry-run transaction is not REPEATABLE READ, READ ONLY");
    }
    const [tenant] = await tx.$queryRawUnsafe(TENANT_SQL, tenantId);
    if (!tenant) return { tenant: null };
    const productUnits = await tx.productUnit.findMany({
      where: { tenantId },
      select: {
        id: true,
        productId: true,
        label: true,
        tenantUnitId: true,
        factorToBase: true,
        parentUnitId: true,
        perParent: true,
      },
    });
    const products = await tx.product.findMany({
      where: { tenantId },
      select: { id: true, unit: true, unitsPerBox: true },
    });
    const existingUnits = await tx.tenantUnit.findMany({
      where: { tenantId },
      select: { id: true, nameKey: true, name: true, archivedAt: true },
    });
    return { tenant, productUnits, products, existingUnits };
  });
}

const fmt = (c) =>
  `tenantUnits created=${c.tenantUnitsCreated} existing=${c.tenantUnitsExisting} ` +
  `overflow=${c.tenantUnitsOverflow}; ` +
  `productUnits linked=${c.productUnitsLinked} parentFilled=${c.productUnitsParentFilled} ` +
  `unlinkedOverflow=${c.productUnitsUnlinkedOverflow}; ` +
  `skipped tooLong=${c.skippedTooLong} synonyms=${c.skippedSynonyms} parent=${c.skippedParent}`;

/** The skipped parent fills, counted by reason (never an id). */
export function parentSkipLines(parentSkips) {
  const byReason = new Map();
  for (const s of parentSkips) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
  return [...byReason.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([reason, n]) => `parent not filled for ${n} level(s): ${reason}`);
}

/**
 * Levels whose existing parent is an explicit factor-1 (Piece) row: left as they are (fill-only), then
 * one count line and each level name with its count (never an id).
 */
export function explicitPieceLines(rows) {
  if (rows.length === 0) return [];
  const byLabel = new Map();
  for (const r of rows) {
    const name = String(r.label ?? "").trim();
    byLabel.set(name, (byLabel.get(name) ?? 0) + 1);
  }
  return [
    `parent is an explicit Piece row: ${rows.length}`,
    ...[...byLabel.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, n]) => `  ${name}: ${n}`),
  ];
}

async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  let target;
  try {
    args = parseArgs(argv);
    target = resolveTarget(args, env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const { PrismaClient } = await import("@prisma/client");
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool(target.cfg);
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const snap = await readSnapshot(prisma, args.tenantId);
    if (!snap.tenant) {
      console.error("Refusing: no tenant with that id.");
      process.exit(1);
    }
    console.log(args.apply ? "MODE: APPLY (writes)" : "MODE: dry-run (no writes)");
    const plan = planTenantUnits(snap);

    let counts = plan.counts;
    if (args.apply) {
      assertLiveApplyAllowed(args, isTestTenant(snap.tenant.slug));
      const sub = subOf(snap.tenant);
      const slugs = loadProtectedSlugs(env, target.url);
      const allowProtected =
        protectedArm(snap.tenant, sub, slugs) === null
          ? undefined
          : await confirmProtectedOverride({ tenantId: args.tenantId, argv });
      assertWritableTenant(snap.tenant, sub, slugs, { allowProtected });

      const result = await applyTenantUnitsPlan({
        prisma,
        tenantId: args.tenantId,
        plan,
        productIdByUnit: new Map(snap.productUnits.map((u) => [u.id, u.productId])),
        batchSize: BACKFILL_BATCH_SIZE,
      });
      console.log(`Batches: ${result.batches} (up to ${BACKFILL_BATCH_SIZE} products each)`);
      if (result.linksChanged + result.parentsChanged > 0) {
        console.log(
          `Changed since planning (skipped, not overwritten): links=${result.linksChanged} ` +
            `parents=${result.parentsChanged}; re-run to pick them up.`,
        );
      }
      if (result.unitsCapped > 0) {
        console.log(
          `Left out at apply time: ${result.unitsCapped} unit name(s), the tenant reached the ` +
            `${MAX_ACTIVE_TENANT_UNITS}-unit cap since planning (SA-810).`,
        );
      }
      // What the writes actually did: a unit someone else created since planning counts as existing;
      // one the cap left out at apply time is overflow (its levels stay unlinked).
      counts = {
        ...plan.counts,
        tenantUnitsCreated: result.unitsCreated,
        tenantUnitsExisting:
          plan.counts.tenantUnitsExisting +
          (plan.toCreate.length - result.unitsCreated - result.unitsCapped),
        tenantUnitsOverflow: plan.counts.tenantUnitsOverflow + result.unitsCapped,
        productUnitsLinked: result.linked,
        productUnitsParentFilled: result.parentFilled,
      };
    }
    console.log(`${args.apply ? "Applied" : "Would apply"}: ${fmt(counts)}`);
    for (const line of overflowLines(plan.overflow)) console.log(line);
    for (const line of archivedLinkLines(plan.archivedLinks)) console.log(line);
    for (const line of parentSkipLines(plan.parentSkips)) console.log(line);
    for (const line of explicitPieceLines(plan.explicitPieceParents)) console.log(line);
    if (!args.apply) console.log("Dry run only; pass --apply to write.");
  } catch (err) {
    console.error(`Refusing: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
}
