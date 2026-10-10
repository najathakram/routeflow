import { roundMoney } from "@routeflow/pricing";
import type {
  ProductInsightsBuyer,
  ProductInsightsLastSale,
  ProductInsightsPrice,
  ProductInsightsProduct,
  ProductInsightsResponse,
  ProductInsightsSeriesPoint,
  ProductInsightsTotals,
} from "@routeflow/types";
import { calendarDateFromIso, startOfCalendarDay } from "../common/calendar-date";
import { netOf, roundQty } from "../common/invoiced-sales";
import { bucketIndexOf, type RangeWindow } from "../analytics/demand-range";
import {
  compareLineKeysDesc,
  lineKeyOf,
  perPieceOf,
  purchaseEventKey,
  salePackOf,
  salePiecesOf,
} from "./sales-facts.rules";
import type { ProductCreditEvents, ProductLifetime, ProductSaleFact } from "./sales-facts.types";

/**
 * #2118 (plan §B, A5-A7) — the pure aggregation behind `GET /analytics/products/:id/insights`.
 * ONE pass over one line collection and one credit collection feeds the totals, the series and
 * the buyers, so the three always reconcile (L-119). Money is summed raw and rounded once per
 * figure through `netOf`/`roundMoney`; pieces through `roundQty`.
 */

interface MoneyAcc {
  qty: number;
  returned: number;
  gross: number;
  creditNotes: number;
  externalRefunds: number;
  /** Σ subtotal / Σ qty over lines with pieces > 0 (price metrics only). */
  pricedGross: number;
  pricedQty: number;
}

const newAcc = (): MoneyAcc => ({
  qty: 0,
  returned: 0,
  gross: 0,
  creditNotes: 0,
  externalRefunds: 0,
  pricedGross: 0,
  pricedQty: 0,
});

interface BuyerAcc extends MoneyAcc {
  customerId: string;
  name: string | null;
  events: Set<string>;
  newestLine: ProductSaleFact | null;
  newestPricedLine: ProductSaleFact | null;
}

const avgOf = (gross: number, qty: number) => (qty > 0 ? roundMoney(gross / qty) : null);

const isNewer = (a: ProductSaleFact, b: ProductSaleFact | null) =>
  b == null || compareLineKeysDesc(lineKeyOf(a), lineKeyOf(b)) < 0;

export interface AggregateProductInsightsInput {
  product: ProductInsightsProduct;
  window: RangeWindow;
  /** Tenant IANA zone (null = UTC) — places credit/refund instants on calendar days. */
  timezone: string | null;
  lines: ProductSaleFact[];
  lifetime: ProductLifetime;
  credits: ProductCreditEvents;
  /** The product's CURRENT pack: a gate for no-snapshot lines, never a multiplier. */
  productPackNow: number | null | undefined;
  topBuyers: number | "all";
}

export function aggregateProductInsights(
  input: AggregateProductInsightsInput,
): ProductInsightsResponse {
  const { window: win, timezone, lines, credits, productPackNow } = input;
  const inWindow = (stamp: Date) => stamp >= win.dataFrom && stamp < win.dataTo;
  /** A real instant → its tenant-local day stamp (UTC-midnight). */
  const dayOf = (instant: Date) => startOfCalendarDay(instant, timezone);

  const total = newAcc();
  const buckets = win.buckets.map(() => newAcc());
  const buyers = new Map<string, BuyerAcc>();
  const buyer = (customerId: string, name: string | null): BuyerAcc => {
    let b = buyers.get(customerId);
    if (!b) {
      b = {
        ...newAcc(),
        customerId,
        name,
        events: new Set(),
        newestLine: null,
        newestPricedLine: null,
      };
      buyers.set(customerId, b);
    } else if (b.name == null && name != null) {
      b.name = name;
    }
    return b;
  };
  const addTo = (accs: (MoneyAcc | undefined)[], apply: (a: MoneyAcc) => void) => {
    for (const a of accs) if (a) apply(a);
  };

  const invoices = new Set<string>();
  const events = new Set<string>();
  const purchasers = new Set<string>();
  const packs = new Set<number>();
  let legacyLines = 0;
  /** Lines whose piece count the stored line cannot give (pack-snapshot rule) — revenue only. */
  let unresolvedSaleLines = 0;
  /** Over lines with pieces > 0 and a known sale-time pack (A6). */
  let sellingUnits = 0;
  let sellingGross = 0;
  let minPerPiece: number | null = null;
  let maxPerPiece: number | null = null;
  let newestPriced: ProductSaleFact | null = null;

  for (const f of lines) {
    if (!inWindow(f.issueDate)) continue; // defensive: the read is already windowed
    const bucket = buckets[bucketIndexOf(win, f.issueDate)];
    const b = buyer(f.customerId, f.customerName);
    const event = purchaseEventKey(f.orderId, f.invoiceId);
    invoices.add(f.invoiceId);
    events.add(event);
    purchasers.add(f.customerId);
    b.events.add(event);
    if (isNewer(f, b.newestLine)) b.newestLine = f;

    // Pieces come from the stored line's own evidence (pack-snapshot rule), never `qty` as-is:
    // a no-split boxed line's qty may count boxes, so it adds revenue and nothing per piece.
    const pieces = salePiecesOf(f, productPackNow);
    addTo([total, bucket, b], (a) => {
      a.gross += f.subtotal;
      if (pieces != null) a.qty += pieces;
    });
    if (pieces == null) {
      unresolvedSaleLines += 1;
      if (salePackOf(f, productPackNow) == null) legacyLines += 1;
      continue;
    }
    if (!(pieces > 0)) continue; // a zero-quantity fee line counts in revenue only (A6)

    addTo([total, bucket, b], (a) => {
      a.pricedGross += f.subtotal;
      a.pricedQty += pieces;
    });
    if (isNewer(f, b.newestPricedLine)) b.newestPricedLine = f;
    if (isNewer(f, newestPriced)) newestPriced = f;
    const perPiece = perPieceOf(f.subtotal, pieces);
    if (perPiece != null) {
      minPerPiece = minPerPiece == null ? perPiece : Math.min(minPerPiece, perPiece);
      maxPerPiece = maxPerPiece == null ? perPiece : Math.max(maxPerPiece, perPiece);
    }
    const pack = salePackOf(f, productPackNow);
    if (pack == null) {
      legacyLines += 1;
    } else {
      packs.add(pack);
      sellingUnits += pieces / pack;
      sellingGross += f.subtotal;
    }
  }
  /** Per piece on the SAME pieces the totals count (null when the line's pieces are unknown). */
  const perPieceOfLine = (f: ProductSaleFact) => {
    const pieces = salePiecesOf(f, productPackNow);
    return pieces == null ? null : perPieceOf(f.subtotal, pieces);
  };

  for (const c of credits.attributed) {
    const stamp = dayOf(c.at);
    if (!inWindow(stamp)) continue;
    const bucket = buckets[bucketIndexOf(win, stamp)];
    addTo([total, bucket, buyer(c.customerId, c.customerName)], (a) => {
      if (c.kind === "CREDIT_NOTE") a.creditNotes += c.amount;
      else a.externalRefunds += c.amount;
    });
  }
  let unresolvedReturnLines = 0;
  for (const r of credits.returned) {
    const stamp = dayOf(r.at);
    if (!inWindow(stamp)) continue;
    const qty = r.qty;
    if (qty == null) {
      unresolvedReturnLines += 1; // B665: its unit is unknown — never counted as pieces
      continue;
    }
    const bucket = buckets[bucketIndexOf(win, stamp)];
    addTo([total, bucket], (a) => {
      a.returned += qty;
    });
  }
  let unattributed = 0;
  for (const u of credits.unattributed) {
    if (inWindow(dayOf(u.at))) unattributed += u.amount;
  }

  const net = (a: MoneyAcc) =>
    netOf({ gross: a.gross, creditNotes: a.creditNotes, externalRefunds: a.externalRefunds });
  const totalNet = net(total);
  const sellingUnitPack = packs.size === 1 ? [...packs][0] : null;

  const totals: ProductInsightsTotals = {
    invoicedQtyPieces: roundQty(total.qty),
    unresolvedSaleLines,
    returnedQtyPieces: roundQty(total.returned),
    unresolvedReturnLines,
    netQtyPieces: roundQty(total.qty - total.returned),
    sellingUnits: roundQty(sellingUnits),
    sellingUnitPack,
    legacyLines,
    mixedPackSizes: packs.size > 1,
    lineGross: totalNet.gross,
    attributedCredits: roundMoney(totalNet.creditNotes + totalNet.externalRefunds),
    lineNet: totalNet.net,
    unattributedCredits: roundMoney(unattributed),
    invoices: invoices.size,
    orders: events.size,
    buyers: purchasers.size,
    firstSaleAt: input.lifetime.first ? calendarDateFromIso(input.lifetime.first) : null,
    lastSaleAt: input.lifetime.last ? calendarDateFromIso(input.lifetime.last) : null,
  };

  const last: ProductInsightsLastSale | null = newestPriced
    ? {
        unitPrice: roundMoney(newestPriced.unitPrice),
        unitLabel: newestPriced.unitLabel,
        unitsPerBox: salePackOf(newestPriced, productPackNow),
        perPiece: perPieceOfLine(newestPriced) as number,
        date: calendarDateFromIso(newestPriced.issueDate),
        customerId: newestPriced.customerId,
        customer: newestPriced.customerName ?? "—",
      }
    : null;

  const price: ProductInsightsPrice = {
    avgPerPiece: avgOf(total.pricedGross, total.pricedQty),
    avgPerSellingUnit: avgOf(sellingGross, sellingUnits),
    last,
    minPerPiece,
    maxPerPiece,
  };

  const series: ProductInsightsSeriesPoint[] = win.buckets.map((bucket, i) => {
    const a = buckets[i];
    const n = net(a);
    return {
      date: bucket.date,
      qtyPieces: roundQty(a.qty),
      returnedQtyPieces: roundQty(a.returned),
      lineGross: n.gross,
      credits: roundMoney(n.creditNotes + n.externalRefunds),
      lineNet: n.net,
      avgPerPiece: avgOf(a.pricedGross, a.pricedQty),
    };
  });

  const rows: ProductInsightsBuyer[] = [...buyers.values()].map((b) => {
    const n = net(b);
    return {
      customerId: b.customerId,
      name: b.name ?? "—",
      qtyPieces: roundQty(b.qty),
      lineGross: n.gross,
      lineNet: n.net,
      orders: b.events.size,
      lastDate: b.newestLine ? calendarDateFromIso(b.newestLine.issueDate) : null,
      lastPerPiece: b.newestPricedLine ? perPieceOfLine(b.newestPricedLine) : null,
      avgPerPiece: avgOf(b.pricedGross, b.pricedQty),
      share: totalNet.gross > 0 ? Math.round((n.gross / totalNet.gross) * 10_000) / 10_000 : 0,
    };
  });
  rows.sort(
    (a, b) =>
      b.lineGross - a.lineGross ||
      b.lineNet - a.lineNet ||
      a.name.localeCompare(b.name) ||
      (a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0),
  );

  return {
    product: input.product,
    window: {
      from: win.fromDay,
      to: win.toDay,
      grain: win.granularity,
      timezone: timezone || "UTC",
    },
    basis: "accrual_net",
    totals,
    price,
    series,
    buyers: input.topBuyers === "all" ? rows : rows.slice(0, input.topBuyers),
    buyersTotal: rows.length,
  };
}
