import { EmailService } from "./email.service";
import { EMAIL_KINDS, EMAIL_KIND_AUDIENCE } from "./email-kinds";
import { lookupDeliveriesByMessageId } from "./bounces/email-bounce-keys";

jest.mock("nodemailer", () => ({ createTransport: jest.fn() }));
// Never reach the real Resend client (B909).
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: jest.fn() } })),
}));

/**
 * W-1443 (SA-1516) T9-T11: the staff copy of an invoice email is its own delivery kind, never the
 * customer's INVOICE_SENT row, and a name carrying a line break cannot start a second header line.
 * Mocked at the module boundary: `send()` is spied, nothing is delivered.
 */
function makeService(
  record: jest.Mock = jest.fn(),
  wall: { klass: string; allowed?: string[] } = { klass: "PRODUCTION" },
): EmailService {
  const prisma = {
    // Since the mail wall (#4551) every send reads the business class; PRODUCTION is never walled.
    tenant: { findUnique: jest.fn().mockResolvedValue({ class: wall.klass }) },
    $queryRaw: jest
      .fn()
      .mockResolvedValue(wall.allowed ? [{ value: JSON.stringify(wall.allowed) }] : []),
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
  const config = { get: () => undefined } as any;
  return new EmailService(
    config,
    prisma,
    { decrypt: (v: string) => v } as any,
    { trySend: jest.fn() } as any,
    { record } as any,
    {} as any,
  );
}

const base = {
  to: "owner@acme.test",
  customerName: "Acme Buyer",
  invoiceNumber: "INV-1",
  invoiceId: "inv-1",
  issueDate: "Jan 1, 2026",
  dueDate: "Jan 31, 2026",
  total: 100,
  items: [],
} as any;

describe("EmailService.sendInvoice - staffCopy (W-1443)", () => {
  it("T9: records the copy as INVOICE_STAFF_COPY with a `Copy: ` subject (the customer send stays INVOICE_SENT)", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice(base); // the customer's email
    await svc.sendInvoice({ ...base, staffCopy: { sentTo: "buyer@acme.test" } });

    const customer = sendSpy.mock.calls[0][0] as any;
    const copy = sendSpy.mock.calls[1][0] as any;
    expect(customer.delivery.kind).toBe("INVOICE_SENT");
    expect(customer.subject).toBe("Invoice INV-1");
    expect(copy.delivery.kind).toBe("INVOICE_STAFF_COPY");
    expect(copy.delivery).toMatchObject({ entityType: "Invoice", entityId: "inv-1" });
    expect(copy.subject).toBe("Copy: Invoice INV-1 (sent to buyer@acme.test)");
    expect(copy.to).toBe("owner@acme.test");
    expect(copy.html).toContain("You sent this invoice to buyer@acme.test.");
    expect(copy.text).toContain("You sent this invoice to buyer@acme.test.");
    expect(customer.html).not.toContain("You sent this invoice to");
  });

  it("T9: the copy keeps alsoEntityIds of a completion email", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);
    await svc.sendInvoice({
      ...base,
      alsoInvoiceIds: ["inv-2"],
      staffCopy: { sentTo: "buyer@acme.test" },
    });
    expect((sendSpy.mock.calls[0][0] as any).delivery.alsoEntityIds).toEqual(["inv-2"]);
  });

  it("T10: a sentTo with a line break does not start a second subject header line, and the body line is escaped", async () => {
    const svc = makeService();
    const sendSpy = jest
      .spyOn(svc, "send")
      .mockResolvedValue({ delivered: true, transport: "smtp" } as any);

    await svc.sendInvoice({
      ...base,
      staffCopy: { sentTo: "buyer@acme.test\r\nBcc: evil@x.test<b>" },
    });

    const copy = sendSpy.mock.calls[0][0] as any;
    expect(copy.subject).not.toMatch(/[\r\n]/);
    expect(copy.html).not.toContain("<b>");
    expect(copy.html).toContain("&lt;b&gt;");
  });

  it("T11: INVOICE_STAFF_COPY is a declared kind with the tenant audience", () => {
    expect(EMAIL_KINDS).toContain("INVOICE_STAFF_COPY");
    expect(EMAIL_KIND_AUDIENCE.INVOICE_STAFF_COPY).toBe("tenant");
  });

  it("a held, non-PRODUCTION business sends no staff copy either (the customer's allowed address still goes)", async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(record, { klass: "TEST", allowed: ["owner@acme.test"] });
    const sent = jest
      .spyOn(svc as any, "sendUnrecorded")
      .mockResolvedValue({ delivered: true, transport: "smtp", id: "<m@acme.test>" });

    const customer = await svc.sendInvoice(base);
    const copy = await svc.sendInvoice({
      ...base,
      to: "staff@acme.test",
      staffCopy: { sentTo: "owner@acme.test" },
    });

    expect(customer.delivered).toBe(true);
    expect(copy.delivered).toBe(false);
    expect(sent).toHaveBeenCalledTimes(1); // only the customer's email reached the transport
    const rows = record.mock.calls.map((c) => c[0]);
    expect(rows.map((r) => [r.kind, r.status])).toEqual([
      ["INVOICE_SENT", "SENT"],
      ["INVOICE_STAFF_COPY", "FAILED"],
    ]);
  });

  it("R-264: the copy has its own refToken and Message-ID; a bounce lookup by the customer's Message-ID finds only the customer's row", async () => {
    const record = jest.fn().mockResolvedValue(undefined);
    const svc = makeService(record);
    const ids = ["<m-customer@acme.test>", "<m-copy@acme.test>"];
    jest
      .spyOn(svc as any, "sendUnrecorded")
      .mockImplementation(async () => ({ delivered: true, transport: "smtp", id: ids.shift() }));

    await svc.sendInvoice(base); // the customer's email
    await svc.sendInvoice({ ...base, staffCopy: { sentTo: "buyer@acme.test" } });

    const [customer, copy] = record.mock.calls.map((c) => c[0]);
    expect(customer.kind).toBe("INVOICE_SENT");
    expect(copy.kind).toBe("INVOICE_STAFF_COPY");
    expect(customer.refToken).toBeTruthy();
    expect(copy.refToken).toBeTruthy();
    expect(copy.refToken).not.toBe(customer.refToken);
    expect(copy.providerMessageId).not.toBe(customer.providerMessageId);

    const rows = [customer, copy].map((r, i) => ({ id: "row" + i, tenantId: "t1", ...r }));
    const prisma = {
      emailDelivery: {
        findMany: jest.fn(async ({ where }: any) =>
          rows.filter((r) => where.providerMessageId.in.includes(r.providerMessageId)),
        ),
      },
    } as any;
    const found = await lookupDeliveriesByMessageId(prisma, "<m-customer@acme.test>");
    expect(found).toEqual({
      status: "MATCHED",
      rows: [{ id: "row0", tenantId: "t1", ...rows[0] }],
    });
  });
});
