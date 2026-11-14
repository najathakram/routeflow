/**
 * W-904 / SA-1142: saving tracking never writes `shippedAt` from its unlocked pre-read. The stamp the ship claim wrote
 * survives a racing tracking save (order and invoice mirror); the legacy backfill and the mirror are fill-only
 * conditional writes, so the database decides at write time.
 *
 * The data layer is a small stateful fake that honours the `where` of the writes under test (id / orderId, status
 * `not` / `in`, `shippedAt: null`), so a case is red on the wrong STORED value, not on a call shape. The race is
 * modelled by the `afterPreRead` hook: it mutates the stored row right after `updateShipmentImpl`'s first read.
 */
import { updateShipmentImpl } from "./order-lifecycle";

const T = new Date("2026-11-13T15:00:00.000Z");
const T2 = new Date("2026-11-12T09:00:00.000Z");
const operator = { sub: "user-op", role: "OPERATOR" } as any;

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    const cur = row[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return cur !== v.not;
      if ("in" in v) return (v.in as unknown[]).includes(cur);
      return false;
    }
    return v === null ? cur == null : cur === v;
  });
}

function fakeDb(order: Row, invoices: Row[], afterPreRead?: (order: Row) => void) {
  let reads = 0;
  const writes: Array<{ model: string; fn: string; args: any }> = [];
  const db = {
    order: {
      findFirst: jest.fn(async (args: any) => {
        const snapshot = { ...order };
        reads += 1;
        if (reads === 1) afterPreRead?.(order);
        return args?.select ? snapshot : { ...order };
      }),
      update: jest.fn(async (args: any) => {
        writes.push({ model: "order", fn: "update", args });
        Object.assign(order, args.data);
        return { ...order };
      }),
      updateMany: jest.fn(async (args: any) => {
        writes.push({ model: "order", fn: "updateMany", args });
        if (!matches(order, args.where)) return { count: 0 };
        Object.assign(order, args.data);
        return { count: 1 };
      }),
    },
    invoice: {
      updateMany: jest.fn(async (args: any) => {
        writes.push({ model: "invoice", fn: "updateMany", args });
        let count = 0;
        for (const inv of invoices) {
          if (matches({ ...inv, orderId: order.id }, args.where)) {
            Object.assign(inv, args.data);
            count += 1;
          }
        }
        return { count };
      }),
    },
  };
  return { db, writes, deps: { prisma: { forTenant: () => db }, messaging: {} } as any };
}

const baseOrder = (over: Row = {}): Row => ({
  id: "ord-1",
  status: "CONFIRMED",
  fulfillPath: "SHIP",
  shippedAt: null,
  customerId: "cust-1",
  orderNumber: "ORD-1",
  shippingCarrier: null,
  shippingTrackingNumber: null,
  ...over,
});
const save = (deps: any, dto: Row = { shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" }) =>
  updateShipmentImpl(deps, "ord-1", dto as any, operator);
const claim = (o: Row) => Object.assign(o, { status: "OUT_FOR_DELIVERY", shippedAt: T });
const wroteShippedAt = (writes: Array<{ args: any }>) =>
  writes.some((w) => "shippedAt" in (w.args.data ?? {}));

describe("W-904 updateShipmentImpl never writes shippedAt from its pre-read", () => {
  it("1: a ship claim that commits between the read and the write keeps its stamp on the order", async () => {
    const order = baseOrder();
    const f = fakeDb(order, [], claim);
    await save(f.deps);
    expect(order.shippedAt).toEqual(T);
    expect(order.shippingTrackingNumber).toBe("1Z999");
    expect(
      f.writes.filter((w) => w.model === "order" && w.fn === "update").map((w) => w.args.data),
    ).toEqual([{ shippingCarrier: "UPS", shippingTrackingNumber: "1Z999" }]);
  });

  it("2: ...and on the invoice whose stamp was copied at creation", async () => {
    const order = baseOrder();
    const inv = { id: "inv-1", status: "SENT", shippedAt: T };
    const f = fakeDb(order, [inv], claim);
    await save(f.deps);
    expect(inv.shippedAt).toEqual(T);
  });

  it("2b: an invoice created before the ship (null stamp) is filled from the order's committed stamp", async () => {
    const order = baseOrder();
    const inv = { id: "inv-1", status: "SENT", shippedAt: null as Date | null };
    const f = fakeDb(order, [inv], claim);
    await save(f.deps);
    expect(inv.shippedAt).toEqual(T);
  });

  it("4: a legacy shipped order with no stamp is stamped once (the backfill is kept)", async () => {
    const order = baseOrder({ status: "OUT_FOR_DELIVERY" });
    const inv = { id: "inv-1", status: "SENT", shippedAt: null as Date | null };
    const f = fakeDb(order, [inv]);
    await save(f.deps);
    expect(order.shippedAt).toBeInstanceOf(Date);
    expect(inv.shippedAt).toEqual(order.shippedAt);
  });

  it("6: a CONFIRMED order is not stamped, and no write carries the key (E-b)", async () => {
    const order = baseOrder();
    const inv = { id: "inv-1", status: "SENT", shippedAt: null as Date | null };
    const f = fakeDb(order, [inv]);
    await save(f.deps);
    expect(order.shippedAt).toBeNull();
    expect(inv.shippedAt).toBeNull();
    expect(wroteShippedAt(f.writes)).toBe(false);
  });

  it("7: clearing the tracking keeps the stamp the transition wrote", async () => {
    const order = baseOrder({
      status: "OUT_FOR_DELIVERY",
      shippedAt: T,
      shippingTrackingNumber: "1Z",
    });
    const inv = { id: "inv-1", status: "SENT", shippedAt: T };
    const f = fakeDb(order, [inv]);
    await save(f.deps, { shippingTrackingNumber: "" });
    expect(order.shippedAt).toEqual(T);
    expect(inv.shippedAt).toEqual(T);
    expect(order.shippingTrackingNumber).toBeNull();
  });

  it("8: the mirror fills a null invoice stamp and never moves one that already has a date", async () => {
    const order = baseOrder({ status: "OUT_FOR_DELIVERY", shippedAt: T });
    const early = { id: "inv-a", status: "SENT", shippedAt: null as Date | null };
    const dated = { id: "inv-b", status: "SENT", shippedAt: T2 };
    const f = fakeDb(order, [early, dated]);
    await save(f.deps);
    expect(early.shippedAt).toEqual(T);
    expect(dated.shippedAt).toEqual(T2);
  });

  it("a void invoice is never touched by the mirror", async () => {
    const order = baseOrder({ status: "OUT_FOR_DELIVERY", shippedAt: T });
    const voided = { id: "inv-v", status: "VOID", shippedAt: null as Date | null };
    const f = fakeDb(order, [voided]);
    await save(f.deps);
    expect(voided.shippedAt).toBeNull();
  });
});
