import { BadRequestException } from "@nestjs/common";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { InvoicesService } from "../invoices/invoices.service";

/**
 * Row 466 ("the record lies"): createSale commits the order and its invoice, then sends. A send
 * failure after that carries the committed invoiceId and orderId, whatever the error was, so the
 * client opens what exists instead of retrying into a duplicate sale. Lives apart from
 * orders.service.spec.ts, which is size-ratchet capped.
 */
describe("OrdersService.createSale — a van-sale send failure keeps the draft (row 466)", () => {
  const dto = {
    customerId: "cust-1",
    items: [{ productId: "p1", qty: 2, unitPrice: 5 }],
    deliveredNow: true,
  } as never;

  async function setup() {
    const h = await buildOrdersService();
    const invoices = h.module.get(InvoicesService) as unknown as Record<string, jest.Mock>;
    jest
      .spyOn(h.service, "create")
      .mockResolvedValue({ id: "ord-1", customerId: "cust-1", orderNumber: "ORD-1" } as never);
    return { h, invoices };
  }

  it("an HttpException keeps its status and code and gains invoiceId and orderId", async () => {
    const { h, invoices } = await setup();
    invoices.send.mockRejectedValueOnce(
      new BadRequestException({ code: "EMAIL_SEND_FAILED", message: "smtp down" }),
    );
    const err = await h.service.createSale(dto, operatorPayload as never).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({
      code: "EMAIL_SEND_FAILED",
      invoiceId: "inv-1",
      orderId: "ord-1",
    });
    // The order and its invoice were created once; the failure created nothing more.
    expect(invoices.createInvoiceFromOrder).toHaveBeenCalledTimes(1);
  });

  it("a non-HTTP error is a coded 500 carrying both ids, never the raw message", async () => {
    const { h, invoices } = await setup();
    invoices.send.mockRejectedValueOnce(new Error("lock timeout: secret-detail"));
    const err = await h.service.createSale(dto, operatorPayload as never).catch((e) => e);
    expect(err.getStatus()).toBe(500);
    expect(err.getResponse()).toMatchObject({
      code: "INVOICE_SEND_AFTER_CREATE_FAILED",
      invoiceId: "inv-1",
      orderId: "ord-1",
    });
    expect(JSON.stringify(err.getResponse())).not.toContain("secret-detail");
  });

  it("a sale whose send works is unchanged: send(id) gets no extra argument", async () => {
    const { h, invoices } = await setup();
    await h.service.createSale(dto, operatorPayload as never);
    expect(invoices.send).toHaveBeenCalledWith("inv-1");
  });
});
