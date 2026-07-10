// Repair a specific set of orders whose invoices diverged from the order, by making
// each invoice a FAITHFUL MIRROR of its order — the same result the fixed code now
// produces when it derives an invoice from an order. The order is the source of
// truth (operator-maintained, internally consistent); the invoice follows it.
//
// Per invoice it either:
//   • per-line UPDATE  — when the invoice's product set already matches the order
//     1:1 and it carries no discount/shipping (preserves the invoice item ids); or
//   • full REGENERATE  — delete the invoice items and recreate them from the order
//     lines (used when the invoice drifted structurally: extra/missing lines, a
//     manual shipping charge, or internally-inconsistent lines).
// The header is always set to mirror the order (subtotal/tax/discount from the
// order, shipping 0, total = order total) and the cached PDF is invalidated.
//
// SAFE BY DEFAULT: dry-run prints the exact before/after. Set REPAIR_APPLY=1 to
// write. Only touches NON-VOID, UNPAID invoices; refuses any invoice with a payment.
//
//   railway run --service postgres node apps/api/scripts/repair-order-invoice-divergence.mjs
//   REPAIR_APPLY=1 railway run --service postgres node apps/api/scripts/repair-order-invoice-divergence.mjs
//
// Default set = the 5 divergent affa orders (box-bug, rounding, and price-drift).
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const ORDER_NUMBERS = (
  process.env.REPAIR_ORDERS || "ORD-00027,ORD-00023,ORD-00026,ORD-00012,ORD-00008"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TENANT_SLUG = process.env.REPAIR_TENANT_SLUG || "affa";
const APPLY = process.env.REPAIR_APPLY === "1";

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
    `\nMissing env: ${missing.join(", ")}\nRun via: railway run --service postgres node apps/api/scripts/repair-order-invoice-divergence.mjs\n`,
  );
  process.exit(1);
}
const url = `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`;
const f = (n) => Number(n).toFixed(2);
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const c = new Client({ connectionString: url });

(async () => {
  await c.connect();
  console.log(`\n===== ORDER↔INVOICE REPAIR ${APPLY ? "(APPLY)" : "(DRY-RUN)"} =====`);
  console.log(`Tenant: ${TENANT_SLUG}   Orders: ${ORDER_NUMBERS.join(", ")}\n`);

  const { rows: tenants } = await c.query(`SELECT id FROM "Tenant" WHERE slug=$1`, [TENANT_SLUG]);
  if (tenants.length === 0) throw new Error(`Tenant ${TENANT_SLUG} not found`);
  const tenantId = tenants[0].id;

  for (const orderNumber of ORDER_NUMBERS) {
    const { rows: orders } = await c.query(
      `SELECT id, "orderNumber", subtotal::float8 s, tax::float8 t, "discountAmount"::float8 d, total::float8 tot
       FROM "Order" WHERE "orderNumber"=$1 AND "tenantId"=$2`,
      [orderNumber, tenantId],
    );
    if (orders.length === 0) {
      console.log(`⚠ ${orderNumber}: not found — skipped\n`);
      continue;
    }
    const order = orders[0];

    // Order lines = the target line set (the agreed truth). Copy every money +
    // denomination field onto the invoice.
    const { rows: oLines } = await c.query(
      `SELECT id, "productId", name, boxes, pieces, "unitsPerBox", "unitPrice"::float8 up,
              "originalPrice"::float8 op, "priceType", subtotal::float8 sub, qty::float8 qty,
              "trackedCategoryId", "categoryTaxAmount"::float8 catTax,
              (SELECT p.name FROM "Product" p WHERE p.id="OrderItem"."productId") AS pname
       FROM "OrderItem" WHERE "orderId"=$1 AND status <> 'CANCELLED'`,
      [order.id],
    );
    const orderLineSubtotal = round2(oLines.reduce((s, l) => s + Number(l.sub), 0));
    const targetSubtotal = orderLineSubtotal;
    const targetTotal = round2(targetSubtotal + Number(order.t) - Number(order.d)); // shipping 0

    console.log(
      `──── ${order.orderNumber} (order total ${f(order.tot)}, lines ${f(orderLineSubtotal)}) ────`,
    );

    const { rows: invoices } = await c.query(
      `SELECT id, "invoiceNumber", status, subtotal::float8 s, "taxAmount"::float8 t,
              discount::float8 d, "shippingFee"::float8 sh, total::float8 tot,
              COALESCE((SELECT SUM(p.amount) FROM "InvoicePayment" p WHERE p."invoiceId"="Invoice".id),0)::float8 paid
       FROM "Invoice" WHERE "orderId"=$1 AND status <> 'VOID'`,
      [order.id],
    );

    for (const inv of invoices) {
      if (inv.paid > 0) {
        console.log(
          `  ✗ ${inv.invoiceNumber} has payments (${f(inv.paid)}) — SKIPPED (handle manually)\n`,
        );
        continue;
      }
      const { rows: iItems } = await c.query(
        `SELECT id, "productId", subtotal::float8 sub FROM "InvoiceItem" WHERE "invoiceId"=$1`,
        [inv.id],
      );

      // Can we do a safe per-line UPDATE? Requires a 1:1 product match with the order
      // and no invoice-level discount/shipping. Otherwise regenerate.
      const oCount = new Map();
      for (const l of oLines)
        if (l.productId) oCount.set(l.productId, (oCount.get(l.productId) ?? 0) + 1);
      const iCount = new Map();
      for (const it of iItems)
        if (it.productId) iCount.set(it.productId, (iCount.get(it.productId) ?? 0) + 1);
      const sameProductSet =
        oLines.every((l) => l.productId) &&
        iItems.every((it) => it.productId) &&
        oCount.size === iCount.size &&
        [...oCount.keys()].every((pid) => iCount.get(pid) === 1 && oCount.get(pid) === 1);
      const cleanHeader = Number(inv.d) === 0 && Number(inv.sh) === 0;
      const mode = sameProductSet && cleanHeader ? "update" : "regenerate";

      console.log(
        `  ${inv.invoiceNumber} [${inv.status}] ${mode.toUpperCase()}: subtotal ${f(inv.s)}→${f(targetSubtotal)}  total ${f(inv.tot)}→${f(targetTotal)}` +
          (Number(inv.sh) ? `  (drops $${f(inv.sh)} shipping)` : ""),
      );

      if (!APPLY) continue;

      await c.query("BEGIN");
      try {
        if (mode === "update") {
          const iByProduct = new Map(iItems.map((it) => [it.productId, it]));
          for (const ol of oLines) {
            const it = iByProduct.get(ol.productId);
            await c.query(
              `UPDATE "InvoiceItem" SET subtotal=$1, boxes=$2, pieces=$3, "unitsPerBox"=$4,
                 "unitPrice"=$5, "originalPrice"=$6, "priceType"=$7, "orderItemId"=$8,
                 "trackedCategoryId"=$9, "categoryTaxAmount"=$10, discount=0, "updatedAt"=NOW()
               WHERE id=$11`,
              [
                round2(ol.sub),
                ol.boxes,
                ol.pieces,
                ol.unitsPerBox,
                round2(ol.up),
                ol.op == null ? null : round2(ol.op),
                ol.priceType,
                ol.id,
                ol.trackedCategoryId,
                round2(ol.catTax),
                it.id,
              ],
            );
          }
        } else {
          await c.query(`DELETE FROM "InvoiceItem" WHERE "invoiceId"=$1`, [inv.id]);
          for (const ol of oLines) {
            await c.query(
              `INSERT INTO "InvoiceItem"
                 (id, "invoiceId", description, "productId", qty, "unitPrice", discount,
                  "originalPrice", "priceType", "taxRate", subtotal, boxes, pieces, "unitsPerBox",
                  "orderItemId", "trackedCategoryId", "categoryTaxAmount", "tenantId", "createdAt", "updatedAt")
               VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,0,$9,$10,$11,$12,$13,$14,$15,$16,NOW(),NOW())`,
              [
                randomUUID(),
                inv.id,
                ol.pname ?? ol.name ?? "Product",
                ol.productId,
                round2(ol.qty),
                round2(ol.up),
                ol.op == null ? null : round2(ol.op),
                ol.priceType,
                round2(ol.sub),
                ol.boxes,
                ol.pieces,
                ol.unitsPerBox,
                ol.id,
                ol.trackedCategoryId,
                round2(ol.catTax),
                tenantId,
              ],
            );
          }
        }
        await c.query(
          `UPDATE "Invoice" SET subtotal=$1, "taxAmount"=$2, discount=$3, "shippingFee"=0,
             total=$4, "pdfUrl"=NULL WHERE id=$5`,
          [targetSubtotal, round2(order.t), round2(order.d), targetTotal, inv.id],
        );
        await c.query("COMMIT");
        console.log(`      ✅ applied (${mode})`);
      } catch (err) {
        await c.query("ROLLBACK");
        console.log(`      ✗ rolled back: ${err.message}`);
      }
    }
    console.log("");
  }

  if (!APPLY) console.log(`(DRY-RUN — nothing written. Re-run with REPAIR_APPLY=1 to apply.)\n`);
  else console.log(`Done. Re-run the divergence report to confirm all reconcile.\n`);
  await c.end();
})().catch((err) => {
  console.error("ERR:", err.message);
  process.exit(1);
});
