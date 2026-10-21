/**
 * Row 588 (SA-814c confirmation 3, P2): `duplicate()` re-takes the VERIFIED inferred rate, or else the tenant's
 * configured rate, instead of copying a legacy 0 or a 4-dp-rounded line rate. The copy re-totals from its own
 * lines, so a copied 0 is a $0-tax copy and a copied 0.0888 is 8.88% on an 8.875% tenant. Asserts stored
 * values (line rate, tax, total), never message text.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../common/msrp", () => ({ loadMsrpMap: jest.fn().mockResolvedValue(new Map()) }));

import { Test } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { sumInvoiceTotalsStrict } from "../common/money-invariants.util";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

const line = (over: Record<string, unknown> = {}) => ({
  id: "li-1",
  description: "Widget",
  productId: "p1",
  qty: 10,
  unitPrice: 100,
  discount: 0,
  taxRate: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  subtotal: 1000,
  promoFreeUnits: null,
  msrp: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  categoryTaxAmount: 0,
  ...over,
});
const source = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  orderId: null,
  customerId: "cust-1",
  invoiceNumber: "INV-0001",
  status: InvoiceStatus.SENT,
  subtotal: 1000,
  taxAmount: 88.75,
  discount: 0,
  shippingFee: 0,
  total: 1088.75,
  notes: null,
  terms: null,
  paymentTermsLabel: null,
  referenceNumber: null,
  subject: null,
  items: [line()],
  ...over,
});

describe("InvoicesService.duplicate — the copy's tax rate (row 588)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const created = () => prisma.invoice.create.mock.calls[0][0].data;
  const tenantRate = (percent: string | null) =>
    prisma.systemConfig.findFirst.mockResolvedValue(percent == null ? null : { value: percent });

  beforeEach(async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    jest.setSystemTime(new Date("2026-10-21T15:00:00.000Z"));
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(false) };
        if (token === RegulatedLedgerService) return { writeSaleEntries: jest.fn() };
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.invoice.create.mockResolvedValue({ id: "inv-2", items: [], customer: {}, payments: [] });
    tenantRate("8.875");
  });

  afterEach(() => jest.useRealTimers());

  it("a legacy rounded rate (0.0888) takes the tenant's 8.875%: 0.08875, tax 88.75 (master copies 0.0888 -> 88.80)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      source({ items: [line({ taxRate: 0.0888 })], taxAmount: 88.8, total: 1088.8 }),
    );
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0.08875);
    expect(created().taxAmount).toBe(88.75);
    expect(created().total).toBe(1088.75);
  });

  it("a legacy 0 whose header carries a verifiable flat rate takes that inferred rate (master copies 0 -> $0 tax)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(source({ taxAmount: 75, total: 1075 }));
    tenantRate("9"); // the verified inference wins over the tenant rate
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0.075);
    expect(created().taxAmount).toBe(75);
    expect(created().total).toBe(1075);
  });

  it("a legacy 0 whose rate cannot be verified takes the tenant rate", async () => {
    // $7.33 on $100,000 is not a flat rate to the cent at any 6-dp rate
    prisma.invoice.findUnique.mockResolvedValue(
      source({
        subtotal: 100000,
        taxAmount: 7.33,
        total: 100007.33,
        items: [line({ qty: 1000, subtotal: 100000 })],
      }),
    );
    tenantRate("8.875");
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0.08875);
  });

  it("SA-833 (b): the copy's stored totals equal a fresh create at the stamped rates (the one builder, sumInvoiceTotalsStrict)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      source({
        subtotal: 1234.56,
        taxAmount: 109.57,
        total: 1344.13,
        items: [line({ qty: 1, unitPrice: 1234.56, subtotal: 1234.56 })],
      }),
    );
    await service.duplicate("inv-1");
    const data = created();
    const lines = data.items.create;
    // 1234.56 x 0.08875 (the tenant's rate, the inference's preferred rate) = 109.5672 -> 109.57: it reproduces the tax
    expect(Number(lines[0].taxRate)).toBe(0.08875);
    const fresh = sumInvoiceTotalsStrict(lines, {
      discount: data.discount,
      shipping: data.shippingFee,
      isTaxExempt: false,
    });
    expect({ subtotal: data.subtotal, tax: data.taxAmount, total: data.total }).toEqual({
      subtotal: fresh.subtotal,
      tax: fresh.tax,
      total: fresh.total,
    });
    expect(data.taxAmount).toBe(109.57);
  });

  it("a deliberate per-line rate (not the tenant's rate cut to 4 dp) is copied as it is", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      source({ items: [line({ taxRate: 0.0625 })], taxAmount: 62.5, total: 1062.5 }),
    );
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0.0625);
    expect(created().taxAmount).toBe(62.5);
  });

  it("a correct rate that already equals the tenant's is copied unchanged", async () => {
    prisma.invoice.findUnique.mockResolvedValue(source({ items: [line({ taxRate: 0.08875 })] }));
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0.08875);
    expect(created().taxAmount).toBe(88.75);
  });

  it("lead ruling (review): an untaxed source (no tax, all goods at 0) copied for a CURRENTLY TAXABLE customer takes the tenant rate", async () => {
    prisma.invoice.findUnique.mockResolvedValue(source({ taxAmount: 0, total: 1000 }));
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0.08875); // master: 0
    expect(created().taxAmount).toBe(88.75);
    expect(created().total).toBe(1088.75);
  });

  it("an untaxed source copied for a customer who is EXEMPT now stays $0 (the copy follows the current customer)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: true });
    prisma.invoice.findUnique.mockResolvedValue(source({ taxAmount: 0, total: 1000 }));
    await service.duplicate("inv-1");
    expect(created().taxAmount).toBe(0);
    expect(created().total).toBe(1000);
  });

  it("an untaxed source for a tenant with no configured rate stays untaxed: no rate is invented", async () => {
    prisma.invoice.findUnique.mockResolvedValue(source({ taxAmount: 0, total: 1000 }));
    tenantRate(null);
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0);
    expect(created().taxAmount).toBe(0);
  });

  it("the tenant rate is the preferred rate of the inference: a legacy 0 whose tax it reproduces takes the TENANT's rate", async () => {
    // 1000 x 0.088751 = 88.751 -> 88.75 = the stored tax; the bare inference would say 0.08875
    prisma.invoice.findUnique.mockResolvedValue(source());
    tenantRate("8.8751");
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0.088751);
    expect(created().taxAmount).toBe(88.75);
  });

  it("a tenant with no configured rate leaves an unverifiable legacy 0 as it was", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      source({
        subtotal: 100000,
        taxAmount: 7.33,
        total: 100007.33,
        items: [line({ qty: 1000, subtotal: 100000 })],
      }),
    );
    tenantRate(null);
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0);
  });

  it("an exempt customer's copy stays $0 regular tax whatever the source lines carry", async () => {
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: true });
    prisma.invoice.findUnique.mockResolvedValue(
      source({ items: [line({ taxRate: 0.0888 })], taxAmount: 88.8, total: 1088.8 }),
    );
    await service.duplicate("inv-1");
    expect(created().taxAmount).toBe(0);
    expect(created().total).toBe(1000);
  });

  it("SA-816 (d)2 / MUST-C: a stored non-finite levy on the source is refused 400 MONEY_INVARIANT before any rate is inferred", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      source({ items: [line({ categoryTaxAmount: "NaN" })] }),
    );
    await expect(service.duplicate("inv-1")).rejects.toMatchObject({
      status: 400,
      response: { code: "MONEY_INVARIANT" },
    });
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it("the NSF fee line is never stamped with a rate", async () => {
    prisma.invoice.findUnique.mockResolvedValue(
      source({
        subtotal: 1025,
        taxAmount: 88.75,
        total: 1113.75,
        items: [
          line({ taxRate: 0.0888 }),
          line({
            id: "li-2",
            description: "NSF fee",
            productId: null,
            qty: 1,
            unitPrice: 25,
            subtotal: 25,
            taxRate: 0,
            systemKind: "NSF_FEE",
          }),
        ],
      }),
    );
    await service.duplicate("inv-1");
    expect(Number(created().items.create[0].taxRate)).toBe(0.08875);
    expect(Number(created().items.create[1].taxRate)).toBe(0);
  });
});
