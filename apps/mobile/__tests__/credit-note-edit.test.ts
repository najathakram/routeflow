/**
 * #2648 / SA-535(c): the mobile Edit credit note flow, mirroring web's EditCreditNoteModal.
 * Pure-logic pins for the save plan (reason/expiry ⇒ in-place PATCH; amount/lines ⇒ reissue,
 * never in place) and the money path's confirm copy, plus source-wiring pins for the screen.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  type CreditNoteEditDraft,
  creditNoteDraftAmount,
  planCreditNoteEdit,
  reissueConfirmMessage,
} from "../lib/credit-notes-logic";

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const note = {
  amount: "30.00",
  reason: "Damaged case",
  expiresAt: null as string | null,
  items: [],
};
const draft = (over: Partial<CreditNoteEditDraft> = {}): CreditNoteEditDraft => ({
  amount: 30,
  lineAmounts: {},
  reason: "Damaged case",
  expiry: "",
  ...over,
});

describe("planCreditNoteEdit", () => {
  it("nothing changed ⇒ none (no request at all)", () => {
    expect(planCreditNoteEdit(note, draft())).toEqual({ kind: "none" });
    expect(planCreditNoteEdit(note, draft({ reason: "  Damaged case " }))).toEqual({
      kind: "none",
    });
  });

  it("reason or expiry only ⇒ an in-place PATCH with just the changed fields", () => {
    expect(planCreditNoteEdit(note, draft({ reason: "Wrong item" }))).toEqual({
      kind: "patch",
      patch: { reason: "Wrong item" },
    });
    expect(planCreditNoteEdit(note, draft({ expiry: FUTURE }))).toEqual({
      kind: "patch",
      patch: { expiresAt: new Date(FUTURE).toISOString() },
    });
    expect(
      planCreditNoteEdit({ ...note, expiresAt: `${FUTURE}T00:00:00.000Z` }, draft({ expiry: "" })),
    ).toEqual({ kind: "patch", patch: { expiresAt: null } });
  });

  it("an amount change ⇒ a reissue, never a PATCH; unchanged reason/expiry are not sent", () => {
    expect(planCreditNoteEdit(note, draft({ amount: 20 }))).toEqual({
      kind: "reissue",
      input: { amount: 20 },
    });
    expect(planCreditNoteEdit(note, draft({ amount: 20, reason: "Price fix" }))).toEqual({
      kind: "reissue",
      input: { amount: 20, reason: "Price fix" },
    });
  });

  it("a line-linked note sends every line; the amount is their sum", () => {
    const linked = {
      ...note,
      items: [
        { invoiceItemId: "ii-1", amount: "20.00" },
        { invoiceItemId: "ii-2", amount: "10.00" },
      ],
    };
    const d = draft({ lineAmounts: { "ii-1": 12.5, "ii-2": 10 } });
    expect(creditNoteDraftAmount(linked, d)).toBe(22.5);
    expect(planCreditNoteEdit(linked, d)).toEqual({
      kind: "reissue",
      input: {
        amount: 22.5,
        items: [
          { invoiceItemId: "ii-1", amount: 12.5 },
          { invoiceItemId: "ii-2", amount: 10 },
        ],
      },
    });
    // Same lines, same money ⇒ nothing to reissue.
    expect(planCreditNoteEdit(linked, draft({ lineAmounts: { "ii-1": 20, "ii-2": 10 } }))).toEqual({
      kind: "none",
    });
  });

  it("refuses a zero amount, a past expiry and a malformed date before any request", () => {
    expect(planCreditNoteEdit(note, draft({ amount: 0 })).kind).toBe("invalid");
    expect(planCreditNoteEdit(note, draft({ expiry: "2020-01-01" })).kind).toBe("invalid");
    expect(planCreditNoteEdit(note, draft({ expiry: "01/02/2031" })).kind).toBe("invalid");
  });
});

describe("reissueConfirmMessage", () => {
  it("names the voided note, the new amount and every un-application", () => {
    expect(
      reissueConfirmMessage("CN-2026-0007", 20, [
        { invoiceNumber: "INV-9", amount: 30 },
        { invoiceNumber: "INV-4", amount: "5.5" },
      ]),
    ).toBe(
      "This voids CN-2026-0007 and issues a new credit note for $20.00 and un-applies $30.00 from INV-9, $5.50 from INV-4. The new credit note starts unapplied.",
    );
    expect(reissueConfirmMessage("CN-1", 5, [])).toBe(
      "This voids CN-1 and issues a new credit note for $5.00. The new credit note starts unapplied.",
    );
  });
});

describe("Edit credit note wiring (#2648)", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const detail = read("app/(operator)/credit-notes/[id].tsx");
  const edit = read("app/(operator)/credit-notes/[id]/edit.tsx");
  const api = read("lib/api/credit-notes.ts");

  it("the detail screen offers Edit on any non-VOID note", () => {
    expect(detail).toMatch(
      /cn\.status !== "VOID" \? \(\s*<ActionTile\s+icon="create-outline"\s+label="Edit"/,
    );
    expect(detail).toContain("/(operator)/credit-notes/${cn.id}/edit");
  });

  it("the edit screen PATCHes a plain save and reissues money behind a confirm, with a key", () => {
    expect(edit).toContain("planCreditNoteEdit(cn, draft)");
    expect(edit).toMatch(/update\.mutate\(\s*\{ id: cn\.id, \.\.\.plan\.patch \}/);
    expect(edit).toMatch(/confirm\(\s*"Change the credit amount\?",\s*reissueConfirmMessage\(/);
    expect(edit).toMatch(
      /reissue\.mutate\(\s*\{ id: cn\.id, idempotencyKey: key, \.\.\.plan\.input \}/,
    );
    expect(edit).toContain('useVoidPreview(id ?? "", plan?.kind === "reissue")');
  });

  it("the reissue sends the Idempotency-Key header to POST :id/reissue", () => {
    expect(api).toMatch(
      /\.post\(`\/credit-notes\/\$\{id\}\/reissue`, dto, \{\s*headers: \{ "Idempotency-Key": idempotencyKey \}/,
    );
  });
});
