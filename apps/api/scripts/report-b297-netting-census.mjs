/**
 * READ-ONLY census for SA-819 MUST 3 (row 632, B297 PR4a): would the first re-sync after deploy re-file history?
 *
 * Master's INVOICE_BILLED re-sync (`reverseInvoiceEntries`, preserveReturns) nets each invoice line on
 * `invoiceItemId` alone and reverses that net under the line's FIRST SALE row's category / subcategory. PR4a's
 * `syncInvoiceEntries` nets with `netHeldByLine(all, { preserveReturns: true, keyOf: syncKey })`, i.e. per
 * `invoiceItemId | trackedCategoryId | trackedSubcategoryId | orderItemId`. Both then book the same target lines,
 * so the two leave the same filing iff the held net they reverse agrees per (invoice, category) and per
 * (invoice, category, subcategory). This script recomputes both nettings over the existing ledger rows and counts
 * the groups where any dimension (qty, unitBasisQty, netSales, categoryTax) differs by more than 0.0005.
 *
 * THE MISMATCH COUNT MUST BE 0 before #3726 merges (SA-819 MUST 3); a non-zero count goes to the SA.
 *
 * COUNTS ONLY: no slug, name or id is printed. Test tenants (scripts/lib/test-tenants.cjs) are counted in their
 * own block, apart from live ones.
 *
 * The two nettings are restated here because a .mjs script cannot import the TypeScript service; `--self-test`
 * pins their behaviour on the cases that matter (unchanged line, live return, prior re-sync reversal, a line
 * re-filed under another category or subcategory).
 *
 * NEVER RUN AGAINST PRODUCTION FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-b297-netting-census.mjs [--json]
 *
 * SAFETY: `default_transaction_read_only = on` before any other query, the one SELECT runs inside
 * BEGIN READ ONLY ... ROLLBACK, `statement_timeout` and `lock_timeout` cap it, the connection is closed in
 * `finally`, and only SELECT appears below.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const EPS = 0.0005;
const DIMS = ["qty", "unitBasisQty", "netSales", "categoryTax"];

const isReturnOrCredit = (r) =>
  r.entryType === "REVERSAL" && (r.returnId != null || r.creditNoteId != null);
const zero = () => ({ qty: 0, unitBasisQty: 0, netSales: 0, categoryTax: 0 });
const addInto = (acc, r, sign = 1) => {
  for (const d of DIMS) acc[d] += sign * Number(r[d] ?? 0);
};
const isSquare = (h) => DIMS.every((d) => Math.abs(h[d]) < EPS);

/**
 * Master's held net (4f80a6b56 `reverseInvoiceEntries`, preserveReturns: true): per invoiceItemId, attributed to
 * the line's first SALE row's category / subcategory; a line with no SALE or square in every dimension reverses
 * nothing. Returns [{ invoiceId, category, subcategory, ...dims }].
 */
export function masterHeld(rows) {
  const byItem = new Map();
  for (const r of rows) {
    if (r.invoiceItemId == null) continue;
    const cur = byItem.get(r.invoiceItemId) ?? { sale: null, ...zero() };
    if (r.entryType === "SALE" && !cur.sale) cur.sale = r;
    if (!isReturnOrCredit(r)) addInto(cur, r);
    byItem.set(r.invoiceItemId, cur);
  }
  const out = [];
  for (const h of byItem.values()) {
    if (!h.sale || isSquare(h)) continue;
    out.push({
      invoiceId: h.sale.invoiceId,
      category: h.sale.trackedCategoryId ?? "",
      subcategory: h.sale.trackedSubcategoryId ?? "",
      ...Object.fromEntries(DIMS.map((d) => [d, h[d]])),
    });
  }
  return out;
}

/**
 * PR4a's held net (`netHeldByLine(all, { preserveReturns: true, keyOf: syncKey })`): per
 * invoiceItemId|category|subcategory|orderItemId, each key's own figure under its own category / subcategory.
 * A key with no SALE row, or square, holds nothing to reverse.
 */
export function pr4aHeld(rows) {
  const byKey = new Map();
  for (const r of rows) {
    if (r.invoiceItemId == null) continue;
    const key = `${r.invoiceItemId}|${r.trackedCategoryId ?? ""}|${r.trackedSubcategoryId ?? ""}|${r.orderItemId ?? ""}`;
    const cur = byKey.get(key) ?? {
      invoiceId: r.invoiceId,
      category: r.trackedCategoryId ?? "",
      subcategory: r.trackedSubcategoryId ?? "",
      hasSale: false,
      ...zero(),
    };
    if (r.entryType === "SALE") cur.hasSale = true;
    if (!isReturnOrCredit(r)) addInto(cur, r);
    byKey.set(key, cur);
  }
  const out = [];
  for (const h of byKey.values()) {
    if (!h.hasSale || isSquare(h)) continue;
    const { hasSale: _hasSale, ...rest } = h;
    out.push(rest);
  }
  return out;
}

/** Sum held rows into groups keyed by `keyOf`. */
function groupSum(held, keyOf) {
  const m = new Map();
  for (const h of held) {
    const k = keyOf(h);
    const cur = m.get(k) ?? zero();
    addInto(cur, h);
    m.set(k, cur);
  }
  return m;
}

/** Count groups where the two nettings disagree in any dimension. */
function mismatches(a, b) {
  let n = 0;
  const byDim = Object.fromEntries(DIMS.map((d) => [d, 0]));
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? zero();
    const y = b.get(k) ?? zero();
    const off = DIMS.filter((d) => Math.abs(x[d] - y[d]) >= EPS);
    if (off.length > 0) {
      n += 1;
      for (const d of off) byDim[d] += 1;
    }
  }
  return { groups: n, byDimension: byDim };
}

/** Counts for one set of ledger rows (any number of invoices). Ids are used for grouping only, never returned. */
export function censusOf(rows) {
  const byInvoice = new Map();
  for (const r of rows) {
    if (r.invoiceId == null) continue;
    byInvoice.set(r.invoiceId, [...(byInvoice.get(r.invoiceId) ?? []), r]);
  }
  let catMismatch = 0;
  let subMismatch = 0;
  let invoicesWithMismatch = 0;
  const byDimension = Object.fromEntries(DIMS.map((d) => [d, 0]));
  for (const invRows of byInvoice.values()) {
    const m = masterHeld(invRows);
    const p = pr4aHeld(invRows);
    const cat = mismatches(
      groupSum(m, (h) => h.category),
      groupSum(p, (h) => h.category),
    );
    const sub = mismatches(
      groupSum(m, (h) => `${h.category}|${h.subcategory}`),
      groupSum(p, (h) => `${h.category}|${h.subcategory}`),
    );
    catMismatch += cat.groups;
    subMismatch += sub.groups;
    for (const d of DIMS) byDimension[d] += cat.byDimension[d];
    if (cat.groups + sub.groups > 0) invoicesWithMismatch += 1;
  }
  return {
    rows: rows.length,
    invoices: byInvoice.size,
    invoicesWithMismatch,
    categoryGroupMismatches: catMismatch,
    subcategoryGroupMismatches: subMismatch,
    categoryMismatchByDimension: byDimension,
  };
}

/** { live, test } blocks: rows carry `slug` for classification only. */
export function summarize(rows) {
  return {
    live: censusOf(rows.filter((r) => !isTestTenant(r.slug))),
    test: censusOf(rows.filter((r) => isTestTenant(r.slug))),
  };
}

/** No-DB checks of the pure functions (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const row = (o) => ({
    invoiceId: "inv",
    invoiceItemId: "ii",
    trackedCategoryId: "cat",
    trackedSubcategoryId: null,
    orderItemId: "oi",
    entryType: "SALE",
    returnId: null,
    creditNoteId: null,
    qty: 10,
    unitBasisQty: 10,
    netSales: 100,
    categoryTax: 5,
    ...o,
  });
  const ret = { entryType: "REVERSAL", qty: -2, unitBasisQty: -2, netSales: -20, categoryTax: -1 };
  // 1. An unchanged line: the same held net either way.
  eq(censusOf([row({})]).categoryGroupMismatches, 0, "unchanged");
  // 2. A live return is left standing by both.
  eq(
    censusOf([row({}), row({ ...ret, returnId: "r1" })]).categoryGroupMismatches,
    0,
    "live return",
  );
  // 3. A prior re-sync's own reversal + re-book nets the same either way.
  const resync = [
    row({}),
    row({ entryType: "REVERSAL", qty: -10, unitBasisQty: -10, netSales: -100, categoryTax: -5 }),
    row({}),
  ];
  eq(censusOf(resync).categoryGroupMismatches, 0, "prior re-sync");
  // 4. A line re-filed under another category (a product swap) after a sale-only reversal: master reverses the
  //    whole net under the FIRST SALE's category; PR4a under each row's own. A mismatch, by design.
  const swapped = [
    row({}),
    row({ entryType: "REVERSAL", qty: -10, unitBasisQty: -10, netSales: -100, categoryTax: -5 }),
    row({ trackedCategoryId: "cat2" }),
  ];
  eq(censusOf(swapped).categoryGroupMismatches, 2, "category swap");
  // 5. A subcategory change shows only in the subcategory count.
  const resub = [
    row({ trackedSubcategoryId: "s1" }),
    row({
      trackedSubcategoryId: "s1",
      entryType: "REVERSAL",
      qty: -10,
      unitBasisQty: -10,
      netSales: -100,
      categoryTax: -5,
    }),
    row({ trackedSubcategoryId: "s2" }),
  ];
  const c5 = censusOf(resub);
  eq([c5.categoryGroupMismatches, c5.subcategoryGroupMismatches], [0, 2], "subcategory swap");
  // 6. Live and test rows land in their own blocks.
  const s = summarize([
    { ...row({}), slug: "acme" },
    { ...row({ invoiceId: "inv2" }), slug: "qa-smoke" },
  ]);
  eq([s.live.invoices, s.test.invoices], [1, 1], "blocks");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl("report-b297-netting-census");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '120s'");
    await client.query("SET lock_timeout = '5s'");
    await client.query("BEGIN READ ONLY");
    let rows;
    try {
      ({ rows } = await client.query(
        `SELECT t.slug, l."invoiceId", l."invoiceItemId", l."trackedCategoryId", l."trackedSubcategoryId",
                l."orderItemId", l."entryType"::text AS "entryType", l."returnId", l."creditNoteId",
                l.qty, l."unitBasisQty", l."netSales", l."categoryTax"
           FROM "RegulatedSalesLedger" l
           JOIN "Tenant" t ON t.id = l."tenantId"
          WHERE l."invoiceId" IS NOT NULL
          ORDER BY l."createdAt", l.id`,
      ));
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
    const report = summarize(rows);
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, c] of Object.entries(report)) {
        console.log(`${block}: ${c.rows} ledger row(s) on ${c.invoices} invoice(s)`);
        console.log(`  invoices with a mismatch:          ${c.invoicesWithMismatch}`);
        console.log(`  (invoice, category) mismatches:    ${c.categoryGroupMismatches}`);
        console.log(`  (invoice, subcategory) mismatches: ${c.subcategoryGroupMismatches}`);
        console.log(`  by dimension: ${JSON.stringify(c.categoryMismatchByDimension)}`);
      }
      console.log(
        "note: SA-819 MUST 3 needs 0 live mismatches before #3726 merges; non-zero goes to the SA.",
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Run only when invoked directly (see report-tenant-timezone-census.mjs for why the name fallback exists). */
export function isInvokedDirectly(entry = process.argv[1], self = fileURLToPath(import.meta.url)) {
  if (!entry) return false;
  const norm = (p) => {
    let r = p;
    try {
      r = realpathSync(p);
    } catch {
      // keep the path as given
    }
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  if (norm(entry) === norm(self)) return true;
  if (basename(entry).toLowerCase() === basename(self).toLowerCase()) {
    console.error(
      `report-b297-netting-census: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`report-b297-netting-census: ${e.message}`);
    process.exit(1);
  });
}
