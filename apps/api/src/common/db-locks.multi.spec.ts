/**
 * #3199 review: `withAdvisoryLocks(opts, fn)` — several keys of ONE family on ONE pinned connection.
 * `pg` is mocked wholesale (same shape as db-locks.spec.ts): `Pool.connect()` resolves a fake client
 * on a real EventEmitter, so the order of every LOCK / UNLOCK statement and every release is visible.
 */
import { EventEmitter } from "events";

const mockConnect = jest.fn();
const mockPoolCtor = jest
  .fn()
  .mockImplementation(() => ({ connect: mockConnect, on: jest.fn(), end: jest.fn() }));
jest.mock("pg", () => ({ Pool: mockPoolCtor }));

import {
  LockTimeoutError,
  LockUnavailableError,
  _resetLockPoolForTests,
  withAdvisoryLocks,
} from "./db-locks";

const makeClient = () =>
  Object.assign(new EventEmitter(), { query: jest.fn(), release: jest.fn() });
const LOCK = "SELECT pg_advisory_lock(hashtext($1), hashtext($2))";
const UNLOCK = "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))";

describe("withAdvisoryLocks — several keys, one connection (#3199 review)", () => {
  let client: ReturnType<typeof makeClient>;
  beforeEach(async () => {
    jest.clearAllMocks();
    await _resetLockPoolForTests();
    client = makeClient();
    client.query.mockResolvedValue({ rows: [] });
    mockConnect.mockResolvedValue(client);
  });
  const statements = () =>
    client.query.mock.calls
      .filter(([sql]) => sql === LOCK || sql === UNLOCK)
      .map(([sql, args]) => `${sql === LOCK ? "lock" : "unlock"} ${(args as string[])[1]}`);

  it("takes every key SORTED (deduped) on ONE connection, runs fn, then unlocks them all", async () => {
    const out = await withAdvisoryLocks(
      { family: "billing", keys: ["addon:t:C", "addon:t:A", "addon:t:B", "addon:t:A"] },
      async () => "done",
    );
    expect(out).toBe("done");
    expect(mockConnect).toHaveBeenCalledTimes(1); // one pool slot, not three
    expect(statements()).toEqual([
      "lock addon:t:A",
      "lock addon:t:B",
      "lock addon:t:C",
      "unlock addon:t:C",
      "unlock addon:t:B",
      "unlock addon:t:A",
    ]);
    expect(client.release).toHaveBeenCalledWith(); // clean release, connection kept
  });

  it("a throwing fn still unlocks every key and releases cleanly, and the error reaches the caller", async () => {
    await expect(
      withAdvisoryLocks({ family: "billing", keys: ["b", "a"] }, async () => {
        throw new Error("apply failed");
      }),
    ).rejects.toThrow("apply failed");
    expect(statements()).toEqual(["lock a", "lock b", "unlock b", "unlock a"]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("a lock_timeout on the second key releases the first and rejects LockTimeoutError (fn never runs)", async () => {
    client.query.mockImplementation(async (sql: string, args?: string[]) => {
      if (sql === LOCK && args?.[1] === "b")
        throw Object.assign(new Error("timeout"), { code: "55P03" });
      return { rows: [] };
    });
    const fn = jest.fn();
    await expect(
      withAdvisoryLocks({ family: "billing", keys: ["a", "b"] }, fn),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(fn).not.toHaveBeenCalled();
    expect(statements()).toEqual(["lock a", "lock b", "unlock a"]);
  });

  it("no connection is LockUnavailableError; an unknown family or empty key is refused before connecting", async () => {
    mockConnect.mockRejectedValueOnce(new Error("pool exhausted"));
    await expect(
      withAdvisoryLocks({ family: "billing", keys: ["a"] }, async () => 1),
    ).rejects.toBeInstanceOf(LockUnavailableError);
    mockConnect.mockClear();
    await expect(withAdvisoryLocks({ family: "nope", keys: ["a"] }, async () => 1)).rejects.toThrow(
      TypeError,
    );
    await expect(
      withAdvisoryLocks({ family: "billing", keys: [""] }, async () => 1),
    ).rejects.toThrow(TypeError);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("an unlock that fails destroys the connection (the server then drops what it still held)", async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql === UNLOCK) throw new Error("socket closed");
      return { rows: [] };
    });
    await withAdvisoryLocks({ family: "billing", keys: ["a"] }, async () => 1);
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });
});
