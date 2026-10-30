/**
 * SA-1032 — promotions can be turned off per business from the back office (real Postgres).
 *
 * The `promotions` feature-config key (modes on/off, fallback on). Off means:
 *  - the buyer-facing read (`activeForCatalog`) returns nothing, so no new order prices a promotion;
 *  - create / update / pause / delete are refused with 403 PROMOTIONS_OFF and change nothing;
 *  - the staff list and detail reads still work (read-only page);
 *  - no stored row is touched, so turning it back on restores every promotion exactly.
 * No row at all behaves as today (on).
 *
 * Driven through the REAL PromotionsService over a tenant-scoped PrismaService and the REAL
 * FeatureConfigService (store reads TenantFeatureConfig). Throwaway `qa-promo-mode-*` tenants,
 * approved by `assertTestTenant`, removed in afterAll. DB lane (`npm run local:test:db`).
 */
import "reflect-metadata";
import { randomUUID } from "crypto";
import { PromotionScope, PromotionType } from "@prisma/client";
import { ForbiddenException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureConfigStore } from "../billing/feature-config.store";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { PromotionsService } from "./promotions.service";
import { BuyerCatalogService } from "../buyer/buyer-catalog.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const DAY = 24 * 60 * 60 * 1000;

describeDb("SA-1032 — promotions on/off per business (real Postgres)", () => {
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
      await prisma.product.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma?.$disconnect();
  });

  /** A fresh service pair per case: FeatureConfigStore caches a successful read per tenant+key. */
  function services() {
    const featureOverrides = new FeatureOverrideService(prisma as any);
    const featureConfig = new FeatureConfigService(
      prisma as any,
      new FeatureConfigStore(prisma as any),
      new AuditService(prisma as any),
      { can: async () => true } as any, // addons: promotions modes declare no `requires`
      { hasFlag: async () => true } as any, // entitlements
      featureOverrides,
    );
    // Two-arg construction keeps this spec compiling on the pre-change one-arg constructor.
    const promotions: PromotionsService = new (PromotionsService as any)(prisma, featureConfig);
    return { promotions, featureConfig };
  }

  async function tenant(mode?: "on" | "off"): Promise<string> {
    const slug = `qa-promo-mode-${run}-${++seq}`;
    assertTestTenant(slug);
    const t = await prisma.tenant.create({ data: { slug, name: slug } });
    tenantIds.push(t.id);
    if (mode) await setMode(t.id, mode);
    return t.id;
  }

  async function setMode(tenantId: string, mode: "on" | "off") {
    await prisma.tenantFeatureConfig.upsert({
      where: { tenantId_featureKey: { tenantId, featureKey: "promotions" } },
      create: { tenantId, featureKey: "promotions", mode, reason: "SA-1032 spec" },
      update: { mode },
    });
  }

  /** An active, in-window ALL-scope 10% promotion. */
  async function promo(tenantId: string, name = "Ten off") {
    const now = Date.now();
    return prisma.promotion.create({
      data: {
        tenantId,
        name,
        type: PromotionType.PERCENT,
        value: 10,
        scope: PromotionScope.ALL,
        startsAt: new Date(now - DAY),
        endsAt: new Date(now + 7 * DAY),
        isActive: true,
      },
    });
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  async function expectPromotionsOff(p: Promise<unknown>) {
    let err: unknown;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: "PROMOTIONS_OFF", // API_ERROR_CODES.PROMOTIONS_OFF (literal so the red compiles on master)
    });
  }

  it("P-R1: off → the buyer-facing active read returns nothing", async () => {
    const t = await tenant("off");
    await promo(t);
    const { promotions } = services();
    const active = await inTenant(t, () => promotions.activeForCatalog());
    expect(active).toEqual([]);
  });

  it("P-G1: no config row → the active promotion is served as today", async () => {
    const t = await tenant();
    const p = await promo(t);
    const { promotions } = services();
    const active = await inTenant(t, () => promotions.activeForCatalog());
    expect(active.map((a: any) => a.id)).toEqual([p.id]);
  });

  it("P-G1b: explicit on → the active promotion is served", async () => {
    const t = await tenant("on");
    const p = await promo(t);
    const { promotions } = services();
    const active = await inTenant(t, () => promotions.activeForCatalog());
    expect(active.map((a: any) => a.id)).toEqual([p.id]);
  });

  it("P-R3: off → create, update, pause and delete are refused and change nothing", async () => {
    const t = await tenant("off");
    const p = await promo(t);
    const before = await prisma.promotion.findUniqueOrThrow({ where: { id: p.id } });
    const { promotions } = services();
    const now = Date.now();
    await inTenant(t, async () => {
      await expectPromotionsOff(
        promotions.create({
          name: "New one",
          type: PromotionType.PERCENT,
          value: 5,
          scope: PromotionScope.ALL,
          startsAt: new Date(now).toISOString(),
          endsAt: new Date(now + DAY).toISOString(),
        } as any),
      );
      await expectPromotionsOff(promotions.update(p.id, { name: "Renamed" } as any));
      await expectPromotionsOff(promotions.setActive(p.id, false));
      await expectPromotionsOff(promotions.remove(p.id));
    });
    expect(await prisma.promotion.count({ where: { tenantId: t } })).toBe(1);
    const after = await prisma.promotion.findUniqueOrThrow({ where: { id: p.id } });
    expect(after).toEqual(before);
  });

  it("P-G4: off → the staff list and detail reads still work", async () => {
    const t = await tenant("off");
    const p = await promo(t);
    const { promotions } = services();
    const list = await inTenant(t, () => promotions.findAll());
    expect(list.map((x: any) => x.id)).toEqual([p.id]);
    const one = await inTenant(t, () => promotions.findOne(p.id));
    expect(one.id).toBe(p.id);
  });

  it("P-G5: off then on → every promotion comes back unchanged", async () => {
    const t = await tenant("on");
    const p = await promo(t);
    const before = await prisma.promotion.findUniqueOrThrow({ where: { id: p.id } });
    await setMode(t, "off");
    expect(await inTenant(t, () => services().promotions.activeForCatalog())).toEqual([]);
    await setMode(t, "on");
    const active = await inTenant(t, () => services().promotions.activeForCatalog());
    expect(active.map((a: any) => a.id)).toEqual([p.id]);
    expect(await prisma.promotion.findUniqueOrThrow({ where: { id: p.id } })).toEqual(before);
  });

  it("P-R5: outside any tenant context the active read returns nothing", async () => {
    const a = await tenant();
    const b = await tenant();
    await promo(a, "A promo");
    await promo(b, "B promo");
    const { promotions } = services();
    let result: unknown;
    try {
      result = await tenantCtx.run(null, () => promotions.activeForCatalog());
    } catch (e) {
      result = e;
    }
    expect(result).toEqual([]);
  });

  it("P-G6: off → the Deals collection holds exactly the isDeal product (the merch flag is not a promotion)", async () => {
    const t = await tenant("off");
    await promo(t); // ALL scope: on, it would make every product a deal
    const product = (name: string, isDeal: boolean) =>
      prisma.product.create({
        data: {
          tenantId: t,
          name,
          sku: `${name}-${run}`,
          unit: "unit",
          pricePerUnit: "10",
          isDeal,
        },
      });
    const deal = await product("deal", true);
    await product("plain", false);
    const { promotions } = services();
    // The catalog's own deals fragment over the real active read, as `collection: "deals"` and the rail count build it.
    const catalog = Object.create(BuyerCatalogService.prototype) as {
      dealsWhere: (promos: unknown[]) => Record<string, unknown>;
    };
    const where = {
      AND: [
        { tenantId: t },
        catalog.dealsWhere(await inTenant(t, () => promotions.activeForCatalog())),
      ],
    };
    const rows = await prisma.product.findMany({ where, select: { id: true } });
    expect(rows.map((r) => r.id)).toEqual([deal.id]);
    expect(await prisma.product.count({ where })).toBe(1);
  });
});
