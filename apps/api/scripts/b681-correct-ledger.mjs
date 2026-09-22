// B681 -- retroactive correction of box-axis-mis-booked RegulatedSalesLedger rows (SA-058 through
// SA-073, Senior Architect ruling 2026-09-22). The money-critical decision logic
// (`computeLineCorrection`, `deriveLinePack`) lives in `@routeflow/pricing` -- this script is the
// DB-facing wrapper: read rows, call it, write exactly what it returns.
//
// DRY-RUN IS THE DEFAULT and the only thing this script does without --apply: a READ ONLY
// transaction, always rolled back, never writes. It classifies every box-unaware line's rows,
// prints a human report, and saves a plan file (JSON, content-hashed) that --apply later replays.
//
//   railway run --service postgres node apps/api/scripts/b681-correct-ledger.mjs
//   DATABASE_URL=postgresql://…@localhost:5432/<db> node apps/api/scripts/b681-correct-ledger.mjs --local
//
// APPLY replays a SAVED plan -- it never re-derives corrections from a live re-query, so what you
// approved is exactly what gets written:
//
//   node apps/api/scripts/b681-correct-ledger.mjs --apply --plan <file> --confirm-plan <hash> \
//     --guard-sha <sha> --i-have-a-fresh-backup [--local] \
//     [--live-tenant-override --confirm "APPLY <n> ROWS"]
//
// Apply gates, in order, ALL must pass or nothing is written:
//   1. --confirm-plan must equal the plan file's own recorded sha256 (you saw the plan you're
//      approving, not a since-edited one).
//   2. --guard-sha must be a git ancestor of BOTH this checkout's HEAD and (best-effort, warns
//      but does not block, if unreachable) the LIVE deployed API's own commit (GET /health) --
//      never applies a correction against a target running code OLDER than the fix that stops the
//      write-time defect from recurring.
//   3. The plan's DB fingerprint (current_database(), tenant id list, ledger max(createdAt)) is
//      re-read and must still match -- refuses if the target changed since the dry run.
//   4. Any LIVE (non-test) tenant in the plan needs --live-tenant-override plus a literal
//      --confirm "APPLY <n> ROWS" phrase (n = the plan's own row count) -- same convention as
//      apps/api/scripts/t6-stamp-null-rows.mjs.
//   5. --i-have-a-fresh-backup is required unconditionally, on every apply, test tenants included.
// One transaction. Every row's `correctsEntryId` must still be an existing row with `qty`,
// `unitBasisQty`, `netSales`, `categoryTax` all identical to what the plan recorded when it was
// built, or the whole apply refuses (the row changed since the dry run -- never blind-write a
// stale delta onto a row that has since moved).
//
// Exit: 0 ok (dry-run printed / apply committed) · 1 refused (nothing written) · 2 env/connection error.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { computeLineCorrection } from "@routeflow/pricing";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import {
  BOX_UNAWARE_ROWS_SQL,
  LIVE_INVOICE_ITEMS_SQL,
  PRIOR_CORRECTIONS_SQL,
  groupByLineKey,
  pickSourceLine,
} from "./lib/b681-ledger-query.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "b681-correct-ledger.mjs");

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function sha256(obj) {
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function resolveTarget() {
  const local = process.argv.includes("--local");
  const url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
  if (!url) throw new Error("--local requires DATABASE_URL");
  if (local && !isLocalDbTarget(url)) {
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  }
  return url;
}

export async function fingerprint(client) {
  const [db, tenants, maxCreated] = await Promise.all([
    client.query("SELECT current_database() AS db"),
    client.query('SELECT id, slug FROM "Tenant" ORDER BY id'),
    client.query('SELECT max("createdAt") AS m FROM "RegulatedSalesLedger"'),
  ]);
  return {
    database: db.rows[0].db,
    tenantIds: tenants.rows.map((t) => t.id),
    ledgerMaxCreatedAt: maxCreated.rows[0].m ? new Date(maxCreated.rows[0].m).toISOString() : null,
  };
}

/** Classifies every box-unaware line, returns { report, plan } -- READ ONLY, no writes. */
export async function classify(client) {
  const flat = (await client.query(BOX_UNAWARE_ROWS_SQL)).rows;
  const lines = groupByLineKey(flat);

  const orderItemIds = [...lines.values()].map((l) => l.orderItemId).filter(Boolean);
  const invoiceItemCandidates =
    orderItemIds.length > 0
      ? (await client.query(LIVE_INVOICE_ITEMS_SQL, [orderItemIds])).rows
      : [];
  const candidatesByOrderItem = new Map();
  for (const c of invoiceItemCandidates) {
    const list = candidatesByOrderItem.get(c.orderItemId);
    if (list) list.push(c);
    else candidatesByOrderItem.set(c.orderItemId, [c]);
  }

  const rowIds = flat.map((r) => r.id);
  const priorCorrectionRows =
    rowIds.length > 0 ? (await client.query(PRIOR_CORRECTIONS_SQL, [rowIds])).rows : [];
  const priorByCorrectedRow = new Map();
  for (const c of priorCorrectionRows) {
    const list = priorByCorrectedRow.get(c.correctsEntryId);
    const entry = { qty: c.qty, unitBasisQty: c.unitBasisQty };
    if (list) list.push(entry);
    else priorByCorrectedRow.set(c.correctsEntryId, [entry]);
  }

  const results = [];
  for (const entry of lines.values()) {
    const sourceLine = pickSourceLine(candidatesByOrderItem, entry.orderItemId);
    // Idempotency: a line's prior corrections are keyed by the SALE row(s) they corrected --
    // classifySaleAxis (inside computeLineCorrection) folds them onto that SALE row's own figures.
    const saleRowIds = entry.rows.filter((r) => r.entryType === "SALE").map((r) => r.id);
    const priorCorrections = saleRowIds.flatMap((id) => priorByCorrectedRow.get(id) ?? []);
    const result = computeLineCorrection(
      entry.rows,
      entry.line,
      sourceLine,
      entry.productPackNow,
      priorCorrections,
    );
    results.push({ ...entry, result });
  }

  const byCategory = new Map();
  for (const r of results) {
    byCategory.set(r.result.category, (byCategory.get(r.result.category) ?? 0) + 1);
  }

  const applyable = results.filter((r) => r.result.corrections.length > 0 && !r.inGeneratedFiling);
  const needsFilingAmendment = results.filter(
    (r) => r.result.corrections.length > 0 && r.inGeneratedFiling,
  );
  const moneyTouched = applyable.filter((r) => r.result.moneySafe);
  // Gross figure -- corrections are a redistribution (they net to ~0 per line by construction,
  // see b681-correction.ts's header), not new money created or destroyed.
  const totalNetMoved = round2(
    moneyTouched.reduce(
      (s, r) => s + r.result.corrections.reduce((s2, c) => s2 + Math.abs(c.netDelta), 0),
      0,
    ),
  );

  const planCorrections = applyable.flatMap((r) =>
    r.result.corrections.map((c) => {
      const row = r.rows.find((x) => x.id === c.rowId);
      return {
        rowId: c.rowId,
        tenantId: r.tenantId,
        trackedCategoryId: r.trackedCategoryId,
        entryType: row.entryType,
        unitBasisDelta: c.unitBasisDelta,
        netDelta: c.netDelta,
        taxDelta: c.taxDelta,
        originalSoldAt: row.soldAt,
        periodBucket: row.periodBucket,
        // Refused if this row has moved since the dry run -- see the header's apply gate 5.
        expectedBooked: {
          qty: row.qty,
          unitBasisQty: row.unitBasisQty,
          netSales: row.netSales,
          categoryTax: row.categoryTax,
        },
      };
    }),
  );

  const report = {
    lineKeys: results.length,
    byCategory: Object.fromEntries(byCategory),
    applyableLines: applyable.length,
    applyableRowCorrections: planCorrections.length,
    moneySafeLines: moneyTouched.length,
    totalNetMoved,
    needsFilingAmendmentLines: needsFilingAmendment.length,
    unknownBasisLines: results
      .filter((r) => r.result.category === "unknown-basis")
      .map((r) => ({ lineKey: r.lineKey, reason: r.result.reason })),
    straddlingLines: results.filter((r) => r.result.category === "straddles").map((r) => r.lineKey),
  };

  return { report, corrections: planCorrections };
}

async function dryRun() {
  const url = await resolveTarget();
  console.log(`b681-correct-ledger: target ${redactUrl(url)} DRY-RUN`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const fp = await fingerprint(client);
    const { report, corrections } = await classify(client);
    await client.query("ROLLBACK");

    const plan = { generatedAt: new Date().toISOString(), fingerprint: fp, corrections };
    const hash = sha256(plan);
    const stamped = { ...plan, planHash: hash };

    const dir = resolve(REPO_ROOT, "local-assets/handoff", new Date().toISOString().slice(0, 10));
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `b681-plan-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(stamped, null, 2));

    console.log(`\nb681-correct-ledger: ${report.lineKeys} box-unaware line key(s) examined`);
    console.log("  by category:", report.byCategory);
    console.log(
      `  applyable: ${report.applyableLines} line(s), ${report.applyableRowCorrections} row correction(s)`,
    );
    console.log(
      `  money-safe: ${report.moneySafeLines} line(s), $${report.totalNetMoved.toFixed(2)} gross redistributed (nets to ~$0 per line)`,
    );
    console.log(
      `  needs filing amendment (GENERATED period, not auto-applyable): ${report.needsFilingAmendmentLines}`,
    );
    console.log(`  unknown-basis (parked): ${report.unknownBasisLines.length}`);
    console.log(`  straddling (flagged, not auto-corrected): ${report.straddlingLines.length}`);
    console.log(`\nplan: ${file}`);
    console.log(`plan hash: ${hash}`);
    if (corrections.length > 0) {
      console.log(
        `\nto apply: node ${SELF.replace(/\\/g, "/")} --apply --plan ${file.replace(/\\/g, "/")} --confirm-plan ${hash} --guard-sha <sha> --i-have-a-fresh-backup`,
      );
    }
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`b681-correct-ledger: ${e.message}`);
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function verifyGuardSha(guardSha) {
  const headSha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  try {
    execFileSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", guardSha, headSha]);
  } catch {
    throw Object.assign(
      new Error(`--guard-sha ${guardSha} is not an ancestor of this checkout's HEAD (${headSha})`),
      { refuse: true },
    );
  }
}

async function verifyLiveDeployedSha(guardSha) {
  try {
    const res = await fetch("https://routeflowapi-production.up.railway.app/api/v1/health");
    const body = await res.json();
    const liveSha = body?.commit;
    if (!liveSha) {
      console.warn(
        "b681-correct-ledger: WARN -- live health endpoint returned no commit; skipping the live-ahead check",
      );
      return;
    }
    try {
      execFileSync("git", ["-C", REPO_ROOT, "cat-file", "-e", liveSha], { stdio: "ignore" });
    } catch {
      execFileSync("git", ["-C", REPO_ROOT, "fetch", "origin", liveSha], { stdio: "ignore" });
    }
    execFileSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", guardSha, liveSha]);
  } catch (e) {
    if (e?.refuse) throw e;
    console.warn(
      `b681-correct-ledger: WARN -- could not confirm --guard-sha is at/before the live deployed commit (${e.message}); proceeding on the local ancestor check alone`,
    );
  }
}

async function apply() {
  const planFile = argOf("--plan");
  const confirmPlan = argOf("--confirm-plan");
  const guardSha = argOf("--guard-sha");
  const hasBackup = process.argv.includes("--i-have-a-fresh-backup");
  if (!planFile || !confirmPlan || !guardSha || !hasBackup) {
    console.error(
      "b681-correct-ledger: --apply needs --plan, --confirm-plan, --guard-sha, and --i-have-a-fresh-backup",
    );
    return 1;
  }
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const { planHash, ...unstamped } = plan;
  if (sha256(unstamped) !== confirmPlan || planHash !== confirmPlan) {
    console.error(
      "b681-correct-ledger: --confirm-plan does not match the plan file's own hash -- refusing",
    );
    return 1;
  }

  try {
    verifyGuardSha(guardSha);
    await verifyLiveDeployedSha(guardSha);
  } catch (e) {
    console.error(`b681-correct-ledger: ${e.message}`);
    return 1;
  }

  const url = await resolveTarget();
  console.log(
    `b681-correct-ledger: target ${redactUrl(url)} APPLY (${plan.corrections.length} row correction(s))`,
  );
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    const fp = await fingerprint(client);
    if (JSON.stringify(fp) !== JSON.stringify(plan.fingerprint)) {
      throw Object.assign(
        new Error(
          "DB fingerprint changed since the dry run (tenants, ledger max createdAt, or database differ) -- refusing",
        ),
        { refuse: true },
      );
    }

    const tenantIds = [...new Set(plan.corrections.map((c) => c.tenantId))];
    const tenantSlugs = await client.query(
      'SELECT id, slug FROM "Tenant" WHERE id = ANY($1::text[])',
      [tenantIds],
    );
    const slugById = new Map(tenantSlugs.rows.map((t) => [t.id, t.slug]));
    const liveTenants = tenantIds.filter((id) => !isTestTenant(slugById.get(id)));
    if (liveTenants.length > 0) {
      const phrase = `APPLY ${plan.corrections.length} ROWS`;
      if (!process.argv.includes("--live-tenant-override") || argOf("--confirm") !== phrase) {
        throw Object.assign(
          new Error(
            `${liveTenants.length} LIVE tenant(s) in this plan (${liveTenants.map((id) => slugById.get(id)).join(", ")}): pass --live-tenant-override --confirm "${phrase}"`,
          ),
          { refuse: true },
        );
      }
    }

    const now = new Date();
    for (const c of plan.corrections) {
      const current = await client.query(
        'SELECT qty, "unitBasisQty", "netSales", "categoryTax", "tenantId", "trackedCategoryId", "orderId", "orderItemId", "invoiceId", "invoiceItemId", "trackedSubcategoryId" FROM "RegulatedSalesLedger" WHERE id = $1',
        [c.rowId],
      );
      const row = current.rows[0];
      if (!row)
        throw Object.assign(new Error(`row ${c.rowId} no longer exists -- refusing`), {
          refuse: true,
        });
      const moved =
        Number(row.qty) !== Number(c.expectedBooked.qty) ||
        Number(row.unitBasisQty) !== Number(c.expectedBooked.unitBasisQty) ||
        Number(row.netSales) !== Number(c.expectedBooked.netSales) ||
        Number(row.categoryTax) !== Number(c.expectedBooked.categoryTax);
      if (moved) {
        throw Object.assign(
          new Error(
            `row ${c.rowId} has changed since the dry run (booked figures no longer match the plan) -- refusing`,
          ),
          { refuse: true },
        );
      }
      await client.query(
        `INSERT INTO "RegulatedSalesLedger"
           (id, "tenantId", "trackedCategoryId", "trackedSubcategoryId", "entryType",
            "orderId", "orderItemId", "invoiceId", "invoiceItemId",
            qty, "unitBasisQty", "netSales", "categoryTax",
            "soldAt", "originalSoldAt", "correctsEntryId", "periodBucket")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12, $13, $14, $15, $16)`,
        [
          randomUUID(),
          row.tenantId,
          row.trackedCategoryId,
          row.trackedSubcategoryId,
          c.entryType,
          row.orderId,
          row.orderItemId,
          row.invoiceId,
          row.invoiceItemId,
          c.unitBasisDelta,
          c.netDelta,
          c.taxDelta,
          now,
          c.originalSoldAt,
          c.rowId,
          c.periodBucket,
        ],
      );
    }
    await client.query("COMMIT");
    console.log(`b681-correct-ledger: committed ${plan.corrections.length} correction row(s)`);
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`b681-correct-ledger: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main() {
  return process.argv.includes("--apply") ? apply() : dryRun();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
