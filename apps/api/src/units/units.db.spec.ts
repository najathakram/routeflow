/**
 * SA-810 pins (Mac mini lane): G6d equivalence of the grouped count with the retired correlated one,
 * the sqlKeyOf == unitNameKey collation pin, the archived paging and the 200-unit cap on a real DB.
 *
 * Units U-1 — DB lane for the pieces a mocked prisma cannot prove: the single productCount query
 * (DISTINCT across ProductUnit.label via tenantUnitId and the three Product text columns, matched by
 * nameKey) and the rename transaction through the REAL tenant-wrapped `tenantTransaction` proxy,
 * including the all-or-nothing collision refusal and tenant isolation.
 *
 * Cleanup is two-phase (`wipe`): every row that points at a Product (order / invoice lines of BOTH test
 * tenants, stock movements and lots) goes first, then the tenants' own rows. The isolation case leaves
 * tenant B's lines on tenant A's product, so a per-tenant sweep that deleted A's products first hit
 * OrderItem_productId_fkey and failed every case after it.
 *
 * Run via `npm run local:test:db` against the compose Postgres. Every tenant is a throwaway
 * `qa-unit-<run>-*` slug approved by `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { randomUUID } from "crypto";
import { ConflictException, NotFoundException, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { UnitsService } from "./units.service";
import { unitNameKey } from "./piece-words";
import { sqlKeyOf } from "./unit-name-sql";
import { MAX_ACTIVE_TENANT_UNITS } from "./unit-room";
import { VariantResolutionService } from "../import/variant-resolution.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { ProductsService } from "../products/products.service";
import { ProductsController } from "../products/products.controller";
import { ProductUnitsService } from "../products/product-units.service";
import { UpdateProductDto } from "../products/dto/update-product.dto";
import { InventoryService } from "../inventory/inventory.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const user = { sub: "u-db-spec", username: "db-spec" } as JwtPayload;

describeDb("tenant units against real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let service: UnitsService;
  let countedClient: PrismaClient;
  let countingService: UnitsService;
  let products: ProductsService;
  let productsController: ProductsController;
  let productUnits: ProductUnitsService;
  let inventory: InventoryService;
  let operatorId: string;
  const queries: Array<{ query: string }> = [];

  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-unit-${run}-a`, "units.db.spec.ts");
  const slugB = assertTestTenant(`qa-unit-${run}-b`, "units.db.spec.ts");
  let A: string;
  let B: string;

  const asA = <T>(fn: () => Promise<T>) => ctx.run(A, fn);
  const asB = <T>(fn: () => Promise<T>) => ctx.run(B, fn);

  const product = (
    tenantId: string,
    name: string,
    over: {
      baseUnitLabel?: string | null;
      packLabel?: string | null;
      unit?: string;
      unitsPerBox?: number;
    } = {},
  ) =>
    raw.product.create({
      data: { name, unit: over.unit ?? "Each", pricePerUnit: "1.00", tenantId, ...over },
    });
  const level = (
    tenantId: string,
    productId: string,
    label: string,
    factorToBase: number,
    tenantUnitId: string | null,
  ) => raw.productUnit.create({ data: { tenantId, productId, label, factorToBase, tenantUnitId } });

  /** A customer of `tenantId` (orders and invoices need one). */
  const customerOf = async (tenantId: string) => {
    const tag = randomUUID().slice(0, 8);
    const u = await raw.user.create({
      data: { email: `${tag}@example.test`, username: `u-${tag}`, role: "CUSTOMER", tenantId },
    });
    return raw.customer.create({
      data: { userId: u.id, businessName: `Units ${tag}`, contactName: "T", tenantId },
    });
  };
  /**
   * One sold line: `kind` order puts it on an OrderItem under a new order of `orderTenantId`, invoice on an
   * InvoiceItem under a new invoice. The item carries the SAME tenantId as its parent (the T6 NOT NULL
   * guards refuse a NULL one); the production check joins through the parent either way. `productId` may
   * belong to ANOTHER tenant (isolation case).
   */
  const line = async (
    kind: "order" | "invoice",
    orderTenantId: string,
    productId: string,
    unitLabel: string,
    unitsPerBox: number | null,
  ) => {
    const c = await customerOf(orderTenantId);
    if (kind === "order") {
      const order = await raw.order.create({
        data: {
          customerId: c.id,
          status: "PENDING",
          subtotal: "1.00",
          total: "1.00",
          tenantId: orderTenantId,
        },
      });
      return raw.orderItem.create({
        data: {
          orderId: order.id,
          tenantId: orderTenantId,
          productId,
          qty: "1",
          // The unitLine split CHECK: a unit line with a pack size > 1 and qty > 0 must say boxes/pieces.
          boxes: 1,
          unitPrice: "1.00",
          unitLabel,
          unitsPerBox,
        },
      });
    }
    const invoice = await raw.invoice.create({
      data: {
        invoiceNumber: `INV-UNITS-${randomUUID().slice(0, 8)}`,
        customerId: c.id,
        subtotal: "1.00",
        total: "1.00",
        tenantId: orderTenantId,
      },
    });
    return raw.invoiceItem.create({
      data: {
        invoiceId: invoice.id,
        tenantId: orderTenantId,
        productId,
        description: "line",
        qty: "1",
        boxes: 1,
        unitPrice: "1.00",
        subtotal: "1.00",
        unitLabel,
        unitsPerBox,
      },
    });
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    service = new UnitsService(prisma, new AuditService(prisma));
    A = (await raw.tenant.create({ data: { slug: slugA, name: `Units spec ${slugA}` } })).id;
    B = (await raw.tenant.create({ data: { slug: slugB, name: `Units spec ${slugB}` } })).id;

    // G6e: a second client that logs every statement it sends. Only `getTenantId` and `$queryRaw` are
    // reached by `list()`, so a thin proxy over the logging client stands in for PrismaService there.
    countedClient = new PrismaClient({
      adapter: new PrismaPg(pool),
      log: [{ emit: "event", level: "query" }],
    });
    (countedClient as unknown as { $on(e: "query", cb: (q: { query: string }) => void): void }).$on(
      "query",
      (q) => queries.push(q),
    );
    const countedPrisma = new Proxy(countedClient, {
      get(target, key) {
        if (key === "getTenantId") return () => ctx.getOrNull();
        const value = (target as unknown as Record<string | symbol, unknown>)[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as PrismaService;
    countingService = new UnitsService(countedPrisma, new AuditService(countedPrisma));

    // N2 / G6b: the REAL products, controller, level and inventory code paths over the same database.
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    products = moduleRef.get(ProductsService);
    productsController = new ProductsController(products, {} as never);
    productUnits = new ProductUnitsService(prisma);
    inventory = new InventoryService(prisma, {
      fireForProducts: jest.fn().mockResolvedValue(undefined),
    } as never);
  }, 120_000);

  /**
   * FK-safe wipe of everything this spec can create for the given tenants, in two phases. Phase 1 deletes
   * every row that points at a Product, matched by tenant, by parent order / invoice AND by product id, so
   * a line of the OTHER test tenant sitting on this tenant's product (the isolation case) goes too. Phase 2
   * deletes the tenants' own rows. Only the spec's own qa-unit-* tenants are ever named (assertTestTenant
   * re-checks each slug); there is no unfiltered deleteMany.
   */
  const wipe = async (tenantIds: string[]) => {
    const ids = tenantIds.filter(Boolean);
    if (ids.length === 0) return;
    for (const t of await raw.tenant.findMany({
      where: { id: { in: ids } },
      select: { slug: true },
    })) {
      assertTestTenant(t.slug, "units.db.spec.ts");
    }
    const productIds = (
      await raw.product.findMany({ where: { tenantId: { in: ids } }, select: { id: true } })
    ).map((p) => p.id);
    // Phase 1: children of Product (and of the tenants' orders / invoices).
    await raw.invoiceItem.deleteMany({
      where: {
        OR: [
          { tenantId: { in: ids } },
          { invoice: { tenantId: { in: ids } } },
          { productId: { in: productIds } },
        ],
      },
    });
    await raw.orderItem.deleteMany({
      where: {
        OR: [
          { tenantId: { in: ids } },
          { order: { tenantId: { in: ids } } },
          { productId: { in: productIds } },
        ],
      },
    });
    await raw.stockMovement.deleteMany({
      where: { OR: [{ tenantId: { in: ids } }, { productId: { in: productIds } }] },
    });
    await raw.stockLot.deleteMany({
      where: { OR: [{ tenantId: { in: ids } }, { productId: { in: productIds } }] },
    });
    await raw.productUnit.deleteMany({
      where: { OR: [{ tenantId: { in: ids } }, { productId: { in: productIds } }] },
    });
    // Phase 2: the tenants' own rows, parents after children.
    await raw.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    await raw.invoice.deleteMany({ where: { tenantId: { in: ids } } });
    await raw.order.deleteMany({ where: { tenantId: { in: ids } } });
    await raw.customer.deleteMany({ where: { tenantId: { in: ids } } });
    await raw.user.deleteMany({ where: { tenantId: { in: ids } } });
    await raw.product.deleteMany({ where: { tenantId: { in: ids } } });
    await raw.tenantUnit.deleteMany({ where: { tenantId: { in: ids } } });
  };

  afterAll(async () => {
    const tenants = [A, B].filter(Boolean);
    await wipe(tenants);
    if (tenants.length > 0) await raw.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
    await countedClient.$disconnect();
    await raw.$disconnect();
    await pool.end();
  }, 120_000);

  beforeEach(async () => {
    await wipe([A, B]);
    // The user a stock movement is performed by (StockMovement.performedById is a real FK).
    const tag = randomUUID().slice(0, 8);
    operatorId = (
      await raw.user.create({
        data: {
          email: `op-${tag}@example.test`,
          username: `op-${tag}`,
          role: "OPERATOR",
          tenantId: A,
        },
      })
    ).id;
    queries.length = 0;
  });

  it("productCount is DISTINCT across the level label and the base / pack / unit text, matched by nameKey", async () => {
    const caseUnit = await asA(() => service.create({ name: "Case" }, user));
    const p1 = await product(A, "P1", { packLabel: " CASE ", unit: "case" }); // pack + unit: ONE product
    const p2 = await product(A, "P2", { baseUnitLabel: "Case" });
    const p3 = await product(A, "P3"); // reached only through a linked level
    await product(A, "P4", { unit: "Box" }); // not a Case product
    await level(A, p3.id, "Case", 12, caseUnit.id);
    await level(A, p3.id, "Case2", 24, null); // unlinked level never counts
    await product(B, "Other tenant", { unit: "Case" }); // another tenant's text never counts
    void p1;
    void p2;
    const [row] = (await asA(() => service.list())).filter((u) => u.id === caseUnit.id);
    expect(row.productCount).toBe(3);
  });

  it("a unit named Div keys as div: the SQL trim never eats the letter v (E-strings have no \\v)", async () => {
    const div = await asA(() => service.create({ name: "Div" }, user));
    const p1 = await product(A, "P1", { unit: "Div" });
    const p2 = await product(A, "P2", { packLabel: " div " });
    await product(A, "P3", { unit: "Di" }); // what a v-eating trim would match
    const [row] = (await asA(() => service.list())).filter((u) => u.id === div.id);
    expect(row.productCount).toBe(2);
    const out = await asA(() => service.update(div.id, { name: "Dive" }, user));
    expect(out.productsUpdated).toBe(2);
    expect((await raw.product.findUnique({ where: { id: p1.id } }))?.unit).toBe("Dive");
    expect((await raw.product.findUnique({ where: { id: p2.id } }))?.packLabel).toBe("Dive");
  });

  it("the SQL key trims every character JS trim() does: an ideographic space (U+3000) around Case still counts and renames", async () => {
    const u = await asA(() => service.create({ name: "Case" }, user));
    const p1 = await product(A, "P1", { unit: "Case\u3000" });
    const p2 = await product(A, "P2", { packLabel: "\ufeff\u2003Case\u202f" });
    const [row] = (await asA(() => service.list())).filter((x) => x.id === u.id);
    expect(row.productCount).toBe(2);
    const out = await asA(() => service.update(u.id, { name: "Carton" }, user));
    expect(out.productsUpdated).toBe(2);
    expect((await raw.product.findUnique({ where: { id: p1.id } }))?.unit).toBe("Carton");
    expect((await raw.product.findUnique({ where: { id: p2.id } }))?.packLabel).toBe("Carton");
  });

  it("an NFD and an NFC spelling of one word are ONE unit, counted and renamed through the SQL NFC fold", async () => {
    const nfc = "Caf\u00e9";
    const nfd = "Cafe\u0301";
    const unit = await asA(() => service.create({ name: nfc }, user));
    const again = await asA(() => service.create({ name: nfd }, user));
    expect(again.id).toBe(unit.id);
    expect(await raw.tenantUnit.count({ where: { tenantId: A } })).toBe(1);
    const p1 = await product(A, "P1", { unit: nfd }); // stored NFD, unit stored NFC
    const p2 = await product(A, "P2", { packLabel: ` ${nfc} ` });
    const [row] = (await asA(() => service.list())).filter((u) => u.id === unit.id);
    expect(row.productCount).toBe(2);
    const out = await asA(() => service.update(unit.id, { name: "Carton" }, user));
    expect(out.productsUpdated).toBe(2);
    expect((await raw.product.findUnique({ where: { id: p1.id } }))?.unit).toBe("Carton");
    expect((await raw.product.findUnique({ where: { id: p2.id } }))?.packLabel).toBe("Carton");
  });

  it("rename rewrites level labels and the three text columns in one go and returns the distinct count", async () => {
    const caseUnit = await asA(() => service.create({ name: "Case" }, user));
    const p1 = await product(A, "P1", { packLabel: "case", unit: "Case" });
    const p2 = await product(A, "P2", { baseUnitLabel: "Case" });
    const p3 = await product(A, "P3");
    await level(A, p3.id, "Case", 12, caseUnit.id);
    const out = await asA(() => service.update(caseUnit.id, { name: "Carton" }, user));
    expect(out.productsUpdated).toBe(3);
    expect(out.unit.name).toBe("Carton");
    expect(await raw.product.findUnique({ where: { id: p1.id } })).toMatchObject({
      packLabel: "Carton",
      unit: "Carton",
    });
    expect((await raw.product.findUnique({ where: { id: p2.id } }))?.baseUnitLabel).toBe("Carton");
    expect((await raw.productUnit.findFirst({ where: { productId: p3.id } }))?.label).toBe(
      "Carton",
    );
    expect(
      await raw.auditLog.count({ where: { tenantId: A, action: "tenant_unit.renamed" } }),
    ).toBe(1);
  });

  it("a collision refuses the whole rename: nothing at all changes", async () => {
    const caseUnit = await asA(() => service.create({ name: "Case" }, user));
    const ok = await product(A, "Fine", { packLabel: "Case" });
    const bad = await product(A, "Gift Box");
    await level(A, bad.id, "Case", 12, caseUnit.id);
    await level(A, bad.id, "Carton", 24, null);
    const err = await asA(() => service.update(caseUnit.id, { name: "Carton" }, user)).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().products).toEqual([{ id: bad.id, name: "Gift Box" }]);
    expect((await raw.product.findUnique({ where: { id: ok.id } }))?.packLabel).toBe("Case");
    expect((await raw.tenantUnit.findUnique({ where: { id: caseUnit.id } }))?.name).toBe("Case");
    expect(await raw.productUnit.count({ where: { productId: bad.id, label: "Case" } })).toBe(1);
  });

  it("renaming onto an existing name (archived too) is 409; a case-only change is allowed", async () => {
    const a = await asA(() => service.create({ name: "Case" }, user));
    const b = await asA(() => service.create({ name: "Box" }, user));
    await asA(() => service.update(b.id, { archived: true }, user));
    await expect(asA(() => service.update(a.id, { name: "BOX" }, user))).rejects.toBeInstanceOf(
      ConflictException,
    );
    const out = await asA(() => service.update(a.id, { name: "CASE" }, user));
    expect(out.unit.name).toBe("CASE");
  });

  it("archive and restore touch no product row; adding an archived name restores the SAME row", async () => {
    const u = await asA(() => service.create({ name: "Pallet" }, user));
    const p = await product(A, "P", { unit: "Pallet" });
    const before = await raw.product.findUnique({ where: { id: p.id } });
    await asA(() => service.update(u.id, { archived: true }, user));
    expect(await raw.product.findUnique({ where: { id: p.id } })).toEqual(before);
    expect(await asA(() => service.list())).toEqual([]);
    const again = await asA(() => service.create({ name: "pallet" }, user));
    expect(again.id).toBe(u.id);
    expect(again.archivedAt).toBeNull();
    expect(await raw.tenantUnit.count({ where: { tenantId: A } })).toBe(1);
  });

  it("two concurrent adds of one name end as one row", async () => {
    const [x, y] = await Promise.all([
      asA(() => service.create({ name: "Tray" }, user)),
      asA(() => service.create({ name: "tray" }, user)),
    ]);
    expect(x.id).toBe(y.id);
    expect(await raw.tenantUnit.count({ where: { tenantId: A } })).toBe(1);
  });

  it("another tenant's unit is a 404 and stays untouched", async () => {
    const mine = await asB(() => service.create({ name: "Case" }, user));
    await expect(asA(() => service.update(mine.id, { name: "X" }, user))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      asA(() => service.update(mine.id, { archived: true }, user)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await raw.tenantUnit.findUnique({ where: { id: mine.id } }))?.archivedAt).toBeNull();
    expect(await asA(() => service.list())).toEqual([]);
    expect(await asA(() => service.listArchived())).toEqual({ items: [], nextCursor: null });
  });
  describe("rename vs sold lines (LINES_AT_OTHER_SIZE), through the parent order / invoice", () => {
    const caseAt12 = async () => {
      const caseUnit = await asA(() => service.create({ name: "Case" }, user));
      const p = await product(A, "Mug");
      await level(A, p.id, "Case", 12, caseUnit.id);
      return { caseUnit, p };
    };
    const refusal = (caseUnitId: string, name: string) =>
      asA(() => service.update(caseUnitId, { name }, user)).catch((e) => e);

    it.each(["order", "invoice"] as const)(
      "a %s line already saying Crate at size 6 refuses Case(12) -> Crate (409, nothing changed)",
      async (kind) => {
        const { caseUnit, p } = await caseAt12();
        await line(kind, A, p.id, "Crate", 6);
        const err = await refusal(caseUnit.id, "Crate");
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toEqual(
          expect.objectContaining({
            code: "UNIT_RENAME_COLLISION",
            reason: "LINES_AT_OTHER_SIZE",
            products: [{ id: p.id, name: "Mug" }],
          }),
        );
        expect((await raw.tenantUnit.findUnique({ where: { id: caseUnit.id } }))?.name).toBe(
          "Case",
        );
        expect((await raw.productUnit.findFirst({ where: { productId: p.id } }))?.label).toBe(
          "Case",
        );
      },
    );

    it.each(["order", "invoice"] as const)(
      "a %s line saying Crate at the SAME size 12 agrees with the level: the rename goes through",
      async (kind) => {
        const { caseUnit, p } = await caseAt12();
        await line(kind, A, p.id, "crate", 12);
        const out = await asA(() => service.update(caseUnit.id, { name: "Crate" }, user));
        expect(out.unit.name).toBe("Crate");
        expect((await raw.productUnit.findFirst({ where: { productId: p.id } }))?.label).toBe(
          "Crate",
        );
      },
    );

    it("a line with no size snapshot counts as a different size", async () => {
      const { caseUnit, p } = await caseAt12();
      await line("order", A, p.id, "Crate", null);
      expect((await refusal(caseUnit.id, "Crate")).getResponse().reason).toBe(
        "LINES_AT_OTHER_SIZE",
      );
    });

    it("the NFD spelling of the new name on a line is found through the NFC key", async () => {
      const { caseUnit, p } = await caseAt12();
      await line("invoice", A, p.id, "Cafe\u0301", 6);
      expect((await refusal(caseUnit.id, "Caf\u00e9")).getResponse().reason).toBe(
        "LINES_AT_OTHER_SIZE",
      );
    });

    it("tenant isolation: a same-named line under ANOTHER tenant's order / invoice never blocks", async () => {
      const { caseUnit, p } = await caseAt12();
      await line("order", B, p.id, "Crate", 6);
      await line("invoice", B, p.id, "Crate", 6);
      const out = await asA(() => service.update(caseUnit.id, { name: "Crate" }, user));
      expect(out.unit.name).toBe("Crate");
    });
  });

  describe("sold lines snapshot their unit text (S6) and Postgres lower() agrees with unitNameKey (S7)", () => {
    it.each(["order", "invoice"] as const)(
      "a rename leaves unitLabel and unitsPerBox on an existing %s line exactly as sold",
      async (kind) => {
        const caseUnit = await asA(() => service.create({ name: "Case" }, user));
        const p = await product(A, "Mug", { unit: "Case" });
        await level(A, p.id, "Case", 12, caseUnit.id);
        const sold = await line(kind, A, p.id, "Case", 12);
        await asA(() => service.update(caseUnit.id, { name: "Carton" }, user));
        const after =
          kind === "order"
            ? await raw.orderItem.findUnique({ where: { id: sold.id } })
            : await raw.invoiceItem.findUnique({ where: { id: sold.id } });
        expect(after).toMatchObject({ unitLabel: "Case", unitsPerBox: 12 });
        // ...while the product and its level did move.
        expect((await raw.productUnit.findFirst({ where: { productId: p.id } }))?.label).toBe(
          "Carton",
        );
      },
    );

    it("Postgres lower(normalize(x, NFC)) equals unitNameKey for ÉTUI (NFC and NFD)", async () => {
      for (const word of ["\u00c9TUI", "E\u0301TUI"]) {
        const rows = await raw.$queryRaw<
          Array<{ k: string }>
        >`SELECT lower(normalize(${word}, NFC)) AS k`;
        expect(rows[0].k).toBe(unitNameKey(word));
      }
    });

    it("a product holding ÉTUI in capitals is counted and renamed under the unit Étui", async () => {
      const unit = await asA(() => service.create({ name: "\u00c9tui" }, user));
      const p = await product(A, "P1", { unit: "\u00c9TUI", packLabel: "E\u0301TUI" });
      const [row] = (await asA(() => service.list())).filter((u) => u.id === unit.id);
      expect(row.productCount).toBe(1);
      const out = await asA(() => service.update(unit.id, { name: "Carton" }, user));
      expect(out.productsUpdated).toBe(1);
      expect(await raw.product.findUnique({ where: { id: p.id } })).toMatchObject({
        unit: "Carton",
        packLabel: "Carton",
      });
    });
  });
  describe("SA-810: one grouped usage count, the collation pin, archived paging and the cap", () => {
    const k = (col: string) => sqlKeyOf(Prisma.sql`p.${Prisma.raw(`"${col}"`)}`);
    /** The RETIRED correlated per-unit count (units.service.ts before SA-810), kept as the oracle. */
    const correlatedCounts = async (tenantId: string) => {
      const rows = await raw.$queryRaw<Array<{ id: string; productCount: number }>>(Prisma.sql`
        SELECT u."id",
          (SELECT COUNT(*)::int FROM (
            SELECT pu."productId" AS pid FROM "ProductUnit" pu WHERE pu."tenantUnitId" = u."id"
            UNION
            SELECT p."id" FROM "Product" p
            WHERE p."tenantId" = u."tenantId"
              AND (${k("baseUnitLabel")} = u."nameKey"
                OR ${k("packLabel")} = u."nameKey"
                OR ${k("unit")} = u."nameKey")
          ) used) AS "productCount"
        FROM "TenantUnit" u
        WHERE u."tenantId" = ${tenantId}
        ORDER BY lower(u."name"), u."id"`);
      return Object.fromEntries(rows.map((r) => [r.id, Number(r.productCount)]));
    };

    it("G6d: the grouped query returns the same counts as the correlated one (FK rows, all 3 columns, a product in two places, NFD Café)", async () => {
      const caseU = await asA(() => service.create({ name: "Case" }, user));
      const cafe = await asA(() => service.create({ name: "Caf\u00e9" }, user));
      const box = await asA(() => service.create({ name: "Box" }, user));
      const old = await asA(() => service.create({ name: "Pallet" }, user));
      await asA(() => service.update(old.id, { archived: true }, user));
      const p1 = await product(A, "P1", { packLabel: " CASE ", unit: "case" }); // two places, one product
      await product(A, "P2", { baseUnitLabel: "Case" });
      const p3 = await product(A, "P3"); // only via a linked level
      await level(A, p3.id, "Case", 12, caseU.id);
      await level(A, p1.id, "Case", 24, caseU.id); // FK row AND text match on one product
      await product(A, "P4", { unit: "Cafe\u0301" }); // NFD
      await product(A, "P5", { baseUnitLabel: "\u00a0caf\u00e9\u00a0" }); // NBSP-padded NFC
      await product(A, "P6", { unit: "Pallet" }); // archived unit still counts
      await product(A, "P7", { packLabel: "Box", unit: "Box" });
      await product(B, "Other tenant", { unit: "Case" });
      const oracle = await correlatedCounts(A);
      const grouped = [
        ...(await asA(() => service.list())),
        ...(await asA(() => service.listArchived())).items,
      ];
      expect(Object.fromEntries(grouped.map((u) => [u.id, u.productCount]))).toEqual(oracle);
      expect(oracle).toEqual({ [caseU.id]: 3, [cafe.id]: 2, [box.id]: 1, [old.id]: 1 });
    });

    it.each([
      ["NFC Caf\u00e9", "Caf\u00e9"],
      ["NFD Cafe\u0301", "Cafe\u0301"],
      ["\u00c9TUI", "\u00c9TUI"],
      ["NBSP-padded", "\u00a0Case\u00a0"],
      ["Stra\u00dfe", "Stra\u00dfe"],
      ["STRASSE", "STRASSE"],
    ])("collation pin: sqlKeyOf(x) equals unitNameKey(x) for %s", async (_label, word) => {
      const rows = await raw.$queryRaw<Array<{ k: string }>>(
        Prisma.sql`SELECT ${sqlKeyOf(Prisma.sql`${word}::text`)} AS k`,
      );
      expect(rows[0].k).toBe(unitNameKey(word));
    });

    it("the archived list pages 100 at a time in (lower(name), id) order and every archived unit appears once", async () => {
      const names = Array.from({ length: 105 }, (_, i) => `Old ${String(i).padStart(3, "0")}`);
      await raw.tenantUnit.createMany({
        data: names.map((name) => ({
          tenantId: A,
          name,
          nameKey: unitNameKey(name),
          archivedAt: new Date(),
        })),
      });
      // Another tenant's archived units (some sorting between A's) never appear on A's pages.
      await raw.tenantUnit.createMany({
        data: ["Old 000a", "Old 050b", "Zz other"].map((name) => ({
          tenantId: B,
          name,
          nameKey: unitNameKey(name),
          archivedAt: new Date(),
        })),
      });
      const first = await asA(() => service.listArchived());
      expect(first.items).toHaveLength(100);
      expect(first.nextCursor).not.toBeNull();
      const second = await asA(() => service.listArchived(first.nextCursor!));
      expect(second.items).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map((u) => u.name)).toEqual(names);
      expect((await asB(() => service.listArchived())).items.map((u) => u.name)).toEqual([
        "Old 000a",
        "Old 050b",
        "Zz other",
      ]);
    });

    it("G6c: at 200 active units an import completeSetup with NEW pack words saves and adds no TenantUnit", async () => {
      await raw.tenantUnit.createMany({
        data: Array.from({ length: MAX_ACTIVE_TENANT_UNITS }, (_, i) => ({
          tenantId: A,
          name: `U${i}`,
          nameKey: `u${i}`,
        })),
      });
      const imports = new VariantResolutionService(prisma, {} as never, {} as never);
      const p1 = await product(A, "Imported 1", { unit: "Each" });
      const p2 = await product(A, "Imported 2", { unit: "Each" });
      await raw.product.updateMany({
        where: { id: { in: [p1.id, p2.id] } },
        data: { detailsIncomplete: true },
      });
      const before = await raw.tenantUnit.findMany({
        where: { tenantId: A },
        select: { id: true, nameKey: true, archivedAt: true },
        orderBy: { id: "asc" },
      });
      await asA(() => imports.completeSetup(p1.id, { unit: "12ct", unitsPerBox: 12 }));
      await asA(() => imports.completeSetup(p2.id, { unit: "Cafe\u0301 24pk", unitsPerBox: 24 }));
      expect(await raw.product.findUnique({ where: { id: p1.id } })).toMatchObject({
        unit: "12ct",
        unitsPerBox: 12,
        detailsIncomplete: false,
      });
      expect((await raw.product.findUnique({ where: { id: p2.id } }))?.unit).toBe(
        "Cafe\u0301 24pk",
      );
      const after = await raw.tenantUnit.findMany({
        where: { tenantId: A },
        select: { id: true, nameKey: true, archivedAt: true },
        orderBy: { id: "asc" },
      });
      expect(after).toEqual(before);
      expect(after).toHaveLength(MAX_ACTIVE_TENANT_UNITS);
    });

    const fillUnits = (tenantId: string, count: number) =>
      raw.tenantUnit.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          tenantId,
          name: `U${i}`,
          nameKey: `u${i}`,
        })),
      });

    it("G6a: a person adds unit #200, then unit #201 is 409 TENANT_UNIT_LIMIT with nothing written; archiving one frees a slot", async () => {
      await fillUnits(A, MAX_ACTIVE_TENANT_UNITS - 1);
      await expect(asA(() => service.create({ name: "Crate" }, user))).resolves.toMatchObject({
        name: "Crate",
      });
      expect(await raw.tenantUnit.count({ where: { tenantId: A, archivedAt: null } })).toBe(200);
      const err = await asA(() => service.create({ name: "Tray" }, user)).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: API_ERROR_CODES.TENANT_UNIT_LIMIT,
        limit: MAX_ACTIVE_TENANT_UNITS,
        active: MAX_ACTIVE_TENANT_UNITS,
      });
      expect(await raw.tenantUnit.count({ where: { tenantId: A, nameKey: "tray" } })).toBe(0);
      expect(await raw.tenantUnit.count({ where: { tenantId: A } })).toBe(200);
      // Another tenant is not held back by A's full list.
      await expect(asB(() => service.create({ name: "Tray" }, user))).resolves.toMatchObject({
        name: "Tray",
      });
      const one = await raw.tenantUnit.findFirst({ where: { tenantId: A, nameKey: "u0" } });
      await asA(() => service.update(one!.id, { archived: true }, user));
      await expect(asA(() => service.create({ name: "Tray" }, user))).resolves.toMatchObject({
        name: "Tray",
      });
      expect(await raw.tenantUnit.count({ where: { tenantId: A, archivedAt: null } })).toBe(200);
    });

    it("G6b: a level write that would auto-add a unit at the cap saves unlinked with unitNotListed and adds no TenantUnit; with room it links", async () => {
      await fillUnits(A, MAX_ACTIVE_TENANT_UNITS);
      const p = await product(A, "Mug");
      const full = await asA(() =>
        productUnits.create(p.id, { label: "Crate", factorToBase: 12 }, operatorId),
      );
      expect(full).toMatchObject({ label: "Crate", factorToBase: 12, unitNotListed: ["Crate"] });
      const saved = await raw.productUnit.findFirst({ where: { productId: p.id, label: "Crate" } });
      expect(saved).toMatchObject({ tenantUnitId: null, factorToBase: 12 });
      expect(await raw.tenantUnit.count({ where: { tenantId: A } })).toBe(200);
      expect(await raw.tenantUnit.count({ where: { tenantId: A, nameKey: "crate" } })).toBe(0);
      expect(
        await raw.auditLog.count({ where: { tenantId: A, action: "tenant_unit.created" } }),
      ).toBe(0);
      // Control: free one slot and the same kind of write adds the unit and links the level to it.
      const one = await raw.tenantUnit.findFirst({ where: { tenantId: A, nameKey: "u0" } });
      await asA(() => service.update(one!.id, { archived: true }, user));
      const roomy = await asA(() =>
        productUnits.create(p.id, { label: "Tray", factorToBase: 24 }, operatorId),
      );
      expect(roomy).not.toHaveProperty("unitNotListed");
      const tray = await raw.tenantUnit.findFirst({ where: { tenantId: A, nameKey: "tray" } });
      expect(tray).not.toBeNull();
      expect(
        (await raw.productUnit.findFirst({ where: { productId: p.id, label: "Tray" } }))
          ?.tenantUnitId,
      ).toBe(tray!.id);
    });

    describe("G6e: the units list sends exactly one usage query, however many units there are", () => {
      /** Run `list()` on the statement-logging client and return the SELECTs it sent. */
      const listSelects = async () => {
        queries.length = 0;
        const rows = await ctx.run(A, () => countingService.list());
        await new Promise((resolve) => setTimeout(resolve, 100)); // query events are delivered async
        return { rows, selects: queries.filter((q) => /^\s*(WITH|SELECT)/i.test(q.query)) };
      };

      it("1 unit: one statement, and it carries the count", async () => {
        const unit = await asA(() => service.create({ name: "Case" }, user));
        await product(A, "P1", { unit: "Case" });
        const { rows, selects } = await listSelects();
        expect(selects).toHaveLength(1);
        expect(selects[0].query).toMatch(/"Product"/);
        expect(rows.map((r) => [r.id, r.productCount])).toEqual([[unit.id, 1]]);
      });

      it("200 units: still one statement, and the counts are right", async () => {
        await fillUnits(A, MAX_ACTIVE_TENANT_UNITS);
        await product(A, "P1", { unit: "U7" });
        await product(A, "P2", { packLabel: " u7 ", baseUnitLabel: "U199" });
        const { rows, selects } = await listSelects();
        expect(selects).toHaveLength(1);
        expect(rows).toHaveLength(MAX_ACTIVE_TENANT_UNITS);
        const count = (name: string) => rows.find((r) => r.name === name)?.productCount;
        expect(count("U7")).toBe(2);
        expect(count("U199")).toBe(1);
        expect(count("U0")).toBe(0);
      });
    });
  });

  describe("N2 (SA-797): the pack precondition is a VALUE compare, through the real PATCH controller", () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });
    /** The body goes through the same ValidationPipe options main.ts uses, then the real controller. */
    const patch = async (productId: string, body: Record<string, unknown>) => {
      const dto = (await pipe.transform(body, {
        type: "body",
        metatype: UpdateProductDto,
      })) as UpdateProductDto;
      const jwt = { sub: operatorId, username: "db-spec-op" } as JwtPayload;
      return asA(() => productsController.update(productId, dto, jwt, "RouteFlow/db-spec"));
    };
    const caseProduct = async () => {
      const caseUnit = await asA(() => service.create({ name: "Case" }, user));
      const p = await product(A, "Mug", { unit: "Case", unitsPerBox: 12 });
      return { caseUnit, p };
    };

    it("a purchase received while the form was open moves updatedAt but not the pack: the save with the expected pack succeeds", async () => {
      const { caseUnit, p } = await caseProduct();
      const opened = await asA(() => products.findOne(p.id)); // the form "opens": it reads the pack
      expect(opened).toMatchObject({
        unit: "Case",
        unitsPerBox: 12,
        packTenantUnitId: caseUnit.id,
      });

      await asA(() =>
        inventory.recordPurchase({ productId: p.id, quantity: 24, unitCost: 2 }, operatorId),
      );
      const afterBuy = await raw.product.findUnique({ where: { id: p.id } });
      expect(afterBuy!.updatedAt.getTime()).toBeGreaterThan(opened.updatedAt.getTime());
      expect(Number(afterBuy!.currentStock)).toBe(24);

      const saved = await patch(p.id, {
        unit: "Carton",
        expectedUnit: opened.unit,
        expectedUnitsPerBox: opened.unitsPerBox,
        expectedTenantUnitId: opened.packTenantUnitId,
      });
      expect(saved).toMatchObject({ unit: "Carton", unitsPerBox: 12 });
      const row = await raw.product.findUnique({ where: { id: p.id } });
      expect(row).toMatchObject({ unit: "Carton", unitsPerBox: 12 });
      expect(Number(row!.currentStock)).toBe(24); // the receipt survived the save
    });

    it("a pack-word rename committed between open and save is 409 PRODUCT_PACK_STALE and nothing is written", async () => {
      const { caseUnit, p } = await caseProduct();
      const opened = await asA(() => products.findOne(p.id));
      // Another operator renames the unit (it rewrites Product.unit) while the form is open.
      await asA(() => service.update(caseUnit.id, { name: "Carton" }, user));
      const before = await raw.product.findUnique({ where: { id: p.id } });
      expect(before!.unit).toBe("Carton");

      const err = await patch(p.id, {
        name: "Mug 2",
        unit: "Crate",
        expectedUnit: opened.unit,
        expectedUnitsPerBox: opened.unitsPerBox,
        expectedTenantUnitId: opened.packTenantUnitId,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.PRODUCT_PACK_STALE });
      // Neither the pack word nor the name in the same PATCH was written.
      expect(await raw.product.findUnique({ where: { id: p.id } })).toEqual(before);
      expect((await raw.tenantUnit.findUnique({ where: { id: caseUnit.id } }))?.name).toBe(
        "Carton",
      );
    });
  });
});
