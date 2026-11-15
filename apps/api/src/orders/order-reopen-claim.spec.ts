import { ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { claimReopenInTx } from "./order-reopen-claim";

/**
 * B695: the reopen claim locks the Order row, then compare-and-sets CANCELLED -> target. SA-1134 R-1: the target is
 * PENDING, or DRAFT for an order holding an open gate flag, and is read again under that lock.
 */
describe("claimReopenInTx", () => {
  const mkTx = (count: number, openGateFlags = 0) => {
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
      order: {
        updateMany: jest.fn(async () => {
          calls.push("updateMany");
          return { count };
        }),
      },
    };
    return { tx, calls };
  };

  it("locks the Order row FOR UPDATE before it reads the flags and claims the status", async () => {
    const { tx, calls } = mkTx(1);
    await claimReopenInTx(tx, "o-1", OrderStatus.PENDING);
    expect(calls).toEqual([
      'raw:SELECT id FROM "Order" WHERE id = ? FOR UPDATE',
      "flags",
      "updateMany",
    ]);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o-1", status: "CANCELLED" },
      data: { status: "PENDING" },
    });
  });

  it("an order holding an open gate flag is claimed into DRAFT, never PENDING", async () => {
    const { tx } = mkTx(1, 1);
    await claimReopenInTx(tx, "o-1", OrderStatus.DRAFT);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: "o-1", status: "CANCELLED" },
      data: { status: "DRAFT" },
    });
  });

  it("a lost claim (count 0) is the coded 409 ORDER_CHANGED_DURING_EDIT, for either target", async () => {
    for (const target of [OrderStatus.PENDING, OrderStatus.DRAFT]) {
      const { tx } = mkTx(0, target === OrderStatus.DRAFT ? 1 : 0);
      const err = await claimReopenInTx(tx, "o-1", target).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT });
    }
  });

  it("a target that moved since the pre-lock read is the same 409 and claims nothing", async () => {
    // read PENDING before the restriction check, but a gate flag is open under the lock
    const flagged = mkTx(1, 1);
    const a = await claimReopenInTx(flagged.tx, "o-1", OrderStatus.PENDING).catch((e) => e);
    expect(a).toBeInstanceOf(ConflictException);
    expect(a.getResponse()).toMatchObject({ code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT });
    expect(flagged.tx.order.updateMany).not.toHaveBeenCalled();
    // read DRAFT (restriction check skipped), but no gate flag is open under the lock
    const clear = mkTx(1, 0);
    const b = await claimReopenInTx(clear.tx, "o-1", OrderStatus.DRAFT).catch((e) => e);
    expect(b).toBeInstanceOf(ConflictException);
    expect(clear.tx.order.updateMany).not.toHaveBeenCalled();
  });
});
