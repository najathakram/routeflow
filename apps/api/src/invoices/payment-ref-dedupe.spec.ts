import { normalizePaymentRef } from "./payment-ref-dedupe";

/** Row 498 (SA-837): the ONE normaliser of the payment-reference dedupe. */
describe("normalizePaymentRef", () => {
  it.each([
    ["abc-123", "ABC123"],
    [" ABC 123 ", "ABC123"],
    ["Abc123", "ABC123"],
    ["a b-c\t1\n2-3", "ABC123"],
    ["chk 77-88", "CHK7788"],
  ])("%j -> %j", (input, out) => {
    expect(normalizePaymentRef(input)).toBe(out);
  });

  it.each([[undefined], [null], [""], ["   "], ["--- -"]])("%j is no reference (null)", (input) => {
    expect(normalizePaymentRef(input as string | null | undefined)).toBeNull();
  });

  it("keeps other punctuation: only spaces and dashes are stripped", () => {
    expect(normalizePaymentRef("pi_3Abc/9")).toBe("PI_3ABC/9");
  });
});
