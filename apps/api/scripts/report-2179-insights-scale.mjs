/**
 * report-2179-insights-scale.mjs — #2179 / SA-400a PRE-LANDING gate. READ-ONLY.
 *
 * #2179's product-insights reads have a slow worst case (a product sold on every invoice of a very
 * large tenant). SA-400a lets #2179 land if BOTH hold for the LIVE cohort:
 *   (1) its hottest product has at most 10,000 invoice lines, and
 *   (2) its largest tenant has at most 10,000 invoices in total.
 * This report gives the owner those numbers without exposing a tenant.
 *
 * Output: aggregate COUNTS per cohort only, TEST (approved test tenants, `isTestTenant`) vs LIVE
 * (everything else): tenants, invoices (cohort total), the largest tenant's invoice count, invoice
 * lines, credit notes, returns, and the hottest product's line count and invoice count. Never an id,
 * slug, name, product or document. The cohort split happens in memory; the SQL groups by tenant id
 * and the ids are discarded.
 *
 * NEVER writes anything: `default_transaction_read_only = on` is set first, then every query runs
 * inside ONE `BEGIN TRANSACTION READ ONLY` snapshot that is rolled back; `statement_timeout` and
 * `lock_timeout` cap every statement. There is no write branch and no --execute flag.
 *
 * Run against prod via the Railway postgres proxy (owner):
 *   railway run --service postgres node apps/api/scripts/report-2179-insights-scale.mjs [--json]
 * Run locally (the shared resolver falls back to your local connection string):
 *   node apps/api/scripts/report-2179-insights-scale.mjs [--json]
 * No database:
 *   node apps/api/scripts/report-2179-insights-scale.mjs --self-test
 *
 * Exit: 0 within the SA-400a bounds · 1 over a bound (do not land #2179 without the perf follow-up)
 * · 2 connection/configuration error.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

/** SA-400a bounds for the LIVE cohort: the hottest product's lines, the largest tenant's invoices. */
export const MAX_HOTTEST_LINES = 10_000;
export const MAX_TENANT_INVOICES = 10_000;

/**
 * The read-only SQL, each grouped by tenant id. Lines are counted THROUGH their invoice (a legacy
 * nested-write line can carry a NULL "tenantId"). The hottest-product query reduces to one row per
 * tenant inside the database, so no product id ever reaches this process.
 */
export const QUERIES = {
  tenants: `SELECT id, slug FROM "Tenant"`,
  invoices: `SELECT "tenantId" AS t, count(*)::bigint AS n FROM "Invoice" GROUP BY 1`,
  lines: `SELECT i."tenantId" AS t, count(*)::bigint AS n
            FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId"
           GROUP BY 1`,
  creditNotes: `SELECT "tenantId" AS t, count(*)::bigint AS n FROM "CreditNote" GROUP BY 1`,
  returns: `SELECT "tenantId" AS t, count(*)::bigint AS n FROM "Return" GROUP BY 1`,
  hottest: `SELECT p.t, max(p.lines)::bigint AS lines, max(p.invoices)::bigint AS invoices
              FROM (SELECT i."tenantId" AS t, ii."productId",
                           count(*) AS lines, count(DISTINCT ii."invoiceId") AS invoices
                      FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId"
                     WHERE ii."productId" IS NOT NULL
                     GROUP BY 1, 2) p
             GROUP BY 1`,
};

const WRITE_WORD = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|COPY)\b/i;

/** Every statement this report sends must be a SELECT with no write keyword. */
export function assertReadOnlySql(sql) {
  if (!/^\s*SELECT\b/i.test(sql) || WRITE_WORD.test(sql)) {
    throw new Error("report-2179-insights-scale: refusing a non-SELECT statement");
  }
}

const emptyCohort = () => ({
  tenants: 0,
  invoices: 0,
  /** The largest single tenant's invoice count in this cohort (SA-400a bound 2). */
  largestTenantInvoices: 0,
  invoiceLines: 0,
  creditNotes: 0,
  returns: 0,
  hottestProductLines: 0,
  hottestProductInvoices: 0,
});

/**
 * Folds per-tenant counts into the two cohorts. `slugById` maps tenant id → slug (used only for
 * `isTestTenant`); a row whose tenant id is unknown or NULL counts as LIVE — the conservative side.
 * The returned object holds counts only.
 */
export function summarize(slugById, counts) {
  const cohorts = { test: emptyCohort(), live: emptyCohort() };
  const cohortOf = (id) => {
    const slug = id == null ? null : slugById.get(id);
    return slug != null && isTestTenant(slug) ? cohorts.test : cohorts.live;
  };
  for (const slug of slugById.values()) {
    (isTestTenant(slug) ? cohorts.test : cohorts.live).tenants += 1;
  }
  const add = (rows, key) => {
    for (const r of rows) cohortOf(r.t)[key] += Number(r.n);
  };
  add(counts.invoices, "invoices");
  // Per tenant, so bound 2 is one tenant's total. A NULL-tenant group counts as one live "tenant".
  for (const r of counts.invoices) {
    const c = cohortOf(r.t);
    c.largestTenantInvoices = Math.max(c.largestTenantInvoices, Number(r.n));
  }
  add(counts.lines, "invoiceLines");
  add(counts.creditNotes, "creditNotes");
  add(counts.returns, "returns");
  for (const r of counts.hottest) {
    const c = cohortOf(r.t);
    c.hottestProductLines = Math.max(c.hottestProductLines, Number(r.lines));
    c.hottestProductInvoices = Math.max(c.hottestProductInvoices, Number(r.invoices));
  }
  return cohorts;
}

/** SA-400a: BOTH bounds on the LIVE cohort — hottest product's lines, largest tenant's invoices. */
export function verdict(cohorts) {
  const live = cohorts.live;
  const withinLines = live.hottestProductLines <= MAX_HOTTEST_LINES;
  const withinTenantInvoices = live.largestTenantInvoices <= MAX_TENANT_INVOICES;
  return {
    withinBounds: withinLines && withinTenantInvoices,
    withinLines,
    withinTenantInvoices,
  };
}

function print(cohorts, json) {
  const v = verdict(cohorts);
  if (json) {
    console.log(JSON.stringify({ cohorts, verdict: v }, null, 2));
    return;
  }
  console.table({ test: cohorts.test, live: cohorts.live });
  console.log(
    `SA-400a: live hottest product ${cohorts.live.hottestProductLines} lines (bound ${MAX_HOTTEST_LINES}); ` +
      `largest live tenant ${cohorts.live.largestTenantInvoices} invoices (bound ${MAX_TENANT_INVOICES}); ` +
      `live cohort ${cohorts.live.invoices} invoices in total → ` +
      (v.withinBounds ? "WITHIN BOUNDS" : "OVER A BOUND"),
  );
}

function runSelfTest() {
  const slugs = new Map([
    ["t-test", "test"],
    ["t-qa", "qa-2179-x"],
    ["t-live-a", "acme-foods"],
    ["t-live-b", "bayside-market"],
  ]);
  const counts = {
    invoices: [
      { t: "t-test", n: "5" },
      { t: "t-live-a", n: "700" },
      { t: "t-live-b", n: "300" },
      { t: null, n: "2" }, // a NULL-tenant row counts LIVE (conservative)
    ],
    lines: [
      { t: "t-test", n: "50" },
      { t: "t-live-a", n: "9000" },
    ],
    creditNotes: [{ t: "t-qa", n: "3" }],
    returns: [{ t: "t-live-b", n: "4" }],
    hottest: [
      { t: "t-test", lines: "40", invoices: "5" },
      { t: "t-live-a", lines: "8000", invoices: "650" },
      { t: "t-live-b", lines: "120", invoices: "900" },
    ],
  };
  const cases = [];
  const check = (name, cond) => cases.push([name, !!cond]);

  const c = summarize(slugs, counts);
  check("cohort tenants split by isTestTenant", c.test.tenants === 2 && c.live.tenants === 2);
  check("invoices fold per cohort; NULL tenant counts live", c.live.invoices === 1002);
  check("test invoices stay test", c.test.invoices === 5);
  check("lines fold per cohort", c.live.invoiceLines === 9000 && c.test.invoiceLines === 50);
  check("credit notes / returns fold", c.test.creditNotes === 3 && c.live.returns === 4);
  check(
    "hottest = max per cohort, lines and invoices independently",
    c.live.hottestProductLines === 8000 && c.live.hottestProductInvoices === 900,
  );
  check(
    "largest tenant = max single tenant's invoices per cohort",
    c.live.largestTenantInvoices === 700 && c.test.largestTenantInvoices === 5,
  );
  check("within bounds", verdict(c).withinBounds === true);
  const bigTenant = summarize(slugs, {
    ...counts,
    invoices: [{ t: "t-live-b", n: "10001" }],
  });
  check(
    "over the tenant-invoice bound",
    verdict(bigTenant).withinBounds === false && !verdict(bigTenant).withinTenantInvoices,
  );
  const manySmall = summarize(slugs, {
    ...counts,
    invoices: [
      { t: "t-live-a", n: "9000" },
      { t: "t-live-b", n: "9000" },
    ],
  });
  check(
    "bound 2 is per tenant, not the cohort total",
    manySmall.live.invoices === 18000 && verdict(manySmall).withinTenantInvoices === true,
  );
  const over = summarize(slugs, {
    ...counts,
    hottest: [{ t: "t-live-a", lines: "10001", invoices: "1" }],
  });
  check("over the line bound", verdict(over).withinBounds === false && !verdict(over).withinLines);
  const text = JSON.stringify(c);
  check(
    "output carries no tenant id or slug",
    !["t-test", "t-qa", "t-live-a", "t-live-b", "qa-2179-x", "acme-foods", "bayside-market"].some(
      (x) => text.includes(x),
    ),
  );
  let refused = false;
  try {
    assertReadOnlySql('DELETE FROM "Invoice"');
  } catch {
    refused = true;
  }
  check("a write statement is refused", refused);
  let allSelect = true;
  for (const sql of Object.values(QUERIES)) {
    try {
      assertReadOnlySql(sql);
    } catch {
      allSelect = false;
    }
  }
  check("every query is a read-only SELECT", allSelect);

  let failed = 0;
  for (const [name, pass] of cases) {
    if (!pass) failed += 1;
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
  }
  console.log(failed ? `\n${failed} self-test case(s) FAILED` : "\nself-test: all cases pass");
  return failed ? 1 : 0;
}

async function main() {
  const json = process.argv.includes("--json");
  const { resolveReportDbUrl } = await import("./lib/report-db-url.mjs");
  const url = resolveReportDbUrl("report-2179-insights-scale");
  if (!url) return 2;
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  const q = async (sql) => {
    assertReadOnlySql(sql);
    return (await client.query(sql)).rows;
  };
  try {
    await client.connect();
  } catch (e) {
    console.error(`report-2179-insights-scale: ${e.message}`);
    return 2;
  }
  let inTx = false;
  try {
    // Read-only session FIRST, then the timeouts, then one read-only snapshot.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");
    await client.query("BEGIN TRANSACTION READ ONLY");
    inTx = true;
    const tenants = await q(QUERIES.tenants);
    const counts = {
      invoices: await q(QUERIES.invoices),
      lines: await q(QUERIES.lines),
      creditNotes: await q(QUERIES.creditNotes),
      returns: await q(QUERIES.returns),
      hottest: await q(QUERIES.hottest),
    };
    await client.query("ROLLBACK");
    inTx = false;
    // Ids and slugs live only in this map, used for the cohort split, then dropped.
    const cohorts = summarize(new Map(tenants.map((t) => [t.id, t.slug])), counts);
    print(cohorts, json);
    return verdict(cohorts).withinBounds ? 0 : 1;
  } catch (e) {
    console.error(`report-2179-insights-scale: ${e.message}`);
    return 2;
  } finally {
    if (inTx) await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

// Import-safe: a spec can load the pure functions without connecting.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = process.argv.includes("--self-test") ? runSelfTest() : await main();
}
