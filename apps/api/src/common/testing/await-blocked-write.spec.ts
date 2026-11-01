import { awaitBlockedWrite } from "./await-blocked-write";
import type { Queryable } from "./blocked-wait";

/**
 * A SLOW fixture: the write only becomes visible as blocked `visibleAfterMs` after the probe was built, as on a host
 * so loaded that the write's connection takes seconds to open. A fixed 300 ms look (the old `setTimeout`) would have
 * seen nothing and either passed vacuously or asserted too early; the signal wait outlasts it.
 */
function slowDb(visibleAfterMs: number): Queryable & { probes: number } {
  const born = Date.now();
  const db = {
    probes: 0,
    async query(sql: string) {
      if (/pg_stat_clear_snapshot/.test(sql)) return { rows: [] };
      db.probes += 1;
      return Date.now() - born >= visibleAfterMs
        ? { rows: [{ pid: 4242, blockers: [4141] }] }
        : { rows: [] };
    },
  };
  return db;
}

const never = () => new Promise<void>(() => {});

describe("awaitBlockedWrite", () => {
  it("waits past the old 300 ms window for a slow write to block, then reports who blocked", async () => {
    const db = slowDb(1_200);
    const started = Date.now();
    const blocked = await awaitBlockedWrite(db, never(), { intervalMs: 10 });
    expect(blocked).toEqual([{ pid: 4242, blockers: [4141] }]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_150);
    expect(db.probes).toBeGreaterThan(5); // polled on a signal, not looked at once
  });

  it("returns at once when the write is already blocked", async () => {
    const blocked = await awaitBlockedWrite(slowDb(0), never(), { intervalMs: 10 });
    expect(blocked).toHaveLength(1);
  });

  it("fails with the write's own error when it fails before it ever blocks", async () => {
    const failing = Promise.reject(new Error("Order lock unavailable"));
    await expect(awaitBlockedWrite(slowDb(60_000), failing, { intervalMs: 10 })).rejects.toThrow(
      "Order lock unavailable",
    );
  });

  it("fails when the write finishes without ever blocking (the lock held nothing back)", async () => {
    await expect(
      awaitBlockedWrite(slowDb(60_000), Promise.resolve("done"), { intervalMs: 10 }),
    ).rejects.toThrow(/finished without ever blocking/);
  });

  it("gives up only at the safety ceiling, and says so", async () => {
    await expect(
      awaitBlockedWrite(slowDb(60_000), never(), { intervalMs: 10, ceilingMs: 150 }),
    ).rejects.toThrow(/no backend blocked within 150ms/);
  });
});
