/**
 * Row 640 (SA-834, R5 part 2 builder B) against real Postgres AND the real published plan catalog (v11..v13
 * published into the test database by the shipped publishers): a snapshot restore re-creates a GRANT override
 * only when the add-on behind it is paid for. Coverage is read through the REAL `PlanCatalogService` and
 * `PlanTransitionConfigService.planAllowsFor`, never a stub, so the catalog's prices and plan inclusion decide.
 *  - a non-COMP GRANT on an add-on key with no billed TenantAddon is held ADDON_NOT_PAID in preview AND apply;
 *  - a billed active row (price equal to the catalog's) restores it; so does a plan that includes the SKU;
 *  - a COMP GRANT is restored as-was;
 *  - a tenant pinned to an older version that predates the SKU, holding a row billed at the PUBLISHED price,
 *    restores it (the price is pinned-else-published, `pricedAddonSku`). No shipped version predates
 *    OCR_PACK_250 (v8 has it; v11+ retire it), so the pinned version is a spec-made SUPERSEDED copy of the
 *    published one without REGULATED_ITEMS, deleted in afterAll;
 *  - a trial plan change naming the add-on (a same-transaction PENDING key) whose checkout writes a price-0
 *    trial row does NOT cover payment: the GRANT is held ADDON_NOT_PAID (B fold d19ef19d6).
 * Throwaway `qa-r640-*` tenants. Collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { PlanTransitionConfigService } from "./plan-transition-config.service";
import {
  AUTO_RESTORE_MAX_ROWS,
  AUTO_RESTORE_TIME_BUDGET_MS,
  TenantConfigSnapshotService,
} from "./tenant-config-snapshot.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
/** `tobacco_dealer` is billed through the REGULATED_ITEMS SKU (the catalog prices it; SCALE includes it). */
const KEY = "tobacco_dealer";
const SKU = "REGULATED_ITEMS";

describeDb(
  "row 640: restored GRANT overrides against the real plan catalog — real Postgres",
  () => {
    let prisma: PrismaService;
    let catalog: PlanCatalogService;
    let transition: PlanTransitionConfigService;
    const svc = new TenantConfigSnapshotService();
    const tenants: string[] = [];
    let seq = 0;
    let skuPrice = 0;
    const versions: string[] = [];

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      prisma = new PrismaService(new TenantContextService());
      await prisma.$connect();
      catalog = new PlanCatalogService(prisma);
      // planAllowsFor reads only the catalog; the other collaborators are never touched by it.
      transition = new PlanTransitionConfigService(
        null as never,
        null as never,
        catalog,
        null as never,
        null as never,
        null as never,
      );
      const published = await catalog.getPublishedVersion();
      if (!published)
        throw new Error("no published plan catalog: run db:publish:catalog:v11..v13 first");
      const sku = (
        published as unknown as {
          addonSkus: { sku: string; monthlyPrice: unknown; includedAtPlan: string | null }[];
        }
      ).addonSkus.find((s) => s.sku === SKU);
      if (!sku) throw new Error(`the published catalog has no ${SKU}`);
      skuPrice = Number(sku.monthlyPrice);
      expect(skuPrice).toBeGreaterThan(0);
      expect(sku.includedAtPlan).toBe("SCALE");
    });

    afterAll(async () => {
      for (const tenantId of tenants) {
        // eslint-disable-next-line no-await-in-loop
        await (async () => {
          await prisma.tenantFeatureConfigSnapshot.deleteMany({ where: { tenantId } });
          await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId } });
          await prisma.tenantAddon.deleteMany({ where: { tenantId } });
          await prisma.auditLog.deleteMany({ where: { tenantId } });
          await prisma.tenant.delete({ where: { id: tenantId } });
        })().catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`row 640 cleanup failed for ${tenantId}:`, e);
        });
      }
      for (const id of versions)
        // eslint-disable-next-line no-await-in-loop
        await prisma.planVersion.delete({ where: { id } }).catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`row 640 cleanup failed for plan version ${id}:`, e);
        });
      await prisma.$disconnect();
    });

    async function world(label: string, kind: "SUPPORT" | "COMP" = "SUPPORT") {
      seq += 1;
      const slug = assertTestTenant(`qa-r640-${RUN}-${seq}-${label}`, "restore-grants.db.spec.ts");
      const tenantId = (await prisma.tenant.create({ data: { slug, name: `R640 ${slug}` } })).id;
      tenants.push(tenantId);
      await prisma.tenantFeatureOverride.create({
        data: { tenantId, featureKey: KEY, effect: "GRANT", kind, reason: "spec grant" } as never,
      });
      return tenantId;
    }
    /** Snapshot on `plan`, lose the override, then preview and apply a restore to `plan` with the REAL coverage. */
    async function snapshotLoseRestore(
      tenantId: string,
      plan: string,
      planVersionId: string | null = null,
    ) {
      await prisma.$transaction((tx) =>
        svc.snapshot(tx, tenantId, plan, "DOWNGRADE", { id: null, name: "spec" }),
      );
      await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId } });
      const planAllows = await transition.planAllowsFor(plan, planVersionId);
      const snap = await prisma.tenantFeatureConfigSnapshot.findFirstOrThrow({
        where: { tenantId },
      });
      const preview = await prisma.$transaction((tx) =>
        svc.previewRestore(tx, tenantId, snap.id, new Date(), planAllows),
      );
      const applied = await prisma.$transaction((tx) =>
        svc.restoreLatest(tx, tenantId, plan, new Date(), planAllows),
      );
      const grant = await prisma.tenantFeatureOverride.findFirst({
        where: { tenantId, featureKey: KEY, revokedAt: null },
      });
      return { preview, applied, grant };
    }
    /** A SUPERSEDED copy of the published catalog WITHOUT `SKU`: a version that predates the add-on. */
    async function versionWithoutSku(): Promise<string> {
      const published = await prisma.planVersion.findFirstOrThrow({
        where: { status: "PUBLISHED" },
        include: { definitions: true, addonSkus: true },
      });
      const strip = <T extends { id: string; planVersionId: string }>({
        id: _id,
        planVersionId: _v,
        ...rest
      }: T) => rest;
      const created = await prisma.planVersion.create({
        data: {
          version: 900_000 + Math.floor(Math.random() * 99_999),
          status: "SUPERSEDED",
          notes: `row 640 spec ${RUN}: published minus ${SKU}`,
          definitions: { create: published.definitions.map(strip) },
          addonSkus: { create: published.addonSkus.filter((s) => s.sku !== SKU).map(strip) },
        } as never,
      });
      versions.push(created.id);
      const pinned = await catalog.getVersionById(created.id);
      expect(pinned?.addonSkus.some((s) => s.sku === SKU)).toBe(false);
      return created.id;
    }
    const heldReasons = (
      held: readonly { kind: string; featureKey: string; reason: string }[] | undefined,
    ) =>
      (held ?? [])
        .filter((h) => h.kind === "override" && h.featureKey === KEY)
        .map((h) => h.reason);

    it("REG: a non-COMP GRANT with no billed add-on row is held ADDON_NOT_PAID in preview AND apply", async () => {
      const t = await world("unpaid");
      const { preview, applied, grant } = await snapshotLoseRestore(t, "GROWTH");
      expect(heldReasons(preview?.held)).toEqual(["ADDON_NOT_PAID"]);
      expect(heldReasons(applied?.held)).toEqual(["ADDON_NOT_PAID"]);
      expect(grant).toBeNull();
    });

    it("an active row priced OFF the catalog (not Stripe-billable) still holds it", async () => {
      const t = await world("offprice");
      await prisma.tenantAddon.create({
        data: {
          tenantId: t,
          addonKey: KEY,
          sku: SKU,
          priceSnapshot: skuPrice / 2,
          active: true,
        } as never,
      });
      const { applied, grant } = await snapshotLoseRestore(t, "GROWTH");
      expect(heldReasons(applied?.held)).toEqual(["ADDON_NOT_PAID"]);
      expect(grant).toBeNull();
    });

    it("a billed active row (the catalog price) restores it", async () => {
      const t = await world("billed");
      await prisma.tenantAddon.create({
        data: {
          tenantId: t,
          addonKey: KEY,
          sku: SKU,
          priceSnapshot: skuPrice,
          active: true,
        } as never,
      });
      const { preview, applied, grant } = await snapshotLoseRestore(t, "GROWTH");
      expect(heldReasons(preview?.held)).toEqual([]);
      expect(heldReasons(applied?.held)).toEqual([]);
      expect(grant).toMatchObject({ featureKey: KEY, effect: "GRANT", kind: "SUPPORT" });
    });

    it("a plan that includes the SKU (SCALE) restores it with no add-on row", async () => {
      const t = await world("included");
      const { applied, grant } = await snapshotLoseRestore(t, "SCALE");
      expect(heldReasons(applied?.held)).toEqual([]);
      expect(grant).toMatchObject({ featureKey: KEY, effect: "GRANT" });
    });

    it("a COMP GRANT is restored as-was with no add-on row", async () => {
      const t = await world("comp", "COMP");
      const { preview, applied, grant } = await snapshotLoseRestore(t, "GROWTH");
      expect(heldReasons(preview?.held)).toEqual([]);
      expect(heldReasons(applied?.held)).toEqual([]);
      expect(grant).toMatchObject({ featureKey: KEY, effect: "GRANT", kind: "COMP" });
    });

    it("REG (B fold): pinned to a version that predates the SKU, a row billed at the PUBLISHED price restores it", async () => {
      const pinnedVersionId = await versionWithoutSku();
      const t = await world("pinned-old");
      await prisma.tenant.update({ where: { id: t }, data: { planVersionId: pinnedVersionId } });
      await prisma.tenantAddon.create({
        data: {
          tenantId: t,
          addonKey: KEY,
          sku: SKU,
          priceSnapshot: skuPrice,
          active: true,
        } as never,
      });
      const { preview, applied, grant } = await snapshotLoseRestore(t, "GROWTH", pinnedVersionId);
      expect(heldReasons(preview?.held)).toEqual([]);
      expect(heldReasons(applied?.held)).toEqual([]);
      expect(grant).toMatchObject({ featureKey: KEY, effect: "GRANT", kind: "SUPPORT" });
    });

    // The payload may name the add-on by its SKU code or its legacy add-on key; before d19ef19d6 the key form covered.
    it.each([
      ["SKU code", SKU],
      ["add-on key", KEY],
    ])(
      "REG (B fold 2): a trial plan change naming the add-on (%s) at price 0 holds a restored non-COMP GRANT",
      async (_form, pending) => {
        const t = await world(`trial-pending-${pending === SKU ? "sku" : "key"}`);
        await prisma.$transaction((tx) =>
          svc.snapshot(tx, t, "GROWTH", "DOWNGRADE", { id: null, name: "spec" }),
        );
        await prisma.tenantFeatureOverride.deleteMany({ where: { tenantId: t } });
        const planAllows = await transition.planAllowsFor("GROWTH", null);
        // The plan-change transaction: the restore runs with the payload's add-on as a PENDING key, then the
        // checkout writes the add-on's TRIAL row (price 0, unbilled until that checkout).
        const applied = await prisma.$transaction(async (tx) => {
          const r = await svc.restoreLatest(
            tx,
            t,
            "GROWTH",
            new Date(),
            planAllows,
            { maxRows: AUTO_RESTORE_MAX_ROWS, timeBudgetMs: AUTO_RESTORE_TIME_BUDGET_MS },
            [pending],
          );
          await tx.tenantAddon.create({
            data: { tenantId: t, addonKey: KEY, sku: SKU, priceSnapshot: 0, active: true } as never,
          });
          return r;
        });
        expect(heldReasons(applied?.held)).toEqual(["ADDON_NOT_PAID"]);
        const grants = await prisma.tenantFeatureOverride.findMany({
          where: { tenantId: t, revokedAt: null },
        });
        expect(grants).toEqual([]);
        const addons = await prisma.tenantAddon.findMany({ where: { tenantId: t } });
        expect(addons.map((a) => [a.addonKey, a.sku, Number(a.priceSnapshot), a.active])).toEqual([
          [KEY, SKU, 0, true],
        ]);
      },
    );
  },
);
