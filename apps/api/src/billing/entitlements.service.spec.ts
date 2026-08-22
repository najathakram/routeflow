import { EntitlementsService } from "./entitlements.service";

/** A published catalog fixture mirroring the seeded v7 (trimmed to what the tests exercise). */
function catalogVersion() {
  return {
    id: "planver_v7",
    definitions: [
      {
        planKey: "STARTER",
        name: "Starter",
        seatsIncluded: 1,
        routesConcurrent: 1,
        scansIncluded: 20,
        msgsIncluded: 200,
        customersIncluded: 100,
        featureFlags: ["addon.ocr"],
      },
      {
        planKey: "TEAM",
        name: "Team",
        seatsIncluded: 5,
        routesConcurrent: 3,
        scansIncluded: 100,
        msgsIncluded: 200,
        customersIncluded: 250,
        featureFlags: ["flag.dispatch_live", "flag.returns", "addon.ocr"],
      },
      {
        planKey: "BUSINESS",
        name: "Business",
        seatsIncluded: 15,
        routesConcurrent: null,
        scansIncluded: 300,
        msgsIncluded: 200,
        customersIncluded: 500,
        featureFlags: ["flag.analytics", "addon.buyer_portal", "addon.ocr"],
      },
      {
        planKey: "ENTERPRISE",
        name: "Enterprise",
        seatsIncluded: null,
        routesConcurrent: null,
        scansIncluded: null,
        msgsIncluded: 200,
        customersIncluded: null,
        featureFlags: ["addon.regulated_items", "flag.api_sso", "addon.ocr"],
      },
    ],
    addonSkus: [
      { sku: "SEAT_EXTRA", meteredKey: "SEATS", capacityPerUnit: 1, grantsFlags: [] },
      { sku: "OCR_PACK_250", meteredKey: "SCANS", capacityPerUnit: 250, grantsFlags: [] },
      {
        sku: "CUSTOMER_PACK_100",
        meteredKey: "CUSTOMERS",
        capacityPerUnit: 100,
        grantsFlags: [],
      },
      {
        sku: "BUYER_PORTAL",
        meteredKey: null,
        capacityPerUnit: null,
        grantsFlags: ["addon.buyer_portal"],
      },
      {
        sku: "REGULATED_ITEMS",
        meteredKey: null,
        capacityPerUnit: null,
        grantsFlags: ["addon.regulated_items"],
      },
    ],
  };
}

interface TenantOpts {
  plan?: string;
  planKey?: string | null;
  status?: string;
  trialEndsAt?: Date | null;
  addons?: Array<{ addonKey: string; sku?: string | null; quantity?: number }>;
}

function tenantFixture(opts: TenantOpts = {}) {
  return {
    id: "t1",
    status: opts.status ?? "ACTIVE",
    plan: opts.plan ?? "STARTER",
    planVersionId: "planver_v7",
    trialEndsAt: opts.trialEndsAt ?? null,
    subscription: opts.planKey !== undefined ? { planKey: opts.planKey } : null,
    addons: (opts.addons ?? []).map((a) => ({
      addonKey: a.addonKey,
      sku: a.sku ?? null,
      quantity: a.quantity ?? 1,
      active: true,
    })),
  };
}

function makeService(tenant: ReturnType<typeof tenantFixture> | null) {
  const prisma = { tenant: { findUnique: jest.fn().mockResolvedValue(tenant) } } as any;
  const catalog = { getVersionForTenant: jest.fn().mockResolvedValue(catalogVersion()) } as any;
  return { svc: new EntitlementsService(prisma, catalog), prisma, catalog };
}

describe("EntitlementsService.resolve", () => {
  it("resolves Starter core flags + caps", async () => {
    const { svc } = makeService(tenantFixture({ plan: "STARTER" }));
    const e = await svc.resolve("t1");
    expect(e.planKey).toBe("STARTER");
    expect(e.flags).toEqual(["addon.ocr"]);
    expect(e.caps).toEqual({ seats: 1, routes: 1, scans: 20, msgs: 200, customers: 100 });
    expect(e.addons).toEqual([]);
  });

  it("maps legacy PROFESSIONAL enum → BUSINESS when no subscription planKey", async () => {
    const { svc } = makeService(tenantFixture({ plan: "PROFESSIONAL", planKey: undefined }));
    const e = await svc.resolve("t1");
    expect(e.planKey).toBe("BUSINESS");
    expect(e.flags).toContain("flag.analytics");
    expect(e.caps.seats).toBe(15);
    expect(e.caps.routes).toBeNull(); // Business = unlimited routes
  });

  it("subscription planKey overrides the legacy enum", async () => {
    const { svc } = makeService(tenantFixture({ plan: "STARTER", planKey: "TEAM" }));
    const e = await svc.resolve("t1");
    expect(e.planKey).toBe("TEAM");
    expect(e.flags).toEqual(expect.arrayContaining(["flag.dispatch_live", "flag.returns"]));
  });

  it("adds SEAT_EXTRA quantity to the seat cap", async () => {
    const { svc } = makeService(
      tenantFixture({
        plan: "STARTER",
        addons: [{ addonKey: "seat_extra", sku: "SEAT_EXTRA", quantity: 3 }],
      }),
    );
    const e = await svc.resolve("t1");
    expect(e.caps.seats).toBe(4); // 1 included + 3 extra
    expect(e.addons).toEqual(["SEAT_EXTRA"]);
  });

  it("stacks OCR packs onto the scan cap (250 each)", async () => {
    const { svc } = makeService(
      tenantFixture({
        plan: "STARTER",
        addons: [{ addonKey: "ocr", sku: "OCR_PACK_250", quantity: 2 }],
      }),
    );
    const e = await svc.resolve("t1");
    expect(e.caps.scans).toBe(520); // 20 + 2×250
  });

  it("stacks CUSTOMER_PACK_100 onto the customers cap (100 each)", async () => {
    const { svc } = makeService(
      tenantFixture({
        plan: "STARTER",
        addons: [{ addonKey: "customer_pack", sku: "CUSTOMER_PACK_100", quantity: 2 }],
      }),
    );
    const e = await svc.resolve("t1");
    expect(e.caps.customers).toBe(300); // 100 included + 2×100
    expect(e.addons).toEqual(["CUSTOMER_PACK_100"]);
  });

  it("grants a flag from an active add-on SKU", async () => {
    const { svc } = makeService(
      tenantFixture({
        plan: "STARTER",
        addons: [{ addonKey: "buyer_portal", sku: "BUYER_PORTAL" }],
      }),
    );
    const e = await svc.resolve("t1");
    expect(e.flags).toContain("addon.buyer_portal");
  });

  it("bridges the legacy tobacco_dealer addonKey → REGULATED_ITEMS SKU + flag", async () => {
    const { svc } = makeService(
      tenantFixture({ plan: "STARTER", addons: [{ addonKey: "tobacco_dealer", sku: null }] }),
    );
    const e = await svc.resolve("t1");
    expect(e.addons).toContain("REGULATED_ITEMS");
    expect(e.flags).toContain("addon.regulated_items");
  });

  it("falls back to the PUBLISHED catalog for an addon SKU the pinned version predates (MSRP on a grandfathered tenant)", async () => {
    // Pinned v7 has no MSRP AddonSku row; the SKU first ships in v9. Without the
    // fallback, enabling the addon grants nothing, the addon-keyed web gates turn
    // on anyway, and every gated write 403s — the addon would be un-grantable for
    // every grandfathered tenant.
    const { svc, catalog } = makeService(
      tenantFixture({ plan: "STARTER", addons: [{ addonKey: "msrp", sku: "MSRP" }] }),
    );
    catalog.getVersionForTenant.mockImplementation(async (pinned: string | null) =>
      pinned === null
        ? {
            ...catalogVersion(),
            id: "planver_v9",
            addonSkus: [
              ...catalogVersion().addonSkus,
              { sku: "MSRP", meteredKey: null, capacityPerUnit: null, grantsFlags: ["flag.msrp"] },
            ],
          }
        : catalogVersion(),
    );
    const e = await svc.resolve("t1");
    expect(e.addons).toContain("MSRP");
    expect(e.flags).toContain("flag.msrp");
    expect(catalog.getVersionForTenant).toHaveBeenCalledWith("planver_v7");
    expect(catalog.getVersionForTenant).toHaveBeenCalledWith(null);
  });

  it("never fetches the published catalog when the pinned version already knows every active SKU", async () => {
    const { svc, catalog } = makeService(
      tenantFixture({
        plan: "STARTER",
        addons: [{ addonKey: "buyer_portal", sku: "BUYER_PORTAL" }],
      }),
    );
    await svc.resolve("t1");
    expect(catalog.getVersionForTenant).toHaveBeenCalledTimes(1);
  });

  it("treats Enterprise caps as unlimited (null), even with capacity add-ons", async () => {
    const { svc } = makeService(
      tenantFixture({
        plan: "ENTERPRISE",
        addons: [{ addonKey: "seat_extra", sku: "SEAT_EXTRA", quantity: 5 }],
      }),
    );
    const e = await svc.resolve("t1");
    expect(e.caps).toEqual({
      seats: null,
      routes: null,
      scans: null,
      msgs: 200,
      customers: null,
    });
  });

  it("hasFlag reflects resolved flags", async () => {
    const { svc } = makeService(tenantFixture({ plan: "STARTER" }));
    expect(await svc.hasFlag("t1", "addon.ocr")).toBe(true);
    expect(await svc.hasFlag("t1", "flag.analytics")).toBe(false);
  });

  it("caches within TTL and re-resolves after invalidate", async () => {
    const { svc, prisma } = makeService(tenantFixture({ plan: "STARTER" }));
    await svc.resolve("t1");
    await svc.resolve("t1");
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
    svc.invalidate("t1");
    await svc.resolve("t1");
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(2);
  });

  it("claimsFor(null) returns null and never touches the DB", async () => {
    const { svc, prisma } = makeService(null);
    expect(await svc.claimsFor(null)).toBeNull();
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("claimsFor returns the compact JWT snapshot", async () => {
    const trialEndsAt = new Date("2026-07-21T00:00:00.000Z");
    const { svc } = makeService(tenantFixture({ plan: "STARTER", trialEndsAt }));
    const claims = await svc.claimsFor("t1");
    expect(claims).toEqual({
      plan: "STARTER",
      flags: ["addon.ocr"],
      addons: [],
      seats: 1,
      trialEnds: trialEndsAt.toISOString(),
    });
  });

  it("falls back consistently when the pinned version lacks the resolved planKey", async () => {
    const { svc, catalog } = makeService(tenantFixture({ plan: "STARTER", planKey: "BUSINESS" }));
    // A future version that kept only STARTER (dropped the plan the sub still names).
    catalog.getVersionForTenant.mockResolvedValueOnce({
      id: "planver_v9",
      definitions: [
        {
          planKey: "STARTER",
          name: "Starter",
          seatsIncluded: 1,
          routesConcurrent: 1,
          scansIncluded: 20,
          msgsIncluded: 200,
          customersIncluded: 100,
          featureFlags: ["addon.ocr"],
        },
      ],
      addonSkus: [],
    });
    const e = await svc.resolve("t1");
    // planKey/caps/flags stay internally consistent — never a BUSINESS claim on STARTER caps.
    expect(e.planKey).toBe("STARTER");
    expect(e.caps).toEqual({ seats: 1, routes: 1, scans: 20, msgs: 200, customers: 100 });
    expect(e.flags).toEqual(["addon.ocr"]);
  });

  it("resolves a legacy stored planKey against a post-rename version (TEAM → GROWTH)", async () => {
    const { svc, catalog } = makeService(tenantFixture({ plan: "STARTER", planKey: "TEAM" }));
    // v8 renamed the middle plans; the subscription still carries the historical key.
    catalog.getVersionForTenant.mockResolvedValueOnce({
      id: "planver_v8",
      definitions: [
        {
          planKey: "STARTER",
          name: "Starter",
          seatsIncluded: 3,
          routesConcurrent: 1,
          scansIncluded: 20,
          msgsIncluded: 200,
          customersIncluded: 100,
          featureFlags: ["flag.returns"],
        },
        {
          planKey: "GROWTH",
          name: "Growth",
          seatsIncluded: 10,
          routesConcurrent: 3,
          scansIncluded: 100,
          msgsIncluded: 200,
          customersIncluded: 250,
          featureFlags: ["flag.returns", "flag.analytics"],
        },
      ],
      addonSkus: [],
    });
    const e = await svc.resolve("t1");
    // NOT a silent downgrade to STARTER — the renamed twin is the tenant's own row.
    expect(e.planKey).toBe("GROWTH");
    expect(e.caps).toEqual({ seats: 10, routes: 3, scans: 100, msgs: 200, customers: 250 });
    expect(e.flags).toContain("flag.analytics");
  });

  it("claimsFor swallows resolution errors (never blocks login)", async () => {
    const { svc, catalog } = makeService(tenantFixture({ plan: "STARTER" }));
    catalog.getVersionForTenant.mockRejectedValueOnce(new Error("catalog down"));
    expect(await svc.claimsFor("t1")).toBeNull();
  });
});
