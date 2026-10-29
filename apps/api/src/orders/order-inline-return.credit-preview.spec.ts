import { ConflictException } from "@nestjs/common";
import { assertIssuedCreditCoversPreview } from "./order-inline-return";

/**
 * W-863 (SA-945 MUST 6, G5): the gate netted a PRE-transaction preview; inside the transaction the credit really issued
 * must still cover it, or the sale is refused (the caller's transaction rolls back).
 */
const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ConflictException
      ? (e.getResponse() as { code?: string; previewed?: number; issued?: number })
      : e;
  }
  return null;
};

describe("assertIssuedCreditCoversPreview", () => {
  it("refuses 409 RETURN_CREDIT_CHANGED when less was issued than the gate netted", () => {
    expect(codeOf(() => assertIssuedCreditCoversPreview({ amount: "4.00" }, 9, 10))).toMatchObject({
      code: "RETURN_CREDIT_CHANGED",
      previewed: 9,
      issued: 4,
    });
  });

  it("a replay or a hold (nothing minted) is refused when a credit was netted", () => {
    expect(codeOf(() => assertIssuedCreditCoversPreview(null, 4, 10))).toMatchObject({
      code: "RETURN_CREDIT_CHANGED",
    });
  });

  it("passes when the issued credit covers it, within half a cent", () => {
    expect(codeOf(() => assertIssuedCreditCoversPreview({ amount: 4 }, 4, 10))).toBeNull();
    expect(codeOf(() => assertIssuedCreditCoversPreview({ amount: 5 }, 4, 10))).toBeNull();
    expect(codeOf(() => assertIssuedCreditCoversPreview({ amount: 3.996 }, 4, 10))).toBeNull();
    expect(codeOf(() => assertIssuedCreditCoversPreview({ amount: 3.99 }, 4, 10))).not.toBeNull();
  });

  it("both sides are capped at the sale total: a $12 preview and $11 issued on a $10 sale is fine", () => {
    expect(codeOf(() => assertIssuedCreditCoversPreview({ amount: 11 }, 12, 10))).toBeNull();
    expect(codeOf(() => assertIssuedCreditCoversPreview({ amount: 9 }, 12, 10))).not.toBeNull();
  });

  it("nothing netted (no preview) holds the sale to nothing", () => {
    expect(codeOf(() => assertIssuedCreditCoversPreview(null, 0, 10))).toBeNull();
  });
});
