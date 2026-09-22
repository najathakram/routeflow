// B681 -- retroactive correction of box-axis-mis-booked RegulatedSalesLedger rows (SA-058 through
// SA-076a, Senior Architect ruling 2026-09-22). The money-critical decision logic
// (`computeLineCorrection`, `deriveLinePack`) lives in `@routeflow/pricing` -- this script is the
// DB-facing wrapper: read rows and evidence, call it, write exactly what it returns.
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
//   2. The pricing dist stamp (packages/pricing/dist/build-info.json, via
//      scripts/lib/assert-pricing-dist-fresh.mjs) must still match what the PLAN recorded -- the
//      code that computes deltas must be the code that planned them, not a rebuilt/edited dist
//      since (SA-076a Ruling 1).
//   3. --guard-sha must be a git ancestor of this checkout's HEAD, and (REFUSES, not warns, on a
//      provable "not an ancestor" -- SA-076a confirms FIX 3a: `git merge-base --is-ancestor` exits
//      1 exactly for that case) of the live deployed API's own commit (GET /health). A warn (never
//      a refusal) is reserved ONLY for the network stage -- the health endpoint or `git fetch`
//      being unreachable, which proves nothing either way. `--local` skips the live-deploy check
//      entirely (the compose DB is not production).
//   4. Every row's evidence hash (SA-076a Ruling 2 -- the ledger row, its line's shape, the pack
//      source-candidate set, productPackNow, and any return evidence) is re-derived AFTER that
//      row's FOR UPDATE lock and compared to the plan's own recorded hash -- refuses on ANY drift
//      (a backfilled split, a changed sibling InvoiceItem, a corrected ReturnItem, and so on).
//   5. FOR UPDATE locks every row on the plan's OWN affected line keys (not the whole ledger --
//      SA-076 FIX 3b) and refuses if any of them has `createdAt` after the plan's own
//      `generatedAt` (new activity on a line this plan touches, since the dry run).
//   6. No row in the plan may already have a correction pointing at it (`correctsEntryId` --
//      SA-076a's explicit refusal in place of a DB-enforced unique index, which is a follow-up
//      with its own migration).
//   7. Any LIVE (non-test) tenant in the plan needs --live-tenant-override plus a literal
//      --confirm "APPLY <n> ROWS" phrase (t6-stamp-null-rows.mjs's own convention).
//   8. --i-have-a-fresh-backup is required unconditionally, on every apply, test tenants included.
// One transaction, 120s statement timeout. Every row is re-read and compared against the plan's
// own recorded booked figures before writing -- refuses whole if any row moved since the dry run.
//
// Exit: 0 ok (dry-run printed / apply committed) · 1 refused (nothing written) · 2 env/connection error.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { computeLineCorrection } from "@routeflow/pricing";
import { assertPricingDistFresh } from "../../../scripts/lib/assert-pricing-dist-fresh.mjs";
import { isTestTenant } from "../../../scripts/lib/test-tenants.cjs";
import { isLocalDbTarget } from "./lib/local-db-target.cjs";
import { redactUrl, resolveDatabaseUrl } from "./lib/railway-db-url.mjs";
import {
  BOX_UNAWARE_ROWS_SQL,
  EXISTING_CORRECTION_SQL,
  EXISTING_PARKED_REVERSAL_SQL,
  LINE_ROWS_BY_KEY_FOR_UPDATE_SQL,
  assertRequiredColumns,
  buildLineContexts,
  computeRowEvidenceHash,
  pickSourceLine,
  rowEvidence,
} from "./lib/b681-ledger-query.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PRICING_ROOT = resolve(REPO_ROOT, "packages/pricing");
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), "b681-correct-ledger.mjs");
const LIVE_HEALTH_URL = "https://routeflowapi-production.up.railway.app/api/v1/health";

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

function resolveTarget() {
  const local = process.argv.includes("--local");
  const url = local ? process.env.DATABASE_URL : resolveDatabaseUrl(process.env);
  if (!url) throw new Error("--local requires DATABASE_URL");
  if (local && !isLocalDbTarget(url)) {
    throw new Error(`--local refuses a non-local host (${redactUrl(url)})`);
  }
  return { url, local };
}

/** Attaches every REVERSAL row's `returnEvidence` (undefined when not return-driven) for
 *  `computeLineCorrection`, using the already-built line contexts. */
function withReturnEvidence(entry, contexts) {
  return entry.rows.map((r) => {
    if (r.entryType !== "REVERSAL" || !r.returnId) return r;
    const { returnEvidence } = rowEvidence(entry, r, contexts);
    return { ...r, returnEvidence };
  });
}

/** Classifies every box-unaware line, returns `{ report, corrections, parkedReversals }` --
 *  READ ONLY, no writes. `client` must already be inside a transaction (dry-run: READ ONLY;
 *  apply's scoped re-verification calls the pieces of this directly instead -- see `apply()`). */
export async function classify(client) {
  await assertRequiredColumns(client);
  const flat = (await client.query(BOX_UNAWARE_ROWS_SQL)).rows;
  const contexts = await buildLineContexts(client, flat);

  const results = [];
  for (const entry of contexts.lines.values()) {
    const { source: sourceLine } = pickSourceLine(
      contexts.candidatesByOrderItem,
      entry.orderItemId,
    );
    const rowsWithEvidence = withReturnEvidence(entry, contexts);
    const priorCorrections = entry.rows
      .filter((r) => r.entryType === "SALE")
      .flatMap((r) => contexts.priorByCorrectedRow.get(r.id) ?? []);
    const result = computeLineCorrection(
      rowsWithEvidence,
      entry.line,
      sourceLine,
      entry.productPackNow,
      priorCorrections,
    );
    results.push({ ...entry, result });
  }

  const byCategory = new Map();
  for (const r of results)
    byCategory.set(r.result.category, (byCategory.get(r.result.category) ?? 0) + 1);

  const eligible = results.filter(
    (r) =>
      !r.inGeneratedFiling &&
      (r.result.corrections.length > 0 || r.result.parkedReversals.length > 0),
  );
  const needsFilingAmendment = results.filter(
    (r) =>
      r.inGeneratedFiling &&
      (r.result.corrections.length > 0 || r.result.parkedReversals.length > 0),
  );
  const applyable = eligible.filter((r) => r.result.corrections.length > 0);
  const moneyTouched = applyable.filter((r) => r.result.moneySafe);
  // Gross figure -- corrections are a redistribution (they net to ~0 per line by construction,
  // see b681-correction.ts's header), not new money created or destroyed.
  const totalNetMoved = round2(
    moneyTouched.reduce(
      (s, r) => s + r.result.corrections.reduce((s2, c) => s2 + Math.abs(c.netDelta), 0),
      0,
    ),
  );

  const corrections = eligible.flatMap((r) =>
    r.result.corrections.map((c) => {
      const row = r.rows.find((x) => x.id === c.rowId);
      const { hashInputs } = rowEvidence(r, row, contexts);
      return {
        rowId: c.rowId,
        lineKey: r.lineKey,
        tenantId: r.tenantId,
        trackedCategoryId: r.trackedCategoryId,
        entryType: row.entryType,
        qtyDelta: c.qtyDelta,
        unitBasisDelta: c.unitBasisDelta,
        netDelta: c.netDelta,
        taxDelta: c.taxDelta,
        originalSoldAt: row.soldAt,
        periodBucket: row.periodBucket,
        evidenceHash: computeRowEvidenceHash(hashInputs),
        expectedBooked: {
          qty: row.qty,
          unitBasisQty: row.unitBasisQty,
          netSales: row.netSales,
          categoryTax: row.categoryTax,
        },
      };
    }),
  );

  const parkedReversals = eligible.flatMap((r) =>
    r.result.parkedReversals.map((pr) => ({
      lineKey: r.lineKey,
      tenantId: r.tenantId,
      orderId: r.orderId,
      orderItemId: r.orderItemId,
      saleEntryId: r.rows.find((x) => x.entryType === "SALE")?.id ?? null,
      reversalRowId: pr.reversalRowId,
      returnId: pr.returnId,
      reason: pr.reason,
      bookedShare: pr.bookedShare,
      periodBucket: r.rows.find((x) => x.id === pr.reversalRowId)?.periodBucket ?? null,
    })),
  );

  const report = {
    lineKeys: results.length,
    byCategory: Object.fromEntries(byCategory),
    applyableLines: applyable.length,
    applyableRowCorrections: corrections.length,
    moneySafeLines: moneyTouched.length,
    totalNetMoved,
    parkedReversalCount: parkedReversals.length,
    needsFilingAmendmentLines: needsFilingAmendment.length,
    unknownBasisLines: results
      .filter((r) => r.result.category === "unknown-basis")
      .map((r) => ({ lineKey: r.lineKey, reason: r.result.reason })),
    straddlingLines: results.filter((r) => r.result.category === "straddles").map((r) => r.lineKey),
  };

  return { report, corrections, parkedReversals };
}

async function dryRun() {
  try {
    const pricingStamp = assertPricingDistFresh(PRICING_ROOT); // before the first read, always.
    const { url } = resolveTarget();
    console.log(`b681-correct-ledger: target ${redactUrl(url)} DRY-RUN`);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await dryRunInner(client, pricingStamp);
    } finally {
      await client.end().catch(() => undefined);
    }
  } catch (e) {
    console.error(`b681-correct-ledger: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  }
}

async function dryRunInner(client, pricingStamp) {
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    const fp = await fingerprint(client);
    const { report, corrections, parkedReversals } = await classify(client);
    await client.query("ROLLBACK");

    const plan = {
      generatedAt: new Date().toISOString(),
      fingerprint: fp,
      pricingDistStamp: pricingStamp.srcHash,
      corrections,
      parkedReversals,
    };
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
      `  parked reversals (RegulatedLedgerParkedReversal rows to write): ${report.parkedReversalCount}`,
    );
    console.log(
      `  needs filing amendment (GENERATED period, not auto-applyable): ${report.needsFilingAmendmentLines}`,
    );
    console.log(`  unknown-basis (parked): ${report.unknownBasisLines.length}`);
    console.log(`  straddling (flagged, not auto-corrected): ${report.straddlingLines.length}`);
    console.log(`\nplan: ${file}`);
    console.log(`plan hash: ${hash}`);
    if (corrections.length > 0 || parkedReversals.length > 0) {
      console.log(
        `\nto apply: node ${SELF.replace(/\\/g, "/")} --apply --plan ${file.replace(/\\/g, "/")} --confirm-plan ${hash} --guard-sha <sha> --i-have-a-fresh-backup`,
      );
    }
    return 0;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  }
}

export async function fingerprint(client) {
  const [db, tenants] = await Promise.all([
    client.query("SELECT current_database() AS db"),
    client.query('SELECT id, slug FROM "Tenant" ORDER BY id'),
  ]);
  return { database: db.rows[0].db, tenantIds: tenants.rows.map((t) => t.id) };
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

/** SA-076a / second-reviewer FIX 3a. A warn (never a refusal) is reserved ONLY for the network
 *  stage (the health endpoint, or `git fetch`, being unreachable) -- that proves nothing either
 *  way. Once the live commit is actually resolved, `git merge-base --is-ancestor` is the
 *  DEFINITIVE answer and its failure (exit 1 = provably not an ancestor, or any other exit = the
 *  question could not be answered) always REFUSES -- a stale-or-undetermined production deploy
 *  and a dropped connection must never look the same to the caller. */
async function verifyLiveDeployedSha(guardSha) {
  let liveSha;
  try {
    const res = await fetch(LIVE_HEALTH_URL);
    const body = await res.json();
    liveSha = body?.commit;
  } catch (e) {
    console.warn(
      `b681-correct-ledger: WARN -- could not reach the live health endpoint (${e.message}); the guard-sha's ancestry against the live deploy could not be confirmed`,
    );
    return;
  }
  if (!liveSha) {
    console.warn(
      "b681-correct-ledger: WARN -- live health endpoint returned no commit; skipping the live-ahead check",
    );
    return;
  }
  try {
    execFileSync("git", ["-C", REPO_ROOT, "cat-file", "-e", liveSha], { stdio: "ignore" });
  } catch {
    try {
      execFileSync("git", ["-C", REPO_ROOT, "fetch", "origin", liveSha], { stdio: "ignore" });
    } catch (e) {
      console.warn(
        `b681-correct-ledger: WARN -- could not fetch the live deployed commit ${liveSha} (${e.message}); ancestry not confirmed`,
      );
      return;
    }
  }
  try {
    execFileSync("git", ["-C", REPO_ROOT, "merge-base", "--is-ancestor", guardSha, liveSha]);
  } catch (e) {
    throw Object.assign(
      new Error(
        `--guard-sha ${guardSha} is not provably at or before the live deployed commit ${liveSha} (git merge-base exited ${e.status})`,
      ),
      { refuse: true },
    );
  }
}

async function apply() {
  try {
    const pricingStamp = assertPricingDistFresh(PRICING_ROOT); // before the first read, always.
    const planFile = argOf("--plan");
    const confirmPlan = argOf("--confirm-plan");
    const guardSha = argOf("--guard-sha");
    const hasBackup = process.argv.includes("--i-have-a-fresh-backup");
    if (!planFile || !confirmPlan || !guardSha || !hasBackup) {
      throw Object.assign(
        new Error("--apply needs --plan, --confirm-plan, --guard-sha, and --i-have-a-fresh-backup"),
        { refuse: true },
      );
    }
    const plan = JSON.parse(readFileSync(planFile, "utf8"));
    const { planHash, ...unstamped } = plan;
    if (sha256(unstamped) !== confirmPlan || planHash !== confirmPlan) {
      throw Object.assign(
        new Error("--confirm-plan does not match the plan file's own hash -- refusing"),
        { refuse: true },
      );
    }
    if (plan.pricingDistStamp !== pricingStamp.srcHash) {
      throw Object.assign(
        new Error(
          `pricing dist has changed since the plan was generated (plan stamp ${plan.pricingDistStamp.slice(0, 12)}, current ${pricingStamp.srcHash.slice(0, 12)}) -- the code that would compute these deltas is not the code that planned them; refusing`,
        ),
        { refuse: true },
      );
    }

    const { url, local } = resolveTarget();
    verifyGuardSha(guardSha);
    if (!local) await verifyLiveDeployedSha(guardSha);

    console.log(
      `b681-correct-ledger: target ${redactUrl(url)} APPLY (${plan.corrections.length} row correction(s), ${plan.parkedReversals.length} parked reversal(s))`,
    );
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '120s'");
      await assertRequiredColumns(client);

      const fp = await fingerprint(client);
      if (JSON.stringify(fp) !== JSON.stringify(plan.fingerprint)) {
        throw Object.assign(
          new Error(
            "DB fingerprint changed since the dry run (database or tenant list differ) -- refusing",
          ),
          { refuse: true },
        );
      }

      const allRowIds = [
        ...new Set([
          ...plan.corrections.map((c) => c.rowId),
          ...plan.parkedReversals.map((p) => p.reversalRowId),
        ]),
      ];
      if (allRowIds.length === 0) {
        throw Object.assign(
          new Error("plan has no corrections and no parked reversals -- nothing to apply"),
          {
            refuse: true,
          },
        );
      }

      const existing = await client.query(EXISTING_CORRECTION_SQL, [
        plan.corrections.map((c) => c.rowId),
      ]);
      if (existing.rows.length > 0) {
        throw Object.assign(
          new Error(
            `${existing.rows.length} row(s) in this plan already have a correction pointing at them -- this plan (or a later one) was already applied; refusing`,
          ),
          { refuse: true },
        );
      }
      if (plan.parkedReversals.length > 0) {
        const existingParked = await client.query(EXISTING_PARKED_REVERSAL_SQL, [
          plan.parkedReversals.map((p) => p.returnId),
          plan.parkedReversals.map((p) => p.saleEntryId),
        ]);
        if (existingParked.rows.length > 0) {
          throw Object.assign(
            new Error(
              `${existingParked.rows.length} parked-reversal row(s) in this plan already exist -- this plan (or a later one) was already applied; refusing`,
            ),
            { refuse: true },
          );
        }
      }

      // FIX 3b: concurrency scoped to the PLAN's own affected line keys, FOR UPDATE, never the
      // whole ledger table.
      const lineKeys = [
        ...new Set([...plan.corrections, ...plan.parkedReversals].map((c) => c.lineKey)),
      ];
      const scoped = (await client.query(LINE_ROWS_BY_KEY_FOR_UPDATE_SQL, [lineKeys])).rows;
      const stale = scoped.filter((r) => new Date(r.createdAt).toISOString() > plan.generatedAt);
      if (stale.length > 0) {
        throw Object.assign(
          new Error(
            `${stale.length} row(s) on this plan's own line key(s) were created after the dry run (${plan.generatedAt}) -- new activity on an affected line since the plan was built; refusing`,
          ),
          { refuse: true },
        );
      }
      const scopedContexts = await buildLineContexts(client, scoped);

      // Re-derive and compare every planned row's evidence hash -- AFTER the FOR UPDATE lock.
      for (const c of [...plan.corrections]) {
        const entry = scopedContexts.lines.get(c.lineKey);
        const row = entry?.rows.find((r) => r.id === c.rowId);
        if (!entry || !row) {
          throw Object.assign(
            new Error(`row ${c.rowId} (line ${c.lineKey}) no longer exists -- refusing`),
            {
              refuse: true,
            },
          );
        }
        const { hashInputs } = rowEvidence(entry, row, scopedContexts);
        const freshHash = computeRowEvidenceHash(hashInputs);
        if (freshHash !== c.evidenceHash) {
          throw Object.assign(
            new Error(
              `evidence for row ${c.rowId} has changed since the dry run (plan hash ${c.evidenceHash.slice(0, 12)}, now ${freshHash.slice(0, 12)}) -- refusing`,
            ),
            { refuse: true },
          );
        }
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
      }

      const tenantIds = [
        ...new Set([
          ...plan.corrections.map((c) => c.tenantId),
          ...plan.parkedReversals.map((p) => p.tenantId),
        ]),
      ];
      const tenantSlugs = await client.query(
        'SELECT id, slug FROM "Tenant" WHERE id = ANY($1::text[])',
        [tenantIds],
      );
      const slugById = new Map(tenantSlugs.rows.map((t) => [t.id, t.slug]));
      const liveTenants = tenantIds.filter((id) => !isTestTenant(slugById.get(id)));
      const totalRows = plan.corrections.length + plan.parkedReversals.length;
      if (liveTenants.length > 0) {
        const phrase = `APPLY ${totalRows} ROWS`;
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
        await client.query(
          `INSERT INTO "RegulatedSalesLedger"
             (id, "tenantId", "trackedCategoryId", "trackedSubcategoryId", "entryType",
              "orderId", "orderItemId", "invoiceId", "invoiceItemId",
              qty, "unitBasisQty", "netSales", "categoryTax",
              "soldAt", "originalSoldAt", "correctsEntryId", "periodBucket", "createdAt")
           SELECT $1, "tenantId", "trackedCategoryId", "trackedSubcategoryId", $2,
                  "orderId", "orderItemId", "invoiceId", "invoiceItemId",
                  $3, $4, $5, $6, $7, "soldAt", $8, "periodBucket", $7
           FROM "RegulatedSalesLedger" WHERE id = $8`,
          [
            randomUUID(),
            c.entryType,
            c.qtyDelta,
            c.unitBasisDelta,
            c.netDelta,
            c.taxDelta,
            now,
            c.rowId,
          ],
        );
      }
      for (const p of plan.parkedReversals) {
        await client.query(
          `INSERT INTO "RegulatedLedgerParkedReversal"
             (id, "tenantId", "returnId", "orderId", "orderItemId", "saleEntryId",
              "returnedPieces", reason, "periodBucket", "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            p.tenantId,
            p.returnId,
            p.orderId,
            p.orderItemId,
            p.saleEntryId,
            p.bookedShare,
            p.reason,
            p.periodBucket,
            now,
          ],
        );
      }
      await client.query("COMMIT");
      console.log(
        `b681-correct-ledger: committed ${plan.corrections.length} correction row(s), ${plan.parkedReversals.length} parked reversal(s)`,
      );
      return 0;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      await client.end().catch(() => undefined);
    }
  } catch (e) {
    console.error(`b681-correct-ledger: ${e.message}${e.refuse ? " -- nothing was written" : ""}`);
    return e.refuse ? 1 : 2;
  }
}

async function main() {
  return process.argv.includes("--apply") ? apply() : dryRun();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
