// READ-ONLY diagnostic: census of HTML-entity corruption left behind by the
// StripHtml() transform, which until the fix in this PR persisted sanitize-html's
// entity-encoded output ("Smith & Sons" stored as "Smith &amp; Sons").
//
// For every column a @StripHtml DTO field persists to, counts the rows that
// contain each of the five entities sanitize-html emits (&amp; &lt; &gt;
// &quot; &#39;), grouped per tenant. Never writes anything — there is
// deliberately no --execute mode; the repair script is a separate,
// owner-approved task.
//
// Prod (via the Railway postgres proxy):
//   railway run --service postgres node apps/api/scripts/report-escaped-entities.mjs
// Local (docker-compose / test tenants):
//   DATABASE_URL=postgresql://... node apps/api/scripts/report-escaped-entities.mjs
//
// Optional: REPORT_TENANT_SLUG scopes to one tenant (default: ALL tenants —
// this is a corruption census, so nothing is filtered out).
import { Client } from "pg";

const e = process.env;
let url = e.DATABASE_URL || null;
if (!url) {
  const need = [
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "POSTGRES_DB",
    "RAILWAY_TCP_PROXY_DOMAIN",
    "RAILWAY_TCP_PROXY_PORT",
  ];
  const missing = need.filter((k) => !e[k]);
  if (missing.length) {
    console.error(
      `\nSet DATABASE_URL, or run via the proxy: railway run --service postgres node apps/api/scripts/report-escaped-entities.mjs\n(missing: ${missing.join(", ")})\n`,
    );
    process.exit(1);
  }
  url =
    `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
    `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`;
}

const slug = e.REPORT_TENANT_SLUG || null;

// The five entities sanitize-html's serializer emits (what StripHtml stored).
const ENTITIES = [
  ["amp", "&amp;"],
  ["lt", "&lt;"],
  ["gt", "&gt;"],
  ["quot", "&quot;"],
  ["apos", "&#39;"],
];

// Every (table, column) a @StripHtml DTO field persists to.
//   tenantExpr — SQL expression yielding the owning tenant id, with alias x on
//   the target table (OrderItem rows can carry NULL tenantId, so they resolve
//   tenancy through their Order; BuyerAccount is a global table).
const TARGETS = [
  { table: "Customer", column: "businessName", via: "customer create/update + buyer profile" },
  { table: "Customer", column: "displayName", via: "buyer profile" },
  { table: "Customer", column: "notes", via: "buyer profile" },
  { table: "Order", column: "notes", via: "order/sale create + order-items edit" },
  { table: "Order", column: "shippingCarrier", via: "shipment update" },
  { table: "Order", column: "shippingTrackingNumber", via: "shipment update" },
  {
    table: "OrderItem",
    column: "name",
    via: "custom/renamed order lines",
    join: `JOIN "Order" o ON o.id = x."orderId"`,
    tenantExpr: `o."tenantId"`,
  },
  { table: "Invoice", column: "notes", via: "invoice create" },
  { table: "Invoice", column: "shippingCarrier", via: "copied from order" },
  { table: "Invoice", column: "shippingTrackingNumber", via: "copied from order" },
  { table: "Product", column: "name", via: "new-variant creation" },
  { table: "StockCountSession", column: "name", via: "stock count start" },
  { table: "StockCountSession", column: "notes", via: "stock count commit" },
  { table: "BillPayment", column: "notes", via: "supplier payment / statement apply" },
  { table: "BuyerAccount", column: "name", via: "buyer account update", global: true },
];

const pad = (v, w) => String(v).padStart(w);
const c = new Client({ connectionString: url });

(async () => {
  await c.connect();

  console.log(`\n===== STORED HTML-ENTITY CENSUS (read-only) =====`);
  console.log(`Scope: ${slug ? `tenant ${slug}` : "all tenants"}`);
  console.log(`Counting rows containing: ${ENTITIES.map(([, s]) => s).join("  ")}\n`);

  let grandRows = 0;
  for (const t of TARGETS) {
    if (t.global && slug) {
      console.log(`-- "${t.table}"."${t.column}": skipped (global table, tenant-scoped run)\n`);
      continue;
    }
    // Older databases may predate a table (e.g. a local dev DB behind the
    // migrations) — a census should skip those, not crash.
    const { rows: reg } = await c.query(`SELECT to_regclass($1) AS r`, [`"${t.table}"`]);
    if (!reg[0].r) {
      console.log(`-- "${t.table}"."${t.column}": skipped (table does not exist here)\n`);
      continue;
    }
    const col = `x."${t.column}"`;
    const anyEntity = ENTITIES.map(([, s]) => `${col} LIKE '%${s}%'`).join(" OR ");
    const perEntity = ENTITIES.map(
      ([key, s]) => `COUNT(*) FILTER (WHERE ${col} LIKE '%${s}%')::int AS ${key}`,
    ).join(", ");

    const tenantSelect = t.global
      ? `'(global)' AS tenant`
      : `COALESCE(tn.slug, '(no tenant)') AS tenant`;
    const tenantJoin = t.global
      ? ""
      : `LEFT JOIN "Tenant" tn ON tn.id = ${t.tenantExpr ?? `x."tenantId"`}`;
    const slugFilter = !t.global && slug ? ` AND tn.slug = $1` : "";

    const sql = `
      SELECT ${tenantSelect}, COUNT(*)::int AS rows, ${perEntity}
      FROM "${t.table}" x
      ${t.join ?? ""}
      ${tenantJoin}
      WHERE (${anyEntity})${slugFilter}
      GROUP BY 1 ORDER BY 1`;
    const { rows } = await c.query(sql, slugFilter ? [slug] : []);

    const total = rows.reduce((s, r) => s + r.rows, 0);
    grandRows += total;
    console.log(`-- "${t.table}"."${t.column}"  (written by: ${t.via})  affected rows: ${total}`);
    if (rows.length) {
      console.log(
        `   ${"tenant".padEnd(28)}${pad("rows", 7)}${ENTITIES.map(([k]) => pad(k, 7)).join("")}`,
      );
      for (const r of rows) {
        console.log(
          `   ${String(r.tenant).padEnd(28)}${pad(r.rows, 7)}${ENTITIES.map(([k]) => pad(r[k], 7)).join("")}`,
        );
      }
    }
    console.log("");
  }

  console.log(`===== TOTAL affected rows across all columns: ${grandRows} =====\n`);
  await c.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
