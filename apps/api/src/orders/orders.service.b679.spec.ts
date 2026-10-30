/**
 * B679/SA-144f/g — create()'s regulatedUnitBasis conversion, at the service level.
 *
 * Split out of orders.service.spec.ts (not merged into it) per the repo's size ratchet
 * (`common/size-ratchet.spec.ts` — that file is one of the 15 tracked giants and may not grow).
 * Same lightweight bootstrap as orders.create-units.spec.ts; duplicated deliberately rather than
 * shared, so this file stays self-contained and small.
 */

// InvoicesService / NotificationsService import ESM-only modules (@react-pdf/renderer,
// expo-server-sdk) Jest's CommonJS parser cannot load; the auto-mocker below never needs them.
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

import { OrdersService } from "./orders.service";
import { linePieceQty } from "./line-piece-qty";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  tenantId: "tenant-1",
  tenantSlug: "test",
};

/** Every collaborator create() touches that this spec does not care about: any method resolves undefined. */
const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describe("OrdersService.create — RF-4 per-category regulated tax (B679/SA-144f/g)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const BOXED_REG_PRODUCT = {
    id: "prod-1",
    name: "Cigarettes",
    pricePerUnit: 10,
    unit: "Case",
    unitsPerBox: 12,
    trackedCategoryId: "cat-alc",
    trackedSubcategoryId: null,
  };
  const EXCISE = {
    id: "cat-alc",
    name: "Cigarettes",
    taxType: "EXCISE_PER_UNIT",
    rate: 0.1,
    unitBasis: "pack",
    priceIncludesTax: false,
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [OrdersService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === ConfigService) return { get: jest.fn().mockReturnValue(0.1) };
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(true) };
        if (token === SystemConfigService) return { get: jest.fn().mockResolvedValue(null) };
        return autoMock();
      })
      .compile();
    service = module.get(OrdersService);

    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    prisma.customerPrice.findMany.mockResolvedValue([]);
    prisma.product.findMany.mockResolvedValue([BOXED_REG_PRODUCT]);
    prisma.trackedCategory.findMany.mockResolvedValue([EXCISE]);
    prisma.productUnit.findMany.mockResolvedValue([]);
    prisma.order.create.mockResolvedValue({
      id: "ord-new",
      customerId: "cust-1",
      orderNumber: "x",
      total: 0,
      urgent: false,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "Acme" },
      lineItems: [],
    });
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $queryRaw: jest.fn().mockResolvedValue([{ max: null }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      }),
    );
  });

  it("SA-144f: a box-split line taxes on its real (already-expanded) piece count", async () => {
    // 1 box of 12 -> qty normalizes to 12 pieces; excise $0.10 x 12 = $1.20.
    await service.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 1, boxes: 1, pieces: 0, unitPrice: 120 }],
      } as any,
      operatorPayload,
    );

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lineItems: {
            create: expect.arrayContaining([expect.objectContaining({ categoryTaxAmount: 1.2 })]),
          },
        }),
      }),
    );
  });

  it("SA-144f (Opus REQUIRED, B679): a request naming the pack's OWN label resolves to a pack line — never under-taxed as a unit line", async () => {
    // "Case" IS this product's own pack label (packLabelOf), so resolveLineUnits resolves it to
    // kind:"pack" (unitLabel: null) — the bug passed the RAW requested "Case" straight into
    // regulatedUnitBasis instead, whose branch 1 then read qty (3) as already being the full
    // piece count, under-taxing by a factor of unitsPerBox (12): $0.30 instead of $3.60.
    await service.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 3, unitLabel: "Case", unitPrice: 10 }],
      } as any,
      operatorPayload,
    );

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lineItems: {
            create: expect.arrayContaining([
              expect.objectContaining({ unitsPerBox: null, categoryTaxAmount: 3.6 }),
            ]),
          },
        }),
      }),
    );
  });

  it("SA-144f: a pack-label request is byte-identical to the same line with no label at all", async () => {
    await service.create(
      {
        customerId: "cust-1",
        items: [{ productId: "prod-1", qty: 3, unitLabel: "Case", unitPrice: 10 }],
      } as any,
      operatorPayload,
    );
    const labeled = prisma.order.create.mock.calls[0][0].data.lineItems.create[0];

    (prisma.order.create as jest.Mock).mockClear();
    await service.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 3, unitPrice: 10 }] } as any,
      operatorPayload,
    );
    const labelLess = prisma.order.create.mock.calls[0][0].data.lineItems.create[0];

    expect(labeled.categoryTaxAmount).toBe(labelLess.categoryTaxAmount);
    expect(labeled.subtotal).toBe(labelLess.subtotal);
  });
});

describe("linePieceQty — unitLabel/pack-vs-fallback precedence (SA-144e)", () => {
  const pieceQty = (li: any, fallback?: number) => linePieceQty(li, fallback);

  it("a unit-labeled line stays at its own count — unitLabel wins even over a boxed unitsPerBox, never expanded by it", () => {
    expect(pieceQty({ qty: 10, boxes: null, unitsPerBox: 1, unitLabel: "Piece" }, 12)).toBe(10);
  });

  it("a line's OWN snapshotted unitsPerBox beats the fallback — never the other way round", () => {
    expect(pieceQty({ qty: 5, boxes: null, unitsPerBox: 12 }, 6)).toBe(60);
  });
});
