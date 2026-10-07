import { ServiceUnavailableException } from "@nestjs/common";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";

/**
 * B1201 (path B): create() commits the order, THEN runs the credit sync in its own tx. When that tx
 * exhausts its retries the client used to get 503 LOCK_UNAVAILABLE "Nothing was saved" (false: the order
 * WAS saved). The tail now says so with a coded 503 carrying the order id, and a keyed REPLAY never
 * writes credits (no money write is decided by a heuristic); it only carries a read-only
 * `creditsPending` hint so the client can show the same "apply them on the order" message.
 */
describe("OrdersService.create - a create-tail credit failure (B1201)", () => {
  const notes = [{ creditNoteId: "cn-1", amount: 25 }];
  const dto = (over: Record<string, unknown> = {}) =>
    ({
      customerId: "cust-1",
      items: [{ productId: "p1", qty: 1 }],
      idempotencyKey: "k-1201",
      appliedCreditNotes: notes,
      ...over,
    }) as never;
  const stored = {
    id: "ord-1",
    customerId: "cust-1",
    status: "PENDING",
    lineItems: [{ productId: "p1", name: "P1", qty: 1, status: "PENDING" }],
  };
  const conflict = () => Object.assign(new Error("write conflict"), { code: "P2034" });

  async function build(heldIntents = 0) {
    const h = await buildOrdersService();
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      deletedAt: null,
      user: { status: "ACTIVE" },
    });
    h.prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "P1", unit: "each" }]);
    h.prisma.orderCreditNote.count.mockResolvedValue(heldIntents);
    jest.spyOn(h.service, "findReplayCandidateByKey").mockResolvedValue(stored as never);
    const credits = h.module.get(CreditNotesService) as unknown as {
      syncOrderCreditSelections: jest.Mock;
      settleOrderCreditsInTx: jest.Mock;
    };
    return { ...h, credits };
  }

  it("a keyed replay NEVER writes credits: no sync, no settle, no credit tx at all", async () => {
    const h = await build();
    const out = await h.service.create(dto(), operatorPayload as never);
    expect(out).toMatchObject({ id: "ord-1" });
    expect(h.credits.syncOrderCreditSelections).not.toHaveBeenCalled();
    expect(h.credits.settleOrderCreditsInTx).not.toHaveBeenCalled();
    expect(h.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(h.prisma.orderCreditNote.create).not.toHaveBeenCalled();
    expect(h.prisma.orderCreditNote.deleteMany).not.toHaveBeenCalled();
  });

  it("the replay response carries creditsPending=true when the chosen credits were never applied", async () => {
    const h = await build(0);
    const out: any = await h.service.create(dto(), operatorPayload as never);
    expect(out.creditsPending).toBe(true);
    expect(h.prisma.orderCreditNote.count).toHaveBeenCalledWith({
      where: { orderId: "ord-1", tenantId: "test-tenant" },
    });
  });

  it("creditsPending=false once the order holds a credit intent", async () => {
    const h = await build(1);
    const out: any = await h.service.create(dto(), operatorPayload as never);
    expect(out.creditsPending).toBe(false);
  });

  it("no credit selection in the request: no hint at all", async () => {
    const h = await build();
    const out: any = await h.service.create(
      dto({ appliedCreditNotes: undefined }),
      operatorPayload as never,
    );
    expect(out).not.toHaveProperty("creditsPending");
    expect(h.prisma.orderCreditNote.count).not.toHaveBeenCalled();
  });

  it("a non-staff replay never gets the hint (the body's credits are ignored for them)", async () => {
    const h = await build();
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    const out: any = await h.service.create(dto(), customerPayload as never);
    expect(out).not.toHaveProperty("creditsPending");
    expect(h.credits.syncOrderCreditSelections).not.toHaveBeenCalled();
  });

  it("the create tail: an exhausted credit tx is a coded 503 carrying orderId, never 'Nothing was saved'", async () => {
    const h = await build();
    h.credits.syncOrderCreditSelections.mockRejectedValue(conflict());
    const e = await (h.service as any).syncCreateCredits("ord-9", "cust-1", notes).then(
      () => null,
      (err: any) => err,
    );
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    const body = e.getResponse();
    expect(body).toMatchObject({ code: "ORDER_SAVED_CREDITS_PENDING", orderId: "ord-9" });
    expect(body.message).not.toMatch(/nothing was saved/i);
  }, 15000);

  it("the create tail: a non-conflict error propagates untouched", async () => {
    const h = await build();
    const boom = new Error("boom");
    h.credits.syncOrderCreditSelections.mockRejectedValue(boom);
    await expect((h.service as any).syncCreateCredits("ord-9", "cust-1", notes)).rejects.toBe(boom);
  });

  it("the create tail with no selection (undefined) does not touch credits", async () => {
    const h = await build();
    await (h.service as any).syncCreateCredits("ord-9", "cust-1", undefined);
    expect(h.credits.syncOrderCreditSelections).not.toHaveBeenCalled();
  });
});
