/**
 * H3b — InvoicesService.create / update judge a typed price against the customer's TIER price and stamp
 * the line (priceType, originalPrice, overrideReason, overriddenBy), exactly as POST /orders/sell does.
 * The acting user is the controller's `user.sub`; with none (an internal caller) nothing is judged.
 * Dedicated file: invoices.service.spec.ts sits at its size-ratchet ceiling.
 *
 *  S1 create, pack line: no reason on a special tier -> 400, nothing written
 *  S2 create, pack line: typed list price + reason -> MANUAL + reason + user, $72
 *  S3 create, pack line: the tier price typed -> SPECIAL, no stamp, $60
 *  S4 create without an actor (an internal caller): the sent price, no price columns
 *  S5 create, unit line (Case): the same outcomes off the ladder
 *  S6 update: a changed price needs a reason; the new stamp is written in place
 *  S7 update: a re-sent stored price (qty edit) keeps the stored type, reason and author
 *  S8 the customer's tier comes from CustomerPrice first, else the customer
 */
jest.mock("./invoice-pdf.service", () => ({ InvoicePdfService: class InvoicePdfService {} }));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

const WHY = "A reason is required to change Widget — it's this customer's special price";

describe("InvoicesService — a typed price is judged against the customer's tier price (H3b)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const scopedUnits = { findMany: jest.fn() };

  // list $24, tier-3 $20; a 24-piece box with a Case level (list $24 / tier-3 $20 per Case)
  const PRODUCT = {
    id: "p1",
    name: "Widget",
    unit: "Box",
    unitsPerBox: 24,
    pricePerUnit: "24.00",
    priceTier2: null,
    priceTier3: "20.00",
    priceTier4: null,
    priceTier5: null,
    trackedCategoryId: null as string | null,
    trackedSubcategoryId: null as string | null,
  };
  const LOOSE = { ...PRODUCT, id: "p2", unit: "Each", unitsPerBox: null as number | null };
  const ladder = [
    {
      productId: "p1",
      label: "Case",
      factorToBase: 288,
      price: "24.00",
      priceTier2: null,
      priceTier3: "20.00",
      priceTier4: null,
      priceTier5: null,
      sortOrder: 0,
    },
  ];
  const line = (over: Record<string, unknown> = {}) => ({
    description: "Widget",
    productId: "p2",
    qty: 3,
    unitPrice: 24,
    ...over,
  });
  const caseLine = (over: Record<string, unknown> = {}) =>
    line({ productId: "p1", unitLabel: "Case", ...over });
  const USER = { sub: "user-1" } as JwtPayload;
  const create = (items: unknown[], actor: JwtPayload | undefined = USER) =>
    service.create({ customerId: "cust-1", items } as never, actor);
  const createdRow = () => prisma.invoice.create.mock.calls[0][0].data.items.create[0];

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
  /** A stored MANUAL pack row: 3 x $24 over the $20 tier price, stamped by another user. */
  const stored = (over: Record<string, unknown> = {}) => ({
    id: "row-1",
    invoiceId: "inv-1",
    productId: "p2",
    description: "Widget",
    qty: 3,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitLabel: null,
    unitPrice: 24,
    discount: 0,
    taxRate: 0,
    subtotal: 72,
    categoryTaxAmount: 0,
    promoFreeUnits: null,
    orderItemId: null,
    notes: null,
    priceType: "MANUAL",
    originalPrice: 24,
    overrideReason: "stored reason",
    overriddenBy: "user-0",
    ...over,
  });
  const update = (items: unknown[], actor: JwtPayload | undefined = USER) =>
    service.update("inv-1", { items } as never, actor);

  beforeEach(async () => {
    prisma = createMockPrisma();
    const hasFlag = jest.fn(async (_t: string, flag: string) => flag === "flag.units_v1");
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
    prisma.invoice.findFirst.mockResolvedValue({ items: [] });
    prisma.invoice.update.mockResolvedValue(draft());
    prisma.invoice.create.mockResolvedValue({ id: "inv-1", items: [], customer: {}, payments: [] });
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      isTaxExempt: false,
      deletedAt: null,
    });
    prisma.customer.findFirst.mockResolvedValue({ isTaxExempt: false, pricingTier: 3 });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([PRODUCT, LOOSE]);
    scopedUnits.findMany.mockReset().mockResolvedValue(ladder);
    (prisma.productUnit.findMany as jest.Mock).mockImplementation((args: unknown) =>
      scopedUnits.findMany(args),
    );
    (prisma.forTenant as jest.Mock).mockReturnValue({
      ...(prisma.forTenant as jest.Mock)(),
      productUnit: scopedUnits,
    });
  });

  it("S1: a pack line typed off a special price with no reason is a 400 and nothing is written", async () => {
    const err = await create([line()]).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(WHY);
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it("S2: typed list price + reason is MANUAL with the reason (trimmed) and the user; the total is $72", async () => {
    await create([line({ overrideReason: " agreed at list " })]);
    expect(createdRow()).toMatchObject({
      unitPrice: 24,
      subtotal: 72,
      priceType: "MANUAL",
      originalPrice: 24,
      overrideReason: "agreed at list",
      overriddenBy: "user-1",
    });
    expect(prisma.invoice.create.mock.calls[0][0].data.total).toBe(72);
  });

  it("S3: the tier price typed is SPECIAL with no stamp; the total is $60", async () => {
    await create([line({ unitPrice: 20 })]);
    expect(createdRow()).toMatchObject({
      unitPrice: 20,
      subtotal: 60,
      priceType: "SPECIAL",
      originalPrice: 24,
      overrideReason: null,
      overriddenBy: null,
    });
    expect(prisma.invoice.create.mock.calls[0][0].data.total).toBe(60);
  });

  it("S4: with no actor (recurring invoices, estimate conversion) the sent price is stored and no price column is set", async () => {
    await service.create({ customerId: "cust-1", items: [line()] } as never);
    expect(createdRow()).toMatchObject({ unitPrice: 24, subtotal: 72 });
    expect(createdRow()).not.toHaveProperty("priceType");
    expect(createdRow()).not.toHaveProperty("overriddenBy");
    expect(prisma.customerPrice.findMany).not.toHaveBeenCalled(); // not even a tier read
  });

  it("S5: a Case line is judged off the ladder: no reason 400, a reason MANUAL, the tier unit price SPECIAL", async () => {
    await expect(create([caseLine()])).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.invoice.create).not.toHaveBeenCalled();

    await create([caseLine({ overrideReason: "agreed at list" })]);
    expect(createdRow()).toMatchObject({
      unitLabel: "Case",
      boxes: 3,
      unitPrice: 24,
      subtotal: 72,
      priceType: "MANUAL",
      originalPrice: 24,
      overrideReason: "agreed at list",
      overriddenBy: "user-1",
    });

    prisma.invoice.create.mockClear();
    await create([caseLine({ unitPrice: 20 })]);
    expect(createdRow()).toMatchObject({
      unitPrice: 20,
      subtotal: 60,
      priceType: "SPECIAL",
      overrideReason: null,
      overriddenBy: null,
    });
  });

  it("S6: an edit that CHANGES the price needs a reason; with one the new stamp is written in place", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([stored()]);
    const err = await update([{ ...line(), id: "row-1", unitPrice: 22 }]).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(WHY);
    expect(prisma.invoice.update).not.toHaveBeenCalled();

    await update([{ ...line(), id: "row-1", unitPrice: 22, overrideReason: "new deal" }]);
    expect(prisma.invoiceItem.update.mock.calls[0][0].data).toMatchObject({
      unitPrice: 22,
      subtotal: 66,
      priceType: "DISCOUNTED",
      originalPrice: 24,
      overrideReason: "new deal",
      overriddenBy: "user-1",
    });
  });

  it("S7: an edit that re-sends the stored price (a qty change) keeps the stored type, reason and author", async () => {
    prisma.invoiceItem.findMany.mockResolvedValue([stored()]);
    await update([{ ...line(), id: "row-1", qty: 5 }]);
    expect(prisma.invoiceItem.update.mock.calls[0][0].data).toMatchObject({
      qty: 5,
      unitPrice: 24,
      subtotal: 120,
      priceType: "MANUAL",
      overrideReason: "stored reason",
      overriddenBy: "user-0",
    });
  });

  it("S8: a per-product CustomerPrice tier wins over the customer's default tier", async () => {
    // default tier 3 would make $20 the special price; this product is tier 1 for the customer: list is the tier
    prisma.customerPrice.findMany.mockResolvedValue([{ productId: "p2", pricingTier: 1 }]);
    await create([line({ unitPrice: 20 })]);
    expect(createdRow()).toMatchObject({
      priceType: "DISCOUNTED", // tier 1: below list is a plain override, no reason needed
      originalPrice: 24,
      overrideReason: null,
      overriddenBy: "user-1",
    });
  });
});
