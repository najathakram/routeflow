import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

/**
 * Row 401: the e-mail of a counter sale paid at the till prints no due date and no payment terms (the CQ-26 rule the
 * invoice page already follows). Every other invoice keeps both. The caller decides with `isPaidAtSale` and passes
 * `hideTerms`; this pins what the renderer does with it, HTML and text part alike.
 */
function makeService(): EmailService {
  const config = { get: () => undefined } as any;
  const prisma = {
    getTenantId: () => "t1",
    forTenant: () => ({
      systemConfig: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }),
    tenantConfig: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findFirst: jest.fn().mockResolvedValue(null) },
  } as any;
  const mailboxSend = {
    trySend: jest.fn().mockResolvedValue({ delivered: false, transport: "mailbox" }),
  } as any;
  return new EmailService(config, prisma, { decrypt: (v: string) => v } as any, mailboxSend, {
    record: jest.fn(),
  } as any);
}

const build = (over: Record<string, unknown> = {}) =>
  (makeService() as any).buildInvoiceEmail(
    {
      customerName: "Acme Market",
      invoiceNumber: "INV-1001",
      issueDate: "Oct 7, 2026",
      dueDate: "Nov 6, 2026",
      paymentTermsLabel: "Net 30",
      total: 12,
      totalPaid: 12,
      balanceDue: 0,
      items: [{ description: "Sample Cola 12pk", qty: 1, unitPrice: 12, subtotal: 12 }],
      ...over,
    },
    "Acme Supply",
  ) as { html: string; text: string };

describe("invoice e-mail — paid-at-sale counter invoice (row 401)", () => {
  it("hideTerms drops the Due Date and Terms rows from the HTML and the text part", () => {
    const { html, text } = build({ hideTerms: true });
    for (const body of [html, text]) {
      expect(body).not.toMatch(/Due Date/);
      expect(body).not.toMatch(/Net 30/);
      expect(body).not.toMatch(/Terms/);
    }
    expect(html).toContain("Issue Date");
    expect(text).toContain("Issue Date: Oct 7, 2026");
  });

  it("hideTerms also drops the deposit schedule (its remainder is a due date), HTML and text", () => {
    const dep = { depositAmount: 3, depositDueDate: "Oct 7, 2026" };
    const hidden = build({ ...dep, hideTerms: true });
    for (const body of [hidden.html, hidden.text]) {
      expect(body).not.toMatch(/Remainder due/);
      expect(body).not.toMatch(/Deposit due/);
    }
    expect(build(dep).html).toContain("Remainder due by Nov 6, 2026");
    expect(build(dep).text).toContain("Remainder due by Nov 6, 2026");
  });

  it("any other invoice keeps its due date and terms (unchanged)", () => {
    for (const over of [{}, { hideTerms: false }]) {
      const { html, text } = build(over);
      expect(html).toContain("Due Date");
      expect(html).toContain("Net 30");
      expect(text).toContain("Due Date: Nov 6, 2026");
      expect(text).toContain("Terms: Net 30");
    }
  });
});
