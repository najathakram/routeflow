/**
 * SA-1032 — with promotions off, order pricing sees no promotion (real Postgres).
 *
 * Every buyer order path prices promotions through `OrdersService.loadActivePromotions`: the buyer
 * create and merge paths, and the standing-order generator (order-templates.service.ts, which
 * prices a standing order as the customer's own checkout). This drives that seam on a REAL
 * OrdersService (buildDbOrdersService) wired to the REAL PromotionsService and FeatureConfigService.
 *
 *  - P-R2: off → the buyer (CUSTOMER) order path gets no promotion rules.
 *  - P-R6: off → the standing-order generator's read (same call, CUSTOMER role) gets none either.
 *  - P-G2: no config row → the buyer path still gets the active promotion (today's behaviour).
 *  - P-G3: staff paths stay promotion-free whatever the mode.
 *
 * Throwaway `qa-promo-orders-*` tenants (assertTestTenant), removed in afterAll. DB lane.
 */
import "reflect-metadata";
import { randomUUID } from "crypto";
import { PromotionScope, PromotionType, UserRole } from "@prisma/client";
import { Logger } from "@nestjs/common";

jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class {} }));
jest.mock("../notifications/notifications.service", () => ({ NotificationsService: class {} }));

import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { buildDbOrdersService } from "../common/testing/orders-service-db-harness";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PromotionsService } from "../promotions/promotions.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const DAY = 24 * 60 * 60 * 1000;

describeDb("SA-1032 — order pricing with promotions off (real Postgres)", () => {
  let tenantCtx: TenantContextService;
  let prisma: PrismaService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    process.env.DATABASE_URL = requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.promotionProduct.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.promotion.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantFeatureConfig.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma?.$disconnect();
  });

  /** A real OrdersService whose promotion read is the real, mode-aware PromotionsService. */
  function ordersService() {
    const featureConfig = new FeatureConfigService(
      prisma as any,
      new FeatureConfigStore(prisma as any),
      new AuditService(prisma as any),
      { can: async () => true } as any,
      { hasFlag: async () => true } as any,
      new FeatureOverrideService(prisma as any),
    );
    const orders = buildDbOrdersService(prisma, tenantCtx);
    orders.promotionsService = new (PromotionsService as any)(prisma, featureConfig);
    return orders;
  }

  async function seed(mode?: "on" | "off") {
    const slug = `qa-promo-orders-${run}-${++seq}`;
    assertTestTenant(slug);
    const t = await prisma.tenant.create({ data: { slug, name: slug } });
    tenantIds.push(t.id);
    if (mode) {
      await prisma.tenantFeatureConfig.create({
        data: { tenantId: t.id, featureKey: "promotions", mode, reason: "SA-1032 spec" },
      });
    }
    const now = Date.now();
    const p = await prisma.promotion.create({
      data: {
        tenantId: t.id,
        name: "Ten off",
        type: PromotionType.PERCENT,
        value: 10,
        scope: PromotionScope.ALL,
        startsAt: new Date(now - DAY),
        endsAt: new Date(now + 7 * DAY),
        isActive: true,
      },
    });
    return { tenantId: t.id, promoId: p.id };
  }

  const rules = (tenantId: string, role: UserRole) =>
    tenantCtx.run(tenantId, () => ordersService().loadActivePromotions(role));

  it("P-R2: off → the buyer order path prices no promotion", async () => {
    const s = await seed("off");
    expect(await rules(s.tenantId, UserRole.CUSTOMER)).toEqual([]);
  });

  it("P-R6: off → the standing-order generator's read (CUSTOMER role) prices none", async () => {
    // order-templates.service.ts prices a standing order via loadActivePromotions(CUSTOMER),
    // whoever triggers the run; the same call must come back empty while off.
    const s = await seed("off");
    const [first, second] = await Promise.all([
      rules(s.tenantId, UserRole.CUSTOMER),
      rules(s.tenantId, UserRole.CUSTOMER),
    ]);
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it("P-G2: no config row → the buyer order path still gets the active promotion", async () => {
    const s = await seed();
    const got = await rules(s.tenantId, UserRole.CUSTOMER);
    expect(got.map((r: any) => r.id)).toEqual([s.promoId]);
  });

  it("P-G3: staff order pricing stays promotion-free in both modes", async () => {
    const on = await seed("on");
    const off = await seed("off");
    expect(await rules(on.tenantId, UserRole.OPERATOR)).toEqual([]);
    expect(await rules(off.tenantId, UserRole.OPERATOR)).toEqual([]);
  });
});
