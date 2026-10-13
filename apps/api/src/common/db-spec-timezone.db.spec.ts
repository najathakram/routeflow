/**
 * Row 359 — every connection a DB spec opens is UTC, whatever the server's timezone: the clock the day-close
 * windows are compared against must read the real instant, not the instant shifted by the server's offset.
 * Pinned through the three ways a spec reaches Postgres (a `pg` Client, the Prisma pg adapter, and the clock
 * read the close/tender code actually uses), against whatever server timezone the lane runs on.
 *
 * Collected only by `jest.db.config.js`; `requireLocalDatabaseUrl()` refuses any non-local host.
 */
import { Client } from "pg";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { dbClockNow } from "../returns/counter-close-lock";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

describeDb("DB specs run every connection at UTC (row 359)", () => {
  it("a pg Client's session timezone is UTC", async () => {
    const c = new Client({ connectionString: requireLocalDatabaseUrl() });
    await c.connect();
    try {
      expect((await c.query("SHOW timezone")).rows[0].TimeZone).toBe("UTC");
    } finally {
      await c.end();
    }
  });

  it("the Prisma pg adapter's session timezone is UTC, and the database clock matches the real instant", async () => {
    const prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    try {
      const tz = (await prisma.$queryRaw`SHOW timezone`) as Array<{ TimeZone: string }>;
      expect(tz[0].TimeZone).toBe("UTC");
      const before = Date.now();
      const now = await dbClockNow(prisma as never);
      // On a Chicago server without the pin this read is hours away; with it the two clocks agree.
      expect(Math.abs(now.getTime() - before)).toBeLessThan(30_000);
    } finally {
      await prisma.$disconnect();
    }
  });
});
