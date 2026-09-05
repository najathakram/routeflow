/**
 * READ-ONLY blast-radius report for one `@RequireAddon` gate key — for every tenant that has
 * PRIOR usage of the gated feature, shows whether it holds an active grant and how many such
 * tenants would be denied the moment the key's registry row (`addon-gate-registry.ts`) flips
 * from `dark` to `enforced`.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs this, once per key, right before a
 * flip decision:
 *
 *   railway run --service postgres node apps/api/scripts/report-addon-gate-blast-radius.mjs --addon ocr
 *
 * Usage evidence for `ocr` (the only key with a modeled activity signal today) is the UNION of
 * three read-only sources, because no single table covers all four gated routes:
 *   - `InvoiceScan` — the archive `VendorBillsService.scanInvoice` leaves, so it covers the
 *     vendor-bill scan route and the batch-import scan route that delegates to it.
 *   - `SupplierStatementScan` — the mirror archive the supplier-statement scan route leaves.
 *   - `AiUsageEvent` rows whose `feature` is the key or `<key>.*` — the only per-call trace the
 *     bookkeeping expense-receipt extraction leaves, and a trace every gated route emits.
 * The two archives reach back before AI metering shipped (#475); `AiUsageEvent` covers every
 * gated route since. The sources overlap on purpose (one vendor-bill scan leaves both an
 * `InvoiceScan` row and an `ocr.vendor_bill` event), so `usage` is evidence weight, not a count
 * of distinct scans; a tenant is counted in `wouldBeDenied` when usage > 0 and it holds no
 * active grant row. For any other key this script prints the active-grant list alone and says so.
 *
 * SAFETY (this script must never be able to touch a client database):
 *   - `default_transaction_read_only = on` is set on the session before any other query runs, so
 *     the server itself rejects a write even if one slipped past review.
 *   - `statement_timeout` caps every query.
 *   - No transaction is left open; the connection is closed in `finally`.
 *   - Only SELECT queries appear below. Tenant slugs land in the owner's terminal output only —
 *     never hardcoded here.
 */
import { createRequire } from "module";
const { Client } = createRequire(import.meta.url)("pg");

function parseArgs(argv) {
  let addon = "ocr";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--addon") {
      addon = argv[++i];
    } else if (arg.startsWith("--addon=")) {
      addon = arg.slice("--addon=".length);
    } else if (arg === "--json") {
      json = true;
    }
  }
  return { addon, json };
}

const { addon, json } = parseArgs(process.argv.slice(2));

// Fail closed BEFORE any connection is attempted — a missing DATABASE_URL must never fall
// through to a driver-level connection error.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    "DATABASE_URL is required and not set. Run via " +
      "`railway run --service postgres node apps/api/scripts/report-addon-gate-blast-radius.mjs --addon <key>`.",
  );
  process.exit(1);
}

const host = (() => {
  try {
    const u = new URL(databaseUrl);
    return `${u.host}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return "unparseable";
  }
})();

const client = new Client({ connectionString: databaseUrl });
const q = async (sql, params) => (await client.query(sql, params)).rows;

/**
 * Only `ocr` has a modeled per-call usage signal today (see file header). Every table name the
 * usage rollup interpolates comes from THIS whitelist — never from argv.
 */
const USAGE_SOURCES = {
  ocr: { featurePrefix: "ocr", archiveTables: ["InvoiceScan", "SupplierStatementScan"] },
};

async function main() {
  await client.connect();

  // Hard read-only guarantee + query cap, before anything else runs.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '45s'");

  if (!json) {
    console.log(`\n=== ADDON GATE BLAST RADIUS — "${addon}" — ${host} ===`);
    console.log("    session is READ ONLY; no writes are possible\n");
  }

  const activeRows = await q(
    `SELECT t.id, t.slug
       FROM "TenantAddon" a
       JOIN "Tenant" t ON t.id = a."tenantId"
      WHERE a."addonKey" = $1 AND a.active = true
      ORDER BY t.slug ASC`,
    [addon],
  );
  const activeByTenant = new Map(activeRows.map((r) => [r.id, r]));

  const usageSource = USAGE_SOURCES[addon];
  const usageModeled = Boolean(usageSource);
  let usageByTenant = new Map();
  if (usageModeled) {
    const sourceSelects = usageSource.archiveTables.map(
      (table) =>
        `SELECT s."tenantId" AS tid, COUNT(*)::int AS n, MAX(s."createdAt") AS last
           FROM "${table}" s
          WHERE s."tenantId" IS NOT NULL
          GROUP BY s."tenantId"`,
    );
    sourceSelects.push(
      `SELECT e."tenantId" AS tid, COUNT(*)::int AS n, MAX(e."createdAt") AS last
         FROM "AiUsageEvent" e
        WHERE e."tenantId" IS NOT NULL AND (e.feature = $1 OR e.feature LIKE $1 || '.%')
        GROUP BY e."tenantId"`,
    );
    const usageRows = await q(
      `SELECT t.id, t.slug, SUM(u.n)::int AS usage, MAX(u.last) AS "lastUsedAt"
         FROM (${sourceSelects.join(" UNION ALL ")}) u
         JOIN "Tenant" t ON t.id = u.tid
        GROUP BY t.id, t.slug`,
      [usageSource.featurePrefix],
    );
    usageByTenant = new Map(usageRows.map((r) => [r.id, r]));
  }

  const tenantIds = new Set([...activeByTenant.keys(), ...usageByTenant.keys()]);
  const rows = [...tenantIds]
    .map((id) => {
      const active = activeByTenant.get(id);
      const usage = usageByTenant.get(id);
      return {
        slug: active?.slug ?? usage?.slug ?? id,
        usage: usage ? usage.usage : usageModeled ? 0 : null,
        lastUsedAt: usage ? usage.lastUsedAt : null,
        activeRow: Boolean(active),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const wouldBeDenied = usageModeled
    ? rows.filter((r) => (r.usage ?? 0) > 0 && !r.activeRow).length
    : null;

  if (json) {
    console.log(
      JSON.stringify(
        {
          addon,
          usageModeled,
          rows,
          wouldBeDeniedOnFlip: wouldBeDenied,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!usageModeled) {
    console.log(
      `Usage evidence is not modeled for addon "${addon}" — listing tenants with an active grant only.\n`,
    );
  }
  console.table(
    rows.map((r) => ({
      slug: r.slug,
      usage: r.usage ?? "n/a",
      lastUsedAt: r.lastUsedAt ?? "",
      activeRow: r.activeRow ? "yes" : "no",
    })),
  );

  if (usageModeled) {
    console.log(
      `\n${wouldBeDenied} tenant(s) with prior usage and no active row would be denied on flip.\n`,
    );
  }

  console.log("=== END — session was read-only; nothing was modified ===\n");
}

main()
  .catch((e) => {
    console.error("blast-radius report failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => client.end());
