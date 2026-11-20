let mockCapturedInvoice: any = null;

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async (element: any) => {
    mockCapturedInvoice = element?.props?.invoice ?? null;
    return Buffer.from("");
  }),
}));

import { Test } from "@nestjs/testing";
import { InvoicePdfService } from "./invoice-pdf.service";
import { sendReminder } from "./invoice-reminder-email";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-1197 C13 / A2-1: the reminder carries no account block, in its body (email.service.spec T21) AND in the PDF it
 * attaches. Driven through the real reminder and the real InvoicePdfService (template props captured): with the
 * option on and another open invoice of 30, the reminder hands the PDF `{ show: false }`, the PDF makes no open-set
 * read and prints no rows.
 */
const INVOICE = {
  id: "inv-1",
  tenantId: "tenant-1",
  customerId: "cust-1",
  orderId: null,
  invoiceNumber: "INV-3001",
  status: "SENT",
  issueDate: new Date("2026-11-01T00:00:00.000Z"),
  dueDate: new Date("2026-12-01T00:00:00.000Z"),
  createdAt: new Date("2026-11-01T12:00:00.000Z"),
  subtotal: 50,
  taxAmount: 0,
  discount: 0,
  shippingFee: 0,
  total: 50,
  depositPercent: null,
  depositDueDate: null,
  notes: null,
  terms: null,
  pdfUrl: "invoice-pdfs/inv-1.pdf",
  customer: {
    id: "cust-1",
    businessName: "Acme Buyer",
    contactName: null,
    phone: null,
    email: "buyer@acme.test",
    isWalkIn: null,
    addresses: [],
  },
  items: [],
  payments: [],
  order: null,
};

async function remind(config: Record<string, string>) {
  mockCapturedInvoice = null;
  const prisma = createMockPrisma();
  prisma.invoice.findUnique.mockResolvedValue(INVOICE as any);
  prisma.invoice.findMany.mockResolvedValue([
    { id: "other-1", customerId: "cust-1", total: 30, status: "SENT", dueDate: null, payments: [] },
  ] as any);
  prisma.tenantConfig.findUnique.mockResolvedValue(null as any);
  const systemConfig = {
    get: jest.fn(async () => null),
    getAll: jest.fn(async () => config),
    set: jest.fn(),
  };
  const storage = {
    upload: jest.fn().mockResolvedValue(undefined),
    download: jest.fn().mockResolvedValue(Buffer.from("")),
    presignedUrl: jest.fn().mockResolvedValue("https://cdn.example.com/x.pdf"),
  };
  const module = await Test.createTestingModule({
    providers: [
      InvoicePdfService,
      { provide: PrismaService, useValue: prisma },
      { provide: StorageService, useValue: storage },
      { provide: SystemConfigService, useValue: systemConfig },
    ],
  }).compile();
  const pdfService = module.get(InvoicePdfService);
  const getOrGenerate = jest.spyOn(pdfService, "getOrGenerate");
  const sendInvoice = jest.fn().mockResolvedValue({ delivered: true });
  await sendReminder(
    {
      prisma,
      emailService: { isEmailConfigured: jest.fn().mockResolvedValue(true), sendInvoice },
      pdfService,
      storage,
      systemConfig,
      logger: { warn: jest.fn() },
    } as never,
    "inv-1",
  );
  return { getOrGenerate, findMany: prisma.invoice.findMany, sendInvoice };
}

describe("sendReminder: no account block in the attached PDF (SA-1197 A2-1, C13)", () => {
  it("option on, others 30: the reminder hands { show: false }; the PDF reads nothing and prints no rows", async () => {
    const { getOrGenerate, findMany, sendInvoice } = await remind({
      "invoice.showAccountBalance": "true",
    });
    expect(getOrGenerate).toHaveBeenCalledTimes(1);
    expect(getOrGenerate.mock.calls[0][1]).toEqual({ account: { show: false } });
    expect(mockCapturedInvoice).not.toBeNull();
    expect("accountRows" in mockCapturedInvoice).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
    // and the body carries none either (T21)
    expect(sendInvoice.mock.calls[0][0]).not.toHaveProperty("accountRows");
  });
});
