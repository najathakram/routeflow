import { ConflictException } from "@nestjs/common";
import { lockProductPack, lockTenantUnits } from "./tenant-units-lock";

type Call = { sql: string; values: unknown[] };

function tx(failOn?: (sql: string) => unknown) {
  const calls: Call[] = [];
  const $executeRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    calls.push({ sql, values });
    const err = failOn?.(sql);
    if (err) throw err;
    return 0;
  });
  return { $executeRaw, calls };
}
const sqls = (calls: Call[]) => calls.map((c) => c.sql);

describe("lockTenantUnits: a bounded wait", () => {
  it("shared: SET LOCAL lock_timeout is issued BEFORE the lock, and reset to the default after it", async () => {
    const t = tx();
    await lockTenantUnits(t, "t1", "shared");
    expect(sqls(t.calls)).toEqual([
      "SET LOCAL lock_timeout = '3s'",
      "SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?))",
      "SET LOCAL lock_timeout TO DEFAULT",
    ]);
    expect(t.calls[1].values).toEqual(["tenant-units", "t1"]);
  });

  it("exclusive (the rename): its own bounded wait, 5 s, then the exclusive lock", async () => {
    const t = tx();
    await lockTenantUnits(t, "t1", "exclusive");
    expect(sqls(t.calls)).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))",
      "SET LOCAL lock_timeout TO DEFAULT",
    ]);
  });

  it.each([
    [
      "a pg error carrying code 55P03",
      { code: "55P03", message: "canceling statement due to lock timeout" },
    ],
    [
      "a Prisma raw-query error with meta.code 55P03",
      { code: "P2010", meta: { code: "55P03" }, message: "Raw query failed" },
    ],
    [
      "a driver-adapter error",
      {
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
        message: "x",
      },
    ],
    ["only the message", new Error("canceling statement due to lock timeout")],
  ])("%s maps to the 409 UNITS_RENAME_IN_PROGRESS", async (_n, error) => {
    const t = tx((sql) => (sql.includes("pg_advisory") ? error : null));
    const err = await lockTenantUnits(t, "t1", "shared").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({
      code: "UNITS_RENAME_IN_PROGRESS",
      message: "A unit rename is in progress. Try again in a moment.",
    });
  });

  it("a timeout waiting for the EXCLUSIVE lock (writers hold it) is the same 409", async () => {
    const t = tx((sql) => (sql.includes("pg_advisory") ? { code: "55P03" } : null));
    await expect(lockTenantUnits(t, "t1", "exclusive")).rejects.toBeInstanceOf(ConflictException);
  });

  it("any other error is rethrown unchanged", async () => {
    const boom = new Error("connection reset");
    const t = tx((sql) => (sql.includes("pg_advisory") ? boom : null));
    await expect(lockTenantUnits(t, "t1", "shared")).rejects.toBe(boom);
  });
});

describe("lockProductPack: both holders are bounded", () => {
  it("tenant lock (shared), then the product lock, inside ONE bounded window", async () => {
    const t = tx();
    await lockProductPack(t, "t1", "p1");
    expect(sqls(t.calls)).toEqual([
      "SET LOCAL lock_timeout = '3s'",
      "SELECT pg_advisory_xact_lock_shared(hashtext(?), hashtext(?))",
      "SELECT pg_advisory_xact_lock(hashtext('product-units'), hashtext(?))",
      "SET LOCAL lock_timeout TO DEFAULT",
    ]);
    expect(t.calls[2].values).toEqual(["p1"]);
  });

  it("a timeout on the PRODUCT lock is the same 409", async () => {
    const t = tx((sql) => (sql.includes("'product-units'") ? { code: "55P03" } : null));
    await expect(lockProductPack(t, "t1", "p1")).rejects.toBeInstanceOf(ConflictException);
  });
});
