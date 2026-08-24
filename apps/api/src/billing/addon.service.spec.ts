import { BadRequestException } from "@nestjs/common";
import { AddonService } from "./addon.service";

function published(skus: string[]) {
  return { addonSkus: skus.map((sku) => ({ sku, name: sku, monthlyPrice: 10 })) };
}

interface Opts {
  existingAddon?: any;
  publishedSkus?: string[];
}

function make(opts: Opts = {}) {
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme" }) },
    tenantAddon: {
      findUnique: jest.fn().mockResolvedValue(opts.existingAddon ?? null),
      upsert: jest.fn().mockResolvedValue({ id: "addon1", active: true }),
      update: jest.fn().mockResolvedValue({ id: "addon1", active: false }),
    },
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
  } as any;
  const stripe = { isConfigured: false, client: {} } as any;
  const entitlements = { invalidate: jest.fn() } as any;
  const catalog = {
    getPublishedCatalog: jest.fn().mockResolvedValue(published(opts.publishedSkus ?? [])),
  } as any;
  const svc = new AddonService(prisma, stripe, entitlements, catalog);
  return { svc, prisma, entitlements, catalog };
}

describe("AddonService.enableAddon", () => {
  it("400s a bridged key whose SKU is missing from the published catalog, and writes nothing", async () => {
    const { svc, prisma, entitlements } = make({ publishedSkus: [] }); // MSRP not published

    await expect(svc.enableAddon("t1", "msrp")).rejects.toThrow(BadRequestException);
    await expect(svc.enableAddon("t1", "msrp")).rejects.toThrow(
      "Addon 'msrp' maps to SKU 'MSRP' which is not in the published catalog",
    );
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("enables a bridged key whose SKU IS published, writes the row, and invalidates entitlements", async () => {
    const { svc, prisma, entitlements } = make({ publishedSkus: ["MSRP"] });

    await svc.enableAddon("t1", "msrp");

    expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_addonKey: { tenantId: "t1", addonKey: "msrp" } },
      }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  it("allows an unbridged legacy key (developer_mode) unchanged, and still invalidates", async () => {
    const { svc, prisma, entitlements, catalog } = make({ publishedSkus: [] });

    await svc.enableAddon("t1", "developer_mode");

    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
    // No SKU to validate → the published catalog is never even fetched.
    expect(catalog.getPublishedCatalog).not.toHaveBeenCalled();
  });
});

describe("AddonService.disableAddon", () => {
  it("invalidates entitlements after disabling", async () => {
    const { svc, prisma, entitlements } = make({
      existingAddon: { id: "addon1", addonKey: "msrp", active: true },
    });

    await svc.disableAddon("t1", "msrp");

    expect(prisma.tenantAddon.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_addonKey: { tenantId: "t1", addonKey: "msrp" } },
      }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });
});
