// READ-ONLY prod diagnostic: list every order whose total no longer matches the
// sum of its non-void invoices, with a per-line comparison so an operator can
// decide which side (order or invoice) holds the correct, agreed price.
//
// Never writes anything. Run against the Railway prod DB via the postgres proxy:
//   railway run --service postgres node apps/api/scripts/order-invoice-divergence-report.mjs
//
// Optional: set REPORT_TENANT_SLUG to scope to one tenant (default: all ACTIVE
// tenants, i.e. excludes READ_ONLY test tenants like ux-audit).
import { Client } from "pg";

const e = process.env;
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
    `\nMissing env: ${missing.join(", ")}\nRun via: railway run --service postgres node apps/api/scripts/order-invoice-divergence-report.mjs\n`,
  );
  process.exit(1);
}

const url =
  `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
  `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`;

const money = (n) => (n == null ? "—" : Number(n).toFixed(2));
const slug = e.REPORT_TENANT_SLUG || null;

const c = new Client({ connectionString: url });

(async () => {
  await c.connect();

  // Header-level divergences: fully-comparable orders whose stored total differs
  // from the sum of their non-void invoice totals. Scope to ACTIVE tenants (or the
  // requested one) so READ_ONLY test tenants don't clutter the report.
  const headerSql = `
    SELECT o.id, o."orderNumber", o."tenantId", t.slug AS tenant,
           o.total::float8 AS order_total,
           SUM(i.total)::float8 AS invoiced_total,
           COUNT(i.id)::int AS n_inv
    FROM "Order" o
    JOIN "Tenant" t ON t.id = o."tenantId"
    JOIN "Invoice" i ON i."orderId" = o.id AND i.status <> 'VOID'
    WHERE ($1::text IS NULL AND t.status = 'ACTIVE') OR t.slug = $1
    GROUP BY o.id, t.slug
    HAVING ABS(o.total - SUM(i.total)) > 0.01
    ORDER BY t.slug, o."orderNumber"`;
  const { rows: headers } = await c.query(headerSql, [slug]);

  console.log(`\n===== ORDER↔INVOICE DIVERGENCE REPORT =====`);
  console.log(`Scope: ${slug ? `tenant ${slug}` : "all ACTIVE tenants"}`);
  console.log(`Divergent orders: ${headers.length}\n`);

  for (const h of headers) {
    const gap = h.order_total - h.invoiced_total;
    console.log(`\n──────────────────────────────────────────────────────────`);
    console.log(`Order ${h.orderNumber}  [${h.tenant}]`);
    console.log(
      `  Order total: ${money(h.order_total)}   Invoiced total: ${money(h.invoiced_total)}   Gap: ${gap > 0 ? "+" : ""}${money(gap)}`,
    );
    console.log(
      `  (${gap > 0 ? "order side higher — invoice UNDER-billed" : "invoice side higher — invoice OVER-billed"})`,
    );

    // Invoices on this order + payment status.
    const { rows: invs } = await c.query(
      `SELECT i.id, i."invoiceNumber", i.status, i.total::float8 AS total,
              COALESCE((SELECT SUM(p.amount) FROM "InvoicePayment" p WHERE p."invoiceId" = i.id), 0)::float8 AS paid
       FROM "Invoice" i WHERE i."orderId" = $1 AND i.status <> 'VOID' ORDER BY i."invoiceNumber"`,
      [h.id],
    );
    for (const inv of invs) {
      console.log(
        `  Invoice ${inv.invoiceNumber}: ${inv.status}, total ${money(inv.total)}, paid ${money(inv.paid)}${inv.paid > 0 ? "  ⚠ HAS PAYMENTS" : ""}`,
      );
    }

    // Per-line comparison. Match order line ↔ invoice line by productId. Show the
    // stored money on each side plus the canonical box math (unitPrice × box-equiv)
    // using the LIVE product unitsPerBox — so it's clear which interpretation each
    // side used.
    const { rows: lines } = await c.query(
      `SELECT p.name,
              oi.qty::float8 AS o_qty, oi.boxes AS o_boxes, oi.pieces AS o_pieces,
              oi."unitPrice"::float8 AS o_price, oi.subtotal::float8 AS o_sub,
              ii.qty::float8 AS i_qty, ii.boxes AS i_boxes, ii.pieces AS i_pieces,
              ii."unitPrice"::float8 AS i_price, ii.subtotal::float8 AS i_sub,
              prod."unitsPerBox" AS live_upb
       FROM "OrderItem" oi
       JOIN "Product" p ON p.id = oi."productId"
       LEFT JOIN "Product" prod ON prod.id = oi."productId"
       LEFT JOIN "InvoiceItem" ii ON ii."productId" = oi."productId"
         AND ii."invoiceId" IN (SELECT id FROM "Invoice" WHERE "orderId" = $1 AND status <> 'VOID')
       WHERE oi."orderId" = $1 AND oi.status <> 'CANCELLED'
       ORDER BY p.name`,
      [h.id],
    );
    console.log(`  Lines (order → invoice):`);
    for (const l of lines) {
      const diverges = l.i_sub != null && Math.abs(Number(l.o_sub) - Number(l.i_sub)) > 0.01;
      const flag = diverges ? "  ✗ DIVERGES" : "";
      const oSplit = l.o_boxes != null ? `${l.o_boxes}b/${l.o_pieces ?? 0}p` : "sell-unit";
      const iSplit =
        l.i_boxes != null
          ? `${l.i_boxes}b/${l.i_pieces ?? 0}p`
          : l.i_sub == null
            ? "—"
            : "sell-unit";
      console.log(
        `    ${String(l.name).slice(0, 40).padEnd(40)} ` +
          `ORDER qty${l.o_qty}(${oSplit}) @${money(l.o_price)}=${money(l.o_sub)}  →  ` +
          `INV qty${l.i_qty ?? "—"}(${iSplit}) @${money(l.i_price)}=${money(l.i_sub)}  upb=${l.live_upb ?? "—"}${flag}`,
      );
    }
  }

  console.log(`\n──────────────────────────────────────────────────────────`);
  console.log(`Decision guide:`);
  console.log(`  • "order side higher" usually means the invoice UNDER-billed a boxed line`);
  console.log(`    (the per-box price became the whole line total). The ORDER side is`);
  console.log(`    typically the agreed price → regenerate the invoice from the order.`);
  console.log(`  • Verify each order individually; an invoice with payments must be handled`);
  console.log(`    manually (void + re-issue), never silently rewritten.`);
  console.log(`\n(READ-ONLY — nothing was modified.)\n`);

  await c.end();
})().catch((err) => {
  console.error("ERR:", err.message);
  process.exit(1);
});
