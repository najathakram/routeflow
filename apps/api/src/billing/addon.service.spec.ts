import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AddonService } from "./addon.service";

function published(skus: string[]) {
  return { addonSkus: skus.map((sku) => ({ sku, name: sku, monthlyPrice: 10 })) };
}

interface Opts {
  existingAddon?: any;
  publishedSkus?: string[];
  /** Override the default unconfigured Stripe mock — e.g. `{ isConfigured: true, client: { subscriptionItems: { del: jest.fn()... } } }`. */
  stripe?: any;
  /** Override tenantSubscription.findUnique's resolved value (default null — no Stripe sub). */
  subscription?: any;
}

function make(opts: Opts = {}) {
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme" }) },
    tenantAddon: {
      findUnique: jest.fn().mockResolvedValue(opts.existingAddon ?? null),
      upsert: jest.fn().mockResolvedValue({ id: "addon1", active: true }),
      update: jest.fn().mockResolvedValue({ id: "addon1", active: false }),
    },
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(opts.subscription ?? null) },
  } as any;
  const stripe = opts.stripe ?? ({ isConfigured: false, client: {} } as any);
  const entitlements = { invalidate: jest.fn() } as any;
  const catalog = {
    getPublishedCatalog: jest.fn().mockResolvedValue(published(opts.publishedSkus ?? [])),
  } as any;
  const svc = new AddonService(prisma, stripe, entitlements, catalog);
  return { svc, prisma, entitlements, catalog, stripe };
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

  it("REG-B107 T7 refuses when the Stripe delete fails (non-missing error)", async () => {
    const del = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { code: "api_error", statusCode: 500 }));
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { del } } },
      existingAddon: { id: "addon1", addonKey: "msrp", stripeItemId: "si_1", active: true },
    });

    const attempt = svc.disableAddon("t1", "msrp");
    // Message oracle first: T7/T8/T9 all reject, and two of them share a class — only the
    // message separates "the Stripe delete failed" from the other two refusals.
    await expect(attempt).rejects.toThrow(/Could not remove the Stripe subscription item/);
    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The refusal must follow a REAL Stripe attempt — a blanket throw whenever Stripe is
    // configured would otherwise satisfy this test for the wrong reason.
    expect(del).toHaveBeenCalled();
    expect(prisma.tenantAddon.update).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("PIN T11: a Stripe 'resource_missing' (404) delete still RESOLVES and clears the pointer — over-refusal turns this red", async () => {
    const del = jest.fn().mockRejectedValue(
      Object.assign(new Error("No such subscription item"), {
        code: "resource_missing",
        statusCode: 404,
      }),
    );
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { del } } },
      existingAddon: { id: "addon1", addonKey: "msrp", stripeItemId: "si_1", active: true },
    });

    await expect(svc.disableAddon("t1", "msrp")).resolves.toBeDefined();
    expect(prisma.tenantAddon.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false, stripeItemId: null } }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });

  it("PIN T14: a successful Stripe delete removes the item and clears the local pointer", async () => {
    const del = jest.fn().mockResolvedValue({ id: "si_9", deleted: true });
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { del } } },
      existingAddon: { id: "addon1", addonKey: "msrp", stripeItemId: "si_9", active: true },
    });

    await expect(svc.disableAddon("t1", "msrp")).resolves.toBeDefined();

    expect(del).toHaveBeenCalledWith("si_9");
    expect(prisma.tenantAddon.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false, stripeItemId: null } }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });
});

// No REG token in the describe: the two REG tests carry their own tokens, and `PIN T12` below
// must stay OUT of `-t "REG-B(58|73|107)"` (jest matches the full concatenated name) — L-060.
describe("AddonService.enableAddon Stripe refusal", () => {
  it("REG-B107 T8 with a price refuses when the Stripe create fails", async () => {
    const create = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("boom"), { code: "api_error", statusCode: 500 }));
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: "sub_1" },
      publishedSkus: ["MSRP"],
    });

    const attempt = svc.enableAddon("t1", "msrp", "price_1");
    // Message oracle first — T8 and T9 reject on the same resolved fixture, so without the
    // message they are separated only by the exception class.
    await expect(attempt).rejects.toThrow(/Could not create the Stripe subscription item/);
    await expect(attempt).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Separates T8 from T9: T8 refuses only AFTER a real Stripe create attempt (503),
    // T9 refuses BEFORE ever calling Stripe (409). Without this the two are indistinguishable.
    expect(create).toHaveBeenCalled();
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it("REG-B107 T9 with a price refuses a tenant without a Stripe subscription", async () => {
    const create = jest.fn();
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: null },
      publishedSkus: ["MSRP"],
    });

    const attempt = svc.enableAddon("t1", "msrp", "price_1");
    // Message oracle first — see T8: the class is the only other separator between them.
    await expect(attempt).rejects.toThrow(/has no active Stripe subscription/);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tenantAddon.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("PIN T12: no stripePriceId (free-grant) resolves without touching Stripe, even when Stripe is configured", async () => {
    const create = jest.fn();
    const { svc, prisma } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      publishedSkus: ["MSRP"],
    });

    await expect(svc.enableAddon("t1", "msrp")).resolves.toBeDefined();
    expect(prisma.tenantAddon.upsert).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("PIN T15: a successful Stripe create persists the real Stripe item id on the row", async () => {
    const create = jest.fn().mockResolvedValue({ id: "si_9" });
    const { svc, prisma, entitlements } = make({
      stripe: { isConfigured: true, client: { subscriptionItems: { create } } },
      subscription: { stripeSubId: "sub_1" },
      publishedSkus: ["MSRP"],
    });

    await expect(svc.enableAddon("t1", "msrp", "price_1")).resolves.toBeDefined();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ subscription: "sub_1", price: "price_1" }),
    );
    expect(prisma.tenantAddon.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ stripeItemId: "si_9", active: true }),
        update: expect.objectContaining({ stripeItemId: "si_9", active: true }),
      }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith("t1");
  });
});
