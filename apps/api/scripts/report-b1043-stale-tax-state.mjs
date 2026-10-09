/**
 * READ-ONLY census for B1043 / SA-742r2 (INV-A): how many invoices would the new
 * `409 INVOICE_TAX_STATE_STALE` hit?
 *
 * The no-items invoice PATCH (header-only: `discount` / `shippingFee` without `items`) will refuse
 * when the stored `subtotal` / `taxAmount` differ from the totals recomputed from the invoice's own
 * lines (rule F1). Web and mobile never send that PATCH; it is API and scripts only, so the exposed
 * set is the DRAFT invoices whose stored header disagrees with their lines. This report counts them.
 *
 * THE ARITHMETIC (inlined from the spec until `sumInvoiceTotals` lands in @routeflow/pricing; pinned
 * by `--self-test`), all money through `roundMoney`, sums in row order (lines ordered by id):
 *   subtotal    = round(sum(line.subtotal))
 *   regularTax  = exempt ? 0 : round(sum(line.subtotal * line.taxRate))
 *   categoryTax = exempt ? 0 : round(sum(line.categoryTaxAmount))
 *   tax         = round(regularTax + categoryTax)
 *   total       = round(subtotal - discount + shipping + tax)
 * An invoice is STALE when round(stored subtotal) != computed subtotal OR round(stored taxAmount) !=
 * computed tax (the exact test the 409 will use); otherwise it is consistent. The total is not part
 * of the test (the PATCH rewrites it).
 *
 * STALE REASONS (first match wins, in this order):
 *   1. subtotal      stored subtotal differs from the lines' subtotal.
 *   2. exempt        the customer is tax exempt and the stored tax is not 0 (the computed tax is 0).
 *   3. zeroRateTax   every line rate is 0 and the stored tax is > 0 (the B294 order-derived shape).
 *   4. rounding      |stored tax - computed tax| <= $0.01 per line (the B296 rate-precision drift).
 *   5. other         any remaining tax mismatch.
 * Independently of the above, `foreignTenantRows` counts invoices with a NULL tenant or any line whose
 * tenant is NULL or differs from the invoice's (the invoice PATCH would 400 on it, B929); such an
 * invoice is still classified consistent / stale as well.
 *
 * SCOPE: invoices with status DRAFT (default), or every status except VOID with `--all-statuses`
 * (context only: those states cannot be PATCHed header-only). The Invoice model has no soft-delete
 * column, so there is no deleted-row filter.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The lead or owner runs it under warn-then-approve:
 *
 *   railway run --service postgres node apps/api/scripts/report-b1043-stale-tax-state.mjs [--json] [--all-statuses]
 *   node apps/api/scripts/report-b1043-stale-tax-state.mjs --self-test      (no database)
 *
 * Output is COUNTS ONLY plus anonymous labels ("tenant A", "tenant B", ...): no tenant id, slug or
 * name, and no invoice, customer or line id is printed. Approved test tenants
 * (scripts/lib/test-tenants.cjs) are reported in a separate `test` block.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and
 * `lock_timeout` cap every query; a keyset cursor by id reads 500 invoices per page; the connection
 * is closed in `finally`; only SELECT statements appear below.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");
const { roundMoney } = require("@routeflow/pricing");

const NAME = "report-b1043-stale-tax-state";
const PAGE = 500;
const DAY_MS = 86_400_000;

/** The stale reasons, in precedence order; also the keys of every `byReason` block. */
export const REASONS = ["subtotal", "exempt", "zeroRateTax", "rounding", "other"];
export const AGE_BUCKETS = ["lt30d", "lt1y", "older"];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The five formulas (F1). Pure; never mutates `lines`. Each line: { subtotal, taxRate?,
 * categoryTaxAmount? }. Sums run in the given row order.
 */
export function sumInvoiceTotals(lines, { discount = 0, shipping = 0, isTaxExempt = false } = {}) {
  let sub = 0;
  let taxable = 0;
  let levy = 0;
  for (const l of lines) {
    const s = num(l.subtotal);
    sub += s;
    taxable += s * num(l.taxRate);
    levy += num(l.categoryTaxAmount);
  }
  const subtotal = roundMoney(sub);
  const regularTax = isTaxExempt ? 0 : roundMoney(taxable);
  const categoryTax = isTaxExempt ? 0 : roundMoney(levy);
  const tax = roundMoney(regularTax + categoryTax);
  const total = roundMoney(subtotal - num(discount) + num(shipping) + tax);
  return { subtotal, regularTax, categoryTax, tax, total };
}

/**
 * Classify one invoice. `invoice`: { subtotal, taxAmount, tenantId, isTaxExempt }; `lines`: rows of
 * { subtotal, taxRate, categoryTaxAmount, tenantId }. Returns { stale, reason | null, foreignTenant }.
 */
export function classifyInvoice(invoice, lines) {
  const exempt = !!invoice.isTaxExempt;
  const computed = sumInvoiceTotals(lines, { isTaxExempt: exempt });
  const storedSubtotal = roundMoney(num(invoice.subtotal));
  const storedTax = roundMoney(num(invoice.taxAmount));
  const foreignTenant =
    invoice.tenantId == null ||
    lines.some((l) => l.tenantId == null || l.tenantId !== invoice.tenantId);

  const subtotalDiffers = storedSubtotal !== computed.subtotal;
  const taxDiffers = storedTax !== computed.tax;
  if (!subtotalDiffers && !taxDiffers) return { stale: false, reason: null, foreignTenant };

  let reason;
  if (subtotalDiffers) reason = "subtotal";
  else if (exempt && storedTax !== 0) reason = "exempt";
  else if (lines.every((l) => num(l.taxRate) === 0) && storedTax > 0) reason = "zeroRateTax";
  else if (roundMoney(Math.abs(storedTax - computed.tax)) <= roundMoney(lines.length / 100))
    reason = "rounding";
  else reason = "other";
  return { stale: true, reason, foreignTenant };
}

export function ageBucket(createdAt, now = new Date()) {
  const days = (now.getTime() - new Date(createdAt).getTime()) / DAY_MS;
  if (days < 30) return "lt30d";
  if (days < 365) return "lt1y";
  return "older";
}

const zeroBlock = () => ({
  scanned: 0,
  consistent: 0,
  stale: 0,
  byReason: Object.fromEntries(REASONS.map((r) => [r, 0])),
  foreignTenantRows: 0,
  staleAge: Object.fromEntries(AGE_BUCKETS.map((b) => [b, 0])),
});

/** Accumulator: one counter block per tenant id (null = no tenant), live and test kept apart. */
export function newAccumulator() {
  return { live: new Map(), test: new Map() };
}

export function addInvoice(acc, { tenantId, isTest }, result, age) {
  const side = isTest ? acc.test : acc.live;
  if (!side.has(tenantId ?? null)) side.set(tenantId ?? null, zeroBlock());
  const b = side.get(tenantId ?? null);
  b.scanned += 1;
  if (result.stale) {
    b.stale += 1;
    b.byReason[result.reason] += 1;
    b.staleAge[age] += 1;
  } else b.consistent += 1;
  if (result.foreignTenant) b.foreignTenantRows += 1;
}

/** One side of the accumulator -> anonymous totals + per-tenant detail. Labels follow tenant id order. */
export function summarizeSide(side) {
  const ids = [...side.keys()].filter((id) => id != null).sort();
  const label = new Map(
    ids.map((id, n) => [
      id,
      `tenant ${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ""}`,
    ]),
  );
  const total = zeroBlock();
  const detail = [];
  for (const id of [...side.keys()].sort((a, b) =>
    a == null ? -1 : b == null ? 1 : a < b ? -1 : 1,
  )) {
    const b = side.get(id);
    total.scanned += b.scanned;
    total.consistent += b.consistent;
    total.stale += b.stale;
    total.foreignTenantRows += b.foreignTenantRows;
    for (const r of REASONS) total.byReason[r] += b.byReason[r];
    for (const k of AGE_BUCKETS) total.staleAge[k] += b.staleAge[k];
    detail.push({ tenant: id == null ? "no tenant" : label.get(id), ...structuredClone(b) });
  }
  return {
    ...total,
    tenantsScanned: side.size,
    tenantsAffected: detail.filter((d) => d.stale > 0).length,
    detail,
  };
}

export function summarize(acc) {
  return { live: summarizeSide(acc.live), test: summarizeSide(acc.test) };
}

/** The two paged SELECTs. `statuses` is either DRAFT only or every non-VOID status (no input reaches the SQL). */
export const INVOICE_PAGE_SQL = (allStatuses) => `SELECT i.id, i."tenantId", i."createdAt",
       i.subtotal::text AS subtotal, i."taxAmount"::text AS "taxAmount",
       c."isTaxExempt" AS "isTaxExempt", t.slug
  FROM "Invoice" i
  LEFT JOIN "Customer" c ON c.id = i."customerId"
  LEFT JOIN "Tenant" t ON t.id = i."tenantId"
 WHERE ${allStatuses ? `i.status <> 'VOID'` : `i.status = 'DRAFT'`}
   AND i.id > $1::text
 ORDER BY i.id
 LIMIT ${PAGE}`;

export const LINES_SQL = `SELECT ii."invoiceId", ii."tenantId",
       ii.subtotal::text AS subtotal, ii."taxRate"::text AS "taxRate",
       ii."categoryTaxAmount"::text AS "categoryTaxAmount"
  FROM "InvoiceItem" ii
 WHERE ii."invoiceId" = ANY($1::text[])
 ORDER BY ii."invoiceId", ii.id`;

/** Pure paging step shared by main() and the self-test: classify one page into the accumulator. */
export function foldPage(acc, invoices, lineRows, now = new Date()) {
  const byInvoice = new Map();
  for (const l of lineRows) {
    if (!byInvoice.has(l.invoiceId)) byInvoice.set(l.invoiceId, []);
    byInvoice.get(l.invoiceId).push(l);
  }
  for (const inv of invoices) {
    const result = classifyInvoice(inv, byInvoice.get(inv.id) ?? []);
    addInvoice(
      acc,
      { tenantId: inv.tenantId ?? null, isTest: !!(inv.slug && isTestTenant(inv.slug)) },
      result,
      ageBucket(inv.createdAt, now),
    );
  }
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  // The five formulas, pinned on fixed numbers.
  const lines = [
    { subtotal: "100.00", taxRate: "0.0825", categoryTaxAmount: "5.00" },
    { subtotal: "50.00", taxRate: "0", categoryTaxAmount: "0" },
  ];
  eq(
    sumInvoiceTotals(lines, { discount: 2, shipping: 10 }),
    { subtotal: 150, regularTax: 8.25, categoryTax: 5, tax: 13.25, total: 171.25 },
    "formula (non-exempt)",
  );
  eq(
    sumInvoiceTotals(lines, { discount: 2, shipping: 10, isTaxExempt: true }),
    { subtotal: 150, regularTax: 0, categoryTax: 0, tax: 0, total: 158 },
    "formula (exempt)",
  );
  eq(
    sumInvoiceTotals([{ subtotal: "33.33", taxRate: "0.0875" }]).tax,
    2.92,
    "formula rounds the sum once",
  );
  const before = JSON.stringify(lines);
  sumInvoiceTotals(lines);
  eq(JSON.stringify(lines), before, "formula must not mutate its input");

  // Classification: one fixture per bucket.
  const L = (subtotal, taxRate, categoryTaxAmount = "0", tenantId = "t1") => ({
    subtotal,
    taxRate,
    categoryTaxAmount,
    tenantId,
  });
  const inv = (subtotal, taxAmount, extra = {}) => ({
    subtotal,
    taxAmount,
    tenantId: "t1",
    isTaxExempt: false,
    ...extra,
  });
  const cls = (i, ls) => {
    const r = classifyInvoice(i, ls);
    return r.stale ? r.reason : r.foreignTenant ? "foreign" : "consistent";
  };
  eq(cls(inv("100.00", "8.00"), [L("100.00", "0.08")]), "consistent", "consistent");
  eq(cls(inv("100.00", "13.00"), [L("100.00", "0.08", "5.00")]), "consistent", "consistent + levy");
  eq(cls(inv("90.00", "8.00"), [L("100.00", "0.08")]), "subtotal", "reason 1");
  eq(cls(inv("100.00", "4.00", { isTaxExempt: true }), [L("100.00", "0")]), "exempt", "reason 2");
  eq(
    cls(inv("100.00", "0.00", { isTaxExempt: true }), [L("100.00", "0.08", "5.00")]),
    "consistent",
    "exempt, tax 0",
  );
  eq(cls(inv("100.00", "4.00"), [L("100.00", "0")]), "zeroRateTax", "reason 3");
  eq(cls(inv("100.00", "8.01"), [L("100.00", "0.08")]), "rounding", "reason 4 (one cent)");
  eq(cls(inv("100.00", "8.02"), [L("100.00", "0.08")]), "other", "one line, two cents");
  eq(
    cls(inv("100.00", "8.02"), [L("50.00", "0.08"), L("50.00", "0.08")]),
    "rounding",
    "two lines, two cents",
  );
  eq(cls(inv("100.00", "9.00"), [L("100.00", "0.08")]), "other", "reason 5");
  eq(cls(inv("100.00", "8.00"), [L("100.00", "0.08", "0", null)]), "foreign", "NULL-tenant line");
  eq(
    cls(inv("100.00", "8.00"), [L("100.00", "0.08", "0", "t2")]),
    "foreign",
    "foreign-tenant line",
  );
  eq(
    cls(inv("100.00", "8.00", { tenantId: null }), [L("100.00", "0.08", "0", null)]),
    "foreign",
    "NULL-tenant invoice",
  );
  eq(classifyInvoice(inv("0.00", "0.00"), []).stale, false, "empty invoice is consistent");

  // Aggregation, labelling and anonymity.
  const acc = newAccumulator();
  const now = new Date("2026-10-09T00:00:00Z");
  const page = [
    {
      id: "i1",
      tenantId: "t-b",
      slug: "acme-b",
      createdAt: "2026-10-01T00:00:00Z",
      ...inv("100.00", "8.00", { tenantId: "t-b" }),
    },
    {
      id: "i2",
      tenantId: "t-b",
      slug: "acme-b",
      createdAt: "2026-03-01T00:00:00Z",
      ...inv("100.00", "4.00", { tenantId: "t-b" }),
    },
    {
      id: "i3",
      tenantId: "t-a",
      slug: "acme-a",
      createdAt: "2020-01-01T00:00:00Z",
      ...inv("90.00", "8.00", { tenantId: "t-a" }),
    },
    {
      id: "i4",
      tenantId: "t-q",
      slug: "qa-probe",
      createdAt: "2026-10-05T00:00:00Z",
      ...inv("10.00", "0.00", { tenantId: "t-q" }),
    },
  ];
  const rows = [
    { invoiceId: "i1", ...L("100.00", "0.08", "0", "t-b") },
    { invoiceId: "i2", ...L("100.00", "0", "0", "t-b") },
    { invoiceId: "i3", ...L("100.00", "0.08", "0", "t-a") },
    { invoiceId: "i4", ...L("10.00", "0", "0", "t-q") },
  ];
  foldPage(acc, page, rows, now);
  const s = summarize(acc);
  eq([s.live.scanned, s.live.consistent, s.live.stale], [3, 1, 2], "live counts");
  eq([s.live.byReason.zeroRateTax, s.live.byReason.subtotal], [1, 1], "live reasons");
  eq(s.live.staleAge, { lt30d: 0, lt1y: 1, older: 1 }, "age buckets");
  eq(s.live.tenantsAffected, 2, "tenants affected");
  eq(
    s.live.detail.map((d) => d.tenant),
    ["tenant A", "tenant B"],
    "labels",
  );
  eq([s.test.scanned, s.test.stale], [1, 0], "test tenants kept apart");
  const text = JSON.stringify(s);
  if (/acme|t-a|t-b|t-q|qa-probe|i[1-4]/.test(text))
    throw new Error("summary leaked an id or slug");
  if (!/FROM "Invoice"/.test(INVOICE_PAGE_SQL(false)) || !/'DRAFT'/.test(INVOICE_PAGE_SQL(false)))
    throw new Error("default scope lost DRAFT");
  if (!/<> 'VOID'/.test(INVOICE_PAGE_SQL(true)))
    throw new Error("--all-statuses lost the VOID exclusion");
  return "self-test ok";
}

function printBlock(name, s) {
  console.log(
    `${name}: ${s.scanned} scanned, ${s.consistent} consistent, ${s.stale} stale ` +
      `(${s.tenantsAffected} of ${s.tenantsScanned} tenant bucket(s) affected)`,
  );
  console.log(`  stale by reason: ${REASONS.map((r) => `${r} ${s.byReason[r]}`).join(", ")}`);
  console.log(`  NULL- or foreign-tenant row (would 400, B929): ${s.foreignTenantRows}`);
  console.log(`  stale age: ${AGE_BUCKETS.map((b) => `${b} ${s.staleAge[b]}`).join(", ")}`);
  for (const d of s.detail)
    console.log(
      `  ${d.tenant}  scanned ${d.scanned}, stale ${d.stale} (${REASONS.map((r) => `${r} ${d.byReason[r]}`).join(", ")}), foreign ${d.foreignTenantRows}`,
    );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const allStatuses = argv.includes("--all-statuses");
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");

    const acc = newAccumulator();
    const now = new Date();
    let cursor = "";
    for (;;) {
      const { rows: invoices } = await client.query(INVOICE_PAGE_SQL(allStatuses), [cursor]);
      if (invoices.length === 0) break;
      const { rows: lineRows } = await client.query(LINES_SQL, [invoices.map((i) => i.id)]);
      foldPage(acc, invoices, lineRows, now);
      cursor = invoices[invoices.length - 1].id;
      if (invoices.length < PAGE) break;
    }
    const report = {
      scope: allStatuses ? "all statuses except VOID (context only)" : "DRAFT",
      ...summarize(acc),
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`scope: ${report.scope}`);
      printBlock("live", report.live);
      printBlock("test", report.test);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Run only when invoked directly: importing this module (for `classifyInvoice` / `selfTest`) must
 * never start a report. Paths are compared after realpath, case-insensitively on Windows; when only
 * the file NAMES match it warns and runs anyway, because a silent exit 0 reads as "nothing found"
 * (the report-b673 pattern).
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
