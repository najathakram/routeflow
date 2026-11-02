/**
 * SA-1083 RT-20 and RT-11: the demo booking job on real rows, with the calendar mocked at its service.
 *
 * SAFETY: bookings carry `example.invalid` addresses, and the one tenant is a throwaway `qa-demoret-<run>` approved by
 * `assertTestTenant`. `afterAll` deletes every row it made and the switch key. The job reads every booking in the
 * database, so this runs only on a local one (`describeDb`).
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { DemoBookingRetentionService } from "./demo-booking-retention.service";
import { RETENTION_DEMO_BOOKING_SWITCH, RetentionSwitchService } from "./retention-switch.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const NOW = new Date("2026-11-02T12:00:00.000Z");
/** 13 months before NOW, and 11. */
const OLD = new Date("2025-10-02T12:00:00.000Z");
const YOUNG = new Date("2025-12-02T12:00:00.000Z");

describeDb("SA-1083: demo booking job, real Postgres", () => {
  let prisma: PrismaService;
  let job: DemoBookingRetentionService;
  const deleteEvent = jest.fn();
  const run = randomUUID().slice(0, 8);
  const bookingIds: string[] = [];
  const caseIds: string[] = [];
  let tenantId: string;
  let seq = 0;

  async function booking(startsAt: Date, googleEventId: string | null = null) {
    seq += 1;
    // A confirmed slot is unique (DemoBooking_startsAt_confirmed_key), so each row takes its own hour.
    const slot = new Date(startsAt.getTime() + seq * 3_600_000);
    const row = await prisma.demoBooking.create({
      data: {
        name: "Sam Rivera",
        email: `demo-${run}-${seq}@example.invalid`,
        company: "Acme",
        startsAt: slot,
        endsAt: new Date(slot.getTime() + 1_800_000),
        timeZone: "America/Chicago",
        googleEventId,
        manageTokenHash: `hash-${run}-${seq}`,
      },
    });
    bookingIds.push(row.id);
    return row.id;
  }

  async function caseFor(demoBookingId: string, tenant: string | null) {
    const row = await prisma.onboardingCase.create({
      data: {
        demoBookingId,
        tenantId: tenant,
        companyName: "Acme",
        contactName: "Sam Rivera",
        contactEmail: `case-${run}@example.invalid`,
        catalogVersion: 1,
        createdById: "qa",
      },
    });
    caseIds.push(row.id);
    return row.id;
  }

  const exists = async (id: string) => (await prisma.demoBooking.count({ where: { id } })) === 1;

  async function setSwitch(value: string | null) {
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = ${RETENTION_DEMO_BOOKING_SWITCH}`;
    if (value == null) return;
    await prisma.$executeRaw`
      INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
      VALUES (gen_random_uuid()::text, ${RETENTION_DEMO_BOOKING_SWITCH}, ${value}, now())
    `;
  }
  const enforce = () => setSwitch(JSON.stringify({ enforced: true }));

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    job = new DemoBookingRetentionService(prisma, new RetentionSwitchService(prisma), {
      deleteEvent,
    } as any);
    const slug = assertTestTenant(`qa-demoret-${run}`, "demo-booking-retention.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `Acme ${slug}` } })).id;
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  }, 60_000);

  beforeEach(() => {
    deleteEvent.mockReset();
    deleteEvent.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    try {
      await setSwitch(null);
      await prisma.onboardingCase.deleteMany({ where: { id: { in: caseIds } } });
      await prisma.demoBooking.deleteMany({ where: { id: { in: bookingIds } } });
      await prisma.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      await prisma?.$disconnect();
    }
  }, 60_000);

  it("RT-20: at 13 months with no case, the event goes first and then the row", async () => {
    const id = await booking(OLD, `ev-${run}-1`);
    const order: string[] = [];
    deleteEvent.mockImplementation(async () => {
      order.push((await exists(id)) ? "event, row still there" : "row gone first");
    });
    await enforce();

    const out = await job.run(NOW);

    expect(out.mode).toBe("enforce");
    expect(deleteEvent).toHaveBeenCalledWith(`ev-${run}-1`);
    expect(order).toEqual(["event, row still there"]);
    expect(await exists(id)).toBe(false);
  });

  it("at 13 months with no event, the row goes and the calendar isn't called", async () => {
    const id = await booking(OLD);
    await enforce();

    await job.run(NOW);

    expect(deleteEvent).not.toHaveBeenCalled();
    expect(await exists(id)).toBe(false);
  });

  it("at 11 months the row and its event stay", async () => {
    const id = await booking(YOUNG, `ev-${run}-2`);
    await enforce();

    await job.run(NOW);

    expect(deleteEvent).not.toHaveBeenCalled();
    expect(await exists(id)).toBe(true);
  });

  it("RT-20: a booking whose case has a tenant is kept and counted, with its event", async () => {
    const id = await booking(OLD, `ev-${run}-3`);
    await caseFor(id, tenantId);
    await enforce();

    const out = await job.run(NOW);

    expect(await exists(id)).toBe(true);
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(out.keptWithTenant).toBeGreaterThanOrEqual(1);
  });

  it("a booking whose case has no tenant goes, and the case stays with its link cleared", async () => {
    const id = await booking(OLD);
    const caseId = await caseFor(id, null);
    await enforce();

    await job.run(NOW);

    expect(await exists(id)).toBe(false);
    const row = await prisma.onboardingCase.findUnique({ where: { id: caseId } });
    expect(row).not.toBeNull();
    expect(row?.demoBookingId).toBeNull();
  });

  it("RT-20: when the calendar delete fails the row stays and is counted, and the next run clears it", async () => {
    const id = await booking(OLD, `ev-${run}-4`);
    deleteEvent.mockRejectedValueOnce(new Error("calendar down"));
    await enforce();

    const first = await job.run(NOW);

    expect(await exists(id)).toBe(true);
    expect(first.calendarFailed).toBe(1);

    const second = await job.run(NOW);

    expect(await exists(id)).toBe(false);
    expect(second.calendarFailed).toBe(0);
  });

  it("report-only: nothing goes, the calendar isn't called, and the audit row holds the counts", async () => {
    const withEvent = await booking(OLD, `ev-${run}-5`);
    const without = await booking(OLD);
    await setSwitch(JSON.stringify({ enforced: false }));

    const out = await job.run(NOW);

    expect(out.mode).toBe("report");
    expect(await exists(withEvent)).toBe(true);
    expect(await exists(without)).toBe(true);
    expect(deleteEvent).not.toHaveBeenCalled();
    expect(out.deleted).toBe(0);
    expect(out.due).toBeGreaterThanOrEqual(2);
    expect(out.dueWithEvent).toBeGreaterThanOrEqual(1);
    const row = await prisma.auditLog.findFirst({
      where: { action: AUDIT_ACTIONS.RETENTION_DEMO_BOOKINGS_RUN },
      orderBy: { createdAt: "desc" },
    });
    const meta = row?.meta as any;
    expect(row?.tenantId).toBeNull();
    expect(meta.mode).toBe("report");
    expect(meta.due).toBe(out.due);
    expect(meta.cutoff).toBe("2025-11-02T12:00:00.000Z");
    expect(JSON.stringify(meta)).not.toContain("example.invalid");
    await prisma.auditLog.deleteMany({
      where: { action: AUDIT_ACTIONS.RETENTION_DEMO_BOOKINGS_RUN, createdAt: { gte: NOW } },
    });
  });

  it("RT-11: a missing switch reports and deletes nothing", async () => {
    const id = await booking(OLD, `ev-${run}-6`);
    await setSwitch(null);

    const out = await job.run(NOW);

    expect(out.mode).toBe("report");
    expect(await exists(id)).toBe(true);
    expect(deleteEvent).not.toHaveBeenCalled();
  });
});
