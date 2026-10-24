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
import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
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
 * Row 479: a BUYER creating or editing a standing order, or adding a line to one, learns nothing about a product the
 * catalog hides. A portal-hidden product, one the engine restricts for them, a hidden FAMILY, a product in a regulated
 * category they are not licensed for, and an unknown id are ONE answer: the same status and the same body, no name, no
 * ids, checked BEFORE anything is stored. Staff paths are unchanged.
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
  trackedCategoryId: null as string | null,
  parent: null,
  ...over,
});

describe("order templates: a buyer's writes go through the catalog's visibility rules (row 479)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let restricted: Set<string>;
  let lockedCategories: Set<string>;
  const createDto = () => ({
    name: "Weekly",
    daysOfWeek: [1],
    items: [{ productId: "p1", qty: 2 }],
  });
  const updateDto = () => ({ items: [{ productId: "p1", qty: 2 }] }) as never;
  const addDto = () => ({ productId: "p1", qty: 2 }) as never;

  beforeEach(async () => {
    prisma = createMockPrisma();
    restricted = new Set();
    lockedCategories = new Set();
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
        {
          provide: SellingRestrictionsService,
          useValue: {
            restrictedProductIdsFor: jest.fn(async () => restricted),
            assertLinesSellable: jest.fn(),
            checkLinesSellable: jest.fn(),
          },
        },
        {
          provide: RegulatedVisibilityService,
          useValue: {
            computeGate: jest.fn(async () => ({ hiddenIds: lockedCategories, locked: [] })),
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
    prisma.orderTemplateItem.create.mockResolvedValue({ id: "i-new" });
  });

  /** The rejection as the client sees it: status plus body. */
  const refusal = async (p: Promise<unknown>) => {
    const err: any = await p.then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(err).toBeInstanceOf(NotFoundException);
    const wire = { status: err.getStatus(), body: err.getResponse() };
    expect(JSON.stringify(wire)).not.toContain(SECRET);
    expect(JSON.stringify(wire)).not.toContain("p1");
    return wire;
  };
  const nothingStored = () => {
    expect(prisma.orderTemplate.create).not.toHaveBeenCalled();
    expect(prisma.orderTemplate.update).not.toHaveBeenCalled();
    expect(prisma.orderTemplateItem.create).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  };

  /** Every cause the catalog hides a product for, plus a missing id. `arrange` loads the world for that cause. */
  const causes: Array<[string, () => unknown[]]> = [
    ["a portal-hidden product", () => [product({ portalVisible: false })]],
    ["an inactive product", () => [product({ isActive: false })]],
    ["a product the engine restricts for this buyer", () => (restricted.add("p1"), [product()])],
    ["a hidden FAMILY", () => [product({ kind: "FAMILY", portalVisible: false })]],
    [
      "a product in a regulated category the buyer is not licensed for",
      () => (lockedCategories.add("cat-locked"), [product({ trackedCategoryId: "cat-locked" })]),
    ],
    ["a missing id", () => []],
  ];
  const writes: Array<[string, () => Promise<unknown>]> = [
    ["create", () => service.createForUser(createDto() as never, buyer)],
    ["update", () => service.updateForUser("t1", updateDto(), buyer)],
    ["addItem", () => service.addItemForUser("t1", addDto(), buyer)],
  ];

  describe.each(writes)("%s", (_w, run) => {
    it("every cause answers the byte-identical 404 as a missing id, and stores nothing", async () => {
      prisma.product.findMany.mockImplementation(async (args: any) => {
        // the visibility read selects portal facts; the regulated read selects only the category
        const rows = current();
        return args?.select?.trackedCategoryId && Object.keys(args.select).length === 1
          ? rows.map((r: any) => ({ trackedCategoryId: r.trackedCategoryId }))
          : rows;
      });
      let current: () => any[] = () => [];
      const wires: string[] = [];
      for (const [, arrange] of causes) {
        restricted.clear();
        lockedCategories.clear();
        const rows = arrange();
        current = () => rows as any[];
        wires.push(JSON.stringify(await refusal(run())));
      }
      expect(new Set(wires).size).toBe(1); // hidden, restricted, family, regulated and unknown are indistinguishable
      nothingStored();
    });
  });

  it("control: a visible product is accepted on create, update and addItem", async () => {
    prisma.product.findMany.mockResolvedValue([product()]);
    prisma.product.findUnique.mockResolvedValue(product());
    await service.createForUser(createDto() as never, buyer);
    expect(prisma.orderTemplate.create).toHaveBeenCalledTimes(1);
    await service.addItemForUser("t1", addDto(), buyer);
    expect(prisma.orderTemplateItem.create).toHaveBeenCalledTimes(1);
  });

  it("control: a licensed buyer (their regulated category is not locked) may list a regulated product", async () => {
    prisma.product.findMany.mockResolvedValue([product({ trackedCategoryId: "cat-open" })]);
    lockedCategories.add("cat-other");
    await service.createForUser(createDto() as never, buyer);
    expect(prisma.orderTemplate.create).toHaveBeenCalledTimes(1);
  });

  it("control: a PATCH with no items (pause/resume) reads no product at all", async () => {
    await service.updateForUser("t1", { isActive: false } as never, buyer);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("control: staff create is unchanged (a missing id keeps its 400, no visibility or regulated gate)", async () => {
    prisma.product.findMany.mockResolvedValue([]);
    await expect(
      service.createForUser({ ...createDto(), customerId: "c1" } as never, staff),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("control: staff may list a hidden, regulated-locked product", async () => {
    lockedCategories.add("cat-locked");
    prisma.product.findMany.mockResolvedValue([
      product({ portalVisible: false, trackedCategoryId: "cat-locked" }),
    ]);
    await service.createForUser({ ...createDto(), customerId: "c1" } as never, staff);
    expect(prisma.orderTemplate.create).toHaveBeenCalledTimes(1);
  });
});
