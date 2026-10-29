import { editDedupeKey, editLockKey } from "./payment-edit-ref";

/**
 * Row 752 / SA-843 ruling 2: an edit runs the ONE reference predicate only when it gives the payment a NEW dedupe
 * identity: the row ENTERS the dedupe set (stored VOID -> DRAFT/PAID), or, while in the set, its method, normalised
 * effective reference or cents change. Effective reference = the dto's when the key is present, else the stored one.
 */
const stored = (over: Record<string, unknown> = {}) =>
  ({
    method: "CHECK",
    reference: "CHK 100",
    amount: 50,
    status: "PAID",
    ...over,
  }) as never;
const dto = (over: Record<string, unknown> = {}) =>
  ({ amount: 50, method: "CHECK", reference: "CHK 100", ...over }) as never;

describe("editDedupeKey: the entry condition (SA-843 ruling 2)", () => {
  it("R1 a new reference and amount while in the set: the NEW key, with the dto's raw reference", () => {
    expect(
      editDedupeKey(stored({ reference: "X1" }), dto({ reference: "CHK-100", amount: 100 })),
    ).toEqual({ method: "CHECK", reference: "CHK-100", amount: 100 });
  });
  it("R2 a VOID row entering the set (status PAID) runs it even with the key unchanged", () => {
    expect(editDedupeKey(stored({ status: "VOID" }), dto({ status: "PAID" }))).toEqual({
      method: "CHECK",
      reference: "CHK 100",
      amount: 50,
    });
    expect(editDedupeKey(stored({ status: "VOID" }), dto({ status: "DRAFT" }))).not.toBeNull();
  });
  it("R3 the same method, reference and amount (a notes-only save) never runs it", () => {
    expect(editDedupeKey(stored(), dto({ notes: "new" }))).toBeNull();
    // the normaliser decides "the same": spaces, dashes and case never make a new identity
    expect(editDedupeKey(stored(), dto({ reference: "chk-100" }))).toBeNull();
    // 50 and 50.001 are the same cents
    expect(editDedupeKey(stored(), dto({ amount: 50.001 }))).toBeNull();
  });
  it("DRAFT <-> PAID with the same key never runs it (both are in the set)", () => {
    expect(editDedupeKey(stored({ status: "DRAFT" }), dto({ status: "PAID" }))).toBeNull();
    expect(editDedupeKey(stored({ status: "PAID" }), dto({ status: "DRAFT" }))).toBeNull();
    expect(editDedupeKey(stored({ status: "PENDING" }), dto({ status: "PAID" }))).toBeNull();
  });
  it("an edit to VOID never runs it, whatever else changes", () => {
    expect(editDedupeKey(stored(), dto({ status: "VOID", reference: "NEW" }))).toBeNull();
    expect(editDedupeKey(stored({ status: "VOID" }), dto({ reference: "NEW" }))).toBeNull();
  });
  it("R6 no reference key in the dto: the STORED reference is the effective one", () => {
    expect(editDedupeKey(stored(), dto({ reference: undefined, amount: 100 }))).toEqual({
      method: "CHECK",
      reference: "CHK 100",
      amount: 100,
    });
  });
  it("a method change alone is a new identity", () => {
    expect(editDedupeKey(stored(), dto({ method: "BANK_TRANSFER" }))).toEqual({
      method: "BANK_TRANSFER",
      reference: "CHK 100",
      amount: 50,
    });
  });
  it("no effective reference (none stored, none sent, or only spaces/dashes): nothing is deduped", () => {
    expect(
      editDedupeKey(stored({ reference: null }), dto({ reference: undefined, amount: 9 })),
    ).toBeNull();
    expect(editDedupeKey(stored(), dto({ reference: " - ", amount: 9 }))).toBeNull();
  });
  it("a stored amount from Prisma (a Decimal-like string) compares by cents", () => {
    expect(editDedupeKey(stored({ amount: "50.00" }), dto())).toBeNull();
    expect(editDedupeKey(stored({ amount: "49.99" }), dto())).not.toBeNull();
  });
});

describe("editLockKey: what the payment-ref lock is held on", () => {
  it("method + normalised reference, or null when the edit needs no lock", () => {
    expect(editLockKey({ method: "CHECK", reference: "chk-100", amount: 1 } as never)).toBe(
      "CHECK:CHK100",
    );
    expect(editLockKey(null)).toBeNull();
  });
  it("an amount-only difference is the same lock key (the lock covers the key, the guard reads the amount)", () => {
    expect(editLockKey({ method: "CHECK", reference: "A", amount: 1 } as never)).toBe(
      editLockKey({ method: "CHECK", reference: "a", amount: 2 } as never),
    );
  });
});
