import "reflect-metadata";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test } from "@nestjs/testing";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BUYER_LINE_QTY_OVER_MAX_MESSAGE } from "../orders/buyer-line-cap";

jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

/**
 * B1386: a BUYER standing-order line whose resolved piece total (qty packs x live pack) passes
 * BUYER_LINE_QTY_MAX (100,000) is refused on create and update, nothing written. Rise-only on update: a stored
 * line already above the cap may be resent unchanged. Staff are never capped.
 */
const base = { status: "ACTIVE" as const, forcePasswordChange: false, tenantId: "test-tenant" };
const buyer = { ...base, sub: "u-cust", username: "b", role: "CUSTOMER" } as JwtPayload;
const staff = { ...base, sub: "u-op", username: "o", role: "OPERATOR" } as JwtPayload;
const OVER = {
  response: {
    code: API_ERROR_CODES.BUYER_LINE_QTY_OVER_MAX,
    message: BUYER_LINE_QTY_OVER_MAX_MESSAGE,
  },
};

describe("OrderTemplatesService buyer line cap (B1386)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const row = (upb: number) => ({
    id: "p1",
    name: "Acme Soda",
    isActive: true,
    kind: "STANDARD",
    portalVisible: true,
    trackedCategoryId: null as string | null,
    unitsPerBox: upb,
    parent: null,
  });
  /** One product row serves the visibility, create/update, regulated and live-pack reads alike. */
  const livePack = (upb: number) => {
    prisma.product.findMany.mockResolvedValue([row(upb)]);
    prisma.product.findUnique.mockResolvedValue(row(upb));
  };
  const nothingWritten = () => {
    expect(prisma.orderTemplate.create).not.toHaveBeenCalled();
    expect(prisma.orderTemplate.update).not.toHaveBeenCalled();
    expect(prisma.orderTemplateItem.create).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  };
  const createDto = (qty: number, extra: Record<string, unknown> = {}) =>
    ({ name: "Weekly", daysOfWeek: [1], items: [{ productId: "p1", qty }], ...extra }) as never;
  const storedTemplate = (qty: number) => ({
    id: "t1",
    customerId: "c1",
    items: [{ id: "i1", productId: "p1", qty, product: row(0) }],
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_i, fn) => fn()) } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn(), getAll: jest.fn().mockResolvedValue({}) },
        },
        { provide: OrdersService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: SellingRestrictionsService,
          useValue: {
            restrictedProductIdsFor: jest.fn(async () => new Set<string>()),
            assertLinesSellable: jest.fn(),
            checkLinesSellable: jest.fn(),
          },
        },
        {
          provide: RegulatedVisibilityService,
          useValue: {
            computeGate: jest.fn(async () => ({ hiddenIds: new Set<string>(), locked: [] })),
          },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    prisma.customer.findFirst.mockResolvedValue({ id: "c1" });
    prisma.customer.findUnique.mockResolvedValue({ id: "c1" });
    prisma.orderTemplate.findUnique.mockResolvedValue(storedTemplate(5));
    prisma.orderTemplate.create.mockResolvedValue({ id: "t-new" });
    prisma.orderTemplate.update.mockResolvedValue({ id: "t1" });
    prisma.orderTemplateItem.create.mockResolvedValue({ id: "i-new" });
    prisma.orderTemplateItem.findMany.mockResolvedValue([]);
  });

  describe("REG-B1386 template cap", () => {
    it("T1 create refuses an item of 100,001 on a plain product, nothing written", async () => {
      livePack(0);
      await expect(service.createForUser(createDto(100_001), buyer)).rejects.toMatchObject(OVER);
      nothingWritten();
    });

    it("T2 create refuses 8,334 packs of 12 (100,008 pieces), nothing written", async () => {
      livePack(12);
      await expect(service.createForUser(createDto(8_334), buyer)).rejects.toMatchObject(OVER);
      nothingWritten();
    });

    it("T3 update refuses raising a stored item (qty 5) to 100,001, nothing written", async () => {
      livePack(0);
      await expect(
        service.updateForUser("t1", { items: [{ productId: "p1", qty: 100_001 }] } as never, buyer),
      ).rejects.toMatchObject(OVER);
      nothingWritten();
    });
  });

  const twoItems = () => ({
    id: "t1",
    customerId: "c1",
    items: [
      { id: "iA", productId: "p1", qty: 120_000, product: row(0) },
      { id: "iB", productId: "p1", qty: 10, product: row(0) },
    ],
  });

  describe("REG-B1386 template cap (same product twice)", () => {
    it("T4 refuses raising item B to 120,000 even though item A of the same product holds 120,000", async () => {
      livePack(0);
      prisma.orderTemplate.findUnique.mockResolvedValue(twoItems());
      await expect(
        service.updateForUser(
          "t1",
          {
            items: [
              { productId: "p1", qty: 120_000 },
              { productId: "p1", qty: 120_000 },
            ],
          } as never,
          buyer,
        ),
      ).rejects.toMatchObject(OVER);
      nothingWritten();
    });
  });

  describe("template cap pins (B1386)", () => {
    it("P11 same stored template: A resent at 120,000 and B raised to 50 resolves", async () => {
      livePack(0);
      prisma.orderTemplate.findUnique.mockResolvedValue(twoItems());
      await expect(
        service.updateForUser(
          "t1",
          {
            items: [
              { productId: "p1", qty: 120_000 },
              { productId: "p1", qty: 50 },
            ],
          } as never,
          buyer,
        ),
      ).resolves.toBeDefined();
    });

    it("P5 update resending a stored item already at 120,000 unchanged resolves", async () => {
      livePack(0);
      prisma.orderTemplate.findUnique.mockResolvedValue(storedTemplate(120_000));
      await expect(
        service.updateForUser("t1", { items: [{ productId: "p1", qty: 120_000 }] } as never, buyer),
      ).resolves.toBeDefined();
      expect(prisma.orderTemplate.update).toHaveBeenCalledTimes(1);
    });

    it("P8 staff (OPERATOR) create with qty 240,000 resolves", async () => {
      livePack(0);
      await expect(
        service.createForUser(createDto(240_000, { customerId: "c1" }), staff),
      ).resolves.toBeDefined();
      expect(prisma.orderTemplate.create).toHaveBeenCalledTimes(1);
    });
  });
});
