/**
 * SA-1083: the census counts what it says and prints no names, and the stamp gives a date only to a closed tenant with
 * none. Both scripts run as the operator runs them, against real Postgres.
 *
 * SAFETY: throwaway `qa-rtscript-<run>-*` tenants approved by `assertTestTenant`; `afterAll` deletes exactly those rows.
 */
import { execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const CENSUS = join(__dirname, "../../scripts/census-retention-sa1083.mjs");
const STAMP = join(__dirname, "../../scripts/stamp-closed-tenant-sa1083.mjs");

describeDb("SA-1083: the census and the stamp, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const ids: string[] = [];
  let seq = 0;
  const env = () => ({ ...process.env, DATABASE_URL: requireLocalDatabaseUrl() });

  const census = (...args: string[]) =>
    JSON.parse(execFileSync(process.execPath, [CENSUS, ...args], { encoding: "utf8", env: env() }));
  const stamp = (...args: string[]) =>
    spawnSync(process.execPath, [STAMP, ...args], { encoding: "utf8", env: env() });

  async function newTenant(data: Record<string, unknown> = {}) {
    seq += 1;
    const slug = assertTestTenant(`qa-rtscript-${run}-${seq}`, "retention-scripts.db.spec.ts");
    const { id } = await raw.tenant.create({ data: { slug, name: `Acme ${slug}`, ...data } });
    ids.push(id);
    return { id, slug };
  }
  /** Closed, with no date: a tenant as it was when the trigger arrived. Bypasses the trigger on this one session only. */
  async function closedWithNoDate() {
    const t = await newTenant({ status: "CANCELLED" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`UPDATE "Tenant" SET "closedAt" = NULL WHERE id = $1`, [t.id]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    return t;
  }
  const row = (id: string) => raw.tenant.findUniqueOrThrow({ where: { id } });
  const audits = (tenantId: string) =>
    raw.auditLog.count({ where: { tenantId, action: "tenant.closed-date-stamped" } });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 60_000);

  afterAll(async () => {
    try {
      await raw.driverLocation.deleteMany({ where: { tenantId: { in: ids } } });
      await raw.driver.deleteMany({ where: { tenantId: { in: ids } } });
      await raw.user.deleteMany({ where: { tenantId: { in: ids } } });
      await raw.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
      await raw.tenantSubscription.deleteMany({ where: { tenantId: { in: ids } } });
      await raw.billingNotificationLog.deleteMany({ where: { tenantId: { in: ids } } });
      await raw.tenant.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 60_000);

  describe("census", () => {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

    it("counts a tenant's states, skips and locations; the older of the two dates sets a point's age", async () => {
      const { id: tenantId, slug } = await closedWithNoDate();
      const { id: userId } = await raw.user.create({
        data: { email: `d-${slug}@example.test`, username: `d-${slug}`, role: "DRIVER", tenantId },
      });
      const { id: driverId } = await raw.driver.create({ data: { userId, tenantId } as never });
      const point = (recordedAt: Date, createdAt: Date) =>
        raw.driverLocation.create({
          data: { tenantId, driverId, lat: 1, lng: 1, recordedAt, createdAt },
        });
      await point(daysAgo(91), daysAgo(91));
      await point(daysAgo(89), daysAgo(89));
      await point(daysAgo(-1), daysAgo(120)); // a phone's future recordedAt doesn't make an old point young
      await raw.billingNotificationLog.create({
        data: { tenantId, milestone: "AUTO_LOCK_PAUSED:stripe_cancelled", key: "sub_1" },
      });

      const out = census("--tenant", slug, "--closed-list");

      expect(out.scope).toBe(slug);
      expect(out.tenantStates).toEqual([
        {
          status: "CANCELLED",
          readOnlyReason: null,
          class: "PRODUCTION",
          deleted: false,
          tenants: 1,
        },
      ]);
      expect(out.tenantTotals.closedWithNoDate).toBe(1);
      expect(out.autoLockSkips).toEqual({
        tenantsWithStripeCancelledSkip: 1,
        stripeCancelledSkipRows: 1,
      });
      expect(out.driverLocations.rows).toBe(3);
      expect(out.driverLocations.olderThan90Days).toBe(2);
      expect(out.closedWithNoDateIds.map((t: { id: string }) => t.id)).toEqual([tenantId]);
    });

    it("--all prints totals with every section, and no tenant's slug or name", async () => {
      const { slug } = await closedWithNoDate();
      const stdout = execFileSync(process.execPath, [CENSUS, "--all"], {
        encoding: "utf8",
        env: env(),
      });
      expect(stdout).not.toContain(slug);
      const out = JSON.parse(stdout);
      expect(out.driverLocationsNoTenant).toEqual(
        expect.objectContaining({ rows: expect.any(Number) }),
      );
      expect(out.demoBookings).toEqual(
        expect.objectContaining({ olderThan12Months: expect.any(Number) }),
      );
      expect(Object.keys(out.nullTenantRows)).toHaveLength(20);
      expect(out.closedWithNoDateIds).toBeUndefined();
    });

    it("refuses a slug that isn't a test tenant, and a run with no scope", () => {
      const live = spawnSync(process.execPath, [CENSUS, "--tenant", "acme"], {
        encoding: "utf8",
        env: env(),
      });
      expect(live.status).toBe(1);
      expect(live.stderr).toMatch(/Test-tenant policy violation/);
      expect(spawnSync(process.execPath, [CENSUS], { encoding: "utf8", env: env() }).status).toBe(
        2,
      );
    });

    it("only ever reads: the session is read-only before any query, and no SQL in the file writes", () => {
      const source = readFileSync(CENSUS, "utf8");
      expect(source.indexOf("SET default_transaction_read_only = on")).toBeLessThan(
        source.indexOf("await runCensus(client"),
      );
      expect(source).not.toMatch(/\b(INSERT INTO|UPDATE "|DELETE FROM|TRUNCATE|ALTER TABLE|DROP )/);
    });
  });

  describe("stamp", () => {
    it("a dry run writes nothing", async () => {
      const { id } = await closedWithNoDate();
      const out = stamp("--tenant", id);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain('"wouldStamp":true');
      expect((await row(id)).closedAt).toBeNull();
      expect(await audits(id)).toBe(0);
    });

    it("--apply dates a closed tenant with no date, from now, with one audit row, and changes nothing else", async () => {
      const { id } = await closedWithNoDate();
      const before = await row(id);
      const out = stamp("--tenant", id, "--apply");
      expect(out.status).toBe(0);
      const after = await row(id);
      expect(Math.abs(Date.now() - after.closedAt!.getTime())).toBeLessThan(5 * 60_000);
      expect(await audits(id)).toBe(1);
      expect({ ...after, closedAt: null, updatedAt: null }).toEqual({
        ...before,
        closedAt: null,
        updatedAt: null,
      });
    });

    it("refuses a second run: the first date stands", async () => {
      const { id } = await closedWithNoDate();
      stamp("--tenant", id, "--apply");
      const first = (await row(id)).closedAt;
      const again = stamp("--tenant", id, "--apply");
      expect(again.status).toBe(3);
      expect(again.stderr).toMatch(/already has a closing date/);
      expect((await row(id)).closedAt).toEqual(first);
      expect(await audits(id)).toBe(1);
    });

    it("refuses a tenant that isn't closed, or isn't there", async () => {
      const { id } = await newTenant({ status: "ACTIVE" });
      const open = stamp("--tenant", id, "--apply");
      expect(open.status).toBe(3);
      expect(open.stderr).toMatch(/is not closed/);
      expect((await row(id)).closedAt).toBeNull();
      expect(stamp("--tenant", randomUUID(), "--apply").status).toBe(3);
    });

    it("refuses a Stripe-linked tenant without the operator override, and writes nothing", async () => {
      const { id } = await closedWithNoDate();
      await raw.tenantSubscription.create({
        data: { tenantId: id, stripeSubId: `sub_${run}`, stripeCustomerId: "cus_acme" },
      });
      const out = stamp("--tenant", id, "--apply");
      expect(out.status).toBe(1);
      expect(out.stderr).toMatch(/is protected \(stripe-linked\): refused/);
      expect((await row(id)).closedAt).toBeNull();
    });
  });
});
