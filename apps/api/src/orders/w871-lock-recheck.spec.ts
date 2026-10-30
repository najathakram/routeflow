/**
 * review-c MUST 2 (SA-944 §3): the paid walk-in refusal is decided before the edit tx opens, but a payment can commit
 * between that read and the Order lock. `lockEditedOrder` takes the lock and checks the same predicate AGAIN under it
 * (the one place that sees every committed payment), then hands back the order's prior total for the overpay judge.
 */
import { lockEditedOrder } from "./replace-after-delivery";

const fakeTx = (opts: { isWalkIn: boolean; paid: boolean; total?: number }) => {
  const calls: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async () => {
      calls.push("lock");
      return 1;
    }),
    order: {
      findUnique: jest.fn(async () => {
        calls.push("read");
        return { total: opts.total ?? 12.34, customer: { isWalkIn: opts.isWalkIn } };
      }),
    },
    invoicePayment: {
      findFirst: jest.fn(async () => {
        calls.push("payment");
        return opts.paid ? { id: "pay1" } : null;
      }),
    },
  };
  return { tx, calls };
};

describe("lockEditedOrder: the walk-in paid-sale recheck under the Order lock", () => {
  it("a walk-in sale that became paid after the pre-check is refused WALK_IN_SALE_PAID, after the lock", async () => {
    const { tx, calls } = fakeTx({ isWalkIn: true, paid: true });
    await expect(lockEditedOrder(tx, "o1")).rejects.toMatchObject({
      response: { code: "WALK_IN_SALE_PAID" },
      status: 409,
    });
    expect(calls[0]).toBe("lock"); // the payment is read only once the row is locked
    expect(calls).toContain("payment");
  });

  it("an unpaid walk-in sale passes and returns the prior total (rounded to cents)", async () => {
    const { tx } = fakeTx({ isWalkIn: true, paid: false, total: 12.344 });
    await expect(lockEditedOrder(tx, "o1")).resolves.toBe(12.34);
  });

  it("a named customer's paid sale is not refused here (R1 keeps it), and no payment is read", async () => {
    const { tx, calls } = fakeTx({ isWalkIn: false, paid: true });
    await expect(lockEditedOrder(tx, "o1")).resolves.toBe(12.34);
    expect(calls).not.toContain("payment");
  });

  it("an unreadable row gives NaN (the overpay fallback then fails closed), never a throw", async () => {
    const { tx } = fakeTx({ isWalkIn: false, paid: false });
    tx.order.findUnique = jest.fn(async () => null) as never;
    await expect(lockEditedOrder(tx, "o1")).resolves.toBeNaN();
  });
});
