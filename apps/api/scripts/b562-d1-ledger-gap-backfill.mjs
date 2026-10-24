// B562 PR-4 — D1 (SA-136 §5): close the stock-ledger gap ONCE, at the PR-2 cutover.
//
// Before B562 PR-2, order create/edit/cancel moved `Product.currentStock` with no StockMovement, so
// on every product with order history `drift = currentStock − Σ StockMovement.quantity` ≠ 0 and the
// cost replay refuses every backdated write (L-207). From PR-2's deploy on, the gap stops growing;
// this script closes the historic part with ONE row per drifted product:
//   type SALE, quantity = drift (negative when sales exceeded), unitCost null,
//   reference `B562:BACKFILL:<planHash>`, notes "ledger gap closed at cutover",
//   effectiveAt = --cutover (the PR-2 deploy SUCCESS time), stockAfter = the counter,
//   avgCostAfter = the product's average (a SALE is stock-only in the fold — the average is
//   untouched; SA-136 §5 D2 repairs it separately).
// After D1, `stock-ledger-gap.mjs` exits 0 and backdated purchases are accepted again.
//
// DRY-RUN IS THE DEFAULT: a READ ONLY transaction, always rolled back. It reports every drifted
// product and saves a content-hashed plan (local-assets/handoff, or --out <dir>) that --apply
// later replays. Report columns per product: drift, last movement, the non-DRAFT/non-CANCELLED
// orders the ledger never saw (count, Σ line qty, how many have OrderRevision rows), and SA-136b's
// "box-unaware sales × (pack − 1)" — the pieces a pre-B703 box-unaware line under-decremented by,
// which feeds an owner stock-count correction (the B746 shape; D1 itself writes nothing for it).
//
//   railway run --service postgres node apps/api/scripts/b562-d1-ledger-gap-backfill.mjs --cutover <iso>
//   node apps/api/scripts/b562-d1-ledger-gap-backfill.mjs --local --cutover <iso> [--tenant <slug>]
//   node apps/api/scripts/b562-d1-ledger-gap-backfill.mjs --self-test
//
// APPLY replays a SAVED plan only (never a live re-query):
//   node apps/api/scripts/b562-d1-ledger-gap-backfill.mjs --apply --plan <file> \
//     --confirm-plan <hash> --guard-sha <sha> --backup-taken [--local] \
//     [--live-tenant-override --confirm "APPLY <n> PRODUCTS"]
// Gates, ALL must pass or nothing is written (SA-134 / B681 / B294's set):
//   1. --confirm-plan equals the plan file's own sha256;
//   2. --guard-sha is a git ancestor of this checkout's HEAD (B562 PR-2, which stops the gap growing);
//   3. the DB fingerprint (database, tenant ids — every tenant, or the --tenant scope) still matches;
//   4. a LIVE (non-test) tenant needs --live-tenant-override plus the literal type-back phrase;
//      a PROTECTED tenant (paying, Stripe-linked, env-listed; live-target-guard.cjs) also needs
//      --allow-protected <tenantId> and the typed "ALLOW PROTECTED <tenantId>" at a real terminal;
//   5. --backup-taken (or its alias --i-have-a-fresh-backup), always;
//   6. every planned product is LOCKED and RE-READ: its counter, Σ quantity and movement count must
//      equal the dry run's — any change refuses the whole apply.
// Idempotent: a product that already carries this plan's reference is skipped (a re-run writes
// nothing). One transaction. Exit: 0 ok · 1 refused (nothing written) · 2 env/connection error.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import { DRIFTED_PRODUCTS_SQL, PRODUCT_LEDGER_SQL } from "./lib/stock-drift-sql.mjs";
import guard from "./lib/live-target-guard.cjs";
import finiteMoney from "../../../scripts/lib/assert-finite-money.cjs";
import protectedSlugsLib from "./lib/protected-slugs.cjs";

const { confirmProtectedOverride, hasBackupAttestation, protectedTenantIds, refuseRetiredFlags } =
  guard;
const { loadProtectedSlugs } = protectedSlugsLib;
const { assertFiniteMoney } = finiteMoney;

const TAG = "b562-d1";
const REFERENCE_PREFIX = "B562:BACKFILL:";
const NOTES = "ledger gap closed at cutover";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "b562-d1-ledger-gap-backfill.mjs");

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sha256 = (obj) => createHash("sha256").update(JSON.stringify(obj)).digest("hex");
const refuse = (msg) => Object.assign(new Error(msg), { refuse: true });

/** Decimal strings compare exactly; Postgres returns numerics as strings. */
const dec = (v) => (v == null ? "0" : String(v));

/**
 * Pure: the backfill row for one product, or null when its ledger already explains the counter.
 * `drift` is a 3-dp decimal string (the quantity column's scale), computed without float error.
 */
export function backfillRowFor(product) {
  const drift = subtractDecimal(dec(product.counter), dec(product.ledger));
  if (isZeroDecimal(drift)) return null;
  return { quantity: drift, stockAfter: dec(product.counter) };
}

/** Pure: a − b for Decimal(…, 3) strings, exact (scaled integers, no float). */
export function subtractDecimal(a, b) {
  const scale = (s) => {
    const neg = s.trim().startsWith("-");
    const [int, frac = ""] = s.trim().replace(/^[-+]/, "").split(".");
    const v = BigInt(int || "0") * 1000n + BigInt((frac + "000").slice(0, 3));
    return neg ? -v : v;
  };
  const d = scale(a) - scale(b);
  const neg = d < 0n;
  const abs = neg ? -d : d;
  const int = abs / 1000n;
  const frac = (abs % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

const isZeroDecimal = (s) => /^-?0(\.0*)?$/.test(s);

/**
 * Pure (SA-136b): the pieces one box-unaware line under-decremented the counter by before B703 —
 * `qty × (pack − 1)` when the line has no boxes/pieces split, no unit label, no own pack snapshot,
 * and the product's pack is > 1 (the counter moved by the BOX count, the shelf lost pack × boxes).
 */
export function boxUnawareUnderDecrement(line, livePack) {
  const pack = Number(livePack ?? 0);
  const unit = typeof line.unitLabel === "string" ? line.unitLabel.trim() : "";
  if (line.boxes != null || line.pieces != null || unit !== "" || line.unitsPerBox != null)
    return 0;
  if (!(pack > 1)) return 0;
  return Number(line.qty) * (pack - 1);
}

// Row 635 (SA-902 MUST 1): the one drift query, shared with stock-ledger-gap.mjs.
const PRODUCTS_SQL = DRIFTED_PRODUCTS_SQL;

// The orders the ledger never saw: non-DRAFT/non-CANCELLED orders with no ORDER:<id> movement
// (PR-2 books one on every stock event), their active lines of the drifted products.
const LEGACY_LINES_SQL = `
  SELECT oi."productId", o.id AS "orderId", oi.qty, oi.boxes, oi.pieces, oi."unitsPerBox",
         oi."unitLabel",
         EXISTS (SELECT 1 FROM "OrderRevision" r WHERE r."orderId" = o.id) AS "hasRevision"
    FROM "OrderItem" oi
    JOIN "Order" o ON o.id = oi."orderId"
   WHERE oi."productId" = ANY($1::text[])
     AND oi.status <> 'CANCELLED'
     AND o.status NOT IN ('DRAFT', 'CANCELLED')
     AND NOT EXISTS (
       SELECT 1 FROM "StockMovement" sm
        WHERE sm."productId" = oi."productId" AND sm.reference = 'ORDER:' || o.id
     )`;

async function resolveTarget() {
  const local = process.argv.includes("--local");
  // --local: the resolver's DATABASE_URL fallback, then refused unless provably local. Otherwise a
  // writer requires the Railway proxy and never falls back (B799).
  const url = resolveDatabaseUrl(process.env, { requireProxy: !local });
  if (local && !isLocalDbTarget(url))
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  return url;
}

/**
 * The DB the plan was built over: its name and the tenant universe — every tenant, or the one
 * `--tenant` scoped the dry run to (the plan then touches only that tenant).
 */
async function fingerprint(client, tenantId) {
  const [db, tenants] = await Promise.all([
    client.query("SELECT current_database() AS db"),
    client.query('SELECT id FROM "Tenant" WHERE ($1::text IS NULL OR id = $1) ORDER BY id', [
      tenantId,
    ]),
  ]);
  return {
    database: db.rows[0].db,
    // Opus #3696 MUST 3: ids and counts only — the plan file never carries a slug or a name.
    tenantScope: tenantId,
    tenantIds: tenants.rows.map((t) => t.id),
  };
}

async function dryRun() {
  const cutoverRaw = argOf("--cutover");
  const cutover = cutoverRaw ? new Date(cutoverRaw) : null;
  if (!cutover || Number.isNaN(cutover.getTime())) {
    console.error(`${TAG}: --cutover <iso> is required (the B562 PR-2 deploy SUCCESS time)`);
    return 1;
  }
  const tenantSlug = argOf("--tenant") ?? null;
  const scoped = tenantSlug != null;
  const url = await resolveTarget();
  console.log(
    `${TAG}: target ${redactUrl(url)} DRY-RUN (cutover ${cutover.toISOString()}${scoped ? ", one tenant" : ""})`,
  );
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const scopeId = tenantSlug
      ? ((await client.query('SELECT id FROM "Tenant" WHERE slug = $1', [tenantSlug])).rows[0]
          ?.id ?? null)
      : null;
    if (tenantSlug && !scopeId) throw new Error("no such tenant");
    const fp = await fingerprint(client, scopeId);
    const products = (await client.query(PRODUCTS_SQL, [tenantSlug])).rows;
    const lines = products.length
      ? (await client.query(LEGACY_LINES_SQL, [products.map((p) => p.productId)])).rows
      : [];
    await client.query("ROLLBACK");

    const linesBy = new Map();
    for (const l of lines) linesBy.set(l.productId, [...(linesBy.get(l.productId) ?? []), l]);

    const apply = [];
    const report = [];
    for (const p of products) {
      const row = backfillRowFor(p);
      if (!row) continue;
      const own = linesBy.get(p.productId) ?? [];
      const orders = new Set(own.map((l) => l.orderId));
      const revised = new Set(own.filter((l) => l.hasRevision).map((l) => l.orderId));
      report.push({
        tenantId: p.tenantId,
        productId: p.productId,
        drift: row.quantity,
        lastMovementAt: p.lastMovementAt ? new Date(p.lastMovementAt).toISOString() : null,
        unseenOrders: orders.size,
        unseenLineQty: own.reduce((s, l) => s + Number(l.qty), 0),
        ordersWithRevisions: revised.size,
        boxUnawareUnderDecrement: own.reduce(
          (s, l) => s + boxUnawareUnderDecrement(l, p.unitsPerBox),
          0,
        ),
      });
      apply.push({
        productId: p.productId,
        tenantId: p.tenantId,
        quantity: row.quantity,
        expected: {
          counter: dec(p.counter),
          ledger: dec(p.ledger),
          movementCount: p.movementCount,
        },
      });
    }

    const plan = {
      generatedAt: new Date().toISOString(),
      cutover: cutover.toISOString(),
      fingerprint: fp,
      apply,
    };
    const hash = sha256(plan);
    const dir = argOf("--out")
      ? resolve(argOf("--out"))
      : resolve(REPO_ROOT, "local-assets/handoff", new Date().toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `b562-d1-plan-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ ...plan, planHash: hash, report }, null, 2));

    console.log(`\n${TAG}: ${apply.length} drifted product(s)`);
    for (const r of report.slice(0, 50)) {
      console.log(
        `  tenant ${r.tenantId ?? "<none>"}  ${r.productId}  drift=${r.drift}  unseenOrders=${r.unseenOrders}` +
          ` (Σqty ${r.unseenLineQty}, ${r.ordersWithRevisions} revised)  boxUnaware×(pack−1)=${r.boxUnawareUnderDecrement}` +
          `  last=${r.lastMovementAt ?? "-"}`,
      );
    }
    if (report.length > 50) console.log(`  … ${report.length - 50} more (see the plan file)`);
    console.log(`\nplan: ${file}\nplan hash: ${hash}`);
    if (apply.length > 0) {
      console.log(
        `\nto apply: node ${SELF.replace(/\\/g, "/")} --apply --plan ${file.replace(/\\/g, "/")} --confirm-plan ${hash} --guard-sha <sha> --backup-taken`,
      );
    }
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`${TAG}: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function verifyGuardSha(guardSha) {
  const head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  try {
    execFileSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", guardSha, head]);
  } catch {
    throw refuse(`--guard-sha ${guardSha} is not an ancestor of this checkout's HEAD (${head})`);
  }
}

async function apply() {
  const planFile = argOf("--plan");
  const confirmPlan = argOf("--confirm-plan");
  const guardSha = argOf("--guard-sha");
  refuseRetiredFlags(process.argv);
  // --backup-taken is the house flag; --i-have-a-fresh-backup stays an alias (live-target-guard.cjs).
  if (
    !planFile ||
    !confirmPlan ||
    !guardSha ||
    !hasBackupAttestation(process.argv, "--i-have-a-fresh-backup")
  ) {
    console.error(`${TAG}: --apply needs --plan, --confirm-plan, --guard-sha and --backup-taken`);
    return 1;
  }
  const saved = JSON.parse(readFileSync(planFile, "utf8"));
  const { planHash, report: _report, ...plan } = saved;
  if (sha256(plan) !== confirmPlan || planHash !== confirmPlan) {
    console.error(`${TAG}: --confirm-plan does not match the plan file's own hash -- refusing`);
    return 1;
  }
  try {
    verifyGuardSha(guardSha);
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 1;
  }

  const reference = `${REFERENCE_PREFIX}${planHash}`;
  const url = await resolveTarget();
  console.log(`${TAG}: target ${redactUrl(url)} APPLY (${plan.apply.length} product(s))`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    const fp = await fingerprint(client, plan.fingerprint.tenantScope ?? null);
    if (JSON.stringify(fp) !== JSON.stringify(plan.fingerprint)) {
      throw refuse("DB fingerprint changed since the dry run (database or tenants differ)");
    }
    const tenantIds = [...new Set(plan.apply.map((a) => a.tenantId))];
    const slugs = await client.query('SELECT id, slug FROM "Tenant" WHERE id = ANY($1::text[])', [
      tenantIds,
    ]);
    const slugById = new Map(slugs.rows.map((t) => [t.id, t.slug]));
    const live = tenantIds.filter((id) => !isTestTenant(slugById.get(id)));
    if (live.length > 0) {
      const phrase = `APPLY ${plan.apply.length} PRODUCTS`;
      if (!process.argv.includes("--live-tenant-override") || argOf("--confirm") !== phrase) {
        throw refuse(
          `${live.length} LIVE tenant(s) in this plan: pass --live-tenant-override --confirm "${phrase}"`,
        );
      }
    }

    // Row 195 / SA-756r (the live-target guard): a PROTECTED tenant (paying, Stripe-linked or env-listed) is written only
    // when the operator names its id with --allow-protected and types the confirmation at a real terminal. Ids only.
    const protectedIds = new Set(
      await protectedTenantIds(client, loadProtectedSlugs(process.env, url)),
    );
    for (const id of tenantIds.filter((t) => protectedIds.has(t))) {
      // eslint-disable-next-line no-await-in-loop
      await confirmProtectedOverride({
        tenantId: id,
        argv: process.argv,
        backupFlag: "--i-have-a-fresh-backup",
      }).catch((e) => {
        throw refuse(e.message);
      });
    }

    let written = 0;
    let skipped = 0;
    for (const a of plan.apply) {
      // Lock the product row first: no stock writer can move the counter between this re-read and
      // the insert (every writer takes the same row, by UPDATE or FOR UPDATE).
      const locked = (
        await client.query(
          'SELECT "currentStock", "averageCost" FROM "Product" WHERE id = $1 FOR UPDATE',
          [a.productId],
        )
      ).rows[0];
      const done = await client.query(
        'SELECT 1 FROM "StockMovement" WHERE "productId" = $1 AND reference = $2 LIMIT 1',
        [a.productId, reference],
      );
      if (done.rowCount > 0) {
        skipped += 1; // already applied — idempotent on the reference
        continue;
      }
      const ledger = (await client.query(PRODUCT_LEDGER_SQL, [a.productId])).rows[0];
      const changed =
        !locked ||
        dec(locked.currentStock) !== a.expected.counter ||
        dec(ledger.total) !== a.expected.ledger ||
        ledger.cnt !== a.expected.movementCount;
      if (changed) throw refuse(`product ${a.productId} has changed since the dry run`);
      await client.query(
        `INSERT INTO "StockMovement"
           (id, "productId", "tenantId", type, quantity, "unitCost", "avgCostAfter", "stockAfter",
            reference, notes, "performedById", "effectiveAt", "createdAt")
         VALUES ($1, $2, $3, 'SALE', $4, NULL, $5, $6, $7, $8, NULL, $9, now())`,
        [
          randomUUID(),
          a.productId,
          a.tenantId,
          assertFiniteMoney(a.quantity, `product ${a.productId} quantity`),
          locked.averageCost == null
            ? null
            : assertFiniteMoney(locked.averageCost, `product ${a.productId} averageCost`),
          assertFiniteMoney(locked.currentStock, `product ${a.productId} currentStock`),
          reference,
          NOTES,
          plan.cutover,
        ],
      );
      written += 1;
    }
    await client.query("COMMIT");
    console.log(
      `${TAG}: committed — ${written} backfill row(s)${skipped ? `, ${skipped} already applied` : ""} (${reference})`,
    );
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`${TAG}: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** --self-test: the pure helpers, no database. */
function selfTest() {
  const cases = [
    [
      "drift: counter 76, ledger 100 → −24",
      backfillRowFor({ counter: "76", ledger: "100" })?.quantity,
      "-24",
    ],
    [
      "drift: counter 10.5, ledger 7.25 → 3.25",
      backfillRowFor({ counter: "10.5", ledger: "7.25" })?.quantity,
      "3.25",
    ],
    ["no drift → no row", backfillRowFor({ counter: "12.000", ledger: "12" }), null],
    ["exact: 0.3 − 0.1 = 0.2 (no float residue)", subtractDecimal("0.3", "0.1"), "0.2"],
    ["box-unaware 2 boxes on a 12-pack → 22", boxUnawareUnderDecrement({ qty: 2 }, 12), 22],
    ["a split line → 0", boxUnawareUnderDecrement({ qty: 27, boxes: 2, pieces: 3 }, 12), 0],
    ["a Units line → 0", boxUnawareUnderDecrement({ qty: 5, unitLabel: "Case" }, 12), 0],
    ["own pack snapshot → 0", boxUnawareUnderDecrement({ qty: 2, unitsPerBox: 6 }, 12), 0],
    ["a plain product → 0", boxUnawareUnderDecrement({ qty: 3 }, null), 0],
  ];
  let failed = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` (got ${JSON.stringify(got)})`}`);
  }
  console.log(
    failed ? `${TAG} self-test: ${failed} FAILED` : `${TAG} self-test: all ${cases.length} passed`,
  );
  return failed ? 1 : 0;
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  try {
    return process.argv.includes("--apply") ? await apply() : await dryRun();
  } catch (e) {
    console.error(`${TAG}: ${e.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
