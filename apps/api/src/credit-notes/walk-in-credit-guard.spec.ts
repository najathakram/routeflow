import { assertCreditCustomerNotWalkIn } from "./walk-in-credit-guard";
import { API_ERROR_CODES } from "../common/api-error-codes";

describe("assertCreditCustomerNotWalkIn (W-913)", () => {
  const txWith = (row: unknown) => ({ customer: { findFirst: jest.fn().mockResolvedValue(row) } });

  it("refuses the walk-in customer with the coded 409", async () => {
    const tx = txWith({ isWalkIn: true });
    const err: any = await assertCreditCustomerNotWalkIn(tx, "c1").catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.WALK_IN_STORE_CREDIT_REFUSED,
      message: "Nothing changed. A walk-in return is refunded at the till.",
    });
    expect(tx.customer.findFirst).toHaveBeenCalledWith({
      where: { id: "c1" },
      select: { isWalkIn: true },
    });
  });

  it.each([[false], [null], [undefined]])("lets isWalkIn=%s through", async (flag) => {
    await expect(assertCreditCustomerNotWalkIn(txWith({ isWalkIn: flag }), "c1")).resolves.toBe(
      undefined,
    );
  });

  it("leaves an unknown customer to the caller's own 404", async () => {
    await expect(assertCreditCustomerNotWalkIn(txWith(null), "c1")).resolves.toBe(undefined);
  });
});
