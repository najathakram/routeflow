/**
 * DB-lane spec for the live config-snapshot flag (A2 decision 2) against a REAL Postgres: the raw
 * SQL upsert/select on `PlatformConfig`, and fail-closed on a hand-written bad value. Collected
 * only by `jest.db.config.js`; run via `npm run local:test:db`. It touches exactly one
 * `PlatformConfig` key and restores whatever was there before (or deletes the row) afterwards.
 */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { ConfigSnapshotFlagService } from "./config-snapshot-flag.service";

const KEY = "entitlements.configSnapshot";

describeDb("ConfigSnapshotFlagService — real Postgres", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let before: { value: string }[] = [];
  const fresh = () => new ConfigSnapshotFlagService(prisma as never); // no cache carried over

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    before = await prisma.$queryRaw<{ value: string }[]>`
      SELECT value FROM "PlatformConfig" WHERE key = ${KEY} LIMIT 1`;
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = ${KEY}`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = ${KEY}`;
    if (before[0]) await fresh().setEnabled(before[0].value === "on");
    await prisma.$disconnect();
    await pool.end();
  });

  it("defaults OFF with no row, turns on/off through the real upsert, and reads it back", async () => {
    expect(await fresh().isEnabled()).toBe(false);

    await fresh().setEnabled(true);
    expect(await fresh().isEnabled()).toBe(true);

    await fresh().setEnabled(false);
    expect(await fresh().isEnabled()).toBe(false);
    const rows = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "PlatformConfig" WHERE key = ${KEY}`;
    expect(Number(rows[0].n)).toBe(1); // one row, updated in place — never duplicated
  });

  it("a hand-written unparseable value fails CLOSED (OFF)", async () => {
    await prisma.$executeRaw`
      UPDATE "PlatformConfig" SET value = 'yes please' WHERE key = ${KEY}`;
    expect(await fresh().isEnabled()).toBe(false);
  });
});
