/**
 * READ-ONLY pre-sitting checks for owner migration sitting 4 (SA-772 §4 step 5, SA-814 §3):
 *
 *   SIZING  `count(*)` of "InvoiceItem" and "RecurringInvoiceItem". Their sum picks the B296 precision folder:
 *           below WIDEN_THRESHOLD (500 000) -> variant 2a (in-place DECIMAL(9,6) widen, a table rewrite);
 *           at or above -> variant 2b (additive "lineTaxRate" columns, expand / contract).
 *   C1      tenants whose `settings.taxRate` (a PERCENT string, parsed like apps/api/src/common/tax-rate.ts
 *           taxRateFractionFrom: parseFloat, non-finite -> 0, clamp 0..100) has MORE THAN 2 decimals, by tenant
 *           class. PRODUCTION = class PRODUCTION and not soft-deleted; other = every other tenant. If C1 is 0 for
 *           PRODUCTION, B296 is latent on prod (the widen still ships; the R6 repair is skipped). `over4` counts the
 *           C1 tenants with more than 4 decimals of percent (beyond what DECIMAL(9,6) stores).
 *   C2      for the C1 tenants, "InvoiceItem" rows with "taxRate" <> 0, by invoice status family
 *           (DRAFT / ISSUED = every other non-VOID status / VOID).
 *   C3      non-VOID invoices (every tenant) whose stored "taxAmount" differs by >= $0.01 from what a recompute
 *           would give: round2(sum(subtotal * taxRate)) + round2(sum(categoryTaxAmount)), or 0 for a tax-exempt
 *           customer (the sumInvoiceTotals shape). By status, with the sum and max of |delta| in CENTS, and split by
 *           whether the invoice belongs to a C1 tenant. This is what a recompute would move; R5-2 refuses it.
 *   C4      ACTIVE "RecurringInvoice" templates of C1 tenants whose item rate equals round4(the tenant's exact
 *           fraction): they generate FUTURE invoices at the rounded rate, so non-zero means live over/under-billing.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead / owner runs it under warn-then-approve `railway run`
 * authorization, from a checkout of the bundle branch (chore/sitting4-schema-bundle), BEFORE the sitting:
 *
 *   railway run --service postgres node apps/api/scripts/report-sitting4-sizing.mjs [--json]
 *
 * Output is COUNTS ONLY: no tenant id, slug or name, no invoice, line or template id is printed (tenant ids are
 * used only as query parameters). `--self-test` runs the pure checks with no database and exits.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and `lock_timeout` cap
 * every query; every count runs inside ONE `BEGIN READ ONLY` REPEATABLE READ transaction (one snapshot) that is
 * always rolled back; the connection is closed in `finally`; only SELECT appears below.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);

const NAME = "report-sitting4-sizing";

/** SA-772 §2 folder 2: the ONE named number that picks 2a (below) or 2b (at or above). */
export const WIDEN_THRESHOLD = 500_000;

export const SIZING_SQL = `SELECT (SELECT count(*) FROM "InvoiceItem")::text AS "invoiceItem",
       (SELECT count(*) FROM "RecurringInvoiceItem")::text AS "recurringInvoiceItem"`;

/** Every tenant's stored tax-rate setting, with what the class bucket needs. No identifying column leaves JS. */
export const RATE_SETTINGS_SQL = `SELECT sc."tenantId", sc.value AS stored,
       (t.class = 'PRODUCTION' AND t."deletedAt" IS NULL) AS prod
  FROM "SystemConfig" sc
  JOIN "Tenant" t ON t.id = sc."tenantId"
 WHERE sc.key = 'settings.taxRate'`;

/** C2: rated invoice lines of the C1 tenants ($1), by status family and class bucket. */
export const C2_SQL = `SELECT CASE WHEN iv.status = 'DRAFT' THEN 'DRAFT'
                 WHEN iv.status = 'VOID' THEN 'VOID'
                 ELSE 'ISSUED' END AS family,
       (t.class = 'PRODUCTION' AND t."deletedAt" IS NULL) AS prod,
       count(*)::text AS n
  FROM "InvoiceItem" ii
  JOIN "Invoice" iv ON iv.id = ii."invoiceId"
  JOIN "Tenant" t ON t.id = iv."tenantId"
 WHERE iv."tenantId" = ANY($1::text[])
   AND ii."taxRate" <> 0
 GROUP BY 1, 2`;

/** C3: non-VOID invoices whose stored tax a recompute would move by >= 1 cent ($1 = the C1 tenant ids). */
export const C3_SQL = `WITH per AS (
  SELECT iv.status::text AS status,
         (t.class = 'PRODUCTION' AND t."deletedAt" IS NULL) AS prod,
         (iv."tenantId" = ANY($1::text[])) AS c1,
         iv."taxAmount" AS stored,
         CASE WHEN COALESCE(cu."isTaxExempt", false) THEN 0
              ELSE ROUND(COALESCE(SUM(ii.subtotal * ii."taxRate"), 0), 2)
                 + ROUND(COALESCE(SUM(ii."categoryTaxAmount"), 0), 2) END AS expected
    FROM "Invoice" iv
    LEFT JOIN "InvoiceItem" ii ON ii."invoiceId" = iv.id
    LEFT JOIN "Customer" cu ON cu.id = iv."customerId"
    LEFT JOIN "Tenant" t ON t.id = iv."tenantId"
   WHERE iv.status <> 'VOID'
   GROUP BY iv.id, iv.status, iv."taxAmount", iv."tenantId", t.class, t."deletedAt", cu."isTaxExempt"
)
SELECT status, COALESCE(prod, false) AS prod, c1,
       count(*)::text AS invoices,
       ROUND(SUM(ABS(expected - stored)) * 100)::text AS "sumAbsDeltaCents",
       ROUND(MAX(ABS(expected - stored)) * 100)::text AS "maxAbsDeltaCents"
  FROM per
 WHERE ABS(expected - stored) >= 0.01
 GROUP BY 1, 2, 3`;

/** C4: active recurring items of C1 tenants ($1 ids, $2 their exact percents) stored at round4(exact fraction). */
export const C4_SQL = `SELECT (t.class = 'PRODUCTION' AND t."deletedAt" IS NULL) AS prod,
       count(*)::text AS items,
       count(DISTINCT ri.id)::text AS templates
  FROM "RecurringInvoiceItem" rii
  JOIN "RecurringInvoice" ri ON ri.id = rii."recurringInvoiceId"
  JOIN unnest($1::text[], $2::numeric[]) AS c(tid, pct) ON c.tid = ri."tenantId"
  JOIN "Tenant" t ON t.id = ri."tenantId"
 WHERE ri."isActive" = true
   AND rii."taxRate" = ROUND(c.pct / 100, 4)
 GROUP BY 1`;

/** The stored PERCENT through the same rules as tax-rate.ts taxRateFractionFrom (before its / 100). */
export function parsePercent(stored) {
  if (stored === null || stored === undefined || stored === "") return 0;
  const pct = parseFloat(stored);
  if (!Number.isFinite(pct)) return 0;
  return Math.min(Math.max(pct, 0), 100);
}

/** Decimals of a parsed percent (8.875 -> 3, 7.0625 -> 4, 8 -> 0), immune to float noise past 10 dp. */
export function percentDecimals(pct) {
  const s = pct.toFixed(10).replace(/0+$/, "");
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Pick the B296 folder variant from the measured counts. */
export function verdict(invoiceItem, recurringInvoiceItem) {
  const total = Number(invoiceItem) + Number(recurringInvoiceItem);
  return {
    total,
    variant: total < WIDEN_THRESHOLD ? "2a" : "2b",
    folder:
      total < WIDEN_THRESHOLD
        ? "20261020090200_invoice_tax_rate_widen (in-place DECIMAL(9,6), a table rewrite)"
        : "20261020090200_invoice_line_tax_rate_expand (additive lineTaxRate, expand / contract)",
    reasonLine: `-- reason: B296 precision; measured ${total} rows; off-peak`,
  };
}

/** C1 from the setting rows: the qualifying tenant ids (query params only) plus anonymous counts by bucket. */
export function classifyRates(rows) {
  const ids = [];
  const pcts = [];
  const c1 = {
    PRODUCTION: { tenants: 0, over4: 0 },
    other: { tenants: 0, over4: 0 },
  };
  for (const r of rows) {
    const pct = parsePercent(r.stored);
    const decimals = percentDecimals(pct);
    if (pct <= 0 || decimals <= 2) continue;
    const bucket = r.prod ? c1.PRODUCTION : c1.other;
    bucket.tenants += 1;
    if (decimals > 4) bucket.over4 += 1;
    ids.push(r.tenantId);
    pcts.push(pct.toFixed(10));
  }
  return { ids, pcts, c1 };
}

const bucketOf = (prod) => (prod ? "PRODUCTION" : "other");

/** Fold the grouped query rows into anonymous nested counts. */
export function summarize({ sizing, rates, c2Rows, c3Rows, c4Rows }) {
  const widen = verdict(sizing.invoiceItem, sizing.recurringInvoiceItem);
  const c2 = {
    PRODUCTION: { DRAFT: 0, ISSUED: 0, VOID: 0 },
    other: { DRAFT: 0, ISSUED: 0, VOID: 0 },
  };
  for (const r of c2Rows) c2[bucketOf(r.prod)][r.family] += Number(r.n);
  const c3 = { PRODUCTION: {}, other: {} };
  for (const r of c3Rows) {
    const b = c3[bucketOf(r.prod)];
    const s = (b[r.status] ??= {
      invoices: 0,
      c1Invoices: 0,
      sumAbsDeltaCents: 0,
      maxAbsDeltaCents: 0,
    });
    s.invoices += Number(r.invoices);
    if (r.c1) s.c1Invoices += Number(r.invoices);
    s.sumAbsDeltaCents += Number(r.sumAbsDeltaCents);
    s.maxAbsDeltaCents = Math.max(s.maxAbsDeltaCents, Number(r.maxAbsDeltaCents));
  }
  const c4 = { PRODUCTION: { items: 0, templates: 0 }, other: { items: 0, templates: 0 } };
  for (const r of c4Rows) {
    c4[bucketOf(r.prod)].items += Number(r.items);
    c4[bucketOf(r.prod)].templates += Number(r.templates);
  }
  return {
    sizing: {
      invoiceItem: Number(sizing.invoiceItem),
      recurringInvoiceItem: Number(sizing.recurringInvoiceItem),
      threshold: WIDEN_THRESHOLD,
      ...widen,
    },
    c1: rates.c1,
    c2,
    c3,
    c4,
  };
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(parsePercent("8.875"), 8.875, "parse");
  eq(parsePercent("150"), 100, "clamp high");
  eq(parsePercent("-3"), 0, "clamp low");
  eq(parsePercent("abc"), 0, "non-finite");
  eq(parsePercent(null), 0, "null");
  eq(percentDecimals(8.875), 3, "3 dp");
  eq(percentDecimals(7.0625), 4, "4 dp");
  eq(percentDecimals(8.25), 2, "2 dp");
  eq(percentDecimals(8), 0, "integer");
  eq(percentDecimals(0.1 + 0.2), 1, "float noise");
  eq(verdict("499999", "0").variant, "2a", "below threshold");
  eq(verdict("400000", "100000").variant, "2b", "at threshold");
  eq(
    verdict("12", "3").reasonLine,
    "-- reason: B296 precision; measured 15 rows; off-peak",
    "reason line",
  );
  const rates = classifyRates([
    { tenantId: "t-a", stored: "8.875", prod: true },
    { tenantId: "t-b", stored: "8.25", prod: true },
    { tenantId: "t-c", stored: "7.06255", prod: false },
    { tenantId: "t-d", stored: "", prod: true },
  ]);
  eq(rates.ids, ["t-a", "t-c"], "c1 ids");
  eq(
    rates.c1,
    { PRODUCTION: { tenants: 1, over4: 0 }, other: { tenants: 1, over4: 1 } },
    "c1 buckets",
  );
  const s = summarize({
    sizing: { invoiceItem: "10", recurringInvoiceItem: "2" },
    rates,
    c2Rows: [
      { family: "DRAFT", prod: true, n: "3" },
      { family: "ISSUED", prod: false, n: "4" },
    ],
    c3Rows: [
      {
        status: "SENT",
        prod: true,
        c1: true,
        invoices: "2",
        sumAbsDeltaCents: "7",
        maxAbsDeltaCents: "6",
      },
      {
        status: "SENT",
        prod: true,
        c1: false,
        invoices: "1",
        sumAbsDeltaCents: "9",
        maxAbsDeltaCents: "9",
      },
    ],
    c4Rows: [{ prod: true, items: "5", templates: "2" }],
  });
  eq(s.sizing.total, 12, "sizing total");
  eq(s.c2.PRODUCTION.DRAFT, 3, "c2 draft");
  eq(s.c2.other.ISSUED, 4, "c2 issued");
  eq(
    s.c3.PRODUCTION.SENT,
    { invoices: 3, c1Invoices: 2, sumAbsDeltaCents: 16, maxAbsDeltaCents: 9 },
    "c3",
  );
  eq(s.c4.PRODUCTION, { items: 5, templates: 2 }, "c4");
  if (/t-a|t-c/.test(JSON.stringify(s))) throw new Error("summary leaked a tenant id");
  for (const sql of [SIZING_SQL, RATE_SETTINGS_SQL, C2_SQL, C3_SQL, C4_SQL])
    if (!/^\s*(SELECT|WITH)\b/.test(sql)) throw new Error("a query is not a SELECT");
  return "self-test ok";
}

function printText(r) {
  const z = r.sizing;
  console.log(
    `SIZING InvoiceItem ${z.invoiceItem} + RecurringInvoiceItem ${z.recurringInvoiceItem} = ${z.total} ` +
      `(threshold ${z.threshold}) -> variant ${z.variant}: ${z.folder}`,
  );
  console.log(`  reason line for the folder: ${z.reasonLine}`);
  for (const b of ["PRODUCTION", "other"]) {
    console.log(
      `C1 ${b}: ${r.c1[b].tenants} tenant(s) with > 2 decimals of percent (${r.c1[b].over4} with > 4)`,
    );
  }
  for (const b of ["PRODUCTION", "other"]) {
    const c = r.c2[b];
    console.log(`C2 ${b}: rated lines DRAFT ${c.DRAFT}, ISSUED ${c.ISSUED}, VOID ${c.VOID}`);
  }
  for (const b of ["PRODUCTION", "other"]) {
    const entries = Object.entries(r.c3[b]);
    if (entries.length === 0) console.log(`C3 ${b}: 0 invoices off by >= $0.01`);
    for (const [status, c] of entries)
      console.log(
        `C3 ${b} ${status}: ${c.invoices} invoice(s) (${c.c1Invoices} of C1 tenants), ` +
          `sum |delta| ${c.sumAbsDeltaCents}c, max ${c.maxAbsDeltaCents}c`,
      );
  }
  for (const b of ["PRODUCTION", "other"]) {
    const c = r.c4[b];
    console.log(
      `C4 ${b}: ${c.items} active recurring item(s) in ${c.templates} template(s) at round4`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '120s'");
    await client.query("SET lock_timeout = '5s'");
    await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    try {
      const sizing = (await client.query(SIZING_SQL)).rows[0];
      const rates = classifyRates((await client.query(RATE_SETTINGS_SQL)).rows);
      const c2Rows = (await client.query(C2_SQL, [rates.ids])).rows;
      const c3Rows = (await client.query(C3_SQL, [rates.ids])).rows;
      const c4Rows = (await client.query(C4_SQL, [rates.ids, rates.pcts])).rows;
      const report = summarize({ sizing, rates, c2Rows, c3Rows, c4Rows });
      if (json) console.log(JSON.stringify(report, null, 2));
      else printText(report);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Run only when invoked directly: importing this module (for `summarize` / `selfTest`) must never start a report.
 * Paths are compared after realpath, case-insensitively on Windows; when only the file NAMES match it warns and
 * runs anyway, because a silent exit 0 reads as "nothing found" (the report-b673 pattern).
 */
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
      `${NAME}: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`${NAME}: ${e.message}`);
    process.exit(1);
  });
}
