/**
 * W-680 (SA-848 LOW 2): the email's paid basis is derived in ONE place, `emailPaidBasis(inv)`, and both the invoice email and
 * the reminder read it. Behaviour-neutral: the figures are the F03/R8/B421 ones (CONFIRMED rows only; cash is external
 * money only; credit-note and advance applications never read as "Amount Paid"; balance due on the confirmed total).
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildInvoiceEmailPayload,
  buildReminderEmailPayload,
  emailPaidBasis,
} from "./invoice-email-payload";

const pay = (over: Record<string, unknown>) => ({
  status: "PAID",
  method: "CASH",
  amount: 0,
  ...over,
});

const inv = {
  id: "i1",
  invoiceNumber: "INV-1",
  total: 200,
  items: [],
  customer: { businessName: "Acme" },
  payments: [
    pay({ method: "CASH", amount: 50 }),
    pay({ method: "CHECK", amount: 25 }),
    pay({ method: "CREDIT_NOTE", amount: 40, creditNote: { creditNoteNumber: "CN-7" } }),
    pay({ method: "CREDIT_NOTE", amount: 10, creditNote: { creditNoteNumber: "CN-7" } }), // same note twice: listed once
    pay({ method: "ADVANCE", amount: 20 }),
    pay({ method: "CASH", amount: 999, status: "DRAFT" }), // unconfirmed: never counted
  ],
};

describe("emailPaidBasis (W-680)", () => {
  it("is the CONFIRMED-only basis: cash excludes credit and advance, a DRAFT row counts for nothing", () => {
    expect(emailPaidBasis(inv)).toEqual({
      totalPaid: 75,
      creditApplied: 50,
      advanceApplied: 20,
      creditNoteNumbers: ["CN-7"],
      balanceDue: 55, // 200 - (75 + 50 + 20)
    });
  });

  it("is the same figures the invoice email and the reminder both carry", () => {
    const basis = emailPaidBasis(inv);
    const email = buildInvoiceEmailPayload(inv, {
      recipientEmail: "ap@example.test",
      pdfUrl: undefined,
      attachment: undefined,
      hideOriginalPrice: false,
    });
    const reminder = buildReminderEmailPayload(inv, {
      recipientEmail: "ap@example.test",
      pdfUrl: undefined,
      attachment: undefined,
      hideOriginalPrice: false,
    });
    for (const out of [email, reminder]) {
      expect({
        totalPaid: out.totalPaid,
        creditApplied: out.creditApplied,
        advanceApplied: out.advanceApplied,
        creditNoteNumbers: out.creditNoteNumbers,
        balanceDue: out.balanceDue,
      }).toEqual(basis);
    }
  });

  it("an invoice with no payments: nothing paid, balance = total", () => {
    expect(emailPaidBasis({ total: 80, payments: [] })).toEqual({
      totalPaid: 0,
      creditApplied: 0,
      advanceApplied: 0,
      creditNoteNumbers: [],
      balanceDue: 80,
    });
  });

  it("sendReminder derives no paid basis of its own any more (one copy)", () => {
    const service = readFileSync(join(__dirname, "invoice-reminder-email.ts"), "utf8");
    const a = service.indexOf("export async function sendReminder(");
    expect(a).toBeGreaterThan(-1);
    const body = service.slice(a);
    expect(body).not.toMatch(/splitConfirmed\(/);
    expect(body).not.toMatch(/confirmedBalance\(/);
    expect(body).not.toMatch(/CREDIT_NOTE_METHOD/);
  });
});
