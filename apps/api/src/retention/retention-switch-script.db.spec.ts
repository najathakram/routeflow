/**
 * SA-1083 RT-33 to RT-35: the switch script runs as the operator runs it, against real Postgres, and the demo booking job
 * reads what it wrote.
 *
 * SAFETY: bookings carry `example.invalid` addresses, there are no tenants, and the calendar is mocked. `beforeEach` and
 * `afterAll` delete the job's run rows, the script's audit rows and the switch key. The job reads every booking in the
 * database, so this runs only on a local one (`describeDb`).
 */
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { join } from "path";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { DemoBookingRetentionService } from "./demo-booking-retention.service";
import { RETENTION_DEMO_BOOKING_SWITCH, RetentionSwitchService } from "./retention-switch.service";

const SCRIPT = join(__dirname, "../../scripts/set-retention-switch.mjs");
const JOB = ["--job", "demo-bookings"];
const RUN_ACTION = AUDIT_ACTIONS.RETENTION_DEMO_BOOKINGS_RUN;
const SWITCH_ACTION = AUDIT_ACTIONS.RETENTION_SWITCH_CHANGED;
const LOCATION_KEY = "retention.driverLocationsEnforced";

describeDb("SA-1083: the retention switch script, real Postgres", () => {
  let prisma: PrismaService;
  let switches: RetentionSwitchService;
  let job: DemoBookingRetentionService;
  const run = randomUUID().slice(0, 8);
  const bookingIds: string[] = [];
  let seq = 0;

  const script = (...args: string[]) =>
    spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: requireLocalDatabaseUrl() },
    });
  const switchOn = (...more: string[]) => script(...JOB, "--on", "--reason", "week read", ...more);
  const switchOff = (...more: string[]) => script(...JOB, "--off", "--reason", "stop it", ...more);

  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  const runRow = (days: number, mode: "report" | "enforce" = "report") =>
    prisma.auditLog.create({
      data: {
        action: RUN_ACTION,
        entityType: "RetentionRun",
        meta: { mode },
        createdAt: daysAgo(days),
      },
    });
  const switchValue = async (key: string = RETENTION_DEMO_BOOKING_SWITCH) => {
    const rows = await prisma.$queryRaw<{ value: string }[]>`
      SELECT value FROM "PlatformConfig" WHERE key = ${key}
    `;
    return rows[0]?.value ?? null;
  };
  const switchAudits = () =>
    prisma.auditLog.findMany({ where: { action: SWITCH_ACTION }, orderBy: { createdAt: "asc" } });

  async function dueBooking() {
    seq += 1;
    // A confirmed slot is unique (DemoBooking_startsAt_confirmed_key), so each row takes its own hour.
    const slot = new Date(daysAgo(400).getTime() + seq * 3_600_000);
    const row = await prisma.demoBooking.create({
      data: {
        name: "Sam Rivera",
        email: `switch-${run}-${seq}@example.invalid`,
        company: "Acme",
        startsAt: slot,
        endsAt: new Date(slot.getTime() + 1_800_000),
        timeZone: "America/Chicago",
        manageTokenHash: `switch-${run}-${seq}`,
      },
    });
    bookingIds.push(row.id);
    return row.id;
  }
  const bookingExists = async (id: string) =>
    (await prisma.demoBooking.count({ where: { id } })) === 1;

  /** The audit insert fails for this action only, so the script's transaction has to take the switch back with it. */
  async function withFailingAudit<T>(fn: () => Promise<T>): Promise<T> {
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION rt34_refuse_audit() RETURNS trigger AS $f$
      BEGIN RAISE EXCEPTION 'audit write refused for RT-34'; END
      $f$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER rt34_refuse_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW
      WHEN (NEW.action = '${SWITCH_ACTION}') EXECUTE FUNCTION rt34_refuse_audit()`);
    try {
      return await fn();
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER rt34_refuse_audit ON "AuditLog"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION rt34_refuse_audit()`);
    }
  }

  async function clean() {
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = ${RETENTION_DEMO_BOOKING_SWITCH} OR key = ${LOCATION_KEY}`;
    await prisma.auditLog.deleteMany({ where: { action: { in: [RUN_ACTION, SWITCH_ACTION] } } });
  }

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    switches = new RetentionSwitchService(prisma);
    job = new DemoBookingRetentionService(prisma, switches, {
      deleteEvent: jest.fn().mockResolvedValue(undefined),
    } as any);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  }, 60_000);

  beforeEach(clean, 60_000);

  afterAll(async () => {
    try {
      await clean();
      await prisma.demoBooking.deleteMany({ where: { id: { in: bookingIds } } });
    } finally {
      await prisma?.$disconnect();
    }
  }, 60_000);

  describe("RT-33: on, then off", () => {
    it("a dry run prints the target, redacted, and before and after, and writes nothing", async () => {
      await runRow(8);
      const out = switchOn();

      expect(out.status).toBe(0);
      expect(out.stdout).toContain("Resolved database host");
      const password = new URL(requireLocalDatabaseUrl()).password;
      if (password) expect(out.stdout).not.toContain(`:${password}@`);
      const printed = JSON.parse(out.stdout.trim().split("\n").pop() as string);
      expect(printed).toMatchObject({
        dryRun: true,
        before: null,
        after: { enforced: true, reason: "week read" },
      });
      expect(await switchValue()).toBeNull();
      expect(await switchAudits()).toEqual([]);
    });

    it("--apply: the job enforces, then reports, with one audit row each", async () => {
      await runRow(8);

      const on = switchOn("--apply");
      expect(on.status).toBe(0);
      expect(await switches.modeOf(RETENTION_DEMO_BOOKING_SWITCH)).toBe("enforce");
      const removed = await dueBooking();
      expect((await job.run()).mode).toBe("enforce");
      expect(await bookingExists(removed)).toBe(false);

      const stored = JSON.parse((await switchValue()) as string);
      expect(stored).toEqual({
        enforced: true,
        reason: "week read",
        by: expect.any(String),
        at: expect.any(String),
      });

      const off = switchOff("--apply");
      expect(off.status).toBe(0);
      expect(await switches.modeOf(RETENTION_DEMO_BOOKING_SWITCH)).toBe("report");
      const kept = await dueBooking();
      expect((await job.run()).mode).toBe("report");
      expect(await bookingExists(kept)).toBe(true);

      const audits = await switchAudits();
      expect(audits).toHaveLength(2);
      expect(audits[0]).toMatchObject({
        tenantId: null,
        entityType: "RetentionSwitch",
        entityId: RETENTION_DEMO_BOOKING_SWITCH,
        meta: {
          job: "demo-bookings",
          before: null,
          after: { enforced: true, reason: "week read" },
        },
      });
      expect(audits[1]).toMatchObject({
        meta: {
          before: { enforced: true, reason: "week read" },
          after: { enforced: false, reason: "stop it" },
        },
      });
    });

    it("--off has no conditions: it works with no run rows at all", async () => {
      const off = switchOff("--apply");
      expect(off.status).toBe(0);
      expect(await switches.modeOf(RETENTION_DEMO_BOOKING_SWITCH)).toBe("report");
      expect(await switchAudits()).toHaveLength(1);
    });
  });

  describe("RT-34: refused, and the switch doesn't move", () => {
    async function expectRefused(pattern: RegExp) {
      for (const out of [switchOn(), switchOn("--apply")]) {
        expect(out.status).toBe(3);
        expect(out.stderr).toMatch(pattern);
      }
      expect(await switchValue()).toBeNull();
      expect(await switchAudits()).toEqual([]);
    }

    it("--on with 6 days of report rows", async () => {
      for (const d of [6, 5, 4, 3, 2, 1]) await runRow(d);
      await expectRefused(/has not run in report mode for 7 days/);
    });

    it("--on with no run rows at all", async () => {
      await expectRefused(/has not run in report mode for 7 days/);
    });

    it("--on when the rows that go back 8 days enforced", async () => {
      await runRow(8, "enforce");
      await expectRefused(/has not run in report mode for 7 days/);
    });

    it("--on when an enforce run cut the report rows to 6 days", async () => {
      await runRow(20);
      await runRow(7, "enforce");
      await runRow(6);
      await expectRefused(/has not run in report mode for 7 days/);
    });

    it("--on is accepted again after 7 report days since the last enforce run", async () => {
      await runRow(20, "enforce");
      await runRow(8);
      await runRow(1);
      expect(switchOn("--apply").status).toBe(0);
      expect(await switches.modeOf(RETENTION_DEMO_BOOKING_SWITCH)).toBe("enforce");
    });

    it("--on with a failed audit write: the switch stays as it was", async () => {
      await runRow(8);
      const before = await withFailingAudit(async () => {
        const out = switchOn("--apply");
        expect(out.status).toBe(3);
        expect(out.stderr).toMatch(/the switch did not move/);
        return switchValue();
      });
      expect(before).toBeNull();
      expect(await switches.modeOf(RETENTION_DEMO_BOOKING_SWITCH)).toBe("report");
      expect(await switchAudits()).toEqual([]);
    });

    it("--off with a failed audit write: the switch stays on", async () => {
      await runRow(8);
      expect(switchOn("--apply").status).toBe(0);
      const on = await switchValue();

      await withFailingAudit(async () => {
        const out = switchOff("--apply");
        expect(out.status).toBe(3);
        expect(await switchValue()).toBe(on);
      });
      expect(await switches.modeOf(RETENTION_DEMO_BOOKING_SWITCH)).toBe("enforce");
      expect(await switchAudits()).toHaveLength(1);
    });
  });

  describe("RT-35: only the jobs in its map", () => {
    it.each([["--on"], ["--off"]])(
      "--job driver-locations %s is refused as unknown",
      async (dir) => {
        await runRow(8);
        const out = script("--job", "driver-locations", dir, "--reason", "any", "--apply");
        expect(out.status).toBe(3);
        expect(out.stderr).toMatch(/unknown job driver-locations/);
        expect(await switchValue(LOCATION_KEY)).toBeNull();
        expect(await switchAudits()).toEqual([]);
      },
    );

    it("a name from Object's prototype is unknown too", () => {
      const out = script("--job", "constructor", "--off", "--reason", "any", "--apply");
      expect(out.status).toBe(3);
      expect(out.stderr).toMatch(/unknown job constructor/);
    });
  });

  describe("a command it can't read", () => {
    it.each([
      ["no job", ["--off", "--reason", "any", "--apply"]],
      ["no direction", [...JOB, "--reason", "any", "--apply"]],
      ["both directions", [...JOB, "--on", "--off", "--reason", "any", "--apply"]],
      ["no reason", [...JOB, "--off", "--apply"]],
      ["a blank reason", [...JOB, "--off", "--reason", "   ", "--apply"]],
      ["a flag where the reason goes", [...JOB, "--off", "--reason", "--apply"]],
    ])("%s prints usage and writes nothing", async (_name, args) => {
      const out = script(...args);
      expect(out.status).toBe(2);
      expect(out.stderr).toMatch(/usage:/);
      expect(await switchValue()).toBeNull();
      expect(await switchAudits()).toEqual([]);
    });
  });
});
