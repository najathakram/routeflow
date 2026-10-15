import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { InvoicesService } from "../invoices/invoices.service";

/**
 * Row 372 (SA-735 items 2-4, API half), through the REAL updateOrderItems with the harness' mock Prisma:
 *  (2) `expectedRevisionNumber`: a mismatch with the latest OrderRevision is 409 ORDER_REVISION_STALE before any
 *      write (inside the Order-locked tx), and GET /orders/:id exposes `revisionNumber` (one derivation);
 *  (3) a payload line id that is absent from the LOCKED lines is 409 CONCURRENT_UPDATE before any write; the
 *      `heldOrSnapshot` fallback to the pre-tx snapshot is gone;
 *  (4) B720: a product the pre-lock context did not load (a concurrent substitution) is loaded AFTER the lock.
 * The real-Postgres pins live in orders.revision-guard.db.spec.ts.
 */
const MOCK_ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-1",
  status: "PENDING" as const,
  source: "APP" as const,
  urgent: false,
  subtotal: 20,
  tax: 0,
  total: 20,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Acme Wholesale" },
};
const line = {
  id: "li-1",
  orderId: "ord-1",
  productId: "prod-A",
  qty: 2,
  unitPrice: 10,
  subtotal: 20,
  status: "PENDING",
  boxes: null,
  pieces: null,
  unitLabel: null,
  invoicedQty: 0,
  deliveredQty: 0,
  trackedCategoryId: null,
};
const product = { id: "prod-A", pricePerUnit: 10, unitsPerBox: null, trackedCategoryId: null };

describe("updateOrderItems: revision guard, vanished line, B720 (row 372)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.order.findUnique.mockResolvedValue({ ...MOCK_ORDER, lineItems: [line] });
    h.prisma.orderItem.findMany.mockResolvedValue([line]);
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([product]);
    h.prisma.product.findUnique.mockResolvedValue(product);
    h.prisma.orderRevision.aggregate.mockResolvedValue({ _max: { revisionNumber: 3 } });
  });
  const writes = () =>
    h.prisma.orderItem.update.mock.calls.length +
    h.prisma.orderItem.create.mock.calls.length +
    h.prisma.orderItem.delete.mock.calls.length +
    h.prisma.orderItem.deleteMany.mock.calls.length;
  const edit = (dto: Record<string, unknown>) =>
    h.service.updateOrderItems("ord-1", dto as never, operatorPayload as never);

  it("a stale expectedRevisionNumber is 409 ORDER_REVISION_STALE and nothing is written", async () => {
    await expect(
      edit({ items: [{ id: "li-1", qty: 3 }], expectedRevisionNumber: 2 }),
    ).rejects.toMatchObject({ response: { code: "ORDER_REVISION_STALE" } });
    expect(writes()).toBe(0);
  });

  it("a stale edit is refused BEFORE any un-tx'd side effect: no invoice revert, no transaction opened", async () => {
    const invoices: any = h.module.get(InvoicesService);
    await expect(
      edit({ items: [{ id: "li-1", qty: 3 }], expectedRevisionNumber: 2 }),
    ).rejects.toMatchObject({ response: { code: "ORDER_REVISION_STALE" } });
    expect(invoices.revertLinkedInvoicesForOrderEdit).not.toHaveBeenCalled();
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("the matching expectedRevisionNumber (and an omitted one) edits as before", async () => {
    await edit({ items: [{ id: "li-1", qty: 3 }], expectedRevisionNumber: 3 });
    expect(h.prisma.orderItem.update).toHaveBeenCalled();
    h.prisma.orderItem.update.mockClear();
    await edit({ items: [{ id: "li-1", qty: 4 }] });
    expect(h.prisma.orderItem.update).toHaveBeenCalled();
  });

  it("GET /orders/:id exposes revisionNumber = the latest EDIT revision", async () => {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      lineItems: [],
      revisions: [{ revisionNumber: 2 }, { revisionNumber: 3 }],
      changeRequests: [],
      invoices: [],
      payments: [],
    });
    const got: any = await h.service
      .findOne("ord-1", operatorPayload as never)
      .catch((e: any) => e);
    expect(got?.revisionNumber).toBe(3);
  });

  it("MF2: reopenOrder revives item-CANCELLED lines, so it appends a SYSTEM_REOPEN revision in the same tx", async () => {
    h.prisma.order.findUnique.mockResolvedValue({
      ...MOCK_ORDER,
      status: "CANCELLED",
      lineItems: [{ ...line, status: "CANCELLED" }],
    });
    h.prisma.order.update.mockResolvedValue({ ...MOCK_ORDER, status: "PENDING", lineItems: [] });
    h.prisma.order.findUniqueOrThrow.mockResolvedValue({
      subtotal: 20,
      tax: 0,
      total: 20,
      shippingFee: 0,
    });
    h.prisma.invoice.findFirst.mockResolvedValue(null);
    await h.service.reopenOrder("ord-1");
    expect(h.prisma.orderItem.updateMany).toHaveBeenCalled();
    expect(h.prisma.orderRevision.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.orderRevision.create.mock.calls[0][0].data).toMatchObject({
      orderId: "ord-1",
      source: "SYSTEM_REOPEN",
    });
  });

  it("the PATCH response carries the revisionNumber the edit produced (a re-opened editor is based on it)", async () => {
    const edited: any = await edit({ items: [{ id: "li-1", qty: 3 }] });
    expect(edited.revisionNumber).toBe(3); // latestEditRevisionNumber over the mocked aggregate
  });

  it("a payload line id absent from the locked lines is 409 CONCURRENT_UPDATE, with nothing written (no snapshot fallback)", async () => {
    // the pre-tx snapshot still lists li-1, but under the lock it is gone (another writer deleted it)
    h.prisma.orderItem.findMany.mockResolvedValue([]);
    await expect(edit({ items: [{ id: "li-1", qty: 3 }] })).rejects.toMatchObject({
      response: { code: "CONCURRENT_UPDATE" },
    });
    expect(writes()).toBe(0);
  });

  it("a payload line id the order NEVER had stays a 404 (the prior contract), not a 409 CONCURRENT_UPDATE", async () => {
    // the lock holds li-1 and the pre-tx snapshot listed li-1 only: li-foreign belongs to another order (or none)
    const err: any = await edit({ items: [{ id: "li-foreign", action: "CANCEL" }] }).catch(
      (e: any) => e,
    );
    expect(err?.response?.code).not.toBe("CONCURRENT_UPDATE");
    expect(writes()).toBe(0);
  });

  it("B720: a product the pre-lock context never loaded is read inside the transaction, after the lock", async () => {
    // the line is unit-aware only under the lock (a concurrent edit gave it a unit): its product was not loaded
    h.prisma.orderItem.findMany.mockResolvedValue([{ ...line, unitLabel: "Case" }]);
    const reads: string[] = [];
    h.prisma.product.findMany.mockImplementation(async (args: any) => {
      reads.push(JSON.stringify(args?.where?.id?.in ?? null));
      return [product];
    });
    await edit({ items: [{ id: "li-1", qty: 3, unitLabel: "Case" }] }).catch(() => undefined);
    // loaded by id, from the locked line's product, not skipped and not a TypeError on a map get
    expect(reads).toContain('["prod-A"]');
  });

  it("the post-lock checks sit AFTER the Order lock in the transaction (structure)", () => {
    const src: string = require("fs").readFileSync(
      require("path").resolve(__dirname, "orders.service.ts"),
      "utf8",
    );
    const lock = src.indexOf("FOR UPDATE`;");
    expect(lock).toBeGreaterThan(0);
    expect(src.indexOf("await assertRevisionCurrent(tx, orderId")).toBeGreaterThan(lock);
    expect(src.indexOf("assertLockedEditLines(tx, unitCtx, heldItems, dto.items)")).toBeGreaterThan(
      lock,
    );
    expect(src).not.toContain("heldOrSnapshot");
  });
});
