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
  // #2700: compute also reads the PUBLISHED version (flags gain forward) when the pinned one is
  // not itself published. Defaulting it to the same version keeps every pre-existing test's
  // pinned === published premise, so none of them sees a union.
  const catalog = {
    getVersionForTenant: jest.fn().mockResolvedValue(catalogVersion()),
    getPublishedVersion: jest.fn().mockResolvedValue(catalogVersion()),
  } as any;
  // Every pre-existing test in this file exercises a tenant with no override rows, so this
  // collaborator-contract addition (feature-grants PR-1) defaults to "no override" — the same
  // plan-only behavior those tests already assert on.
  const featureOverrides = { get: jest.fn().mockResolvedValue(null) } as any;
  return {
    svc: new EntitlementsService(prisma, catalog, featureOverrides),
    prisma,
    catalog,
    featureOverrides,
  };
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
    catalog.getPublishedVersion.mockResolvedValue({
      ...catalogVersion(),
      id: "planver_v9",
      status: "PUBLISHED",
      addonSkus: [
        ...catalogVersion().addonSkus,
        { sku: "MSRP", meteredKey: null, capacityPerUnit: null, grantsFlags: ["flag.msrp"] },
      ],
    });
    const e = await svc.resolve("t1");
    expect(e.addons).toContain("MSRP");
    expect(e.flags).toContain("flag.msrp");
    expect(catalog.getVersionForTenant).toHaveBeenCalledWith("planver_v7");
    // #2700: the published version is read once, via getPublishedVersion (the SKU fallback and
    // the flag union share it).
    expect(catalog.getPublishedVersion).toHaveBeenCalledTimes(1);
  });

  it("never fetches the published catalog when the tenant's pinned version IS the published one", async () => {
    const { svc, catalog } = makeService(
      tenantFixture({
        plan: "STARTER",
        addons: [{ addonKey: "msrp", sku: "MSRP" }],
      }),
    );
    catalog.getVersionForTenant.mockResolvedValue({ ...catalogVersion(), status: "PUBLISHED" });
    await svc.resolve("t1");
    expect(catalog.getVersionForTenant).toHaveBeenCalledTimes(1);
    expect(catalog.getPublishedVersion).not.toHaveBeenCalled();
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

  it("hasFlag: a GRANT override wins even though the plan lacks the flag", async () => {
    const { svc, featureOverrides } = makeService(tenantFixture({ plan: "STARTER" }));
    featureOverrides.get.mockResolvedValue("GRANT");
    expect(await svc.hasFlag("t1", "flag.analytics")).toBe(true);
  });

  it("hasFlag: a DENY override wins even though the plan grants the flag", async () => {
    const { svc, featureOverrides } = makeService(tenantFixture({ plan: "STARTER" }));
    featureOverrides.get.mockResolvedValue("DENY");
    expect(await svc.hasFlag("t1", "addon.ocr")).toBe(false);
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

// WP2 (R3a.3/R3a.7): isAlwaysEnforcedTenant is the collaborator PlanFlagGuard/AddonGuard
// use to decide whether a tenant gets the PLAN_FLAG_ENFORCEMENT/dark-addon-gate courtesy
// allow. Only an always-enforced plan (today: LITE) says no.
describe("EntitlementsService.isAlwaysEnforcedTenant", () => {
  it("resolves true for a LITE tenant", async () => {
    const { svc, catalog } = makeService(tenantFixture({ plan: "LITE" }));
    catalog.getVersionForTenant.mockResolvedValueOnce({
      ...catalogVersion(),
      definitions: [
        ...catalogVersion().definitions,
        {
          planKey: "LITE",
          name: "Lite",
          seatsIncluded: 1,
          routesConcurrent: 1,
          scansIncluded: 10,
          msgsIncluded: 50,
          customersIncluded: 25,
          featureFlags: [],
        },
      ],
    });
    expect(await svc.isAlwaysEnforcedTenant("t1")).toBe(true);
  });

  it("resolves false for a non-Lite tenant (STARTER) — the non-Lite regression case", async () => {
    const { svc } = makeService(tenantFixture({ plan: "STARTER" }));
    expect(await svc.isAlwaysEnforcedTenant("t1")).toBe(false);
  });

  it("resolves false for GROWTH/SCALE/ENTERPRISE tenants too", async () => {
    const { svc: growth } = makeService(tenantFixture({ plan: "STARTER", planKey: "TEAM" }));
    expect(await growth.isAlwaysEnforcedTenant("t1")).toBe(false);
    const { svc: enterprise } = makeService(tenantFixture({ plan: "ENTERPRISE" }));
    expect(await enterprise.isAlwaysEnforcedTenant("t1")).toBe(false);
  });

  it("never throws — resolves false when entitlement resolution itself fails", async () => {
    const { svc } = makeService(null);
    expect(await svc.isAlwaysEnforcedTenant("missing-tenant")).toBe(false);
  });
});

describe("EntitlementsService — #2700 (SA-559(2)): feature flags gain forward", () => {
  /** v13-shaped published catalog: STARTER gains flag.returns and a brand-new flag.later. */
  function publishedV13() {
    const v = catalogVersion();
    return {
      ...v,
      id: "planver_v13",
      status: "PUBLISHED",
      definitions: v.definitions.map((d) =>
        d.planKey === "STARTER"
          ? { ...d, seatsIncluded: 99, featureFlags: ["flag.returns", "flag.later"] }
          : d,
      ),
    };
  }

  it("a tenant pinned to an older version gains the published plan's NEW flags — caps and planVersionId stay pinned", async () => {
    const { svc, catalog } = makeService(tenantFixture({ plan: "STARTER" }));
    catalog.getPublishedVersion.mockResolvedValue(publishedV13());
    const e = await svc.resolve("t1");
    expect(e.flags).toEqual(expect.arrayContaining(["addon.ocr", "flag.returns", "flag.later"]));
    expect(e.planVersionId).toBe("planver_v7"); // never re-pinned
    expect(e.caps.seats).toBe(1); // v7's STARTER, not v13's 99
  });

  it("a flag the published plan DROPPED is never removed from a grandfathered tenant (a union)", async () => {
    const { svc, catalog } = makeService(tenantFixture({ plan: "STARTER" }));
    catalog.getPublishedVersion.mockResolvedValue(publishedV13()); // v13 STARTER lacks addon.ocr
    expect((await svc.resolve("t1")).flags).toContain("addon.ocr");
  });

  it("no union when the published version has no such plan", async () => {
    const { svc, catalog } = makeService(tenantFixture({ plan: "STARTER" }));
    const v = publishedV13();
    catalog.getPublishedVersion.mockResolvedValue({
      ...v,
      definitions: v.definitions.filter((d) => d.planKey !== "STARTER"),
    });
    expect((await svc.resolve("t1")).flags).toEqual(["addon.ocr"]);
  });

  it("the union follows the plan-key rename (a TEAM-keyed tenant gains the published GROWTH row's flags)", async () => {
    const { svc, catalog } = makeService(tenantFixture({ plan: "STARTER", planKey: "TEAM" }));
    const v = catalogVersion();
    catalog.getPublishedVersion.mockResolvedValue({
      ...v,
      id: "planver_v13",
      status: "PUBLISHED",
      definitions: [
        ...v.definitions.filter((d) => d.planKey !== "TEAM"),
        {
          ...v.definitions.find((d) => d.planKey === "TEAM")!,
          planKey: "GROWTH",
          featureFlags: ["flag.sales_agents"],
        },
      ],
    });
    expect((await svc.resolve("t1")).flags).toContain("flag.sales_agents");
  });

  it("compute writes nothing: the only DB call is the tenant read", async () => {
    const { svc, prisma, catalog } = makeService(tenantFixture({ plan: "STARTER" }));
    catalog.getPublishedVersion.mockResolvedValue(publishedV13());
    await svc.resolve("t1");
    expect(Object.keys(prisma)).toEqual(["tenant"]);
    expect(Object.keys(prisma.tenant)).toEqual(["findUnique"]);
    expect(prisma.tenant.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("EntitlementsService — #2700: the REAL v11 → v12 gain at compute level (lead pin)", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const v11 = require("../../prisma/plan-catalog-v11.definitions");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const v12 = require("../../prisma/plan-catalog-v12.definitions");
  const versionOf = (id: string, status: string, defs: any[]) => ({
    id,
    status,
    definitions: defs,
    addonSkus: [],
  });

  it("a GROWTH tenant pinned to v11 gains v12's five new plan flags; its caps stay v11's", async () => {
    const { svc, catalog } = makeService(tenantFixture({ plan: "STARTER", planKey: "GROWTH" }));
    catalog.getVersionForTenant.mockResolvedValue(
      versionOf("planver_v11", "SUPERSEDED", v11.V11_DEFINITIONS),
    );
    catalog.getPublishedVersion.mockResolvedValue(
      versionOf("planver_v12", "PUBLISHED", v12.V12_DEFINITIONS),
    );
    const e = await svc.resolve("t1");
    const v11Growth = v11.V11_DEFINITIONS.find((d: any) => d.planKey === "GROWTH");
    for (const flag of v12.NEW_PLAN_FLAGS) expect(e.flags).toContain(flag);
    for (const flag of v11Growth.featureFlags) expect(e.flags).toContain(flag);
    expect(e.planVersionId).toBe("planver_v11");
    expect(e.caps.seats).toBe(v11Growth.seatsIncluded);
    expect(e.caps.customers).toBe(v11Growth.customersIncluded);
  });
});
