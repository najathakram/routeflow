import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

/**
 * SA-1029 G-6 (one word): the MSRP note names the line's base unit, the same word the per-piece
 * cell uses. A pack line of a "Bag" product prints "/bag"; a loose line has no per-base-unit
 * object and keeps "/pc".
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

const build = (item: Record<string, unknown>) =>
  (makeService() as any).buildInvoiceEmail(
    {
      customerName: "Acme Market",
      invoiceNumber: "INV-1001",
      issueDate: "Oct 7, 2026",
      dueDate: "Nov 6, 2026",
      paymentTermsLabel: "Net 30",
      total: 48,
      totalPaid: 0,
      balanceDue: 48,
      items: [{ description: "Sample Chips", qty: 1, unitPrice: 48, subtotal: 48, ...item }],
    },
    "Acme Supply",
  ) as { html: string; text: string };

describe("invoice e-mail — MSRP note unit word (SA-1029 G-6)", () => {
  it("MSRP-R1: a pack line of a Bag product prints MSRP /bag", () => {
    const { html } = build({ msrp: 3.49, perBaseUnit: { price: 2, unit: "bag" } });
    expect(html).toContain("MSRP $3.49/bag");
    expect(html).not.toContain("MSRP $3.49/pc");
  });

  it("MSRP-G1: a loose line keeps MSRP /pc", () => {
    const { html } = build({ msrp: 3.49 });
    expect(html).toContain("MSRP $3.49/pc");
  });

  it("E-R3: a unit word is tenant text, so the MSRP note escapes it", () => {
    const { html } = build({ msrp: 3.49, perBaseUnit: { price: 2, unit: "<b>x" } });
    expect(html).toContain("MSRP $3.49/&lt;b&gt;x");
    expect(html).not.toContain("MSRP $3.49/<b>x");
  });
});
