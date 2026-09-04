/**
 * data-integrity-report.mjs — READ-ONLY forensic integrity report.
 *
 * Runs a battery of SELECT/aggregate checks that detect the database footprints
 * of confirmed RouteFlow bugs (see local-assets/docs/routeflow-bug-register.html:
 * B11, B46, B53, B55, B56, B64, B66, B67, B71, B74, B81, B84 ...) plus general
 * corruption (tenant-scope drift, arithmetic drift, orphans, duplicates).
 *
 * SAFE TO RUN AGAINST PRODUCTION:
 *   • The session sets `default_transaction_read_only = on` BEFORE any check
 *     runs, so the server itself rejects any write that might slip in.
 *   • Every query is a SELECT/aggregate; a statement_timeout caps each one.
 *   • No customer names, addresses, emails, or product names are ever printed —
 *     only row IDs, counts, and amounts.
 *
 * Usage:
 *   railway run --service postgres node scripts/data-integrity-report.mjs
 *   node scripts/data-integrity-report.mjs                       # uses $DATABASE_URL
 *   node scripts/data-integrity-report.mjs --tenant <slug>      # single tenant
 *   node scripts/data-integrity-report.mjs --verbose            # list offending IDs
 *
 * Connection: DATABASE_URL from the environment; when run via `railway run
 * --service postgres` (which injects an internal-only DATABASE_URL) the public
 * TCP proxy URL is assembled from the injected POSTGRES_* / RAILWAY_TCP_PROXY_*
 * variables instead. Nothing is ever hardcoded and credentials are never printed.
 *
 * Exit code: non-zero ONLY when a CRITICAL check returns rows (or the run fails).
 *
 * VALIDATION STATUS (Fable adversarial review, Aug 29 2026) — these checks were
 * independently verified against the schema and the services they mirror:
 *   • Forensic check: recurring-duplicate-fire correctly detects B46's midnight re-fire pairs
 *   • Forensic checks: payments-vs-status contradictions mirror recomputeStatus exactly
 *   • Credit-note/advance wallet drift checks sound; dangling-pointer mechanism backwards
 *   • Billing-counter checks valid tripwires, but B84 double-void leaves no negative scar
 *   • Returns exceeding delivered qty — footprint check confirmed against ordered-basis validator
 *   • Tenant-scope drift check confirmed — nullable tenantId class has fired before
 *   • REFUTED: stock-vs-last-movement — the invariant is false by design (movements do not
 *     reconstruct currentStock), so it floods with false positives. B55/B64 are real but
 *     not detectable via that footprint. (Confirmed in prod: 315 rows = noise.)
 *   • B48 (F13): template-order-list-price-vs-tier is CURRENT-basis (tier/override as of now;
 *     promotion-based overcharges are unrecoverable) — read it beside
 *     order-list-price-vs-tier-any (positive control) and f13-gate-state (rows = closed gates).
 *
 */
import pg from "pg";

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose");
const tenantIdx = argv.indexOf("--tenant");
const TENANT_SLUG = tenantIdx >= 0 ? argv[tenantIdx + 1] : null;
if (tenantIdx >= 0 && !TENANT_SLUG) {
  console.error("--tenant requires a slug argument");
  process.exit(2);
}
const VERBOSE_ID_LIMIT = 50;

// ─── Connection resolution (mirrors apps/api/scripts/prod-readonly-audit.mjs) ─
function resolveUrl() {
  const direct = process.env.DATABASE_URL;
  if (direct && !direct.includes(".railway.internal")) return direct;
  const {
    POSTGRES_USER,
    POSTGRES_PASSWORD,
    POSTGRES_DB,
    RAILWAY_TCP_PROXY_DOMAIN,
    RAILWAY_TCP_PROXY_PORT,
  } = process.env;
  if (RAILWAY_TCP_PROXY_DOMAIN && POSTGRES_USER && POSTGRES_PASSWORD) {
    const db = POSTGRES_DB || "railway";
    const port = RAILWAY_TCP_PROXY_PORT || "5432";
    return `postgresql://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(
      POSTGRES_PASSWORD,
    )}@${RAILWAY_TCP_PROXY_DOMAIN}:${port}/${db}`;
  }
  return direct || null;
}

const url = resolveUrl();
if (!url) {
  console.error(
    "No usable connection string. Set DATABASE_URL, or run via:\n" +
      "  railway run --service postgres node scripts/data-integrity-report.mjs",
  );
  process.exit(2);
}

const client = new pg.Client({ connectionString: url });

/**
 * Check definition contract:
 *   name        short identifier printed in the summary table
 *   severity    critical | high | medium | low  (critical rows ⇒ non-zero exit)
 *   explain     one line: what a returned row MEANS
 *   sql(t)      returns the SELECT; `t` is "" (no filter) or an "AND ..." clause
 *               referencing $1 = tenant id. First column MUST be the row id;
 *               additional numeric columns are shown in --verbose.
 *   skipWithTenant  optional: check is meaningless under a tenant filter
 */
const CHECKS = [
  // ── Payments vs invoices ───────────────────────────────────────────────────
  {
    name: "invoice-overpaid",
    severity: "critical",
    explain: "non-VOID payments exceed the invoice total (money double-counted)",
    sql: (t) => `
      SELECT i.id, i.total::float8 AS total, p.paid::float8 AS paid
      FROM "Invoice" i
      JOIN (
        SELECT "invoiceId", SUM(amount) AS paid
        FROM "InvoicePayment" WHERE status <> 'VOID' GROUP BY 1
      ) p ON p."invoiceId" = i.id
      WHERE i.status <> 'VOID' ${t.replace(/x\./g, "i.")}
        AND p.paid > i.total + 0.01`,
  },
  {
    name: "invoice-paid-with-balance",
    severity: "critical",
    explain: "status PAID but non-VOID payments < total (invoice lies as settled — B74/B84 family)",
    sql: (t) => `
      SELECT i.id, i.total::float8 AS total, COALESCE(p.paid, 0)::float8 AS paid
      FROM "Invoice" i
      LEFT JOIN (
        SELECT "invoiceId", SUM(amount) AS paid
        FROM "InvoicePayment" WHERE status <> 'VOID' GROUP BY 1
      ) p ON p."invoiceId" = i.id
      WHERE i.status = 'PAID' ${t.replace(/x\./g, "i.")}
        AND COALESCE(p.paid, 0) < i.total - 0.01`,
  },
  {
    name: "invoice-unpaid-with-payments",
    severity: "high",
    explain:
      "status SENT/VIEWED/OVERDUE yet carries non-VOID payments (status never recomputed — B74/B76)",
    sql: (t) => `
      SELECT i.id, i.status::text, p.paid::float8 AS paid
      FROM "Invoice" i
      JOIN (
        SELECT "invoiceId", SUM(amount) AS paid
        FROM "InvoicePayment" WHERE status <> 'VOID' GROUP BY 1
      ) p ON p."invoiceId" = i.id
      WHERE i.status IN ('SENT','VIEWED','OVERDUE') ${t.replace(/x\./g, "i.")}
        AND p.paid > 0.01`,
  },
  {
    name: "payment-stuck-draft",
    severity: "critical",
    explain:
      "DRAFT InvoicePayment older than 7 days — money recorded but invisible everywhere (B11)",
    sql: (t) => `
      SELECT x.id, x.amount::float8 AS amount
      FROM "InvoicePayment" x
      WHERE x.status = 'DRAFT' ${t}
        AND x."createdAt" < now() - interval '7 days'`,
  },
  {
    name: "payment-on-dead-invoice",
    severity: "critical",
    explain:
      "non-VOID CREDIT_NOTE/ADVANCE payment applied to a VOID or WRITTEN_OFF invoice (B66/B67)",
    sql: (t) => `
      SELECT x.id, x.amount::float8 AS amount, i.status::text AS invoice_status
      FROM "InvoicePayment" x
      JOIN "Invoice" i ON i.id = x."invoiceId"
      WHERE x.status <> 'VOID' ${t}
        AND x.method IN ('CREDIT_NOTE','ADVANCE')
        AND i.status IN ('VOID','WRITTEN_OFF')`,
  },
  // ── Invoice arithmetic ─────────────────────────────────────────────────────
  {
    name: "invoice-header-math",
    severity: "high",
    explain: "stored total ≠ subtotal − discount + tax + shipping (header math drift)",
    sql: (t) => `
      SELECT i.id, i.total::float8 AS total,
             (i.subtotal - i.discount + i."taxAmount" + i."shippingFee")::float8 AS computed
      FROM "Invoice" i
      WHERE i.status <> 'VOID' ${t.replace(/x\./g, "i.")}
        AND abs(i.total - (i.subtotal - i.discount + i."taxAmount" + i."shippingFee")) > 0.02`,
  },
  {
    name: "invoice-lines-vs-subtotal",
    severity: "high",
    explain: "stored subtotal ≠ Σ line subtotals (a line edit that never re-summed the header)",
    sql: (t) => `
      SELECT i.id, i.subtotal::float8 AS header, s.line_sum::float8 AS line_sum
      FROM "Invoice" i
      JOIN (
        SELECT "invoiceId", SUM(subtotal) AS line_sum FROM "InvoiceItem" GROUP BY 1
      ) s ON s."invoiceId" = i.id
      WHERE i.status <> 'VOID' ${t.replace(/x\./g, "i.")}
        AND abs(i.subtotal - s.line_sum) > 0.02`,
  },
  {
    name: "invoice-number-dup-null-tenant",
    severity: "high",
    explain: "duplicate invoiceNumber among tenantId-NULL rows (the unique index can't see NULLs)",
    skipWithTenant: true,
    sql: () => `
      SELECT MIN(id) AS id, COUNT(*)::int AS copies
      FROM "Invoice"
      WHERE "tenantId" IS NULL
      GROUP BY "invoiceNumber"
      HAVING COUNT(*) > 1`,
  },
  // ── Orders / billing bookkeeping ───────────────────────────────────────────
  {
    name: "orderitem-overbilled",
    severity: "critical",
    explain: "invoicedQty exceeds ordered qty (billing bookkeeping overran the line)",
    sql: (t) => `
      SELECT x.id, x.qty::float8 AS ordered, x."invoicedQty"::float8 AS invoiced
      FROM "OrderItem" x
      WHERE x."invoicedQty" > x.qty + 0.001 ${t}`,
  },
  {
    name: "orderitem-invoicedqty-underrun",
    severity: "critical",
    explain:
      "live (non-VOID) invoice lines bill MORE than the line's invoicedQty records — double-billing or a double-void release (B84)",
    sql: (t) => `
      SELECT x.id, x."invoicedQty"::float8 AS recorded, b.billed::float8 AS live_billed
      FROM "OrderItem" x
      JOIN (
        SELECT ii."orderItemId", SUM(ii.qty) AS billed
        FROM "InvoiceItem" ii
        JOIN "Invoice" iv ON iv.id = ii."invoiceId"
        WHERE ii."orderItemId" IS NOT NULL AND iv.status <> 'VOID'
        GROUP BY 1
      ) b ON b."orderItemId" = x.id
      WHERE b.billed > x."invoicedQty" + 0.001 ${t}`,
  },
  {
    name: "orderitem-negative-counters",
    severity: "high",
    explain: "negative invoicedQty or deliveredQty (a release/compensation ran twice)",
    sql: (t) => `
      SELECT x.id, x."invoicedQty"::float8 AS invoiced, x."deliveredQty"::float8 AS delivered
      FROM "OrderItem" x
      WHERE (x."invoicedQty" < -0.001 OR x."deliveredQty" < -0.001) ${t}`,
  },
  {
    name: "cancelled-order-delivered-goods",
    severity: "critical",
    explain: "CANCELLED order with deliveredQty > 0 — goods handed over, revenue voided (B56)",
    sql: (t) => `
      SELECT o.id, SUM(oi."deliveredQty")::float8 AS delivered_units
      FROM "Order" o
      JOIN "OrderItem" oi ON oi."orderId" = o.id
      WHERE o.status = 'CANCELLED' ${t.replace(/x\./g, "o.")}
      GROUP BY o.id
      HAVING SUM(oi."deliveredQty") > 0.001`,
  },
  // ── Returns ────────────────────────────────────────────────────────────────
  {
    name: "return-exceeds-delivered",
    severity: "high",
    explain:
      "returned qty > delivered qty for an order line (returns validated against ORDERED qty — B53)",
    sql: (t) => `
      WITH ret AS (
        SELECT r."orderId", ri."productId", SUM(ri.qty) AS returned
        FROM "ReturnItem" ri
        JOIN "Return" r ON r.id = ri."returnId"
        WHERE r.status NOT IN ('CANCELLED','REJECTED') ${t.replace(/x\./g, "r.")}
        GROUP BY 1, 2
      ),
      del AS (
        SELECT oi."orderId", oi."productId",
               SUM(oi."deliveredQty") AS delivered, SUM(oi.qty) AS ordered
        FROM "OrderItem" oi
        WHERE oi."productId" IS NOT NULL
        GROUP BY 1, 2
      )
      SELECT (ret."orderId" || ':' || ret."productId") AS id,
             ret.returned::float8, del.delivered::float8, del.ordered::float8
      FROM ret
      JOIN del ON del."orderId" = ret."orderId" AND del."productId" = ret."productId"
      WHERE ret.returned > del.delivered + 0.001`,
  },
  {
    name: "return-exceeds-ordered",
    severity: "critical",
    explain:
      "returned qty > ORDERED qty for an order line (even the buggy validator should stop this)",
    sql: (t) => `
      WITH ret AS (
        SELECT r."orderId", ri."productId", SUM(ri.qty) AS returned
        FROM "ReturnItem" ri
        JOIN "Return" r ON r.id = ri."returnId"
        WHERE r.status NOT IN ('CANCELLED','REJECTED') ${t.replace(/x\./g, "r.")}
        GROUP BY 1, 2
      ),
      del AS (
        SELECT oi."orderId", oi."productId", SUM(oi.qty) AS ordered
        FROM "OrderItem" oi
        WHERE oi."productId" IS NOT NULL
        GROUP BY 1, 2
      )
      SELECT (ret."orderId" || ':' || ret."productId") AS id,
             ret.returned::float8, del.ordered::float8
      FROM ret
      JOIN del ON del."orderId" = ret."orderId" AND del."productId" = ret."productId"
      WHERE ret.returned > del.ordered + 0.001`,
  },
  {
    name: "return-dangling-creditnote",
    severity: "high",
    explain:
      "Return.creditNoteId points at a credit note that does not exist (no FK backs this column)",
    sql: (t) => `
      SELECT x.id, x."refundAmount"::float8 AS refund_amount
      FROM "Return" x
      LEFT JOIN "CreditNote" cn ON cn.id = x."creditNoteId"
      WHERE x."creditNoteId" IS NOT NULL AND cn.id IS NULL ${t}`,
  },
  // ── Credit notes / advances (wallet truth) ─────────────────────────────────
  {
    name: "creditnote-overdrawn",
    severity: "critical",
    explain:
      "amountUsed exceeds the note's amount (wallet gave out more credit than issued — B66/B81)",
    sql: (t) => `
      SELECT x.id, x.amount::float8, x."amountUsed"::float8 AS used
      FROM "CreditNote" x
      WHERE x."amountUsed" > x.amount + 0.01 ${t}`,
  },
  {
    name: "creditnote-used-drift",
    severity: "high",
    explain:
      "amountUsed disagrees with Σ live CREDIT_NOTE payments referencing the note (B68/B81/B85 footprint)",
    sql: (t) => `
      SELECT x.id, x."amountUsed"::float8 AS used, COALESCE(p.applied, 0)::float8 AS applied
      FROM "CreditNote" x
      LEFT JOIN (
        SELECT "creditNoteId", SUM(amount) AS applied
        FROM "InvoicePayment"
        WHERE status <> 'VOID' AND "creditNoteId" IS NOT NULL
        GROUP BY 1
      ) p ON p."creditNoteId" = x.id
      WHERE abs(x."amountUsed" - COALESCE(p.applied, 0)) > 0.01 ${t}`,
  },
  {
    name: "advance-balance-drift",
    severity: "critical",
    explain:
      "AdvancePayment.balance ≠ amount − Σ live applications (customer wallet corrupted — B81)",
    sql: (t) => `
      SELECT x.id, x.amount::float8, x.balance::float8,
             (x.amount - COALESCE(p.applied, 0))::float8 AS computed
      FROM "AdvancePayment" x
      LEFT JOIN (
        SELECT "advancePaymentId", SUM(amount) AS applied
        FROM "InvoicePayment"
        WHERE status <> 'VOID' AND "advancePaymentId" IS NOT NULL
        GROUP BY 1
      ) p ON p."advancePaymentId" = x.id
      WHERE abs(x.balance - (x.amount - COALESCE(p.applied, 0))) > 0.01 ${t}`,
  },
  // ── Inventory ──────────────────────────────────────────────────────────────
  {
    name: "product-negative-stock",
    severity: "high",
    explain: "currentStock below zero (oversell or a decrement that ran twice)",
    sql: (t) => `
      SELECT x.id, x."currentStock"::float8 AS stock
      FROM "Product" x
      WHERE x."currentStock" < -0.001 ${t}`,
  },
  {
    name: "stock-vs-last-movement",
    severity: "high",
    explain:
      "currentStock ≠ latest movement's stockAfter snapshot (stock written without a movement — B55/B64 footprint)",
    sql: (t) => `
      SELECT p.id, p."currentStock"::float8 AS stock, m."stockAfter"::float8 AS snapshot
      FROM "Product" p
      JOIN LATERAL (
        SELECT "stockAfter"
        FROM "StockMovement"
        WHERE "productId" = p.id
        ORDER BY "createdAt" DESC, id DESC
        LIMIT 1
      ) m ON true
      WHERE m."stockAfter" IS NOT NULL ${t.replace(/x\./g, "p.")}
        AND abs(p."currentStock" - m."stockAfter") > 0.001`,
  },
  // ── Recurring invoices (B46) ───────────────────────────────────────────────
  {
    name: "recurring-duplicate-fire",
    severity: "critical",
    explain:
      "two invoices from one template closer together than its frequency allows (midnight re-fire — B46)",
    sql: (t) => `
      WITH inv AS (
        SELECT i.id, r.frequency, i."createdAt",
               lag(i."createdAt") OVER (
                 PARTITION BY i."recurringInvoiceId" ORDER BY i."createdAt", i.id
               ) AS prev
        FROM "Invoice" i
        JOIN "RecurringInvoice" r ON r.id = i."recurringInvoiceId"
        WHERE i."recurringInvoiceId" IS NOT NULL AND i.status <> 'VOID' ${t.replace(/x\./g, "i.")}
      )
      SELECT id, extract(epoch FROM ("createdAt" - prev)) / 3600.0 AS hours_since_prev
      FROM inv
      WHERE prev IS NOT NULL
        AND ("createdAt" - prev) < (CASE frequency
              WHEN 'WEEKLY'   THEN interval '5 days'
              WHEN 'BIWEEKLY' THEN interval '12 days'
              WHEN 'MONTHLY'  THEN interval '25 days'
            END)`,
  },
  {
    name: "recurring-stalled",
    severity: "medium",
    explain: "active template whose nextRunAt is > 3 days past (cron missed it or died)",
    sql: (t) => `
      SELECT x.id, extract(day FROM (now() - x."nextRunAt"))::int AS days_overdue
      FROM "RecurringInvoice" x
      WHERE x."isActive" = true ${t}
        AND x."nextRunAt" < now() - interval '3 days'`,
  },
  // ── Standing-order pricing (B48, F13) ───────────────────────────────────────
  {
    name: "template-order-list-price-vs-tier",
    severity: "high",
    explain:
      "template-generated line billed at the CURRENT list price while the customer's CURRENT tier/override price differs (B48 overcharge candidates — current-basis; promotions unrecoverable)",
    sql: (t) => `
      SELECT li.id, o.id AS order_id, o.status::text AS order_status,
             li."unitPrice"::float8 AS billed, tp.tier_price::float8 AS tier_price,
             (li."unitPrice" - tp.tier_price)::float8 AS delta_per_unit, li.qty::float8 AS qty
      FROM "OrderItem" li
      JOIN "Order" o ON o.id = li."orderId"
      JOIN "Product" p ON p.id = li."productId"
      JOIN "Customer" c ON c.id = o."customerId"
      LEFT JOIN "CustomerPrice" cp ON cp."customerId" = c.id AND cp."productId" = p.id
      CROSS JOIN LATERAL (
        SELECT CASE COALESCE(cp."pricingTier", c."pricingTier", 1)
                 WHEN 2 THEN p."priceTier2" WHEN 3 THEN p."priceTier3"
                 WHEN 4 THEN p."priceTier4" WHEN 5 THEN p."priceTier5"
                 ELSE p."pricePerUnit" END AS tier_price
      ) tp
      WHERE o."templateId" IS NOT NULL
        AND li.status <> 'CANCELLED'
        AND li."priceType" = 'STANDARD'
        AND abs(li."unitPrice" - p."pricePerUnit") <= 0.005
        AND tp.tier_price > 0
        AND abs(li."unitPrice" - tp.tier_price) > 0.005 ${t.replace(/x\./g, "o.")}`,
  },
  {
    name: "order-list-price-vs-tier-any",
    severity: "info",
    explain:
      "POSITIVE CONTROL for the check above: the same arithmetic over ALL orders — expected > 0 on any tenant with tiered customers; if this is ALSO 0, distrust the predicate, not the data",
    sql: (t) => `
      SELECT li.id, o.id AS order_id, li."unitPrice"::float8 AS billed, tp.tier_price::float8 AS tier_price
      FROM "OrderItem" li
      JOIN "Order" o ON o.id = li."orderId"
      JOIN "Product" p ON p.id = li."productId"
      JOIN "Customer" c ON c.id = o."customerId"
      LEFT JOIN "CustomerPrice" cp ON cp."customerId" = c.id AND cp."productId" = p.id
      CROSS JOIN LATERAL (
        SELECT CASE COALESCE(cp."pricingTier", c."pricingTier", 1)
                 WHEN 2 THEN p."priceTier2" WHEN 3 THEN p."priceTier3"
                 WHEN 4 THEN p."priceTier4" WHEN 5 THEN p."priceTier5"
                 ELSE p."pricePerUnit" END AS tier_price
      ) tp
      WHERE li.status <> 'CANCELLED'
        AND li."priceType" = 'STANDARD'
        AND abs(li."unitPrice" - p."pricePerUnit") <= 0.005
        AND tp.tier_price > 0
        AND abs(li."unitPrice" - tp.tier_price) > 0.005 ${t.replace(/x\./g, "o.")}`,
  },
  {
    name: "f13-gate-state",
    severity: "info",
    explain:
      "each row is a CLOSED gate for the B46/B48 checks (recurring-duplicate-fire, template-order-list-price-vs-tier): a 0-row result on those is only evidence of no damage while THIS returns 0 rows",
    sql: (t) => `
      SELECT g.id, g.n
      FROM (
        SELECT 'monthly-templates-ever-run' AS id,
               (SELECT count(*) FROM "RecurringInvoice" x
                 WHERE x.frequency = 'MONTHLY' AND x."lastRunAt" IS NOT NULL ${t})::int AS n
        UNION ALL
        SELECT 'template-generated-orders',
               (SELECT count(*) FROM "Order" x WHERE x."templateId" IS NOT NULL ${t})::int
        UNION ALL
        SELECT 'template-orders-for-tiered-or-override-customers',
               (SELECT count(*) FROM "Order" x
                 JOIN "Customer" c ON c.id = x."customerId"
                 WHERE x."templateId" IS NOT NULL ${t}
                   AND (c."pricingTier" <> 1 OR EXISTS (
                     SELECT 1 FROM "CustomerPrice" cp
                     WHERE cp."customerId" = c.id AND cp."pricingTier" IS NOT NULL)))::int
      ) g
      WHERE g.n = 0`,
  },
  // ── Routes / delivery record honesty ───────────────────────────────────────
  {
    name: "stop-completed-no-timestamp",
    severity: "high",
    explain:
      "COMPLETED stop with no completedAt (the delivery record lies about when — B34/B71 family)",
    sql: (t) => `
      SELECT x.id
      FROM "RouteRunStop" x
      WHERE x.status = 'COMPLETED' AND x."completedAt" IS NULL ${t}`,
  },
  {
    name: "delivered-order-skipped-stop",
    severity: "high",
    explain: "DELIVERED order whose route stop is SKIPPED (the COMPLETED→SKIPPED flip fired — B71)",
    sql: (t) => `
      SELECT o.id
      FROM "Order" o
      JOIN "RouteRunStop" s ON s.id = o."routeRunStopId"
      WHERE o.status = 'DELIVERED' AND s.status = 'SKIPPED' ${t.replace(/x\./g, "o.")}`,
  },
  // ── Tenant-scope hygiene ───────────────────────────────────────────────────
  ...[
    ["InvoiceItem", "Invoice", "invoiceId"],
    ["InvoicePayment", "Invoice", "invoiceId"],
    ["OrderItem", "Order", "orderId"],
    ["ReturnItem", "Return", "returnId"],
    ["Return", "Order", "orderId"],
    ["StockMovement", "Product", "productId"],
  ].map(([child, parent, fk]) => ({
    name: `tenant-drift-${child.toLowerCase()}`,
    severity: "high",
    explain: `${child}.tenantId NULL or ≠ its ${parent}'s tenantId (rows invisible to forTenant() scoping)`,
    sql: (t) => `
      SELECT c.id
      FROM "${child}" c
      JOIN "${parent}" p ON p.id = c."${fk}"
      WHERE p."tenantId" IS NOT NULL
        AND (c."tenantId" IS NULL OR c."tenantId" <> p."tenantId")
        ${t.replace(/x\./g, "p.")}`,
  })),
];

// ─── Runner ──────────────────────────────────────────────────────────────────
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  await client.connect();
  // Hard read-only guarantee + query cap, before anything else runs.
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = '60s'");

  let tenantId = null;
  if (TENANT_SLUG) {
    const r = await client.query(`SELECT id FROM "Tenant" WHERE slug = $1`, [TENANT_SLUG]);
    if (!r.rows.length) {
      console.error(`Tenant slug not found: ${TENANT_SLUG}`);
      process.exit(2);
    }
    tenantId = r.rows[0].id;
  }

  console.log(`\n=== ROUTEFLOW DATA-INTEGRITY REPORT (read-only) ===`);
  console.log(`    scope: ${TENANT_SLUG ? `tenant "${TENANT_SLUG}"` : "ALL tenants"}`);
  console.log(`    ${new Date().toISOString()}\n`);

  const results = [];
  let criticalHits = 0;

  for (const check of CHECKS) {
    if (tenantId && check.skipWithTenant) {
      results.push({ ...check, count: "skip", note: "not applicable with --tenant" });
      continue;
    }
    const tenantClause = tenantId ? `AND x."tenantId" = $1` : "";
    const params = tenantId ? [tenantId] : [];
    try {
      const res = await client.query(check.sql(tenantClause), params);
      const count = res.rows.length;
      results.push({ ...check, count, rows: res.rows });
      if (count > 0 && check.severity === "critical") criticalHits += count;
    } catch (err) {
      results.push({ ...check, count: "ERR", note: err.message.split("\n")[0] });
    }
  }

  // Summary table
  console.log(pad("CHECK", 36) + pad("SEVERITY", 10) + pad("ROWS", 8) + "EXPLANATION");
  console.log("-".repeat(110));
  for (const r of results) {
    const flag = typeof r.count === "number" && r.count > 0 ? " <<<" : "";
    console.log(
      pad(r.name, 36) +
        pad(r.severity, 10) +
        pad(r.count, 8) +
        (r.note ? `[${r.note}] ` : "") +
        r.explain +
        flag,
    );
  }

  if (VERBOSE) {
    console.log(
      "\n--- VERBOSE: offending rows (IDs/amounts only, capped at " +
        VERBOSE_ID_LIMIT +
        " per check) ---",
    );
    for (const r of results) {
      if (typeof r.count !== "number" || r.count === 0) continue;
      console.log(`\n[${r.severity}] ${r.name} (${r.count} rows):`);
      for (const row of r.rows.slice(0, VERBOSE_ID_LIMIT)) {
        // Print only whitelisted shapes: the id plus numeric/status columns the
        // check itself selected. No names/emails/addresses are ever selected.
        const rest = Object.entries(row)
          .filter(([k]) => k !== "id")
          .map(([k, v]) => `${k}=${v}`)
          .join("  ");
        console.log(`  ${row.id}${rest ? "  " + rest : ""}`);
      }
      if (r.count > VERBOSE_ID_LIMIT) console.log(`  ... and ${r.count - VERBOSE_ID_LIMIT} more`);
    }
  }

  const errored = results.filter((r) => r.count === "ERR").length;
  console.log(
    `\n=== DONE — ${results.length} checks, ` +
      `${results.filter((r) => typeof r.count === "number" && r.count > 0).length} with findings, ` +
      `${criticalHits} CRITICAL rows${errored ? `, ${errored} checks errored` : ""} ===\n`,
  );

  process.exitCode = criticalHits > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("Report failed:", err.message);
    process.exitCode = 2;
  })
  .finally(() => client.end());
