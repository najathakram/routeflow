import { readFileSync } from "fs";
import { join } from "path";
import type { UpdatePaymentDto } from "../lib/api/payments";

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

  it("the resend carries recordAnyway: true on the same body; a first save never does", () => {
    expect(src).toMatch(/const submit = \(recordAnyway = false\) =>/);
    expect(src).toMatch(/\.\.\.\(recordAnyway \? \{ recordAnyway: true \} : \{\}\)/);
  });

  it("the edit DTO carries the flag", () => {
    const dto: UpdatePaymentDto = {
      invoiceId: "i",
      paymentId: "p",
      method: "CHECK",
      amount: 1,
      recordAnyway: true,
    };
    expect(dto.recordAnyway).toBe(true);
  });
});
