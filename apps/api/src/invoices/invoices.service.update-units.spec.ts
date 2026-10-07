/**
 * VU-4a / B1218 (lead ruling D3) — a DRAFT invoice PATCH accepts unit lines through the SAME two
 * calls create() uses (`resolveLineUnits` -> `buildInvoiceUnitLine`). A SENT invoice, or a draft
 * linked to an order (the back-sync would write the unit onto the order line), stays refused with
 * the unchanged 400. Dedicated file: invoices.service.spec.ts sits at its size-ratchet ceiling.
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { computeLineSubtotal } from "@routeflow/pricing";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { createMockPrisma } from "../testing/prisma-mock";

/** Any collaborator method resolves undefined; `then`/symbols stay undefined (a thenable mock hangs `await`). */
const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

const REFUSAL = "Selling by a unit can't be set on an invoice edit yet.";

describe("InvoicesService.update — a DRAFT invoice edit sells a line by a unit (VU-4a, D3)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let hasFlag: jest.Mock;
  const scopedUnits = { findMany: jest.fn() };

  // A 24-piece box; a Case of 12 pieces at 24.00.
  const PRODUCT = {
    id: "p1",
    unit: "Box",
    unitsPerBox: 24,
    trackedCategoryId: null as string | null,
    trackedSubcategoryId: null as string | null,
  };
  const ladder = [
    {
      productId: "p1",
      label: "Case",
      factorToBase: 12,
      price: "24.00",
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
      sortOrder: 0,
    },
  ];
  const draft = (over: Record<string, unknown> = {}) => ({
    id: "inv-1",
    orderId: null,
    deliveryBatchId: null,
    customerId: "cust-1",
    invoiceNumber: "INV-2026-0099",
    status: InvoiceStatus.DRAFT,
    subtotal: 0,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 0,
    notes: null,
    terms: null,
    dueDate: null,
    issueDate: new Date(),
    items: [],
    ...over,
  });
  const caseLine = (over: Record<string, unknown> = {}) => ({
    description: "Widget",
    productId: "p1",
    qty: 3,
    unitPrice: 24,
    unitLabel: "Case",
    ...over,
  });
  /** A stored Case row: 3 Cases x 12 pcs @ 24.00. */
  const storedCase = (over: Record<string, unknown> = {}) => ({
    id: "row-1",
    invoiceId: "inv-1",
    productId: "p1",
    description: "Widget",
    qty: 36,
    boxes: 3,
    pieces: 0,
    unitsPerBox: 12,
    unitLabel: "Case",
    unitPrice: 24,
    discount: 0,
    taxRate: 0,
    subtotal: 72,
    categoryTaxAmount: 0,
    promoFreeUnits: null,
    orderItemId: null,
    notes: null,
    ...over,
  });
  const update = (items: unknown[], dto: Record<string, unknown> = {}) =>
    service.update("inv-1", { items, ...dto } as never);
  const written = () => prisma.invoice.update.mock.calls[0][0].data.items.create as any[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    hasFlag = jest.fn(async (_t: string, flag: string) => flag === "flag.units_v1");
    const module = await Test.createTestingModule({ providers: [InvoicesService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === EntitlementsService) return { hasFlag };
        if (token === EntitlementAuthority) return { can: hasFlag };
        return autoMock();
      })
      .compile();
    service = module.get(InvoicesService);
    prisma.invoice.findUnique.mockResolvedValue(draft());
    prisma.invoice.findFirst.mockResolvedValue({ items: [] }); // the units guard reads the parent
    prisma.invoice.update.mockResolvedValue(draft());
    prisma.invoice.create.mockResolvedValue({ id: "inv-1", items: [], customer: {}, payments: [] });
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      isTaxExempt: false,
      deletedAt: null,
    });
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false });
    prisma.product.findMany.mockResolvedValue([PRODUCT]);
    scopedUnits.findMany.mockReset().mockResolvedValue(ladder);
    (prisma.forTenant as jest.Mock).mockReturnValue({
      ...(prisma.forTenant as jest.Mock)(),
      productUnit: scopedUnits,
    });
  });

  it("A1: a DRAFT (no order) PATCH adds Case x3 @24.00 and stores EXACTLY what create() stores for the same payload", async () => {
    await update([caseLine()]);
    const [row] = written();
    expect(row).toMatchObject({
      unitLabel: "Case",
      boxes: 3,
      pieces: 0,
      qty: 36,
      unitsPerBox: 12,
      unitPrice: 24,
      subtotal: 72,
    });
    // same fake DB, same payload through create(): field for field
    await service.create({ customerId: "cust-1", items: [caseLine()] } as never);
    const created = prisma.invoice.create.mock.calls[0][0].data.items.create[0];
    expect(row).toEqual(created);
    expect(prisma.invoice.update.mock.calls[0][0].data.subtotal).toBe(72);
  });

  it("A2: an unknown unit is the same 400 UNIT_NOT_OFFERED create() throws", async () => {
    const bad = caseLine({ unitLabel: "Bogus" });
    const fromCreate = await service
      .create({ customerId: "cust-1", items: [bad] } as never)
      .catch((e) => e);
    const fromUpdate = await update([bad]).catch((e) => e);
    expect(fromCreate).toBeInstanceOf(BadRequestException);
    expect(fromUpdate).toBeInstanceOf(BadRequestException);
    expect(fromUpdate.getResponse()).toEqual(fromCreate.getResponse());
    expect(fromUpdate.getResponse().code).toBe("UNIT_NOT_OFFERED");
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("A3: a SENT invoice + a unit line keeps the exact unchanged 400; SENT without a unit keeps its own", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draft({ status: InvoiceStatus.SENT }));
    await expect(update([caseLine()])).rejects.toThrow(REFUSAL);
    await expect(update([{ ...caseLine(), unitLabel: undefined, qty: 1 }])).rejects.toThrow(
      "Only DRAFT invoices can be edited",
    );
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("A4: an order-linked DRAFT + a unit line is the same 400 (the back-sync would write the unit onto the order)", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draft({ orderId: "ord-1" }));
    await expect(update([caseLine()])).rejects.toThrow(REFUSAL);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("A4: an order-linked draft that already holds a unit row is still refused by the rewrite guard; an unreadable parent still fails closed", async () => {
    // deliveryBatchId set: the "mirrors an order" lock is not what this test is about
    prisma.invoice.findUnique.mockResolvedValue(
      draft({ orderId: "ord-1", deliveryBatchId: "b-1" }),
    );
    prisma.invoice.findFirst.mockResolvedValue({ items: [{ unitLabel: "Case" }] });
    prisma.order.findFirst.mockResolvedValue({ lineItems: [] });
    await expect(
      update([{ productId: "p1", description: "W", qty: 1, unitPrice: 5 }]),
    ).rejects.toBeInstanceOf(ConflictException);
    prisma.invoice.findFirst.mockResolvedValue(null);
    await expect(
      update([{ productId: "p1", description: "W", qty: 1, unitPrice: 5 }]),
    ).rejects.toMatchObject({ response: { code: "UNIT_AWARE_LINE_UNVERIFIABLE" } });
  });

  it("A4: an order-LESS draft that already holds a unit row may be edited (the stored Case row is kept verbatim)", async () => {
    prisma.invoice.findFirst.mockResolvedValue({ items: [{ unitLabel: "Case" }] });
    prisma.invoiceItem.findMany.mockResolvedValue([storedCase()]);
    await update([caseLine({ id: "row-1" })], { notes: "n" });
    expect(prisma.invoice.update).toHaveBeenCalled();
    expect(written()).toEqual([]); // no create: the row stays in place
  });

  it("A5: a stored Case row re-sent as Box (2 boxes + 3 pcs) becomes a PACK line at the LIVE pack, prorated; the Case label is cleared", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([storedCase()]);
    await update([
      {
        id: "row-1",
        productId: "p1",
        description: "Widget",
        qty: 51,
        boxes: 2,
        pieces: 3,
        unitPrice: 48,
      },
    ]);
    const patch = prisma.invoiceItem.update.mock.calls[0][0];
    expect(patch.where).toEqual({ id: "row-1" });
    expect(patch.data).toMatchObject({
      unitLabel: null,
      unitsPerBox: 24,
      boxes: 2,
      pieces: 3,
      qty: 51,
      subtotal: computeLineSubtotal({
        unitPrice: 48,
        qty: 51,
        boxes: 2,
        pieces: 3,
        unitsPerBox: 24,
      }),
    });
  });

  it("A5 (reverse): a stored pack row re-sent as Case x3 becomes a unit line in place", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([
      storedCase({
        unitLabel: null,
        unitsPerBox: 24,
        boxes: 2,
        pieces: 3,
        qty: 51,
        unitPrice: 48,
        subtotal: 98,
      }),
    ]);
    await update([caseLine({ id: "row-1" })]);
    const patch = prisma.invoiceItem.update.mock.calls[0][0];
    expect(patch.data).toMatchObject({
      unitLabel: "Case",
      boxes: 3,
      pieces: 0,
      qty: 36,
      unitsPerBox: 12,
      unitPrice: 24,
      subtotal: 72,
    });
  });

  it("A6: a unit row re-sent verbatim is untouched: no row write, totals unchanged", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([storedCase()]);
    await update([caseLine({ id: "row-1" })]);
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.deleteMany.mock.calls[0][0].where.id).toEqual({ notIn: ["row-1"] });
    expect(prisma.invoice.update.mock.calls[0][0].data.subtotal).toBe(72);
  });

  it("A6 (id-less): the cached-client fallback matches a stored Case row on its unit too, never a pack row", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([storedCase()]);
    await update([caseLine()]);
    expect(prisma.invoiceItem.update).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
  });

  it("A7: unit line + line discount + taxable + invoice discount == create() of the same payload; an over-discount is still refused", async () => {
    const item = caseLine({ discount: 5, taxRate: 0.1 });
    await update([item], { discount: 2 });
    const u = prisma.invoice.update.mock.calls[0][0].data;
    await service.create({ customerId: "cust-1", items: [item], discount: 2 } as never);
    const c = prisma.invoice.create.mock.calls[0][0].data;
    expect(u.items.create[0]).toEqual(c.items.create[0]);
    expect({ s: u.subtotal, t: u.taxAmount, total: u.total }).toEqual({
      s: c.subtotal,
      t: c.taxAmount,
      total: c.total,
    });
    expect(u.subtotal).toBe(67);
    prisma.invoice.update.mockClear();
    await expect(update([caseLine({ discount: 500 })])).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("A8: flag off is refused like create() (403), nothing written", async () => {
    hasFlag.mockResolvedValue(false);
    await expect(update([caseLine()])).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("A8: a product with no ladder row for the label is UNIT_NOT_OFFERED like create()", async () => {
    scopedUnits.findMany.mockResolvedValue([]);
    await expect(update([caseLine()])).rejects.toMatchObject({
      response: { code: "UNIT_NOT_OFFERED" },
    });
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("A9: a regulated per-unit levy on a unit line uses the BASE piece count (qty), same as create()", async () => {
    prisma.product.findMany.mockResolvedValue([{ ...PRODUCT, trackedCategoryId: "cat-1" }]);
    prisma.trackedCategory.findMany.mockResolvedValue([
      { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: 0.5, priceIncludesTax: false },
    ]);
    await update([caseLine()]);
    const [row] = written();
    expect(row.categoryTaxAmount).toBe(18); // 0.50 x 36 pieces, never x 3 Cases
    await service.create({ customerId: "cust-1", items: [caseLine()] } as never);
    expect(row).toEqual(prisma.invoice.create.mock.calls[0][0].data.items.create[0]);
  });

  describe("factor snapshot: the ladder Case factor changes 12 -> 10 after the draft was saved", () => {
    beforeEach(() => {
      scopedUnits.findMany.mockResolvedValue([{ ...ladder[0], factorToBase: 10 }]);
    });

    it("(a) an edited count on the existing Case row keeps ITS factor 12 (the order path's rule 2)", async () => {
      prisma.invoiceItem.findMany.mockResolvedValue([storedCase()]);
      await update([caseLine({ id: "row-1", qty: 5 })]);
      expect(prisma.invoiceItem.update.mock.calls[0][0].data).toMatchObject({
        unitLabel: "Case",
        unitsPerBox: 12,
        boxes: 5,
        qty: 60,
        subtotal: 120,
      });
    });

    it("(b) a newly added Case line uses the live ladder factor 10", async () => {
      prisma.invoiceItem.findMany.mockResolvedValue([storedCase()]);
      await update([caseLine({ id: "row-1" }), caseLine({ qty: 2 })]);
      expect(prisma.invoiceItem.update).not.toHaveBeenCalled(); // row-1 untouched
      expect(written()[0]).toMatchObject({ unitsPerBox: 10, boxes: 2, qty: 20, subtotal: 48 });
    });

    it("(c) a pack row re-sent as Case uses the live factor 10", async () => {
      prisma.invoiceItem.findMany.mockResolvedValue([
        storedCase({ unitLabel: null, unitsPerBox: 24, boxes: 2, pieces: 3, qty: 51 }),
      ]);
      await update([caseLine({ id: "row-1" })]);
      expect(prisma.invoiceItem.update.mock.calls[0][0].data).toMatchObject({
        unitLabel: "Case",
        unitsPerBox: 10,
        boxes: 3,
        qty: 30,
      });
    });
  });

  it("a pack-only PATCH reads no ladder and never asks for flag.units_v1", async () => {
    await update([{ productId: "p1", description: "W", qty: 2, unitPrice: 5 }]);
    expect(scopedUnits.findMany).not.toHaveBeenCalled();
    expect(hasFlag).not.toHaveBeenCalledWith(expect.anything(), "flag.units_v1");
  });
});
