/**
 * READ-ONLY report for B673 — next-delivery drafts billed 12x for a driver's door add.
 *
 * The defect (fixed in the B673 PR): an ADD_ITEM change request filed at the door carries
 * `{ qty: total pieces, boxes, pieces }`. Approving it for the NEXT delivery handed create() the
 * bare `qty`, which create() reads as a BOX count on a boxed product. 1 box of a 12-pack at $40
 * became a draft line for 12 boxes, $480. This report finds the lines that path created and
 * prices each one two ways: as stored, and as the filed split says it should have been.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   railway run --service postgres node apps/api/scripts/report-b673-next-delivery-overcharge.mjs
 *   ... add --json for machine-readable output.
 *   node apps/api/scripts/report-b673-next-delivery-overcharge.mjs --self-test   (no database)
 *
 * WHAT IT SELECTS
 *   Change requests with type ADD_ITEM, status APPROVED, resolution NEXT_DELIVERY and a filed box
 *   split (payload boxes > 0 or pieces > 0), then the non-cancelled lines for that product on the
 *   draft order they rolled to (`nextOrderId`).
 *   - AFFECTED: exactly one such line, still box-unaware (boxes IS NULL) with qty equal to the
 *     filed qty. That is the shape the defect wrote. It is priced stored vs expected.
 *   - REVIEW: anything else (no line, several lines, a box-aware line, or a qty that no longer
 *     matches because the line was edited or merged). Listed with its shape, never priced:
 *     a guess at a merged line's history would be worse than a flag.
 *   For each AFFECTED line it reports the order status, `invoicedQty`, and the ids and statuses
 *   of any invoices that carry it — whether the overcharge reached a customer is the question.
 *
 * EXPECTED PRICE
 *   From @routeflow/pricing's computeLineSubtotal (the house money helper; no local math) at the
 *   line's own stored unitPrice (the box price) with the FILED split and the FILED pack,
 *   (qty - pieces) / boxes. A loose-pieces-only request (boxes 0) has no filed pack; it is
 *   priced at the product's LIVE pack and marked `livePackUsed` so the owner can weigh it.
 *
 * WHAT IT PRINTS
 *   Ids only: tenant id, change-request id, order id, order-item id, invoice ids. Amounts:
 *   stored, expected, delta. Per-tenant and grand totals. No tenant slug, business name,
 *   product name, order number or invoice number is printed — an id can be looked up by the
 *   owner; a name in terminal scrollback cannot be un-shared.
 *
 * SAFETY (this script must never be able to touch a client database):
 *   - `default_transaction_read_only = on` is set on the session before any other query runs,
 *     so the server itself rejects a write even if one slipped past review.
 *   - `statement_timeout` caps every query.
 *   - Only SELECT queries appear below. The connection is closed in `finally`.
 *   - Any repair is a separate, dry-run-first script the owner asks for. This one changes nothing.
 */
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { computeLineSubtotal } = require("@routeflow/pricing");

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const selfTest = argv.includes("--self-test");

const num = (v) => (v == null ? null : Number(v));

/**
 * Classify one change request against the draft lines it could have produced, and price it.
 * Pure: no database. `lines` are the non-cancelled lines for the CR's product on its draft.
 */
export function assess(cr, lines, liveUnitsPerBox) {
  const qty = num(cr.payload?.qty);
  const boxes = num(cr.payload?.boxes) ?? 0;
  const pieces = num(cr.payload?.pieces) ?? 0;
  const base = { crId: cr.id, tenantId: cr.tenantId, orderId: cr.nextOrderId };

  if (lines.length !== 1) {
    return { ...base, kind: "REVIEW", reason: `${lines.length} matching lines on the draft` };
  }
  const line = lines[0];
  if (line.boxes != null) {
    return {
      ...base,
      kind: "REVIEW",
      reason: "line is box-aware (not the defect's shape)",
      orderItemId: line.id,
    };
  }
  if (num(line.qty) !== qty) {
    return {
      ...base,
      kind: "REVIEW",
      reason: `line qty ${num(line.qty)} != filed qty ${qty} (edited or merged since)`,
      orderItemId: line.id,
    };
  }

  let upb;
  let livePackUsed = false;
  if (boxes > 0) {
    upb = (qty - pieces) / boxes;
    if (!Number.isInteger(upb) || upb <= 1) {
      return {
        ...base,
        kind: "REVIEW",
        reason: `filed split gives no whole pack (${upb})`,
        orderItemId: line.id,
      };
    }
  } else {
    upb = num(liveUnitsPerBox) ?? 0;
    livePackUsed = true;
    if (!(upb > 1)) {
      return {
        ...base,
        kind: "REVIEW",
        reason: "loose pieces only and no live pack",
        orderItemId: line.id,
      };
    }
  }

  const unitPrice = num(line.unitPrice);
  const stored = num(line.subtotal);
  const expected = computeLineSubtotal({ unitPrice, qty, boxes, pieces, unitsPerBox: upb });
  return {
    ...base,
    kind: "AFFECTED",
    orderItemId: line.id,
    filed: { qty, boxes, pieces, pack: upb },
    livePackUsed,
    unitPrice,
    stored,
    expected,
    delta: Math.round((stored - expected) * 100) / 100,
  };
}

function runSelfTest() {
  const cr = (payload) => ({ id: "cr", tenantId: "t", nextOrderId: "o", payload });
  const line = (over) => ({
    id: "li",
    qty: 12,
    boxes: null,
    pieces: null,
    unitPrice: 40,
    subtotal: 480,
    ...over,
  });
  const cases = [
    [
      "1 box of 12 at $40 billed $480",
      assess(cr({ qty: 12, boxes: 1, pieces: 0 }), [line({})], 12),
      (r) => r.kind === "AFFECTED" && r.stored === 480 && r.expected === 40 && r.delta === 440,
    ],
    [
      "5 loose pieces billed as 5 boxes",
      assess(cr({ qty: 5, boxes: 0, pieces: 5 }), [line({ qty: 5, subtotal: 200 })], 12),
      (r) =>
        r.kind === "AFFECTED" &&
        r.expected === 16.67 &&
        r.delta === 183.33 &&
        r.livePackUsed === true,
    ],
    [
      "a box-aware line is not the defect's shape",
      assess(cr({ qty: 12, boxes: 1, pieces: 0 }), [line({ boxes: 1, pieces: 0 })], 12),
      (r) => r.kind === "REVIEW",
    ],
    [
      "an edited qty is flagged, not priced",
      assess(cr({ qty: 12, boxes: 1, pieces: 0 }), [line({ qty: 13 })], 12),
      (r) => r.kind === "REVIEW" && r.stored === undefined,
    ],
    [
      "no line on the draft",
      assess(cr({ qty: 12, boxes: 1, pieces: 0 }), [], 12),
      (r) => r.kind === "REVIEW",
    ],
  ];
  let failed = 0;
  for (const [name, result, ok] of cases) {
    const pass = ok(result);
    if (!pass) failed++;
    console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  -> ${JSON.stringify(result)}`}`);
  }
  console.log(failed ? `\n${failed} self-test case(s) FAILED` : "\nself-test: all cases pass");
  process.exit(failed ? 1 : 0);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is required and not set. Run via " +
        "`railway run --service postgres node apps/api/scripts/report-b673-next-delivery-overcharge.mjs`.",
    );
    process.exit(1);
  }
  const { Client } = require("pg");
  const client = new Client({ connectionString: databaseUrl });
  const q = async (sql, params) => (await client.query(sql, params)).rows;

  await client.connect();
  try {
    // Hard read-only guarantee + query cap, before anything else runs.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");

    const crs = await q(
      `SELECT cr.id, cr."tenantId", cr."productId", cr."nextOrderId", cr.payload, cr."resolvedAt"
         FROM "ChangeRequest" cr
        WHERE cr.type = 'ADD_ITEM'
          AND cr.status = 'APPROVED'
          AND cr.resolution = 'NEXT_DELIVERY'
          AND cr."nextOrderId" IS NOT NULL
          AND (COALESCE((cr.payload->>'boxes')::numeric, 0) > 0
               OR COALESCE((cr.payload->>'pieces')::numeric, 0) > 0)
        ORDER BY cr."resolvedAt" ASC`,
    );

    const results = [];
    for (const cr of crs) {
      const lines = await q(
        `SELECT oi.id, oi.qty, oi.boxes, oi.pieces, oi."unitPrice", oi.subtotal, oi."invoicedQty"
           FROM "OrderItem" oi
          WHERE oi."orderId" = $1 AND oi."productId" = $2 AND oi.status <> 'CANCELLED'`,
        [cr.nextOrderId, cr.productId],
      );
      const [prod] = await q(`SELECT p."unitsPerBox" FROM "Product" p WHERE p.id = $1`, [
        cr.productId,
      ]);
      const r = assess(cr, lines, prod?.unitsPerBox ?? null);
      if (r.kind === "AFFECTED") {
        const [order] = await q(`SELECT o.status FROM "Order" o WHERE o.id = $1`, [cr.nextOrderId]);
        const invoices = await q(
          `SELECT DISTINCT i.id, i.status
             FROM "InvoiceItem" ii JOIN "Invoice" i ON i.id = ii."invoiceId"
            WHERE ii."orderItemId" = $1`,
          [r.orderItemId],
        );
        r.orderStatus = order?.status ?? "MISSING";
        r.invoicedQty = num(lines[0].invoicedQty);
        r.invoices = invoices;
      }
      results.push(r);
    }

    const affected = results.filter((r) => r.kind === "AFFECTED");
    const review = results.filter((r) => r.kind === "REVIEW");
    const byTenant = new Map();
    for (const r of affected) {
      const t = byTenant.get(r.tenantId) ?? {
        tenantId: r.tenantId,
        lines: 0,
        invoicedLines: 0,
        delta: 0,
      };
      t.lines += 1;
      if ((r.invoices?.length ?? 0) > 0) t.invoicedLines += 1;
      t.delta = Math.round((t.delta + r.delta) * 100) / 100;
      byTenant.set(r.tenantId, t);
    }
    const grandDelta = Math.round(affected.reduce((s, r) => s + r.delta, 0) * 100) / 100;

    if (json) {
      console.log(
        JSON.stringify(
          { scanned: crs.length, affected, review, byTenant: [...byTenant.values()], grandDelta },
          null,
          2,
        ),
      );
      return;
    }
    console.log("\n=== B673 — next-delivery drafts billed from a bare door-add qty ===");
    console.log("    session is READ ONLY; no writes are possible\n");
    console.log(
      `scanned ${crs.length} approved next-delivery ADD_ITEM requests that carried a box split`,
    );
    console.log(`AFFECTED ${affected.length} · REVIEW ${review.length}\n`);
    for (const r of affected) {
      const inv = r.invoices.length
        ? r.invoices.map((i) => `${i.id}(${i.status})`).join(",")
        : "none";
      console.log(
        `AFFECTED tenant=${r.tenantId} cr=${r.crId} order=${r.orderId}(${r.orderStatus}) item=${r.orderItemId} ` +
          `filed=${r.filed.boxes}b+${r.filed.pieces}p@${r.filed.pack}${r.livePackUsed ? "(LIVE pack)" : ""} ` +
          `stored=${r.stored} expected=${r.expected} delta=${r.delta} invoicedQty=${r.invoicedQty} invoices=${inv}`,
      );
    }
    for (const r of review) {
      console.log(
        `REVIEW   tenant=${r.tenantId} cr=${r.crId} order=${r.orderId} item=${r.orderItemId ?? "-"} — ${r.reason}`,
      );
    }
    console.log("\nper tenant (AFFECTED only):");
    for (const t of byTenant.values()) {
      console.log(
        `  ${t.tenantId}  lines=${t.lines}  invoicedLines=${t.invoicedLines}  overcharge=${t.delta}`,
      );
    }
    console.log(`\ngrand total overcharge across AFFECTED lines: ${grandDelta}`);
    console.log(
      "Nothing was changed. Any repair is the owner's decision, via a separate dry-run-first script.",
    );
  } finally {
    await client.end();
  }
}

if (selfTest) runSelfTest();
else
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
