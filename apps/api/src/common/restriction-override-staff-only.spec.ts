/**
 * Row 510: the restriction-override stamp is STAFF-ONLY. A buyer read, an invoice PDF, a packing slip and a receipt
 * never carry `restrictionOverrideReason` / `By` / `At` / `RuleIds`.
 *  1. Buyer reads: `staff-only-fields.ts` is an ALLOWLIST; the buyer controller's order and invoice reads go through
 *     `toCustomerOrder` / `pickCustomerOrderFields` / `pickCustomerInvoiceFields`. A stamped fixture row comes out
 *     without any of the four columns, and no allowlist names one.
 *  2. Invoice PDF: `invoice-pdf.service.ts` includes WHOLE item rows; its model mapper strips the stamp
 *     (`withoutOverrideStamp`), so the template model built from a stamped row has none of the four keys.
 *  3. Source pin: the document templates and models never spell `restrictionOverride` (a future read would be a leak).
 */
let mockCapturedInvoice: any = null;

jest.mock("@react-pdf/renderer", () => ({
  renderToBuffer: jest.fn(async (element: any) => {
    mockCapturedInvoice = element?.props?.invoice ?? null;
    return Buffer.from("");
  }),
}));

import * as fs from "fs";
import * as path from "path";
import { Test } from "@nestjs/testing";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import {
  CLEARED_OVERRIDE_STAMP,
  OVERRIDE_STAMP_COLUMNS,
  OVERRIDE_STAMP_SELECT,
  carryOverrideStamp,
  hasOverrideStamp,
  withoutOverrideStamp,
} from "./restriction-override-columns";
import {
  CUSTOMER_INVOICE_FIELDS,
  CUSTOMER_INVOICE_ITEM_FIELDS,
  CUSTOMER_ORDER_FIELDS,
  CUSTOMER_ORDER_ITEM_FIELDS,
  pickCustomerInvoiceFields,
  pickCustomerOrderFields,
  toCustomerOrder,
} from "./staff-only-fields";

const STAMP = {
  restrictionOverrideReason: "Customer holds a licence",
  restrictionOverrideBy: "u-op",
  restrictionOverrideAt: new Date("2026-10-14T12:00:00.000Z"),
  restrictionOverrideRuleIds: ["r1"],
};
/** What a STAFF read carries: the stamp plus the resolved name of the overriding user (row 510, ruling 2026-10-14). */
const STAFF_STAMP = { ...STAMP, restrictionOverrideByName: "Pat Lee" };
const stampKeys = (row: object) =>
  Object.keys(row).filter((k) => k.startsWith("restrictionOverride"));

const stampedOrder = () => ({
  id: "o-1",
  status: "PENDING",
  total: 10,
  lineItems: [
    { id: "li-1", productId: "p-1", qty: 1, unitPrice: 10, subtotal: 10, ...STAFF_STAMP },
    { id: "li-2", productId: "p-2", qty: 1, unitPrice: 0, subtotal: 0 },
  ],
});
const stampedInvoice = () => ({
  id: "inv-1",
  status: "SENT",
  total: 10,
  taxAmount: 0,
  items: [{ id: "ii-1", productId: "p-1", qty: 1, unitPrice: 10, subtotal: 10, ...STAFF_STAMP }],
  payments: [],
});

describe("row 510: buyer reads omit the override stamp (allowlist)", () => {
  it("the column helper names exactly the four schema columns", () => {
    expect([...OVERRIDE_STAMP_COLUMNS].sort()).toEqual(Object.keys(STAMP).sort());
    expect(Object.keys(OVERRIDE_STAMP_SELECT).sort()).toEqual(Object.keys(STAMP).sort());
  });

  it("no buyer allowlist names a stamp column, nor the resolved name of the overriding user", () => {
    for (const list of [
      CUSTOMER_ORDER_FIELDS,
      CUSTOMER_ORDER_ITEM_FIELDS,
      CUSTOMER_INVOICE_FIELDS,
      CUSTOMER_INVOICE_ITEM_FIELDS,
    ])
      for (const col of [...OVERRIDE_STAMP_COLUMNS, "restrictionOverrideByName"])
        expect(list as readonly string[]).not.toContain(col);
  });

  it("toCustomerOrder and pickCustomerOrderFields strip all four from every line", () => {
    for (const out of [toCustomerOrder(stampedOrder()), pickCustomerOrderFields(stampedOrder())]) {
      expect(out.lineItems).toHaveLength(2);
      for (const l of out.lineItems) expect(stampKeys(l)).toEqual([]);
      expect(out.lineItems[0]).toMatchObject({ id: "li-1", productId: "p-1" }); // the line itself survives
    }
  });

  it("pickCustomerInvoiceFields strips all four from every line (detail and list shapes)", () => {
    for (const out of [
      pickCustomerInvoiceFields(stampedInvoice()),
      pickCustomerInvoiceFields(stampedInvoice(), { confirmedPaymentsOnly: true }),
    ]) {
      expect(out.items).toHaveLength(1);
      expect(stampKeys(out.items[0])).toEqual([]);
      expect(out.items[0]).toMatchObject({ id: "ii-1" });
    }
  });

  it("mutation proof: the same fixture DOES carry the stamp before projection", () => {
    expect(stampKeys(stampedOrder().lineItems[0])).toHaveLength(5); // the four columns + the resolved name
    expect(stampKeys(stampedInvoice().items[0])).toHaveLength(5);
  });
});

describe("row 510: the column helper", () => {
  it("withoutOverrideStamp removes the keys (and a resolved name) and keeps the rest; the source is not mutated", () => {
    const src = { id: "x", qty: 2, ...STAFF_STAMP };
    const out = withoutOverrideStamp(src);
    expect(out).toEqual({ id: "x", qty: 2 });
    expect(stampKeys(src)).toHaveLength(5);
  });

  it("carryOverrideStamp copies the stamp as stored, never aliasing the rule list; a missing stamp reads cleared", () => {
    const src = { id: "x", ...STAMP };
    const carried = carryOverrideStamp(src);
    expect(carried).toEqual(STAMP);
    expect(carried.restrictionOverrideRuleIds).not.toBe(src.restrictionOverrideRuleIds);
    expect(carryOverrideStamp({})).toEqual(CLEARED_OVERRIDE_STAMP);
    expect(carryOverrideStamp(null)).toEqual(CLEARED_OVERRIDE_STAMP);
  });

  it("hasOverrideStamp keys on the timestamp; the cleared stamp has none", () => {
    expect(hasOverrideStamp(STAMP)).toBe(true);
    expect(hasOverrideStamp(CLEARED_OVERRIDE_STAMP)).toBe(false);
    expect(hasOverrideStamp(null)).toBe(false);
    expect(Object.isFrozen(CLEARED_OVERRIDE_STAMP)).toBe(true);
  });
});

describe("row 510: the invoice PDF model never carries the stamp", () => {
  it("a stamped invoice line reaches the template without restrictionOverride*", async () => {
    mockCapturedInvoice = null;
    const prisma = createMockPrisma();
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      tenantId: "tenant-1",
      invoiceNumber: "INV-1",
      status: "SENT",
      issueDate: new Date("2026-10-01T00:00:00.000Z"),
      dueDate: new Date("2026-10-31T00:00:00.000Z"),
      subtotal: 10,
      taxAmount: 0,
      discount: 0,
      shippingFee: 0,
      total: 10,
      depositPercent: null,
      pdfUrl: "invoice-pdfs/inv-1.pdf",
      orderId: null,
      customer: {
        id: "c-1",
        businessName: "Acme Buyer",
        contactName: null,
        phone: null,
        addresses: [],
      },
      items: [
        {
          id: "ii-1",
          description: "Widget",
          qty: 1,
          unitPrice: 10,
          subtotal: 10,
          ...STAFF_STAMP,
          product: { id: "p-1", name: "Widget", barcode: null, sku: null, unitSku: null },
        },
      ],
      payments: [],
      order: null,
    } as any);
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
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
      ],
    }).compile();

    await module.get(InvoicePdfService).generateAndUpload("inv-1");

    expect(mockCapturedInvoice?.items).toHaveLength(1);
    expect(mockCapturedInvoice.items[0]).toMatchObject({ id: "ii-1", description: "Widget" });
    expect(stampKeys(mockCapturedInvoice.items[0])).toEqual([]);
  });
});

describe("row 510: document templates and models never read the stamp (source pin)", () => {
  const SRC = path.resolve(__dirname, "..");
  const DOCUMENT_FILES = [
    "invoices/invoice-pdf-template.tsx",
    "invoices/invoice-pdf-item.ts",
    "orders/packing-slip-data.ts",
    "orders/packing-slip-pdf-template.tsx",
    "documents/receipt-model.ts",
    "documents/render-order-receipt.ts",
  ];

  it.each(DOCUMENT_FILES)("%s never spells restrictionOverride", (rel) => {
    const file = path.join(SRC, rel);
    expect(fs.existsSync(file)).toBe(true); // a rename must update this list, never empty it
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/restrictionOverride/);
  });
});
