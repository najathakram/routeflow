/**
 * Owner ruling 2026-09-28 ("On for everyone"): `orders_inline_returns` is defaultGranted, and the
 * default grant must be honoured at RUNTIME, not just by the explain/preview resolver. One
 * predicate (`isDefaultGrantedAddon`) feeds AddonService, so AddonGuard, GET /tenants/me/addons
 * and hasAddon (InlineReturnsService's own check) all agree. Lead's red-first cases:
 *   (1) no row + flag.returns          → allowed; /me/addons lists the key; hasAddon true
 *   (2) same tenant + a DENY override  → 403; key absent; hasAddon false
 *   (3) no flag.returns                → still 403 (requires still gates)
 *   (4) a defaultGranted:false key     → still 403 with no row (no blast radius)
 */
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { AddonService } from "./addon.service";
import { AddonGuard } from "./addon.guard";
import { TenantsController } from "../tenants/tenants.controller";
import {
  DEFAULT_GRANTED_ADDON_FEATURES,
  FEATURE_REGISTRY,
  isDefaultGrantedAddon,
} from "./feature-registry";
import { resolveOneKey } from "./feature-resolver.service";

const KEY = "orders_inline_returns";
const NOT_DEFAULT = "recurring_routes"; // RequireAddon, enforced, defaultGranted:false
const TENANT = "t-acme";

type Effect = "GRANT" | "DENY";

function harness(opts: { flags: string[]; rows?: string[]; overrides?: Record<string, Effect> }) {
  const rows = opts.rows ?? [];
  const overrides = new Map<string, Effect>(Object.entries(opts.overrides ?? {}));
  const prisma = {
    tenantAddon: {
      findMany: jest.fn().mockResolvedValue(rows.map((addonKey) => ({ addonKey }))),
      findFirst: jest
        .fn()
        .mockImplementation(({ where }: { where: { OR: Array<{ addonKey?: string }> } }) => {
          const hit = where.OR.some(
            (c) => typeof c.addonKey === "string" && rows.includes(c.addonKey),
          );
          return Promise.resolve(hit ? { active: true } : null);
        }),
    },
  };
  const entitlements = {
    resolve: jest.fn().mockResolvedValue({ planKey: "pro", flags: opts.flags }),
    isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false),
  };
  const featureOverrides = {
    get: jest
      .fn()
      .mockImplementation((_t: string, k: string) => Promise.resolve(overrides.get(k) ?? null)),
    getMany: jest.fn().mockImplementation((_t: string, keys: string[]) => {
      const m = new Map<string, Effect>();
      for (const k of keys) if (overrides.has(k)) m.set(k, overrides.get(k)!);
      return Promise.resolve(m);
    }),
    allActive: jest.fn().mockResolvedValue(overrides),
  };
  const service = new AddonService(
    prisma as never,
    {} as never, // stripe
    entitlements as never,
    {} as never, // catalog
    {} as never, // featureResolver
    {} as never, // authority
    {} as never, // events
    featureOverrides as never,
  );
  const guardFor = (key: string) => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue([key]) };
    const guard = new AddonGuard(
      reflector as unknown as Reflector,
      service,
      entitlements as never,
      featureOverrides as never,
    );
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          user: { tenantId: TENANT },
          method: "POST",
          url: "/returns/inline/quote",
        }),
      }),
    } as unknown as ExecutionContext;
    return () => guard.canActivate(ctx);
  };
  const meAddons = () =>
    TenantsController.prototype.getMyAddons.call({ addonService: service, featureOverrides }, {
      tenantId: TENANT,
    } as never) as Promise<{ addons: string[] }>;
  return { service, guardFor, meAddons, entitlements, prisma };
}

describe("registry: orders_inline_returns is default-granted, gated by flag.returns", () => {
  it("is defaultGranted with requires allOf flag.returns, and is the only default add-on", () => {
    const row = FEATURE_REGISTRY.find((f) => f.key === KEY)!;
    expect(row.defaultGranted).toBe(true);
    expect(row.requires).toEqual({ allOf: ["flag.returns"] });
    expect(DEFAULT_GRANTED_ADDON_FEATURES.map((f) => f.key)).toEqual([KEY]);
  });

  it("the predicate: requires met against rows ∪ ent.flags; false for non-default keys", () => {
    const row = FEATURE_REGISTRY.find((f) => f.key === KEY)!;
    expect(isDefaultGrantedAddon(row, [], ["flag.returns"])).toBe(true);
    expect(isDefaultGrantedAddon(row, [], [])).toBe(false);
    const other = FEATURE_REGISTRY.find((f) => f.key === NOT_DEFAULT)!;
    expect(isDefaultGrantedAddon(other, [], ["flag.returns"])).toBe(false);
  });
});

describe("(1) no row + flag.returns → held everywhere", () => {
  it("AddonGuard allows the inline-returns quote", async () => {
    await expect(harness({ flags: ["flag.returns"] }).guardFor(KEY)()).resolves.toBe(true);
  });
  it("GET /tenants/me/addons includes the key (web useHasAddon, mobile lib/api/addons)", async () => {
    const { addons } = await harness({ flags: ["flag.returns"] }).meAddons();
    expect(addons).toContain(KEY);
  });
  it("hasAddon is true (InlineReturnsService.assertGranted)", async () => {
    await expect(harness({ flags: ["flag.returns"] }).service.hasAddon(TENANT, KEY)).resolves.toBe(
      true,
    );
  });
});

describe("(2) same tenant with a DENY override → not held", () => {
  const h = () => harness({ flags: ["flag.returns"], overrides: { [KEY]: "DENY" } });
  it("AddonGuard 403s", async () => {
    await expect(h().guardFor(KEY)()).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("/me/addons omits the key", async () => {
    expect((await h().meAddons()).addons).not.toContain(KEY);
  });
  it("hasAddon is false and getActiveAddons omits it", async () => {
    const { service } = h();
    await expect(service.hasAddon(TENANT, KEY)).resolves.toBe(false);
    await expect(service.getActiveAddons(TENANT)).resolves.not.toContain(KEY);
  });
});

describe("(3) no flag.returns → still gated by requires", () => {
  const h = () => harness({ flags: ["flag.analytics"] });
  it("AddonGuard 403s", async () => {
    await expect(h().guardFor(KEY)()).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("/me/addons omits it and hasAddon is false", async () => {
    const x = h();
    expect((await x.meAddons()).addons).not.toContain(KEY);
    await expect(x.service.hasAddon(TENANT, KEY)).resolves.toBe(false);
  });
});

describe("(4) a defaultGranted:false add-on with no row → unchanged, still 403", () => {
  it("AddonGuard 403s recurring_routes even with every flag", async () => {
    const h = harness({ flags: ["flag.returns", "flag.analytics"] });
    await expect(h.guardFor(NOT_DEFAULT)()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(h.service.hasAddon(TENANT, NOT_DEFAULT)).resolves.toBe(false);
    expect(await h.service.getActiveAddons(TENANT)).toEqual([KEY]);
  });
  it("a held row still decides as before, and is not duplicated", async () => {
    const h = harness({ flags: ["flag.returns"], rows: [NOT_DEFAULT, KEY] });
    await expect(h.guardFor(NOT_DEFAULT)()).resolves.toBe(true);
    expect((await h.service.getActiveAddons(TENANT)).sort()).toEqual([KEY, NOT_DEFAULT].sort());
  });
});

describe("fail closed + explain/preview parity", () => {
  it("if entitlements cannot resolve, the default grant is skipped (rows still count)", async () => {
    const h = harness({ flags: ["flag.returns"], rows: [NOT_DEFAULT] });
    h.entitlements.resolve.mockRejectedValue(new Error("db down"));
    await expect(h.service.getActiveAddons(TENANT)).resolves.toEqual([NOT_DEFAULT]);
    await expect(h.service.hasAddon(TENANT, KEY)).resolves.toBe(false);
  });

  it("resolveOneKey (explain/preview) agrees with the runtime rule", () => {
    const row = FEATURE_REGISTRY.find((f) => f.key === KEY)!;
    const base = {
      overrides: new Map<string, Effect>(),
      activeAddonSet: new Set<string>(),
      planFeatureFlags: new Set<string>(),
      activeSkuSet: new Set<string>(),
    };
    expect(resolveOneKey(row, { ...base, entFlags: ["flag.returns"] })).toMatchObject({
      effective: true,
      source: "PRESET",
      term: "default",
    });
    expect(resolveOneKey(row, { ...base, entFlags: [] }).effective).toBe(false);
    expect(
      resolveOneKey(row, {
        ...base,
        entFlags: ["flag.returns"],
        overrides: new Map([[KEY, "DENY" as Effect]]),
      }).effective,
    ).toBe(false);
  });
});
