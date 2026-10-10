/**
 * WS9 Settings → Inventory & ordering against a REAL Postgres: tenant A patches to "backorder"
 * while tenant B stays "off" (GET and the buyer resolver both), a PATCH writes a `policy.set`
 * AuditLog row, and the superseded row is kept (append-only).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`;
 * `requireLocalDatabaseUrl()` refuses any non-local host. SAFETY: every tenant is a throwaway
 * `qa-invsettings-<run>-<n>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the
 * tenants THIS run created (PolicyValue cascades; AuditLog has no FK, so it goes by tenantId).
 */
import { randomUUID } from "crypto";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PolicyService, POLICY_SET_ACTION } from "../policy/policy.service";
import { PolicyOversellReader } from "../orders/policy-oversell-reader";
import { resolveOversellAllowed } from "../orders/oversell-policy";
import { SettingsInventoryController } from "./settings-inventory.controller";
import { SettingsInventoryService } from "./settings-inventory.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;

describeDb("settings/inventory — real Postgres (WS9)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let policies: PolicyService;
  let controller: SettingsInventoryController;
  let reader: PolicyOversellReader;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    policies = new PolicyService(prisma);
    controller = new SettingsInventoryController(new SettingsInventoryService(policies, prisma));
    reader = new PolicyOversellReader(policies);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanup(tenantId).catch((e) => {
        console.warn(`settings-inventory.db.spec: cleanup of tenant ${tenantId} failed: ${e}`);
      });
    }
    await _resetLockPoolForTests();
    await prisma?.$disconnect();
  });

  async function cleanup(tenantId: string): Promise<void> {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.policyValue.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  async function seed() {
    seq += 1;
    const slug = assertTestTenant(`qa-invsettings-${RUN}-${seq}`, "settings-inventory.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `Inv ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `Acme ${seq}`, contactName: "c", tenantId: tenant.id },
    });
    const admin = {
      sub: null,
      username: "qa-admin",
      role: "TENANT_ADMIN",
      tenantId: tenant.id,
    } as unknown as JwtPayload;
    return { tenantId: tenant.id, customerId: customer.id, admin };
  }

  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const buyerAllowed = (t: { tenantId: string; customerId: string }) =>
    resolveOversellAllowed(reader, {
      tenantId: t.tenantId,
      role: "CUSTOMER",
      source: "buyer",
      customerId: t.customerId,
    });

  it("A patches to backorder, B stays off (GET and the buyer resolver)", async () => {
    const a = await seed();
    const b = await seed();
    expect(await inTenant(a.tenantId, () => controller.get(a.admin))).toEqual({
      buyerOversell: "off",
      buyerBackorderVisibility: "show",
      customerOverrides: 0,
    });

    await inTenant(a.tenantId, () => controller.update({ buyerOversell: "backorder" }, a.admin));
    // A fresh service/cache per read: the writer invalidates, but prove the DB, not a cache.
    policies = new PolicyService(prisma);
    reader = new PolicyOversellReader(policies);
    controller = new SettingsInventoryController(new SettingsInventoryService(policies, prisma));

    expect(await inTenant(a.tenantId, () => controller.get(a.admin))).toEqual({
      buyerOversell: "backorder",
      buyerBackorderVisibility: "show",
      customerOverrides: 0,
    });
    expect(await inTenant(b.tenantId, () => controller.get(b.admin))).toEqual({
      buyerOversell: "off",
      buyerBackorderVisibility: "show",
      customerOverrides: 0,
    });
    expect(await buyerAllowed(a)).toBe(true);
    expect(await buyerAllowed(b)).toBe(false);
  });

  it("OOS PR2: the visibility setting is per tenant, defaults to show, and is read back from the DB", async () => {
    const a = await seed();
    const b = await seed();
    expect(await inTenant(a.tenantId, () => controller.get(a.admin))).toMatchObject({
      buyerBackorderVisibility: "show",
    });

    await inTenant(a.tenantId, () =>
      controller.update({ buyerBackorderVisibility: "hide" }, a.admin),
    );
    // A fresh service/cache per read: prove the DB, not a cache.
    policies = new PolicyService(prisma);
    reader = new PolicyOversellReader(policies);
    controller = new SettingsInventoryController(new SettingsInventoryService(policies, prisma));

    expect(await inTenant(a.tenantId, () => controller.get(a.admin))).toMatchObject({
      buyerOversell: "off", // writing the visibility never touches the out-of-stock switch
      buyerBackorderVisibility: "hide",
    });
    expect(await inTenant(b.tenantId, () => controller.get(b.admin))).toMatchObject({
      buyerBackorderVisibility: "show",
    });
    const rows = await prisma.auditLog.findMany({
      where: { tenantId: a.tenantId, action: POLICY_SET_ACTION },
    });
    expect(rows).toHaveLength(1); // exactly the one audited write
  });

  it("a PATCH writes one policy.set AuditLog row for the tenant", async () => {
    const t = await seed();
    await inTenant(t.tenantId, () => controller.update({ buyerOversell: "backorder" }, t.admin));
    const rows = await prisma.auditLog.findMany({
      where: { tenantId: t.tenantId, action: POLICY_SET_ACTION },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("policy.set");
  });

  it("the SAME PolicyService instance: a cached GET and the buyer resolver both see a PATCH at once", async () => {
    // Prime the 30 s cache through GET and the buyer resolver, then PATCH on the very same instance:
    // both reads must flip immediately. Without PolicyService.set()'s invalidate they stay "off".
    const t = await seed();
    expect(await inTenant(t.tenantId, () => controller.get(t.admin))).toMatchObject({
      buyerOversell: "off",
    });
    expect(await buyerAllowed(t)).toBe(false);

    await inTenant(t.tenantId, () => controller.update({ buyerOversell: "backorder" }, t.admin));

    expect(await inTenant(t.tenantId, () => controller.get(t.admin))).toMatchObject({
      buyerOversell: "backorder",
    });
    expect(await buyerAllowed(t)).toBe(true);
  });

  it("customerOverrides counts a customer pin", async () => {
    const t = await seed();
    await inTenant(t.tenantId, () =>
      policies.set({
        tenantId: t.tenantId,
        key: "orders.buyerOversell",
        scopeType: "CUSTOMER",
        scopeId: t.customerId,
        value: "backorder",
        reason: "qa pin",
        actor: { id: null, name: "qa-admin", impersonatedBy: null },
      }),
    );
    expect(await inTenant(t.tenantId, () => controller.get(t.admin))).toEqual({
      buyerOversell: "off",
      buyerBackorderVisibility: "show",
      customerOverrides: 1,
    });
  });

  it("the superseded row is kept: two patches leave two rows, one active", async () => {
    const t = await seed();
    await inTenant(t.tenantId, () => controller.update({ buyerOversell: "backorder" }, t.admin));
    await inTenant(t.tenantId, () =>
      controller.update({ buyerOversell: "off", reason: "back to off" }, t.admin),
    );
    const rows = await prisma.policyValue.findMany({
      where: { tenantId: t.tenantId, key: "orders.buyerOversell", scopeType: "TENANT" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].supersededAt).not.toBeNull();
    expect(rows[0].value).toBe("backorder");
    expect(rows[1].supersededAt).toBeNull();
    expect(rows[1].value).toBe("off");
    expect(rows[1].reason).toBe("back to off");
  });
});
