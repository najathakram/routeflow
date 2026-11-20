import { buildInvoiceEmailPayload, buildReminderEmailPayload } from "./invoice-email-payload";
import type { InvoiceAccountBalance } from "../customers/invoice-account-balance";

/**
 * SA-1197 (C4, C5, C13): the invoice email payload carries the rows of the ONE account result the send read (the same
 * object the PDF got), decided with the tenant's hideBalanceDue. The reminder payload never carries them (T21).
 */
const INV = {
  id: "inv-1",
  invoiceNumber: "INV-1",
  total: 50,
  status: "SENT",
  issueDate: new Date("2026-11-01T00:00:00.000Z"),
  dueDate: new Date("2026-12-01T00:00:00.000Z"),
  customer: { businessName: "Acme Buyer" },
  items: [],
  payments: [],
};
const CTX = {
  recipientEmail: "buyer@example.com",
  pdfUrl: undefined,
  attachment: undefined,
  hideOriginalPrice: false,
};
const SHOWN: InvoiceAccountBalance = {
  show: true,
  others: 30,
  thisInvoice: 50,
  openBalance: 80,
  asOf: "2026-11-20",
};

describe("buildInvoiceEmailPayload: the account rows (SA-1197)", () => {
  it("T18 guard: no account handed, or { show: false } -> no accountRows key (today's payload)", () => {
    const today = buildInvoiceEmailPayload(INV, CTX);
    expect("accountRows" in today).toBe(false);
    const none = buildInvoiceEmailPayload(INV, { ...CTX, account: { show: false } });
    expect(none).toEqual(today);
  });

  it("the handed result's rows, full form", () => {
    const p = buildInvoiceEmailPayload(INV, { ...CTX, account: SHOWN });
    expect(p.accountRows?.map((r) => [r.kind, r.amount])).toEqual([
      ["heading", null],
      ["others", 30],
      ["thisInvoice", 50],
      ["openBalance", 80],
    ]);
  });

  it("T11: hideBalanceDue -> the single 'Open balance on' row", () => {
    const p = buildInvoiceEmailPayload(INV, { ...CTX, hideBalanceDue: true, account: SHOWN });
    expect(p.accountRows).toEqual([
      { kind: "openBalanceOn", label: "Open balance on Nov 20, 2026", amount: 80 },
    ]);
  });

  it("T21 guard: the reminder payload carries no account rows", () => {
    const r = buildReminderEmailPayload(INV, { ...CTX, account: SHOWN } as never);
    expect("accountRows" in r).toBe(false);
  });
});
