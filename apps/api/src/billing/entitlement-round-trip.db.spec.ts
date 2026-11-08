/**
 * SA-1106 WP8 (T15 / T16, R15 / R16): a GRANT or a DENY on every `override:true` registry row reaches every reader
 * a client or a guard uses, over a real Postgres and the real collaborators. Readers, by gate:
 *   RequireAddon   : AddonGuard, AddonService.hasAddon, `/tenants/me/addons` (heldAddonKeys)
 *   RequirePlanFlag: EntitlementsService.hasFlag, `subscription.flags` (computeServedFlags), and, when the row
 *                    declares `grant.addonKey` (flag.msrp -> msrp), hasAddon and `/tenants/me/addons` too
 *   guard          : hasAddon and `/tenants/me/addons` (driver_payments)
 * Rows whose gate is "none" or "service" have no reader beyond the console; they are named, not skipped silently.
 * Red on master: a GRANT on flag.sales_agents is absent from `/me/addons`; hasAddon ignores a DENY on a held row.
 */
import { randomUUID } from "crypto";
import { ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { AddonService } from "./addon.service";
import { AddonGuard } from "./addon.guard";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { FEATURE_REGISTRY } from "./feature-registry";
import { heldAddonKeys } from "./fulfilment-capability";
import { computeServedFlags } from "./plan-flag-policy";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

type Row = (typeof FEATURE_REGISTRY)[number];
const ROWS = FEATURE_REGISTRY.filter((f) => f.grant.override);
const addonRows = ROWS.filter((f) => f.gate.via === "RequireAddon");
const flagRows = ROWS.filter((f) => f.gate.via === "RequirePlanFlag");
const guardRows = ROWS.filter((f) => f.gate.via === "guard");
const noReader = ROWS.filter(
  (f) => !["RequireAddon", "RequirePlanFlag", "guard"].includes(f.gate.via),
);
// The add-on key a client asks for: the row's own declaration, else the key itself (ocr declares none).
const askKey = (f: Row) => f.grant.addonKey ?? f.key;

describeDb("WP8 round trip: every override reaches every reader (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let addons: AddonService;
  let entitlements: EntitlementsService;
  let overrides: FeatureOverrideService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const versionIds: string[] = [];
  let createdVersionId: string | undefined;
  let versionAllFlags: string;
  let versionNoFlags: string;
  let seq = 0;

  async function specVersion(featureFlags: string[]) {
    const v = await prisma.planVersion.create({
      data: {
        version: 1_900_000_000 + Math.floor(Math.random() * 99_999_999),
        notes: "entitlement-round-trip.db.spec.ts (spec-owned, deleted in afterAll)",
        definitions: {
          create: [
            { planKey: "GROWTH", name: "Growth", monthlyPrice: 249, isCustom: false, featureFlags },
          ],
        },
      },
    });
    versionIds.push(v.id);
    return v.id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    createdVersionId = await ensurePublishedCatalog(
      prisma,
      { plans: [{ planKey: "GROWTH", name: "Growth", monthlyPrice: 249 }], addons: [] },
      "entitlement-round-trip.db.spec.ts",
    );
    versionAllFlags = await specVersion(flagRows.map((f) => f.key));
    versionNoFlags = await specVersion([]);
    const catalog = new PlanCatalogService(prisma as any);
    overrides = new FeatureOverrideService(prisma as any);
    entitlements = new EntitlementsService(prisma as any, catalog, overrides);
    addons = new AddonService(
      prisma as any,
      {} as any,
      entitlements,
      catalog,
      { invalidate: jest.fn() } as any,
      { assertFeatureRequiresMet: jest.fn().mockResolvedValue(undefined) } as any,
      { emit: jest.fn() } as any,
      overrides,
    );
  });

  afterAll(async () => {
    if (tenantIds.length) {
      await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    await prisma.planVersion.deleteMany({ where: { id: { in: versionIds.filter(Boolean) } } });
    await dropPublishedCatalog(prisma, createdVersionId);
    await prisma?.$disconnect();
    await pool?.end();
  });

  /** A throwaway ACTIVE GROWTH tenant pinned to a spec-owned version (every flag, or none). */
  async function tenant(label: string, withFlags: boolean): Promise<string> {
    seq += 1;
    const slug = assertTestTenant(
      `qa-wp8rt-${run}-${seq}-${label}`,
      "entitlement-round-trip.db.spec.ts",
    );
    const planVersionId = withFlags ? versionAllFlags : versionNoFlags;
    const t = await prisma.tenant.create({
      data: {
        slug,
        name: slug,
        class: TenantClass.PRODUCTION,
        status: TenantStatus.ACTIVE,
        planVersionId,
      } as any,
    });
    tenantIds.push(t.id);
    await prisma.tenantSubscription.create({
      data: {
        tenantId: t.id,
        planKey: "GROWTH",
        planVersionId,
        stripeSubId: `sub_wp8rt_${run}_${seq}`,
        discount: 0,
      } as any,
    });
    return t.id;
  }

  const setOverride = (tenantId: string, featureKey: string, effect: "GRANT" | "DENY") =>
    overrides.create({
      tenantId,
      featureKey,
      effect,
      reason: "WP8 round-trip db.spec fixture",
      expiresAt: null,
      createdById: null,
    });

  function guardFor(key: string, tenantId: string) {
    const guard = new AddonGuard(
      { getAllAndOverride: jest.fn().mockReturnValue([key]) } as unknown as Reflector,
      addons,
      entitlements,
      overrides,
    );
    const ctx = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ user: { tenantId }, method: "POST", url: "/x" }),
      }),
    } as unknown as ExecutionContext;
    return () => guard.canActivate(ctx);
  }

  /** What `/tenants/me/addons` and `subscription.flags` answer for this tenant. */
  async function readers(tenantId: string) {
    const held = await heldAddonKeys(addons, overrides, tenantId);
    const ent = await entitlements.resolve(tenantId);
    const served = computeServedFlags(ent.planKey, ent.flags, await overrides.allActive(tenantId), {
      PLAN_FLAG_ENFORCEMENT: "on",
    } as NodeJS.ProcessEnv);
    return { held, served };
  }

  it("covers every override:true row: addon, plan-flag and guard rows have readers; the rest are named", () => {
    expect(addonRows.length + flagRows.length + guardRows.length + noReader.length).toBe(
      ROWS.length,
    );
    for (const f of noReader) expect(["none", "service"]).toContain(f.gate.via);
  });

  describe.each(addonRows.map((f) => [f.key, f] as const))("RequireAddon row %s", (key, f) => {
    it("T15 GRANT: guard, hasAddon and /me/addons all say yes with no row", async () => {
      const t = await tenant("ag", false);
      await setOverride(t, key, "GRANT");
      await expect(guardFor(key, t)()).resolves.toBe(true);
      await expect(addons.hasAddon(t, askKey(f))).resolves.toBe(true);
      expect((await readers(t)).held.has(askKey(f))).toBe(true);
    });
    it("T16 DENY over a held row: guard, hasAddon and /me/addons all say no", async () => {
      const t = await tenant("ad", false);
      await prisma.tenantAddon.create({ data: { tenantId: t, addonKey: askKey(f), active: true } });
      await setOverride(t, key, "DENY");
      await expect(guardFor(key, t)()).rejects.toBeInstanceOf(ForbiddenException);
      await expect(addons.hasAddon(t, askKey(f))).resolves.toBe(false);
      expect((await readers(t)).held.has(askKey(f))).toBe(false);
    });
  });

  describe.each(flagRows.map((f) => [f.key, f] as const))("RequirePlanFlag row %s", (key, f) => {
    it("T15 GRANT: hasFlag and subscription.flags say yes; so do hasAddon and /me/addons when it declares an add-on key", async () => {
      const t = await tenant("fg", false);
      await setOverride(t, key, "GRANT");
      const r = await readers(t);
      await expect(entitlements.hasFlag(t, key)).resolves.toBe(true);
      expect(r.served).toContain(key);
      if (f.grant.addonKey) {
        await expect(addons.hasAddon(t, f.grant.addonKey)).resolves.toBe(true);
        expect(r.held.has(f.grant.addonKey)).toBe(true);
      }
    });
    it("T16 DENY over a plan-held flag (and a held add-on row): every reader says no", async () => {
      const t = await tenant("fd", true);
      if (f.grant.addonKey) {
        await prisma.tenantAddon.create({
          data: { tenantId: t, addonKey: f.grant.addonKey, active: true },
        });
      }
      await setOverride(t, key, "DENY");
      const r = await readers(t);
      await expect(entitlements.hasFlag(t, key)).resolves.toBe(false);
      expect(r.served).not.toContain(key);
      if (f.grant.addonKey) {
        await expect(addons.hasAddon(t, f.grant.addonKey)).resolves.toBe(false);
        expect(r.held.has(f.grant.addonKey)).toBe(false);
      }
    });
  });

  describe.each(guardRows.map((f) => [f.key, f] as const))("guard row %s", (key, f) => {
    it("T15/T16: a GRANT shows in hasAddon and /me/addons; a DENY over a held row hides it", async () => {
      const g = await tenant("gg", false);
      await setOverride(g, key, "GRANT");
      await expect(addons.hasAddon(g, askKey(f))).resolves.toBe(true);
      expect((await readers(g)).held.has(askKey(f))).toBe(true);
      const d = await tenant("gd", false);
      await prisma.tenantAddon.create({ data: { tenantId: d, addonKey: askKey(f), active: true } });
      await setOverride(d, key, "DENY");
      await expect(addons.hasAddon(d, askKey(f))).resolves.toBe(false);
      expect((await readers(d)).held.has(askKey(f))).toBe(false);
    });
  });

  it("a business with no override moves nowhere: rows, plan flags and defaults answer as before", async () => {
    const t = await tenant("none", true);
    await prisma.tenantAddon.create({ data: { tenantId: t, addonKey: "msrp", active: true } });
    const r = await readers(t);
    expect([...r.held].sort()).toEqual([...(await addons.getActiveAddons(t))].sort());
    await expect(addons.hasAddon(t, "msrp")).resolves.toBe(true);
    await expect(addons.hasAddon(t, "sales_agents")).resolves.toBe(false);
  });
});
