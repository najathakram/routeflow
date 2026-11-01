/**
 * B606 — a unit-aware line (`unitLabel` set) must never become the customer's REMEMBERED price.
 *
 * `getCustomerPriceHistory` feeds the sticky-upsell rule (`resolveBuyerLinePrice`): a remembered
 * price above list becomes the effective price of the next pack line. A Case line's price is
 * per-CASE money, so remembered against the product it would price 2 boxes of a $42 / 24-per-box
 * product at $450 each ($900). `distinct: productId` made it worse: a newer Case row shadowed a real
 * pack override.
 *
 * The Prisma client is a FAKE THAT EVALUATES the `where` the service really builds (and throws on a
 * key it does not understand), so removing `unitLabel: null` from the service turns these red —
 * asserting only that the filter exists would be a churn gate, not a guard (B590).
 */
import { OrderStatus, PriceType } from "@prisma/client";
import { computeLineSubtotal } from "@routeflow/pricing";
import { OrdersService } from "./orders.service";
import { resolveBuyerLinePrice } from "./buyer-merge-pricing";

interface Row {
  productId: string;
  unitPrice: number;
  originalPrice: number | null;
  priceType: PriceType;
  unitLabel: string | null;
  updatedAt: number;
  order: { customerId: string; status: OrderStatus };
}

/** Evaluates exactly the where/orderBy/distinct keys getCustomerPriceHistory uses — nothing else. */
function fakeFindMany(rows: Row[]) {
  return async (args: {
    where: Record<string, any>;
    orderBy?: { updatedAt: "desc" };
    distinct?: string[];
  }) => {
    const { where, orderBy, distinct } = args;
    for (const key of Object.keys(where)) {
      if (!["order", "originalPrice", "priceType", "unitLabel"].includes(key)) {
        throw new Error(`fake findMany does not model where.${key} — extend it with the filter`);
      }
    }
    let out = rows.filter((r) => {
      if (where.order) {
        if (r.order.customerId !== where.order.customerId) return false;
        if (where.order.status?.notIn?.includes(r.order.status)) return false;
      }
      if (where.originalPrice && "not" in where.originalPrice && where.originalPrice.not === null) {
        if (r.originalPrice === null) return false;
      }
      if (where.priceType && "not" in where.priceType && r.priceType === where.priceType.not) {
        return false;
      }
      if ("unitLabel" in where && where.unitLabel === null && r.unitLabel !== null) return false;
      return true;
    });
    if (orderBy) out = [...out].sort((a, b) => b.updatedAt - a.updatedAt);
    if (distinct?.length === 1) {
      const seen = new Set<string>();
      out = out.filter((r) => {
        const k = (r as any)[distinct[0]];
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    return out;
  };
}

const history = (rows: Row[], customerId = "c1") =>
  OrdersService.prototype.getCustomerPriceHistory.call(
    { prisma: { forTenant: () => ({ orderItem: { findMany: fakeFindMany(rows) } }) } } as any,
    customerId,
  );

const PRODUCT = { id: "p1", category: null, pricePerUnit: 42 }; // $42 per 24-piece box
const row = (over: Partial<Row>): Row => ({
  productId: "p1",
  unitPrice: 450,
  originalPrice: 480,
  priceType: PriceType.DISCOUNTED,
  unitLabel: null,
  updatedAt: 1,
  order: { customerId: "c1", status: OrderStatus.CONFIRMED },
  ...over,
});

/** A later plain pack line: 2 boxes of the product, priced through the real buyer resolver. */
async function priceTwoBoxes(rows: Row[]) {
  const remembered = (await history(rows))[PRODUCT.id]?.stickyPrice ?? null;
  const r = resolveBuyerLinePrice(PRODUCT, 1, [], 48, 2, remembered, {
    boxes: 2,
    pieces: 0,
    unitsPerBox: 24,
  });
  return {
    ...r,
    subtotal: computeLineSubtotal({
      unitPrice: r.unitPrice,
      qty: 48,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 24,
    }),
  };
}

describe("B606 — price history ignores unit-aware lines", () => {
  // the row the real writer (buildUnitLine) produces for a Case sold below its list price
  const CASE_ROW = row({ unitLabel: "Case" });

  it("a Case line the customer was sold never remembers as the product's price: 2 boxes cost $84, not $900", async () => {
    expect(await history([CASE_ROW])).toEqual({});
    expect(await priceTwoBoxes([CASE_ROW])).toMatchObject({
      unitPrice: 42,
      priceType: PriceType.STANDARD,
      subtotal: 84,
    });
  });

  it("a newer Case row does not shadow a real pack override for the same product", async () => {
    // sticky upsell
    const packOverride = row({
      unitPrice: 50,
      originalPrice: 42,
      priceType: PriceType.MANUAL,
      updatedAt: 1,
    });
    const newerCase = row({ unitLabel: "Case", updatedAt: 2 });
    expect(await history([packOverride, newerCase])).toEqual({
      p1: { lastPrice: 50, stickyPrice: 50, listPriceAtTime: 42 },
    });
    expect(await priceTwoBoxes([packOverride, newerCase])).toMatchObject({
      unitPrice: 50,
      priceType: PriceType.MANUAL,
      subtotal: 100,
    });
  });

  it("still remembers a pack override (no unit) — the filter narrows, it does not disable the feature", async () => {
    const override = row({ unitPrice: 50, originalPrice: 42, priceType: PriceType.MANUAL });
    expect(await history([override])).toEqual({
      p1: { lastPrice: 50, stickyPrice: 50, listPriceAtTime: 42 },
    });
  });

  it("SA-1072: only a MANUAL newest line carries a sticky price, and an older MANUAL line never comes back", async () => {
    const upsell = row({
      unitPrice: 50,
      originalPrice: 42,
      priceType: PriceType.MANUAL,
      updatedAt: 1,
    });
    const tier = row({
      unitPrice: 45,
      originalPrice: 42,
      priceType: PriceType.SPECIAL,
      updatedAt: 2,
    });
    expect(await history([upsell, tier])).toEqual({
      p1: { lastPrice: 45, stickyPrice: null, listPriceAtTime: 42 },
    });
  });

  it("keeps its existing exclusions: PROMO, cancelled orders and other customers", async () => {
    const rows = [
      row({ priceType: PriceType.PROMO, unitPrice: 40, originalPrice: 42, updatedAt: 5 }),
      row({ order: { customerId: "c1", status: OrderStatus.CANCELLED }, updatedAt: 6 }),
      row({ order: { customerId: "c2", status: OrderStatus.CONFIRMED }, updatedAt: 7 }),
    ];
    expect(await history(rows)).toEqual({});
  });

  it("the fake refuses a where key it does not model (a new filter must be modelled here)", async () => {
    await expect(fakeFindMany([])({ where: { somethingNew: 1 } })).rejects.toThrow(
      /does not model/,
    );
  });
});
