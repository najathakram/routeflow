/**
 * SA-1083 RT-1, RT-2: the database stamps `Tenant.closedAt` when a tenant enters a closed state, whichever writer moved
 * it. Real Postgres, because the rule lives in a trigger. Closed means CANCELLED, or READ_ONLY with
 * `subscription_cancelled`.
 *
 * SAFETY: throwaway `qa-closedclock-<run>-*` tenants approved by `assertTestTenant`; `afterAll` deletes exactly those.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { isClosedTenantState } from "./closed-tenant-proof";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const CANCEL = { status: "CANCELLED" as const, readOnlyReason: null };
const WINDOW = { status: "READ_ONLY" as const, readOnlyReason: "subscription_cancelled" };
const OPEN = { status: "ACTIVE" as const, readOnlyReason: null };

describeDb("SA-1083: the closed clock on Tenant, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const ids: string[] = [];
  let seq = 0;

  const newTenant = async (data: Record<string, unknown> = {}) => {
    seq += 1;
    const slug = assertTestTenant(`qa-closedclock-${run}-${seq}`, "tenant-closed-clock.db.spec.ts");
    const { id } = await raw.tenant.create({ data: { slug, name: `Acme ${slug}`, ...data } });
    ids.push(id);
    return id;
  };
  const read = (id: string) => raw.tenant.findUniqueOrThrow({ where: { id } });
  const closedAt = async (id: string) => (await read(id)).closedAt;
  /** A row as the migration found it: closed, and no date. Bypasses the trigger on this one session only. */
  const clearClockAsIfOlderThanTheTrigger = async (id: string) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(`UPDATE "Tenant" SET "closedAt" = NULL WHERE id = $1`, [id]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 60_000);

  afterAll(async () => {
    try {
      await raw.tenant.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 60_000);

  it("RT-1: updateMany and raw SQL both stamp; reopening clears date and approval; closing again is a new date", async () => {
    const byPrisma = await newTenant();
    await raw.tenant.updateMany({ where: { id: byPrisma }, data: CANCEL });
    const first = await closedAt(byPrisma);
    expect(first).toBeInstanceOf(Date);

    const bySql = await newTenant();
    await pool.query(`UPDATE "Tenant" SET status = 'CANCELLED' WHERE id = $1`, [bySql]);
    expect(await closedAt(bySql)).toBeInstanceOf(Date);

    await raw.tenant.update({
      where: { id: byPrisma },
      data: { purgeApprovedAt: new Date(), purgeApprovedCounts: { order: 1 } },
    });
    await tick();
    await raw.tenant.update({ where: { id: byPrisma }, data: OPEN });
    const reopened = await read(byPrisma);
    expect(reopened.closedAt).toBeNull();
    expect(reopened.purgeApprovedAt).toBeNull();
    expect(reopened.purgeApprovedCounts).toBeNull();

    await tick();
    await raw.tenant.update({ where: { id: byPrisma }, data: CANCEL });
    const second = await closedAt(byPrisma);
    expect(second!.getTime()).toBeGreaterThan(first!.getTime());
  });

  it("RT-2: moving between the two closed states keeps the date, both ways", async () => {
    const id = await newTenant({ ...WINDOW });
    const stamped = await closedAt(id);
    expect(stamped).toBeInstanceOf(Date);

    await tick();
    await raw.tenant.update({ where: { id }, data: CANCEL });
    expect(await closedAt(id)).toEqual(stamped);

    await tick();
    await raw.tenant.update({ where: { id }, data: WINDOW });
    expect(await closedAt(id)).toEqual(stamped);
  });

  it("the trigger and isClosedTenantState agree on every state", async () => {
    const cases = [
      { status: "TRIAL", readOnlyReason: null },
      { status: "ACTIVE", readOnlyReason: null },
      { status: "SUSPENDED", readOnlyReason: null },
      { status: "SUSPENDED", readOnlyReason: "subscription_cancelled" },
      { status: "READ_ONLY", readOnlyReason: null },
      { status: "READ_ONLY", readOnlyReason: "trial_expired" },
      { status: "READ_ONLY", readOnlyReason: "subscription_cancelled" },
      { status: "CANCELLED", readOnlyReason: null },
      { status: "CANCELLED", readOnlyReason: "stripe_cancelled" },
    ] as const;
    for (const state of cases) {
      const id = await newTenant();
      await raw.tenant.update({ where: { id }, data: state });
      const stamped = (await closedAt(id)) !== null;
      expect({ ...state, stamped }).toEqual({ ...state, stamped: isClosedTenantState(state) });
    }
    expect(cases.filter((c) => isClosedTenantState(c))).toHaveLength(3);
  });

  it("leaving closed into READ_ONLY with no reason clears the date: a NULL reason reads as not closed", async () => {
    const id = await newTenant({ status: "CANCELLED" });
    await raw.tenant.update({
      where: { id },
      data: { status: "READ_ONLY", readOnlyReason: null, purgeApprovedAt: new Date() },
    });
    const after = await read(id);
    expect(after.closedAt).toBeNull();
    expect(after.purgeApprovedAt).toBeNull();
  });

  it("entering closed from READ_ONLY with no reason stamps: a NULL reason on the old row reads as not closed too", async () => {
    const id = await newTenant({ status: "READ_ONLY", readOnlyReason: null });
    await raw.tenant.update({ where: { id }, data: CANCEL });
    expect(await closedAt(id)).toBeInstanceOf(Date);
  });

  it("a tenant created closed is stamped; one created open can't carry a date", async () => {
    expect(await closedAt(await newTenant({ status: "CANCELLED" }))).toBeInstanceOf(Date);
    expect(await closedAt(await newTenant({ closedAt: new Date("2020-01-01") }))).toBeNull();
  });

  it("a date already set can't be rewritten, and an open tenant can't be given one", async () => {
    const closed = await newTenant({ status: "CANCELLED" });
    const stamped = await closedAt(closed);
    await raw.tenant.update({ where: { id: closed }, data: { closedAt: new Date("2020-01-01") } });
    expect(await closedAt(closed)).toEqual(stamped);
    await raw.tenant.update({ where: { id: closed }, data: { closedAt: null } });
    expect(await closedAt(closed)).toEqual(stamped);

    const open = await newTenant();
    await raw.tenant.update({ where: { id: open }, data: { closedAt: new Date("2020-01-01") } });
    expect(await closedAt(open)).toBeNull();
  });

  it("an unrelated write keeps the date, and leaves a closed tenant with no date at no date", async () => {
    const id = await newTenant({ status: "CANCELLED" });
    const stamped = await closedAt(id);
    await tick();
    await raw.tenant.update({ where: { id }, data: { name: "Acme renamed" } });
    expect(await closedAt(id)).toEqual(stamped);

    await clearClockAsIfOlderThanTheTrigger(id);
    await raw.tenant.update({ where: { id }, data: { name: "Acme renamed again" } });
    expect(await closedAt(id)).toBeNull();
  });

  it("a closed tenant with no date takes one given to it, once", async () => {
    const id = await newTenant({ status: "CANCELLED" });
    await clearClockAsIfOlderThanTheTrigger(id);
    const given = new Date("2026-11-02T00:00:00.000Z");
    await raw.tenant.update({ where: { id }, data: { closedAt: given } });
    expect(await closedAt(id)).toEqual(given);
    await raw.tenant.update({ where: { id }, data: { closedAt: new Date("2020-01-01") } });
    expect(await closedAt(id)).toEqual(given);
  });

  it("RT-8's second half: leaving closed is refused once a purge has started, and the row is unchanged", async () => {
    const id = await newTenant({ status: "CANCELLED" });
    const stamped = await closedAt(id);
    await raw.tenant.update({ where: { id }, data: { purgeStartedAt: new Date() } });

    await expect(raw.tenant.update({ where: { id }, data: OPEN })).rejects.toThrow(
      /TENANT_PURGE_STARTED/,
    );
    await expect(
      pool.query(`UPDATE "Tenant" SET status = 'ACTIVE' WHERE id = $1`, [id]),
    ).rejects.toThrow(/TENANT_PURGE_STARTED/);
    const after = await read(id);
    expect(after.status).toBe("CANCELLED");
    expect(after.closedAt).toEqual(stamped);

    await raw.tenant.update({ where: { id }, data: WINDOW });
    expect(await closedAt(id)).toEqual(stamped);
  });

  it("the clock reads UTC whatever the session's time zone", async () => {
    const id = await newTenant();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL TIME ZONE 'Asia/Tokyo'");
      await client.query(`UPDATE "Tenant" SET status = 'CANCELLED' WHERE id = $1`, [id]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const stamped = await closedAt(id);
    expect(Math.abs(Date.now() - stamped!.getTime())).toBeLessThan(5 * 60_000);
  });
});
