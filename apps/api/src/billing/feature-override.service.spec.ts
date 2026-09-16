import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { FeatureOverrideService } from "./feature-override.service";

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ov1",
    tenantId: "t1",
    featureKey: "tobacco_dealer",
    effect: "GRANT",
    reason: "pilot",
    expiresAt: null,
    createdById: "admin1",
    createdAt: new Date("2026-09-16T00:00:00Z"),
    revokedAt: null,
    ...overrides,
  };
}

function build() {
  const prisma = {
    tenantFeatureOverride: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      // Default: nothing to auto-close (the common case) — every pre-existing test in this
      // file exercises that path unchanged.
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as any;
  return { svc: new FeatureOverrideService(prisma), prisma };
}

describe("FeatureOverrideService.get / getMany — read + cache", () => {
  it("returns null when the tenant has no override rows", async () => {
    const { svc } = build();
    await expect(svc.get("t1", "tobacco_dealer")).resolves.toBeNull();
  });

  it("returns the effect of an active row", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([row({ effect: "GRANT" })]);
    await expect(svc.get("t1", "tobacco_dealer")).resolves.toBe("GRANT");
  });

  it("returns DENY for an active DENY row", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([row({ effect: "DENY" })]);
    await expect(svc.get("t1", "tobacco_dealer")).resolves.toBe("DENY");
  });

  it("the DB query scopes to the tenant and excludes revoked rows", async () => {
    const { svc, prisma } = build();
    await svc.get("t1", "tobacco_dealer");
    const args = prisma.tenantFeatureOverride.findMany.mock.calls[0][0];
    expect(args.where.tenantId).toBe("t1");
    expect(args.where.revokedAt).toBeNull();
  });

  it("ignores a row whose expiresAt is in the past, rechecked at READ time (not just at fetch)", async () => {
    // expiresAt drifts stale purely by wall-clock time within an otherwise-valid 30s cache
    // window, unlike revokedAt (a write-driven state fully covered by invalidate()) — so this
    // must be a live recheck, not merely a query-time filter that a still-cached entry outlives.
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      row({ effect: "GRANT", expiresAt: new Date("2000-01-01T00:00:00Z") }),
    ]);
    await expect(svc.get("t1", "tobacco_dealer")).resolves.toBeNull();
  });

  it("a standing override (expiresAt null) is honoured", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      row({ effect: "DENY", expiresAt: null }),
    ]);
    await expect(svc.get("t1", "tobacco_dealer")).resolves.toBe("DENY");
  });

  it("caches for 30s: a second get() within the TTL does not re-query", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([row({ effect: "GRANT" })]);
    await svc.get("t1", "tobacco_dealer");
    await svc.get("t1", "tobacco_dealer");
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(1);
  });

  it("a second tenant is cached independently", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([]);
    await svc.get("t1", "tobacco_dealer");
    await svc.get("t2", "tobacco_dealer");
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(2);
  });

  it("invalidate(tenantId) forces the next get() to re-query", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([]);
    await svc.get("t1", "tobacco_dealer");
    svc.invalidate("t1");
    await svc.get("t1", "tobacco_dealer");
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(2);
  });

  it("invalidate() only clears the named tenant, not others", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([]);
    await svc.get("t1", "tobacco_dealer");
    await svc.get("t2", "tobacco_dealer");
    svc.invalidate("t1");
    await svc.get("t1", "tobacco_dealer");
    await svc.get("t2", "tobacco_dealer");
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(3);
  });

  it("fails open (null) on a DB error — never throws into a guard", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockRejectedValue(new Error("db down"));
    await expect(svc.get("t1", "tobacco_dealer")).resolves.toBeNull();
  });

  it("getMany() returns only the keys that carry an active override", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      row({ featureKey: "recurring_routes", effect: "GRANT" }),
    ]);
    const result = await svc.getMany("t1", ["recurring_routes", "order_delivery"]);
    expect(result.get("recurring_routes")).toBe("GRANT");
    expect(result.has("order_delivery")).toBe(false);
  });

  it("getMany() fails open to an empty Map on a DB error", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockRejectedValue(new Error("db down"));
    const result = await svc.getMany("t1", ["recurring_routes"]);
    expect(result.size).toBe(0);
  });

  it("allActive() returns every active override, including a key never asked for by name", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      row({ featureKey: "tobacco_dealer", effect: "GRANT" }),
      row({ featureKey: "recurring_routes", effect: "DENY" }),
    ]);
    const result = await svc.allActive("t1");
    expect(result.get("tobacco_dealer")).toBe("GRANT");
    expect(result.get("recurring_routes")).toBe("DENY");
    expect(result.size).toBe(2);
  });

  it("allActive() excludes an expired row, rechecked at read time", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([
      row({ featureKey: "tobacco_dealer", expiresAt: new Date("2000-01-01T00:00:00Z") }),
    ]);
    const result = await svc.allActive("t1");
    expect(result.size).toBe(0);
  });

  it("allActive() fails open to an empty Map on a DB error", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.findMany.mockRejectedValue(new Error("db down"));
    const result = await svc.allActive("t1");
    expect(result.size).toBe(0);
  });
});

describe("FeatureOverrideService.create", () => {
  it("creates a row and invalidates the tenant's cache", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.create.mockResolvedValue(row());
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([]);
    await svc.get("t1", "tobacco_dealer"); // warm the cache
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(1);

    await svc.create({
      tenantId: "t1",
      featureKey: "tobacco_dealer",
      effect: "GRANT",
      reason: "pilot",
      expiresAt: null,
      createdById: "admin1",
    });

    prisma.tenantFeatureOverride.findMany.mockResolvedValue([row({ effect: "GRANT" })]);
    await svc.get("t1", "tobacco_dealer");
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(2); // cache was invalidated
  });

  // Opus review of 8130b204, item 5: the partial unique index is `WHERE revokedAt IS NULL` --
  // an expired-but-never-revoked row still counts toward it and would otherwise block a
  // re-grant/re-deny of the same key until someone manually revokes the stale row first.
  it("auto-closes an expired-but-unrevoked row for the same key before inserting", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.create.mockResolvedValue(row());

    await svc.create({
      tenantId: "t1",
      featureKey: "tobacco_dealer",
      effect: "GRANT",
      reason: "renewed pilot",
      expiresAt: null,
      createdById: "admin1",
    });

    expect(prisma.tenantFeatureOverride.updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        featureKey: "tobacco_dealer",
        revokedAt: null,
        expiresAt: { lte: expect.any(Date) },
      },
      data: { revokedAt: expect.any(Date) },
    });
    // The auto-close runs BEFORE the insert, so a still-active partial-unique row from a
    // genuinely current (non-expired) override is never touched by it — only the query's own
    // `expiresAt: { lte: now }` filter enforces that, proven by the where clause above.
    const closeOrder = prisma.tenantFeatureOverride.updateMany.mock.invocationCallOrder[0];
    const createOrder = prisma.tenantFeatureOverride.create.mock.invocationCallOrder[0];
    expect(closeOrder).toBeLessThan(createOrder);
  });

  it("rejects a featureKey that does not exist in FEATURE_REGISTRY with FEATURE_KEY_UNKNOWN", async () => {
    const { svc } = build();
    const err = await svc
      .create({
        tenantId: "t1",
        featureKey: "not_a_real_key",
        effect: "GRANT",
        reason: "pilot",
        expiresAt: null,
        createdById: "admin1",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "FEATURE_KEY_UNKNOWN" });
  });

  it("translates a unique-constraint violation (an active row already exists) into 409", async () => {
    const { svc, prisma } = build();
    const conflict = Object.assign(new Error("unique"), { code: "P2002" });
    Object.setPrototypeOf(conflict, Prisma.PrismaClientKnownRequestError.prototype);
    prisma.tenantFeatureOverride.create.mockRejectedValue(conflict);

    const err = await svc
      .create({
        tenantId: "t1",
        featureKey: "tobacco_dealer",
        effect: "GRANT",
        reason: "pilot",
        expiresAt: null,
        createdById: "admin1",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
  });
});

describe("FeatureOverrideService.revoke", () => {
  it("sets revokedAt and invalidates the tenant's cache", async () => {
    const { svc, prisma } = build();
    prisma.tenantFeatureOverride.update.mockResolvedValue(row({ revokedAt: new Date() }));
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([row({ effect: "GRANT" })]);
    await svc.get("t1", "tobacco_dealer");
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(1);

    await svc.revoke("t1", "ov1");

    expect(prisma.tenantFeatureOverride.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ov1", tenantId: "t1" },
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    prisma.tenantFeatureOverride.findMany.mockResolvedValue([]);
    await svc.get("t1", "tobacco_dealer");
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledTimes(2);
  });

  // Opus review of 8130b204, item 3: `where: { id }` alone let tenant B revoke tenant A's row
  // via tenant A's row id under tenant B's URL — mis-audited and mis-invalidated. Prisma's
  // combined { id, tenantId } where throws P2025 (RecordNotFound) when they don't both match.
  it("scopes the update to the owning tenant — a foreign id 404s instead of revoking", async () => {
    const { svc, prisma } = build();
    const notFound = Object.assign(new Error("no record"), { code: "P2025" });
    Object.setPrototypeOf(notFound, Prisma.PrismaClientKnownRequestError.prototype);
    prisma.tenantFeatureOverride.update.mockRejectedValue(notFound);

    const err = await svc.revoke("tenant-b", "ov-belongs-to-tenant-a").catch((e) => e);

    expect(err).toBeInstanceOf(NotFoundException);
    expect(prisma.tenantFeatureOverride.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ov-belongs-to-tenant-a", tenantId: "tenant-b" } }),
    );
  });
});
