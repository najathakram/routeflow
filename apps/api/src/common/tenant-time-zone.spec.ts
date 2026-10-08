import { Logger } from "@nestjs/common";
import {
  FALLBACK_ZONE,
  configuredZone,
  isValidTimeZone,
  resetTenantZoneWarnings,
  resolveTenantZone,
  resolveZone,
  tenantTimeZone,
  zoneFromConfig,
} from "./tenant-time-zone";

function prismaWith(row: unknown, ambient: string | null = "t1") {
  return {
    getTenantId: jest.fn(() => ambient),
    tenantConfig: { findUnique: jest.fn().mockResolvedValue(row) },
  };
}

describe("resolveTenantZone (SA-738: one resolver, one fallback)", () => {
  it("passes a valid zone through unchanged", () => {
    expect(resolveTenantZone("America/Chicago")).toEqual({
      zone: "America/Chicago",
      fallback: false,
    });
    expect(resolveTenantZone("UTC")).toEqual({ zone: "UTC", fallback: false });
  });

  it.each([null, undefined, "", "Mars/Phobos", "+01:00", " America/Chicago"])(
    "gives UTC with fallback:true for %p",
    (raw) => {
      expect(resolveTenantZone(raw as string | null | undefined)).toEqual({
        zone: FALLBACK_ZONE,
        fallback: true,
      });
    },
  );

  it("zoneFromConfig reads a config row; a missing row falls back", () => {
    expect(zoneFromConfig({ timezone: "Asia/Tokyo" }).zone).toBe("Asia/Tokyo");
    expect(zoneFromConfig(null)).toEqual({ zone: "UTC", fallback: true });
    expect(zoneFromConfig({ timezone: "Mars/Phobos" }).fallback).toBe(true);
  });

  it("configuredZone is the zone only when the tenant really has one (null otherwise)", () => {
    expect(configuredZone({ timezone: "Asia/Tokyo" })).toBe("Asia/Tokyo");
    expect(configuredZone(null)).toBeNull();
    expect(configuredZone({ timezone: "Mars/Phobos" })).toBeNull();
  });

  it("isValidTimeZone refuses non-strings and offsets", () => {
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone("-05:00")).toBe(false);
    expect(isValidTimeZone("Europe/London")).toBe(true);
  });
});

describe("resolveZone(prisma, { tenantId, locationId? })", () => {
  beforeEach(() => resetTenantZoneWarnings());

  it("reads the tenant's own row, once", async () => {
    const prisma = prismaWith({ timezone: "America/Los_Angeles" });
    await expect(resolveZone(prisma, { tenantId: "t9" })).resolves.toEqual({
      zone: "America/Los_Angeles",
      fallback: false,
    });
    expect(prisma.tenantConfig.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.tenantConfig.findUnique.mock.calls[0][0].where).toEqual({ tenantId: "t9" });
  });

  it("a tenant with no TenantConfig row resolves to UTC, flagged", async () => {
    await expect(resolveZone(prismaWith(null), { tenantId: "t9" })).resolves.toEqual({
      zone: "UTC",
      fallback: true,
    });
  });

  it("an invalid stored zone resolves to UTC, flagged (never echoed)", async () => {
    const r = await resolveZone(prismaWith({ timezone: "Mars/Phobos" }), { tenantId: "t9" });
    expect(r).toEqual({ zone: "UTC", fallback: true });
  });

  it("locationId is accepted and ignored in v1 (same query, same answer)", async () => {
    const prisma = prismaWith({ timezone: "Asia/Tokyo" });
    const withLoc = await resolveZone(prisma, { tenantId: "t9", locationId: "loc-1" });
    const without = await resolveZone(prisma, { tenantId: "t9" });
    expect(withLoc).toEqual(without);
    expect(prisma.tenantConfig.findUnique.mock.calls[0][0]).toEqual(
      prisma.tenantConfig.findUnique.mock.calls[1][0],
    );
  });

  it("warns once per tenant per process when the fallback is used", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const prisma = prismaWith(null);
      await resolveZone(prisma, { tenantId: "t-warn" });
      await resolveZone(prisma, { tenantId: "t-warn" });
      await resolveZone(prisma, { tenantId: "t-warn-2" });
      expect(warn).toHaveBeenCalledTimes(2);
      await resolveZone(prismaWith({ timezone: "Asia/Tokyo" }), { tenantId: "t-fine" });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("an empty tenant id never queries and falls back", async () => {
    const prisma = prismaWith({ timezone: "Asia/Tokyo" });
    await expect(resolveZone(prisma, { tenantId: "" })).resolves.toEqual({
      zone: "UTC",
      fallback: true,
    });
    expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
  });
});

describe("tenantTimeZone delegates to resolveZone", () => {
  beforeEach(() => resetTenantZoneWarnings());

  it("returns the resolved zone for the ambient tenant", async () => {
    await expect(tenantTimeZone(prismaWith({ timezone: "Asia/Tokyo" }))).resolves.toBe(
      "Asia/Tokyo",
    );
  });

  it("returns UTC (not null, not the raw string) for a no-row or invalid tenant", async () => {
    await expect(tenantTimeZone(prismaWith(null))).resolves.toBe("UTC");
    await expect(tenantTimeZone(prismaWith({ timezone: "Mars/Phobos" }))).resolves.toBe("UTC");
  });

  it("an explicit tenant in the context object wins over the ambient one", async () => {
    const prisma = prismaWith({ timezone: "Asia/Tokyo" }, null);
    await expect(tenantTimeZone(prisma, { tenantId: "t-explicit" })).resolves.toBe("Asia/Tokyo");
    expect(prisma.tenantConfig.findUnique.mock.calls[0][0].where).toEqual({
      tenantId: "t-explicit",
    });
  });

  it("is null only when there is no tenant context at all", async () => {
    const prisma = prismaWith({ timezone: "Asia/Tokyo" }, null);
    await expect(tenantTimeZone(prisma)).resolves.toBeNull();
    expect(prisma.tenantConfig.findUnique).not.toHaveBeenCalled();
  });
});
