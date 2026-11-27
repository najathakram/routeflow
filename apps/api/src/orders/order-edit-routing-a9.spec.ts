/**
 * SA-1544 (ap) (ar) (ao), unit level:
 *  - `routingUnderLock`: the routing input read before the transaction must still hold on the LOCKED held lines, for every
 *    role (the function takes no role): a difference is 409 ORDER_CHANGED_DURING_EDIT.
 *  - `routedByHeldLines`: the named export beside the rule (never a second call of `resyncsInPlace` with `false`).
 *  - `syncInvoicesAfterEdit`: a restated edit (`restatedInTx`) runs neither the post-commit resync, nor the draft
 *    reconcile, nor `followPartialPrices`; an edit that was not restated keeps the B215 tail exactly.
 */
import { routedByHeldLines, routingUnderLock } from "./order-carrier-guard";
import { syncInvoicesAfterEdit } from "./order-edit-invoice-sync";

const DELIVERED = [{ status: "PENDING", deliveredQty: 4 }];
const NONE = [{ status: "PENDING", deliveredQty: 0 }];
const GUARD = { withCarrier: false, billsShip: false };

describe("SA-1544 (ap) routingUnderLock", () => {
  it("passes when the locked lines hold what the pre-read held", () => {
    expect(() => routingUnderLock(true, DELIVERED)).not.toThrow();
    expect(() => routingUnderLock(false, NONE)).not.toThrow();
    expect(() => routingUnderLock(false, [])).not.toThrow();
  });

  it("a delivered line that disappeared under the lock is 409 ORDER_CHANGED_DURING_EDIT", () => {
    expect(() => routingUnderLock(true, NONE)).toThrow(
      expect.objectContaining({
        status: 409,
        response: expect.objectContaining({ code: "ORDER_CHANGED_DURING_EDIT" }),
      }),
    );
  });

  it("a delivered line that appeared under the lock is the same 409 (a driver delivered it meanwhile)", () => {
    expect(() => routingUnderLock(false, DELIVERED)).toThrow(
      expect.objectContaining({
        status: 409,
        response: expect.objectContaining({ code: "ORDER_CHANGED_DURING_EDIT" }),
      }),
    );
  });

  it("a cancelled delivered line does not count (the same predicate as the routing rule)", () => {
    expect(() => routingUnderLock(false, [{ status: "CANCELLED", deliveredQty: 4 }])).not.toThrow();
  });
});

describe("SA-1544 (ao) routedByHeldLines", () => {
  it("is true only when the held lines alone route the edit in place", () => {
    expect(routedByHeldLines("CONFIRMED", GUARD, DELIVERED)).toBe(true);
    expect(routedByHeldLines("CONFIRMED", GUARD, NONE)).toBe(false);
    expect(routedByHeldLines("DELIVERED", GUARD, DELIVERED)).toBe(false); // the status already routed it
    expect(routedByHeldLines("CONFIRMED", { withCarrier: true, billsShip: true }, DELIVERED)).toBe(
      false,
    );
  });
});

describe("SA-1544 (ar) syncInvoicesAfterEdit tail", () => {
  const invoices = () =>
    ({
      resyncOrderInvoicesForEdit: jest.fn().mockResolvedValue([{ id: "i" }]),
      reconcileOrderDraftInvoice: jest.fn().mockResolvedValue(null),
      followPartialPrices: jest.fn().mockResolvedValue({ issuedPartialsUnchanged: [] }),
    }) as any;

  it("a restated staff edit calls resync 0 times, reconcile 0 times and followPartialPrices 0 times", async () => {
    const inv = invoices();
    await syncInvoicesAfterEdit(
      inv,
      "o1",
      { postDeliveryEdit: true, skipInPlaceResync: false, restatedInTx: true },
      "u1",
      true,
    );
    expect(inv.resyncOrderInvoicesForEdit).not.toHaveBeenCalled(); // wrong value: 1
    expect(inv.reconcileOrderDraftInvoice).not.toHaveBeenCalled();
    expect(inv.followPartialPrices).not.toHaveBeenCalled(); // wrong value: 1 (the head's skipInPlaceResync reads as not rebuilt)
  });

  it("an edit that was not restated in the tx keeps the B215 tail: the in-place resync runs", async () => {
    const inv = invoices();
    await syncInvoicesAfterEdit(
      inv,
      "o1",
      { postDeliveryEdit: true, skipInPlaceResync: false },
      "u1",
      true,
    );
    expect(inv.resyncOrderInvoicesForEdit).toHaveBeenCalledTimes(1);
    expect(inv.followPartialPrices).not.toHaveBeenCalled();
  });

  it("a partially invoiced edit (skipInPlaceResync, not restated) still follows partial prices", async () => {
    const inv = invoices();
    await syncInvoicesAfterEdit(
      inv,
      "o1",
      { postDeliveryEdit: true, skipInPlaceResync: true },
      "u1",
      true,
    );
    expect(inv.resyncOrderInvoicesForEdit).not.toHaveBeenCalled();
    expect(inv.followPartialPrices).toHaveBeenCalledTimes(1);
  });

  it("an undelivered edit reconciles the open draft, as before", async () => {
    const inv = invoices();
    await syncInvoicesAfterEdit(
      inv,
      "o1",
      { postDeliveryEdit: false, skipInPlaceResync: false },
      "u1",
      true,
    );
    expect(inv.reconcileOrderDraftInvoice).toHaveBeenCalledTimes(1);
  });
});
