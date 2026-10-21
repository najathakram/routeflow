/**
 * H2 DB-lane proof (SA #3457 MUST 1): a reparent never silently drops a selling ban, against real Postgres.
 *
 * Every other H2 spec runs on LabelFakeDb / a mocked Prisma. This one drives the REAL service paths — a single move
 * (`ProductsService.update`), the bulk "group as variants" move (`bulkAssignParent`) and an unlink (`parentProductId:
 * null`) — and then asks the two readers the product page and the order paths use:
 *   - the product's restriction chips: `SellingRestrictionsAdminService.productLimits` (GET /selling-restrictions
 *     ?productId=) still lists the CA/NY rule, now reached through the variant's own label (CATEGORY);
 *   - the engine entry every line-writing path calls: `SellingRestrictionsService.checkLinesSellable` (STAFF) still
 *     BLOCKs the variant for a CA and a NY customer (and a TX customer stays ALLOW: the control).
 * It also exercises what a mock cannot: the plan's selects, the label locks taken before the row locks, the kept
 * INCLUDE rows, the `product_label.kept_on_reparent` audit `createMany`, the inert-EXCLUDE -> INCLUDE replacement
 * (its audit names the replaced opt-out), and the coded 409 on an unreadable (cyclic) old chain with nothing written.
 * Concurrency (the setLabel deadlock) is NOT driven here: the harness has no two-connection interleaving helper for
 * this path; the lock ORDER is pinned in products.reparent-lock-order.spec.ts.
 *
 * Collected only by `jest.db.config.js` (`npm run local:test:db`). The tenant is a throwaway `qa-h2keep-<run>` slug
 * approved by `assertTestTenant`; afterAll deletes exactly what it made.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ProductsService } from "./products.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { SellingRestrictionsAdminService } from "../selling-restrictions-admin/selling-restrictions-admin.service";
import { LABEL_KEPT_ON_REPARENT_ACTION } from "../product-categories/label-writer";
import { ProductChainUnreadableError } from "../product-labels/keep-labels-on-reparent";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { plainToInstance } from "class-transformer";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ProductLabelsAdminService } from "../product-categories/product-labels-admin.service";
import { AuditService } from "../audit/audit.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const RULE_REASON = "H2 CA/NY ban";
const ACTOR = { packPrecondition: "internal" as const, actorId: null, actorName: "h2-keep" };

describeDb("H2: a reparent keeps the CA/NY ban (real Postgres)", () => {
  let prisma: PrismaService;
  let ctx: TenantContextService;
  let products: ProductsService;
  let engine: SellingRestrictionsService;
  let admin: SellingRestrictionsAdminService;
  let tenantId: string;
  let categoryId: string;
  let ruleId: string;
  const customers: Record<"CA" | "NY" | "TX", string> = { CA: "", NY: "", TX: "" };

  const as = <T>(fn: () => Promise<T>) => ctx.run(tenantId, fn);
  const mkProduct = async (name: string, extra: Record<string, unknown> = {}) =>
    (
      await prisma.product.create({
        data: { tenantId, name, unit: "each", pricePerUnit: "1.00", ...extra },
      })
    ).id;
  const family = (name: string) => mkProduct(name, { kind: "FAMILY" });
  const variant = (name: string, parentProductId: string) =>
    mkProduct(name, { kind: "VARIANT", parentProductId, variantName: name });

  /** The two readers: the chips list and the engine's BLOCK for each state. */
  async function expectBanned(productId: string) {
    const chips = await as(() => admin.productLimits(productId));
    const chip = chips.items.find((c) => c.id === ruleId);
    expect(chip).toBeDefined();
    expect(chip).toMatchObject({ via: "CATEGORY" });
    for (const state of ["CA", "NY"] as const) {
      const res = await as(() =>
        engine.checkLinesSellable({
          tenantId,
          customerId: customers[state],
          lines: [{ productId, qtyDelta: 1 }],
          channel: "STAFF",
          fulfilmentKind: "DELIVERY",
        }),
      );
      expect(res.outcome).toBe("BLOCK");
      expect(res.reasons[0]).toMatchObject({ reason: "STATE_BAN", state });
    }
    const tx = await as(() =>
      engine.checkLinesSellable({
        tenantId,
        customerId: customers.TX,
        lines: [{ productId, qtyDelta: 1 }],
        channel: "STAFF",
        fulfilmentKind: "DELIVERY",
      }),
    );
    expect(tx.outcome).toBe("ALLOW"); // control: the rule names CA and NY only
  }

  const ownLabel = (productId: string) =>
    prisma.productCategoryLabel.findFirst({ where: { tenantId, productId, categoryId } });
  const keptAudits = (productId: string) =>
    prisma.auditLog.findMany({
      where: { tenantId, entityId: productId, action: LABEL_KEPT_ON_REPARENT_ACTION },
    });

  async function mkCustomer(state: "CA" | "NY" | "TX") {
    const handle = `h2keep-${RUN}-${state.toLowerCase()}`;
    const user = await prisma.user.create({
      data: { email: `${handle}@example.invalid`, username: handle, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `Acme ${state}`, contactName: "H2", tenantId },
    });
    await prisma.customerAddress.create({
      data: {
        tenantId,
        customerId: customer.id,
        line1: "1 Test St",
        city: "Testville",
        state,
        stateCode: state,
        zip: "00000",
        isDefault: true,
        addressType: "BILLING",
      },
    });
    customers[state] = customer.id;
  }

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    ctx = new TenantContextService();
    prisma = new PrismaService(ctx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest.fn().mockResolvedValue([]),
            upload: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
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
    products = module.get(ProductsService);
    const labels = new ProductLabelsService(prisma);
    engine = new SellingRestrictionsService(prisma, labels);
    admin = new SellingRestrictionsAdminService(prisma, labels);

    const slug = assertTestTenant(`qa-h2keep-${RUN}`, "reparent-keeps-bans.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `H2 keep ${slug}` } })).id;
    await prisma.systemConfig.create({
      data: { tenantId, key: "selling_restrictions.enabled", value: "true" },
    });
    categoryId = (await prisma.productCategory.create({ data: { tenantId, name: "Hemp" } })).id;
    ruleId = (
      await prisma.sellingRestriction.create({
        data: {
          tenantId,
          categoryId,
          jurisdiction: "STATE",
          states: ["CA", "NY"],
          reason: RULE_REASON,
          effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        },
      })
    ).id;
    for (const s of ["CA", "NY", "TX"] as const) await mkCustomer(s);
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await prisma.auditLog.deleteMany({ where: { tenantId } });
      await prisma.sellingRestriction.deleteMany({ where: { tenantId } });
      await prisma.productCategoryLabel.deleteMany({ where: { tenantId } });
      await prisma.systemConfig.deleteMany({ where: { tenantId } });
      await prisma.customerAddress.deleteMany({ where: { tenantId } });
      await prisma.customer.deleteMany({ where: { tenantId } });
      await prisma.stockMovement.deleteMany({ where: { tenantId } });
      await prisma.stockLot.deleteMany({ where: { tenantId } });
      // Break any link (incl. the cycle the last case writes), then delete: no FK order to get wrong.
      await prisma.product.updateMany({ where: { tenantId }, data: { parentProductId: null } });
      await prisma.product.deleteMany({ where: { tenantId } });
      await prisma.productCategory.deleteMany({ where: { tenantId } });
      await prisma.user.deleteMany({ where: { tenantId } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    }
    await prisma?.$disconnect();
  }, 120_000);

  /** A labelled family (carries the ban), an unlabelled one, and `n` variants of the first. */
  async function world(tag: string, n: number) {
    const banned = await family(`${tag} banned family`);
    const clean = await family(`${tag} clean family`);
    await prisma.productCategoryLabel.create({
      data: { tenantId, productId: banned, categoryId, mode: "INCLUDE" },
    });
    const kids: string[] = [];
    for (let i = 0; i < n; i++) kids.push(await variant(`${tag} v${i}`, banned));
    return { banned, clean, kids };
  }

  it("single move: the variant keeps its own INCLUDE, one audit row, and is still listed + BLOCKed in CA/NY", async () => {
    const { banned, clean, kids } = await world("single", 1);
    const [v] = kids;
    await expectBanned(v); // before: inherited through the banned family

    const out = (await as(() =>
      products.update(v, { parentProductId: clean } as never, ACTOR),
    )) as { parentProductId: string | null; keptLabels?: string[] };

    expect(out.parentProductId).toBe(clean);
    expect(out.keptLabels).toEqual(["Hemp"]);
    expect(await ownLabel(v)).toMatchObject({ mode: "INCLUDE", reason: null });
    const audits = await keptAudits(v);
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({
      categoryId,
      source: "reparent",
      fromParentProductId: banned,
      toParentProductId: clean,
    });
    await expectBanned(v);
  }, 60_000);

  it("bulk move: every child keeps the ban, reported per child, each listed + BLOCKed in CA/NY", async () => {
    const { clean, kids } = await world("bulk", 2);
    const result = await as(() =>
      products.bulkAssignParent(
        {
          parentProductId: clean,
          assignments: kids.map((id, i) => ({ id, variantName: `bulk moved ${i}` })),
        } as never,
        ACTOR,
      ),
    );
    expect(result.failed).toEqual([]);
    expect([...result.succeeded].sort()).toEqual([...kids].sort());
    expect(result.keptLabels.map((k) => k.id).sort()).toEqual([...kids].sort());
    for (const k of result.keptLabels) expect(k.labels).toEqual(["Hemp"]);
    for (const id of kids) {
      expect(await ownLabel(id)).toMatchObject({ mode: "INCLUDE" });
      expect(await keptAudits(id)).toHaveLength(1);
      await expectBanned(id);
    }
  }, 60_000);

  it("unlink: the standalone product keeps the ban; an INERT opt-out is replaced by the INCLUDE and named in the audit", async () => {
    const { kids } = await world("unlink", 1);
    const [v] = kids;
    // An opt-out written with no pin is inert (the ban still applies through the family).
    const optOut = await prisma.productCategoryLabel.create({
      data: { tenantId, productId: v, categoryId, mode: "EXCLUDE", reason: "seed approval" },
    });
    await expectBanned(v);

    const out = (await as(() => products.update(v, { parentProductId: null } as never, ACTOR))) as {
      parentProductId: string | null;
      kind: string;
      keptLabels?: string[];
    };

    expect(out.parentProductId).toBeNull();
    expect(out.kind).toBe("STANDARD");
    expect(out.keptLabels).toEqual(["Hemp"]);
    const rows = await prisma.productCategoryLabel.findMany({ where: { tenantId, productId: v } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: "INCLUDE", categoryId });
    expect(rows[0].id).not.toBe(optOut.id);
    const audits = await keptAudits(v);
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({
      toParentProductId: null,
      replacedOptOut: { id: optOut.id, reason: "seed approval" },
    });
    await expectBanned(v);
  }, 60_000);

  it("#3467 x H2: unlinking a variant under a FEDERAL-labelled family keeps it blocked, and an operator cannot remove the kept label", async () => {
    const fedCategory = (
      await prisma.productCategory.create({ data: { tenantId, name: `Federal ${RUN}` } })
    ).id;
    await prisma.sellingRestriction.create({
      data: {
        tenantId,
        categoryId: fedCategory,
        jurisdiction: "FEDERAL",
        states: [],
        surface: "ALL",
        reason: `federal ${RUN}`,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const fam = await family("fed family");
    await prisma.productCategoryLabel.create({
      data: { tenantId, productId: fam, categoryId: fedCategory, mode: "INCLUDE" },
    });
    const v = await variant("fed v0", fam);
    const blocked = async () =>
      (
        await as(() =>
          engine.checkLinesSellable({
            tenantId,
            customerId: customers.TX,
            lines: [{ productId: v, qtyDelta: 1 }],
            channel: "STAFF",
            fulfilmentKind: "DELIVERY",
          }),
        )
      ).outcome;
    expect(await blocked()).toBe("BLOCK");

    // The web Unlink body, through the same transform the ValidationPipe applies.
    const body = plainToInstance(UpdateProductDto, { parentProductId: null });
    const out = (await as(() => products.update(v, body as never, ACTOR))) as {
      parentProductId: string | null;
    };
    expect(out.parentProductId).toBeNull();
    expect(await blocked()).toBe("BLOCK");

    const labelsAdmin = new ProductLabelsAdminService(
      prisma,
      new AuditService(prisma),
      new ProductLabelsService(prisma),
    );
    const operator = { sub: "op", username: "op", role: "OPERATOR" } as never;
    const refusal = await as(() => labelsAdmin.removeLabel(v, fedCategory, operator)).catch(
      (e: { getResponse(): unknown }) => e.getResponse(),
    );
    expect(refusal).toMatchObject({ code: "RULE_ADMIN_ONLY" });
    expect(
      await prisma.productCategoryLabel.findFirst({
        where: { tenantId, productId: v, categoryId: fedCategory, mode: "INCLUDE" },
      }),
    ).not.toBeNull();
    expect(await blocked()).toBe("BLOCK");
  }, 60_000);

  it("an unreadable (cyclic) old chain is the coded 409, and nothing is written", async () => {
    const { banned, clean, kids } = await world("cycle", 1);
    const [v] = kids;
    const loop = await family("cycle loop");
    // Written around the service (it would refuse it): banned -> loop -> banned.
    await prisma.product.update({ where: { id: banned }, data: { parentProductId: loop } });
    await prisma.product.update({ where: { id: loop }, data: { parentProductId: banned } });

    const err = await as(() => products.update(v, { parentProductId: clean } as never, ACTOR)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProductChainUnreadableError);
    expect((err as ProductChainUnreadableError).getStatus()).toBe(409);
    expect((err as ProductChainUnreadableError).getResponse()).toMatchObject({
      code: API_ERROR_CODES.PRODUCT_CHAIN_UNREADABLE,
    });
    const after = await prisma.product.findUniqueOrThrow({ where: { id: v } });
    expect(after.parentProductId).toBe(banned);
    expect(await ownLabel(v)).toBeNull();
    expect(await keptAudits(v)).toHaveLength(0);
  }, 60_000);
});
