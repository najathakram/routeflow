// The sweep runs inside a Postgres advisory lock; these specs pin the cap on the FOLD, not the lock, so the critical
// section runs inline (mirrors orders.line-author-merge.spec.ts).
jest.mock("./merge-lock-recheck", () => require("./testing/merge-recheck").pass());
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { buildOrdersService } from "./testing/orders-service-harness";
import * as lineCap from "./buyer-line-cap";

/**
 * B1386 (REG-B1386 S1-S6): the after-create sweep (`mergeAllPendingForCustomer`) runs AFTER the new order committed, so
 * it cannot refuse. When the fold involves a buyer (a buyer-initiated sweep, or any buyer-authored line), a loser order
 * whose fold would push a merged line past `BUYER_LINE_QTY_MAX` (rise-only) is kept apart: it stays its own pending order,
 * is not folded at all, and a warn names the order ids and product ids. Staff-only folds are unchanged. Synthetic data.
 *
 * How a buyer fold is told from a staff fold: a line's own `authorChannel` marker, else its order's recorded source
 * (APP = buyer, PHONE/ROUTE = staff; an order that never recorded its source is UNKNOWN_LEGACY = staff), plus the
 * `buyerInitiated` option of the buyer-portal and customer-create callers.
 */
const line = (
  id: string,
  productId: string,
  qty: number,
  authorChannel: string | null = "BUYER",
) => ({
  id,
  productId,
  qty,
  unitPrice: 5,
  subtotal: 5,
  status: "PENDING",
  priceType: "STANDARD",
  originalPrice: null,
  name: null,
  overrideReason: null,
  overriddenBy: null,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  trackedCategoryId: null,
  categoryTaxType: null,
  categoryTaxRate: null,
  categoryPriceIncludesTax: null,
  notes: null,
  promoFreeUnits: null,
  authorChannel,
});
const order = (id: string, src: object, lineItems: unknown[]) => ({
  id,
  customerId: "cust-1",
  status: "PENDING",
  ...src,
  lineItems,
});
const APP = { source: "APP", sourceRecorded: true };
const PHONE = { source: "PHONE", sourceRecorded: true };

describe("the sweep keeps an order apart when its fold would pass the buyer line cap (REG-B1386 S1-S6)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let warn: jest.SpyInstance;

  const nothingWritten = () => {
    expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    expect(h.prisma.order.delete).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.product.findMany.mockResolvedValue([
      { id: "single", unitsPerBox: null },
      { id: "boxed", unitsPerBox: 12 },
      { id: "other", unitsPerBox: null },
    ]);
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 5, status: "PENDING" }]);
    warn = jest.spyOn((h.service as any).logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it("REG-B1386 S1: a winner line of 99,996 + a loser line of 99,996 (one product, buyer fold) stay two orders, a warn, no write", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", APP, [line("w-a", "single", 99_996)]),
      order("l1", APP, [line("l-a", "single", 99_996)]),
    ]);
    const merged = await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });
    expect(merged).toBeNull();
    nothingWritten();
    const kept = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("apart"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("l1");
    expect(kept[0]).toContain("w1");
    expect(kept[0]).toContain("single");
  });

  it("S1b: the same fold with no buyerInitiated flag (the hourly sweep, a template run) is told apart by the line author", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", APP, [line("w-a", "single", 99_996, null)]),
      order("l1", APP, [line("l-a", "single", 99_996, null)]),
    ]);
    expect(await h.service.mergeAllPendingForCustomer("cust-1")).toBeNull();
    nothingWritten();
  });

  it("REG-B1386 S2: a 12-pack with 8,333 packs on each side is kept apart (16,666 boxes = 199,992 pieces)", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", APP, [line("w-a", "boxed", 8_333)]),
      order("l1", APP, [line("l-a", "boxed", 8_333)]),
    ]);
    expect(
      await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true }),
    ).toBeNull();
    nothingWritten();
  });

  it("REG-B1386 S3: a fold under the cap (50,000 + 50,000 = exactly 100,000) still merges", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", APP, [line("w-a", "single", 50_000)]),
      order("l1", APP, [line("l-a", "single", 50_000)]),
    ]);
    await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });
    const update = h.prisma.orderItem.update.mock.calls
      .map((c: any) => c[0])
      .find((a: any) => a.where.id === "w-a");
    expect(Number(update?.data.qty)).toBe(100_000);
    expect(h.prisma.order.delete).toHaveBeenCalledTimes(1);
  });

  it("REG-B1386 S4: a staff-only fold at 240,000 still merges (staff limits unchanged)", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", PHONE, [line("w-a", "single", 120_000, "STAFF")]),
      order("l1", PHONE, [line("l-a", "single", 120_000, "STAFF")]),
    ]);
    await h.service.mergeAllPendingForCustomer("cust-1");
    const update = h.prisma.orderItem.update.mock.calls
      .map((c: any) => c[0])
      .find((a: any) => a.where.id === "w-a");
    expect(Number(update?.data.qty)).toBe(240_000);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("apart"))).toBe(false);
  });

  it("REG-B1386 S5: the sweep judges the merged lines through the shared buyerLinesOverCap", async () => {
    const spy = jest.spyOn(lineCap, "buyerLinesOverCap");
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", APP, [line("w-a", "single", 50_000)]),
      order("l1", APP, [line("l-a", "single", 50_000)]),
    ]);
    await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });
    expect(spy).toHaveBeenCalled();
    const judged = spy.mock.calls.flatMap((c) => c[0]);
    expect(judged).toEqual([{ productId: "single", pieces: 100_000, storedPieces: 50_000 }]);
  });

  it("REG-B1386 S6: rise-only: a winner already at 120,000 (pre-fix) + a loser line of a DIFFERENT product still merges, the 120,000 line untouched", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", APP, [line("w-a", "single", 120_000)]),
      order("l1", APP, [line("l-a", "other", 5)]),
    ]);
    await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });
    expect(h.prisma.orderItem.update.mock.calls.map((c: any) => c[0].where.id)).not.toContain(
      "w-a",
    );
    const created = h.prisma.orderItem.create.mock.calls.map((c: any) => c[0].data);
    expect(created.map((d: any) => d.productId)).toEqual(["other"]);
    expect(h.prisma.order.delete).toHaveBeenCalledTimes(1);
  });

  it("S6b: the same 120,000 line may not be raised by a loser line of its own product", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", APP, [line("w-a", "single", 120_000)]),
      order("l1", APP, [line("l-a", "single", 1)]),
    ]);
    expect(
      await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true }),
    ).toBeNull();
    nothingWritten();
  });

  it("S7: a loser line already above the cap (120,000) moves over intact: that is not a rise", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", APP, [line("w-a", "other", 5)]),
      order("l1", APP, [line("l-a", "single", 120_000)]),
    ]);
    await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });
    const created = h.prisma.orderItem.create.mock.calls.map((c: any) => c[0].data);
    expect(created.map((d: any) => Number(d.qty))).toEqual([120_000]);
  });

  it("S8: with several losers, the over-cap order alone is kept apart; the others still fold (no partial fold of an order)", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", APP, [line("w-a", "single", 60_000)]),
      order("l1", APP, [line("l-a", "single", 30_000)]),
      order("l2", APP, [line("l-b", "single", 30_000), line("l-c", "other", 7)]),
    ]);
    await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true });
    const update = h.prisma.orderItem.update.mock.calls
      .map((c: any) => c[0])
      .find((a: any) => a.where.id === "w-a");
    expect(Number(update?.data.qty)).toBe(90_000); // l1 folded
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled(); // l2's "other" line did not move: l2 stays whole
    expect(h.prisma.order.delete).toHaveBeenCalledTimes(1);
    expect(h.prisma.order.delete.mock.calls[0][0]).toEqual({ where: { id: "l1" } });
  });

  it("S9: a buyer-initiated sweep caps a fold of staff-authored lines too (a buyer drove it)", async () => {
    h.prisma.order.findMany.mockResolvedValue([
      order("w1", PHONE, [line("w-a", "single", 99_996, "STAFF")]),
      order("l1", PHONE, [line("l-a", "single", 99_996, "STAFF")]),
    ]);
    expect(
      await h.service.mergeAllPendingForCustomer("cust-1", { buyerInitiated: true }),
    ).toBeNull();
    nothingWritten();
  });
});
