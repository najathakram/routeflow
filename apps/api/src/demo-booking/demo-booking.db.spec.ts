/**
 * Real-Postgres contention spec for the demo-booking race guards (review
 * finding 4 / round-2 finding B).
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js's `.db.spec.ts$`
 * lane) — never in the default `npm run test` red gate. `requireLocalDatabaseUrl()`
 * refuses any non-local host.
 *
 * Proves the two independent guards `demo-booking.service.ts` relies on,
 * each against REAL Postgres rather than the in-memory FIFO mock
 * `demo-booking.service.spec.ts` uses:
 *
 *   (a) the `demo-booking` advisory lock genuinely serialises two concurrent
 *       holders on the same key, across two separate connections — the same
 *       shape `db-locks.db.spec.ts` case (a) proves for `order-merge`;
 *   (b) the partial unique index from migration 20260916031500
 *       (`DemoBooking_startsAt_confirmed_key`) rejects a second CONFIRMED row
 *       at the same `startsAt` (23505), and does NOT reject a CANCELLED one
 *       at that same instant — the exact behaviour verified by hand against a
 *       throwaway scratch table before that migration was committed, made
 *       permanent here.
 *
 * PREREQUISITE: the `DemoBooking` table must already exist — this spec does
 * not provision schema itself (same posture as every other `.db.spec.ts` in
 * this repo). Run `npm run local:migrate` first if you added or changed a
 * migration this session.
 *
 * SAFETY. Every row this file creates carries a `db-spec-<run>-` id prefix;
 * `afterAll` deletes exactly those ids. No other row in the table is read,
 * written, or assumed to be absent.
 */
import { randomUUID } from "crypto";
import { Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

let lockMod: { withAdvisoryLock?: (...args: unknown[]) => unknown } = {};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  lockMod = require("../common/db-locks");
} catch {
  lockMod = {};
}

async function withAdvisoryLock(
  opts: { family: string; key: string; mode: "wait" | "try"; waitMs?: number },
  fn: () => Promise<unknown>,
): Promise<{ acquired: boolean; value?: unknown }> {
  if (typeof lockMod.withAdvisoryLock === "function") {
    return lockMod.withAdvisoryLock(opts, fn) as Promise<{ acquired: boolean; value?: unknown }>;
  }
  // Guarded-require fallback (house rule, see db-locks.db.spec.ts): keep the
  // callback-driven synchronisation these contention tests use from hanging
  // forever, while still failing the test on its own assertion.
  try {
    await fn();
  } catch {
    // swallowed — the test's own assertions decide pass/fail
  }
  return { acquired: false };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const RUN = randomUUID().slice(0, 8);
const ID_PREFIX = `db-spec-${RUN}-`;
const createdIds: string[] = [];

function row(id: string, startsAt: Date, status: "CONFIRMED" | "CANCELLED" = "CONFIRMED") {
  createdIds.push(id);
  return {
    id,
    name: "DB Spec",
    email: "db-spec@example.com",
    company: "DB Spec Co",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    timeZone: "America/Chicago",
    status,
    manageTokenHash: `hash-${id}`,
  };
}

async function insertRow(client: Client, r: ReturnType<typeof row>) {
  return client.query(
    `INSERT INTO "DemoBooking"
       (id, name, email, company, "startsAt", "endsAt", "timeZone", status, "manageTokenHash", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
    [
      r.id,
      r.name,
      r.email,
      r.company,
      r.startsAt,
      r.endsAt,
      r.timeZone,
      r.status,
      r.manageTokenHash,
    ],
  );
}

describeDb("demo-booking — real-Postgres contention (review findings 4 / round-2 B)", () => {
  let databaseUrl: string;
  let verifyClient: Client;

  beforeAll(async () => {
    databaseUrl = requireLocalDatabaseUrl();
    verifyClient = new Client({ connectionString: databaseUrl });
    await verifyClient.connect();
    const exists = await verifyClient.query(
      `SELECT to_regclass('"DemoBooking"') IS NOT NULL AS present`,
    );
    if (!exists.rows[0].present) {
      throw new Error(
        'The "DemoBooking" table does not exist on this database. Run `npm run local:migrate` ' +
          "(after `npm run local:up`) to apply the demo-booking migrations first.",
      );
    }
  });

  afterAll(async () => {
    if (createdIds.length) {
      await verifyClient.query(`DELETE FROM "DemoBooking" WHERE id = ANY($1::text[])`, [
        createdIds,
      ]);
    }
    await verifyClient.end();
  });

  it("(a) two concurrent wait locks on the SAME demo-booking key serialise across two connections", async () => {
    const events: Array<{ start: number; end: number }> = [];
    const run = () =>
      withAdvisoryLock(
        { family: "demo-booking", key: `${ID_PREFIX}lock`, mode: "wait", waitMs: 20_000 },
        async () => {
          const start = Date.now();
          await sleep(250);
          const end = Date.now();
          events.push({ start, end });
          return end;
        },
      );

    const [r1, r2] = await Promise.all([run(), run()]);
    expect(r1.acquired).toBe(true);
    expect(r2.acquired).toBe(true);
    expect(events).toHaveLength(2);
    const [first, second] = [...events].sort((x, y) => x.start - y.start);
    expect(second.start).toBeGreaterThanOrEqual(first.end);
  }, 15_000);

  it("(b) the partial unique index rejects a second CONFIRMED row at the same startsAt", async () => {
    const startsAt = new Date(Date.now() + 10 * 86_400_000);
    startsAt.setUTCMinutes(0, 0, 0);
    const a = new Client({ connectionString: databaseUrl });
    const b = new Client({ connectionString: databaseUrl });
    await a.connect();
    await b.connect();
    try {
      await insertRow(a, row(`${ID_PREFIX}b-first`, startsAt));

      let rejection: { code?: string } | null = null;
      try {
        await insertRow(b, row(`${ID_PREFIX}b-second`, startsAt));
      } catch (error) {
        rejection = error as { code?: string };
      }

      expect(rejection).not.toBeNull();
      expect(rejection?.code).toBe("23505");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("(c) a CANCELLED row at the same startsAt does not conflict with a CONFIRMED one", async () => {
    const startsAt = new Date(Date.now() + 11 * 86_400_000);
    startsAt.setUTCMinutes(0, 0, 0);
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await insertRow(client, row(`${ID_PREFIX}c-confirmed`, startsAt, "CONFIRMED"));
      // Must not throw — the partial index only covers status = 'CONFIRMED'.
      await expect(
        insertRow(client, row(`${ID_PREFIX}c-cancelled`, startsAt, "CANCELLED")),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });
});
