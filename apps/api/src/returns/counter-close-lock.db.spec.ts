/**
 * SA-740r2 item 6 / SA-750r3 - real-Postgres pin of the counter-close LOCK KEY CONTRACT the future end-of-day close must match.
 *
 * The refund paths take `lockCounterClose` (SHARED form of the key `(hashtext('counter-close'), hashtext('<tenant>:<register>'))`)
 * as the first statement of their transaction. The close will take the EXCLUSIVE form of the SAME key. This proves, against the
 * real lock manager, that:
 *   - a session holding `pg_advisory_xact_lock(hashtext('counter-close'), hashtext('<tenant>:main'))` BLOCKS a refund's lock
 *     (pg_blocking_pids shows it queued behind the holder) until the holder commits;
 *   - the same holder does NOT block another register of the tenant, or another tenant;
 *   - two refunds (shared form) never block each other.
 * `lockCounterClose` is the exact helper both `InlineReturnsService.refund` and `ReturnsService.recordExternalRefund` call (the
 * services' use of it as the first statement is pinned in their unit specs).
 *
 * Runs only under `npm run local:test:db`. Written WITHOUT being run in the authoring environment (no Postgres there).
 */
import { randomUUID } from "crypto";
import { Client, Pool } from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { lockCounterClose } from "./counter-close-lock";

const RUN = randomUUID().slice(0, 8);
const TENANT = `qa-closelock-${RUN}`; // a tenant-id-shaped string: the key only hashes it, no row is read or written
const OTHER_TENANT = `qa-closelock-other-${RUN}`;

describeDb("counter-close lock key contract, real Postgres", () => {
  let url: string;
  let pool: Pool;
  let prisma: PrismaClient;
  let holder: Client;
  let poller: Client;

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url, max: 6 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    holder = new Client({ connectionString: url });
    poller = new Client({ connectionString: url });
    await holder.connect();
    await poller.connect();
  });

  afterAll(async () => {
    await holder.query("ROLLBACK").catch(() => undefined);
    await holder.end().catch(() => undefined);
    await poller.end().catch(() => undefined);
    await prisma.$disconnect();
    await pool.end();
  });

  const closeLockSql = `SELECT pg_advisory_xact_lock(hashtext('counter-close'), hashtext($1))`;
  const refundLock = (tenant: string, register: string) =>
    prisma.$transaction((tx) => lockCounterClose(tx as any, tenant, register), { timeout: 20_000 });

  async function blockedCount(holderPid: number): Promise<number> {
    const r = await poller.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    return Number(r.rows[0].n);
  }
  const settleWithin = (p: Promise<unknown>, ms: number) =>
    Promise.race([
      p.then(() => "done"),
      new Promise((res) => setTimeout(() => res("pending"), ms)),
    ]);

  it("an exclusive close lock on tenant:main blocks a refund's shared lock until the close commits; other registers and tenants are not blocked", async () => {
    await holder.query("BEGIN");
    await holder.query(closeLockSql, [`${TENANT}:main`]);
    const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);

    // other register / other tenant: not blocked, settle at once
    expect(await settleWithin(refundLock(TENANT, "till-2"), 5_000)).toBe("done");
    expect(await settleWithin(refundLock(OTHER_TENANT, "main"), 5_000)).toBe("done");

    // the same tenant:main refund is queued behind the holder (the real red pin: the key matches the close's key)
    const blocked = refundLock(TENANT, "main");
    let queued = 0;
    for (let i = 0; i < 100 && queued === 0; i++) {
      queued = await blockedCount(holderPid);
      if (queued === 0) await new Promise((res) => setTimeout(res, 50));
    }
    expect(queued).toBeGreaterThan(0);
    expect(await settleWithin(blocked, 300)).toBe("pending");

    await holder.query("COMMIT"); // the close finishes: the refund proceeds
    expect(await settleWithin(blocked, 10_000)).toBe("done");
  }, 60_000);

  it("two refunds (the shared form) never block each other", async () => {
    await holder.query("BEGIN");
    await holder.query(
      `SELECT pg_advisory_xact_lock_shared(hashtext('counter-close'), hashtext($1))`,
      [`${TENANT}:main`],
    );
    expect(await settleWithin(refundLock(TENANT, "main"), 5_000)).toBe("done");
    await holder.query("COMMIT");
  }, 60_000);
});
