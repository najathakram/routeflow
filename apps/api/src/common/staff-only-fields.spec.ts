import { readFileSync } from "fs";
import { join } from "path";
import {
  STAFF_ONLY_INVOICE_FIELDS,
  STAFF_ONLY_LINE_FIELDS,
  STAFF_ONLY_ORDER_FIELDS,
  STAFF_ONLY_PAYMENT_FIELDS,
  omitStaffOnlyInvoiceFields,
  omitStaffOnlyOrderFields,
} from "./staff-only-fields";

/**
 * Customer-facing order and invoice responses carry customer-facing fields only. The helpers return
 * a copy without the staff-internal fields (line override reason/author, order commission rate,
 * invoice internal notes, payment notes) and never mutate their input, so a staff caller holding
 * the same object is unaffected. Fixtures are placeholders.
 */
const line = () => ({
  id: "li-1",
  unitPrice: 5,
  overrideReason: "staff-only reason",
  overriddenBy: "user-op",
});

const order = () => ({
  id: "ord-1",
  status: "PENDING",
  commissionRatePct: 7.5,
  notes: "customer note",
  lineItems: [line()],
  invoices: [
    { id: "inv-draft", status: "DRAFT", payments: [] },
    { id: "inv-sent", status: "SENT", payments: [{ id: "p-1", amount: 2 }] },
  ],
});

const invoice = () => ({
  id: "inv-1",
  status: "SENT",
  notes: "printed on the invoice",
  internalNotes: "staff-only memo",
  items: [line()],
  payments: [
    { id: "p-paid", status: "PAID", amount: 3, notes: "staff-only payment memo" },
    { id: "p-draft", status: "DRAFT", amount: 4, notes: "unconfirmed" },
    { id: "p-pending", status: "PENDING", amount: 5, notes: null },
    { id: "p-void", status: "VOID", amount: 6, notes: "bounced" },
  ],
});

describe("staff-only field lists", () => {
  it("name exactly the staff-internal fields", () => {
    expect([...STAFF_ONLY_LINE_FIELDS]).toEqual(["overrideReason", "overriddenBy"]);
    expect([...STAFF_ONLY_ORDER_FIELDS]).toEqual(["commissionRatePct"]);
    expect([...STAFF_ONLY_INVOICE_FIELDS]).toEqual(["internalNotes"]);
    expect([...STAFF_ONLY_PAYMENT_FIELDS]).toEqual(["notes"]);
  });
});

describe("omitStaffOnlyOrderFields", () => {
  it("drops the commission rate and every line's override reason/author", () => {
    const out = omitStaffOnlyOrderFields(order());
    expect(out).not.toHaveProperty("commissionRatePct");
    expect(out.lineItems[0]).not.toHaveProperty("overrideReason");
    expect(out.lineItems[0]).not.toHaveProperty("overriddenBy");
    expect(out.lineItems[0]).toEqual({ id: "li-1", unitPrice: 5 });
    expect(out.notes).toBe("customer note");
  });

  it("drops DRAFT invoices from the order's invoice list", () => {
    const out = omitStaffOnlyOrderFields(order());
    expect(out.invoices.map((i) => i.id)).toEqual(["inv-sent"]);
  });

  it("never mutates its input", () => {
    const input = order();
    const snapshot = JSON.parse(JSON.stringify(input));
    omitStaffOnlyOrderFields(input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it("is null-safe and leaves shapes without the fields alone", () => {
    expect(omitStaffOnlyOrderFields(null)).toBeNull();
    expect(omitStaffOnlyOrderFields(undefined)).toBeUndefined();
    expect(omitStaffOnlyOrderFields({ id: "o" })).toEqual({ id: "o" });
  });
});

describe("omitStaffOnlyInvoiceFields", () => {
  it("drops internal notes, line override reason/author and payment notes", () => {
    const out = omitStaffOnlyInvoiceFields(invoice());
    expect(out).not.toHaveProperty("internalNotes");
    expect(out.notes).toBe("printed on the invoice");
    expect(out.items[0]).toEqual({ id: "li-1", unitPrice: 5 });
    for (const p of out.payments) expect(p).not.toHaveProperty("notes");
    // Without the option every payment row stays (the detail view's own list).
    expect(out.payments.map((p) => p.id)).toEqual(["p-paid", "p-draft", "p-pending", "p-void"]);
  });

  it("confirmedPaymentsOnly keeps only PAID payment rows", () => {
    const out = omitStaffOnlyInvoiceFields(invoice(), { confirmedPaymentsOnly: true });
    expect(out.payments).toEqual([{ id: "p-paid", status: "PAID", amount: 3 }]);
  });

  it("never mutates its input", () => {
    const input = invoice();
    const snapshot = JSON.parse(JSON.stringify(input));
    omitStaffOnlyInvoiceFields(input, { confirmedPaymentsOnly: true });
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it("is null-safe", () => {
    expect(omitStaffOnlyInvoiceFields(null)).toBeNull();
    expect(omitStaffOnlyInvoiceFields({ id: "i" })).toEqual({ id: "i" });
  });
});

describe("customer-facing PDFs never render a staff-only field", () => {
  const renderers = [
    "../invoices/invoice-pdf.service.ts",
    "../invoices/invoice-pdf-item.ts",
    "../invoices/invoice-pdf-variant.ts",
    "../buyer/statement-pdf.service.ts",
    "../buyer/statement.service.ts",
  ];
  const names = [
    ...STAFF_ONLY_LINE_FIELDS,
    ...STAFF_ONLY_ORDER_FIELDS,
    ...STAFF_ONLY_INVOICE_FIELDS,
  ] as string[];

  it.each(renderers)("%s references none of them", (rel) => {
    const src = readFileSync(join(__dirname, rel), "utf8");
    for (const name of names) expect(src).not.toContain(name);
    // A payment's `notes` never reaches a renderer either.
    expect(src).not.toMatch(/payments?\b[^;\n]*\.notes\b/);
    expect(src).not.toMatch(/\bp(ayment)?\.notes\b/);
  });
});
