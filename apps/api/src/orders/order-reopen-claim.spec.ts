import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { claimReopenInTx } from "./order-reopen-claim";

/**
 * B695: the reopen claim locks the Order row, then compare-and-sets CANCELLED -> target. SA-1134 R-1: the target is
 * PENDING, or DRAFT for an order holding an open gate flag, and is read again under that lock. SA-1136 W-2: after the
 * CAS it writes the `order.reopened` audit row in the same transaction.
 */
describe("claimReopenInTx", () => {
  const user = { sub: "u-1", impersonatedBy: "sa-1" } as never;
  /** `newest` is the order's newest cancelled-or-reopened audit row; `openGateFlags` the open gate flags. */
  const mkTx = (
    count: number,
    openGateFlags = 0,
    newest: { action: string; meta: unknown } | null = null,
  ) => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        calls.push(`raw:${strings.join("?").replace(/\s+/g, " ").trim()}`);
        return 1;
      }),
      orderReviewFlag: {
        count: jest.fn(async () => {
          calls.push("flags");
          return openGateFlags;
        }),
      },
      auditLog: {
        findFirst: jest.fn(async () => {
          calls.push("audit-read");
          return newest;
        }),
        create: jest.fn(async () => {
          calls.push("audit-write");
        }),
      },
      order: {
        updateMany: jest.fn(async () => {
          calls.push("updateMany");
          return { count };
        }),
        findUnique: jest.fn(async () => ({ tenantId: "t-1" })),
      },
    };
    return { tx, calls };
  };
  const cancelledFromDraft = { action: "order.cancelled", meta: { fromStatus: "DRAFT" } };

  it("locks the Order row FOR UPDATE before it reads the target and claims the status", async () => {
    const { tx, calls } = mkTx(1);
    await claimReopenInTx(tx, "o-1", OrderStatus.PENDING, user);
    expect(calls[0]).toBe('raw:SELECT id FROM "Order" WHERE id = ? FOR UPDATE');
    expect(calls.indexOf("updateMany")).toBeGreaterThan(calls.indexOf("audit-read"));
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o-1", status: "CANCELLED" },
      data: { status: "PENDING" },
    });
  });

  it("an order holding an open gate flag is claimed into DRAFT, never PENDING", async () => {
    const { tx } = mkTx(1, 1);
    await claimReopenInTx(tx, "o-1", OrderStatus.DRAFT, user);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o-1", status: "CANCELLED" },
      data: { status: "DRAFT" },
    });
  });

  it("a cancel recorded from a DRAFT is claimed into DRAFT with no flag at all", async () => {
    const { tx } = mkTx(1, 0, cancelledFromDraft);
    await claimReopenInTx(tx, "o-1", OrderStatus.DRAFT, user);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o-1", status: "CANCELLED" },
      data: { status: "DRAFT" },
    });
  });

  it("writes one order.reopened row after the claim, with the target, the actor and the locked row's tenant", async () => {
    const { tx, calls } = mkTx(1, 0, cancelledFromDraft);
    await claimReopenInTx(tx, "o-1", OrderStatus.DRAFT, user);
    expect(calls.indexOf("audit-write")).toBeGreaterThan(calls.indexOf("updateMany"));
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: "t-1",
        userId: "u-1",
        impersonatedBy: "sa-1",
        action: "order.reopened",
        entityType: "Order",
        entityId: "o-1",
        meta: { toStatus: "DRAFT" },
      },
    });
  });

  it("a lost claim (count 0) is the coded 409 ORDER_CHANGED_DURING_EDIT and writes no row, for either target", async () => {
    for (const target of [OrderStatus.PENDING, OrderStatus.DRAFT]) {
      const { tx } = mkTx(0, target === OrderStatus.DRAFT ? 1 : 0);
      const err = await claimReopenInTx(tx, "o-1", target, user).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT });
      expect(tx.auditLog.create).not.toHaveBeenCalled();
    }
  });

  it("a target that moved since the pre-lock read is the same 409 and claims nothing", async () => {
    // read PENDING before the restriction check, but a gate flag is open under the lock
    const flagged = mkTx(1, 1);
    const a = await claimReopenInTx(flagged.tx, "o-1", OrderStatus.PENDING, user).catch((e) => e);
    expect(a).toBeInstanceOf(ConflictException);
    expect(a.getResponse()).toMatchObject({ code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT });
    expect(flagged.tx.order.updateMany).not.toHaveBeenCalled();
    // read DRAFT (restriction check skipped), but no gate flag and no draft cancel under the lock
    const clear = mkTx(1, 0);
    const b = await claimReopenInTx(clear.tx, "o-1", OrderStatus.DRAFT, user).catch((e) => e);
    expect(b).toBeInstanceOf(ConflictException);
    expect(clear.tx.order.updateMany).not.toHaveBeenCalled();
    expect(clear.tx.auditLog.create).not.toHaveBeenCalled();
  });
});
