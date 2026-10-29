import { advisoryXactLocks } from "./db-locks";

/**
 * Row 562 S1: `advisoryXactLocks` takes MANY transaction-scoped advisory locks of one family in ONE
 * statement, in sorted key order (the multi-key form of `advisoryXactLock`). The real-Postgres proof
 * (every key held, no deadlock against an opposite order) is `inventory/stock-count-seed-locks.db.spec.ts`.
 */
function fakeTx() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const tx = {
    $executeRaw: jest.fn((s: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ sql: s.join("?"), values });
      return Promise.resolve(0);
    }),
  };
  const locks = () => statements.filter((s) => s.sql.includes("pg_advisory_xact_lock"));
  return { tx, statements, locks };
}

describe("advisoryXactLocks (row 562 S1)", () => {
  it("takes N keys in ONE lock statement, de-duplicated and sorted", async () => {
    const f = fakeTx();

    await advisoryXactLocks(f.tx, "stock-count-product", ["t:b", "t:c", "t:a", "t:b"]);

    expect(f.locks()).toHaveLength(1);
    expect(f.locks()[0].values).toEqual(["stock-count-product", ["t:a", "t:b", "t:c"]]);
  });

  it("orders the locks by the sorted position, not by hash or by whatever order the caller used", async () => {
    const f = fakeTx();
    await advisoryXactLocks(f.tx, "stock-count-product", ["z", "a"]);
    const sql = f.locks()[0].sql;
    expect(sql).toMatch(/WITH ORDINALITY/);
    expect(sql).toMatch(/ORDER BY ord/);
    expect(sql).toMatch(/hashtext\(\?\), hashtext\(/);
  });

  it("bounds the wait first (lock_timeout, only while the transaction has none yet)", async () => {
    const f = fakeTx();
    await advisoryXactLocks(f.tx, "stock-count-product", ["a"]);
    expect(f.statements[0].sql).toContain("set_config('lock_timeout'");
    expect(f.statements[1].sql).toContain("pg_advisory_xact_lock");
  });

  it("no keys: no statement at all", async () => {
    const f = fakeTx();
    await advisoryXactLocks(f.tx, "stock-count-product", []);
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("refuses an empty or non-string key and an unknown family before touching the database", async () => {
    const f = fakeTx();
    await expect(advisoryXactLocks(f.tx, "stock-count-product", ["a", ""])).rejects.toThrow(
      TypeError,
    );
    await expect(
      advisoryXactLocks(f.tx, "stock-count-product", [42 as unknown as string]),
    ).rejects.toThrow(TypeError);
    await expect(advisoryXactLocks(f.tx, "no-such-family" as any, ["a"])).rejects.toThrow(
      TypeError,
    );
    expect(f.tx.$executeRaw).not.toHaveBeenCalled();
  });
});
