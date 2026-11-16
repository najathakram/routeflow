import { isSettleAdjustedPayment, SETTLE_ADJUSTED_PAYMENT_WHERE } from "./settle-adjusted-payment";

/** SA-1156 S1: the where-fragment and its pure twin answer the same on every method x creditNoteId fixture. */
describe("settle-adjusted payment predicate", () => {
  const methods = [
    "CASH",
    "CHECK",
    "ACH",
    "OTHER",
    "CREDIT_NOTE",
    "ADVANCE",
    "CREDIT_CARD",
    "ZELLE",
  ];
  /** Evaluate the Prisma fragment against a plain object (the only operators it uses: equality and `{ not: null }`). */
  const matches = (p: { method: string; creditNoteId: string | null }) =>
    Object.entries(SETTLE_ADJUSTED_PAYMENT_WHERE).every(([k, v]) => {
      const got = (p as any)[k];
      return typeof v === "object" && v !== null ? got !== (v as any).not : got === v;
    });
  const fixtures = methods.flatMap((method) =>
    [null, "cn1"].map((creditNoteId) => ({ method, creditNoteId })),
  );

  it.each(fixtures)("fragment and twin agree on $method / $creditNoteId", (p) => {
    expect(matches(p)).toBe(isSettleAdjustedPayment(p));
  });

  it("only a credit-note payment that names its note is settle-adjusted", () => {
    expect(fixtures.filter(isSettleAdjustedPayment)).toEqual([
      { method: "CREDIT_NOTE", creditNoteId: "cn1" },
    ]);
  });
});
