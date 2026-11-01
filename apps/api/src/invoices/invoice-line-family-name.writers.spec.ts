import { readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { sendReminder } from "./invoice-reminder-email";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { buildManualInvoiceLines } from "./manual-invoice-lines";
import { sortInvoiceLines } from "./invoice-line-order";
import { buildEditedLines, matchEditLines, type StoredEditRow } from "./invoice-edit-plan";
import {
  displayLineDescription,
  lineProductName,
  withFamilyNames,
  LINE_NAME_PRODUCT_SELECT,
  ORDER_LINE_PRODUCT_SELECT,
} from "./invoice-line-name";
import { SEND_SNAPSHOT_INCLUDE } from "./invoice-send-snapshot";
import { EstimatesService } from "../estimates/estimates.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NO_PRICE_RIGHTS } from "../common/testing/no-rights-actor";

jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/msrp", () => ({ loadMsrpMap: jest.fn().mockResolvedValue(new Map()) }));
jest.mock("../auth/permissions/price-edit", () => ({
  priceEditAllowedFor: jest.fn().mockResolvedValue(true),
}));

/**
 * Owner bug (2026-11-01), the WRITERS beyond the order copy: every place that creates an invoice line from a product
 * stores "<Family> - <Variant>", and one that copies a line keeps a typed-over description as typed. The read side and
 * the order copy are pinned in invoice-line-family-name.spec.ts.
 */
const FAMILY = "Acme Family";
const COMPOSED = `${FAMILY} - Classic`;
const variantRow = {
  id: "p-variant",
  name: "Classic",
  variantName: "Classic",
  parentProductId: "p-family",
  parent: { name: FAMILY },
  kind: "SIMPLE",
  unitsPerBox: 0,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
};
const soloRow = {
  ...variantRow,
  id: "p-solo",
  name: "Widget",
  variantName: null,
  parentProductId: null,
  parent: null,
};

describe("the shared rule (invoice-line-name.ts)", () => {
  it("lineProductName composes a variant and leaves a standalone product alone", () => {
    expect(lineProductName(variantRow)).toBe(COMPOSED);
    expect(lineProductName(soloRow)).toBe("Widget");
  });

  it("displayLineDescription composes ONLY a stored description that is still the bare name or variant label", () => {
    expect(displayLineDescription("Classic", variantRow)).toBe(COMPOSED);
    expect(displayLineDescription("  classic ", variantRow)).toBe(COMPOSED);
    expect(displayLineDescription("Classic, case of 12", variantRow)).toBe("Classic, case of 12");
    expect(displayLineDescription(COMPOSED, variantRow)).toBe(COMPOSED);
    expect(displayLineDescription("Widget", soloRow)).toBe("Widget");
    expect(displayLineDescription("Classic", null)).toBe("Classic");
    expect(displayLineDescription("Classic", { ...variantRow, parent: null })).toBe("Classic");
  });

  it("withFamilyNames returns a NEW array and never mutates the stored rows (the send fingerprint hashes them)", () => {
    const rows = [{ id: "a", description: "Classic", product: variantRow }];
    const out = withFamilyNames(rows);
    expect(out).not.toBe(rows);
    expect(out[0].description).toBe(COMPOSED);
    expect(rows[0].description).toBe("Classic");
  });

  it("the select asks for the family's name, not for the whole parent row", () => {
    expect(LINE_NAME_PRODUCT_SELECT).toEqual({
      name: true,
      variantName: true,
      parentProductId: true,
      parent: { select: { name: true } },
    });
  });

  it("the issuing snapshot's product read carries the family fields (one read feeds the PDF, the email and the fingerprint)", () => {
    expect(SEND_SNAPSHOT_INCLUDE.items.include.product.select).toMatchObject(
      LINE_NAME_PRODUCT_SELECT,
    );
  });

  it("SA-1058 order: a variant line sorts under its family by the name the reader sees", () => {
    const lines = withFamilyNames([
      { id: "1", description: "Zebra Co", productId: "p", product: soloRow },
      { id: "2", description: "Classic", productId: "p-variant", product: variantRow },
      { id: "3", description: "Acme Family - Zesty", productId: "p-z", product: undefined },
    ]);
    expect(sortInvoiceLines(lines).map((l) => l.description)).toEqual([
      COMPOSED,
      "Acme Family - Zesty",
      "Zebra Co",
    ]);
  });
});

describe("manual / estimate-converted / recurring lines (C5: buildManualInvoiceLines)", () => {
  const build = (description: string, productId: string | undefined) =>
    buildManualInvoiceLines(
      [{ description, productId, qty: 2, unitPrice: 10 }] as any,
      {
        productMap: new Map<string, any>([
          ["p-variant", variantRow],
          ["p-solo", soloRow],
        ]),
        categoryMap: new Map(),
        tenantId: "t1",
        role: "OPERATOR",
        clampFreeUnits: () => 0,
      } as any,
    );

  it("a line that names a variant but carries the bare label is stored composed; money unchanged", () => {
    const { itemsData, subtotal } = build("Classic", "p-variant");
    expect(itemsData[0].description).toBe(COMPOSED);
    expect([itemsData[0].qty, itemsData[0].unitPrice, itemsData[0].subtotal, subtotal]).toEqual([
      2, 10, 20, 20,
    ]);
  });

  it("a typed-over description, a standalone product and a no-product line are stored as sent", () => {
    expect(build("Classic gift box", "p-variant").itemsData[0].description).toBe(
      "Classic gift box",
    );
    expect(build("Widget", "p-solo").itemsData[0].description).toBe("Widget");
    expect(build("Delivery", undefined).itemsData[0].description).toBe("Delivery");
  });
});

describe("InvoicesService.duplicate copies a NEW line", () => {
  it("a source line still holding the bare variant label is copied composed; a typed-over one is kept", async () => {
    const prisma = createMockPrisma();
    const mod = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        if (token === RegulatedLedgerService)
          return { writeSaleEntries: jest.fn().mockResolvedValue(undefined) };
        return new Proxy({} as Record<string | symbol, jest.Mock>, {
          get: (t, k) =>
            k === "then" || typeof k === "symbol"
              ? undefined
              : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
        });
      })
      .compile();
    const service = mod.get(InvoicesService);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.create.mockResolvedValue({ id: "inv-2", items: [], customer: {}, payments: [] });
    const line = (id: string, description: string, product: any) => ({
      id,
      description,
      productId: product.id,
      qty: 2,
      unitPrice: 10,
      discount: 0,
      taxRate: 0,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      subtotal: 20,
      promoFreeUnits: null,
      msrp: null,
      trackedCategoryId: null,
      trackedSubcategoryId: null,
      categoryTaxAmount: 0,
      product,
    });
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      orderId: null,
      customerId: "cust-1",
      invoiceNumber: "INV-0001",
      status: InvoiceStatus.SENT,
      subtotal: 60,
      taxAmount: 0,
      discount: 0,
      shippingFee: 0,
      total: 60,
      notes: null,
      terms: null,
      paymentTermsLabel: null,
      referenceNumber: null,
      subject: null,
      items: [
        line("a", "Classic", variantRow),
        line("b", "Classic gift box", variantRow),
        line("c", "Widget", soloRow),
      ],
    });
    await service.duplicate("inv-1");
    const lines = prisma.invoice.create.mock.calls[0][0].data.items.create;
    expect(lines.map((l: any) => l.description)).toEqual([COMPOSED, "Classic gift box", "Widget"]);
    expect(lines.map((l: any) => [l.qty, l.unitPrice, l.subtotal])).toEqual([
      [2, 10, 20],
      [2, 10, 20],
      [2, 10, 20],
    ]);
    // and the source read asks for the family
    const arg = prisma.invoice.findUnique.mock.calls[0][0];
    expect(arg.include.items.include.product.select).toEqual(LINE_NAME_PRODUCT_SELECT);
  });
});

describe("EstimatesService.create stores the composed name for a catalog line", () => {
  it("a variant line sent without a description is stored '<Family> - <Variant>'", async () => {
    const prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("EST-1") },
        },
        { provide: RegulatedLedgerService, useValue: { writeSaleEntries: jest.fn() } },
      ],
    }).compile();
    const service = mod.get(EstimatesService);
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.product.findMany.mockResolvedValue([variantRow] as any);
    prisma.estimate.create.mockResolvedValue({ id: "est-1", items: [] } as any);
    await service
      .create(
        {
          customerId: "cust-1",
          items: [{ productId: "p-variant", unitPrice: 10, qty: 2 }],
        } as any,
        NO_PRICE_RIGHTS,
      )
      .catch(() => undefined);
    const call = prisma.estimate.create.mock.calls[0]?.[0];
    expect(call?.data.items.create[0].description).toBe(COMPOSED);
    // the first product read is the tenant guard (`select: { id }`); the line read is the one with an include
    const lineRead = prisma.product.findMany.mock.calls.find((c: any[]) => c[0]?.include);
    expect(lineRead?.[0].include).toEqual({ parent: { select: { name: true } } });
  });
});

describe("PATCH /invoices/:id (edit plan) stores the composed name for a changed variant line", () => {
  const stored = {
    id: "row-1",
    invoiceId: "inv-1",
    productId: "p-variant",
    description: "Classic",
    qty: 12,
    unitPrice: 8,
    discount: 0,
    taxRate: 0,
    subtotal: 96,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    promoFreeUnits: null,
    notes: null,
    orderItemId: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    categoryTaxAmount: 0,
    categoryTaxType: null,
    categoryTaxRate: null,
    categoryPriceIncludesTax: null,
  } as StoredEditRow;
  const edit = (description: string) => {
    const items = [
      { id: "row-1", productId: "p-variant", description, qty: 6, unitPrice: 8, discount: 0 },
    ];
    return buildEditedLines({
      items,
      stored: [stored],
      matches: matchEditLines(items as any, [stored]),
      productMap: new Map([["p-variant", variantRow]]),
      categoryMap: new Map(),
      clampFreeUnits: (free: number | undefined) => free ?? 0,
      warn: jest.fn(),
    } as any)[0].data;
  };

  it("a changed line that still carries the bare label is stored composed; the money is the qty change only", () => {
    const data = edit("Classic");
    expect(data.description).toBe(COMPOSED);
    expect([data.qty, data.unitPrice, data.subtotal]).toEqual([6, 8, 48]);
  });

  it("a typed-over description is stored as typed", () => {
    expect(edit("Classic, gift").description).toBe("Classic, gift");
  });
});

describe("EstimatesService.findOne reads a quote line the way the invoice does", () => {
  it("a stored bare variant name reads '<Family> - <Variant>'; money unchanged", async () => {
    const prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: SellingRestrictionsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementAuthority, useValue: { can: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn() } },
        { provide: NumberingService, useValue: {} },
        { provide: RegulatedLedgerService, useValue: {} },
      ],
    }).compile();
    prisma.estimate.findUnique.mockResolvedValue({
      id: "est-1",
      items: [
        {
          id: "e1",
          description: "Classic",
          qty: 2,
          unitPrice: 10,
          subtotal: 20,
          product: variantRow,
        },
      ],
    } as any);
    const out: any = await mod.get(EstimatesService).findOne("est-1");
    expect(out.items[0].description).toBe(COMPOSED);
    expect([out.items[0].qty, out.items[0].unitPrice, out.items[0].subtotal]).toEqual([2, 10, 20]);
    expect(
      prisma.estimate.findUnique.mock.calls[0][0].include.items.include.product.select,
    ).toMatchObject(LINE_NAME_PRODUCT_SELECT);
  });
});

describe("every loader that feeds a name writer or reader asks for the family", () => {
  it("the reminder email reads each line's family (it builds the same item table as the invoice email)", async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    await sendReminder(
      { prisma: { forTenant: () => ({ invoice: { findUnique } }) } } as any,
      "inv-1",
    ).catch(() => undefined);
    expect(findUnique.mock.calls[0][0].include.items.include.product.select).toMatchObject(
      LINE_NAME_PRODUCT_SELECT,
    );
  });

  it("the order-line product read carries the names beside the pack and category facts it always read", () => {
    expect(ORDER_LINE_PRODUCT_SELECT).toEqual({
      ...LINE_NAME_PRODUCT_SELECT,
      unitsPerBox: true,
      trackedCategoryId: true,
      trackedSubcategoryId: true,
    });
  });

  const read = (f: string) => readFileSync(join(__dirname, f), "utf8");
  it("pin: all six order reads in invoices.service use ORDER_LINE_PRODUCT_SELECT, none a hand-typed select", () => {
    const service = read("invoices.service.ts");
    expect(service.match(/product: \{ select: ORDER_LINE_PRODUCT_SELECT \}/g)).toHaveLength(6);
    expect(service).not.toMatch(/product: \{\s*select: \{\s*name: true,\s*unitsPerBox: true,/);
  });

  it("pin: the manual-line and edit-plan product loaders select the family fields", () => {
    expect(read("manual-invoice-context.ts")).toContain("...LINE_NAME_PRODUCT_SELECT");
    expect(read("invoice-edit-plan.ts")).toContain("...LINE_NAME_PRODUCT_SELECT");
  });
});
