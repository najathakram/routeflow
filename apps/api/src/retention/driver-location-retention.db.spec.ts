/**
 * SA-1083 RT-4, RT-5, RT-11 and the hold: the driver location job on real rows, in both modes.
 *
 * SAFETY: throwaway `qa-locret-<run>-*` tenants approved by `assertTestTenant`; `afterAll` deletes every row it made and
 * both switch keys. The job walks every tenant in the database, so this runs only on a local one (`describeDb`).
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { DriverLocationRetentionService } from "./driver-location-retention.service";
import { RETENTION_LOCATION_SWITCH, RetentionSwitchService } from "./retention-switch.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const NOW = new Date("2026-11-02T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describeDb("SA-1083: driver location job, real Postgres", () => {
  let prisma: PrismaService;
  let job: DriverLocationRetentionService;
  const run = randomUUID().slice(0, 8);
  const tenantIds: string[] = [];
  const driverIds: string[] = [];
  const userIds: string[] = [];
  let seq = 0;

  async function tenantWithDriver() {
    seq += 1;
    const slug = assertTestTenant(
      `qa-locret-${run}-${seq}`,
      "driver-location-retention.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `Acme ${slug}` } });
    tenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "DRIVER",
        tenantId: tenant.id,
      },
    });
    userIds.push(user.id);
    const driver = await prisma.driver.create({
      data: { userId: user.id, contactName: "Sam Rivera", tenantId: tenant.id },
    });
    driverIds.push(driver.id);
    return { tenantId: tenant.id, driverId: driver.id };
  }

  async function point(
    owner: { tenantId: string | null; driverId: string },
    recordedAt: Date,
    createdAt: Date = recordedAt,
  ) {
    const row = await prisma.driverLocation.create({
      data: { ...owner, lat: 30.1, lng: -97.1, recordedAt, createdAt },
    });
    return row.id;
  }

  const exists = async (id: string) => (await prisma.driverLocation.count({ where: { id } })) === 1;

  async function setSwitch(value: string | null) {
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = ${RETENTION_LOCATION_SWITCH}`;
    if (value == null) return;
    await prisma.$executeRaw`
      INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
      VALUES (gen_random_uuid()::text, ${RETENTION_LOCATION_SWITCH}, ${value}, now())
    `;
  }
  const enforce = () => setSwitch(JSON.stringify({ enforced: true }));

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    job = new DriverLocationRetentionService(prisma, new RetentionSwitchService(prisma));
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  }, 60_000);

  afterAll(async () => {
    try {
      await setSwitch(null);
      await prisma.driverLocation.deleteMany({ where: { driverId: { in: driverIds } } });
      await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    } finally {
      await prisma?.$disconnect();
    }
  }, 60_000);

  it("RT-4 enforced: the point at 91 days goes and the point at 89 stays", async () => {
    const owner = await tenantWithDriver();
    const old = await point(owner, daysAgo(91));
    const young = await point(owner, daysAgo(89));
    await enforce();

    const out = await job.run(NOW);

    expect(out.mode).toBe("enforce");
    expect(await exists(old)).toBe(false);
    expect(await exists(young)).toBe(true);
    expect(out.perTenant[owner.tenantId]).toEqual({ due: 1, deleted: 1, held: false });
  });

  it("RT-4 report-only: both stay, and the run's audit row holds the count", async () => {
    const owner = await tenantWithDriver();
    const old = await point(owner, daysAgo(91));
    const young = await point(owner, daysAgo(89));
    await setSwitch(JSON.stringify({ enforced: false }));

    const out = await job.run(NOW);

    expect(out.mode).toBe("report");
    expect(await exists(old)).toBe(true);
    expect(await exists(young)).toBe(true);
    expect(out.perTenant[owner.tenantId]).toEqual({ due: 1, deleted: 0, held: false });
    const row = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.RETENTION_DRIVER_LOCATIONS_RUN },
      orderBy: { createdAt: "desc" },
    });
    const meta = row?.meta as any;
    expect(row?.tenantId).toBeNull();
    expect(meta.mode).toBe("report");
    expect(meta.cutoff).toBe(daysAgo(90).toISOString());
    expect(meta.perTenant[owner.tenantId]).toEqual({ due: 1, deleted: 0, held: false });
    await prisma.auditLog.deleteMany({ where: { id: row!.id } });
  });

  it("RT-5: the older of the two dates decides, so a phone's future date can't keep a point", async () => {
    const owner = await tenantWithDriver();
    const future = await point(owner, new Date(NOW.getTime() + 86_400_000), daysAgo(91));
    const backdated = await point(owner, daysAgo(91), daysAgo(1));
    const young = await point(owner, daysAgo(89), daysAgo(89));
    await enforce();

    await job.run(NOW);

    expect(await exists(future)).toBe(false);
    expect(await exists(backdated)).toBe(false);
    expect(await exists(young)).toBe(true);
  });

  it("RT-5: the table refuses a point with no tenant, and the job's count reads zero", async () => {
    const owner = await tenantWithDriver();
    await expect(point({ tenantId: null, driverId: owner.driverId }, daysAgo(200))).rejects.toThrow(
      /DriverLocation_tenantId_nn/,
    );

    const out = await job.run(NOW);

    expect(out.noTenantRows).toBe(0);
  });

  it("a held tenant's points stay and are counted, and its neighbour's go", async () => {
    const held = await tenantWithDriver();
    const neighbour = await tenantWithDriver();
    await prisma.tenant.update({
      where: { id: held.tenantId },
      data: { retentionHoldAt: NOW, retentionHoldReason: "qa" },
    });
    const kept = await point(held, daysAgo(91));
    const gone = await point(neighbour, daysAgo(91));
    await enforce();

    const out = await job.run(NOW);

    expect(await exists(kept)).toBe(true);
    expect(await exists(gone)).toBe(false);
    expect(out.perTenant[held.tenantId]).toEqual({ due: 1, deleted: 0, held: true });
    expect(out.heldRows).toBeGreaterThanOrEqual(1);
  });

  it("RT-11: a missing switch, or one that says nothing readable, reports and deletes nothing", async () => {
    const owner = await tenantWithDriver();
    const old = await point(owner, daysAgo(91));
    for (const value of [null, "true", "yes", "{not json", "[true]", '{"enforced":"true"}']) {
      await setSwitch(value);
      const out = await job.run(NOW);
      expect(out.mode).toBe("report");
      expect(await exists(old)).toBe(true);
    }
  });
});
