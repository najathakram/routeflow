/**
 * READ-ONLY census for #2230 / SA-388d: how many unit lines carry the ALL-EMPTY split today, per
 * line table: `unitLabel` set, pack factor `unitsPerBox > 1`, `qty > 0`, and neither `boxes >= 1`
 * nor `pieces >= 1`. That is B718's over-bill shape (the count is underivable). A part-unit split
 * such as 0 boxes + 5 pieces is VALID (SA-178) and is not counted; an "Each" line (factor 1) is
 * exempt. #2230 adds a writer guard plus a CHECK on OrderItem/InvoiceItem (NOT VALID); its
 * VALIDATE runs only after this census reads zero.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-b2230-unit-lines-without-boxes.mjs [--json]
 *
 * Output is COUNTS ONLY plus anonymous labels ("tenant A", "tenant B", ...): no tenant id, slug,
 * name, line or document id is printed. Test tenants (scripts/lib/test-tenants.cjs) are counted in
 * a separate `test` block; rows with no tenant are counted under "no tenant". Each count is split
 * by `boxes` NULL vs 0, by `qty` = 0 vs > 0 and by `pieces` > 0 (a part-unit split such as a
 * non-whole-Case delivery, 0 boxes + 5 pieces), so a legitimate shape (if one exists)
 * is visible before a constraint is chosen. `--tenant <id>` limits the count to one tenant
 * (DB-lane use only).
 *
 * `--self-test` runs the pure checks (anonymous summary) with no database and exits.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and
 * `lock_timeout` cap every query; the connection is closed in `finally`; only SELECT appears below.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

const NAME = "report-b2230-unit-lines-without-boxes";

/** The line tables with the unit columns. The CHECK targets the first two; estimates are counted for the record. */
export const TABLES = ["OrderItem", "InvoiceItem", "EstimateItem"];

/** The violating shape, shared by every table's query (and pinned by the spec). */
export const VIOLATION_SQL = `i."unitLabel" IS NOT NULL AND COALESCE(i."unitsPerBox", 1) > 1 AND i.qty > 0 AND COALESCE(i.boxes, 0) < 1 AND COALESCE(i.pieces, 0) < 1`;

/**
 * One grouped SELECT per table: per tenant, how many violating rows, split by boxes NULL/0 and
 * qty 0/>0. `table` comes only from TABLES above, never from input.
 */
export function censusSql(table) {
  if (!TABLES.includes(table)) throw new Error(`unknown table ${table}`);
  return `SELECT i."tenantId", t.slug,
                 COUNT(*)::int AS rows,
                 COUNT(*) FILTER (WHERE i.boxes IS NULL)::int AS "boxesNull",
                 COUNT(*) FILTER (WHERE i.boxes IS NOT NULL)::int AS "boxesZero",
                 COUNT(*) FILTER (WHERE i.qty = 0)::int AS "qtyZero",
                 COUNT(*) FILTER (WHERE i.qty > 0)::int AS "qtyPositive",
                 COUNT(*) FILTER (WHERE COALESCE(i.pieces, 0) > 0)::int AS "piecesPositive"
            FROM "${table}" i
            LEFT JOIN "Tenant" t ON t.id = i."tenantId"
           WHERE ${VIOLATION_SQL}
             AND ($1::text IS NULL OR i."tenantId" = $1::text)
           GROUP BY i."tenantId", t.slug
           ORDER BY i."tenantId" NULLS FIRST`;
}

/**
 * Anonymous per-table summary. Labels (A, B, ...) are assigned in tenantId order ACROSS tables, so
 * "tenant A" names the same tenant in every table; ids and slugs never leave this function.
 */
export function summarize(byTable) {
  const ids = [
    ...new Set(
      Object.values(byTable)
        .flat()
        .map((r) => r.tenantId)
        .filter((id) => id != null),
    ),
  ].sort();
  const label = new Map(
    ids.map((id, n) => [
      id,
      `tenant ${String.fromCharCode(65 + (n % 26))}${n >= 26 ? Math.floor(n / 26) : ""}`,
    ]),
  );
  const out = {};
  for (const [table, rows] of Object.entries(byTable)) {
    const total = {
      rows: 0,
      boxesNull: 0,
      boxesZero: 0,
      qtyZero: 0,
      qtyPositive: 0,
      piecesPositive: 0,
    };
    const detail = rows.map((r) => {
      for (const k of Object.keys(total)) total[k] += Number(r[k] ?? 0);
      return {
        tenant: r.tenantId == null ? "no tenant" : label.get(r.tenantId),
        rows: r.rows,
        boxesNull: r.boxesNull,
        boxesZero: r.boxesZero,
        qtyZero: r.qtyZero,
        qtyPositive: r.qtyPositive,
        piecesPositive: r.piecesPositive,
      };
    });
    out[table] = { ...total, tenants: detail.length, detail };
  }
  return out;
}

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const row = (tenantId, slug, rows, boxesNull, qtyZero) => ({
    tenantId,
    slug,
    rows,
    boxesNull,
    boxesZero: rows - boxesNull,
    qtyZero,
    qtyPositive: rows - qtyZero,
  });
  const s = summarize({
    OrderItem: [row("t-b", "acme-b", 3, 1, 2), row(null, null, 1, 1, 0)],
    InvoiceItem: [row("t-a", "acme-a", 2, 0, 0), row("t-b", "acme-b", 1, 1, 1)],
  });
  eq(s.OrderItem.rows, 4, "order total");
  eq(s.OrderItem.boxesNull, 2, "order boxesNull");
  eq(
    s.OrderItem.detail.map((d) => d.tenant),
    ["tenant B", "no tenant"],
    "order labels",
  );
  eq(
    s.InvoiceItem.detail.map((d) => d.tenant),
    ["tenant A", "tenant B"],
    "labels stable across tables",
  );
  const text = JSON.stringify(s);
  if (/acme|t-a|t-b/.test(text)) throw new Error("summary leaked an id or slug");
  if (!censusSql("OrderItem").includes(VIOLATION_SQL)) throw new Error("sql lost the violation");
  let threw = false;
  try {
    censusSql('OrderItem"; SELECT 1; --');
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("censusSql accepted a table outside TABLES");
  return "self-test ok";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const tenantArg = argv.indexOf("--tenant");
  const onlyTenant = tenantArg >= 0 ? argv[tenantArg + 1] : null;
  if (tenantArg >= 0 && !onlyTenant) {
    console.error(`${NAME}: --tenant needs a tenant id`);
    process.exit(2);
  }
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);

  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");

    const live = {};
    const test = {};
    for (const table of TABLES) {
      const { rows } = await client.query(censusSql(table), [onlyTenant]);
      live[table] = rows.filter((r) => !(r.slug && isTestTenant(r.slug)));
      test[table] = rows.filter((r) => r.slug && isTestTenant(r.slug));
    }
    const report = { live: summarize(live), test: summarize(test) };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, byTable] of Object.entries(report)) {
        for (const [table, s] of Object.entries(byTable)) {
          console.log(
            `${block} ${table}: ${s.rows} violating row(s) in ${s.tenants} tenant bucket(s) ` +
              `(boxes NULL ${s.boxesNull}, boxes 0 ${s.boxesZero}; qty 0 ${s.qtyZero}, qty > 0 ${s.qtyPositive}; pieces > 0 ${s.piecesPositive})`,
          );
          for (const d of s.detail)
            console.log(
              `  ${d.tenant}  ${d.rows} (boxes NULL ${d.boxesNull}, 0 ${d.boxesZero}; qty 0 ${d.qtyZero}, > 0 ${d.qtyPositive}; pieces > 0 ${d.piecesPositive})`,
            );
        }
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Run only when invoked directly: importing this module (for `summarize` / `selfTest`) must never
 * start a report. Paths are compared after realpath, case-insensitively on Windows; when only the
 * file NAMES match it warns and runs anyway, because a silent exit 0 reads as "nothing found"
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
