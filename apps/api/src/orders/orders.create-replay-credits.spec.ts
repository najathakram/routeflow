import { ServiceUnavailableException } from "@nestjs/common";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import {
  buildOrdersService,
  customerPayload,
  operatorPayload,
} from "./testing/orders-service-harness";

/**
 * B1201: create() commits the order, THEN runs the credit sync in its own tx. When that tx exhausts
 * its retries the client got 503 LOCK_UNAVAILABLE "Nothing was saved" - false (the order WAS saved) -
 * and the key-holding resubmit replayed the order WITHOUT re-running the sync, so the staff's
 * `appliedCreditNotes` were never applied. The replay now re-runs the (idempotent) sync, and the
 * create tail says the order was saved.
 */
describe("OrdersService.create - credit sync survives a create-tail failure (B1201)", () => {
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

  async function build() {
    const h = await buildOrdersService();
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      deletedAt: null,
      user: { status: "ACTIVE" },
    });
    h.prisma.product.findMany.mockResolvedValue([{ id: "p1", name: "P1", unit: "each" }]);
    jest.spyOn(h.service, "findReplayCandidateByKey").mockResolvedValue(stored as never);
    const credits = h.module.get(CreditNotesService) as unknown as {
      syncOrderCreditSelections: jest.Mock;
      settleOrderCreditsInTx: jest.Mock;
    };
    return { ...h, credits };
  }

  it("a staff replay re-runs the credit sync + settle against the existing order", async () => {
    const h = await build();
    const out = await h.service.create(dto(), operatorPayload as never);
    expect(out).toMatchObject({ id: "ord-1" });
    expect(h.credits.syncOrderCreditSelections).toHaveBeenCalledTimes(1);
    expect(h.credits.syncOrderCreditSelections).toHaveBeenCalledWith(
      expect.anything(),
      "ord-1",
      "cust-1",
      notes,
    );
    expect(h.credits.settleOrderCreditsInTx).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: replaying twice hands the SAME selection to the sync both times (no extra intents)", async () => {
    const h = await build();
    await h.service.create(dto(), operatorPayload as never);
    await h.service.create(dto(), operatorPayload as never);
    const calls = h.credits.syncOrderCreditSelections.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1].slice(1)).toEqual(calls[0].slice(1));
  });

  it("a replay with no credit selection (undefined) does not touch credits", async () => {
    const h = await build();
    await h.service.create(dto({ appliedCreditNotes: undefined }), operatorPayload as never);
    expect(h.credits.syncOrderCreditSelections).not.toHaveBeenCalled();
    expect(h.credits.settleOrderCreditsInTx).not.toHaveBeenCalled();
  });

  it("a non-staff replay never applies the body's credit selection", async () => {
    const h = await build();
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    await h.service.create(dto(), customerPayload as never);
    expect(h.credits.syncOrderCreditSelections).not.toHaveBeenCalled();
  });

  it("a replay whose credit tx exhausts again is a coded 503 carrying the order id, not a silent success", async () => {
    const h = await build();
    h.credits.syncOrderCreditSelections.mockRejectedValue(conflict());
    const e = await h.service.create(dto(), operatorPayload as never).then(
      () => null,
      (err) => err,
    );
    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect(e.getResponse()).toMatchObject({
      code: "ORDER_SAVED_CREDITS_PENDING",
      orderId: "ord-1",
    });
  }, 15000);

  it("the create tail: an exhausted credit tx says the order WAS saved (never 'Nothing was saved')", async () => {
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
});
