/**
 * READ-ONLY report for B673 — next-delivery drafts billed 12x for a driver's door add.
 *
 * The defect (fixed in #1282): an ADD_ITEM change request filed at the door carries
 * `{ qty: total pieces, boxes, pieces }`. Approving it for the NEXT delivery handed create() the
 * bare `qty`, which create() reads as a BOX count on a boxed product: 1 box of a 12-pack at $40
 * became a draft line for 12 boxes, $480. This report finds the lines that path wrote and prices
 * each one two ways: as stored, and as the filed split says it should have been.
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The owner runs it:
 *
 *   npm run build -w packages/pricing     # once — the script imports @routeflow/pricing's dist
 *   railway run --service postgres node apps/api/scripts/report-b673-next-delivery-overcharge.mjs
 *   ... add --json for machine-readable output.
 *   node apps/api/scripts/report-b673-next-delivery-overcharge.mjs --self-test   (no database)
 *
 * WHICH DATABASE
 *   Under `railway run --service postgres`, DATABASE_URL is the *.railway.internal host, which is
 *   unreachable from the owner's machine. The URL is built from Railway's TCP-proxy variables via
 *   the shared `resolveDatabaseUrl(env, { requireProxy: true })` (scripts/lib/railway-db-url.mjs):
 *   a missing proxy variable REFUSES, never falls back to DATABASE_URL. The target is printed,
 *   password redacted, before anything is read.
 *
 * WHAT IT SELECTS
 *   Change requests with type ADD_ITEM, status APPROVED, resolution NEXT_DELIVERY and a filed box
 *   split (payload boxes > 0 or pieces > 0), then the non-cancelled lines for that product on the
 *   draft order they rolled to (`nextOrderId`). A line is AFFECTED only when EVERY one of these
 *   holds; anything else is REVIEW — never priced and never in the totals, but listed with its
 *   ids, its STORED qty and subtotal, and the first reason it failed, because a REVIEW row can
 *   still be an overcharge (5 loose pieces billed at a box price is exactly that):
 *   - exactly one such line, still box-unaware (boxes IS NULL), qty equal to the filed qty;
 *   - its stored subtotal is exactly what create() writes for a bare qty —
 *     computeLineSubtotal({ unitPrice, qty, freeUnits: promoFreeUnits }) — so it has not been
 *     re-priced since;
 *   - priceType is not DISCOUNTED, MANUAL or PROMO. A hand-set price (DISCOUNTED / MANUAL) is not
 *     the defect's price. A promotion — which is how a QUANTITY BREAK is priced — depends on the
 *     quantity: the bare-qty line earned it at 12 "boxes", the correct 1 box may not, so pricing
 *     the filed split at the promo price would OVERSTATE the overcharge by (list - promo) x boxes;
 *   - the request filed boxes (> 0), so the filed pack (qty - pieces) / boxes is known, and the
 *     product's LIVE pack still equals it (a product repacked since — or to 1 — is REVIEW);
 *   - no BOGO free units on the line (promoFreeUnits 0): the correct free-unit count for the
 *     filed quantity cannot be re-derived from the row, so the expected figure would be a guess.
 *
 * EXPECTED PRICE AND WHAT THE TOTAL MEANS
 *   @routeflow/pricing's computeLineSubtotal (the house money helper; no local math) at the line's
 *   own stored unitPrice (the box price) with the FILED split and pack. Amounts are rounded with
 *   roundMoney. The overcharge is PRE-TAX: per-unit excise and sales tax on these lines were
 *   inflated too and are NOT included — the real customer impact is larger than the printed delta.
 *   For each AFFECTED line it prints the order status, `invoicedQty`, and the ids and statuses of
 *   any invoices that carry it — whether the overcharge reached a customer is the question.
 *
 * WHAT IT PRINTS
 *   Ids only: tenant id, change-request id, order id, order-item id, invoice ids. Amounts:
 *   stored, expected, delta. Per-tenant and grand totals. No tenant slug, business name, product
 *   name, order number or invoice number is printed.
 *
 * SAFETY (this script must never be able to touch a client database):
 *   - `default_transaction_read_only = on`, then every query runs inside ONE
 *     `BEGIN TRANSACTION READ ONLY` (a consistent snapshot) that is ROLLED BACK at the end.
 *   - `statement_timeout` caps every query.
 *   - `q()` refuses any SQL carrying a write/DDL verb before it reaches the server.
 *   - Any repair is a separate, dry-run-first script the owner asks for. This one changes nothing.
 */
import { realpathSync } from "fs";
import { createRequire } from "module";
import { basename } from "path";
import { fileURLToPath } from "url";
import { resolveDatabaseUrl, redactUrl } from "./lib/railway-db-url.mjs";

const require = createRequire(import.meta.url);
const { computeLineSubtotal, roundMoney } = require("@routeflow/pricing");

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const selfTest = argv.includes("--self-test");

const num = (v) => (v == null ? null : Number(v));
// DISCOUNTED / MANUAL: a hand-set price. PROMO: a promotion, which is how a quantity break is
// priced — the bare 12-"box" line may have earned a break the correct 1 box would not, so its
// expected figure would be understated and the overcharge overstated. All three go to REVIEW.
const NON_DEFECT_PRICE_TYPES = new Set(["DISCOUNTED", "MANUAL", "PROMO"]);

/**
 * Classify one change request against the draft lines it could have produced, and price it.
 * Pure: no database. `lines` are the non-cancelled lines for the CR's product on its draft.
 */
export function assess(cr, lines, liveUnitsPerBox) {
  const qty = num(cr.payload?.qty);
  const boxes = num(cr.payload?.boxes) ?? 0;
  const pieces = num(cr.payload?.pieces) ?? 0;
  const base = { crId: cr.id, tenantId: cr.tenantId, orderId: cr.nextOrderId };
  // REVIEW rows are never PRICED (no expected, no delta), but they carry the line's stored qty and
  // subtotal: a REVIEW row can still be an overcharge (5 loose pieces billed at a box price), and
  // the owner must see the amount to judge it.
  const review = (reason, line) => ({
    ...base,
    kind: "REVIEW",
    reason,
    orderItemId: line?.id,
    storedQty: line ? num(line.qty) : undefined,
    stored: line ? num(line.subtotal) : undefined,
  });

  if (lines.length !== 1) return review(`${lines.length} matching lines on the draft`);
  const line = lines[0];
  if (line.boxes != null) return review("line is box-aware (not the defect's shape)", line);
  if (num(line.qty) !== qty) {
    return review(`line qty ${num(line.qty)} != filed qty ${qty} (edited or merged since)`, line);
  }
  if (NON_DEFECT_PRICE_TYPES.has(line.priceType)) {
    return review(
      `priceType ${line.priceType} (a hand-set or promotional price; the correct price for the ` +
        `filed quantity cannot be re-derived)`,
      line,
    );
  }
  const freeUnits = num(line.promoFreeUnits) ?? 0;
  const unitPrice = num(line.unitPrice);
  const stored = num(line.subtotal);
  const bareSubtotal = computeLineSubtotal({ unitPrice, qty, freeUnits });
  if (stored !== bareSubtotal) {
    return review(
      `stored subtotal ${stored} != the bare-qty price ${bareSubtotal} (re-priced since)`,
      line,
    );
  }
  if (freeUnits > 0) {
    return review(
      `${freeUnits} BOGO free unit(s): the correct free units cannot be re-derived`,
      line,
    );
  }
  if (boxes <= 0) return review("loose pieces only: no filed pack to confirm against", line);
  const pack = (qty - pieces) / boxes;
  if (!Number.isInteger(pack) || pack <= 1) {
    return review(`filed split gives no whole pack (${pack})`, line);
  }
  const livePack = num(liveUnitsPerBox) ?? 0;
  if (livePack !== pack) {
    return review(`live pack ${livePack} != filed pack ${pack} (repacked since)`, line);
  }

  const expected = computeLineSubtotal({ unitPrice, qty, boxes, pieces, unitsPerBox: pack });
  return {
    ...base,
    kind: "AFFECTED",
    orderItemId: line.id,
    filed: { qty, boxes, pieces, pack },
    unitPrice,
    stored,
    expected,
    delta: roundMoney(stored - expected),
  };
}

/** Refuse any SQL that could write or change schema, before it reaches the server. */
const WRITE_VERB =
  /\b(insert|update|delete|merge|upsert|drop|alter|truncate|create|grant|revoke|copy|vacuum|reindex|cluster|lock|call|do)\b/i;
export function assertReadOnlySql(sql) {
  const code = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  const hit = code.match(WRITE_VERB);
  if (hit) throw new Error(`refusing non-read-only SQL (found "${hit[1]}")`);
  if (!/^\s*(select|with)\b/i.test(code)) throw new Error("refusing SQL that is not a SELECT");
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
    priceType: "STANDARD",
    promoFreeUnits: null,
    ...over,
  });
  const box = { qty: 12, boxes: 1, pieces: 0 };
  const cases = [
    [
      "1 box of 12 at $40 billed $480 -> AFFECTED, expected $40, delta $440",
      assess(cr(box), [line({})], 12),
      (r) => r.kind === "AFFECTED" && r.stored === 480 && r.expected === 40 && r.delta === 440,
    ],
    [
      "2 boxes + 5 pieces billed as 29 boxes -> expected $96.67",
      assess(cr({ qty: 29, boxes: 2, pieces: 5 }), [line({ qty: 29, subtotal: 1160 })], 12),
      (r) => r.kind === "AFFECTED" && r.expected === 96.67 && r.delta === 1063.33,
    ],
    [
      "SPECIAL (tier) price is still the defect's shape -> AFFECTED",
      assess(cr(box), [line({ priceType: "SPECIAL", unitPrice: 36, subtotal: 432 })], 12),
      (r) => r.kind === "AFFECTED" && r.expected === 36,
    ],
    [
      "re-priced since (stored != bare-qty price) -> REVIEW: unpriced, stored amount shown",
      assess(cr(box), [line({ subtotal: 450 })], 12),
      (r) =>
        r.kind === "REVIEW" &&
        r.expected === undefined &&
        r.delta === undefined &&
        r.stored === 450,
    ],
    [
      "priceType DISCOUNTED -> REVIEW",
      assess(cr(box), [line({ priceType: "DISCOUNTED" })], 12),
      (r) => r.kind === "REVIEW",
    ],
    [
      "priceType MANUAL -> REVIEW",
      assess(cr(box), [line({ priceType: "MANUAL" })], 12),
      (r) => r.kind === "REVIEW",
    ],
    [
      "priceType PROMO (e.g. a quantity break) -> REVIEW, never an overstated AFFECTED",
      assess(cr(box), [line({ priceType: "PROMO", unitPrice: 36, subtotal: 432 })], 12),
      (r) => r.kind === "REVIEW" && r.delta === undefined && r.stored === 432,
    ],
    [
      "repacked to 1 since filing -> REVIEW",
      assess(cr(box), [line({})], 1),
      (r) => r.kind === "REVIEW",
    ],
    [
      "repacked 12 -> 24 since filing -> REVIEW",
      assess(cr(box), [line({})], 24),
      (r) => r.kind === "REVIEW",
    ],
    [
      "BOGO free units on the line -> REVIEW",
      assess(cr(box), [line({ promoFreeUnits: 1, subtotal: 440 })], 12),
      (r) => r.kind === "REVIEW",
    ],
    [
      "loose pieces only (no filed pack) -> REVIEW, with its $200 stored amount visible",
      assess(cr({ qty: 5, boxes: 0, pieces: 5 }), [line({ qty: 5, subtotal: 200 })], 12),
      (r) => r.kind === "REVIEW" && r.stored === 200 && r.storedQty === 5 && r.delta === undefined,
    ],
    [
      "a box-aware line -> REVIEW",
      assess(cr(box), [line({ boxes: 1, pieces: 0 })], 12),
      (r) => r.kind === "REVIEW",
    ],
    [
      "an edited qty -> REVIEW",
      assess(cr(box), [line({ qty: 13, subtotal: 520 })], 12),
      (r) => r.kind === "REVIEW",
    ],
    ["no line on the draft -> REVIEW", assess(cr(box), [], 12), (r) => r.kind === "REVIEW"],
  ];
  const sqlCases = [
    [
      "guard passes a SELECT",
      () => assertReadOnlySql('SELECT cr.id FROM "ChangeRequest" cr'),
      false,
    ],
    [
      "guard passes a quoted column named like a verb",
      () => assertReadOnlySql('SELECT "updatedAt" FROM "Order"'),
      false,
    ],
    ["guard refuses UPDATE", () => assertReadOnlySql('UPDATE "Order" SET total = 0'), true],
    [
      "guard refuses a SELECT with a trailing DELETE",
      () => assertReadOnlySql('SELECT 1; DELETE FROM "Order"'),
      true,
    ],
    [
      "guard refuses a data-modifying CTE",
      () => assertReadOnlySql('WITH x AS (DELETE FROM "Order" RETURNING id) SELECT * FROM x'),
      true,
    ],
  ];
  let failed = 0;
  for (const [name, result, ok] of cases) {
    const pass = ok(result);
    if (!pass) failed++;
    console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass ? "" : `  -> ${JSON.stringify(result)}`}`);
  }
  for (const [name, fn, shouldThrow] of sqlCases) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    const pass = threw === shouldThrow;
    if (!pass) failed++;
    console.log(`${pass ? "ok  " : "FAIL"} ${name}`);
  }
  console.log(failed ? `\n${failed} self-test case(s) FAILED` : "\nself-test: all cases pass");
  process.exit(failed ? 1 : 0);
}

async function main() {
  let url;
  try {
    url = resolveDatabaseUrl(process.env, { requireProxy: true });
  } catch (e) {
    console.error(
      `report-b673: ${e.message}\nRun via \`railway run --service postgres node apps/api/scripts/report-b673-next-delivery-overcharge.mjs\`.`,
    );
    process.exit(2);
  }
  if (!json) {
    console.log(
      `report-b673: target ${redactUrl(url)} (READ ONLY; prints tenant ids: keep off public issues)`,
    );
  }

  const { Client } = require("pg");
  const client = new Client({ connectionString: url });
  const q = async (sql, params) => {
    assertReadOnlySql(sql);
    return (await client.query(sql, params)).rows;
  };

  await client.connect();
  let inTx = false;
  try {
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '60s'");
    await client.query("BEGIN TRANSACTION READ ONLY"); // one consistent snapshot for every read
    inTx = true;

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
        `SELECT oi.id, oi.qty, oi.boxes, oi.pieces, oi."unitPrice", oi.subtotal, oi."invoicedQty",
                oi."priceType", oi."promoFreeUnits"
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
        preTaxDelta: 0,
      };
      t.lines += 1;
      if ((r.invoices?.length ?? 0) > 0) t.invoicedLines += 1;
      t.preTaxDelta = roundMoney(t.preTaxDelta + r.delta);
      byTenant.set(r.tenantId, t);
    }
    const grandPreTaxDelta = roundMoney(affected.reduce((s, r) => s + r.delta, 0));

    if (json) {
      console.log(
        JSON.stringify(
          {
            scanned: crs.length,
            deltasArePreTax: true,
            affected,
            review,
            byTenant: [...byTenant.values()],
            grandPreTaxDelta,
          },
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
    console.log(`AFFECTED ${affected.length} · REVIEW ${review.length}`);
    console.log(
      "REVIEW rows are NOT priced and NOT in the totals below, but they may still be overcharged " +
        "(e.g. loose pieces billed at a box price). Each is listed with its ids and stored amount " +
        "so it can be checked by hand.\n",
    );
    for (const r of affected) {
      const inv = r.invoices.length
        ? r.invoices.map((i) => `${i.id}(${i.status})`).join(",")
        : "none";
      console.log(
        `AFFECTED tenant=${r.tenantId} cr=${r.crId} order=${r.orderId}(${r.orderStatus}) item=${r.orderItemId} ` +
          `filed=${r.filed.boxes}b+${r.filed.pieces}p@${r.filed.pack} ` +
          `stored=${r.stored} expected=${r.expected} preTaxDelta=${r.delta} invoicedQty=${r.invoicedQty} invoices=${inv}`,
      );
    }
    for (const r of review) {
      console.log(
        `REVIEW   tenant=${r.tenantId} cr=${r.crId} order=${r.orderId} item=${r.orderItemId ?? "-"} ` +
          `storedQty=${r.storedQty ?? "-"} stored=${r.stored ?? "-"} — ${r.reason}`,
      );
    }
    console.log("\nper tenant (AFFECTED only; PRE-TAX):");
    for (const t of byTenant.values()) {
      console.log(
        `  ${t.tenantId}  lines=${t.lines}  invoicedLines=${t.invoicedLines}  preTaxOvercharge=${t.preTaxDelta}`,
      );
    }
    console.log(`\ngrand PRE-TAX overcharge across AFFECTED lines: ${grandPreTaxDelta}`);
    console.log(
      "Per-unit excise and sales tax on these lines were inflated too and are NOT included above.",
    );
    console.log(
      "Nothing was changed. Any repair is the owner's decision, via a separate dry-run-first script.",
    );
  } finally {
    if (inTx) await client.query("ROLLBACK").catch(() => {});
    await client.end();
  }
}

/**
 * Run only when invoked directly: importing this module (for `assess` / `assertReadOnlySql`) must
 * never start a report. Both paths are compared after realpath, case-insensitively on Windows,
 * where a drive-letter case or a junction can make an exact URL comparison fail. That failure
 * used to exit 0 silently, which reads as "no findings". So when the file NAMES match but the
 * paths still differ, the report warns and runs anyway rather than doing nothing.
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
      `report-b673: warning: entry path ${entry} did not match ${self} exactly; running anyway.`,
    );
    return true;
  }
  return false;
}

if (isInvokedDirectly()) {
  if (selfTest) runSelfTest();
  else
    main().catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
