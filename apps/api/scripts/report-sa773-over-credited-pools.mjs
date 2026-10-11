// SA-773 census: READ-ONLY, COUNT-ONLY by default. How many goods pools (an order's invoices, one product) were already credited
// or refunded MORE than they were billed (a historical double pay), and how many whole orders were? The refundable remainder
// (apps/api/src/returns/refundable-remainder.ts) reads such a pool as <= 0 and refuses any further refund or credit on it; this
// sizes what is already there so the owner can decide the remedy PER CASE. There is no automatic clawback.
//
// Two sections, both a SIZING ESTIMATE from the stored rows alone (the application also converts a STANDARD return's boxes to
// pieces through the order's pack evidence, which a plain query cannot):
//   pool   gross billed value of the product's lines (net subtotal + tax at the line's stored rate + category tax) against the
//          gross value of the standalone credit note items on those lines (not VOID, not a counted return's own credit note) plus
//          the stored item money of the INLINE returns (not rejected or cancelled) sold on that order;
//   order  net billed value of the order's goods against every non-VOID credit note on its invoices, the INLINE return items and
//          the recorded (EXTERNAL_REFUND) STANDARD refunds that issued no credit note.
// A STANDARD return that issued a credit note is in both sections through that credit note; one still open (not yet refunded) is
// not money out and is not counted.
//
// Output is an overage bucket and integers ONLY. `--list` additionally prints one row per case with the tenant id, the INVOICE id
// (the order's first live invoice), the product id (pool section) and the overage, for the owner's per-case decision: ids only,
// never a name, slug, customer or number. Ids leave the terminal only on purpose: `--list` is refused unless stdout is a TTY
// or the run says `--ack-ids-only` (or SA773_ACK_IDS_ONLY=1), i.e. the caller knows the output is ids only and where it goes.
// One READ ONLY transaction, always rolled back; the SQL has no parameters. Safety rests on READ ONLY + ROLLBACK, NOT on a target
// check: it does not refuse a non-local database (the B768 ruling: owner-run reports reach prod through the shared resolver on
// purpose). Run it against production ONLY with the owner's yes.
//
//   node apps/api/scripts/report-sa773-over-credited-pools.mjs --self-test
//   node apps/api/scripts/report-sa773-over-credited-pools.mjs --print-sql [--list]   # no connection: paste into psql
//   node apps/api/scripts/report-sa773-over-credited-pools.mjs [--list [--ack-ids-only]]   # local compose DB (B768 resolver)
//   railway run --service postgres node apps/api/scripts/report-sa773-over-credited-pools.mjs   # owner-run, with the owner's yes

import { pathToFileURL } from "node:url";

const TAG = "report-sa773";
/** An overage under five cents is rounding, not a double pay. */
const NOISE = "0.05";

const BUCKET = `CASE WHEN o."over" > 100 THEN '100+' WHEN o."over" > 10 THEN '10-100' WHEN o."over" > 1 THEN '1-10' ELSE '0.05-1' END`;

/** The shared CTEs: the live invoices, the billed side, the credited side per pool, and the per-order totals. */
const WITH_CLAUSE = [
  `WITH live AS (`,
  `  SELECT i."id" AS "invoiceId", i."tenantId", i."orderId"`,
  `  FROM "Invoice" i`,
  `  WHERE i."orderId" IS NOT NULL AND i."status"::text NOT IN ('VOID', 'WRITTEN_OFF')`,
  `), billed AS (`,
  `  SELECT l."tenantId", l."orderId", ii."productId", min(l."invoiceId") AS "invoiceId",`,
  `         sum(round(ii."subtotal", 2) + round(round(ii."subtotal", 2) * ii."taxRate", 2) + ii."categoryTaxAmount") AS "gross",`,
  `         sum(round(ii."subtotal", 2)) AS "net"`,
  `  FROM live l JOIN "InvoiceItem" ii ON ii."invoiceId" = l."invoiceId"`,
  `  WHERE ii."productId" IS NOT NULL`,
  `  GROUP BY l."tenantId", l."orderId", ii."productId"`,
  `), standalone AS (`,
  `  SELECT l."tenantId", l."orderId", ii."productId",`,
  `         sum(cni."amount" + cni."categoryTax" + round(cni."amount" * ii."taxRate", 2)) AS "credited"`,
  `  FROM "CreditNoteItem" cni`,
  `  JOIN "CreditNote" c ON c."id" = cni."creditNoteId" AND c."status"::text <> 'VOID'`,
  `  JOIN "InvoiceItem" ii ON ii."id" = cni."invoiceItemId"`,
  `  JOIN live l ON l."invoiceId" = ii."invoiceId"`,
  `  WHERE ii."productId" IS NOT NULL`,
  `    AND NOT EXISTS (SELECT 1 FROM "Return" r WHERE r."creditNoteId" = c."id" AND r."status"::text NOT IN ('REJECTED', 'CANCELLED'))`,
  `  GROUP BY l."tenantId", l."orderId", ii."productId"`,
  `), inline AS (`,
  `  SELECT ri."tenantId", ri."sourceOrderId" AS "orderId", ri."productId",`,
  `         sum(coalesce(ri."subtotal", 0) + coalesce(ri."taxAmount", 0) + coalesce(ri."categoryTax", 0)) AS "credited",`,
  `         sum(coalesce(ri."subtotal", 0)) AS "creditedNet"`,
  `  FROM "ReturnItem" ri JOIN "Return" r ON r."id" = ri."returnId"`,
  `  WHERE r."kind"::text = 'INLINE' AND r."status"::text NOT IN ('REJECTED', 'CANCELLED') AND ri."sourceOrderId" IS NOT NULL`,
  `  GROUP BY ri."tenantId", ri."sourceOrderId", ri."productId"`,
  `), pool_over AS (`,
  `  SELECT b."tenantId", b."orderId", b."productId", b."invoiceId",`,
  `         coalesce(s."credited", 0) + coalesce(n."credited", 0) - b."gross" AS "over"`,
  `  FROM billed b`,
  `  LEFT JOIN standalone s ON s."tenantId" = b."tenantId" AND s."orderId" = b."orderId" AND s."productId" = b."productId"`,
  `  LEFT JOIN inline n ON n."tenantId" = b."tenantId" AND n."orderId" = b."orderId" AND n."productId" = b."productId"`,
  `), order_billed AS (`,
  `  SELECT "tenantId", "orderId", min("invoiceId") AS "invoiceId", sum("net") AS "net" FROM billed GROUP BY "tenantId", "orderId"`,
  `), order_cn AS (`,
  `  SELECT l."tenantId", l."orderId", sum(c."amount") AS "credited"`,
  `  FROM "CreditNote" c JOIN live l ON l."invoiceId" = c."invoiceId"`,
  `  WHERE c."status"::text <> 'VOID'`,
  `  GROUP BY l."tenantId", l."orderId"`,
  `), order_inline AS (`,
  `  SELECT "tenantId", "orderId", sum("creditedNet") AS "credited" FROM inline GROUP BY "tenantId", "orderId"`,
  `), order_external AS (`,
  `  SELECT r."tenantId", r."orderId", sum(coalesce(r."refundAmount", 0)) AS "credited"`,
  `  FROM "Return" r`,
  `  WHERE r."kind"::text = 'STANDARD' AND r."status"::text IN ('REFUNDED', 'PROCESSED')`,
  `    AND r."refundMethod" = 'EXTERNAL_REFUND' AND r."creditNoteId" IS NULL`,
  `  GROUP BY r."tenantId", r."orderId"`,
  `), order_over AS (`,
  `  SELECT b."tenantId", b."orderId", b."invoiceId",`,
  `         coalesce(c."credited", 0) + coalesce(n."credited", 0) + coalesce(e."credited", 0) - b."net" AS "over"`,
  `  FROM order_billed b`,
  `  LEFT JOIN order_cn c ON c."tenantId" = b."tenantId" AND c."orderId" = b."orderId"`,
  `  LEFT JOIN order_inline n ON n."tenantId" = b."tenantId" AND n."orderId" = b."orderId"`,
  `  LEFT JOIN order_external e ON e."tenantId" = b."tenantId" AND e."orderId" = b."orderId"`,
  `)`,
];

/** The ONE statement. Default: overage buckets and counts. `list`: one row per case, ids and the overage only. */
export function buildSql({ list = false } = {}) {
  const tail = list
    ? [
        `SELECT 'pool' AS "section", o."tenantId", o."invoiceId", o."productId" AS "pool", round(o."over", 2) AS "overage"`,
        `FROM pool_over o WHERE o."over" > ${NOISE}`,
        `UNION ALL`,
        `SELECT 'order', o."tenantId", o."invoiceId", NULL, round(o."over", 2)`,
        `FROM order_over o WHERE o."over" > ${NOISE}`,
        `ORDER BY 1, 5 DESC, 2, 3`,
      ]
    : [
        `SELECT 'pool' AS "section", ${BUCKET} AS "overage", count(*)::int AS "cases", count(DISTINCT o."tenantId")::int AS "tenants"`,
        `FROM pool_over o WHERE o."over" > ${NOISE} GROUP BY 2`,
        `UNION ALL`,
        `SELECT 'order', ${BUCKET}, count(*)::int, count(DISTINCT o."tenantId")::int`,
        `FROM order_over o WHERE o."over" > ${NOISE} GROUP BY 2`,
        `ORDER BY 1, 2`,
      ];
  return [...WITH_CLAUSE, ...tail].join("\n");
}

/** Refuses anything that is not a single read-only SELECT (a WITH ... SELECT included). */
export function assertReadOnlySql(sql) {
  const body = String(sql).trim().replace(/;\s*$/, "");
  if (body.includes(";")) throw new Error(`${TAG}: refusing multiple statements`);
  if (!/^\s*(SELECT|WITH)\b/i.test(body)) throw new Error(`${TAG}: only a SELECT is allowed`);
  const banned =
    /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY|VACUUM|REINDEX|CALL|DO)\b/i;
  if (banned.test(body.replace(/'[^']*'/g, "''"))) throw new Error(`${TAG}: write keyword refused`);
  return body;
}

/** Overage buckets and integers only. */
export function formatReport(rows) {
  const lines = [
    "section".padEnd(8) + "overage".padEnd(10) + "cases".padStart(8) + "tenants".padStart(9),
  ];
  const totals = { pool: 0, order: 0 };
  for (const r of rows) {
    lines.push(
      String(r.section).padEnd(8) +
        String(r.overage).padEnd(10) +
        String(r.cases).padStart(8) +
        String(r.tenants).padStart(9),
    );
    totals[r.section] = (totals[r.section] ?? 0) + Number(r.cases);
  }
  lines.push(
    "",
    `${totals.pool} goods pool(s) and ${totals.order} order(s) credited past what was billed (a sizing estimate)`,
    "The refundable remainder refuses any further refund or credit on them. The remedy is the owner's, per case; nothing is clawed back.",
  );
  return lines.join("\n");
}

/** `--list`: one line per case, ids and the overage only. */
export function formatList(rows) {
  const lines = ["section\ttenantId\tinvoiceId\tpool\toverage"];
  for (const r of rows)
    lines.push([r.section, r.tenantId, r.invoiceId, r.pool ?? "", r.overage].join("\t"));
  return lines.join("\n");
}

/** `--list` is allowed on a terminal, or when the caller acknowledged that the output is ids only. */
export function listIdsAcknowledged(
  args,
  { stdoutIsTty = process.stdout.isTTY, env = process.env } = {},
) {
  return Boolean(stdoutIsTty) || args.includes("--ack-ids-only") || env.SA773_ACK_IDS_ONLY === "1";
}

function selfTest() {
  if (listIdsAcknowledged(["--list"], { stdoutIsTty: false, env: {} }))
    throw new Error("self-test: --list was allowed without a terminal or an acknowledgement");
  for (const ok of [
    [["--list", "--ack-ids-only"], { stdoutIsTty: false, env: {} }],
    [["--list"], { stdoutIsTty: true, env: {} }],
    [["--list"], { stdoutIsTty: false, env: { SA773_ACK_IDS_ONLY: "1" } }],
  ])
    if (!listIdsAcknowledged(ok[0], ok[1]))
      throw new Error("self-test: an acknowledged --list was refused");
  assertReadOnlySql(buildSql());
  assertReadOnlySql(buildSql({ list: true }));
  for (const bad of ['DELETE FROM "User"', "SELECT 1; SELECT 2", 'UPDATE "User" SET a = 1']) {
    let refused = false;
    try {
      assertReadOnlySql(bad);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error(`self-test: ${bad} was not refused`);
  }
  console.log(`${TAG} self-test: OK (one read-only statement per mode)`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const list = args.includes("--list");
  if (args.includes("--print-sql")) {
    console.log(`${assertReadOnlySql(buildSql({ list }))};`);
    return;
  }
  // ids leave the terminal only on purpose: before any connection
  if (list && !listIdsAcknowledged(args)) {
    console.error(
      `${TAG}: --list prints tenant, invoice and product IDS (no names). Run it in a terminal, or add --ack-ids-only (or set SA773_ACK_IDS_ONLY=1) to say the output is ids only and where it goes.`,
    );
    process.exit(2);
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
    await client.query("SET LOCAL statement_timeout = '120s'");
    const rows = (await client.query(assertReadOnlySql(buildSql({ list })))).rows;
    console.log(list ? formatList(rows) : formatReport(rows));
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
