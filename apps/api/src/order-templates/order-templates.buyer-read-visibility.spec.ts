import { RegulatedVisibilityService } from "../buyer/regulated-visibility.service";
import { oversellReaderOffProvider } from "../orders/testing/policy-reader-provider";
import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
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

/**
 * Row 479: a BUYER's template read must not return a line for a product the buyer catalog would 404 (portal-hidden,
 * hidden or inactive parent, inactive, a FAMILY, or in the selling-restrictions blocked set). The line is DROPPED, so
 * no name or other product detail leaves the server; staff reads are untouched. Placeholders only.
 */
const TENANT = "test-tenant";
const parentOk = { portalVisible: true, isActive: true, tenantId: TENANT };

const product = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: `Widget ${id}`,
  unit: "each",
  isActive: true,
  kind: "STANDALONE",
  trackedCategoryId: null as string | null,
  portalVisible: true,
  parent: null,
  ...over,
});
const line = (id: string, p: ReturnType<typeof product>) => ({
  id: `line-${id}`,
  productId: id,
  qty: 2,
  product: p,
});
const user = (role: string): JwtPayload =>
  ({ sub: "u1", username: "u", role, status: "ACTIVE", tenantId: TENANT }) as unknown as JwtPayload;

describe("OrderTemplatesService — buyer template reads drop lines the catalog hides (row 479)", () => {
  let service: OrderTemplatesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let restrictedProductIdsFor: jest.Mock;
  let lockedCategories: Set<string>;

  const rowWith = (items: unknown[]) => ({
    id: "t1",
    customerId: "c1",
    name: "Weekly",
    isActive: true,
    items,
    customer: { id: "c1", businessName: "Acme Foods" },
  });
  // Every hiding cause in one template, plus two visible lines.
  const mixedItems = () => [
    line("ok1", product("ok1")),
    line("portal", product("portal", { portalVisible: false })),
    line("inactive", product("inactive", { isActive: false })),
    line("family", product("family", { kind: "FAMILY" })),
    line("hidParent", product("hidParent", { parent: { ...parentOk, portalVisible: false } })),
    line("deadParent", product("deadParent", { parent: { ...parentOk, isActive: false } })),
    line("blocked", product("blocked")),
    line("ok2", product("ok2", { parent: parentOk })),
  ];

  beforeEach(async () => {
    prisma = createMockPrisma();
    lockedCategories = new Set();
    restrictedProductIdsFor = jest.fn().mockResolvedValue(new Set(["blocked"]));
    const mod = await Test.createTestingModule({
      providers: [
        oversellReaderOffProvider,
        OrderTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: { run: jest.fn((_id, fn) => fn()) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue("0") } },
        { provide: OrdersService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: SellingRestrictionsService, useValue: { restrictedProductIdsFor } },
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
    prisma.orderTemplate.findMany.mockResolvedValue([rowWith(mixedItems())]);
    prisma.orderTemplate.findUnique.mockResolvedValue(rowWith(mixedItems()));
  });

  const visibleIds = (t: { items: Array<{ productId: string }> }) =>
    t.items.map((i) => i.productId);

  it("findAllForUser(CUSTOMER) keeps only the visible lines and no hidden name appears anywhere in the JSON", async () => {
    const res = await service.findAllForUser(user("CUSTOMER"));
    expect(visibleIds(res.data[0])).toEqual(["ok1", "ok2"]);
    const json = JSON.stringify(res);
    for (const hidden of ["portal", "inactive", "family", "hidParent", "deadParent", "blocked"]) {
      expect(json).not.toContain(`Widget ${hidden}`);
    }
    expect(json).toContain("Widget ok1");
    expect(res.meta.total).toBe(1);
  });

  it("findAllForBuyer (the portal list) is the same filtered answer, keyed by customerId", async () => {
    const res = await service.findAllForBuyer("c1");
    expect(visibleIds(res.data[0])).toEqual(["ok1", "ok2"]);
    expect(restrictedProductIdsFor).toHaveBeenCalledWith(TENANT, "c1", expect.any(Date));
  });

  it("findOneForUser(CUSTOMER) drops the hidden lines too", async () => {
    const res = await service.findOneForUser("t1", user("CUSTOMER"));
    expect(visibleIds(res)).toEqual(["ok1", "ok2"]);
    expect(JSON.stringify(res)).not.toMatch(
      /Widget (portal|inactive|family|hidParent|deadParent|blocked)/,
    );
  });

  it("a kept line's product keeps the staff shape { id, name, unit } and gains no visibility field", async () => {
    const res = await service.findOneForUser("t1", user("CUSTOMER"));
    expect(res.items[0].product).toEqual({ id: "ok1", name: "Widget ok1", unit: "each" });
  });

  it("the buyer read loads the visibility facts the catalog rule needs; the staff read keeps its narrow select", async () => {
    await service.findAllForBuyer("c1");
    const buyerSelect =
      prisma.orderTemplate.findMany.mock.calls[0][0].include.items.include.product.select;
    expect(Object.keys(buyerSelect)).toEqual(
      expect.arrayContaining(["isActive", "kind", "portalVisible", "parent"]),
    );
    prisma.orderTemplate.findMany.mockClear();
    await service.findAllForUser(user("OPERATOR"), "c1");
    expect(
      prisma.orderTemplate.findMany.mock.calls[0][0].include.items.include.product.select,
    ).toEqual({
      id: true,
      name: true,
      unit: true,
    });
    expect(restrictedProductIdsFor).toHaveBeenCalledTimes(1); // only the buyer read built a context
  });

  it("STAFF reads are unchanged: OPERATOR sees every line, no visibility filter is applied", async () => {
    prisma.orderTemplate.findMany.mockResolvedValue([rowWith(mixedItems())]);
    const list = await service.findAllForUser(user("OPERATOR"), "c1");
    expect(list.data[0].items).toHaveLength(8);
    const one = await service.findOneForUser("t1", user("TENANT_ADMIN"));
    expect(one.items).toHaveLength(8);
    expect(JSON.stringify(one)).toContain("Widget portal");
  });

  it("a CUSTOMER who does not own the template is still refused before any product is loaded", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "other" });
    await expect(service.findOneForUser("t1", user("CUSTOMER"))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.orderTemplate.findUnique).toHaveBeenCalledTimes(1); // the ownership read only
  });

  it("MUST 2: a line in a regulated category the buyer is not licensed for is dropped, by the catalog's own gate", async () => {
    lockedCategories.add("cat-locked");
    prisma.orderTemplate.findMany.mockResolvedValue([
      rowWith([
        line("ok1", product("ok1")),
        line("reg", product("reg", { trackedCategoryId: "cat-locked" })),
        line("regOpen", product("regOpen", { trackedCategoryId: "cat-licensed" })),
      ]),
    ]);
    const list = await service.findAllForBuyer("c1");
    expect(visibleIds(list.data[0])).toEqual(["ok1", "regOpen"]);
    expect(JSON.stringify(list)).not.toContain('Widget reg"');
    prisma.orderTemplate.findUnique.mockResolvedValue(
      rowWith([line("reg", product("reg", { trackedCategoryId: "cat-locked" }))]),
    );
    const one = await service.findOneForUser("t1", user("CUSTOMER"));
    expect(one.items).toEqual([]);
  });

  it("MUST 2: staff reads ignore the regulated gate", async () => {
    lockedCategories.add("cat-locked");
    prisma.orderTemplate.findMany.mockResolvedValue([
      rowWith([line("reg", product("reg", { trackedCategoryId: "cat-locked" }))]),
    ]);
    const list = await service.findAllForUser(user("OPERATOR"), "c1");
    expect(list.data[0].items).toHaveLength(1);
  });

  it("a template whose every line is hidden is returned with no items (the row itself is the buyer's)", async () => {
    prisma.orderTemplate.findMany.mockResolvedValue([
      rowWith([line("portal", product("portal", { portalVisible: false }))]),
    ]);
    const res = await service.findAllForBuyer("c1");
    expect(res.data[0].items).toEqual([]);
    expect(res.data[0].name).toBe("Weekly");
  });
});
