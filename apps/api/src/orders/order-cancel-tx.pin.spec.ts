// The harness FIRST: it jest.mock()s modules that orders.service also imports.
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { BadRequestException } from "@nestjs/common";
import { InvoicesService } from "../invoices/invoices.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";

// SA-762r F5: the office cancel (PATCH status CANCELLED) is pinned here BEFORE its transaction body moves
// into cancelOrderInTx (order-cancel-tx.ts). Every assertion is green on the old inline code and must stay
// green on the extracted one: the stock credit, the credit/wallet release, the invoice voids and the item
// marking, in that order, behind the one compare-and-set status claim. Real-DB twin: order-cancel-tx.db.spec.ts.
jest.mock("./driver-edit-access", () => ({ assertDriverMayEditOrder: jest.fn() }));

const ORDER = {
  id: "ord-1",
  customerId: "cust-1",
  orderNumber: "ORD-123",
  status: "CONFIRMED",
  source: "APP",
  urgent: false,
  subtotal: 50,
  tax: 0,
  total: 50,
  notes: null,
  driverNote: null,
  routeRunId: null,
  routeRunStopId: null,
  deliveredAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  customer: { businessName: "Test Business" },
};

describe("office cancel of a CONFIRMED order (pin: identical before/after the cancelOrderInTx extraction)", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let invoices: { releaseWalletPaymentsInTx: jest.Mock; voidInvoiceInTx: jest.Mock };
  let credits: { releaseOrderCreditsInTx: jest.Mock };

  beforeEach(async () => {
    h = await buildOrdersService();
    invoices = h.module.get(InvoicesService) as never;
    credits = h.module.get(CreditNotesService) as never;
    const { prisma } = h;
    prisma.order.findUnique.mockResolvedValue(ORDER);
    prisma.order.findFirst.mockResolvedValue(ORDER); // cancelImpact's own read
    prisma.order.update.mockResolvedValue({ ...ORDER, status: "CANCELLED" });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    // 1st read = cancelImpact (pre-check), 2nd = the live invoices the cancel voids.
    prisma.invoice.findMany
      .mockResolvedValueOnce([
        { id: "inv-1", invoiceNumber: "INV-1", status: "SENT", total: 50, payments: [] },
        { id: "inv-2", invoiceNumber: "INV-2", status: "SENT", total: 0, payments: [] },
      ])
      .mockResolvedValueOnce([{ id: "inv-1" }, { id: "inv-2" }]);
    prisma.orderItem.findMany.mockResolvedValue([
      {
        productId: "prod-1",
        qty: 5,
        deliveredQty: 0,
        status: "CONFIRMED",
        unitsPerBox: null,
        boxes: null,
        pieces: null,
        unitLabel: null,
      },
    ] as never);
    prisma.product.findMany.mockResolvedValue([
      { id: "prod-1", name: "Tomatoes", currentStock: 10, unitsPerBox: null },
    ] as never);
    prisma.product.update.mockResolvedValue({ id: "prod-1", currentStock: 15 } as never);
  });

  it("credits the stock, releases credits and wallet, voids every live invoice, marks the items", async () => {
    const { prisma } = h;
    await h.service.changeStatus(
      "ord-1",
      { status: "CANCELLED" as never },
      operatorPayload as never,
    );

    // stock: the creation-time decrement comes back (+5), recorded as a CANCEL movement
    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: "prod-1" },
      data: { currentStock: { increment: 5 } },
    });
    expect(prisma.stockMovement.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ notes: "CANCEL" }) }),
    );
    // the order's credits, then each invoice's wallet money, then the void (the SA-404d unwind order)
    expect(credits.releaseOrderCreditsInTx).toHaveBeenCalledWith(expect.anything(), "ord-1");
    expect(invoices.releaseWalletPaymentsInTx).toHaveBeenCalledTimes(2);
    expect(invoices.releaseWalletPaymentsInTx).toHaveBeenCalledWith(expect.anything(), "inv-1");
    expect(invoices.voidInvoiceInTx).toHaveBeenCalledWith(expect.anything(), "inv-1", "ord-1");
    expect(invoices.voidInvoiceInTx).toHaveBeenCalledWith(expect.anything(), "inv-2", "ord-1");
    // the lines this cancel released are marked CANCELLED (reopenOrder re-decrements exactly these)
    expect(prisma.orderItem.updateMany).toHaveBeenCalledWith({
      where: { orderId: "ord-1", status: { not: "CANCELLED" } },
      data: { status: "CANCELLED" },
    });
    // the status write is the CAS on the cancellable set (never DELIVERED), carrying the CANCELLED status
    const claim = prisma.order.updateMany.mock.calls[0][0];
    expect(claim.where.id).toBe("ord-1");
    expect(claim.where.status.in).toEqual(expect.arrayContaining(["PENDING", "CONFIRMED"]));
    expect(claim.where.status.in).not.toContain("DELIVERED");
    expect(claim.data).toMatchObject({ status: "CANCELLED" });
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it("runs claim -> stock credit -> credit release -> wallet release -> void -> item marking", async () => {
    const { prisma } = h;
    await h.service.changeStatus(
      "ord-1",
      { status: "CANCELLED" as never },
      operatorPayload as never,
    );
    const first = (m: { mock: { invocationCallOrder: number[] } }) => m.mock.invocationCallOrder[0];
    const steps = [
      first(prisma.order.updateMany),
      first(prisma.product.update),
      first(credits.releaseOrderCreditsInTx),
      first(invoices.releaseWalletPaymentsInTx),
      first(invoices.voidInvoiceInTx),
      first(prisma.orderItem.updateMany),
    ];
    expect(steps.every((n) => typeof n === "number")).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });

  it("PATCH status CANCELLED on a DELIVERED order is still a 400 and writes nothing", async () => {
    const { prisma } = h;
    const delivered = { ...ORDER, status: "DELIVERED", deliveredAt: new Date() };
    prisma.order.findUnique.mockResolvedValue(delivered);
    prisma.order.findFirst.mockResolvedValue(delivered);
    const err = await h.service
      .changeStatus("ord-1", { status: "CANCELLED" as never }, operatorPayload as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(invoices.voidInvoiceInTx).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
  });
});
