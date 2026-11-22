let mockCapturedInvoice: any = null;

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async (element: any) => {
    mockCapturedInvoice = element?.props?.invoice ?? null;
    return Buffer.from("");
  }),
}));

import { Test } from "@nestjs/testing";
import { InvoicePdfService } from "./invoice-pdf.service";
import { SEND_SNAPSHOT_INCLUDE } from "./invoice-send-snapshot";
import type { InvoiceAccountBalance } from "../customers/invoice-account-balance";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-1197: the invoice PDF's account block. The template is jest-mocked wholesale (as in invoice-pdf.service.spec.ts),
 * so these read the props the service hands it: `accountRows` is the server's row list (accountBlockRows), present only
 * when there is something to print.
 */

const INVOICE = {
  id: "inv-1",
  tenantId: "tenant-1",
  customerId: "cust-1",
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
    isWalkIn: null,
    addresses: [],
  },
  items: [],
  payments: [],
  order: null,
};

async function render(opts: {
  config?: Record<string, string>;
  others?: { total: number }[];
  handed?: InvoiceAccountBalance;
  customer?: Record<string, unknown>;
  zone?: string;
}) {
  mockCapturedInvoice = null;
  const prisma = createMockPrisma();
  prisma.invoice.findUnique.mockResolvedValue({
    ...INVOICE,
    customer: { ...INVOICE.customer, ...(opts.customer ?? {}) },
  } as any);
  prisma.invoice.findMany.mockResolvedValue(
    (opts.others ?? []).map((o, i) => ({
      customerId: "cust-1",
      total: o.total,
      status: "SENT",
      dueDate: null,
      payments: [],
      id: `other-${i}`,
    })) as any,
  );
  prisma.tenantConfig.findUnique.mockResolvedValue(
    (opts.zone ? { timezone: opts.zone } : null) as any,
  );
  const systemConfig = {
    get: jest.fn(async () => null),
    getAll: jest.fn(async () => opts.config ?? {}),
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
  const service = module.get(InvoicePdfService);
  await service.getOrGenerate("inv-1", opts.handed ? { account: opts.handed } : undefined);
  return { props: mockCapturedInvoice, findMany: prisma.invoice.findMany };
}

const ON = { "invoice.showAccountBalance": "true" };

describe("InvoicePdfService: the account block (SA-1197)", () => {
  it("T18: switch absent -> no accountRows key and zero open-set reads (today's model)", async () => {
    const { props, findMany } = await render({ others: [{ total: 30 }] });
    expect("accountRows" in props).toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("on, others owed -> the full block from one open-set read", async () => {
    const { props, findMany } = await render({ config: ON, others: [{ total: 30 }] });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      customerId: "cust-1",
      id: { not: "inv-1" },
    });
    expect(props.accountRows.map((r: any) => [r.kind, r.amount])).toEqual([
      ["heading", null],
      ["others", 30],
      ["thisInvoice", 50],
      ["openBalance", 80],
    ]);
  });

  it("T11: Balance Due hidden -> one 'Open balance on' row", async () => {
    const { props } = await render({
      config: { ...ON, "invoice.hideBalanceDue": "true" },
      others: [{ total: 30 }],
    });
    expect(props.accountRows.map((r: any) => [r.kind, r.amount])).toEqual([["openBalanceOn", 80]]);
  });

  it("T3: a handed result is printed as given and the service makes zero open-set reads", async () => {
    const handed: InvoiceAccountBalance = {
      show: true,
      others: 12,
      thisInvoice: 50,
      openBalance: 62,
      asOf: "2026-11-21",
      asOfAt: "2026-11-21T22:46:00.000Z",
      zone: "America/Chicago",
    };
    const { props, findMany } = await render({ config: ON, others: [{ total: 30 }], handed });
    expect(findMany).not.toHaveBeenCalled();
    expect(props.accountRows.find((r: any) => r.kind === "openBalance").amount).toBe(62);
  });

  it("D3-7: a handed read keeps its own time when the PDF is built a day later (a cached PDF's time)", async () => {
    const handed: InvoiceAccountBalance = {
      show: true,
      others: 30,
      thisInvoice: 50,
      openBalance: 80,
      asOf: "2026-11-21",
      asOfAt: "2026-11-21T22:46:00.000Z",
      zone: "America/Chicago",
    };
    const { props } = await render({ config: ON, handed });
    expect(props.accountRows[0].label).toBe(
      "Customer account balance as of Nov 21, 2026, 4:46 PM CST",
    );
  });

  it("D3-8: the template gets the tenant's zone for the Generated stamp; no zone falls back to UTC", async () => {
    expect((await render({ zone: "America/Chicago" })).props.tenantZone).toBe("America/Chicago");
    expect((await render({})).props.tenantZone).toBe("UTC");
  });

  it("T3b: a handed { show: false } is honoured, never re-read", async () => {
    const { props, findMany } = await render({
      config: ON,
      others: [{ total: 30 }],
      handed: { show: false },
    });
    expect(findMany).not.toHaveBeenCalled();
    expect("accountRows" in props).toBe(false);
  });

  it("T9: the walk-in customer gets no block and no read", async () => {
    const { props, findMany } = await render({
      config: ON,
      others: [{ total: 30 }],
      customer: { isWalkIn: true },
    });
    expect(findMany).not.toHaveBeenCalled();
    expect("accountRows" in props).toBe(false);
  });

  it("C7: the snapshot / PDF include selects isWalkIn, so a real model can carry the block", () => {
    expect(SEND_SNAPSHOT_INCLUDE.customer.select).toMatchObject({ isWalkIn: true });
  });
});
