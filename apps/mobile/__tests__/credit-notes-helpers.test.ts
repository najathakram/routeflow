/**
 * P10-PAR-2 pure-logic guards for the mobile credit-notes parity screen. Locks
 * the status→pill mapping and the action gating (Issue=DRAFT cosmetic,
 * Apply=ISSUED, Void=DRAFT|ISSUED — matching the server contract so no action
 * shown will be rejected by the API).
 */
import { creditNoteActionFlags, creditNotePillFor } from "../lib/credit-notes-logic";
import type { CreditNoteStatus } from "../lib/api/credit-notes";

describe("creditNotePillFor", () => {
  const cases: [CreditNoteStatus, string, string][] = [
    ["DRAFT", "gray", "Draft"],
    ["ISSUED", "brand", "Issued"],
    ["APPLIED", "green", "Applied"],
    ["VOID", "red", "Void"],
  ];
  it.each(cases)("%s → %s / %s", (status, variant, label) => {
    expect(creditNotePillFor(status)).toEqual({ variant, label });
  });
});

describe("creditNoteActionFlags", () => {
  it("DRAFT → issue (+void), never apply", () => {
    expect(creditNoteActionFlags("DRAFT")).toEqual({
      canIssue: true,
      canApply: false,
      canVoid: true,
    });
  });

  it("ISSUED → apply (+void), never issue", () => {
    expect(creditNoteActionFlags("ISSUED")).toEqual({
      canIssue: false,
      canApply: true,
      canVoid: true,
    });
  });

  it.each(["APPLIED", "VOID"] as CreditNoteStatus[])("%s → no actions (terminal)", (status) => {
    expect(creditNoteActionFlags(status)).toEqual({
      canIssue: false,
      canApply: false,
      canVoid: false,
    });
  });
});
