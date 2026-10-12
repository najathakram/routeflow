/**
 * Row 361 — the app's own connections are UTC whatever the server (or startup option) says: PrismaService's
 * pool (the Prisma adapter) and a pool built from `utcPoolConfig` (the advisory-lock pools use the same
 * function) start a session in America/Chicago via the libpq startup option and must still read UTC, so
 * `dbClockNow` and every timestamptz read agree with the real instant.
 *
 * Collected only by `jest.db.config.js`; `requireLocalDatabaseUrl()` refuses any non-local host.
 */
import { Pool } from "pg";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { utcPoolConfig } from "./pg-session";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

describeDb("the app pins its pg session time zone to UTC (row 361)", () => {
  const saved = process.env.PGOPTIONS;
  beforeAll(() => {
    // Force every new connection to START in Chicago, whatever the server and the spec helper say.
    process.env.PGOPTIONS = "-c timezone=America/Chicago";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = saved;
  });

  it("an UNPINNED pool really starts in Chicago (the control: this test can fail)", async () => {
    const pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    try {
      const { rows } = await pool.query("SHOW timezone");
      expect(rows[0].TimeZone).toBe("America/Chicago");
    } finally {
      await pool.end();
    }
  });

  it("a pool built from utcPoolConfig reads UTC", async () => {
    const pool = new Pool(utcPoolConfig({ connectionString: requireLocalDatabaseUrl() }));
    try {
      const { rows } = await pool.query("SHOW timezone");
      expect(rows[0].TimeZone).toBe("UTC");
    } finally {
      await pool.end();
    }
  });

  it("PrismaService (the adapter's pool) reads UTC, and the database clock is the real instant", async () => {
    const prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    try {
      const tz = (await prisma.$queryRaw`SHOW timezone`) as Array<{ TimeZone: string }>;
      expect(tz[0].TimeZone).toBe("UTC");
      // The clock the day-close / tender windows read: a REAL Date, within seconds of the app clock (on a
      // Chicago-started session without the pin this read is hours away). Queried directly so a driver that
      // returned a non-Date can never pass through `dbClockNow`'s app-clock fallback.
      const before = Date.now();
      const rows = (await prisma.$queryRaw`SELECT clock_timestamp() AS now`) as Array<{
        now: unknown;
      }>;
      expect(rows[0].now).toBeInstanceOf(Date);
      expect(Math.abs((rows[0].now as Date).getTime() - before)).toBeLessThan(30_000);
    } finally {
      await prisma.$disconnect();
    }
  });
});
