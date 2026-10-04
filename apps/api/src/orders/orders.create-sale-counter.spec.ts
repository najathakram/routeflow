import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { InvoicesService } from "../invoices/invoices.service";
import { ConflictException } from "@nestjs/common";

/**
 * createSale as the counter sale's engine (SA-655). createSale was four separate commits (create
 * -> DELIVERED -> invoice -> send): a failed invoice step leaves a DELIVERED, stock-decremented
 * order with no receivable. With an Idempotency-Key a retry now RESUMES from wherever the first
 * attempt stopped (create() hands back the original order and flags the replay), and never writes a
 * second invoice. No key = byte-identical to POST /orders/sell today.
 */
describe("OrdersService.createSale — counter-sale options and resume", () => {
  const dto = {
    customerId: "cust-1",
    items: [{ productId: "p1", qty: 2, unitPrice: 5 }],
    deliveredNow: true,
  } as never;
  const orderRow = (status: string) => ({
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-1",
    status,
  });

  async function setup(status = "PENDING") {
    const h = await buildOrdersService();
    const invoices = h.module.get(InvoicesService) as unknown as Record<string, jest.Mock>;
    let replayed = false;
    const create = jest
      .spyOn(h.service, "create")
      .mockImplementation(async (_dto: any, _user: any, options: any) => {
        if (replayed) options?.onReplay?.(orderRow(status));
        return orderRow(status) as never;
      });
    const setReplayed = (v: boolean, nextStatus?: string) => {
      replayed = v;
      if (nextStatus) status = nextStatus;
    };
    return { h, invoices, create, setReplayed };
  }

  it("no sale options: create() gets EXACTLY { skipAutoMerge: true } and send(id) gets no second argument (/sell unchanged)", async () => {
    const { h, invoices, create } = await setup();
    await h.service.createSale(dto, operatorPayload as never);
    expect(create.mock.calls[0][2]).toEqual({ skipAutoMerge: true });
    expect(create.mock.calls[0][0]).not.toHaveProperty("idempotencyKey");
    expect(invoices.send).toHaveBeenCalledWith("inv-1");
  });

  it("a counter sale passes PICKUP and the Idempotency-Key to create(), never merges, and still skipAutoMerge", async () => {
    const { h, create } = await setup();
    await h.service.createSale(
      { ...(dto as object), idempotencyKey: "k-1" } as never,
      operatorPayload as never,
      { fulfillPath: "PICKUP" as never },
    );
    expect(create.mock.calls[0][0]).toMatchObject({ idempotencyKey: "k-1", status: "PENDING" });
    expect(create.mock.calls[0][2]).toMatchObject({ skipAutoMerge: true, fulfillPath: "PICKUP" });
    expect(typeof create.mock.calls[0][2]!.onReplay).toBe("function");
  });

  it("suppressInvoiceNotify sends the invoice with { suppressNotify: true } (walk-in: no INVOICE_SENT email)", async () => {
    const { h, invoices } = await setup();
    await h.service.createSale(dto, operatorPayload as never, { suppressInvoiceNotify: true });
    expect(invoices.send).toHaveBeenCalledWith("inv-1", { suppressNotify: true });
  });

  it("marks DELIVERED with status + deliveredAt ONLY (no deliveredQty stamp: B1050 — corrections go via return/credit)", async () => {
    const { h } = await setup();
    await h.service.createSale(dto, operatorPayload as never, { fulfillPath: "PICKUP" as never });
    const data = h.prisma.order.update.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(["deliveredAt", "status"]);
  });

  it("never touches stock itself: create()'s own decrement is the only one", async () => {
    const { h } = await setup();
    const decrement = jest.spyOn(h.service as any, "decrementStockForSale");
    await h.service.createSale(dto, operatorPayload as never, { fulfillPath: "PICKUP" as never });
    expect(decrement).not.toHaveBeenCalled();
  });

  describe("replay RESUMES (same Idempotency-Key)", () => {
    const keyed = { ...(dto as object), idempotencyKey: "k-1" } as never;

    it("fires sale.onReplay on a replay and never on a fresh sale", async () => {
      const { h, setReplayed } = await setup();
      const onReplay = jest.fn();
      await h.service.createSale(keyed, operatorPayload as never, { onReplay });
      expect(onReplay).not.toHaveBeenCalled();
      setReplayed(true);
      await h.service.createSale(keyed, operatorPayload as never, { onReplay });
      expect(onReplay).toHaveBeenCalledTimes(1);
    });

    it("order still PENDING (the first attempt died after create): marks DELIVERED, invoices and sends once", async () => {
      const { h, invoices, setReplayed } = await setup("PENDING");
      setReplayed(true);
      await h.service.createSale(keyed, operatorPayload as never);
      expect(h.prisma.order.update).toHaveBeenCalledTimes(1);
      expect(invoices.createInvoiceFromOrder).toHaveBeenCalledTimes(1);
      expect(invoices.send).toHaveBeenCalledTimes(1);
    });

    it("order DELIVERED, invoice still DRAFT: no second DELIVERED write, the invoice is sent", async () => {
      const { h, invoices, setReplayed } = await setup("DELIVERED");
      invoices.createInvoiceFromOrder.mockResolvedValue([
        { id: "inv-1", status: "DRAFT", createdAt: new Date(1) },
      ]);
      setReplayed(true);
      await h.service.createSale(keyed, operatorPayload as never);
      expect(h.prisma.order.update).not.toHaveBeenCalled();
      expect(invoices.send).toHaveBeenCalledWith("inv-1");
    });

    it("order DELIVERED, invoice already SENT: nothing is written or re-sent; the invoice comes back", async () => {
      const { h, invoices, setReplayed } = await setup("DELIVERED");
      invoices.createInvoiceFromOrder.mockResolvedValue([
        { id: "inv-1", status: "SENT", createdAt: new Date(1) },
      ]);
      setReplayed(true);
      const out = await h.service.createSale(keyed, operatorPayload as never);
      expect(h.prisma.order.update).not.toHaveBeenCalled();
      expect(invoices.send).not.toHaveBeenCalled();
      expect(out).toMatchObject({ id: "inv-1" });
    });

    it("sibling invoices of a mixed order: only DRAFTs are sent and the OLDEST is the primary", async () => {
      const { h, invoices, setReplayed } = await setup("DELIVERED");
      invoices.createInvoiceFromOrder.mockResolvedValue([
        { id: "inv-r1", status: "DRAFT", createdAt: new Date(2) }, // the real helper lists newest first
        { id: "inv-base", status: "SENT", createdAt: new Date(1) },
      ]);
      setReplayed(true);
      const out = await h.service.createSale(keyed, operatorPayload as never);
      expect(invoices.send).toHaveBeenCalledTimes(1);
      expect(invoices.send).toHaveBeenCalledWith("inv-r1");
      expect(out).toMatchObject({ id: "inv-base" });
    });

    it("a replayed order that was since CANCELLED is a 409, not a resumed sale", async () => {
      const { h, invoices, setReplayed } = await setup("CANCELLED");
      setReplayed(true);
      await expect(h.service.createSale(keyed, operatorPayload as never)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(h.prisma.order.update).not.toHaveBeenCalled();
      expect(invoices.createInvoiceFromOrder).not.toHaveBeenCalled();
    });

    it("a failed invoice step leaves DELIVERED + no invoice; the retry with the same key finishes it, one DELIVERED write, one send", async () => {
      const { h, invoices, setReplayed } = await setup("PENDING");
      invoices.createInvoiceFromOrder.mockRejectedValueOnce(new Error("invoice step failed"));
      await expect(h.service.createSale(keyed, operatorPayload as never)).rejects.toThrow(
        "invoice step failed",
      );
      expect(h.prisma.order.update).toHaveBeenCalledTimes(1);
      expect(invoices.send).not.toHaveBeenCalled();

      setReplayed(true, "DELIVERED"); // the first attempt's DELIVERED write is visible to the retry
      invoices.createInvoiceFromOrder.mockResolvedValue([
        { id: "inv-1", status: "DRAFT", createdAt: new Date(1) },
      ]);
      await expect(h.service.createSale(keyed, operatorPayload as never)).resolves.toMatchObject({
        id: "inv-1",
      });
      expect(h.prisma.order.update).toHaveBeenCalledTimes(1); // still the one from attempt 1
      expect(invoices.send).toHaveBeenCalledTimes(1);
    });
  });
});
