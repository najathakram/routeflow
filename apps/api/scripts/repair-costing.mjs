// READ-ONLY costing diagnostic: quantifies the two prod-data problems the
// costing-accuracy batch fixed going forward, and proposes (but never runs)
// the repair for what's already recorded:
//
//   1. DUPLICATE RECEIVED BILLS — the same supplier invoice received more than
//      once (pre-dedup uploads). Every receive beyond the first double-counted
//      stock and re-blended the average cost. Proposal: void the extras (the
//      shipped void path reverses stock + cost exactly).
//   2. CASE-COST SUSPECTS — received lines whose "unit cost" looks like a CASE
//      price applied per PIECE (packSize recorded, or cost ≥ the product's
//      per-piece sell price on a boxed product). These inflated averageCost by
//      up to unitsPerBox×. Proposal: correct the movement denomination, then
//      replay the product's cost history (recompute).
//
// NEVER writes anything — there is deliberately no --execute flag; the owner
// reviews this report first and the repair ships as its own reviewed step.
//
// Run against prod via the Railway postgres proxy:
//   railway run --service postgres node apps/api/scripts/repair-costing.mjs
// Optional: REPORT_TENANT_SLUG=<slug> to scope to one tenant (default: all
// ACTIVE tenants). REPORT_RECEIVED_BEFORE=<ISO date> bounds section 2 to
// receives BEFORE the conversion fix deployed — receives after it convert
// correctly and are not suspects (default: no bound).
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
    `\nMissing env: ${missing.join(", ")}\nRun via: railway run --service postgres node apps/api/scripts/repair-costing.mjs\n`,
  );
  process.exit(1);
}

const url =
  `postgresql://${e.POSTGRES_USER}:${encodeURIComponent(e.POSTGRES_PASSWORD)}` +
  `@${e.RAILWAY_TCP_PROXY_DOMAIN}:${e.RAILWAY_TCP_PROXY_PORT}/${e.POSTGRES_DB}`;

const slug = e.REPORT_TENANT_SLUG || null;
const money = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);
const qty = (n) => (n == null ? "—" : String(Number(n)));

const c = new Client({ connectionString: url });

(async () => {
  await c.connect();

  // The packSize/lineTotal columns ship with this batch's migrations — degrade
  // gracefully when the report runs against a DB that predates them.
  const { rows: colRows } = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'VendorBillItem' AND column_name = 'packSize'`,
  );
  const hasPackSize = colRows.length > 0;
  const packExpr = hasPackSize ? `vbi."packSize"` : `NULL::int`;

  console.log(`\n===== COSTING REPAIR REPORT (read-only) =====`);
  console.log(`Scope: ${slug ? `tenant ${slug}` : "all ACTIVE tenants"}`);
  console.log(`packSize column present: ${hasPackSize}\n`);

  // ── 1. Duplicate RECEIVED bills ────────────────────────────────────────────
  // Same tenant + supplier + normalized supplier invoice number, more than one
  // of them actually received. VOID bills are excluded — they already reversed.
  const dupSql = `
    WITH bills AS (
      SELECT vb.id, vb."billNumber", vb.status, vb."receivedDate", vb."billDate",
             vb."totalOwed"::float8 AS total, vb."tenantId", t.slug AS tenant,
             vb."supplierId", s.name AS supplier,
             UPPER(REGEXP_REPLACE(vb."supplierInvoiceNumber", '\\s+', '', 'g')) AS norm
      FROM "VendorBill" vb
      JOIN "Tenant" t ON t.id = vb."tenantId"
      LEFT JOIN "Supplier" s ON s.id = vb."supplierId"
      WHERE vb.status <> 'VOID'
        AND vb."supplierInvoiceNumber" IS NOT NULL
        AND (($1::text IS NULL AND t.status = 'ACTIVE') OR t.slug = $1)
    )
    SELECT tenant, supplier, norm,
           COUNT(*)::int AS bills,
           COUNT(*) FILTER (WHERE "receivedDate" IS NOT NULL)::int AS received,
           json_agg(json_build_object(
             'id', id, 'billNumber', "billNumber", 'status', status,
             'received', "receivedDate" IS NOT NULL, 'receivedDate', "receivedDate",
             'billDate', "billDate", 'total', total
           ) ORDER BY "receivedDate" NULLS LAST, "billDate") AS detail
    FROM bills
    GROUP BY tenant, supplier, norm, "tenantId", "supplierId"
    HAVING COUNT(*) FILTER (WHERE "receivedDate" IS NOT NULL) > 1
    ORDER BY tenant, supplier, norm`;
  const { rows: dupGroups } = await c.query(dupSql, [slug]);

  console.log(`── 1. DUPLICATE RECEIVED BILLS: ${dupGroups.length} group(s) ──`);
  let dupExtraValue = 0;
  const dupExtraBillIds = [];
  for (const g of dupGroups) {
    console.log(`\n  ${g.tenant} · ${g.supplier ?? "(no supplier)"} · invoice ${g.norm}`);
    const received = g.detail.filter((b) => b.received);
    received.forEach((b, i) => {
      const keep = i === 0;
      if (!keep) {
        dupExtraValue += Number(b.total) || 0;
        dupExtraBillIds.push(b.id);
      }
      console.log(
        `    ${keep ? "KEEP " : "EXTRA"} ${b.billNumber}  ${b.status}  received ${String(b.receivedDate).slice(0, 10)}  ${money(b.total)}`,
      );
    });
    for (const b of g.detail.filter((x) => !x.received)) {
      console.log(
        `    draft ${b.billNumber}  ${b.status}  ${money(b.total)} (never received — no stock impact)`,
      );
    }
  }

  // Stock/cost impact of the EXTRA receives, per product, in the same
  // denomination receive() used at the time (pre-fix prod receives never
  // converted packs, so pieces-as-recorded = qty).
  let dupImpact = [];
  if (dupExtraBillIds.length > 0) {
    const impactSql = `
      SELECT p.id AS product_id, p.name, t.slug AS tenant,
             SUM(vbi.qty)::float8 AS extra_qty,
             SUM(vbi.qty * vbi."unitCost")::float8 AS extra_value,
             p."currentStock"::float8 AS stock_now,
             p."averageCost"::float8 AS avg_now
      FROM "VendorBillItem" vbi
      JOIN "VendorBill" vb ON vb.id = vbi."vendorBillId"
      JOIN "Tenant" t ON t.id = vb."tenantId"
      JOIN "Product" p ON p.id = vbi."productId"
      WHERE vbi."vendorBillId" = ANY($1)
      GROUP BY p.id, t.slug
      ORDER BY extra_value DESC`;
    dupImpact = (await c.query(impactSql, [dupExtraBillIds])).rows;
    console.log(`\n  Per-product overstatement from the EXTRA receives:`);
    for (const r of dupImpact) {
      console.log(
        `    ${r.tenant} · ${r.name}: +${qty(r.extra_qty)} units, ${money(r.extra_value)} of phantom stock ` +
          `(now ${qty(r.stock_now)} on hand @ avg ${money(r.avg_now)})`,
      );
    }
  }

  // ── 2. Case-cost suspects ──────────────────────────────────────────────────
  // (a) received lines that RECORDED a pack size — every one received before
  //     the conversion fix landed as cases-as-pieces at the case cost.
  // (b) boxed products (unitsPerBox > 1) whose received line cost is at or
  //     above the product's PER-PIECE sell price — a per-piece cost that wipes
  //     out the margin usually means the case price was keyed per piece.
  const suspectSql = `
    SELECT t.slug AS tenant, p.id AS product_id, p.name,
           p."unitsPerBox", p."pricePerUnit"::float8 AS box_price,
           p."averageCost"::float8 AS avg_now, p."currentStock"::float8 AS stock_now,
           vb."billNumber", vb."receivedDate",
           vbi.qty::float8 AS line_qty, vbi."unitCost"::float8 AS line_cost,
           ${packExpr} AS pack
    FROM "VendorBillItem" vbi
    JOIN "VendorBill" vb ON vb.id = vbi."vendorBillId"
    JOIN "Tenant" t ON t.id = vb."tenantId"
    JOIN "Product" p ON p.id = vbi."productId"
    WHERE vb."receivedDate" IS NOT NULL
      AND vb.status <> 'VOID'
      AND (($1::text IS NULL AND t.status = 'ACTIVE') OR t.slug = $1)
      AND ($2::timestamptz IS NULL OR vb."receivedDate" < $2)
      AND (
        (${packExpr}) > 1
        OR (p."unitsPerBox" > 1
            AND vbi."unitCost" >= (p."pricePerUnit" / NULLIF(p."unitsPerBox", 0)))
      )
    ORDER BY t.slug, p.name, vb."receivedDate"`;
  const receivedBefore = e.REPORT_RECEIVED_BEFORE || null;
  const { rows: suspects } = await c.query(suspectSql, [slug, receivedBefore]);
  if (receivedBefore) console.log(`\n(section 2 bounded to receives before ${receivedBefore})`);

  console.log(`\n── 2. CASE-COST SUSPECT LINES: ${suspects.length} line(s) ──`);
  const byProduct = new Map();
  for (const s of suspects) {
    const key = s.product_id;
    if (!byProduct.has(key)) byProduct.set(key, { ...s, lines: [] });
    byProduct.get(key).lines.push(s);
  }
  for (const p of byProduct.values()) {
    const upb = p.pack && p.pack > 1 ? p.pack : p.unitsPerBox;
    const perPieceSell = p.unitsPerBox > 1 ? p.box_price / p.unitsPerBox : p.box_price;
    console.log(
      `\n  ${p.tenant} · ${p.name} (box of ${p.unitsPerBox ?? "?"}, sells ${money(perPieceSell)}/pc)`,
    );
    console.log(`    averageCost NOW: ${money(p.avg_now)}/pc on ${qty(p.stock_now)} on hand`);
    for (const l of p.lines) {
      const impliedPiece = upb > 1 ? l.line_cost / upb : l.line_cost;
      console.log(
        `    ${l.billNumber} (${String(l.receivedDate).slice(0, 10)}): ${qty(l.line_qty)} × ${money(l.line_cost)}` +
          `${l.pack && l.pack > 1 ? ` [pack ${l.pack}]` : ""} → per-piece should be ~${money(impliedPiece)}`,
      );
    }
  }

  // ── 3. Repair proposal (nothing below executes) ────────────────────────────
  console.log(`\n── 3. PROPOSED REPAIR (for owner review — this script never writes) ──`);
  if (dupExtraBillIds.length === 0 && byProduct.size === 0) {
    console.log(`  Nothing to repair — no duplicate receives, no case-cost suspects.`);
  }
  if (dupExtraBillIds.length > 0) {
    console.log(
      `  A. Void the ${dupExtraBillIds.length} EXTRA duplicate bill(s) (${money(dupExtraValue)} owed on paper).` +
        `\n     Post-deploy, void reverses each bill's stock and average-cost effect exactly` +
        `\n     (receipt-aware: only bills actually received get a reversal).` +
        `\n     Bill ids: ${dupExtraBillIds.join(", ")}`,
    );
  }
  if (byProduct.size > 0) {
    console.log(
      `  B. For the ${byProduct.size} case-cost product(s): correct the mis-denominated` +
        `\n     PURCHASE movements (qty ×pack, cost ÷pack), then replay cost history per` +
        `\n     product (the recompute already shipped with the AVCO branch). Requires a` +
        `\n     per-product review of the lines listed in section 2 first — some "suspects"` +
        `\n     may be genuinely thin margins, not keying mistakes.`,
    );
  }
  console.log(
    `\n  Sequencing: A before B (voiding a dup already corrects that bill's share);` +
      `\n  fresh backup before either; each step as its own reviewed script run.`,
  );

  await c.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
