/**
 * BusinessProfileService — list, plan and preview. Red-first: written before the service existed.
 *
 * Reads the tenant's current state through the EXISTING services only (FeatureOverrideService for
 * the active overrides, FeatureConfigService for can() and the stored modes) and previews through
 * the EXISTING FeaturePreviewService. It writes nothing: the confirm path is the platform-admin
 * controller's own audited override + feature-config writes.
 */
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { BusinessProfileService } from "./business-profile.service";

const T = "tenant-a";
const DAY = 86_400_000;

function overrideRow(p: {
  id: string;
  featureKey: string;
  effect: "GRANT" | "DENY";
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  tenantId?: string;
}) {
  return { tenantId: T, revokedAt: null, expiresAt: null, ...p };
}

function build(
  opts: {
    tenant?: { id: string } | null;
    overrides?: ReturnType<typeof overrideRow>[];
    holds?: Record<string, boolean>;
    modes?: Record<string, string>;
  } = {},
) {
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue(opts.tenant === undefined ? { id: T } : opts.tenant),
    },
  };
  // Deliberately NO `create`/`revoke`: a write from this service would throw.
  const featureOverrides = { list: jest.fn().mockResolvedValue(opts.overrides ?? []) };
  const holds = opts.holds ?? {
    recurring_routes: false,
    order_delivery: false,
    driver_payments: true,
  };
  const modes = opts.modes ?? { fulfilment_model: "unset", counter_sales: "unset" };
  const featureConfig = {
    can: jest.fn(async (_t: string, key: string) => holds[key] ?? false),
    getState: jest.fn(async (_t: string, key: string) => ({
      value: modes[key] ?? "unset",
      effective: modes[key] ?? "unset",
    })),
    set: jest.fn(),
    clear: jest.fn(),
  };
  const previewResponse = { before: [], after: [], changed: ["driver_payments"] };
  const featurePreview = { preview: jest.fn().mockResolvedValue(previewResponse) };
  const svc = new BusinessProfileService(
    prisma as never,
    featureOverrides as never,
    featureConfig as never,
    featurePreview as never,
  );
  return { svc, prisma, featureOverrides, featureConfig, featurePreview, previewResponse };
}

describe("BusinessProfileService.list", () => {
  it("returns the four profiles as shared summaries, in registry order", () => {
    const { svc } = build();
    const res = svc.list();
    expect(res.profiles.map((p) => p.key)).toEqual([
      "delivery_distributor",
      "shipping_wholesaler",
      "in_store_retailer",
      "in_store_shipping_retailer",
    ]);
    expect(res.profiles.every((p) => p.available)).toBe(true);
  });
});

describe("BusinessProfileService.preview", () => {
  it("400 BUSINESS_PROFILE_UNKNOWN for a key that is not a profile — before any read", async () => {
    const { svc, prisma, featureOverrides } = build();
    const err = await svc.preview(T, "pickup_counter").catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ code: "BUSINESS_PROFILE_UNKNOWN" });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(featureOverrides.list).not.toHaveBeenCalled();
  });

  it("404 for a tenant that does not exist", async () => {
    const { svc } = build({ tenant: null });
    await expect(svc.preview("nope", "shipping_wholesaler")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("previews through the EXISTING feature preview with only the non-skip overrides and the profile's modes", async () => {
    const { svc, featurePreview, previewResponse } = build();
    const res = await svc.preview(T, "shipping_wholesaler");
    expect(featurePreview.preview).toHaveBeenCalledWith(T, {
      overrides: [
        {
          featureKey: "driver_payments",
          effect: "DENY",
          reason: "Business profile: Shipping wholesaler",
        },
      ],
      modes: { fulfilment_model: "ship" },
    });
    expect(res).toEqual({
      ...previewResponse,
      profile: "shipping_wholesaler",
      plan: {
        overrides: [
          { featureKey: "recurring_routes", effect: "DENY", action: "skip" },
          { featureKey: "order_delivery", effect: "DENY", action: "skip" },
          { featureKey: "driver_payments", effect: "DENY", action: "create" },
        ],
        modes: [{ key: "fulfilment_model", from: "unset", to: "ship" }],
      },
      summary: expect.arrayContaining([
        "How orders reach customers: Not configured (today's behavior) → Ship by carrier",
      ]),
    });
    expect(res.summary).toHaveLength(2);
  });

  it("writes NOTHING (no override, no config row)", async () => {
    const { svc, featureConfig } = build();
    await svc.preview(T, "delivery_distributor");
    expect(featureConfig.set).not.toHaveBeenCalled();
    expect(featureConfig.clear).not.toHaveBeenCalled();
  });

  it("is tenant-scoped: every read names the target tenant and nothing else", async () => {
    const { svc, prisma, featureOverrides, featureConfig, featurePreview } = build();
    await svc.preview(T, "in_store_retailer");
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: T },
      select: { id: true },
    });
    expect(featureOverrides.list).toHaveBeenCalledWith(T);
    for (const call of [
      ...featureConfig.can.mock.calls,
      ...featureConfig.getState.mock.calls,
      ...featurePreview.preview.mock.calls,
    ]) {
      expect(call[0]).toBe(T);
    }
  });
});

describe("BusinessProfileService.plan — the confirm-time plan", () => {
  it("reads only ACTIVE overrides (revoked and expired rows are ignored) and returns the row to revoke for each replace", async () => {
    const now = Date.now();
    const { svc } = build({
      overrides: [
        overrideRow({
          id: "old",
          featureKey: "order_delivery",
          effect: "DENY",
          revokedAt: new Date(now - DAY),
        }),
        overrideRow({
          id: "expired",
          featureKey: "recurring_routes",
          effect: "DENY",
          expiresAt: new Date(now - DAY),
        }),
        overrideRow({
          id: "live",
          featureKey: "order_delivery",
          effect: "DENY",
          expiresAt: new Date(now + DAY),
        }),
      ],
    });
    const res = await svc.plan(T, "delivery_distributor");
    expect(res.plan.overrides).toEqual([
      { featureKey: "recurring_routes", effect: "GRANT", action: "create" },
      { featureKey: "order_delivery", effect: "GRANT", action: "replace" },
      { featureKey: "driver_payments", effect: "GRANT", action: "skip" },
    ]);
    expect(res.revokeOverrideIds).toEqual({ order_delivery: "live" });
    expect(res.profile.key).toBe("delivery_distributor");
  });

  it("a tenant that already matches plans nothing: before == after", async () => {
    const { svc } = build({
      overrides: [overrideRow({ id: "d", featureKey: "driver_payments", effect: "DENY" })],
      holds: { recurring_routes: false, order_delivery: false, driver_payments: false },
      modes: { fulfilment_model: "ship", counter_sales: "unset" },
    });
    const res = await svc.plan(T, "shipping_wholesaler");
    expect(res.plan.overrides.every((o) => o.action === "skip")).toBe(true);
    expect(res.plan.modes).toEqual([]);
    expect(res.summary).toEqual([]);
  });
});
