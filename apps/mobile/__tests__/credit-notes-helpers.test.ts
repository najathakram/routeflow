/**
 * P10-PAR-2 pure-logic guards for the mobile credit-notes parity screen. Locks
 * the status→pill mapping and the action gating (Apply=ISSUED, Void=ISSUED —
 * matching the server contract so no action shown will be rejected by the
 * API). No Issue action or DRAFT status — B18 removed the no-op issue()
 * endpoint; create always writes ISSUED.
 */
import {
  creditNoteActionFlags,
  creditNotePillFor,
  isCreditOpenForApply,
  openCreditBalance,
} from "../lib/credit-notes-logic";
import type { CreditNoteStatus } from "../lib/api/credit-notes";

describe("creditNotePillFor", () => {
  const cases: [CreditNoteStatus, string, string][] = [
    ["ISSUED", "brand", "Issued"],
    ["APPLIED", "green", "Applied"],
    ["VOID", "red", "Void"],
  ];
  it.each(cases)("%s → %s / %s", (status, variant, label) => {
    expect(creditNotePillFor(status)).toEqual({ variant, label });
  });
});

describe("creditNoteActionFlags", () => {
  it("ISSUED → apply + void", () => {
    expect(creditNoteActionFlags("ISSUED")).toEqual({
      canApply: true,
      canVoid: true,
    });
  });

  it.each(["APPLIED", "VOID"] as CreditNoteStatus[])("%s → no actions (terminal)", (status) => {
    expect(creditNoteActionFlags(status)).toEqual({
      canApply: false,
      canVoid: false,
    });
  });
});

describe("openCreditBalance", () => {
  it("amount − amountUsed, floored at 0, cents-rounded", () => {
    expect(openCreditBalance({ amount: 100, amountUsed: 40 })).toBe(60);
    expect(openCreditBalance({ amount: 100, amountUsed: 100 })).toBe(0);
    expect(openCreditBalance({ amount: 50, amountUsed: 60 })).toBe(0);
    expect(openCreditBalance({ amount: 10.1, amountUsed: 0.05 })).toBe(10.05);
  });

  it("partially-applied note: amount alone is never the open balance", () => {
    // Prisma decimals arrive as strings — the helper must coerce.
    expect(openCreditBalance({ amount: "75.00", amountUsed: "25.50" })).toBe(49.5);
  });

  it("missing amountUsed means untouched", () => {
    expect(openCreditBalance({ amount: 30 })).toBe(30);
    expect(openCreditBalance({ amount: 30, amountUsed: null })).toBe(30);
  });
});

describe("isCreditOpenForApply", () => {
  const now = new Date("2026-08-11T12:00:00Z");
  const open = { status: "ISSUED" as CreditNoteStatus, amount: 50, amountUsed: 0 };

  it("ISSUED, unexpired, with balance → applicable", () => {
    expect(isCreditOpenForApply(open, now)).toBe(true);
    expect(isCreditOpenForApply({ ...open, expiresAt: "2026-12-31T00:00:00Z" }, now)).toBe(true);
  });

  it("expired ISSUED note is filtered — the server never flips status on expiry", () => {
    expect(isCreditOpenForApply({ ...open, expiresAt: "2026-08-01T00:00:00Z" }, now)).toBe(false);
  });

  it("drained or non-ISSUED notes are out", () => {
    expect(isCreditOpenForApply({ ...open, amountUsed: 50 }, now)).toBe(false);
    for (const status of ["APPLIED", "VOID"] as CreditNoteStatus[]) {
      expect(isCreditOpenForApply({ ...open, status }, now)).toBe(false);
    }
  });
});
