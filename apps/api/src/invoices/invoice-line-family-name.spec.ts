let mockCapturedInvoice: any = null;

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async (element: any) => {
    mockCapturedInvoice = element?.props?.invoice ?? null;
    return Buffer.from("");
  }),
}));

import { Test } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { buildInvoiceEmailPayload, buildReminderEmailPayload } from "./invoice-email-payload";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * Owner bug (2026-11-01): an invoice line for a product with variants printed only the variant label ("Classic"),
 * which means nothing on its own. The line must read "<Family> - <Variant>" on every copy of the invoice: a NEW line
 * stores the composed name (the writers), and an EXISTING line, whose stored description is still the bare name, is
 * composed at read time (no backfill: the send fingerprint hashes the stored text, so a rewrite would show every sent
 * invoice as changed since sent). A description someone typed over the product name is never touched.
 *
 * Money is out of scope: every case here also pins qty, unit price and subtotal.
 */
const FAMILY = "Acme Family";
const VARIANT = "Classic";
const COMPOSED = `${FAMILY} - ${VARIANT}`;

const variantProduct = {
  id: "p-variant",
  name: VARIANT,
  variantName: VARIANT,
  parentProductId: "p-family",
  parent: { name: FAMILY },
  barcode: null,
  sku: null,
  unitSku: null,
  unitsPerBox: 0,
};
const standaloneProduct = {
  id: "p-solo",
  name: "Widget",
  variantName: null,
  parentProductId: null,
  parent: null,
  barcode: null,
  sku: null,
  unitSku: null,
  unitsPerBox: 0,
};

/** One stored invoice line the way it sits in the DB today. */
const storedLine = (id: string, description: string, product: any) => ({
  id,
  description,
  productId: product.id,
  qty: 3,
  unitPrice: 10,
  discount: 0,
  taxRate: 0,
  subtotal: 30,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  originalPrice: null,
  priceType: "STANDARD",
  promoFreeUnits: null,
  msrp: null,
  notes: null,
  product,
});

const MONEY = (l: any) => [Number(l.qty), Number(l.unitPrice), Number(l.subtotal)];

describe("order line -> invoice line (writer C1: buildInvoiceItemData)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new InvoicesService(...(Array(15).fill(undefined) as any[]));
  const build = (li: any) => (service as any).buildInvoiceItemData(li, 3, "test-tenant");
  const orderLine = (product: any, over: Record<string, unknown> = {}) => ({
    id: "oi-1",
    productId: product.id,
    name: product.name,
    qty: 3,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 10,
    subtotal: 30,
    product,
    ...over,
  });

  it("a variant line is stored as '<Family> - <Variant>', not the bare variant label", () => {
    expect(build(orderLine(variantProduct)).description).toBe(COMPOSED);
  });

  it("a standalone product keeps its name", () => {
    expect(build(orderLine(standaloneProduct)).description).toBe("Widget");
  });

  it("a legacy variant whose stored name already carries the family prefix is not double-prefixed", () => {
    const legacy = { ...variantProduct, name: COMPOSED, variantName: COMPOSED };
    expect(build(orderLine(legacy)).description).toBe(COMPOSED);
  });

  it("an unlisted line (no product) keeps its free-text name", () => {
    expect(
      build(orderLine({ ...standaloneProduct, id: null }, { product: null, productId: null }))
        .description,
    ).toBe("Widget");
  });

  it("the name changes nothing about the money: the same order line bills the same as a standalone one", () => {
    const a = build(orderLine(variantProduct));
    const b = build(orderLine(standaloneProduct));
    expect(MONEY(a)).toEqual(MONEY(b));
    expect(a.subtotal).toBe(b.subtotal);
    expect(a.categoryTaxAmount).toBe(b.categoryTaxAmount);
  });
});

describe("the email's item table (sendEmail + reminder payloads)", () => {
  const ctx = {
    recipientEmail: "buyer@example.test",
    pdfUrl: undefined,
    attachment: undefined,
    hideOriginalPrice: false,
  };
  const invoice = (items: any[]) => ({
    id: "inv-1",
    invoiceNumber: "INV-1",
    issueDate: new Date("2026-01-01T00:00:00Z"),
    dueDate: new Date("2026-01-31T00:00:00Z"),
    total: 30,
    status: "SENT",
    customer: { businessName: "Acme Buyer" },
    payments: [],
    items,
  });

  it.each([
    ["invoice email", (inv: any) => buildInvoiceEmailPayload(inv, ctx)],
    ["reminder email", (inv: any) => buildReminderEmailPayload(inv, ctx)],
  ])(
    "%s: a stored bare variant name reads '<Family> - <Variant>'; money is unchanged",
    (_n, build) => {
      const payload = build(invoice([storedLine("i1", VARIANT, variantProduct)]));
      expect(payload.items[0].description).toBe(COMPOSED);
      expect(MONEY(payload.items[0])).toEqual([3, 10, 30]);
    },
  );

  it("a description typed over the product name is left alone", () => {
    const payload = buildInvoiceEmailPayload(
      invoice([storedLine("i1", "Classic, case of 12 (gift)", variantProduct)]),
      ctx,
    );
    expect(payload.items[0].description).toBe("Classic, case of 12 (gift)");
  });

  it("a standalone line is unchanged and the variant lines sort under their family", () => {
    const payload = buildInvoiceEmailPayload(
      invoice([
        storedLine("i1", "Widget", standaloneProduct),
        storedLine("i2", VARIANT, variantProduct),
      ]),
      ctx,
    );
    expect(payload.items.map((i: any) => i.description)).toEqual([COMPOSED, "Widget"]);
  });
});

describe("the PDF's item rows", () => {
  it("a stored bare variant name prints '<Family> - <Variant>' next to an unchanged standalone line", async () => {
    mockCapturedInvoice = null;
    const prisma = createMockPrisma();
    prisma.tenantConfig.findUnique.mockResolvedValue(null as any);
    const module = await Test.createTestingModule({
      providers: [
        InvoicePdfService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue(undefined),
            download: jest.fn(),
            presignedUrl: jest.fn().mockResolvedValue("https://cdn.example.com/x.pdf"),
          },
        },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
      ],
    }).compile();
    const pdf = module.get(InvoicePdfService);
    const model = {
      id: "inv-1",
      tenantId: null,
      invoiceNumber: "INV-1",
      status: "SENT",
      issueDate: new Date("2026-01-01T00:00:00Z"),
      dueDate: new Date("2026-01-31T00:00:00Z"),
      subtotal: 60,
      taxAmount: 0,
      discount: 0,
      shippingFee: 0,
      total: 60,
      customer: { id: "c1", businessName: "Acme Buyer", addresses: [] },
      items: [
        storedLine("i1", VARIANT, variantProduct),
        storedLine("i2", "Widget", standaloneProduct),
      ],
      payments: [],
      order: null,
    };
    await pdf.generateAndUpload("inv-1", undefined, model as any);
    const rows: any[] = mockCapturedInvoice.items;
    expect(rows.map((r) => r.description)).toEqual([COMPOSED, "Widget"]);
    expect(rows.map(MONEY)).toEqual([
      [3, 10, 30],
      [3, 10, 30],
    ]);
  });
});

describe("InvoicesService.findOne (staff page, buyer portal, mobile all read this)", () => {
  const makeService = (findUnique: jest.Mock) => {
    const service = new (InvoicesService as unknown as new (...a: unknown[]) => InvoicesService)(
      ...Array(14).fill(undefined),
    );
    Object.assign(service, {
      prisma: {
        getTenantId: () => null,
        forTenant: () => ({
          invoice: { findUnique },
          auditLog: {
            groupBy: jest.fn().mockResolvedValue([]),
            findFirst: jest.fn().mockResolvedValue(null),
          },
        }),
      },
      systemConfig: { get: jest.fn().mockResolvedValue(null) },
    });
    return service;
  };
  const stored = () => ({
    id: "inv-1",
    status: "SENT",
    total: 60,
    dueDate: null,
    payments: [],
    items: [
      storedLine("i1", VARIANT, variantProduct),
      storedLine("i2", "Widget", standaloneProduct),
    ],
  });

  it("reads each line's family from the product (the select asks for it)", async () => {
    const findUnique = jest.fn().mockResolvedValue(stored());
    await makeService(findUnique).findOne("inv-1");
    const select = findUnique.mock.calls[0][0].include.items.include.product.select;
    expect(select).toMatchObject({
      name: true,
      variantName: true,
      parentProductId: true,
      parent: { select: { name: true } },
    });
  });

  it("returns '<Family> - <Variant>' for a stored bare name, a standalone line unchanged, money identical", async () => {
    const findUnique = jest.fn().mockResolvedValue(stored());
    const out: any = await makeService(findUnique).findOne("inv-1");
    expect(out.items.map((i: any) => i.description)).toEqual([COMPOSED, "Widget"]);
    expect(out.items.map(MONEY)).toEqual([
      [3, 10, 30],
      [3, 10, 30],
    ]);
  });
});
