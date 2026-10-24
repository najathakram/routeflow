/**
 * SA-750r3 (day close): `withAdvisoryLock`'s `sharedAlso` option takes the SHARED counter-close lock on the SAME pinned
 * connection right after the first lock (a second connection could exhaust the 4-slot `counter-tender` pool) and releases
 * it before the first lock, even when `fn` throws. Callers that do not pass it are unchanged.
 */
import { EventEmitter } from "events";

const mockConnect = jest.fn();
const mockPoolCtor = jest
  .fn()
  .mockImplementation(() => ({ connect: mockConnect, on: jest.fn(), end: jest.fn() }));
jest.mock("pg", () => ({ Pool: mockPoolCtor }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withAdvisoryLock, LockTimeoutError, _resetLockPoolForTests } = require("./db-locks");

const makeClient = () =>
  Object.assign(new EventEmitter(), { query: jest.fn(), release: jest.fn() });
const sqls = (client: ReturnType<typeof makeClient>): string[] =>
  client.query.mock.calls.map((c: unknown[]) => String(c[0]));
const SHARED = { family: "counter-close", key: "tenant-1:main" };

describe("withAdvisoryLock — sharedAlso (SA-750r3)", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await _resetLockPoolForTests();
  });

  it("takes the shared lock on the SAME client right after the order lock, and releases it BEFORE the first lock", async () => {
    const client = makeClient();
    client.query.mockResolvedValue({ rows: [] });
    mockConnect.mockResolvedValueOnce(client);
    const fn = jest.fn().mockResolvedValue("done");

    const res = await withAdvisoryLock(
      { family: "counter-tender", key: "order-1", mode: "wait", sharedAlso: SHARED },
      fn,
    );

    expect(res).toEqual({ acquired: true, value: "done" });
    expect(mockConnect).toHaveBeenCalledTimes(1); // ONE connection: no second pool slot
    expect(sqls(client)).toEqual([
      expect.stringContaining("SET lock_timeout"),
      "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
      "SELECT pg_advisory_lock_shared(hashtext($1), hashtext($2))",
      "SELECT pg_advisory_unlock_shared(hashtext($1), hashtext($2))",
      "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
    ]);
    expect(client.query.mock.calls[1][1]).toEqual(["counter-tender", "order-1"]);
    expect(client.query.mock.calls[2][1]).toEqual(["counter-close", "tenant-1:main"]);
    expect(client.query.mock.calls[3][1]).toEqual(["counter-close", "tenant-1:main"]);
    expect(client.query.mock.calls[4][1]).toEqual(["counter-tender", "order-1"]);
    // fn runs only once BOTH locks are held and before either is released.
    const order = (m: jest.Mock) => m.mock.invocationCallOrder[0];
    expect(order(fn)).toBeGreaterThan(client.query.mock.invocationCallOrder[2]);
    expect(order(fn)).toBeLessThan(client.query.mock.invocationCallOrder[3]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("still releases the shared lock then the first lock when fn throws, and rethrows fn's error", async () => {
    const client = makeClient();
    client.query.mockResolvedValue({ rows: [] });
    mockConnect.mockResolvedValueOnce(client);
    const boom = new Error("tender failed");

    await expect(
      withAdvisoryLock(
        { family: "counter-tender", key: "order-1", mode: "wait", sharedAlso: SHARED },
        async () => {
          throw boom;
        },
      ),
    ).rejects.toBe(boom);

    expect(sqls(client).slice(-2)).toEqual([
      "SELECT pg_advisory_unlock_shared(hashtext($1), hashtext($2))",
      "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
    ]);
    expect(client.release).toHaveBeenCalledWith(); // healthy connection: not destroyed
  });

  it("a lock_timeout on the shared acquire surfaces as LockTimeoutError, never runs fn, and unlocks the first lock", async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // SET
      .mockResolvedValueOnce({ rows: [] }) // first lock
      .mockRejectedValueOnce(Object.assign(new Error("lock timeout"), { code: "55P03" })) // shared
      .mockResolvedValue({ rows: [] }); // unlock
    mockConnect.mockResolvedValueOnce(client);
    const fn = jest.fn();

    const err = await withAdvisoryLock(
      { family: "counter-tender", key: "order-1", mode: "wait", sharedAlso: SHARED },
      fn,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LockTimeoutError);
    expect(fn).not.toHaveBeenCalled();
    expect(sqls(client)).toEqual([
      expect.stringContaining("SET lock_timeout"),
      "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
      "SELECT pg_advisory_lock_shared(hashtext($1), hashtext($2))",
      "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", // no shared unlock: it was never taken
    ]);
    expect(client.release).toHaveBeenCalledWith();
  });

  it("a failed shared unlock destroys the connection but the first lock is still unlocked", async () => {
    const client = makeClient();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // SET
      .mockResolvedValueOnce({ rows: [] }) // first lock
      .mockResolvedValueOnce({ rows: [] }) // shared lock
      .mockRejectedValueOnce(new Error("socket gone")) // shared unlock
      .mockResolvedValueOnce({ rows: [] }); // first unlock
    mockConnect.mockResolvedValueOnce(client);

    await withAdvisoryLock(
      { family: "counter-tender", key: "order-1", mode: "wait", sharedAlso: SHARED },
      async () => 1,
    );

    expect(sqls(client)[4]).toBe("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))");
    expect(client.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it("rejects an unknown shared family before connecting (a typo cannot read as locked)", async () => {
    await expect(
      withAdvisoryLock(
        {
          family: "counter-tender",
          key: "order-1",
          mode: "wait",
          sharedAlso: { family: "counter-clsoe", key: "t:main" },
        },
        async () => 1,
      ),
    ).rejects.toThrow(TypeError);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("without sharedAlso the query sequence is exactly the pre-existing one", async () => {
    const client = makeClient();
    client.query.mockResolvedValue({ rows: [] });
    mockConnect.mockResolvedValueOnce(client);

    await withAdvisoryLock(
      { family: "counter-tender", key: "order-1", mode: "wait" },
      async () => 1,
    );

    expect(sqls(client)).toEqual([
      expect.stringContaining("SET lock_timeout"),
      "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
      "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
    ]);
  });
});
