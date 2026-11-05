/**
 * SA-963 A-1 (F13): the resolver fills the override detail (kind, reason, end date) beside the verdict, so the Feature Console's
 * chips and its Details panel read real data. Unit rows over the three pieces: the override service's detail read, `resolveOneKey`'s
 * spread, and the preview's before/after. The same rows on a real database are in feature-override-detail.sa963.db.spec.ts.
 */
import { FEATURE_REGISTRY } from "./feature-registry";
import { FeatureOverrideService } from "./feature-override.service";
import { resolveOneKey, ResolveContext } from "./feature-resolver.service";
import { FeaturePreviewService } from "./feature-preview.service";
import { V11_PIN_FIXTURE, featureConfigOver, mockCollaborators } from "./feature-fixtures";

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ov1",
    tenantId: "t1",
    featureKey: "tobacco_dealer",
    effect: "GRANT",
    kind: "COMP",
    reason: "pilot",
    expiresAt: null,
    createdById: "admin1",
    createdAt: new Date("2026-09-16T00:00:00Z"),
    revokedAt: null,
    ...over,
  };
}

function buildService() {
  const prisma = {
    tenantFeatureOverride: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  return { svc: new FeatureOverrideService(prisma), prisma };
}

describe("FeatureOverrideService.activeDetail", () => {
  const ends = new Date(Date.now() + 5 * 24 * 3600 * 1000);

  it("F-1: a dated GRANT row gives its kind, reason and an ISO end date", async () => {
    const { svc, prisma } = buildService();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      row({ kind: "COMP", reason: "pilot month", expiresAt: ends }),
    ]);
    expect((await svc.activeDetail("t1")).get("tobacco_dealer")).toEqual({
      kind: "COMP",
      reason: "pilot month",
      expiresAt: ends.toISOString(),
    });
  });

  it("F-2: a standing GRANDFATHER row has a null end date", async () => {
    const { svc, prisma } = buildService();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      row({ kind: "GRANDFATHER", reason: "kept", expiresAt: null }),
    ]);
    expect((await svc.activeDetail("t1")).get("tobacco_dealer")).toEqual({
      kind: "GRANDFATHER",
      reason: "kept",
      expiresAt: null,
    });
  });

  it("F-4: a row past its end date gives no detail and no past date, like the verdict", async () => {
    const { svc, prisma } = buildService();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      row({ expiresAt: new Date(Date.now() - 1000) }),
    ]);
    expect((await svc.activeDetail("t1")).size).toBe(0);
    expect((await svc.allActive("t1")).size).toBe(0);
  });

  it("the detail and the verdict come from the one cached read", async () => {
    const { svc, prisma } = buildService();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([row()]);
    await svc.allActive("t1");
    await svc.activeDetail("t1");
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.tenantFeatureOverride.findMany.mock.calls[0][0].select).toMatchObject({
      kind: true,
      reason: true,
    });
  });

  it("F-5: invalidate() drops the detail, so a revoke is seen at once", async () => {
    const { svc, prisma } = buildService();
    prisma.tenantFeatureOverride.findMany.mockResolvedValueOnce([row()]);
    expect((await svc.activeDetail("t1")).size).toBe(1);
    prisma.tenantFeatureOverride.findMany.mockResolvedValueOnce([]);
    svc.invalidate("t1");
    expect((await svc.activeDetail("t1")).size).toBe(0);
  });

  it("F-10: a lookup error is an empty map, never a throw", async () => {
    const { svc, prisma } = buildService();
    prisma.tenantFeatureOverride.findMany.mockRejectedValue(new Error("db down"));
    await expect(svc.activeDetail("t1")).resolves.toEqual(new Map());
  });
});

describe("resolveOneKey: kind, reason and expiresAt on the two override returns only", () => {
  const key = "flag.estimates";
  const feature = FEATURE_REGISTRY.find((f) => f.key === key)!;
  const detail = { kind: "COMP", reason: "pilot", expiresAt: "2026-11-30T00:00:00.000Z" };
  const base = (overrides: ResolveContext["overrides"]): ResolveContext => ({
    overrides,
    activeAddonSet: new Set(),
    planFeatureFlags: new Set(),
    entFlags: [],
    activeSkuSet: new Set(),
    courtesy: () => false,
    billed: new Set<string>(),
  });

  it("a GRANT carries the detail", () => {
    const ctx = {
      ...base(new Map([[key, "GRANT" as const]])),
      overrideDetail: new Map([[key, detail]]),
    };
    expect(resolveOneKey(feature, ctx)).toEqual({
      key,
      effective: true,
      strict: true,
      source: "OVERRIDE_GRANT",
      ...detail,
      charged: false,
    });
  });

  it("F-3: a DENY carries the detail", () => {
    const ctx = {
      ...base(new Map([[key, "DENY" as const]])),
      overrideDetail: new Map([[key, detail]]),
    };
    expect(resolveOneKey(feature, ctx)).toMatchObject({
      effective: false,
      source: "OVERRIDE_DENY",
      ...detail,
    });
  });

  it("F-7 (unit): every key's verdict is the same with and without the detail", () => {
    const overrides = new Map<string, "GRANT" | "DENY">([
      [key, "GRANT"],
      ["flag.reports", "DENY"],
    ]);
    const withDetail = {
      ...base(overrides),
      overrideDetail: new Map([
        [key, detail],
        ["flag.reports", detail],
      ]),
    };
    for (const f of FEATURE_REGISTRY) {
      const a = resolveOneKey(f, withDetail);
      const b = resolveOneKey(f, base(overrides));
      expect([a.key, a.effective, a.source, a.charged]).toEqual([
        b.key,
        b.effective,
        b.source,
        b.charged,
      ]);
    }
  });

  it("a key with no override never carries detail, even if the detail map holds an entry for it", () => {
    const ctx = { ...base(new Map()), overrideDetail: new Map([[key, detail]]) };
    const r = resolveOneKey(feature, ctx);
    expect(r).not.toHaveProperty("kind");
    expect(r).not.toHaveProperty("reason");
    expect(r).not.toHaveProperty("expiresAt");
  });
});

describe("FeaturePreviewService: the override detail before and after", () => {
  const stored = { kind: "COMP", reason: "pilot", expiresAt: "2026-11-30T00:00:00.000Z" };
  const fixture = {
    ...V11_PIN_FIXTURE,
    name: "stored-dated-grant",
    overrides: [{ featureKey: "flag.estimates", effect: "GRANT" as const, detail: stored }],
  };

  function buildPreview(f: typeof fixture) {
    const { entitlements, featureOverrides, catalog, prisma } = mockCollaborators(f as any);
    return new FeaturePreviewService(
      entitlements as any,
      featureOverrides as any,
      catalog as any,
      prisma as any,
      featureConfigOver({}).service,
    );
  }

  it("F-6: a DENY over a stored dated GRANT: before has the stored date, after the request's, never the stored one", async () => {
    const result = await buildPreview(fixture).preview("t1", {
      overrides: [
        {
          featureKey: "flag.estimates",
          effect: "DENY",
          kind: "SUPPORT",
          reason: "abuse",
          expiresAt: "2026-12-15T00:00:00.000Z",
        },
      ],
    });
    const before = result.before.find((f) => f.key === "flag.estimates")!;
    const after = result.after.find((f) => f.key === "flag.estimates")!;
    expect(before.detail).toMatchObject(stored);
    expect(after.source).toBe("OVERRIDE_DENY");
    expect(after.detail).toMatchObject({
      kind: "SUPPORT",
      reason: "abuse",
      expiresAt: "2026-12-15T00:00:00.000Z",
    });
  });

  it("F-6b: a GRANT with no end date over a stored dated GRANT: after.expiresAt is null", async () => {
    const result = await buildPreview(fixture).preview("t1", {
      overrides: [{ featureKey: "flag.estimates", effect: "GRANT", reason: "keep it" }],
    });
    const after = result.after.find((f) => f.key === "flag.estimates")!;
    expect(after.detail.expiresAt).toBeNull();
    expect(after.detail).toMatchObject({ kind: "COMP", reason: "keep it" });
  });

  it("a key the request does not touch keeps its stored detail in after", async () => {
    const result = await buildPreview(fixture).preview("t1", {
      overrides: [{ featureKey: "flag.reports", effect: "DENY", reason: "x" }],
    });
    expect(result.after.find((f) => f.key === "flag.estimates")!.detail).toMatchObject(stored);
  });

  it("F-7 (unit): `changed` and every after verdict are identical with and without the detail", async () => {
    const withoutDetail = {
      ...fixture,
      overrides: [{ featureKey: "flag.estimates", effect: "GRANT" as const }],
    };
    const req = {
      overrides: [{ featureKey: "flag.reports", effect: "DENY" as const, reason: "x" }],
    };
    const a = await buildPreview(fixture).preview("t1", req);
    const b = await buildPreview(withoutDetail as any).preview("t1", req);
    expect(a.changed).toEqual(b.changed);
    expect(a.after.map((f) => [f.key, f.resolver, f.source])).toEqual(
      b.after.map((f) => [f.key, f.resolver, f.source]),
    );
  });
});
