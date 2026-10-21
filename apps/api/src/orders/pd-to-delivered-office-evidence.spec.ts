import { OrderStatus } from "@prisma/client";
import { makeStampDb } from "../common/testing/delivered-stamp-fake-db";
import { deliveredBasisByLine, deliveredQtyFromBasis } from "../invoices/delivered-basis-by-line";
import { updateStatusWithShipMarker } from "./order-ship-state";
import { buildStatusUpdateData } from "./order-status-claim";

/**
 * Row 587 (SA-814h item 4, P1): a PARTIALLY_DELIVERED -> DELIVERED write left the lines the OFFICE had marked
 * partly delivered at the partial figure. An office PD records its quantities as DeliveryMutation evidence
 * (order-pd-quantities.ts, no route stop, no driver); the "entry" stamp skipped every evidenced line, so a
 * 6-of-10 line stayed at 6 on a DELIVERED order and the delivered-basis invoice billed 6.
 * The ruled figure: DELIVERED completes an OFFICE-evidenced line to its qty, by an office DELIVERED row for the
 * remainder (rows beat the column). A ROUTE-evidenced line keeps its route figure (R4-3 note, a separate row).
 */
const order = (db: ReturnType<typeof makeStampDb>) => ({
  id: "o1",
  tenantId: "t1",
  status: db.committed.order.status as OrderStatus,
  fulfillPath: "ROUTE" as never,
  subtotal: 10,
  tax: 0,
  total: 10,
  deliveredAt: null,
  orderDate: null,
  shippedAt: null,
  notes: null,
});
const deliver = (db: ReturnType<typeof makeStampDb>, from: OrderStatus) =>
  updateStatusWithShipMarker(
    { prisma: db.prisma },
    { ...order(db), status: from },
    { status: OrderStatus.DELIVERED },
    undefined,
    buildStatusUpdateData(order(db) as never, OrderStatus.DELIVERED, {
      isDeliveredDemotion: false,
    }),
  );
const officeRow = (orderItemId: string, quantityDelivered: number, type = "PARTIAL") => ({
  orderItemId,
  type,
  quantityDelivered,
  routeRunStopId: null,
  driverId: null,
  note: "OFFICE_MARKED",
});
/** What the delivered-basis invoice bills for the line: the evidence reader, never the column. */
const billedQty = async (db: ReturnType<typeof makeStampDb>, id: string) => {
  const tx = db.prisma.forTenant();
  const basis = await deliveredBasisByLine(tx as never, "o1");
  return deliveredQtyFromBasis(db.line(id), basis);
};

describe("row 587: PD -> DELIVERED completes the office-evidenced lines", () => {
  it("a line the office marked 6 of 10 is delivered in full: column 10, a remainder row of 4, invoice basis 10", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [
        { id: "a", qty: 10, deliveredQty: 6 },
        { id: "b", qty: 2, deliveredQty: 0 },
      ],
      mutations: [officeRow("a", 6)],
    });
    await deliver(db, OrderStatus.PARTIALLY_DELIVERED);
    expect(db.committed.order.status).toBe("DELIVERED");
    expect(db.line("a").deliveredQty).toBe(10); // master: 6
    expect(await billedQty(db, "a")).toBe(10); // master: 6 (the invoice bills the partial figure)
    expect(db.line("b").deliveredQty).toBe(2); // the no-evidence line is stamped as before
    const added = db.committed.mutations.filter(
      (m) => m.orderItemId === "a" && m.type === "DELIVERED",
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      orderId: "o1",
      quantityDelivered: 4,
      routeRunStopId: null,
      driverId: null,
    });
  });

  it("SA-833 (a): each completed line is audited ('line X: 6 -> 10, office completion') and named in the response", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [{ id: "a", qty: 10, deliveredQty: 6 }],
      mutations: [officeRow("a", 6)],
    });
    const res: any = await updateStatusWithShipMarker(
      { prisma: db.prisma },
      { ...order(db), status: OrderStatus.PARTIALLY_DELIVERED },
      { status: OrderStatus.DELIVERED },
      { sub: "u1", impersonatedBy: "sa1" } as never,
      buildStatusUpdateData(order(db) as never, OrderStatus.DELIVERED, {
        isDeliveredDemotion: false,
      }),
    );
    expect(res.officeCompletedLines).toEqual([
      { lineId: "a", from: 6, to: 10, summary: "line a: 6 -> 10, office completion" },
    ]);
    expect(db.committed.audits).toHaveLength(1);
    expect(db.committed.audits[0]).toMatchObject({
      tenantId: "t1",
      userId: "u1",
      impersonatedBy: "sa1",
      action: "order.line-office-completed",
      entityType: "Order",
      entityId: "o1",
      meta: { lineId: "a", from: 6, to: 10, summary: "line a: 6 -> 10, office completion" },
    });
  });

  it("a fractional remainder is exact (3 of 7.5 leaves 4.5)", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [{ id: "a", qty: 7.5, deliveredQty: 3 }],
      mutations: [officeRow("a", 3)],
    });
    await deliver(db, OrderStatus.PARTIALLY_DELIVERED);
    expect(db.line("a").deliveredQty).toBe(7.5);
    expect(await billedQty(db, "a")).toBe(7.5);
  });

  it("is idempotent: a second DELIVERED write adds no row and moves no column", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [{ id: "a", qty: 10, deliveredQty: 6 }],
      mutations: [officeRow("a", 6)],
    });
    await deliver(db, OrderStatus.PARTIALLY_DELIVERED);
    const rows = db.committed.mutations.length;
    db.calls.lineWrites = 0;
    const again: any = await deliver(db, OrderStatus.DELIVERED); // a re-entry of the DELIVERED write
    expect(db.committed.mutations).toHaveLength(rows);
    expect(db.calls.lineWrites).toBe(0);
    expect(db.committed.audits).toHaveLength(1); // no second audit row
    expect(again.officeCompletedLines).toBeUndefined();
  });

  it("an office line already delivered in full gets no extra row", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [
        { id: "a", qty: 4, deliveredQty: 4 },
        { id: "b", qty: 5, deliveredQty: 0 },
      ],
      mutations: [officeRow("a", 4, "DELIVERED")],
    });
    await deliver(db, OrderStatus.PARTIALLY_DELIVERED);
    expect(db.committed.mutations).toHaveLength(1);
    expect(db.committed.audits).toHaveLength(0);
    expect(db.line("b").deliveredQty).toBe(5);
  });

  it("control: a ROUTE-evidenced short line keeps its route figure and gains no row", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [{ id: "route", qty: 10, deliveredQty: 6 }],
      mutations: [{ ...officeRow("route", 6), routeRunStopId: "stop-1", driverId: "d1" }],
    });
    await deliver(db, OrderStatus.PARTIALLY_DELIVERED);
    expect(db.line("route").deliveredQty).toBe(6);
    expect(db.committed.mutations).toHaveLength(1);
    expect(db.committed.audits).toHaveLength(0);
  });

  it("control: a line with a route row AND an office row is a route line and stays", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [{ id: "mixed", qty: 10, deliveredQty: 6 }],
      mutations: [{ ...officeRow("mixed", 4), routeRunStopId: "stop-1" }, officeRow("mixed", 2)],
    });
    await deliver(db, OrderStatus.PARTIALLY_DELIVERED);
    expect(db.line("mixed").deliveredQty).toBe(6);
    expect(db.committed.mutations).toHaveLength(2);
    expect(db.committed.audits).toHaveLength(0);
  });

  it("control: a REFUSED row is a resolved outcome, not a partial figure: the line stays", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [{ id: "a", qty: 3, deliveredQty: 0 }],
      mutations: [officeRow("a", 0, "REFUSED")],
    });
    await deliver(db, OrderStatus.PARTIALLY_DELIVERED);
    expect(db.line("a").deliveredQty).toBe(0);
    expect(db.committed.mutations).toHaveLength(1);
    expect(db.committed.audits).toHaveLength(0);
  });

  it("control: a CANCELLED office line is left alone", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [{ id: "dead", qty: 10, deliveredQty: 6, status: "CANCELLED" }],
      mutations: [officeRow("dead", 6)],
    });
    await deliver(db, OrderStatus.PARTIALLY_DELIVERED);
    expect(db.line("dead").deliveredQty).toBe(6);
    expect(db.committed.mutations).toHaveLength(1);
    expect(db.committed.audits).toHaveLength(0);
  });

  it("a failure after the status write rolls the remainder row back with it", async () => {
    const db = makeStampDb({
      status: "PARTIALLY_DELIVERED",
      lines: [{ id: "a", qty: 10, deliveredQty: 6 }],
      mutations: [officeRow("a", 6)],
      failAfterStatusWrite: true,
    });
    await expect(deliver(db, OrderStatus.PARTIALLY_DELIVERED)).rejects.toThrow("boom");
    expect(db.committed.mutations).toHaveLength(1);
    expect(db.committed.audits).toHaveLength(0);
    expect(db.line("a").deliveredQty).toBe(6);
  });
});
