import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PlanCatalogService } from "./plan-catalog.service";

const PUBLISHED = {
  id: "planver_v7",
  version: 7,
  status: "PUBLISHED",
  definitions: [],
  addonSkus: [],
};

function makeService() {
  const prisma = {
    planVersion: {
      findFirst: jest.fn().mockResolvedValue(PUBLISHED),
      findUnique: jest.fn(),
    },
  } as any;
  return { svc: new PlanCatalogService(prisma), prisma };
}

describe("PlanCatalogService", () => {
  it("returns the highest published version", async () => {
    const { svc, prisma } = makeService();
    expect(await svc.getPublishedVersion()).toBe(PUBLISHED);
    expect(prisma.planVersion.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "PUBLISHED" }, orderBy: { version: "desc" } }),
    );
  });

  it("getVersionForTenant returns the pinned version when present", async () => {
    const { svc, prisma } = makeService();
    const pinned = { id: "planver_v6", version: 6, definitions: [], addonSkus: [] };
    prisma.planVersion.findUnique.mockResolvedValue(pinned);
    expect(await svc.getVersionForTenant("planver_v6")).toBe(pinned);
  });

  it("getVersionForTenant falls back to published when the pinned version is gone", async () => {
    const { svc, prisma } = makeService();
    prisma.planVersion.findUnique.mockResolvedValue(null);
    expect(await svc.getVersionForTenant("missing")).toBe(PUBLISHED);
  });

  it("getVersionForTenant(null) uses the published version", async () => {
    const { svc } = makeService();
    expect(await svc.getVersionForTenant(null)).toBe(PUBLISHED);
  });

  it("throws when no catalog is seeded", async () => {
    const { svc, prisma } = makeService();
    prisma.planVersion.findFirst.mockResolvedValue(null);
    await expect(svc.getVersionForTenant(null)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getPublishedCatalog()).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getPublicCatalog projects only customer-facing fields (no internal ids/publishedBy/notes)", async () => {
    const prisma = {
      planVersion: {
        findFirst: jest.fn().mockResolvedValue({
          id: "v7",
          version: 7,
          status: "PUBLISHED",
          publishedBy: "admin-1",
          notes: "internal note",
          createdAt: new Date(),
          updatedAt: new Date(),
          effectiveAt: new Date("2026-07-08T00:00:00.000Z"),
          definitions: [
            {
              id: "d1",
              planVersionId: "v7",
              planKey: "STARTER",
              name: "Starter",
              monthlyPrice: 59,
              annualPrice: 590,
              isCustom: false,
              seatsIncluded: 1,
              routesConcurrent: 1,
              scansIncluded: 20,
              msgsIncluded: 200,
              featureFlags: ["addon.ocr"],
              sortOrder: 0,
            },
          ],
          addonSkus: [
            {
              id: "s1",
              planVersionId: "v7",
              sku: "CUSTOMER_PACK_100",
              name: "Customer pack (+100)",
              monthlyPrice: 50,
              unit: "FLAT",
              includedAtPlan: null,
              meteredKey: "CUSTOMERS",
              capacityPerUnit: 100,
              stackable: true,
              grantsFlags: [],
              sortOrder: 0,
            },
          ],
        }),
      },
    } as any;
    const pub = (await new PlanCatalogService(prisma).getPublicCatalog()) as Record<
      string,
      unknown
    >;
    expect(pub.version).toBe(7);
    expect(pub).not.toHaveProperty("id");
    expect(pub).not.toHaveProperty("publishedBy");
    expect(pub).not.toHaveProperty("notes");
    const plan = (pub.plans as Record<string, unknown>[])[0];
    expect(plan.planKey).toBe("STARTER");
    expect(plan).not.toHaveProperty("id");
    expect(plan).not.toHaveProperty("planVersionId");
    const addon = (pub.addons as Record<string, unknown>[])[0];
    expect(addon.sku).toBe("CUSTOMER_PACK_100");
    expect(addon).not.toHaveProperty("id");
  });

  it("getPublicCatalog lists only self-service SKUs (admin-only ones ship dark)", async () => {
    const prisma = {
      planVersion: {
        findFirst: jest.fn().mockResolvedValue({
          id: "v7",
          version: 7,
          status: "PUBLISHED",
          effectiveAt: new Date("2026-07-08T00:00:00.000Z"),
          definitions: [],
          addonSkus: [
            { sku: "CUSTOMER_PACK_100", name: "Customer pack (+100)", sortOrder: 0 },
            { sku: "MSRP", name: "MSRP", sortOrder: 1 },
            { sku: "SALES_AGENTS", name: "Sales agents", sortOrder: 2 },
            { sku: "BUYER_PORTAL", name: "Buyer portal", sortOrder: 3 },
          ],
        }),
      },
    } as any;
    const pub = (await new PlanCatalogService(prisma).getPublicCatalog()) as Record<
      string,
      unknown
    >;
    expect((pub.addons as Record<string, unknown>[]).map((a) => a.sku)).toEqual([
      "CUSTOMER_PACK_100",
    ]);
  });

  it("getPublicCatalog excludes invite-only plans (LITE) — WP3a R2.3", async () => {
    const prisma = {
      planVersion: {
        findFirst: jest.fn().mockResolvedValue({
          id: "v9",
          version: 9,
          status: "PUBLISHED",
          effectiveAt: new Date("2026-09-15T00:00:00.000Z"),
          definitions: [
            { planKey: "LITE", name: "Lite", monthlyPrice: 29, sortOrder: 0 },
            { planKey: "STARTER", name: "Starter", monthlyPrice: 59, sortOrder: 1 },
            { planKey: "TEAM", name: "Team", monthlyPrice: 149, sortOrder: 2 },
          ],
          addonSkus: [],
        }),
      },
    } as any;
    const pub = (await new PlanCatalogService(prisma).getPublicCatalog()) as Record<
      string,
      unknown
    >;
    expect((pub.plans as Record<string, unknown>[]).map((p) => p.planKey)).toEqual([
      "STARTER",
      "TEAM",
    ]);
  });
});

describe("PlanCatalogService.upgradeTargetForFlag", () => {
  it("returns the cheapest granting plan + the à-la-carte SKU", async () => {
    const prisma = {
      planVersion: {
        findFirst: jest.fn().mockResolvedValue({
          id: "v7",
          definitions: [
            { planKey: "BUSINESS", monthlyPrice: 349, featureFlags: ["addon.buyer_portal"] },
            { planKey: "TEAM", monthlyPrice: 149, featureFlags: ["addon.buyer_portal"] },
          ],
          addonSkus: [{ sku: "BUYER_PORTAL", monthlyPrice: 49 }],
        }),
      },
    } as any;
    const svc = new PlanCatalogService(prisma);
    const u = await svc.upgradeTargetForFlag("addon.buyer_portal");
    expect(u.planKey).toBe("TEAM"); // cheapest granting plan
    expect(u.planMonthlyPrice).toBe("149");
    expect(u.addonSku).toBe("BUYER_PORTAL");
    expect(u.addonMonthlyPrice).toBe("49");
  });

  it("returns all nulls when the catalog is unseeded", async () => {
    const prisma = { planVersion: { findFirst: jest.fn().mockResolvedValue(null) } } as any;
    const svc = new PlanCatalogService(prisma);
    expect(await svc.upgradeTargetForFlag("flag.reports")).toEqual({
      planKey: null,
      planMonthlyPrice: null,
      addonSku: null,
      addonMonthlyPrice: null,
    });
  });
});

describe("PlanCatalogService lifecycle", () => {
  it("rejects a second draft while one already exists", async () => {
    const prisma = {
      planVersion: { findFirst: jest.fn().mockResolvedValue({ id: "draft", status: "DRAFT" }) },
    } as any;
    const svc = new PlanCatalogService(prisma);
    await expect(svc.createDraft()).rejects.toMatchObject({ status: 409 });
  });

  it("auto-fills annualPrice to monthly×10 when editing a draft definition", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      planVersion: { findUnique: jest.fn().mockResolvedValue({ status: "DRAFT" }) },
      planDefinition: { update },
    } as any;
    const svc = new PlanCatalogService(prisma);
    await svc.updateDefinition("v8", "TEAM", { monthlyPrice: 149 });
    const data = update.mock.calls[0][0].data;
    expect(data.monthlyPrice).toBe(149);
    expect(data.annualPrice.toString()).toBe("1490"); // exact ×10, not 1489.99…
  });

  it("does not overwrite an explicitly-provided annualPrice", async () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      planVersion: { findUnique: jest.fn().mockResolvedValue({ status: "DRAFT" }) },
      planDefinition: { update },
    } as any;
    const svc = new PlanCatalogService(prisma);
    await svc.updateDefinition("v8", "TEAM", { monthlyPrice: 149, annualPrice: 1400 });
    expect(update.mock.calls[0][0].data.annualPrice).toBe(1400);
  });

  it("rejects editing a non-draft version", async () => {
    const prisma = {
      planVersion: { findUnique: jest.fn().mockResolvedValue({ status: "PUBLISHED" }) },
      planDefinition: { update: jest.fn() },
    } as any;
    const svc = new PlanCatalogService(prisma);
    await expect(svc.updateDefinition("v7", "TEAM", { monthlyPrice: 1 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("rejects publishing a non-draft version", async () => {
    const prisma = {
      planVersion: {
        findUnique: jest.fn().mockResolvedValue({ status: "PUBLISHED", definitions: [{}] }),
      },
    } as any;
    const svc = new PlanCatalogService(prisma);
    await expect(svc.publish("v7")).rejects.toMatchObject({ status: 400 });
  });

  it("publishes a draft and supersedes the prior published version", async () => {
    const updateMany = jest.fn().mockResolvedValue({});
    const update = jest.fn().mockResolvedValue({ id: "v8", status: "PUBLISHED" });
    const tx = { planVersion: { updateMany, update } };
    const prisma = {
      planVersion: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: "DRAFT", definitions: [{ planKey: "STARTER" }] }),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    } as any;
    const svc = new PlanCatalogService(prisma);
    await svc.publish("v8", "admin-1");
    expect(updateMany).toHaveBeenCalledWith({
      where: { status: "PUBLISHED" },
      data: { status: "SUPERSEDED" },
    });
    expect(update.mock.calls[0][0].data).toMatchObject({
      status: "PUBLISHED",
      publishedBy: "admin-1",
    });
  });

  it("maps a concurrent-publish P2002 to a clean 409", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError("unique violation", {
      code: "P2002",
      clientVersion: "7.8.0",
    });
    const prisma = {
      planVersion: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ status: "DRAFT", definitions: [{ planKey: "STARTER" }] }),
      },
      $transaction: jest.fn().mockRejectedValue(p2002),
    } as any;
    const svc = new PlanCatalogService(prisma);
    await expect(svc.publish("v8")).rejects.toMatchObject({ status: 409 });
  });
});
