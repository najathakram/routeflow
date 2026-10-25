/**
 * READ-ONLY, COUNTS-ONLY census for SA-780 (rows 406 / 407): the order-level discount model.
 *
 * Only `create()` subtracted `Order.discountAmount` from the stored total; the pending merges, the staff edit, the
 * change-request apply and the finalize recompute re-total WITHOUT it (row 406), and the partial-invoice writer cuts the
 * invoice with `discount: 0` (row 407). This reports, for PRODUCTION orders with `discountAmount > 0`, how many sit in
 * each state and what it is worth, so the owner can size any remedy BEFORE the fix ships.
 *
 *   railway run --service postgres node apps/api/scripts/report-order-discounts.mjs [--json]
 *   node apps/api/scripts/report-order-discounts.mjs --self-test      (no database)
 *
 * WHAT IT COUNTS (PRODUCTION tenants, not deleted), per anonymous tenant bucket and in total:
 *   (a) orders       with discountAmount > 0, by order status;
 *   (b) total class  stored total against subtotal + tax + levy + shipping - discount:
 *         consistent           the total carries the discount;
 *         gapEqualsDiscount    the total is exactly the discount too high (a writer re-totalled without it);
 *         other                anything else (not explained by the discount);   with the Σ $ of the gap-equals-discount orders;
 *   (c) invoices     on orders with at least one LIVE (not VOID / WRITTEN_OFF) invoice, Σ Invoice.discount against the
 *                    order's discount: zero | partial | full | over, with the Σ $ shortfall (an over-billing);
 *   (d) issued/PAID  orders whose shortfall sits on an ISSUED (not DRAFT) invoice, and those with a PAID invoice;
 *   (e) taxBaseDelta Σ the regular tax the new base would remove (tax x discount / subtotal): the owner ruled tax is
 *                    computed AFTER the discount, so this is the size of that step on these orders (informational).
 *
 * OUTPUT is COUNTS and $ ONLY: tenants are anonymous labels ("tenant-1"...), no tenant id, slug or name, no customer,
 * order or invoice identifier. No data is changed; remedies (credit notes) are the owner's, per tenant.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and `lock_timeout` cap every
 * query; the target is the one `resolveReportDbUrl` resolves (the redacted target goes to stderr; nothing usable = exit
 * 2 without connecting); only SELECT statements appear below; the connection is closed in `finally`.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);

const NAME = "report-order-discounts";

/** One row per discounted order, numbers only. `tenant_no` is an anonymous rank over the tenant column. */
export const ORDERS_SQL = `SELECT DENSE_RANK() OVER (ORDER BY x.tn)::int AS tenant_no,
       x.status AS status,
       x.disc::text AS disc,
       x.subtotal::text AS subtotal,
       x.tax::text AS tax,
       x.levy::text AS levy,
       x.shipping::text AS shipping,
       x.total::text AS total,
       x.live::int AS live_invoices,
       x.issued::int AS issued_invoices,
       x.paid::int AS paid_invoices,
       x."invDisc"::text AS invoice_discount,
       x."invSub"::text AS invoice_subtotal
  FROM (
    SELECT o."tenantId" AS tn,
           o.status::text AS status,
           o."discountAmount" AS disc,
           o.subtotal AS subtotal,
           o.tax AS tax,
           COALESCE((SELECT SUM(i."categoryTaxAmount") FROM "OrderItem" i
                      WHERE i."orderId" = o.id AND i.status::text <> 'CANCELLED'), 0) AS levy,
           COALESCE(o."shippingFee", 0) AS shipping,
           o.total AS total,
           (SELECT COUNT(*) FROM "Invoice" v
             WHERE v."orderId" = o.id AND v.status::text NOT IN ('VOID', 'WRITTEN_OFF')) AS live,
           (SELECT COUNT(*) FROM "Invoice" v
             WHERE v."orderId" = o.id AND v.status::text NOT IN ('DRAFT', 'VOID', 'WRITTEN_OFF')) AS issued,
           (SELECT COUNT(*) FROM "Invoice" v
             WHERE v."orderId" = o.id AND v.status::text = 'PAID') AS paid,
           COALESCE((SELECT SUM(v.discount) FROM "Invoice" v
                      WHERE v."orderId" = o.id AND v.status::text NOT IN ('VOID', 'WRITTEN_OFF')), 0) AS "invDisc",
           COALESCE((SELECT SUM(v.subtotal) FROM "Invoice" v
                      WHERE v."orderId" = o.id AND v.status::text NOT IN ('VOID', 'WRITTEN_OFF')), 0) AS "invSub"
      FROM "Order" o
      JOIN "Tenant" t ON t.id = o."tenantId" AND t.class::text = 'PRODUCTION' AND t."deletedAt" IS NULL
     WHERE o."discountAmount" > 0
  ) x`;

/**
 * W-762 / SA-918 (census for SA-780's repair): discounted PRODUCTION orders that were EDITED or MERGED after create (they
 * carry an OrderRevision: one is written after every edit, change-request apply and merge) and whose stored total does
 * NOT carry the discount (more than 1 cent off subtotal + tax + levy + shipping − discount). Before W-762 those re-totals
 * dropped the discount, so these totals are wrong today. Internal order ids only, for the repair; nothing is changed.
 */
export const REPAIR_IDS_SQL = `SELECT DENSE_RANK() OVER (ORDER BY o."tenantId")::int AS tenant_no,
       o.id AS order_ref,
       o.status::text AS status,
       (SELECT COUNT(*) FROM "OrderRevision" r WHERE r."orderId" = o.id)::int AS revisions,
       (o.total - (o.subtotal + o.tax + COALESCE(o."shippingFee", 0) - o."discountAmount"
         + COALESCE((SELECT SUM(i."categoryTaxAmount") FROM "OrderItem" i
                      WHERE i."orderId" = o.id AND i.status::text <> 'CANCELLED'), 0)))::text AS over_by
  FROM "Order" o
  JOIN "Tenant" t ON t.id = o."tenantId" AND t.class::text = 'PRODUCTION' AND t."deletedAt" IS NULL
 WHERE o."discountAmount" > 0
   AND EXISTS (SELECT 1 FROM "OrderRevision" r WHERE r."orderId" = o.id)
   AND abs(o.total - (o.subtotal + o.tax + COALESCE(o."shippingFee", 0) - o."discountAmount"
         + COALESCE((SELECT SUM(i."categoryTaxAmount") FROM "OrderItem" i
                      WHERE i."orderId" = o.id AND i.status::text <> 'CANCELLED'), 0))) > 0.01
 ORDER BY tenant_no, o.id`;

const c = (v) => Math.round((Number(v ?? 0) || 0) * 100);
const money = (n) => (n / 100).toFixed(2);

/** A cent of rounding is not a finding (#3685 review NIT3): stored money is rounded per writer. */
const TOLERANCE_CENTS = 1;
const near = (a, b) => Math.abs(a - b) <= TOLERANCE_CENTS;

/**
 * Pure: classify one order row. Cents throughout.
 * The invoices' expected discount is the order's discount scaled by the BILLED share (Σ live invoice subtotal / order
 * subtotal, capped at 1): the invoice allocator spreads the discount over what each invoice bills, so a partly invoiced
 * order is short only against its own share (#3685 review NIT1). A partial invoice cut with no discount at all (row 407)
 * still shows as "zero" with its share as the shortfall.
 */
export function classify(r) {
  const disc = c(r.disc);
  const expected = c(r.subtotal) + c(r.tax) + c(r.levy) + c(r.shipping) - disc;
  const total = c(r.total);
  const totalClass = near(total, expected)
    ? "consistent"
    : near(total, expected + disc)
      ? "gapEqualsDiscount"
      : "other";
  const live = Number(r.live_invoices) > 0;
  const invDisc = c(r.invoice_discount);
  const subtotal = c(r.subtotal);
  const billedShare = subtotal > 0 ? Math.min(1, c(r.invoice_subtotal) / subtotal) : 1;
  const expectedInvDisc = Math.round(disc * billedShare);
  let invoiceClass = "noInvoice";
  if (live)
    invoiceClass =
      invDisc === 0 && expectedInvDisc > TOLERANCE_CENTS
        ? "zero"
        : near(invDisc, expectedInvDisc)
          ? "full"
          : invDisc < expectedInvDisc
            ? "partial"
            : "over";
  const shortfall =
    live && !near(invDisc, expectedInvDisc) ? Math.max(0, expectedInvDisc - invDisc) : 0;
  const taxBaseDelta = subtotal > 0 ? Math.round((c(r.tax) * disc) / subtotal) : 0;
  return {
    totalClass,
    gap: totalClass === "gapEqualsDiscount" ? disc : 0,
    invoiceClass,
    partlyInvoiced: live && billedShare < 1,
    shortfall,
    issuedShortfall: shortfall > 0 && Number(r.issued_invoices) > 0,
    paidShortfall: shortfall > 0 && Number(r.paid_invoices) > 0,
    over: invoiceClass === "over" ? invDisc - expectedInvDisc : 0,
    taxBaseDelta,
  };
}

const blank = () => ({
  orders: 0,
  consistent: 0,
  gapEqualsDiscount: 0,
  otherTotal: 0,
  gapCents: 0,
  withLiveInvoices: 0,
  partlyInvoiced: 0,
  invoiceDiscountZero: 0,
  invoiceDiscountPartial: 0,
  invoiceDiscountFull: 0,
  invoiceDiscountOver: 0,
  shortfallCents: 0,
  overCents: 0,
  issuedWithShortfall: 0,
  paidWithShortfall: 0,
  taxBaseDeltaCents: 0,
});

/** Pure: fold rows into the total, the per-status blocks and the per-anonymous-tenant blocks. Keeps no identifier. */
export function summarize(rows) {
  const total = blank();
  const byStatus = new Map();
  const byTenant = new Map();
  for (const r of rows) {
    const k = classify(r);
    const st = byStatus.get(r.status) ?? blank();
    byStatus.set(r.status, st);
    const tn = byTenant.get(r.tenant_no) ?? blank();
    byTenant.set(r.tenant_no, tn);
    for (const b of [total, st, tn]) {
      b.orders += 1;
      if (k.totalClass === "consistent") b.consistent += 1;
      else if (k.totalClass === "gapEqualsDiscount") b.gapEqualsDiscount += 1;
      else b.otherTotal += 1;
      b.gapCents += k.gap;
      if (k.invoiceClass !== "noInvoice") b.withLiveInvoices += 1;
      if (k.partlyInvoiced) b.partlyInvoiced += 1;
      if (k.invoiceClass === "zero") b.invoiceDiscountZero += 1;
      if (k.invoiceClass === "partial") b.invoiceDiscountPartial += 1;
      if (k.invoiceClass === "full") b.invoiceDiscountFull += 1;
      if (k.invoiceClass === "over") b.invoiceDiscountOver += 1;
      b.shortfallCents += k.shortfall;
      b.overCents += k.over;
      if (k.issuedShortfall) b.issuedWithShortfall += 1;
      if (k.paidShortfall) b.paidWithShortfall += 1;
      b.taxBaseDeltaCents += k.taxBaseDelta;
    }
  }
  const statuses = [...byStatus.entries()]
    .sort((a, b) => b[1].orders - a[1].orders)
    .map(([status, b]) => ({ status, ...b }));
  const tenants = [...byTenant.values()]
    .sort((a, b) => b.orders - a.orders || b.shortfallCents - a.shortfallCents)
    .map((b, i) => ({ label: `tenant-${i + 1}`, ...b }));
  return { total, statuses, tenants };
}

/** No-DB checks of the pure parts and the SQL text (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const eq = (a, b, what) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  const base = {
    tenant_no: 1,
    status: "PENDING",
    subtotal: "40",
    tax: "3.30",
    levy: "0",
    shipping: "4",
    disc: "5",
    invoice_subtotal: "40", // fully billed unless a case says otherwise
  };
  // 40 + 3.30 + 0 + 4 - 5 = 42.30
  eq(
    classify({
      ...base,
      total: "42.30",
      live_invoices: 0,
      issued_invoices: 0,
      paid_invoices: 0,
      invoice_discount: "0",
    }).totalClass,
    "consistent",
    "consistent",
  );
  eq(
    classify({
      ...base,
      total: "47.30",
      live_invoices: 0,
      issued_invoices: 0,
      paid_invoices: 0,
      invoice_discount: "0",
    }).totalClass,
    "gapEqualsDiscount",
    "edit dropped the discount",
  );
  eq(
    classify({
      ...base,
      total: "50",
      live_invoices: 0,
      issued_invoices: 0,
      paid_invoices: 0,
      invoice_discount: "0",
    }).totalClass,
    "other",
    "other",
  );
  const zero = classify({
    ...base,
    total: "47.30",
    live_invoices: 1,
    issued_invoices: 1,
    paid_invoices: 1,
    invoice_discount: "0",
  });
  eq(
    [zero.invoiceClass, zero.shortfall, zero.issuedShortfall, zero.paidShortfall],
    ["zero", 500, true, true],
    "invoice discount 0, issued and paid",
  );
  eq(
    classify({
      ...base,
      total: "42.30",
      live_invoices: 1,
      issued_invoices: 0,
      paid_invoices: 0,
      invoice_discount: "2",
    }).invoiceClass,
    "partial",
    "partial",
  );
  eq(
    classify({
      ...base,
      total: "42.30",
      live_invoices: 1,
      issued_invoices: 1,
      paid_invoices: 0,
      invoice_discount: "5",
    }).invoiceClass,
    "full",
    "full",
  );
  eq(
    classify({
      ...base,
      total: "42.30",
      live_invoices: 1,
      issued_invoices: 1,
      paid_invoices: 0,
      invoice_discount: "6",
    }).over,
    100,
    "over by 1.00",
  );
  eq(
    classify({
      ...base,
      total: "42.30",
      live_invoices: 0,
      issued_invoices: 0,
      paid_invoices: 0,
      invoice_discount: "0",
    }).invoiceClass,
    "noInvoice",
    "no live invoice",
  );
  // $100 / $10 off / 8.25% tax 8.25: the new base removes 0.825 -> 0.83 (82.5 cents rounds to 83)
  eq(
    classify({
      tenant_no: 1,
      status: "X",
      subtotal: "100",
      tax: "8.25",
      levy: "0",
      shipping: "0",
      disc: "10",
      total: "98.25",
      live_invoices: 0,
      issued_invoices: 0,
      paid_invoices: 0,
      invoice_discount: "0",
    }).taxBaseDelta,
    83,
    "tax base delta",
  );
  const s = summarize([
    {
      ...base,
      total: "47.30",
      live_invoices: 1,
      issued_invoices: 1,
      paid_invoices: 0,
      invoice_discount: "0",
    },
    {
      ...base,
      tenant_no: 2,
      status: "DELIVERED",
      total: "42.30",
      live_invoices: 1,
      issued_invoices: 1,
      paid_invoices: 1,
      invoice_discount: "5",
    },
  ]);
  eq(
    [s.total.orders, s.total.gapEqualsDiscount, s.total.consistent, money(s.total.gapCents)],
    [2, 1, 1, "5.00"],
    "totals",
  );
  eq(
    [
      s.total.invoiceDiscountZero,
      s.total.invoiceDiscountFull,
      money(s.total.shortfallCents),
      s.total.issuedWithShortfall,
      s.total.paidWithShortfall,
    ],
    [1, 1, "5.00", 1, 0],
    "invoice classes",
  );
  eq(
    s.tenants.map((t) => t.label),
    ["tenant-1", "tenant-2"],
    "anonymous tenants",
  );
  // #3685 NIT1/NIT3: half billed (20 of 40) with half the discount is full, not short; with none it is short its share;
  // a total a cent off is still consistent.
  const half = {
    ...base,
    total: "42.30",
    live_invoices: 1,
    issued_invoices: 1,
    paid_invoices: 0,
    invoice_subtotal: "20",
  };
  eq(
    [
      classify({ ...half, invoice_discount: "2.50" }).invoiceClass,
      classify({ ...half, invoice_discount: "2.50" }).shortfall,
    ],
    ["full", 0],
    "partly invoiced, its share of the discount",
  );
  eq(
    [
      classify({ ...half, invoice_discount: "0" }).invoiceClass,
      classify({ ...half, invoice_discount: "0" }).shortfall,
    ],
    ["zero", 250],
    "partly invoiced, no discount (row 407)",
  );
  eq(classify({ ...half, invoice_discount: "2.50" }).partlyInvoiced, true, "partly invoiced flag");
  eq(
    classify({ ...half, total: "42.31", invoice_discount: "2.50" }).totalClass,
    "consistent",
    "1c tolerance",
  );
  eq(
    classify({ ...half, invoice_subtotal: "40", invoice_discount: "4.99" }).shortfall,
    0,
    "1c tolerance on the invoice discount",
  );

  // the one SELECT list the report returns carries no identifier, slug, name or email
  const outerSelect = ORDERS_SQL.split(/\n\s*FROM \(/)[0];
  if (/\bslug\b|\bemail\b|businessName|\bAS\s+"?(id|tenantId|orderId)"?\b/i.test(outerSelect))
    throw new Error("the SELECT list must not carry an id, slug, name or email");
  // W-762: the repair list carries internal order ids only, and is read-only too
  if (/\bslug\b|\bemail\b|businessName|\bname\b/i.test(REPAIR_IDS_SQL))
    throw new Error("the repair list must not carry a slug, name or email");
  if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/i.test(REPAIR_IDS_SQL))
    throw new Error("the repair list SQL must be read-only");
  if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY)\b/i.test(ORDERS_SQL))
    throw new Error("the report SQL must be read-only");
  return "self-test ok";
}

function printBlock(name, b) {
  console.log(
    `${name}: ${b.orders} order(s); total consistent ${b.consistent}, gap == discount ${b.gapEqualsDiscount} ` +
      `($${money(b.gapCents)}), other ${b.otherTotal}; ` +
      `${b.withLiveInvoices} with live invoices, ${b.partlyInvoiced} partly invoiced (discount 0: ${b.invoiceDiscountZero}, partial ${b.invoiceDiscountPartial}, ` +
      `full ${b.invoiceDiscountFull}, over ${b.invoiceDiscountOver}); shortfall $${money(b.shortfallCents)}` +
      `${b.overCents ? `, over-discounted $${money(b.overCents)}` : ""}; ` +
      `issued with shortfall ${b.issuedWithShortfall}, PAID with shortfall ${b.paidWithShortfall}; ` +
      `new-base tax step $${money(b.taxBaseDeltaCents)}`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    console.log(selfTest());
    return;
  }
  const json = argv.includes("--json");
  const databaseUrl = resolveReportDbUrl(NAME);
  if (!databaseUrl) process.exit(2);
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("SET lock_timeout = '5s'");
    await assertReadOnly(client);
    await client.query("BEGIN READ ONLY");
    const { rows } = await client.query(ORDERS_SQL);
    const { rows: repair } = await client.query(REPAIR_IDS_SQL);
    await client.query("ROLLBACK");
    const report = summarize(rows);
    if (json) console.log(JSON.stringify({ ...report, editedOrMergedWrongTotal: repair }, null, 2));
    else {
      console.log("\n=== ORDERS WITH AN ORDER-LEVEL DISCOUNT (SA-780 census, counts only) ===");
      printBlock("all", report.total);
      for (const st of report.statuses) printBlock(`  status ${st.status}`, st);
      for (const t of report.tenants) printBlock(`  ${t.label}`, t);
      if (report.total.orders === 0) console.log("  no discounted orders");
      // W-762 / SA-918: the ids SA-780's repair needs (internal ids only).
      console.log(
        `\n=== DISCOUNTED ORDERS EDITED OR MERGED WITH A WRONG STORED TOTAL (W-762): ${repair.length} ===`,
      );
      for (const r of repair) {
        console.log(
          `  tenant-${r.tenant_no}  ${r.order_ref}  ${r.status}  revisions ${r.revisions}  over by $${Number(r.over_by).toFixed(2)}`,
        );
      }
      console.log(
        "\nNo data is changed. 'shortfall' is the discount the live invoices do not carry (an over-billing); remedies are the owner's, per tenant.",
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** #3685 review NIT2: read the setting back; a session that is not read-only never runs the census. */
async function assertReadOnly(client) {
  const { rows } = await client.query("SHOW default_transaction_read_only");
  if (rows[0]?.default_transaction_read_only !== "on")
    throw new Error("the session is not read-only; refusing to run");
}

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
