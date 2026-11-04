/**
 * FG-1 WP1 / T10 (R10) — the read-only entitlement sweep, real Postgres, real collaborators.
 *
 * `GET /platform-admin/entitlements/sweep` returns, per tenant, a hashed id, the class, an
 * `inputsHash` and per gated registry key the bits old / effective / strict / clientAddon /
 * clientFlag. The expected bits below are worked by hand from the plan fixtures (the oracle), not
 * read back from the code under test:
 *   - STARTER, no rows: the plan carries no flag. `ocr` and `flag.reports` are DARK gates, so the
 *     old path allows them as a courtesy while the resolver (no courtesy yet, WP2) says false;
 *     `tobacco_dealer` is enforced, both false. `flag.credit_limits` runs the real credit check for
 *     everyone while the switch is not "on" (SA-1099 §2): old true, effective false.
 *   - GROWTH carrying flag.reports + flag.credit_limits, plus an active tobacco_dealer row: all true.
 *   - LITE (always enforced) with a GRANT override on tobacco_dealer: that key true everywhere,
 *     `ocr` and `flag.reports` false (no courtesy for an always-enforced plan).
 *   - GROWTH with an active `ocr` row and a DENY override on it: old false, effective false.
 * Output safety: the body names no tenant name, slug or raw id. Only super admin may call it.
 *
 * Collected only by `jest.db.config.js`. SAFETY: throwaway `qa-sweep-<run>-*` tenants approved by
 * `assertTestTenant`; afterAll deletes exactly what this run created.
 */
import { randomUUID } from "crypto";
import request from "supertest";
import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient, TenantClass, TenantStatus } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { dropPublishedCatalog, ensurePublishedCatalog } from "../testing/ensure-published-catalog";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { EntitlementSweepController } from "./entitlement-sweep.controller";
import { EntitlementSweepService, hashTenantId } from "../billing/entitlement-sweep.service";
import { AddonAccessService } from "../billing/addon-access";
import { AddonService } from "../billing/addon.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EntitlementsModeService } from "../billing/entitlements-mode.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { FeatureDiffService } from "../billing/feature-diff.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { FeatureResolverService } from "../billing/feature-resolver.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SPEC = "entitlement-sweep.controller.db.spec.ts";
const SWITCH = "PLAN_FLAG_ENFORCEMENT";

type Bits = Record<string, boolean | null>;

describeDb("FG-1 WP1: entitlement sweep endpoint (real Postgres)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let app: INestApplication;
  let createdVersionId: string | undefined;
  let growthVersionId: string;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const names: string[] = [];
  const slugs: string[] = [];
  const t = {} as Record<"starter" | "growth" | "lite" | "deny", string>;
  const savedSwitch = process.env[SWITCH];

  async function tenant(label: string, planKey: string, versionId: string): Promise<string> {
    const slug = assertTestTenant(`qa-sweep-${run}-${label}`, SPEC);
    const name = `Acme Sweep Fixture ${label} ${run}`;
    const row = await prisma.tenant.create({
      data: {
        slug,
        name,
        class: TenantClass.PRODUCTION,
        status: TenantStatus.ACTIVE,
        planVersionId: versionId,
      } as never,
    });
    tenantIds.push(row.id);
    names.push(name);
    slugs.push(slug);
    await prisma.tenantSubscription.create({
      data: { tenantId: row.id, planKey, planVersionId: versionId, discount: 0 } as never,
    });
    return row.id;
  }

  const bitsFor = (body: any, tenantId: string, key: string): Bits | undefined =>
    body.tenants.find((x: any) => x.id === hashTenantId(tenantId))?.keys?.[key];
  const sweepPage = async (qs = "", role = "SUPER_ADMIN") =>
    request(app.getHttpServer())
      .get(`/platform-admin/entitlements/sweep${qs}`)
      .set("x-test-role", role);

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as never);

    createdVersionId = await ensurePublishedCatalog(
      prisma,
      {
        plans: [
          { planKey: "LITE", name: "Lite", monthlyPrice: 0 },
          { planKey: "STARTER", name: "Starter", monthlyPrice: 99 },
          { planKey: "GROWTH", name: "Growth", monthlyPrice: 249 },
        ],
        addons: [],
      },
      SPEC,
    );
    // A catalog seeded elsewhere would forward-merge its own flags into our pinned plans.
    const published = await prisma.planVersion.findFirstOrThrow({
      where: { status: "PUBLISHED" },
      include: { definitions: true },
    });
    for (const d of published.definitions.filter((x) => ["LITE", "STARTER"].includes(x.planKey))) {
      expect(d.featureFlags).not.toEqual(
        expect.arrayContaining(["flag.reports", "flag.credit_limits"]),
      );
    }
    const version = 1_900_000_000 + Math.floor(Math.random() * 99_999_999);
    growthVersionId = (
      await prisma.planVersion.create({
        data: {
          version,
          notes: `${SPEC} (spec-owned, deleted in afterAll)`,
          definitions: {
            create: [
              {
                planKey: "GROWTH",
                name: "Growth",
                monthlyPrice: 249,
                isCustom: false,
                featureFlags: ["flag.reports", "flag.credit_limits"],
              },
            ],
          },
        },
      })
    ).id;

    t.starter = await tenant("starter", "STARTER", published.id);
    t.growth = await tenant("growth", "GROWTH", growthVersionId);
    t.lite = await tenant("lite", "LITE", published.id);
    t.deny = await tenant("deny", "GROWTH", growthVersionId);

    await prisma.tenantAddon.create({
      data: { tenantId: t.growth, addonKey: "tobacco_dealer", quantity: 1, active: true },
    });
    await prisma.tenantAddon.create({
      data: { tenantId: t.deny, addonKey: "ocr", quantity: 1, active: true },
    });
    const override = (tenantId: string, featureKey: string, effect: "GRANT" | "DENY") =>
      prisma.tenantFeatureOverride.create({
        data: { tenantId, featureKey, effect, reason: `${SPEC} fixture` } as never,
      });
    await override(t.lite, "tobacco_dealer", "GRANT");
    await override(t.deny, "ocr", "DENY");

    const catalog = new PlanCatalogService(prisma as never);
    const overrides = new FeatureOverrideService(prisma as never);
    const entitlements = new EntitlementsService(prisma as never, catalog, overrides);
    const resolver = new FeatureResolverService(entitlements, overrides, catalog, prisma as never);
    const mode = new EntitlementsModeService(prisma as never);
    const authority = new EntitlementAuthority(
      entitlements,
      overrides,
      resolver,
      mode,
      new FeatureDiffService(prisma as never),
      prisma as never,
    );
    const addons = new AddonService(
      prisma as never,
      {} as never,
      entitlements,
      catalog,
      resolver,
      authority,
      { emit: jest.fn() } as never,
      overrides,
    );
    const sweep = new EntitlementSweepService(
      prisma as never,
      entitlements,
      overrides,
      resolver,
      authority,
      mode,
      addons,
      new AddonAccessService(addons, entitlements, overrides),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [EntitlementSweepController],
      providers: [{ provide: EntitlementSweepService, useValue: sweep }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          const role = req.headers["x-test-role"];
          if (!role) return false; // unauthenticated
          req.user = { tenantId: null, role };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  }, 60_000);

  beforeEach(() => {
    delete process.env[SWITCH];
  });

  afterAll(async () => {
    if (savedSwitch === undefined) delete process.env[SWITCH];
    else process.env[SWITCH] = savedSwitch;
    await app?.close();
    if (tenantIds.length) {
      await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantAddon.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenantSubscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    }
    if (growthVersionId) {
      await prisma.planDefinition.deleteMany({ where: { planVersionId: growthVersionId } });
      await prisma.planVersion.deleteMany({ where: { id: growthVersionId } });
    }
    await dropPublishedCatalog(prisma, createdVersionId);
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("super admin: the bits are right for a few keys per plan, switch unset", async () => {
    const res = await sweepPage("?limit=100");
    expect(res.status).toBe(200);
    const expectBits = (tenantId: string, key: string, want: Partial<Bits>) =>
      expect({ key, ...bitsFor(res.body, tenantId, key) }).toMatchObject({ key, ...want });

    // STARTER, no rows
    expectBits(t.starter, "tobacco_dealer", { old: false, effective: false, clientAddon: false });
    expectBits(t.starter, "ocr", { old: true, effective: false, clientAddon: false });
    expectBits(t.starter, "flag.reports", { old: true, effective: false });
    // SA-1099 §2: the credit check runs for a Starter while the switch is not on
    expectBits(t.starter, "flag.credit_limits", { old: true, effective: false });
    // GROWTH carrying the flags, tobacco_dealer row active
    expectBits(t.growth, "tobacco_dealer", { old: true, effective: true, clientAddon: true });
    expectBits(t.growth, "flag.reports", { old: true, effective: true });
    expectBits(t.growth, "flag.credit_limits", { old: true, effective: true });
    // LITE (always enforced) + GRANT on tobacco_dealer
    expectBits(t.lite, "tobacco_dealer", { old: true, effective: true, clientAddon: true });
    expectBits(t.lite, "ocr", { old: false, effective: false, clientAddon: false });
    expectBits(t.lite, "flag.reports", { old: false, effective: false });
    // GROWTH, ocr row active but DENY override
    expectBits(t.deny, "ocr", { old: false, effective: false, clientAddon: false });
    // strict is a bit on every gated key (WP2 makes it differ from effective)
    expect(typeof bitsFor(res.body, t.growth, "ocr")?.strict).toBe("boolean");

    const row = res.body.tenants.find((x: any) => x.id === hashTenantId(t.lite));
    expect(row.class).toBe("PRODUCTION");
    expect(row.inputsHash).toMatch(/^[0-9a-f]{16,}$/);
    // one row per distinct multi-key @RequireAddon set
    expect(Object.keys(row.sets).sort()).toEqual([
      "order_delivery|developer_mode",
      "recurring_routes|order_delivery|developer_mode",
    ]);
  }, 60_000);

  it("switch 'on': a Starter without the flag is no longer checked, and the page says so", async () => {
    process.env[SWITCH] = "on";
    const res = await sweepPage("?limit=100");
    expect(res.status).toBe(200);
    expect(res.body.planFlagEnforcement).toBe("on");
    expect(bitsFor(res.body, t.starter, "flag.credit_limits")?.old).toBe(false);
    expect(bitsFor(res.body, t.growth, "flag.credit_limits")?.old).toBe(true);
  }, 60_000);

  it("the first page carries mode + planFlagEnforcement and no other env; later pages omit them", async () => {
    const first = await sweepPage("?limit=1");
    expect(first.status).toBe(200);
    expect(Object.keys(first.body).sort()).toEqual([
      "mode",
      "nextCursor",
      "planFlagEnforcement",
      "tenants",
    ]);
    expect(first.body.mode).toBe("shadow");
    expect(first.body.planFlagEnforcement).toBe("off");
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await sweepPage(`?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.status).toBe(200);
    expect(second.body.mode).toBeUndefined();
    expect(second.body.planFlagEnforcement).toBeUndefined();
    expect(Object.keys(second.body).sort()).toEqual(["nextCursor", "tenants"]);
  }, 60_000);

  it("no business name, slug or raw id anywhere in the body (including the cursor)", async () => {
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await sweepPage(
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(res.status).toBe(200);
      all.push(res.text);
      cursor = res.body.nextCursor;
    } while (cursor);
    const text = all.join("\n");
    for (const needle of [...names, ...slugs, ...tenantIds]) expect(text).not.toContain(needle);
    for (const id of tenantIds) expect(text).toContain(hashTenantId(id));
    for (const id of tenantIds) expect(hashTenantId(id)).not.toBe(id);
  }, 60_000);

  it("cursor paging walks every tenant exactly once", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await sweepPage(
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.tenants.length).toBeLessThanOrEqual(2);
      seen.push(...res.body.tenants.map((x: any) => x.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor && pages < 500);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(await prisma.tenant.count());
    for (const id of tenantIds) expect(seen).toContain(hashTenantId(id));
  }, 120_000);

  it("an OPERATOR gets 403 and an unauthenticated caller is refused", async () => {
    const operator = await sweepPage("", "OPERATOR");
    expect(operator.status).toBe(403);
    expect(operator.text).not.toContain("tenants");
    const anon = await request(app.getHttpServer()).get("/platform-admin/entitlements/sweep");
    expect([401, 403]).toContain(anon.status);
  }, 60_000);
});
