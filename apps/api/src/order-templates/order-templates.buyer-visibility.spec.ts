import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import "reflect-metadata";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { OrderTemplatesService } from "./order-templates.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { NotificationsService } from "../notifications/notifications.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

/**
 * A BUYER creating or editing a standing order must not learn anything about a product the portal hides: a hidden
 * product, a hidden FAMILY and a missing id are the SAME 404 (no name, no ids), checked BEFORE anything is stored.
 * Staff paths are unchanged.
 */
const base = { status: "ACTIVE" as const, forcePasswordChange: false, tenantId: "test-tenant" };
const buyer = { ...base, sub: "u-cust", username: "b", role: "CUSTOMER" } as JwtPayload;
const staff = { ...base, sub: "u-op", username: "o", role: "OPERATOR" } as JwtPayload;
const SECRET = "Secret Soda";
const product = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  name: SECRET,
  isActive: true,
  kind: "STANDARD",
  portalVisible: true,
  parent: null,
  ...over,
});

describe("order templates: a buyer's create/update goes through the portal visibility gate", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let restricted: Set<string>;
  const createDto = () => ({
    name: "Weekly",
    daysOfWeek: [1],
    items: [{ productId: "p1", qty: 2 }],
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    restricted = new Set();
    const mod = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_i, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn() } },
        { provide: OrdersService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        // master's regulated-category gate (a constructor dependency added after this spec): nothing locked here
        {
          provide: RegulatedVisibilityService,
          useValue: { computeGate: jest.fn(async () => ({ hiddenIds: new Set(), locked: [] })) },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            restrictedProductIdsFor: jest.fn(async () => restricted),
            assertLinesSellable: jest.fn(),
            checkLinesSellable: jest.fn(),
          },
        },
      ],
    }).compile();
    service = mod.get(OrderTemplatesService);
    prisma.customer.findFirst.mockResolvedValue({ id: "c1" });
    prisma.customer.findUnique.mockResolvedValue({ id: "c1" });
    prisma.orderTemplate.findUnique.mockResolvedValue({ id: "t1", customerId: "c1", items: [] });
    prisma.orderTemplate.create.mockResolvedValue({ id: "t-new" });
    prisma.orderTemplate.update.mockResolvedValue({ id: "t1" });
  });

  const body = async (p: Promise<unknown>) => {
    const err: any = await p.then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(NotFoundException);
    expect(JSON.stringify(err.getResponse())).not.toContain(SECRET);
    expect(JSON.stringify(err.getResponse())).not.toContain("p1");
    return err.getResponse();
  };
  const nothingStored = () => {
    expect(prisma.orderTemplate.create).not.toHaveBeenCalled();
    expect(prisma.orderTemplate.update).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  };

  it.each([
    ["a portal-hidden product", () => [product({ portalVisible: false })]],
    ["a product the engine hides from this buyer", () => (restricted.add("p1"), [product()])],
    ["a hidden FAMILY", () => [product({ kind: "FAMILY", portalVisible: false })]],
    ["a missing id", () => []],
  ])("create with %s is the same 404 and stores nothing", async (_n, arrange) => {
    prisma.product.findMany.mockResolvedValue(arrange());
    await body(service.createForUser(createDto() as never, buyer));
    nothingStored();
  });

  it("update with a hidden product / hidden family / missing id is the same 404 and stores nothing", async () => {
    const bodies: unknown[] = [];
    for (const rows of [
      [product({ portalVisible: false })],
      [product({ kind: "FAMILY", portalVisible: false })],
      [],
    ]) {
      prisma.product.findMany.mockResolvedValue(rows);
      bodies.push(
        await body(
          service.updateForUser("t1", { items: [{ productId: "p1", qty: 2 }] } as never, buyer),
        ),
      );
    }
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    nothingStored();
  });

  it("create: the missing-id body equals the hidden-product body", async () => {
    prisma.product.findMany.mockResolvedValue([product({ portalVisible: false })]);
    const hidden = await body(service.createForUser(createDto() as never, buyer));
    prisma.product.findMany.mockResolvedValue([]);
    const missing = await body(service.createForUser(createDto() as never, buyer));
    expect(missing).toEqual(hidden);
  });

  it("control: a visible product creates the template", async () => {
    prisma.product.findMany.mockResolvedValue([product()]);
    await service.createForUser(createDto() as never, buyer);
    expect(prisma.orderTemplate.create).toHaveBeenCalledTimes(1);
  });

  it("control: staff create is unchanged (a missing id keeps its 400, no visibility gate)", async () => {
    prisma.product.findMany.mockResolvedValue([]);
    await expect(
      service.createForUser({ ...createDto(), customerId: "c1" } as never, staff),
    ).rejects.toMatchObject({ status: 400 });
  });
});
