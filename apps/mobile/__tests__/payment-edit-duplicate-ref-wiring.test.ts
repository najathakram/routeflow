import { readFileSync } from "fs";
import { join } from "path";
import type { UpdatePaymentDto } from "../lib/api/payments";
import { editPaymentDto } from "../lib/payments-logic";

// W-718 (row 752 follow-up): the payment EDIT screen answers a 409 DUPLICATE_PAYMENT_REF like the record-payment
// screens: the shared prompt through chooseAction, and for staff "Record anyway" resends the SAME edit with
// `recordAnyway: true`. RN screens aren't renderable in this lane, so the wiring is source-pinned (the prompt and the
// choice themselves are covered in duplicate-payment-ref.test.ts).
const EDIT = "app/(operator)/(tabs)/invoices/[id]/payments/[paymentId]/edit.tsx";

describe("payment edit: a duplicate reference offers Record anyway (W-718)", () => {
  const src = readFileSync(join(__dirname, "..", EDIT), "utf8");

  it("the error path reads the prompt BEFORE the generic toast and resends via submit(true)", () => {
    const at = src.indexOf("onError:", src.indexOf("mut.mutate("));
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("showToast(", at));
    expect(body).toMatch(/duplicateRefPrompt\(\w+, role\)/);
    expect(body).toMatch(/duplicateRefChoice\(\w+, \(\) => submit\(true\)\)/);
    expect(body).toMatch(/chooseAction\(/);
  });

  it("the screen sends editPaymentDto(fields, recordAnyway); a first save passes false", () => {
    expect(src).toMatch(/const submit = \(recordAnyway = false\) =>/);
    expect(src).toMatch(/mut\.mutate\(\s*editPaymentDto\([\s\S]*?,\s*recordAnyway,?\s*\)/);
    expect(src).toMatch(/onSubmit=\{\(\) => submit\(\)\}/);
  });
});

// #3657 review NIT: pin the SENT body, not only the source text.
describe("editPaymentDto: the body the edit screen sends (W-718)", () => {
  const fields = {
    invoiceId: "inv-1",
    paymentId: "pay-1",
    method: "CHECK" as const,
    amount: 40,
    reference: " 1042 ",
    notes: "",
    bankCharges: "",
    paidAt: "2026-10-05",
    settledAt: "",
  };
  const first: UpdatePaymentDto = editPaymentDto(fields, false);

  it("W-663: an emptied reference and notes are SENT as null, so the server clears them", () => {
    const body = editPaymentDto({ ...fields, reference: "  ", notes: "" }, false);
    expect(body.reference).toBeNull();
    expect(body.notes).toBeNull();
  });

  it("a first save: trimmed fields, an emptied bank date sent as null, and no flag", () => {
    expect(first).toEqual({
      invoiceId: "inv-1",
      paymentId: "pay-1",
      method: "CHECK",
      amount: 40,
      reference: "1042",
      notes: null,
      bankCharges: undefined,
      paidAt: "2026-10-05",
      settledAt: null,
    });
    expect("recordAnyway" in first).toBe(false);
  });

  it("Record anyway: the SAME body plus recordAnyway: true", () => {
    expect(editPaymentDto(fields, true)).toEqual({ ...first, recordAnyway: true });
  });
});
