/**
 * `lockRowsNoWait` (apps/api/src/common/db-locks.ts) — the shared `FOR NO KEY UPDATE NOWAIT`
 * row lock behind the at-door merge's stop lock and the invoice un-send.
 *
 * Pure unit: the "tx" is a fake whose `$executeRaw` records the tagged-template call, so a case
 * can assert the emitted SQL and drive the 55P03 branch without a database. `pg` is never
 * touched here — the module's advisory-lock half lazily builds its pool on first use only.
 */

import { ConflictException } from "@nestjs/common";

import { lockRowsNoWait, NOWAIT_LOCK_TABLES } from "./db-locks";

const fakeTx = () => ({ $executeRaw: jest.fn().mockResolvedValue(0) });
// The tagged-template strings, re-joined with a placeholder per interpolated value.
const sqlOf = (tx: { $executeRaw: jest.Mock }, call = 0) =>
  tx.$executeRaw.mock.calls[call][0].join("?");

describe("db-locks — lockRowsNoWait", () => {
  it("P14a: locks the named rows FOR NO KEY UPDATE NOWAIT on the quoted table", async () => {
    const tx = fakeTx();

    await lockRowsNoWait(tx, "RouteRunStop", ["stop-1"], "STOP_BUSY");

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(tx)).toContain('"RouteRunStop"');
    expect(sqlOf(tx)).toContain("FOR NO KEY UPDATE NOWAIT");
  });

  it("P14b: every allowed table emits its own quoted identifier", async () => {
    for (const table of NOWAIT_LOCK_TABLES) {
      const tx = fakeTx();
      await lockRowsNoWait(tx, table, ["id-1"], "REASON");
      expect(sqlOf(tx)).toContain(`"${table}"`);
      expect(sqlOf(tx)).toContain("FOR NO KEY UPDATE NOWAIT");
    }
  });

  it("P14c: a 55P03 on meta.code becomes a retryable CONCURRENT_UPDATE conflict", async () => {
    const tx = fakeTx();
    const lockErr: any = new Error("Raw query failed");
    lockErr.meta = { code: "55P03" };
    tx.$executeRaw.mockRejectedValueOnce(lockErr);

    const err = await lockRowsNoWait(tx, "Invoice", ["inv-1"], "INVOICE_BUSY").catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "CONCURRENT_UPDATE",
      reason: "INVOICE_BUSY",
      retryable: true,
    });
  });

  it("P14d: the same conflict when the driver reports 55P03 only in the message", async () => {
    const tx = fakeTx();
    tx.$executeRaw.mockRejectedValueOnce(
      new Error('could not obtain lock on row in relation "Invoice"'),
    );

    const err = await lockRowsNoWait(tx, "Invoice", ["inv-1"], "INVOICE_BUSY").catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "CONCURRENT_UPDATE", retryable: true });
  });

  it("P14e: any other failure is rethrown unchanged, never dressed up as a 409", async () => {
    const tx = fakeTx();
    const boom = new Error("connection terminated unexpectedly");
    tx.$executeRaw.mockRejectedValueOnce(boom);

    await expect(lockRowsNoWait(tx, "RouteRunStop", ["stop-1"], "STOP_BUSY")).rejects.toBe(boom);
  });

  it("P14f: an empty id list issues no query at all", async () => {
    const tx = fakeTx();

    await lockRowsNoWait(tx, "Invoice", [], "INVOICE_BUSY");

    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("P14g: a table outside the allow-list throws before any query", async () => {
    const tx = fakeTx();

    await expect(lockRowsNoWait(tx, "Order" as any, ["o-1"], "X")).rejects.toThrow(/unknown table/);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
