import { routeHeldLines } from "./route-held-lines";

/**
 * Row 590 (SA-978 §1): the DELIVERED response names the lines that keep the driver's figure. Read-only: the helper never
 * writes. A line is named when it has a qualifying route-stop row and its delivered figure (rows beat the column) is below qty.
 */
type Row = {
  orderItemId: string | null;
  type: string;
  quantityDelivered: number | null;
  routeRunStopId: string | null;
};
function fakeTx(
  lines: Array<{ id: string; qty: number; deliveredQty: number; status?: string }>,
  rows: Row[],
) {
  const writes = jest.fn();
  const tx = {
    orderItem: {
      findMany: jest.fn(async () =>
        lines.filter((l) => l.status !== "CANCELLED").map((l) => ({ ...l })),
      ),
      update: writes,
      updateMany: writes,
    },
    deliveryMutation: {
      findMany: jest.fn(async (args: { where: { routeRunStopId?: unknown } }) =>
        rows.filter((r) => (args.where.routeRunStopId ? r.routeRunStopId !== null : true)),
      ),
      create: writes,
    },
  };
  return { tx: tx as never, writes };
}
const route = (id: string, q: number, type = "PARTIAL"): Row => ({
  orderItemId: id,
  type,
  quantityDelivered: q,
  routeRunStopId: "stop-1",
});
const office = (id: string, q: number): Row => ({
  orderItemId: id,
  type: "PARTIAL",
  quantityDelivered: q,
  routeRunStopId: null,
});

describe("routeHeldLines", () => {
  it("names a 6-of-10 route line {lineId, delivered, qty}; reads only", async () => {
    const { tx, writes } = fakeTx([{ id: "L1", qty: 10, deliveredQty: 6 }], [route("L1", 6)]);
    expect(await routeHeldLines(tx, "o1")).toEqual([{ lineId: "L1", delivered: 6, qty: 10 }]);
    expect(writes).not.toHaveBeenCalled();
  });

  it("rows beat a stale column: delivered is the rows' sum", async () => {
    const { tx } = fakeTx(
      [{ id: "L1", qty: 10, deliveredQty: 0 }],
      [route("L1", 4), route("L1", 2)],
    );
    expect(await routeHeldLines(tx, "o1")).toEqual([{ lineId: "L1", delivered: 6, qty: 10 }]);
  });

  it("a route line delivered in full, an office-only line, a no-evidence line and a cancelled line are not named", async () => {
    const { tx } = fakeTx(
      [
        { id: "full", qty: 10, deliveredQty: 10 },
        { id: "off", qty: 10, deliveredQty: 6 },
        { id: "none", qty: 10, deliveredQty: 0 },
        { id: "gone", qty: 10, deliveredQty: 3, status: "CANCELLED" },
      ],
      [route("full", 10, "DELIVERED"), office("off", 6), route("gone", 3)],
    );
    expect(await routeHeldLines(tx, "o1")).toEqual([]);
  });

  it("a mixed line (an office row and a route row) keeps the route figure and is named", async () => {
    const { tx } = fakeTx(
      [{ id: "L1", qty: 10, deliveredQty: 8 }],
      [office("L1", 5), route("L1", 3)],
    );
    expect(await routeHeldLines(tx, "o1")).toEqual([{ lineId: "L1", delivered: 8, qty: 10 }]);
  });

  it("a REFUSED route row is a resolved outcome of 0 delivered, still named", async () => {
    const { tx } = fakeTx([{ id: "L1", qty: 4, deliveredQty: 0 }], [route("L1", 0, "REFUSED")]);
    expect(await routeHeldLines(tx, "o1")).toEqual([{ lineId: "L1", delivered: 0, qty: 4 }]);
  });
});
