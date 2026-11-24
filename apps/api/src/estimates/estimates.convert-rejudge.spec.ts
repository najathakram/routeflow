/**
 * W-1266 / SA-1182 K2 / SA-1260 section 1 - converting an accepted quote re-judges each product line's
 * QUOTED price against the customer's price TODAY (`decideStaffOverride`, @routeflow/pricing, the rule every
 * other sale path uses). A real override (DISCOUNTED / MANUAL) stamps the invoice line: price type, original
 * price, "Quoted on {estimate number}, accepted on {date}." and the converting user. The billed price never
 * moves (B659). The accept date is the quote's `updatedAt` read at the convert pre-flight, in the tenant's
 * calendar; a repeat accept writes nothing so that date stays the first acceptance (pins A1-A5).
 */
import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EstimatesService } from "./estimates.service";
import { estimateAcceptedOn } from "./estimate-convert-lines";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const ACTOR = {
  sub: "user-convert",
  tenantId: "test-tenant",
  role: "ADMIN",
} as unknown as JwtPayload;
const EST_NO = "EST-2026-0007";

/** list 6.00; tier 2 (a special tier) 5.00; tier 3 (a special tier) 4.50. */
const product = (over: Record<string, unknown> = {}) => ({
  id: "p-1",
  name: "Acme Widget",
  unit: "pack",
  unitsPerBox: null,
  pricePerUnit: 6,
  priceTier2: 5,
  priceTier3: 4.5,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  ...over,
});
const quoteLine = (unitPrice: number, over: Record<string, unknown> = {}) => ({
  id: "el-1",
  description: "Acme Widget",
  productId: "p-1",
  qty: 2,
  unitPrice,
  subtotal: Math.round(unitPrice * 2 * 100) / 100,
  boxes: null,
  pieces: null,
  unitLabel: null,
  unitsPerBox: null,
  ...over,
});

describe("EstimatesService.convertToInvoice - re-judges the quoted price (W-1266)", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const numbering = { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") };
  const ledger = { writeSaleEntries: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    prisma = createMockPrisma();
    numbering.reserveNext.mockClear();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: PrismaService, useValue: prisma },
        {
          provide: EntitlementAuthority,
          inject: [EntitlementsService],
          useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
            can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
          }),
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: NumberingService, useValue: numbering },
        { provide: RegulatedLedgerService, useValue: ledger },
      ],
    }).compile();
    service = mod.get(EstimatesService);
    prisma.estimate.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: "inv-1",
        ...args.data,
        issueDate: new Date("2026-11-24T00:00:00Z"),
        items: (args.data.items.create as any[]).map((c, i) => ({ id: `ii-${i}`, ...c })),
        customer: {},
      }),
    );
  });

  /** Arm the estimate (pre-flight AND in-tx read), the live product, the customer's tier and the tenant zone. */
  const arm = (opts: {
    items: any[];
    tier?: number;
    updatedAt?: Date;
    zone?: string | null;
    status?: string;
    products?: any[];
  }) => {
    const subtotal = opts.items.reduce((s, i) => s + Number(i.subtotal), 0);
    (prisma as any).systemConfig.findFirst.mockResolvedValue({ value: "0" });
    prisma.estimate.findUnique.mockResolvedValue({
      id: "est-1",
      estimateNumber: EST_NO,
      status: opts.status ?? "ACCEPTED",
      updatedAt: opts.updatedAt ?? new Date("2026-11-20T15:00:00Z"),
      customerId: "cust-1",
      customer: { isTaxExempt: false },
      subtotal,
      taxAmount: 0,
      discount: 0,
      total: subtotal,
      notes: null,
      terms: null,
      items: opts.items,
    });
    prisma.product.findMany.mockResolvedValue(opts.products ?? [product()]);
    prisma.customer.findFirst.mockResolvedValue({ pricingTier: opts.tier ?? 1 });
    prisma.tenantConfig.findUnique.mockResolvedValue(
      opts.zone === null ? null : { timezone: opts.zone ?? "America/New_York" },
    );
  };
  const built = () => prisma.invoice.create.mock.calls[0][0].data.items.create as any[];

  it("1. quoted below the customer's special price: DISCOUNTED, list as original, the exact reason, the converter", async () => {
    arm({ items: [quoteLine(4)], tier: 2 });
    await service.convertToInvoice("est-1", ACTOR);
    expect(built()[0]).toMatchObject({
      priceType: "DISCOUNTED",
      originalPrice: 6,
      overrideReason: `Quoted on ${EST_NO}, accepted on 2026-11-20.`,
      overriddenBy: "user-convert",
    });
  });

  it("2. quoted at the customer's own price (within half a cent): no reason, no author", async () => {
    arm({ items: [quoteLine(5.004)], tier: 2 });
    await service.convertToInvoice("est-1", ACTOR);
    expect(built()[0].overrideReason ?? null).toBeNull();
    expect(built()[0].overriddenBy ?? null).toBeNull();
  });

  it("3. quoted above list: MANUAL with the reason stamped", async () => {
    arm({ items: [quoteLine(7)], tier: 1 });
    await service.convertToInvoice("est-1", ACTOR);
    expect(built()[0]).toMatchObject({
      priceType: "MANUAL",
      originalPrice: 6,
      overrideReason: `Quoted on ${EST_NO}, accepted on 2026-11-20.`,
      overriddenBy: "user-convert",
    });
  });

  it("4. the customer's tier moved after the quote: judged against today's 4.50, so 5.00 is DISCOUNTED", async () => {
    arm({ items: [quoteLine(5)], tier: 3 });
    await service.convertToInvoice("est-1", ACTOR);
    expect(built()[0]).toMatchObject({
      priceType: "DISCOUNTED",
      originalPrice: 6,
      overrideReason: `Quoted on ${EST_NO}, accepted on 2026-11-20.`,
    });
  });

  it.each([
    ["1", 4, 2],
    ["2", 5, 2],
    ["3", 7, 1],
    ["4", 5, 3],
  ])(
    "5. case %s: the billed unit price and subtotal are the quote's, to the cent",
    async (_n, price, tier) => {
      arm({ items: [quoteLine(price)], tier });
      await service.convertToInvoice("est-1", ACTOR);
      expect(built()[0].unitPrice).toBe(price);
      expect(built()[0].subtotal).toBe(price * 2);
    },
  );

  it("6. a line with no product is never stamped", async () => {
    arm({ items: [quoteLine(4, { productId: null })], tier: 2 });
    await service.convertToInvoice("est-1", ACTOR);
    expect(built()[0].overrideReason ?? null).toBeNull();
    expect(built()[0].priceType ?? "STANDARD").toBe("STANDARD");
  });

  it("6b. a legacy no-pack split line copies its subtotal verbatim (the stamp follows the unit price)", async () => {
    arm({
      items: [quoteLine(4, { qty: 6, boxes: 0, pieces: 6, subtotal: 21.5 })],
      tier: 2,
    });
    await service.convertToInvoice("est-1", ACTOR);
    expect(built()[0].subtotal).toBe(21.5);
    expect(built()[0]).toMatchObject({ priceType: "DISCOUNTED", originalPrice: 6 });
  });

  it("A2. accepted at 23:30 New York time: that local day, not the next UTC day", async () => {
    // 2026-11-21T04:30Z is 23:30 on the 20th in New York (UTC-5).
    arm({ items: [quoteLine(4)], tier: 2, updatedAt: new Date("2026-11-21T04:30:00Z") });
    await service.convertToInvoice("est-1", ACTOR);
    expect(built()[0].overrideReason).toBe(`Quoted on ${EST_NO}, accepted on 2026-11-20.`);
  });

  it("A2b. the date is taken in the tenant's own zone (east of UTC reads the next day)", async () => {
    arm({
      items: [quoteLine(4)],
      tier: 2,
      updatedAt: new Date("2026-11-20T20:00:00Z"),
      zone: "Asia/Tokyo",
    });
    await service.convertToInvoice("est-1", ACTOR);
    expect(built()[0].overrideReason).toBe(`Quoted on ${EST_NO}, accepted on 2026-11-21.`);
  });

  it("estimateAcceptedOn words 'accepted on' only for an ACCEPTED row", () => {
    const updatedAt = new Date("2026-11-20T15:00:00Z");
    expect(estimateAcceptedOn({ status: "ACCEPTED", updatedAt }, "America/New_York")).toBe(
      "2026-11-20",
    );
    expect(estimateAcceptedOn({ status: "SENT", updatedAt }, "America/New_York")).toBeNull();
  });
});

describe("EstimatesService.accept - a repeat accept writes nothing (SA-1260 A1, A5)", () => {
  let service: EstimatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        EstimatesService,
        { provide: SellingRestrictionsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
      ],
    }).compile();
    service = mod.get(EstimatesService);
  });

  it("A1. accept, accept again a day later: the second accept does not write, so updatedAt stays the first day", async () => {
    // A stateful quote: a write moves updatedAt to the clock, as the @updatedAt column does.
    let clock = new Date("2026-11-20T15:00:00Z");
    const row: any = { id: "est-1", status: "SENT", updatedAt: clock };
    prisma.estimate.findFirst.mockImplementation(async () => ({ ...row }));
    prisma.estimate.findUniqueOrThrow.mockImplementation(async () => ({ ...row }));
    prisma.estimate.updateMany.mockImplementation(async ({ data }: any) => {
      Object.assign(row, data, { updatedAt: clock });
      return { count: 1 };
    });

    await service.accept("est-1");
    clock = new Date("2026-11-21T15:00:00Z");
    const again = await service.accept("est-1");

    expect(prisma.estimate.updateMany).toHaveBeenCalledTimes(1);
    expect(again.status).toBe("ACCEPTED");
    expect(estimateAcceptedOn(again, "America/New_York")).toBe("2026-11-20");
  });

  it("A5. a CONVERTED quote is still refused, with no write", async () => {
    prisma.estimate.updateMany.mockResolvedValue({ count: 0 });
    prisma.estimate.findFirst.mockResolvedValue({ id: "est-1", status: "CONVERTED" });
    await expect(service.accept("est-1")).rejects.toThrow(BadRequestException);
    await expect(service.accept("est-1")).rejects.toThrow(
      "Converted estimates cannot be re-accepted",
    );
    expect(prisma.estimate.updateMany).toHaveBeenCalledWith({
      where: { id: "est-1", status: { notIn: ["CONVERTED"] } },
      data: { status: "ACCEPTED" },
    });
  });
});
