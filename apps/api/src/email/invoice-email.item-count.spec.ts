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

const item = (description: string, over: Record<string, unknown>) => ({
  description,
  qty: 1,
  unitPrice: 1,
  subtotal: 1,
  ...over,
});

const build = (items: unknown[]) =>
  (makeService() as any).buildInvoiceEmail(
    {
      customerName: "Acme Market",
      invoiceNumber: "INV-1001",
      issueDate: "Oct 7, 2026",
      dueDate: "Nov 6, 2026",
      total: 12,
      balanceDue: 12,
      items,
    },
    "Acme Supply",
  ) as { html: string; text: string };

describe("invoice e-mail item count (W-1185)", () => {
  it("HTML and text part carry the mixed count", () => {
    const { html, text } = build([
      item("Sample Cola", { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 }),
      item("Sample Juice", { qty: 16, boxes: 1, pieces: 4, unitsPerBox: 12 }),
      item("Sample Water", { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, unitLabel: "Case" }),
      item("Sample Gum", { qty: 2, product: { unit: "each" } }),
    ]);
    const count = "4 lines · 4 boxes · 2 cases · 6 pcs";
    expect(html).toMatch(/Items<\/td>\s*<td[^>]*>4 lines · 4 boxes · 2 cases · 6 pcs<\/td>/);
    expect(text).toContain(`Items: ${count}`);
    // Items row opens the tfoot, above the Balance Due row; the text line sits above the money line.
    expect(html.indexOf("<tfoot>")).toBeLessThan(html.indexOf("Items</td>"));
    expect(html.indexOf("Items</td>")).toBeLessThan(html.indexOf("Balance Due"));
    expect(text.indexOf("Items: ")).toBeLessThan(text.indexOf("Balance Due"));
  });

  it("a single-line invoice reads 1 line · 1 box", () => {
    const { html, text } = build([
      item("Sample Cola", { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 }),
    ]);
    expect(html).toContain("1 line · 1 box</td>");
    expect(text).toContain("Items: 1 line · 1 box");
  });
});
