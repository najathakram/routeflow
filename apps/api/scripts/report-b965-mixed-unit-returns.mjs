// B965 sizing: READ-ONLY, COUNT-ONLY. How many STANDARD returns still open (PENDING, APPROVED, IN_TRANSIT or RECEIVED, so a refund may still be ahead of them)
// sit on an order where a returned product's live lines MIX pack evidence: a line with a boxes/pieces split beside a box-unaware
// line of a boxed product (e.g. 12 loose pieces beside 2 boxes of 12)? A STANDARD return's qty is in its order line's own unit, so
// such a product has no single piece count. create() has refused to record one since SA-158 (409, "inline, per line"); these are
// the legacy rows that predate it. The refund door now refuses them too (409 RETURN_MIXED_UNIT_PRODUCT, before the claim); the
// operator resolves each with an inline per-line return, a manual credit, or EXTERNAL_REFUND.
//
// A HEURISTIC from the stored order-line columns alone (it does not run the invoice-item pack resolver the door uses): it flags a
// returned product whose live lines differ in pack evidence (a boxes/pieces split, a unit-aware factor-1 label, or a boxed snapshot
// of a given size). It can MISS what the door refuses through invoice evidence alone (a line billed across several invoice items,
// two box-unaware lines resolved differently), so read it as a sizing estimate, not a bound. Output is the return status and
// integers ONLY: never an id, tenant, customer, product or amount.
// One READ ONLY transaction, always rolled back; the SQL has no parameters. Safety rests on READ ONLY + ROLLBACK, NOT on a
// target check: it does not refuse a non-local database (the B768 ruling: owner-run reports reach prod through the shared
// resolver on purpose).
//
//   node apps/api/scripts/report-b965-mixed-unit-returns.mjs --self-test
//   node apps/api/scripts/report-b965-mixed-unit-returns.mjs --print-sql   # no connection: paste into psql
//   node apps/api/scripts/report-b965-mixed-unit-returns.mjs               # local compose DB (B768 resolver)
//   railway run --service postgres node apps/api/scripts/report-b965-mixed-unit-returns.mjs   # owner-run

import { pathToFileURL } from "node:url";

const TAG = "report-b965";

/** The ONE statement: open STANDARD returns with a returned product on lines that mix a split with a box-unaware line. */
export function buildSql() {
  return [
    `SELECT m."status" AS return_status,`,
    `       count(DISTINCT m."id")::int AS returns,`,
    `       count(*)::int AS products`,
    `FROM (`,
    `  SELECT r."id", r."status"::text AS "status", ri."productId"`,
    `  FROM "Return" r`,
    `  JOIN "ReturnItem" ri ON ri."returnId" = r."id"`,
    `  JOIN "OrderItem" oi ON oi."orderId" = r."orderId" AND oi."productId" = ri."productId"`,
    `                     AND oi."status"::text <> 'CANCELLED'`,
    `  JOIN "Product" p ON p."id" = oi."productId"`,
    `  WHERE r."kind" = 'STANDARD' AND r."status"::text IN ('PENDING', 'APPROVED', 'IN_TRANSIT', 'RECEIVED')`,
    `  GROUP BY r."id", r."status", ri."productId"`,
    `  HAVING count(DISTINCT CASE`,
    `           WHEN oi."boxes" IS NOT NULL OR oi."pieces" IS NOT NULL THEN 'split'`,
    `           WHEN btrim(COALESCE(oi."unitLabel", '')) <> '' AND oi."unitsPerBox" = 1 THEN 'unit1'`,
    `           WHEN COALESCE(oi."unitsPerBox", 0) > 1 THEN 'boxed:' || oi."unitsPerBox"::text`,
    `           WHEN COALESCE(p."unitsPerBox", 0) > 1 THEN 'boxed:' || p."unitsPerBox"::text`,
    `           ELSE 'plain' END) > 1`,
    `     AND bool_or(NOT (oi."boxes" IS NOT NULL OR oi."pieces" IS NOT NULL)`,
    `                 AND (COALESCE(oi."unitsPerBox", 0) > 1 OR COALESCE(p."unitsPerBox", 0) > 1))`,
    `) m`,
    `GROUP BY m."status"`,
    `ORDER BY 1`,
  ].join("\n");
}

/** Refuses anything that is not a single read-only SELECT. */
export function assertReadOnlySql(sql) {
  const body = String(sql).trim().replace(/;\s*$/, "");
  if (body.includes(";")) throw new Error(`${TAG}: refusing multiple statements`);
  if (!/^\s*SELECT\b/i.test(body)) throw new Error(`${TAG}: only a SELECT is allowed`);
  const banned =
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CALL|DO)\b/i;
  if (banned.test(body.replace(/'[^']*'/g, "''"))) throw new Error(`${TAG}: write keyword refused`);
  return body;
}

/** Return statuses and integers only. */
export function formatReport(rows) {
  const lines = ["return_status".padEnd(16) + "returns".padStart(10) + "products".padStart(10)];
  let total = 0;
  for (const r of rows) {
    lines.push(
      String(r.return_status).padEnd(16) +
        String(r.returns).padStart(10) +
        String(r.products).padStart(10),
    );
    total += Number(r.returns);
  }
  lines.push(
    "",
    `${total} open STANDARD return(s) on a mixed-unit product (${rows.length} status group(s)); a sizing estimate`,
    "Each is a return the refund door refuses (RETURN_MIXED_UNIT_PRODUCT): resolve it inline per line, manually, or EXTERNAL_REFUND.",
  );
  return lines.join("\n");
}

function selfTest() {
  assertReadOnlySql(buildSql());
  for (const bad of ['DELETE FROM "User"', "SELECT 1; SELECT 2", 'UPDATE "User" SET a = 1']) {
    let refused = false;
    try {
      assertReadOnlySql(bad);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error(`self-test: ${bad} was not refused`);
  }
  console.log(`${TAG} self-test: OK (one read-only SELECT)`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  if (args.includes("--print-sql")) {
    console.log(`${assertReadOnlySql(buildSql())};`);
    return;
  }
  // B768: owner-run read-only reports reach the database through the ONE shared resolver.
  const { resolveReportDbUrl } = await import("./lib/report-db-url.mjs");
  const url = resolveReportDbUrl(TAG);
  if (!url) {
    console.error(`${TAG}: no usable database URL: refusing to run`);
    process.exit(2);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL default_transaction_read_only = on");
    await client.query("SET LOCAL statement_timeout = '60s'");
    console.log(formatReport((await client.query(assertReadOnlySql(buildSql()))).rows));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`${TAG}: ${e.message}`);
    process.exit(1);
  });
}
