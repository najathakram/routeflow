import { ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { OrdersService } from "./orders.service";
import * as cancelledLines from "./order-edit-cancelled";
import * as unitAware from "./unit-aware-guard";

/**
 * #2565: a buyer's ownership is settled FIRST in updateOrderItems, unconditionally — before any
 * status/shape answer and before any side effect. The later buyer checks were each conditional
 * (e.g. the unit guard returns early for a strike-off-only diff), so a non-owner's diff reached
 * `revertLinkedInvoicesForOrderEdit` — which commits on its own connection — and only then met
 * the in-transaction 403.
 */
describe("updateOrderItems — a non-owner buyer meets the 403 before anything else (#2565)", () => {
  afterEach(() => jest.restoreAllMocks());

  const build = (order: Record<string, unknown>, owner: { id: string } | null) => {
    const db = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      customer: { findFirst: jest.fn().mockResolvedValue(owner) },
    };
    const revert = jest.fn();
    const svc: any = Object.assign(Object.create(OrdersService.prototype), {
      prisma: { forTenant: () => db },
      invoicesService: { revertLinkedInvoicesForOrderEdit: revert },
    });
    return { svc, revert };
  };
  const buyer = { role: UserRole.CUSTOMER, sub: "u-other" } as any;
  const strikeOff = { replaceAll: false, items: [{ id: "li-1", action: "CANCEL" }] };

  it.each([
    ["another customer's buyer", { id: "cust-other" }],
    ["a removed customer (no owner row)", null],
  ])("%s: bare 403, no revert, no cancelled-line plan, no unit guard", async (_n, owner) => {
    const { svc, revert } = build(
      { id: "ord-1", customerId: "cust-1", status: "PENDING", lineItems: [] },
      owner,
    );
    const plan = jest.spyOn(cancelledLines, "planCancelledLines");
    const guard = jest.spyOn(unitAware, "assertOrderEditAllowed");
    const err = await svc.updateOrderItems("ord-1", strikeOff, buyer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).message).toBe("Forbidden");
    expect(revert).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
  });

  it("a non-owner never learns the order is CANCELLED (403, not the cancelled-order 400)", async () => {
    const { svc } = build(
      { id: "ord-1", customerId: "cust-1", status: "CANCELLED", lineItems: [] },
      { id: "cust-other" },
    );
    await expect(svc.updateOrderItems("ord-1", strikeOff, buyer)).rejects.toThrow(
      ForbiddenException,
    );
  });
});
