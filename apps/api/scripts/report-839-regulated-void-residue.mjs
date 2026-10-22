/**
 * READ-ONLY report (SA-839 section 6, B705 / #1478 and B706 / #1479): regulated-ledger rows left standing by
 * void / unvoid / return-cancel / credit-note-void, per tenant id and per period, COUNTS only.
 *
 * Classes (per line; the period is the bucket of the line's newest void-signature REVERSAL, "filed" = a
 * GENERATED / LOCKED filing of the line's category covers it):
 *   UNVOID_UNBOOKED            the invoice is live but the line's newest ledger row is a void and its sale-record
 *                              no longer covers the line qty (B706: unvoid never re-booked)
 *   VOID_NOTE_ON_LIVE_INVOICE  a VOID credit note's REVERSAL rows still stand on a live invoice (B706 example C)
 *   VOID_RESIDUE               the invoice is VOID or gone and the line still nets to something (B705), split
 *                              RETURN_CANCELLED / NOTE_VOIDED / AXIS_ONLY / OTHER
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   railway run --service postgres node apps/api/scripts/report-839-regulated-void-residue.mjs [--json] [--tenant ID]
 *   node apps/api/scripts/report-839-regulated-void-residue.mjs --self-test   (no database)
 *
 * Protected tenants (paying, Stripe-linked or named in PROTECTED_TENANT_SLUGS, via the live-target guard) are
 * flagged PROTECTED and approved test tenants TEST. Against a non-local database PROTECTED_TENANT_SLUGS must be
 * set (use "" to state there are none), exactly as for every other script that uses the guard.
 *
 * SAFETY
 *   - The first statement is the session `default_transaction_read_only = on`, then statement / lock / idle
 *     timeouts, then BEGIN TRANSACTION READ ONLY; the report aborts unless SHOW transaction_read_only is `on`.
 *     SELECT / SHOW only; the transaction ends with ROLLBACK.
 *   - It refuses --apply, --fix and --repair (exit 2): there is no write mode. Repair is the owner's decision.
 *   - Output: tenant ids, protected / test flags and counts only. No slug, name, customer, invoice or credit-note
 *     number, amount or row id.
 * Pure logic + SQL: ./lib/report-839-regulated-void-residue.cjs (unit-tested with a mocked client).
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const lib = require("./lib/report-839-regulated-void-residue.cjs");
const { protectedTenantIds, refuseRetiredFlags } = require("./lib/live-target-guard.cjs");
const { loadProtectedSlugs } = require("./lib/protected-slugs.cjs");

const NAME = "report-839-regulated-void-residue";

/** No-DB checks of the pure part (`--self-test`). Throws on the first failure. */
export async function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`self-test ${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const row = (o) => ({
    entryType: "SALE",
    returnId: null,
    creditNoteId: null,
    correctsEntryId: null,
    qty: 0,
    unitBasisQty: 0,
    netSales: 0,
    categoryTax: 0,
    periodBucket: "2026-09",
    ...o,
  });
  const sale = row({
    id: "s",
    qty: 10,
    unitBasisQty: 10,
    netSales: 100,
    categoryTax: 20,
    createdAt: "2026-09-02T00:00:00Z",
  });
  const voided = row({
    id: "v",
    entryType: "REVERSAL",
    qty: -10,
    unitBasisQty: -10,
    netSales: -100,
    categoryTax: -20,
    periodBucket: "2026-10",
    createdAt: "2026-10-02T00:00:00Z",
  });
  const line = { qty: 10, trackedCategoryId: "c" };
  eq(
    lib.classifyLine([sale, voided], "DRAFT", {}, line),
    [{ cls: "UNVOID_UNBOOKED", bucket: "2026-10" }],
    "unvoid unbooked",
  );
  eq(lib.classifyLine([sale, voided], "VOID", {}, line), [], "void and square is clean");
  eq(lib.classifyLine([sale], "SENT", {}, line), [], "live sale is clean");
  const cancelled = lib.classifyLine(
    [sale, { ...voided, qty: -7, unitBasisQty: -7, netSales: -70, categoryTax: -14 }],
    "VOID",
    { r1: "CANCELLED" },
    line,
  );
  eq(
    cancelled,
    [{ cls: "VOID_RESIDUE", sub: "RETURN_CANCELLED", bucket: "2026-10" }],
    "return cancelled residue",
  );

  // the READ ONLY wrapper: read-only SET first, READ ONLY transaction, ROLLBACK last, abort when not read-only
  const seen = [];
  const client = {
    query: async (sql) => {
      seen.push(sql);
      if (sql === lib.SHOW_READ_ONLY) return { rows: [{ transaction_read_only: "on" }] };
      return { rows: [] };
    },
  };
  await lib.withReadOnlyTx(client, () => lib.buildReport(client, { protectedIds: new Set() }));
  eq(seen[0], "SET default_transaction_read_only = on", "read-only SET is the first statement");
  eq(
    [seen.includes(lib.BEGIN_READ_ONLY), seen.at(-1)],
    [true, "ROLLBACK"],
    "READ ONLY tx ends in ROLLBACK",
  );
  let aborted = false;
  await lib
    .withReadOnlyTx(
      {
        query: async (sql) =>
          sql === lib.SHOW_READ_ONLY ? { rows: [{ transaction_read_only: "off" }] } : { rows: [] },
      },
      async () => {},
    )
    .catch(() => (aborted = true));
  if (!aborted) throw new Error("self-test: did not abort when transaction_read_only is not on");

  // write-shaped flags are refused
  for (const f of lib.WRITE_FLAGS)
    if (lib.checkArgs([f]).ok) throw new Error(`self-test: ${f} accepted`);
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    refuseRetiredFlags(argv);
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(2);
  }
  const args = lib.checkArgs(argv);
  if (!args.ok) {
    console.error(`${NAME}: ${args.message}`);
    process.exit(2);
  }
  if (args.selfTest) {
    console.log(await selfTest());
    return;
  }

  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  let slugs;
  try {
    slugs = loadProtectedSlugs(process.env, databaseUrl);
  } catch (e) {
    console.error(`${NAME}: ${e.message}`);
    process.exit(2);
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const report = await lib.withReadOnlyTx(client, async () => {
      const protectedIds = new Set(await protectedTenantIds(client, slugs));
      return lib.buildReport(client, { protectedIds, onlyTenant: args.tenant });
    });
    const meta = {
      generatedAt: new Date().toISOString(),
      scope: args.tenant ? "one tenant" : "all tenants",
    };
    console.log(
      args.json
        ? JSON.stringify(lib.jsonReport(report, meta), null, 2)
        : lib.formatReport(report, meta),
    );
  } finally {
    await client.end().catch(() => {});
  }
}

export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return norm(entry) === norm(self) || basename(entry) === basename(self);
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
