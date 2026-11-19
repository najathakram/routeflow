// REG-B1337: promoting a plain staff DRAFT skipped the entry credit gate, so a draft over the customer's limit became a live PENDING
// order. SA-1345 Q2 (e94e7cc206): assertPromotionCredit runs the gate for EVERY draft with the projected total, and no longer
// reads review flags at all (the wrong value is "gate not called").
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { assertPromotionCredit } from "./review-flags";

const staff = { sub: "u1", role: "OPERATOR", tenantId: "t1" } as JwtPayload;

describe("REG-B1337: promotion runs the credit gate for every draft", () => {
  const draft = { id: "o1", customerId: "c1", total: "1234.565" };

  it("REG-B1337: a plain draft (no review flag of any kind) is judged by the gate with its projected total, excluding itself", async () => {
    const gate = jest.fn().mockResolvedValue(undefined);
    await assertPromotionCredit(draft, gate, staff);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledWith({
      customerId: "c1",
      projectedTotal: 1234.57,
      excludeOrderId: "o1",
      principal: staff,
    });
  });

  it("REG-B1337: a refusing gate refuses the promotion (the over-limit draft never becomes PENDING)", async () => {
    const refusal = new Error("CREDIT_LIMIT_EXCEEDED");
    const gate = jest.fn().mockRejectedValue(refusal);
    await expect(assertPromotionCredit(draft, gate, staff)).rejects.toBe(refusal);
  });
});
