/**
 * READ-ONLY count for #2197 / R-030: how many invoices already carry an `issueDate` that is NOT the
 * UTC-midnight symbolic stamp of a calendar day (i.e. it has a time component). Before #2197,
 * InvoicesService.create()/update() stored a client datetime raw, so such rows can exist; #2197 stops
 * new ones and does not rewrite old ones. Count 0 means nothing to decide; > 0 is its own owner
 * ruling (R-030: no backfill without one).
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run`
 * authorization (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-b2197-issuedate-time-component.mjs [--json]
 *
 * Output is COUNTS ONLY plus anonymous labels ("tenant A", "tenant B", …): no tenant id, slug, name
 * or invoice number is printed. Test tenants (scripts/lib/test-tenants.cjs) are counted in a separate
 * `test` block. `--tenant <id>` limits the count to one tenant (DB-lane use only).
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
const { Client } = require("pg");
const { isTestTenant } = require("../../../scripts/lib/test-tenants.cjs");

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const s = summarize([
    { tenantId: "b", slug: "x", rows: 2, drafts: 1 },
    { tenantId: "a", slug: "y", rows: 3, drafts: 0 },
  ]);
  eq(s.tenants, 2, "tenants");
  eq(s.invoices, 5, "invoices");
  eq(s.drafts, 1, "drafts");
  eq(
    s.detail.map((d) => d.tenant),
    ["tenant A", "tenant B"],
    "labels",
  );
  if (JSON.stringify(s).includes('"x"') || JSON.stringify(s).includes('"y"'))
    throw new Error("summary leaked a slug");
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
    console.error("report-b2197-issuedate-time-component: --tenant needs a tenant id");
    process.exit(2);
  }
  const databaseUrl = resolveReportDbUrl("report-b2197-issuedate-time-component");
  if (!databaseUrl) process.exit(2);

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");

    const { rows } = await client.query(
      `SELECT i."tenantId", t.slug,
              COUNT(*)::int AS rows,
              COUNT(*) FILTER (WHERE i.status = 'DRAFT')::int AS drafts
         FROM "Invoice" i
         JOIN "Tenant" t ON t.id = i."tenantId"
        WHERE i."issueDate" IS NOT NULL
          AND i."issueDate" <> date_trunc('day', i."issueDate")
          AND ($1::text IS NULL OR i."tenantId" = $1::text)
        GROUP BY i."tenantId", t.slug
        ORDER BY i."tenantId"`,
      [onlyTenant],
    );

    const report = {
      live: summarize(rows.filter((r) => !isTestTenant(r.slug))),
      test: summarize(rows.filter((r) => isTestTenant(r.slug))),
    };
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      for (const [block, s] of Object.entries(report)) {
        console.log(
          `${block}: ${s.invoices} invoice(s) with a time component across ${s.tenants} tenant(s) (${s.drafts} DRAFT)`,
        );
        for (const g of s.detail)
          console.log(`  ${g.tenant}  ${g.rows} invoice(s), ${g.drafts} DRAFT`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Anonymous per-tenant labels (A, B, …) in tenantId order; ids and slugs never leave this function. */
export function summarize(rows) {
  const label = new Map();
  const detail = rows.map((r) => {
    if (!label.has(r.tenantId))
      label.set(
        r.tenantId,
        `tenant ${String.fromCharCode(65 + (label.size % 26))}${label.size >= 26 ? Math.floor(label.size / 26) : ""}`,
      );
    return { tenant: label.get(r.tenantId), rows: r.rows, drafts: r.drafts };
  });
  return {
    tenants: label.size,
    invoices: rows.reduce((n, r) => n + r.rows, 0),
    drafts: rows.reduce((n, r) => n + r.drafts, 0),
    detail,
  };
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
      `report-b2197-issuedate-time-component: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  main().catch((e) => {
    console.error(`report-b2197-issuedate-time-component: ${e.message}`);
    process.exit(1);
  });
}
