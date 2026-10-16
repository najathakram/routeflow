/**
 * SA-322 (carried by #2185) — the reorder gate ships DARK. `flag.forecasting` is in DARK_PLAN_FLAGS
 * and PLAN_FLAG_ENFORCEMENT stays off, so `assertReorderAllowed`:
 *   - ALLOWS every reorder writer (create / update / bulk import / the CSV importer's file gate)
 *     and logs ONE "would deny (dark)" warning whenever the EntitlementAuthority's own
 *     resolution (preset + grants − denies, the one rule) says the tenant would be refused once the
 *     flag is enforced — so the blast radius is readable before the flip;
 *   - with enforcement ON, refuses with the readable PLAN_GATE 403, exactly as the inventory route's
 *     PlanFlagGuard does.
 * No second plan-lookup path: the would-deny reads `authority.resolveAll` (the same resolver).
 */
import { ForbiddenException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ProductsService } from "./products.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";

const FLAG = "flag.forecasting";
const resolved = (effective: boolean) => ({ byKey: new Map([[FLAG, { effective }]]) });

describe("SA-322 reorder gate — dark shape (allow + would-deny warn) and enforced 403", () => {
  let service: ProductsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let authority: { can: jest.Mock; resolveAll: jest.Mock };
  let warn: jest.SpyInstance;
  const savedEnv = process.env.PLAN_FLAG_ENFORCEMENT;

  beforeEach(async () => {
    delete process.env.PLAN_FLAG_ENFORCEMENT; // dark
    prisma = createMockPrisma();
    authority = { can: jest.fn().mockResolvedValue(true), resolveAll: jest.fn() };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: { presignedUrl: jest.fn(), presignedUrls: jest.fn().mockResolvedValue([]) },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: EntitlementAuthority, useValue: authority },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn(), resolve: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: PlanCatalogService,
          useValue: {
            upgradeTargetForFlag: jest.fn().mockResolvedValue({
              planKey: "GROWTH",
              planMonthlyPrice: 99,
              addonSku: null,
              addonMonthlyPrice: null,
            }),
          },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ProductsService);
    warn = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
    else process.env.PLAN_FLAG_ENFORCEMENT = savedEnv;
  });

  const wouldDenyWarns = () =>
    warn.mock.calls.filter((c) => String(c[0]).includes("would deny (dark)"));

  it("DARK, tenant not entitled (resolver effective=false): allows and logs ONE would-deny warn naming flag + tenant", async () => {
    authority.resolveAll.mockResolvedValue(resolved(false));
    await expect(service.assertReorderAllowed()).resolves.toBeUndefined();
    expect(wouldDenyWarns()).toHaveLength(1);
    expect(String(wouldDenyWarns()[0][0])).toContain(`flag=${FLAG}`);
    expect(String(wouldDenyWarns()[0][0])).toContain("tenant=test-tenant");
  });

  it("DARK, tenant entitled (effective=true): allows silently", async () => {
    authority.resolveAll.mockResolvedValue(resolved(true));
    await expect(service.assertReorderAllowed()).resolves.toBeUndefined();
    expect(wouldDenyWarns()).toHaveLength(0);
  });

  it("DARK, resolver unavailable (null): allows, no warn, no throw", async () => {
    authority.resolveAll.mockResolvedValue(null);
    await expect(service.assertReorderAllowed()).resolves.toBeUndefined();
    expect(wouldDenyWarns()).toHaveLength(0);
  });

  it("DARK: create() with a reorder value still WRITES and warns", async () => {
    authority.resolveAll.mockResolvedValue(resolved(false));
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.create.mockResolvedValue({ id: "prod-new", name: "W" });
    await service.create({
      name: "W",
      sku: "W-1",
      unit: "each",
      pricePerUnit: 1,
      reorderPoint: 5,
    } as any);
    expect(prisma.product.create).toHaveBeenCalled();
    expect(wouldDenyWarns()).toHaveLength(1);
  });

  it("DARK: update() with a reorder value still WRITES and warns", async () => {
    authority.resolveAll.mockResolvedValue(resolved(false));
    prisma.product.findUnique.mockResolvedValue({ id: "p1", name: "W", imageKeys: [] } as any);
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.update.mockResolvedValue({ id: "p1", name: "W" } as any);
    await service.update("p1", { reorderQty: 9 } as any, { packPrecondition: "internal" });
    expect(prisma.product.update).toHaveBeenCalled();
    expect(wouldDenyWarns()).toHaveLength(1);
  });

  it("DARK: the bulk import with a reorderPoint item is NOT refused (the gate allows and warns)", async () => {
    authority.resolveAll.mockResolvedValue(resolved(false));
    prisma.product.findFirst.mockResolvedValue(null);
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.create.mockResolvedValue({ id: "z1", name: "Z" });
    await expect(
      service.importFromZoho({ items: [{ name: "Z", sku: "Z-1", reorderPoint: 3 }] } as any),
    ).resolves.toBeDefined();
    expect(wouldDenyWarns().length).toBeGreaterThanOrEqual(1);
  });

  it("ENFORCED (PLAN_FLAG_ENFORCEMENT=on), not entitled: a readable PLAN_GATE 403, and no would-deny warn", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    authority.can.mockResolvedValue(false);
    const err = await service.assertReorderAllowed().catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ code: "PLAN_GATE" });
    expect(wouldDenyWarns()).toHaveLength(0);
  });

  it("ENFORCED, entitled: allows with no warn", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    authority.can.mockResolvedValue(true);
    await expect(service.assertReorderAllowed()).resolves.toBeUndefined();
    expect(authority.resolveAll).not.toHaveBeenCalled();
    expect(wouldDenyWarns()).toHaveLength(0);
  });

  it("the flag is in DARK_PLAN_FLAGS and no second lookup is used (the would-deny reads the authority's resolver)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DARK_PLAN_FLAGS } = require("../billing/plan-flag.guard");
    expect(DARK_PLAN_FLAGS.has(FLAG)).toBe(true);
    authority.resolveAll.mockResolvedValue(resolved(false));
    await service.assertReorderAllowed();
    expect(authority.resolveAll).toHaveBeenCalledTimes(1);
  });
});
