import { OrderStatus } from "@prisma/client";
import { OPEN_ORDER_STATUSES } from "../invoices/credit-exposure";
import { openOrderLinesForProduct, type OpenOrderLinesDb } from "./open-order-lines";

/**
 * In-memory stand-in for the two reads the helper makes. It evaluates ONLY the where/orderBy/take
 * shapes the helper sends, so a wrong filter shows up as a wrong VALUE, not as a wrong call.
 */
interface FakeLine {
  id: string;
  productId: string;
  status: string;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  unitPrice?: number;
  priceType?: string | null;
}
interface FakeOrder {
  id: string;
  orderNumber: string | null;
  status: OrderStatus;
  counterSale: boolean;
  customerId: string;
  customer: { id: string; businessName: string };
  orderDate: Date | null;
  createdAt: Date;
  lineItems: FakeLine[];
}
interface FakeInvoice {
  status: string;
  items: { orderItemId: string; qty: number }[];
}

const acme = { id: "c-acme", businessName: "Acme Foods" };
const globex = { id: "c-globex", businessName: "Globex Market" };

const line = (id: string, qty: number, over: Partial<FakeLine> = {}): FakeLine => ({
  id,
  productId: "p1",
  status: "PENDING",
  qty,
  unitPrice: 5,
  ...over,
});

const order = (id: string, over: Partial<FakeOrder> = {}): FakeOrder => ({
  id,
  orderNumber: `ORD-${id}`,
  status: OrderStatus.PENDING,
  counterSale: false,
  customerId: acme.id,
  customer: acme,
  orderDate: null,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  lineItems: [line(`${id}-l1`, 10)],
  ...over,
});

function fakeDb(orders: FakeOrder[], invoices: FakeInvoice[] = []): OpenOrderLinesDb {
  return {
    order: {
      findMany: async (args: any) => {
        const w = args.where;
        const wantsLine = (l: FakeLine) =>
          l.productId === w.lineItems.some.productId && l.status !== "CANCELLED";
        let rows = orders.filter(
          (o) =>
            (w.status?.in ? w.status.in.includes(o.status) : true) &&
            (w.counterSale === false ? !o.counterSale : true) &&
            (w.customerId ? o.customerId === w.customerId : true) &&
            (w.id?.not ? o.id !== w.id.not : true) &&
            o.lineItems.some(wantsLine),
        );
        rows = [...rows].sort((a, b) => {
          const at = (a.orderDate ?? a.createdAt).getTime();
          const bt = (b.orderDate ?? b.createdAt).getTime();
          return bt - at || (a.id < b.id ? 1 : -1);
        });
        return rows
          .slice(0, args.take)
          .map((o) => ({ ...o, lineItems: o.lineItems.filter(wantsLine) }));
      },
    },
    invoice: {
      findMany: async (args: any) => {
        const notIn: string[] = args.where.status.notIn;
        const ids: string[] = args.where.items.some.orderItemId.in;
        return invoices
          .filter((i) => !notIn.includes(i.status))
          .map((i) => ({ items: i.items.filter((it) => ids.includes(it.orderItemId)) }))
          .filter((i) => i.items.length > 0);
      },
    },
  };
}

const base = { tenantId: "t1", productId: "p1", statuses: OPEN_ORDER_STATUSES, take: 50 };

describe("openOrderLinesForProduct", () => {
  it("returns only PENDING, CONFIRMED and OUT_FOR_DELIVERY orders; never DRAFT, CANCELLED, delivered or counter sales", async () => {
    const statuses: OrderStatus[] = [
      OrderStatus.DRAFT,
      OrderStatus.PENDING,
      OrderStatus.CONFIRMED,
      OrderStatus.OUT_FOR_DELIVERY,
      OrderStatus.PARTIALLY_DELIVERED,
      OrderStatus.DELIVERED,
      OrderStatus.CANCELLED,
    ];
    const orders = statuses.map((s) => order(`o-${s}`, { status: s }));
    orders.push(order("o-counter", { status: OrderStatus.PENDING, counterSale: true }));
    const out = await openOrderLinesForProduct(fakeDb(orders), {
      ...base,
      excludeCounterSales: true,
    });
    expect(out.map((l) => l.orderId).sort()).toEqual(
      ["o-CONFIRMED", "o-OUT_FOR_DELIVERY", "o-PENDING"].sort(),
    );
    expect(out.find((l) => l.orderId === "o-PENDING")).toEqual(
      expect.objectContaining({
        orderNumber: "ORD-o-PENDING",
        customerId: acme.id,
        customerName: "Acme Foods",
        status: OrderStatus.PENDING,
        qty: 10,
        billedQty: 0,
        remainingQty: 10,
      }),
    );
  });

  it("keeps counter sales unless the caller excludes them (price history behaviour is unchanged)", async () => {
    const orders = [order("o-counter", { counterSale: true }), order("o-plain")];
    const kept = await openOrderLinesForProduct(fakeDb(orders), base);
    expect(kept.map((l) => l.orderId).sort()).toEqual(["o-counter", "o-plain"]);
    const dropped = await openOrderLinesForProduct(fakeDb(orders), {
      ...base,
      excludeCounterSales: true,
    });
    expect(dropped.map((l) => l.orderId)).toEqual(["o-plain"]);
  });

  it("remaining = qty − issued-invoice qty; a DRAFT invoice does not reduce it; a fully billed line drops", async () => {
    const orders = [
      order("o-part", { lineItems: [line("part", 10)] }),
      order("o-draft", { lineItems: [line("draftOnly", 8)] }),
      order("o-full", { lineItems: [line("full", 6)] }),
    ];
    const invoices: FakeInvoice[] = [
      { status: "SENT", items: [{ orderItemId: "part", qty: 4 }] },
      { status: "PAID", items: [{ orderItemId: "part", qty: 1 }] },
      { status: "DRAFT", items: [{ orderItemId: "draftOnly", qty: 8 }] },
      { status: "VOID", items: [{ orderItemId: "draftOnly", qty: 3 }] },
      { status: "SENT", items: [{ orderItemId: "full", qty: 6 }] },
    ];
    const out = await openOrderLinesForProduct(fakeDb(orders, invoices), base);
    const byLine = Object.fromEntries(out.map((l) => [l.orderItemId, l]));
    expect(byLine.part).toEqual(
      expect.objectContaining({ qty: 10, billedQty: 5, remainingQty: 5 }),
    );
    expect(byLine.draftOnly).toEqual(
      expect.objectContaining({ qty: 8, billedQty: 0, remainingQty: 8 }),
    );
    expect(byLine.full).toBeUndefined();
  });

  it("a CANCELLED line on an open order is excluded", async () => {
    const orders = [
      order("o-mixed", {
        lineItems: [line("live", 3), line("gone", 9, { status: "CANCELLED" })],
      }),
    ];
    const out = await openOrderLinesForProduct(fakeDb(orders), base);
    expect(out.map((l) => l.orderItemId)).toEqual(["live"]);
  });

  it("orders newest first by orderDate ?? createdAt, capped at take", async () => {
    const orders = [
      order("o-old", { createdAt: new Date("2026-09-01T00:00:00Z") }),
      // entered late but dated earlier than o-new: orderDate wins over createdAt
      order("o-backdated", {
        createdAt: new Date("2026-10-15T00:00:00Z"),
        orderDate: new Date("2026-09-20T00:00:00Z"),
        customerId: globex.id,
        customer: globex,
      }),
      order("o-new", { createdAt: new Date("2026-10-10T00:00:00Z") }),
    ];
    const all = await openOrderLinesForProduct(fakeDb(orders), base);
    expect(all.map((l) => l.orderId)).toEqual(["o-new", "o-backdated", "o-old"]);
    expect(all[1].orderDate).toEqual(new Date("2026-09-20T00:00:00Z"));
    const capped = await openOrderLinesForProduct(fakeDb(orders), { ...base, take: 2 });
    expect(capped.map((l) => l.orderId)).toEqual(["o-new", "o-backdated"]);
  });

  it("scopes to one customer and drops the excluded order when asked", async () => {
    const orders = [
      order("o-a"),
      order("o-b", { customerId: globex.id, customer: globex }),
      order("o-edit"),
    ];
    const out = await openOrderLinesForProduct(fakeDb(orders), {
      ...base,
      customerId: acme.id,
      excludeOrderId: "o-edit",
    });
    expect(out.map((l) => l.orderId)).toEqual(["o-a"]);
  });
});
