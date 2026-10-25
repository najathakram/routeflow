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
//     products. Each batch first takes U-1's ladder locks (the tenant units lock SHARED, then each
//     product's lock, sorted), so a unit rename never interleaves with it, then re-reads its
//     TenantUnits and parents FOR SHARE and writes compare-and-set, so a row edited since planning
//     is skipped and reported, never overwritten. Idempotent: a re-run
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
//   ... --local --tenant <id> --expect-zero      (SA-984 §3: the read-only re-run check)
//
// --expect-zero: runs the normal dry run (same snapshot, same plan), then prints one line and exits by
//   the plan's counts (SA-984 §3 as amended by SA-986), one ordered decision, first hit wins:
//     pending (exit 3): tenantUnitsCreated / productUnitsLinked / productUnitsParentFilled above 0, or a
//       gated count missing or malformed;
//     residue (exit 4): tenantUnitsOverflow / skippedTooLong / skippedParent above 0;
//     else all six are 0 (exit 0).
//   It is read-only: combining it with --apply is refused as an argument error.
// Exit codes: 0 = done (with --expect-zero: all six gated counts are 0); 1 = refused or failed (an
//   argument, target, guard or database error); 3 = --expect-zero found a re-run still plans rows;
//   4 = --expect-zero found residue no re-run clears (overflow, too-long names, skipped parent fills).
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
  cappedAtApplyLines,
} = require("./lib/tenant-units-plan.cjs");
const { applyTenantUnitsPlan, BACKFILL_BATCH_SIZE } = require("./lib/tenant-units-apply.cjs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every argv token this script (and the guards it forwards argv to) reads. live-target-guard.cjs reads
// --allow-protected <tenantId> and --backup-taken (its older backup aliases are not passed here, so none
// is accepted); the retired paying-tenant flags are refused earlier, by refuseRetiredFlags.
export const ACCEPTED_FLAGS = Object.freeze({
  boolean: Object.freeze([
    "--apply",
    "--local",
    "--live-tenant-override",
    "--backup-taken",
    "--expect-zero",
  ]),
  value: Object.freeze(["--tenant", "--allow-protected"]),
});
export const USAGE =
  "Usage: backfill-tenant-units.mjs --tenant <tenantId> [--local] [--apply] [--expect-zero] " +
  "[--live-tenant-override] [--backup-taken] [--allow-protected <tenantId>]";

/**
 * Refuses any argv token the script does not read, so a typo (`--expectzero`) can never pass as an OK
 * dry run. A flag's value is consumed with it; a stray positional is refused without echoing it (it
 * could be a slug); an unknown flag is named up to any `=`.
 */
function refuseUnknownArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (ACCEPTED_FLAGS.value.includes(t)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${t} requires a value. ${USAGE}`);
      i++;
    } else if (!ACCEPTED_FLAGS.boolean.includes(t)) {
      throw new Error(
        t.startsWith("--")
          ? `unknown flag: ${t.split("=")[0]}. ${USAGE}`
          : `unexpected argument (a value without a flag). ${USAGE}`,
      );
    }
  }
}

export function parseArgs(argv) {
  refuseRetiredFlags(argv);
  const idx = argv.indexOf("--tenant");
  if (idx === -1) throw new Error("--tenant <tenantId> is required");
  if (argv.indexOf("--tenant", idx + 1) !== -1) throw new Error("--tenant may be given only once");
  const tenantId = argv[idx + 1];
  if (!tenantId || tenantId.startsWith("--")) throw new Error("--tenant requires a tenant id");
  if (!UUID.test(tenantId)) throw new Error("--tenant takes the tenant id (a uuid), never a slug");
  refuseUnknownArgs(argv);
  if (argv.includes("--expect-zero") && argv.includes("--apply")) {
    throw new Error("--expect-zero is a read-only check; do not combine it with --apply");
  }
  return {
    apply: argv.includes("--apply"),
    expectZero: argv.includes("--expect-zero"),
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

/**
 * The --expect-zero decision (SA-984 §3 as amended by SA-986): ONE ordered pure decision over the plan's
 * counts, first hit wins.
 *   1. pending, exit 3: tenantUnitsCreated, productUnitsLinked or productUnitsParentFilled above 0 (a
 *      re-run still plans rows), OR any of the six gated counts missing or not a number >= 0 (fails
 *      closed, never OK);
 *   2. residue, exit 4: tenantUnitsOverflow, skippedTooLong or skippedParent above 0 (no re-run clears
 *      these, so a re-apply is pointless: the counts go to the SA);
 *   3. zero, exit 0: all six are exactly 0.
 * Both holding: exit 3, and the line names both. The gate on the cap is the NAME count
 * tenantUnitsOverflow (a pack word with no ladder level is still a unit missing from Settings > Units);
 * productUnitsUnlinkedOverflow is printed, gated through it. Counts by design not gated are classed in
 * BY_DESIGN_COUNTS; a spec pins every key of the plan's counts as one or the other. Exit 3 and 4 are
 * distinct from a real error (1).
 */
export const PENDING_COUNTS = Object.freeze([
  "tenantUnitsCreated",
  "productUnitsLinked",
  "productUnitsParentFilled",
]);
export const RESIDUE_COUNTS = Object.freeze([
  "tenantUnitsOverflow",
  "skippedTooLong",
  "skippedParent",
]);
export const BY_DESIGN_COUNTS = Object.freeze([
  "tenantUnitsExisting", // done work
  "productUnitsUnlinkedOverflow", // printed; gated through tenantUnitsOverflow
  "skippedSynonyms", // piece words are never a TenantUnit
  "explicitPieceParent", // left as it is (#3336), only listed
]);

export function expectZeroResult(counts) {
  const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const malformed = [...PENDING_COUNTS, ...RESIDUE_COUNTS].filter((k) => !isCount(counts?.[k]));
  const pending = PENDING_COUNTS.some((k) => isCount(counts?.[k]) && counts[k] > 0);
  const residue = RESIDUE_COUNTS.some((k) => isCount(counts?.[k]) && counts[k] > 0);
  const c = counts ?? {};
  const pendingPart = `created=${c.tenantUnitsCreated} linked=${c.productUnitsLinked} parentFilled=${c.productUnitsParentFilled}`;
  const residuePart =
    `overflow=${c.tenantUnitsOverflow} unlinkedOverflow=${c.productUnitsUnlinkedOverflow} ` +
    `tooLong=${c.skippedTooLong} parentSkipped=${c.skippedParent}`;
  if (pending || malformed.length > 0) {
    const notes = [];
    if (pending) notes.push("a re-run still plans rows");
    if (malformed.length > 0)
      notes.push(`a count is missing or malformed: ${malformed.join(", ")}`);
    if (residue) notes.push("the residue stays after it; send the counts to the SA");
    return {
      ok: false,
      line:
        `Expect-zero: FAIL ${pendingPart}` +
        (residue ? `; RESIDUE ${residuePart}` : "") +
        ` (${notes.join("; ")})`,
      exitCode: 3,
    };
  }
  if (residue) {
    return {
      ok: false,
      line: `Expect-zero: RESIDUE ${residuePart} (no re-run clears this; send the counts to the SA)`,
      exitCode: 4,
    };
  }
  return {
    ok: true,
    line: `Expect-zero: OK ${pendingPart} overflow=0 tooLong=0 parentSkipped=0`,
    exitCode: 0,
  };
}

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

      let batchesCommitted = 0;
      let result;
      try {
        result = await applyTenantUnitsPlan({
          prisma,
          tenantId: args.tenantId,
          plan,
          productIdByUnit: new Map(snap.productUnits.map((u) => [u.id, u.productId])),
          batchSize: BACKFILL_BATCH_SIZE,
          onBatch: (done, total) => {
            batchesCommitted = done;
            console.log(`Batch ${done}/${total} committed`);
          },
        });
      } catch (err) {
        // The finished batches stay committed; a re-run plans only what is still missing.
        const total = err?.batchesTotal;
        console.error(
          total === undefined
            ? "Stopped before any product batch ran (the unit-create step failed or was rolled back)."
            : `Stopped after ${err?.batchesCommitted ?? batchesCommitted} of ${total} product ` +
                "batch(es) committed; re-run to resume.",
        );
        throw err;
      }
      console.log(`Batches: ${result.batches} (up to ${BACKFILL_BATCH_SIZE} products each)`);
      if (result.linksChanged + result.parentsChanged > 0) {
        console.log(
          `Changed since planning (skipped, not overwritten): links=${result.linksChanged} ` +
            `parents=${result.parentsChanged}; re-run to pick them up.`,
        );
      }
      if (result.linksOverCap > 0) {
        console.log(
          `Not linked, their unit is over the cap: ${result.linksOverCap} level(s) ` +
            "(they keep their label; a re-run links them once there is room).",
        );
      }
      for (const line of cappedAtApplyLines(result.unitsCappedNames)) console.log(line);
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
    if (args.expectZero) {
      const check = expectZeroResult(plan.counts);
      console.log(check.line);
      process.exitCode = check.exitCode;
    }
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
