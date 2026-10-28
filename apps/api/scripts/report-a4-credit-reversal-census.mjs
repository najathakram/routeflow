// SA-1042 A-4 G5: READ-ONLY census of old rows. Typed CreditNoteItems with a tracked category (non-VOID notes) whose
// credit note's REVERSAL rows booked LESS levy than the items stored.
//
// SCOPE (A-5): only items whose order line has a live SALE row count. The ledger reverses nothing for a line with no
// live SALE (SA-628 return-refund rows, lines that never booked), so their stored levy would read as a mismatch without
// being one. "Live" here = a base SALE row (entryType SALE, correctsEntryId null) on the item's invoice item or on its
// order line, the same match `loadCreditReversalRoom` starts from. `itemsWithoutLiveSale` reports what the scope drops.
//
// Run against the compose DB; the prod run is the owner's. Local databases only.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Client } = require("pg");
const url =
  process.env.CENSUS_DATABASE_URL ?? "postgresql://user:pass@127.0.0.1:5432/routeflow_dev";
if (!/@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url))
  throw new Error("census: local database only");
const c = new Client({ connectionString: url });
await c.connect();
await c.query("SET default_transaction_read_only = on");
const q = async (sql) => (await c.query(sql)).rows;

// typed credit items on live (non-VOID) notes, each flagged with whether its order line has a live SALE row
const typedItems = `SELECT ci."creditNoteId", ci."categoryTax", ci.amount,
    EXISTS (SELECT 1 FROM "RegulatedSalesLedger" s
      WHERE s."entryType" = 'SALE' AND s."correctsEntryId" IS NULL
        AND (s."invoiceItemId" = ci."invoiceItemId"
          OR (ii."orderItemId" IS NOT NULL AND s."orderItemId" = ii."orderItemId"))) AS has_live_sale
  FROM "CreditNoteItem" ci
  JOIN "CreditNote" cn ON cn.id = ci."creditNoteId"
  LEFT JOIN "InvoiceItem" ii ON ii.id = ci."invoiceItemId"
  WHERE ci."trackedCategoryId" IS NOT NULL AND cn.status <> 'VOID'`;

const [totals] = await q(`WITH t AS (${typedItems})
  SELECT count(*)::int AS typed_items, count(DISTINCT "creditNoteId")::int AS notes,
    count(*) FILTER (WHERE has_live_sale)::int AS items_with_live_sale,
    count(*) FILTER (WHERE NOT has_live_sale)::int AS items_without_live_sale
  FROM t`);
const rows = await q(`WITH stored AS (
    SELECT "creditNoteId", sum("categoryTax") AS stored_tax, sum(amount) AS stored_net
    FROM (${typedItems}) t WHERE has_live_sale GROUP BY "creditNoteId"),
  booked AS (
    SELECT "creditNoteId", -sum("categoryTax") AS booked_tax, -sum("netSales") AS booked_net
    FROM "RegulatedSalesLedger" WHERE "entryType" = 'REVERSAL' AND "creditNoteId" IS NOT NULL GROUP BY "creditNoteId")
  SELECT s."creditNoteId", s.stored_tax, coalesce(b.booked_tax, 0) AS booked_tax, s.stored_net, coalesce(b.booked_net, 0) AS booked_net
  FROM stored s LEFT JOIN booked b USING ("creditNoteId")
  WHERE coalesce(b.booked_tax, 0) < s.stored_tax - 0.01 ORDER BY s.stored_tax - coalesce(b.booked_tax, 0) DESC`);
console.log(
  JSON.stringify(
    {
      typedItemsOnLiveNotes: {
        typed_items: totals.typed_items,
        notes: totals.notes,
        itemsWithLiveSale: totals.items_with_live_sale,
        itemsWithoutLiveSale: totals.items_without_live_sale,
      },
      notesBookedLessTaxThanStored: rows.length,
      sample: rows.slice(0, 5),
    },
    null,
    2,
  ),
);
await c.end();
