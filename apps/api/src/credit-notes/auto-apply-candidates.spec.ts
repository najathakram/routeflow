import { autoApplyCandidateWhere, hasOpenCreditBalance } from "./auto-apply-candidates";

describe("autoApplyCandidateWhere", () => {
  const now = new Date("2026-10-04T00:00:00Z");

  it("selects every non-VOID, non-excluded, non-expired note of the customer", () => {
    expect(autoApplyCandidateWhere({ customerId: "c1", now })).toEqual({
      customerId: "c1",
      status: { not: "VOID" },
      autoApplyExcluded: false,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    });
  });

  it("adds the explicit-intent exclusion only when ids are given", () => {
    expect(
      autoApplyCandidateWhere({ customerId: "c1", now, excludeCreditNoteIds: [] }),
    ).not.toHaveProperty("id");
    expect(
      autoApplyCandidateWhere({ customerId: "c1", now, excludeCreditNoteIds: ["a"] }).id,
    ).toEqual({
      notIn: ["a"],
    });
  });
});

describe("hasOpenCreditBalance", () => {
  it("is true above a tenth of a cent and false at or below", () => {
    expect(hasOpenCreditBalance({ amount: 10, amountUsed: 4 })).toBe(true);
    expect(hasOpenCreditBalance({ amount: 10, amountUsed: 10 })).toBe(false);
    expect(hasOpenCreditBalance({ amount: "10.00", amountUsed: "9.9995" })).toBe(false);
  });
});
