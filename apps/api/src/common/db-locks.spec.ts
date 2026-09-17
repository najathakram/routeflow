/**
 * T1 (R1) — `apps/api/src/common/db-locks.ts` contract: `withAdvisoryLock<T>(opts, fn)`.
 *
 * House rule for tests of NEW modules: guarded `require` inside the test body so absence
 * fails on an assertion (`typeof mod.withAdvisoryLock` is `"undefined"`), never on an
 * unresolved import. See test-plan.md T1.
 *
 * `pg` is mocked wholesale: `Pool`'s `connect()` resolves a fake client built on a real
 * `EventEmitter` (`{ query: jest.fn(), release: jest.fn() }` layered on top) so a case can
 * `emit("error", …)` mid-`fn` and exercise the module's own `on`/`removeListener` pairing.
 */

import { EventEmitter } from "events";

const mockConnect = jest.fn();
// `on` is part of the fake: the module registers a pool-level "error" listener at creation so a
// dropped idle connection cannot surface as an uncaught EventEmitter error.
const mockPoolOn = jest.fn();
// `end` is part of the fake so `_resetLockPoolForTests()` can drop the memoized pool and let a
// case observe a FRESH construction (the pool is built once, on first use).
const mockPoolEnd = jest.fn();
const mockPoolCtor = jest
  .fn()
  .mockImplementation(() => ({ connect: mockConnect, on: mockPoolOn, end: mockPoolEnd }));

jest.mock("pg", () => ({
  Pool: mockPoolCtor,
}));

describe("db-locks — withAdvisoryLock (T1, R1)", () => {
  let mod: any = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require("./db-locks");
  } catch {
    mod = {};
  }

  // Call-site fallback: the guarded require above protects the module LOAD, but calling a
  // missing export would still throw `TypeError: … is not a function` before any assertion
  // runs. Resolving to a sentinel instead keeps every case failing on its OWN oracle (a
  // wrong `acquired`/`value`, or a promise that resolved when a case expects a rejection)
  // rather than on an uncaught exception.
  const NOT_IMPLEMENTED = Symbol("db-locks not implemented");
  const withAdvisoryLock = (opts: unknown, fn: () => unknown): Promise<any> =>
    typeof mod.withAdvisoryLock === "function"
      ? mod.withAdvisoryLock(opts, fn)
      : Promise.resolve(NOT_IMPLEMENTED);

  // A real EventEmitter so a case can `emit("error", …)` mid-`fn` and the module's own
  // `client.on("error", …)` / `client.removeListener("error", …)` pairing actually fires,
  // rather than asserting against a jest.fn() stand-in that never wires the two together.
  const makeClient = () =>
    Object.assign(new EventEmitter(), { query: jest.fn(), release: jest.fn() });

  // Safe positional read into a jest mock's call log — returns `[]` (never throws) for a
  // call index that never happened, so an unmet expectation fails via `toBe`/`toEqual`
  // rather than via a TypeError indexing into `undefined`.
  const callArgs = (fn: jest.Mock, n: number): unknown[] => fn.mock.calls[n] ?? [];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("module shape", () => {
    it("exports withAdvisoryLock — the customer advisory lock helper — as a function", () => {
      expect(typeof mod.withAdvisoryLock).toBe("function");
    });

    it("exports LOCK_FAMILIES as the closed list of families that may own a pool", () => {
      // F5 round 1 (independent review round 1, PR-2) briefly added "idempotency" here;
      // round 2 (N1, independent review round 2) retired it — ReturnsService#create now takes a
      // TRANSACTION-scoped pg_advisory_xact_lock on its own connection instead
      // (common/idempotency.service.ts#acquireLock), needing no dedicated pool at all.
      // "tenant-mirror" (F3, Phase 0 T12-T15 review round, 2026-09-15) backs
      // TenantMirrorService#upsert's session-scoped critical section (spans a $transaction PLUS
      // a separate ContactPerson find-then-create loop — genuinely session-scoped, unlike the
      // retired idempotency case above). "demo-booking" (2026-09-16, review finding 4) backs
      // DemoBookingService#create/#reschedule's check-then-write window on the public,
      // unauthenticated demo-booking endpoint, keyed on the slot's start instant.
      expect(mod.LOCK_FAMILIES).toEqual([
        "order-merge",
        "cron",
        "billing",
        "tenant-mirror",
        "demo-booking",
      ]);
    });
  });

  describe("withAdvisoryLock", () => {
    it("(a) wait mode: SET, advisory lock acquire, and advisory lock unlock queries fire in order, the client is released with no argument, and the result is { acquired: true, value }", async () => {
      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);

      const fn = jest.fn().mockResolvedValue(42);

      const result = await withAdvisoryLock(
        { family: "order-merge", key: "cust-1", mode: "wait" },
        fn,
      );

      expect(result).toEqual({ acquired: true, value: 42 });
      expect(fn).toHaveBeenCalledTimes(1);

      expect(client.query.mock.calls.length).toBe(3);
      expect(callArgs(client.query, 0)).toEqual(["SET lock_timeout = '20000ms'"]);
      expect(callArgs(client.query, 1)[0]).toBe(
        "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
      );
      expect(callArgs(client.query, 1)[1]).toEqual(["order-merge", "cust-1"]);
      expect(callArgs(client.query, 2)[0]).toBe(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
      );
      expect(callArgs(client.query, 2)[1]).toEqual(["order-merge", "cust-1"]);

      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith();
    });

    it("(b) fn rejecting still issues the advisory lock unlock and rejects with that same error — and once that unlock LANDS the client is released cleanly, not destroyed", async () => {
      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);

      const boom = new Error("boom");
      const fn = jest.fn().mockRejectedValue(boom);

      await expect(
        withAdvisoryLock({ family: "order-merge", key: "cust-1", mode: "wait" }, fn),
      ).rejects.toBe(boom);

      expect(client.query.mock.calls.length).toBe(3);
      expect(callArgs(client.query, 2)[0]).toBe(
        "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
      );
      expect(callArgs(client.query, 2)[1]).toEqual(["order-merge", "cust-1"]);
      expect(client.release).toHaveBeenCalledTimes(1);
      // NO argument. `release(err)` DESTROYS the connection, and after an unlock that SUCCEEDED
      // this session holds nothing: a thrown `fn` is an application failure (a validation error,
      // a dead dependency inside the critical section), not a sick connection. Destroying on it
      // would burn one of the 8 pinned slots every time a merge fails — shrinking the pool for
      // unrelated customers. Destroy stays for the two cases where state may survive: a failed
      // unlock (case (i)/(j)) and a connection/session-setup error (case (g)).
      expect(client.release).toHaveBeenCalledWith();
    });

    it("(c) a 55P03 on the advisory lock acquire rejects with LockTimeoutError, never calls fn, and still releases the client", async () => {
      const client = makeClient();
      const timeoutErr = Object.assign(new Error("lock timeout"), { code: "55P03" });
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockRejectedValueOnce(timeoutErr); // pg_advisory_lock
      mockConnect.mockResolvedValueOnce(client);

      const fn = jest.fn();

      await expect(
        withAdvisoryLock({ family: "order-merge", key: "cust-1", mode: "wait" }, fn),
      ).rejects.toMatchObject({ name: "LockTimeoutError" });

      expect(fn).not.toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledTimes(1);
      // …and released CLEANLY, with no argument. A 55P03 means the acquire gave up WITHOUT
      // taking the lock, on a healthy connection: there is nothing to unlock and nothing to
      // destroy. `release(err)` DESTROYS the connection, so treating a timeout as a failure
      // would burn one of the 8 pool slots on every contended merge — shrinking the pool
      // exactly when contention is highest, until unrelated customers 503.
      expect(client.release).toHaveBeenCalledWith();
    });

    it("(d) a rejected connect() rejects with LockUnavailableError before any advisory lock query and never calls fn", async () => {
      mockConnect.mockRejectedValueOnce(new Error("connection refused"));

      const fn = jest.fn();

      await expect(
        withAdvisoryLock({ family: "order-merge", key: "cust-1", mode: "wait" }, fn),
      ).rejects.toMatchObject({ name: "LockUnavailableError" });

      expect(fn).not.toHaveBeenCalled();
    });

    it("(e) try mode: a failed advisory lock resolves { acquired: false }, never calls fn, issues no unlock query, and still releases the client", async () => {
      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [{ ok: false }] }); // pg_try_advisory_lock
      mockConnect.mockResolvedValueOnce(client);

      const fn = jest.fn();

      const result = await withAdvisoryLock(
        { family: "order-merge", key: "cust-1", mode: "try" },
        fn,
      );

      expect(result).toEqual({ acquired: false });
      expect(fn).not.toHaveBeenCalled();

      expect(client.query.mock.calls.length).toBe(2);
      expect(callArgs(client.query, 1)[0]).toBe(
        "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok",
      );
      expect(callArgs(client.query, 1)[1]).toEqual(["order-merge", "cust-1"]);

      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it("(f) waitMs: 500 sets the advisory lock's lock_timeout to '500ms'", async () => {
      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);

      const fn = jest.fn().mockResolvedValue("ok");

      await withAdvisoryLock(
        { family: "order-merge", key: "cust-1", mode: "wait", waitMs: 500 },
        fn,
      );

      expect(callArgs(client.query, 0)).toEqual(["SET lock_timeout = '500ms'"]);
    });

    it("(g) a non-55P03 failure on the advisory lock acquire rejects with that same error — not LockTimeoutError — never calls fn, and releases the client with it", async () => {
      const client = makeClient();
      // 57P01 = admin_shutdown: the lock connection died mid-acquire. Only 55P03 (lock_timeout)
      // may be mapped to LockTimeoutError; anything else must surface as the real fault, or the
      // caller answers a dead connection with a retryable 409 and the operator retries forever.
      const adminShutdown = Object.assign(new Error("boom"), { code: "57P01" });
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockRejectedValueOnce(adminShutdown); // pg_advisory_lock
      mockConnect.mockResolvedValueOnce(client);

      const fn = jest.fn();

      await expect(
        withAdvisoryLock({ family: "order-merge", key: "cust-1", mode: "wait" }, fn),
      ).rejects.toBe(adminShutdown);

      expect(fn).not.toHaveBeenCalled();
      expect(client.query.mock.calls.length).toBe(2); // no unlock for a lock never held
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(adminShutdown);
    });

    it("(i) a failing advisory lock unlock is swallowed — the call still resolves { acquired: true, value } and the client is released with the unlock error", async () => {
      const client = makeClient();
      const unlockErr = new Error("connection reset");
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockRejectedValueOnce(unlockErr); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);

      const fn = jest.fn().mockResolvedValue(7);

      // fn's writes already committed: rethrowing the unlock failure would report a successful
      // merge as a 500. Releasing WITH the error destroys the connection instead, so the server
      // drops the session lock that the unlock statement failed to release.
      await expect(
        withAdvisoryLock({ family: "order-merge", key: "cust-1", mode: "wait" }, fn),
      ).resolves.toEqual({ acquired: true, value: 7 });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(client.query.mock.calls.length).toBe(3);
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(unlockErr);
    });

    it("(h) the lock pool is bounded and safe: max 8, a connection timeout, and a pool-level error listener", async () => {
      // The pool is memoized on first use, so drop it and force a fresh construction here —
      // `beforeEach`'s clearAllMocks has already wiped the call log from whichever case built it.
      await mod._resetLockPoolForTests?.();
      mockPoolCtor.mockClear();
      mockPoolOn.mockClear();

      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);

      await withAdvisoryLock(
        { family: "order-merge", key: "cust-1", mode: "wait" },
        jest.fn().mockResolvedValue("ok"),
      );

      // Every checkout is pinned for the whole critical section: without a connection timeout an
      // overflowing caller queues forever instead of surfacing as LockUnavailableError → 503.
      expect(mockPoolCtor).toHaveBeenCalledTimes(1);
      expect(callArgs(mockPoolCtor, 0)[0]).toMatchObject({
        max: 8,
        connectionTimeoutMillis: 5_000,
      });
      // pg re-emits an idle client's socket error on the pool; with no listener EventEmitter
      // throws it uncaught and takes the API process down.
      expect(mockPoolOn).toHaveBeenCalledWith("error", expect.any(Function));
    });

    // Shared helper for the per-family pool cases: one clean wait-mode acquisition on `family`.
    const acquireOnce = async (family: string) => {
      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);
      return withAdvisoryLock(
        { family, key: "k-1", mode: "wait" },
        jest.fn().mockResolvedValue("ok"),
      );
    };

    it("(p) each family gets its OWN pool, sized for its own peak (order-merge 8, cron 12, billing 4) and kept alive at the socket; a second order-merge acquisition reuses the first", async () => {
      await mod._resetLockPoolForTests?.();
      mockPoolCtor.mockClear();

      await acquireOnce("order-merge");
      await acquireOnce("cron");
      await acquireOnce("billing");
      await acquireOnce("order-merge");

      // A cron WINNER pins its slot for the whole tick (minutes), and up to 7 ticks fire at once
      // on the monthly peak — out of ONE shared pool that left merges a single slot and 503s.
      // Per-family pools bound that peak inside cron's own pool.
      expect(mockPoolCtor).toHaveBeenCalledTimes(3);
      const [poolA, poolB, poolC] = mockPoolCtor.mock.results.map((r) => r.value);
      expect(poolA).not.toBe(poolB);
      expect(poolA).not.toBe(poolC);
      expect(poolB).not.toBe(poolC);
      // The three families are sized differently ON PURPOSE: order-merge checkouts are short and
      // request-path with real checkout volume, cron must fit the monthly 7-holder peak PLUS a
      // straggling hourly sweep (a cron holder that finds no slot skips its tick outright), and
      // billing (enableAddon) is the same short request-path shape as order-merge but a far
      // rarer settings action, so it gets a smaller pool rather than order-merge's size.
      expect(callArgs(mockPoolCtor, 0)[0]).toMatchObject({
        max: 8,
        connectionTimeoutMillis: 5_000,
      });
      expect(callArgs(mockPoolCtor, 1)[0]).toMatchObject({
        max: 12,
        connectionTimeoutMillis: 5_000,
      });
      expect(callArgs(mockPoolCtor, 2)[0]).toMatchObject({
        max: 4,
        connectionTimeoutMillis: 5_000,
      });
      // ALL THREE pools keep TCP keepalive on: a lock connection is socket-idle for the whole
      // critical section (a cron leader's work runs on the Prisma pool), so an idle-reap anywhere
      // on the path would end the session and release the advisory lock MID-TICK — another
      // replica would then win an election for a job still running. Probes every 30 s keep the
      // session honest.
      for (const i of [0, 1, 2]) {
        expect(callArgs(mockPoolCtor, i)[0]).toMatchObject({
          keepAlive: true,
          keepAliveInitialDelayMillis: 30_000,
        });
      }
      // The fourth acquisition built NO fourth pool: pools are memoized per family, so
      // `order-merge` keeps one 8-slot pool rather than one per call site.
      expect(mockPoolOn).toHaveBeenCalledTimes(3);
    });

    it("(p2) tenant-mirror gets its own 4-slot pool, distinct from billing despite the same size", async () => {
      await mod._resetLockPoolForTests?.();
      mockPoolCtor.mockClear();

      await acquireOnce("billing");
      await acquireOnce("tenant-mirror");

      expect(mockPoolCtor).toHaveBeenCalledTimes(2);
      const [billingPool, mirrorPool] = mockPoolCtor.mock.results.map((r) => r.value);
      expect(billingPool).not.toBe(mirrorPool);
      expect(callArgs(mockPoolCtor, 1)[0]).toMatchObject({
        max: 4,
        connectionTimeoutMillis: 5_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 30_000,
      });
    });

    it("(q) an unknown family rejects with TypeError and never takes a connection — the allow-list is closed", async () => {
      // Without this the typo would lazily stand up a THIRD pool: 8 more pinned connections whose
      // holders serialize against nobody, while every caller reads its section as locked.
      const fn = jest.fn();

      await expect(
        withAdvisoryLock({ family: "order-merges", key: "cust-1", mode: "wait" }, fn),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        withAdvisoryLock({ family: "crons", key: "cust-1", mode: "wait" }, fn),
      ).rejects.toThrow(/unknown lock family/);

      expect(mockConnect).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    });

    it("(r) _resetLockPoolForTests ends EVERY family's pool, not just the last one built", async () => {
      await mod._resetLockPoolForTests?.();
      mockPoolCtor.mockClear();
      mockPoolEnd.mockClear();

      await acquireOnce("order-merge");
      await acquireOnce("cron");
      expect(mockPoolCtor).toHaveBeenCalledTimes(2);

      await mod._resetLockPoolForTests?.();

      // A reset that ended only one pool would leave the other's sockets open across suites and,
      // worse, leave a stale pool memoized for the family it forgot.
      expect(mockPoolEnd).toHaveBeenCalledTimes(2);
      mockPoolCtor.mockClear();
      await acquireOnce("order-merge");
      expect(mockPoolCtor).toHaveBeenCalledTimes(1);
    });

    it("(j) a non-Error thrown by fn plus a failing unlock: the call rejects with the original thrown value and the client is still destroyed", async () => {
      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockRejectedValueOnce(new Error("unlock failed")); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);

      const fn = jest.fn().mockRejectedValue("nope");

      await expect(
        withAdvisoryLock({ family: "order-merge", key: "cust-1", mode: "wait" }, fn),
      ).rejects.toBe("nope");

      // A non-Error failure must still take the destroy path — releasing a still-locked session
      // back into the pool would strand the advisory lock — and the ORIGINAL failure wins over
      // the later unlock error.
      expect(client.release).toHaveBeenCalledTimes(1);
      const released = callArgs(client.release, 0)[0];
      expect(released).toBeInstanceOf(Error);
      expect((released as Error).message).toBe("nope");
    });

    it("(k) a non-Error thrown by fn with a successful unlock: the call rejects with the original thrown value and the client is released cleanly", async () => {
      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);

      const fn = jest.fn().mockRejectedValue("nope");

      await expect(
        withAdvisoryLock({ family: "order-merge", key: "cust-1", mode: "wait" }, fn),
      ).rejects.toBe("nope");

      expect(client.query.mock.calls.length).toBe(3);
      expect(client.release).toHaveBeenCalledTimes(1);
      // The non-Error thrown value still surfaces to the caller (asserted above), but it does
      // NOT make the connection suspect: the unlock landed, so the session is clean. Only a
      // FAILED unlock turns a non-Error failure into `release(new Error("nope"))` — case (j).
      expect(client.release).toHaveBeenCalledWith();
    });

    it("(m) fn rejecting AND the unlock failing: the client IS destroyed, and with fn's error — the first failure wins over the later unlock error", async () => {
      const client = makeClient();
      const boom = new Error("boom");
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockRejectedValueOnce(new Error("connection reset")); // pg_advisory_unlock

      mockConnect.mockResolvedValueOnce(client);

      await expect(
        withAdvisoryLock(
          { family: "order-merge", key: "cust-1", mode: "wait" },
          jest.fn().mockRejectedValue(boom),
        ),
      ).rejects.toBe(boom);

      // This is the pair that (b) contrasts with: the unlock never landed, so the session may
      // still hold the advisory lock and the connection must be destroyed rather than returned.
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(boom);
    });

    it("(n) a socket-level error on the pinned client mid-fn records the failure, forces a destroy, and removes the listener it was raised on", async () => {
      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);

      const onSpy = jest.spyOn(client, "on");
      const removeListenerSpy = jest.spyOn(client, "removeListener");
      const socketErr = new Error("socket reset");

      // Simulate the socket dying WHILE the critical section runs — fn itself still resolves
      // (the "error" event and fn's own outcome are independent), but the connection is no
      // longer trustworthy for anything after this.
      const fn = jest.fn().mockImplementation(async () => {
        client.emit("error", socketErr);
        return "ok";
      });

      const result = await withAdvisoryLock(
        { family: "order-merge", key: "cust-1", mode: "wait" },
        fn,
      );

      expect(result).toEqual({ acquired: true, value: "ok" });
      // The listener that fired is the SAME one that was registered — not a coincidentally
      // similar handler — and it is torn down before the client is returned to (or destroyed
      // from) the pool.
      expect(onSpy).toHaveBeenCalledWith("error", expect.any(Function));
      const registeredHandler = onSpy.mock.calls[0][1];
      expect(removeListenerSpy).toHaveBeenCalledWith("error", registeredHandler);
      // Even though `fn` succeeded and the unlock query landed cleanly, the socket error alone
      // is enough to destroy the connection rather than return a possibly-unsound one to the pool.
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release).toHaveBeenCalledWith(socketErr);
    });

    it("(o) a clean run removes the error listener before releasing the client", async () => {
      const client = makeClient();
      client.query
        .mockResolvedValueOnce(undefined) // SET lock_timeout
        .mockResolvedValueOnce({ rows: [] }) // pg_advisory_lock
        .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock
      mockConnect.mockResolvedValueOnce(client);

      const removeListenerSpy = jest.spyOn(client, "removeListener");

      await withAdvisoryLock(
        { family: "order-merge", key: "cust-1", mode: "wait" },
        jest.fn().mockResolvedValue("ok"),
      );

      expect(removeListenerSpy).toHaveBeenCalledWith("error", expect.any(Function));
      expect(client.release).toHaveBeenCalledTimes(1);
      // Order matters: a listener still attached when the connection goes back to the pool would
      // double-fire (once here, once on whatever the pool wires up next) on the next socket error.
      const removeOrder = removeListenerSpy.mock.invocationCallOrder[0];
      const releaseOrder = (client.release as jest.Mock).mock.invocationCallOrder[0];
      expect(removeOrder).toBeLessThan(releaseOrder);
    });

    it("(l) an empty or missing family/key rejects with TypeError before any connection is taken", async () => {
      // `hashtext(NULL)` is NULL, so an undefined key would lock (family, NULL) — a namespace
      // every other miswired caller shares — and `fn` would run believing it was serialized.
      // The check also runs BEFORE `pool.connect()`, so a programming error can never sit on
      // one of the 8 pinned slots for the whole `connectionTimeoutMillis`.
      const fn = jest.fn();

      await expect(
        withAdvisoryLock({ family: "order-merge", key: "", mode: "wait" }, fn),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        withAdvisoryLock({ family: "order-merge", key: undefined as any, mode: "wait" }, fn),
      ).rejects.toThrow("withAdvisoryLock: family and key must be non-empty strings");
      await expect(
        withAdvisoryLock({ family: "", key: "cust-1", mode: "wait" }, fn),
      ).rejects.toBeInstanceOf(TypeError);

      expect(mockConnect).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    });
  });
});
