import { BadRequestException } from "@nestjs/common";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { InvoicesService } from "../invoices/invoices.service";

/**
 * Row 466: createSale commits the ORDER, then builds its invoice. When the invoice step throws (or
 * returns nothing) the error carries `orderId`, so the client opens the order instead of retrying
 * into a duplicate sale. Lives apart from orders.service.spec.ts, which is size-ratchet capped.
 */
describe("OrdersService.createSale — the invoice step fails after the order committed (row 466)", () => {
  const dto = {
    customerId: "cust-1",
    items: [{ productId: "p1", qty: 2, unitPrice: 5 }],
    deliveredNow: true,
    dueDate: "2026-09-25",
    terms: "T",
    paymentTermsLabel: "Net 30",
  } as never;

  async function setup() {
    const h = await buildOrdersService();
    const invoices = h.module.get(InvoicesService) as unknown as Record<string, jest.Mock>;
    jest
      .spyOn(h.service, "create")
      .mockResolvedValue({ id: "ord-1", customerId: "cust-1", orderNumber: "ORD-1" } as never);
    return { h, invoices };
  }
  const sell = (h: Awaited<ReturnType<typeof setup>>["h"]) =>
    h.service.createSale(dto, operatorPayload as never).catch((e) => e);

  it("an HttpException keeps its class, status and code and gains orderId", async () => {
    const { h, invoices } = await setup();
    invoices.createInvoiceFromOrder.mockRejectedValueOnce(
      new BadRequestException({ code: "SOME_REFUSAL", message: "no" }),
    );
    const err = await sell(h);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toMatchObject({
      code: "SOME_REFUSAL",
      message: "no",
      orderId: "ord-1",
    });
  });

  it("an HttpException that already carries invoiceId keeps it and gains orderId", async () => {
    const { h, invoices } = await setup();
    invoices.createInvoiceFromOrder.mockRejectedValueOnce(
      new BadRequestException({ code: "X", invoiceId: "inv-9" }),
    );
    const err = await sell(h);
    expect(err.getResponse()).toMatchObject({ invoiceId: "inv-9", orderId: "ord-1" });
  });

  it("a non-HTTP error is a coded 500 with a fixed message, orderId and the original as cause", async () => {
    const { h, invoices } = await setup();
    const cause = new Error("deadlock detected: secret-detail");
    invoices.createInvoiceFromOrder.mockRejectedValueOnce(cause);
    const err = await sell(h);
    expect(err.getStatus()).toBe(500);
    expect(err.getResponse()).toMatchObject({
      code: "SALE_INVOICE_CREATE_FAILED",
      orderId: "ord-1",
    });
    expect(JSON.stringify(err.getResponse())).not.toContain("secret-detail");
    expect(err.cause).toBe(cause);
  });

  it("an empty result is the same coded 500 carrying orderId (the old message is kept)", async () => {
    const { h, invoices } = await setup();
    invoices.createInvoiceFromOrder.mockResolvedValueOnce([]);
    const err = await sell(h);
    expect(err.getStatus()).toBe(500);
    expect(err.message).toMatch(/order was created but its invoice could not be generated/);
    expect(err.getResponse()).toMatchObject({
      code: "SALE_INVOICE_CREATE_FAILED",
      orderId: "ord-1",
    });
  });

  it("control: the happy path still calls createInvoiceFromOrder(orderId, undefined, terms)", async () => {
    const { h, invoices } = await setup();
    await h.service.createSale(dto, operatorPayload as never);
    expect(invoices.createInvoiceFromOrder).toHaveBeenCalledWith("ord-1", undefined, {
      dueDate: "2026-09-25",
      terms: "T",
      paymentTermsLabel: "Net 30",
    });
  });
});
