// Same driver-ownership stub as orders.update-items-restrictions.spec.ts (this file pins restrictions only).
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { ConflictException } from "@nestjs/common";

/**
 * A DRAFT order is judged at its promotion, EXCEPT when it has a live linked invoice: the undelivered-edit
 * reconcile re-syncs a SENT/VIEWED/PARTIAL/OVERDUE deposit mirror from the order's lines, so a banned product
 * added to the DRAFT would reach a sent document unjudged. With a non-VOID linked invoice a DRAFT edit is judged
 * like any live edit; with none (or only a VOID one) it stays flag-not-block.
 */
describe("updateOrderItems — a DRAFT order with a live linked invoice is judged", () => {
  const ORDER = {
    id: "ord-1",
    customerId: "cust-1",
    tenantId: "t-row",
    orderNumber: "ORD-1",
    status: "DRAFT",
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Acme" },
    lineItems: [
      {
        id: "li-a",
        orderId: "ord-1",
        productId: "prod-a",
        qty: 2,
        unitPrice: 10,
        subtotal: 20,
        status: "PENDING",
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        priceType: "STANDARD",
        originalPrice: null,
      },
    ],
  };
  const operator = { ...operatorPayload, tenantId: "t-caller" } as never;
  const ADD_X = { items: [{ productId: "prod-x", qty: 1 }] };
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const edit = () => {
    h.prisma.order.findUnique.mockResolvedValue({ ...ORDER });
    return h.service.updateOrderItems("ord-1", ADD_X as never, operator);
  };
  /** The linked-invoice lookup answers by the status filter the service asks with. */
  const linked = (status: string | null) =>
    h.prisma.invoice.findFirst.mockImplementation(async (args: any) => {
      const f = args?.where?.status;
      if (status === null || args?.where?.orderId !== "ord-1") return null;
      if (f?.not === status || (f?.in && !f.in.includes(status))) return null;
      return { id: "inv-1" };
    });

  beforeEach(async () => {
    h = await buildOrdersService();
    h.restrictions.getPolicy.mockResolvedValue({ enabled: true });
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.product.findMany.mockResolvedValue([
      { id: "prod-a", pricePerUnit: 10, unitsPerBox: null, category: null },
      { id: "prod-x", pricePerUnit: 5, unitsPerBox: null, category: null },
    ]);
    h.prisma.orderItem.findMany.mockResolvedValue(ORDER.lineItems);
  });

  it("a SENT mirror: adding a banned product is refused (409 SELLING_RESTRICTED) and nothing is written", async () => {
    linked("SENT");
    h.restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", blockedLines: [] }),
    );
    await expect(edit()).rejects.toMatchObject({ response: { code: "SELLING_RESTRICTED" } });
    expect(h.restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "STAFF", lines: [{ productId: "prod-x" }] }),
    );
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    expect(h.prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("control: no linked invoice, the DRAFT edits freely and the engine is never asked", async () => {
    linked(null);
    await edit();
    expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
  });

  it("control: only a VOID linked invoice, the DRAFT edits freely", async () => {
    linked("VOID");
    await edit();
    expect(h.restrictions.assertLinesSellable).not.toHaveBeenCalled();
  });

  it("race: no invoice at the pre-check, a deposit mirror committed before the lock is a retryable 409, nothing written", async () => {
    let asked = 0;
    h.prisma.invoice.findFirst.mockImplementation(async (args: any) => {
      if (args?.where?.status?.not !== "VOID") return null;
      return ++asked === 1 ? null : { id: "inv-1" }; // the in-lock re-read sees the new SENT mirror
    });
    await expect(edit()).rejects.toMatchObject({
      status: 409,
      response: { code: "ORDER_CHANGED_DURING_EDIT" },
    });
    expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    expect(h.prisma.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(h.prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("race control: still no invoice under the lock, the DRAFT edit proceeds", async () => {
    h.prisma.invoice.findFirst.mockResolvedValue(null);
    await edit();
    expect(h.prisma.orderItem.create).toHaveBeenCalled();
  });
});
