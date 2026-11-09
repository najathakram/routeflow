import { buildInvoiceEmailPayload } from "../invoices/invoice-email-payload";
import { EmailService } from "./email.service";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));

/**
 * W-1185: the invoice e-mail's line-items table closes with an "Items" row (lines, boxes, named units, pieces),
 * and the text part carries `Items: ...` right after the item lines, above the money lines.
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
  return new EmailService(
    config,
    prisma,
    { decrypt: (v: string) => v } as any,
    mailboxSend,
    { record: jest.fn() } as any,
    {} as any,
  );
}

// The item rows are built the way the real send builds them: `buildInvoiceEmailPayload` maps the
// stored invoice rows (Prisma shape) into the e-mail's items, so a field the payload drops is a
// field this spec does not see either.
const item = (description: string, over: Record<string, unknown>) => ({
  description,
  qty: 1,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  packLabel: null,
  baseLabel: null,
  systemKind: null,
  unitPrice: 1,
  subtotal: 1,
  ...over,
});

const build = (stored: unknown[]) => {
  const payload = buildInvoiceEmailPayload(
    {
      id: "i1",
      invoiceNumber: "INV-1001",
      issueDate: "2026-10-07",
      dueDate: "2026-11-06",
      total: 12,
      payments: [],
      items: stored,
      customer: { businessName: "Acme Market" },
    },
    {
      recipientEmail: "ap@example.test",
      pdfUrl: undefined,
      attachment: undefined,
      hideOriginalPrice: false,
    },
  );
  return (makeService() as any).buildInvoiceEmail(payload, "Acme Supply") as {
    html: string;
    text: string;
  };
};

describe("invoice e-mail item count (W-1185)", () => {
  it("HTML and text part carry the mixed count", () => {
    const { html, text } = build([
      item("Sample Cola", { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 }),
      item("Sample Juice", { qty: 16, boxes: 1, pieces: 4, unitsPerBox: 12 }),
      item("Sample Water", { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, unitLabel: "Case" }),
      item("Sample Gum", { qty: 2 }),
    ]);
    // The plain gum line has no frozen word: its bare qty counts as pieces.
    const count = "4 lines · 4 boxes · 2 cases · 6 pcs";
    expect(html).toMatch(/Items<\/td>\s*<td[^>]*>4 lines · 4 boxes · 2 cases · 6 pcs<\/td>/);
    expect(text).toContain(`Items: ${count}`);
    // Items row opens the tfoot, above the Balance Due row; the text line sits above the money line.
    expect(html.indexOf("<tfoot>")).toBeLessThan(html.indexOf("Items</td>"));
    expect(html.indexOf("Items</td>")).toBeLessThan(html.indexOf("Balance Due"));
    expect(text.indexOf("Items: ")).toBeLessThan(text.indexOf("Balance Due"));
  });

  it("a named line with no stored boxes counts qty / unitsPerBox, as the web page and the PDF do", () => {
    const { html, text } = build([
      item("Sample Water", { qty: 24, unitsPerBox: 12, unitLabel: "Case", boxes: null }),
    ]);
    expect(html).toContain("1 line · 2 cases</td>");
    expect(text).toContain("Items: 1 line · 2 cases");
  });

  it("the NSF fee is not goods and a frozen base label names a plain line", () => {
    const { html } = build([
      item("Sample Cola", { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 }),
      item("Sample Produce", { qty: 1.5, baseLabel: "kg" }),
      item("Returned check fee", { qty: 1, systemKind: "NSF_FEE" }),
    ]);
    expect(html).toContain("2 lines · 3 boxes · 1.5 kg</td>");
  });

  it("a single-line invoice reads 1 line · 1 box", () => {
    const { html, text } = build([
      item("Sample Cola", { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 }),
    ]);
    expect(html).toContain("1 line · 1 box</td>");
    expect(text).toContain("Items: 1 line · 1 box");
  });
});
