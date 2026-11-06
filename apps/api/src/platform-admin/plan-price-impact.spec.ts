// SA-733 D8: the fan-out runs each sync under a per-tenant Postgres advisory lock; there is no
// database here, so the lock is a PASS-THROUGH that still runs the body.
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PlatformAdminService } from "./platform-admin.service";
import { PLAN_PRICE_IMPACT_CHANGED } from "./plan-price-impact";

/**
 * R24 / T24 (API leg): `GET platform-admin/plans/:planKey/price-impact?monthly=<n>` answers "how many
 * businesses would this price change re-price, and by how much" BEFORE the PATCH runs. The count must
 * be the PATCH's own selection (`updated`), so the dialog can never promise a different number than the
 * fan-out then delivers; and the read writes nothing (no plan row, no Stripe, no audit row).
 */

interface Row {
  tenantId: string;
  planKey: string | null;
  tenantPlan: string;
  priceOverrideMonthly: number | null;
  downgradeToPlanKey: string | null;
  deleted: boolean;
}

const row = (over: Partial<Row> & { tenantId: string }): Row => ({
  planKey: "GROWTH",
  tenantPlan: "GROWTH",
  priceOverrideMonthly: null,
  downgradeToPlanKey: null,
  deleted: false,
  ...over,
});

// Three on the catalog price (a, b by legacy enum, e with a downgrade armed but NOT yet pushed),
// one whose downgrade price is already pushed to Stripe (d: the fan-out skips it), one on another
// plan (c); own-price: f counts, g is deleted, h is on another plan.
const FIXTURE: Row[] = [
  row({ tenantId: "a" }),
  row({ tenantId: "b", planKey: null }),
  row({ tenantId: "c", planKey: "STARTER", tenantPlan: "STARTER" }),
  row({ tenantId: "d", downgradeToPlanKey: "STARTER" }),
  row({ tenantId: "e", downgradeToPlanKey: "SCALE" }),
  row({ tenantId: "z", deleted: true }),
  row({ tenantId: "f", priceOverrideMonthly: 80 }),
  row({ tenantId: "g", priceOverrideMonthly: 80, deleted: true }),
  row({ tenantId: "h", planKey: "STARTER", tenantPlan: "STARTER", priceOverrideMonthly: 30 }),
];
const PUSHED = new Set(["d"]);

function make(currentMonthly = 100) {
  const findMany = jest.fn(async ({ where }: any) =>
    FIXTURE.filter((r) => !(where.tenant?.deletedAt === null && r.deleted))
      .filter((r) =>
        where.priceOverrideMonthly === null
          ? r.priceOverrideMonthly === null
          : r.priceOverrideMonthly !== null,
      )
      .map((r) => ({
        tenantId: r.tenantId,
        planKey: r.planKey,
        downgradeToPlanKey: r.downgradeToPlanKey,
        tenant: { plan: r.tenantPlan },
      })),
  );
  const prisma = {
    tenantSubscription: {
      findMany,
      findUnique: jest.fn(async ({ where }: any) => ({
        downgradeToPlanKey: FIXTURE.find((r) => r.tenantId === where.tenantId)?.downgradeToPlanKey,
      })),
    },
    planDefinition: { update: jest.fn() },
  };
  const planCatalogService = {
    getPublishedVersion: jest.fn().mockResolvedValue({
      id: "v-9",
      definitions: [
        {
          id: "def-1",
          planKey: "GROWTH",
          monthlyPrice: new Prisma.Decimal(currentMonthly),
          isCustom: false,
        },
      ],
    }),
  };
  const billingService = {
    syncStripeSubscriptionPrice: jest.fn().mockResolvedValue({ synced: true }),
  };
  const auditService = { log: jest.fn().mockResolvedValue(undefined) };
  const scheduledPrice = {
    isDowngradePricePushed: jest.fn(async (id: string) => PUSHED.has(id)),
  };
  const service = Object.create(PlatformAdminService.prototype) as any;
  Object.assign(service, {
    prisma,
    planCatalogService,
    billingService,
    auditService,
    scheduledPrice,
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { service: service as PlatformAdminService, prisma, billingService, auditService };
}

describe("R24 plan price impact (the count behind the price-change confirm)", () => {
  it("names how many businesses the change re-prices, how many keep their own price, and the monthly total", async () => {
    const { service } = make(100);
    const out = await service.getPlanPriceImpact("GROWTH", "149");
    expect(out).toEqual({
      planKey: "GROWTH",
      currentMonthly: 100,
      newMonthly: 149,
      affected: 3,
      ownPrice: 1,
      monthlyDelta: 147,
    });
  });

  it("a price drop reports a negative total", async () => {
    const { service } = make(100);
    const out = await service.getPlanPriceImpact("GROWTH", "90");
    expect(out.affected).toBe(3);
    expect(out.monthlyDelta).toBe(-30);
  });

  it("rounds the total to cents (no float residue)", async () => {
    const { service } = make(99.99);
    const out = await service.getPlanPriceImpact("GROWTH", "100.01");
    expect(out.monthlyDelta).toBe(0.06);
  });

  it("the affected count equals the PATCH's `updated` on the same fixture", async () => {
    const { service, prisma } = make(100);
    prisma.planDefinition.update.mockResolvedValue({ monthlyPrice: 149, annualPrice: 1490 });
    const impact = await service.getPlanPriceImpact("GROWTH", "149");
    const patched = await service.updatePlanPrices(
      "GROWTH",
      { monthly: 149, expectedAffected: impact.affected } as any,
      "admin-1",
    );
    expect(patched.updated).toBe(impact.affected);
    expect(patched.skippedDowngrade).toBe(1);
  });

  it("excludes deleted businesses and businesses with their own price from `affected`", async () => {
    const { service, prisma } = make(100);
    await service.getPlanPriceImpact("GROWTH", "149");
    const wheres = prisma.tenantSubscription.findMany.mock.calls.map((c: any) => c[0].where);
    // the affected selection: no own price, not deleted
    expect(
      wheres.some((w: any) => w.priceOverrideMonthly === null && w.tenant.deletedAt === null),
    ).toBe(true);
    // the own-price selection: not deleted either
    expect(
      wheres.some((w: any) => w.priceOverrideMonthly?.not === null && w.tenant.deletedAt === null),
    ).toBe(true);
  });

  it("writes nothing: no plan row, no Stripe sync, no audit row", async () => {
    const { service, prisma, billingService, auditService } = make(100);
    await service.getPlanPriceImpact("GROWTH", "149");
    expect(prisma.planDefinition.update).not.toHaveBeenCalled();
    expect(billingService.syncStripeSubscriptionPrice).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it("refuses a missing, negative, absurd or non-numeric price", async () => {
    const { service } = make(100);
    for (const bad of [undefined, "", "abc", "-1", "100001", "10.999"]) {
      await expect(service.getPlanPriceImpact("GROWTH", bad as any)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it("answers 404 for a plan the catalog does not have", async () => {
    const { service } = make(100);
    await expect(service.getPlanPriceImpact("SCALE", "10")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// SA-1100 §2: the PATCH carries the count the admin confirmed. Before ANY write the server counts again from the same
// selection; a different number answers 409 PLAN_PRICE_IMPACT_CHANGED and nothing is changed.
describe("SA-1100 §2 plan price edit: the confirmed count is re-checked on the server", () => {
  const conflictBody = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictException);
      return (e as ConflictException).getResponse() as Record<string, unknown>;
    }
    throw new Error("expected a 409");
  };

  it("the code is PLAN_PRICE_IMPACT_CHANGED", () => {
    expect(PLAN_PRICE_IMPACT_CHANGED).toBe("PLAN_PRICE_IMPACT_CHANGED");
  });

  it("a count that moved since the confirm answers 409 with the code and the current count", async () => {
    const { service } = make(100);
    const body = await conflictBody(
      service.updatePlanPrices("GROWTH", { monthly: 149, expectedAffected: 2 } as any, "admin-1"),
    );
    expect(body).toMatchObject({
      code: PLAN_PRICE_IMPACT_CHANGED,
      expectedAffected: 2,
      affected: 3,
    });
  });

  it("writes NOTHING on a 409: no plan row, no Stripe sync, no audit row", async () => {
    const { service, prisma, billingService, auditService } = make(100);
    await expect(
      service.updatePlanPrices("GROWTH", { monthly: 149, expectedAffected: 9 } as any, "admin-1"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.planDefinition.update).not.toHaveBeenCalled();
    expect(billingService.syncStripeSubscriptionPrice).not.toHaveBeenCalled();
    expect(auditService.log).not.toHaveBeenCalled();
  });

  it("a missing count is a 409 too: an unconfirmed save never writes", async () => {
    const { service, prisma } = make(100);
    await expect(
      service.updatePlanPrices("GROWTH", { monthly: 149 } as any, "admin-1"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.planDefinition.update).not.toHaveBeenCalled();
  });

  it("the matching count goes through and the fan-out reports the same number", async () => {
    const { service, prisma } = make(100);
    prisma.planDefinition.update.mockResolvedValue({ monthlyPrice: 149, annualPrice: 1490 });
    const out = await service.updatePlanPrices(
      "GROWTH",
      { monthly: 149, expectedAffected: 3 } as any,
      "admin-1",
    );
    expect(prisma.planDefinition.update).toHaveBeenCalledTimes(1);
    expect(out.updated).toBe(3);
  });

  it("the re-count leaves out a pushed-downgrade business exactly as the impact read does", async () => {
    const { service, prisma } = make(100);
    prisma.planDefinition.update.mockResolvedValue({ monthlyPrice: 149, annualPrice: 1490 });
    // 4 businesses are on the plan without an own price, but d is pushed: confirming 4 is the wrong number
    await expect(
      service.updatePlanPrices("GROWTH", { monthly: 149, expectedAffected: 4 } as any, "admin-1"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("the re-count happens before the plan row is touched (check, then write)", async () => {
    const { service, prisma } = make(100);
    prisma.planDefinition.update.mockImplementation(() => {
      throw new Error("must not be reached");
    });
    await expect(
      service.updatePlanPrices("GROWTH", { monthly: 149, expectedAffected: 0 } as any, "admin-1"),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
