/**
 * READ-ONLY census for B894 (SA-576): how much money did the free-unit telescope over-credit?
 *
 * Before B894, a return credit (`priceMatchedChunk`) and a regulated price-correction target
 * (`priceCorrectionTarget`) priced a SLICE of an already-billed line through `prorateLineSubtotal`, whose
 * floored free-unit curve is non-monotone: on a BOGO line the slices of one line could credit MORE than the
 * line. The fix makes both callers LINEAR (`creditedThrough`). This report sizes what already happened, on lines
 * whose source invoice line has promoFreeUnits > 0:
 *
 *   1. CREDIT-NOTE LINES: inline-return rows priced off a SOURCE_INVOICE line (ReturnItem.priceSource =
 *      'SOURCE_INVOICE', return not CANCELLED). For each: how many, and one aggregate
 *      Σ(credited − linear), where `credited` is what was booked and `linear` is what the fixed code prices the
 *      same slice at (same discount share). Split by size 1 (selling-unit line) vs size > 1 (box-split line).
 *   2. REGULATED CORRECTIONS: price-change correction rows (RegulatedSalesLedger.correctsEntryId set, qty 0,
 *      no returnId) on lines with promoFreeUnits > 0: a count, split the same way.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   railway run --service postgres node apps/api/scripts/report-b894-prorate-counts.mjs
 *   ... add --per-tenant for anonymous per-tenant lines (labels A, B, ...; never a slug or id).
 *   node apps/api/scripts/report-b894-prorate-counts.mjs --self-test   (no database)
 *
 * WHICH DATABASE: the shared report resolver (scripts/lib/report-db-url.mjs, B768): the Railway proxy variables
 * win, and the target is printed (password redacted, on stderr) before anything is read.
 *
 * WHAT IT PRINTS: aggregates only. No tenant slug, name or id, no return / invoice / product id. Live and
 * approved-test tenants are reported as two blocks of totals. Remediation of an issued credit note is a
 * separate per-tenant owner decision: this script never writes and never proposes an update.
 *
 * SAFETY: one `BEGIN; SET TRANSACTION READ ONLY` transaction (plus `default_transaction_read_only = on`), a
 * statement timeout, and SELECTs only.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { prorateLineSubtotal, creditedThrough, roundMoney } = require("@routeflow/pricing");

const NAME = "report-b894-prorate-counts";
const num = (v) => (v == null ? 0 : Number(v));

/** The line's free-unit axis size: box-split lines count a free unit in boxes, every other line in its own unit. */
export function freeUnitSize(row) {
  return row.lineBoxes != null ? num(row.lineUnitsPerBox) || 1 : 1;
}

/**
 * Re-derive one inline-return chunk exactly as `priceMatchedChunk` does, under BOTH slice rules.
 * `row` (all numbers or numeric strings): pieces (the chunk, ReturnItem.qty), credited (ReturnItem.subtotal, the
 * booked credit), lineQty, lineSubtotal, lineBoxes (null on a selling-unit line), lineUnitsPerBox, freeUnits,
 * invoiceSubtotal, invoiceDiscount.
 * @returns { size, old, linear, credited, overCredit }  (money in dollars, rounded to cents)
 */
export function evaluateChunk(row) {
  const upb = num(row.lineUnitsPerBox);
  const boxSplit = row.lineBoxes != null;
  const pieces = num(row.pieces);
  const axis = boxSplit ? pieces : upb > 1 ? pieces / upb : pieces;
  const size = freeUnitSize(row);
  const S = num(row.lineSubtotal);
  const priced = (prorated) => {
    const share = S > 0 ? prorated / S : 0;
    const lineDiscount =
      num(row.invoiceSubtotal) > 0
        ? roundMoney((num(row.invoiceDiscount) * S) / num(row.invoiceSubtotal))
        : 0;
    return roundMoney(prorated - roundMoney(lineDiscount * share));
  };
  const old = priced(prorateLineSubtotal(S, axis, num(row.lineQty), num(row.freeUnits), size));
  const linear = priced(creditedThrough(S, axis, num(row.lineQty)));
  const credited = num(row.credited);
  return { size, old, linear, credited, overCredit: roundMoney(credited - linear) };
}

const emptyBucket = () => ({ lines: 0, dollars: 0, unreconciled: 0 });

/** Aggregate evaluated chunks into totals split by size. `rows` are evaluateChunk inputs + kind flags. */
export function summarizeCredits(rows) {
  const out = {
    size1: emptyBucket(),
    sizeGt1: emptyBucket(),
    danglingSources: 0,
    freeUnitLines: 0,
  };
  for (const r of rows) {
    if (r.dangling) {
      out.danglingSources++;
      continue;
    }
    if (!(num(r.freeUnits) > 0)) continue;
    const e = evaluateChunk(r);
    const b = e.size > 1 ? out.sizeGt1 : out.size1;
    b.lines++;
    b.dollars = roundMoney(b.dollars + e.overCredit);
    // the recomputed OLD price should equal what was booked; a mismatch means a manual override or a later edit
    if (Math.abs(e.old - e.credited) > 0.01) b.unreconciled++;
    out.freeUnitLines++;
  }
  return out;
}

/** Anonymous per-tenant labels A, B, ... in first-seen order (never a slug or id). */
export function anonymize(tenantIds) {
  const label = new Map();
  for (const id of tenantIds)
    if (!label.has(id)) {
      const n = label.size;
      label.set(
        id,
        `tenant ${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ""}`,
      );
    }
  return label;
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  // size 1, BOGO: P=2, F=1, S=10 — returning 1 piece credited the FULL S under the telescope (2S over two slices)
  const bogo = {
    pieces: 1,
    credited: 10,
    lineQty: 2,
    lineSubtotal: 10,
    lineBoxes: null,
    lineUnitsPerBox: null,
    freeUnits: 1,
    invoiceSubtotal: 10,
    invoiceDiscount: 0,
  };
  const e1 = evaluateChunk(bogo);
  eq([e1.size, e1.old, e1.linear, e1.overCredit], [1, 10, 5, 5], "size-1 BOGO slice");
  // size 4: S=24, 20 pcs, 2 free boxes — 9 pieces credited 18.00, linear is 10.80
  const box = {
    pieces: 9,
    credited: 18,
    lineQty: 20,
    lineSubtotal: 24,
    lineBoxes: 5,
    lineUnitsPerBox: 4,
    freeUnits: 2,
    invoiceSubtotal: 24,
    invoiceDiscount: 0,
  };
  const e4 = evaluateChunk(box);
  eq([e4.size, e4.old, e4.linear, e4.overCredit], [4, 18, 10.8, 7.2], "size-4 slice");
  // a discount share applies the same way to both rules
  const disc = evaluateChunk({ ...bogo, invoiceDiscount: 2 });
  eq([disc.old, disc.linear], [8, 4], "discount share");
  const s = summarizeCredits([
    bogo,
    box,
    { ...bogo, freeUnits: 0 }, // not a free-unit line: not counted
    { ...box, dangling: true }, // the source line is gone: only counted as dangling
  ]);
  eq(
    [s.size1.lines, s.size1.dollars, s.sizeGt1.lines, s.sizeGt1.dollars],
    [1, 5, 1, 7.2],
    "summary",
  );
  eq([s.danglingSources, s.freeUnitLines], [1, 2], "summary counters");
  eq(
    s.size1.unreconciled + s.sizeGt1.unreconciled,
    0,
    "recomputed old price equals the booked credit",
  );
  // a price-change correction counts; a B681 unit-basis restatement row (qty 0, net 0, tax 0, unitBasisQty != 0) does not
  const priceRow = {
    qty: 0,
    netSales: -3.2,
    categoryTax: 0,
    unitBasisQty: 0,
    returnId: null,
    lineBoxes: 5,
    lineUnitsPerBox: 4,
  };
  const b681Row = {
    qty: 0,
    netSales: 0,
    categoryTax: 0,
    unitBasisQty: -12,
    returnId: null,
    lineBoxes: 5,
    lineUnitsPerBox: 4,
  };
  const taxOnly = { ...priceRow, netSales: 0, categoryTax: 1.5 };
  eq(
    [isPriceCorrectionRow(priceRow), isPriceCorrectionRow(b681Row), isPriceCorrectionRow(taxOnly)],
    [true, false, true],
    "correction predicate",
  );
  eq(
    isPriceCorrectionRow({ ...priceRow, returnId: "r1" }),
    false,
    "a return-driven row is not a price correction",
  );
  const blk = blockOf([], [priceRow, b681Row, taxOnly, { ...priceRow, lineBoxes: null }]);
  eq(
    [blk.corrections.size1, blk.corrections.sizeGt1],
    [1, 2],
    "B681 row excluded from the correction counts",
  );
  eq([...anonymize(["x", "y", "x"]).values()], ["tenant A", "tenant B"], "labels");
  if (JSON.stringify(s).match(/tenant|slug|id"/)) throw new Error("summary leaked an identifier");
  return "self-test ok";
}

const CREDIT_SQL = `
  SELECT ri."tenantId", t.slug,
         ri.qty       AS pieces,
         ri.subtotal  AS credited,
         ii.qty       AS "lineQty",
         ii.subtotal  AS "lineSubtotal",
         ii.boxes     AS "lineBoxes",
         ii."unitsPerBox" AS "lineUnitsPerBox",
         ii."promoFreeUnits" AS "freeUnits",
         inv.subtotal AS "invoiceSubtotal",
         inv.discount AS "invoiceDiscount",
         (ii.id IS NULL) AS dangling
    FROM "ReturnItem" ri
    JOIN "Return" r ON r.id = ri."returnId"
    JOIN "Tenant" t ON t.id = ri."tenantId"
    LEFT JOIN "InvoiceItem" ii ON ii.id = ri."sourceInvoiceItemId"
    LEFT JOIN "Invoice" inv ON inv.id = ii."invoiceId"
   WHERE ri."priceSource" = 'SOURCE_INVOICE'
     AND r.status <> 'CANCELLED'
     AND ri.subtotal IS NOT NULL`;

const CORRECTION_SQL = `
  SELECT rl."tenantId", t.slug,
         rl.qty AS qty, rl."netSales" AS "netSales", rl."categoryTax" AS "categoryTax",
         rl."unitBasisQty" AS "unitBasisQty", rl."returnId" AS "returnId",
         ii.boxes AS "lineBoxes", ii."unitsPerBox" AS "lineUnitsPerBox"
    FROM "RegulatedSalesLedger" rl
    JOIN "Tenant" t ON t.id = rl."tenantId"
    JOIN "InvoiceItem" ii ON ii.id = rl."invoiceItemId"
   WHERE rl."correctsEntryId" IS NOT NULL
     AND rl.qty = 0
     AND rl."returnId" IS NULL
     AND (rl."netSales" <> 0 OR rl."categoryTax" <> 0)
     AND ii."promoFreeUnits" > 0`;

/**
 * A price-change correction row (`correctSaleForPriceChange`): a correction of a SALE (qty 0, no returnId) that
 * carries a NET or CATEGORY-TAX delta. B681 unit-basis restatement rows share the correctsEntryId / qty 0 shape
 * but move only unitBasisQty (netSales 0, categoryTax 0); `priceCorrectionTarget` never priced them.
 * Mirrors the WHERE clause of CORRECTION_SQL.
 */
export function isPriceCorrectionRow(r) {
  return (
    num(r.qty) === 0 && r.returnId == null && (num(r.netSales) !== 0 || num(r.categoryTax) !== 0)
  );
}

/** Totals for one block (live or test) from the credit rows and the correction rows. */
export function blockOf(creditRows, correctionRows) {
  const credits = summarizeCredits(creditRows);
  const corr = { size1: 0, sizeGt1: 0 };
  for (const c of correctionRows.filter(isPriceCorrectionRow))
    freeUnitSize(c) > 1 ? corr.sizeGt1++ : corr.size1++;
  return { credits, corrections: corr };
}

function printBlock(name, b) {
  const c = b.credits;
  console.log(`${name}:`);
  console.log(
    `  credit-note lines on promoFreeUnits > 0 lines: ${c.freeUnitLines}` +
      ` (size 1: ${c.size1.lines}, size > 1: ${c.sizeGt1.lines}); ${c.danglingSources} with a source line no longer present`,
  );
  console.log(
    `  Σ(credited − linear): size 1 $${c.size1.dollars.toFixed(2)}, size > 1 $${c.sizeGt1.dollars.toFixed(2)}, total $${roundMoney(c.size1.dollars + c.sizeGt1.dollars).toFixed(2)}` +
      `; not reproducible from the stored line: ${c.size1.unreconciled + c.sizeGt1.unreconciled}`,
  );
  console.log(
    `  regulated price-corrections on promoFreeUnits > 0 lines: ${b.corrections.size1 + b.corrections.sizeGt1} (size 1: ${b.corrections.size1}, size > 1: ${b.corrections.sizeGt1})`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const known = new Set(["--per-tenant", "--json", "--self-test"]);
  for (const a of argv)
    if (a.startsWith("--") && !known.has(a)) {
      console.error(`${NAME}: unknown argument ${a}`);
      process.exit(2);
    } else if (!a.startsWith("--")) {
      console.error(`${NAME}: unexpected argument ${a}`);
      process.exit(2);
    }
  const perTenant = argv.includes("--per-tenant");
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const { rows: credits } = await client.query(CREDIT_SQL);
    const { rows: corrections } = await client.query(CORRECTION_SQL);
    await client.query("ROLLBACK");

    const split = (rows, live) => rows.filter((r) => isTestTenant(r.slug) !== live);
    const report = {
      scanned: { creditRows: credits.length, correctionRows: corrections.length },
      live: blockOf(split(credits, true), split(corrections, true)),
      test: blockOf(split(credits, false), split(corrections, false)),
    };
    if (perTenant) {
      const labels = anonymize([...credits, ...corrections].map((r) => r.tenantId));
      report.perTenant = [...labels.entries()].map(([id, label]) => ({
        tenant: label,
        ...blockOf(
          credits.filter((r) => r.tenantId === id),
          corrections.filter((r) => r.tenantId === id),
        ),
      }));
    }
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `${NAME}: scanned ${report.scanned.creditRows} inline-return credit row(s), ${report.scanned.correctionRows} price-correction row(s) on free-unit lines`,
    );
    printBlock("live tenants", report.live);
    printBlock("approved test tenants", report.test);
    for (const t of report.perTenant ?? []) printBlock(t.tenant, t);
  } finally {
    await client.end().catch(() => {});
  }
}

/** True when this module is the process entry point (not imported by a spec). */
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
  return (
    norm(entry) === norm(self) || basename(entry).toLowerCase() === basename(self).toLowerCase()
  );
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
