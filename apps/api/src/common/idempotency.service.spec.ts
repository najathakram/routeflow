/**
 * REG-IDEM-SVC — the shared replay guard, whose semantics were COPIED from
 * RoutesService's three private RF-019 helpers (makeKeyHash /
 * checkIdempotencyKey / saveIdempotencyKey). RoutesService keeps its own
 * copies and still uses them for production driver traffic — it was not
 * refactored onto this service. Any change to the semantics pinned below
 * must be mirrored by hand in RoutesService's copies, or the two guards will
 * silently diverge.
 *
 * These pin the three semantics that make it safe to reuse: the sha256 scoping,
 * the 24h read window, and the FAIL-OPEN catches. A replay guard that throws
 * would 500 a legitimate return, so "the DB is broken" must degrade to "the
 * duplicate lands", never to "the request fails".
 *
 * F5 round 2 (N1, independent review round 2, PR-2, 2026-09-15): `check`/`save`/`acquireLock`
 * now require a transaction client (`tx`) and run each of their own statements inside a
 * SAVEPOINT — a plain JS try/catch around a raw-SQL failure does NOT undo Postgres marking the
 * whole surrounding transaction "aborted"; only `ROLLBACK TO SAVEPOINT` does. `tx` here is a
 * hand-rolled fake exposing just `$queryRaw`/`$executeRaw` as jest mocks — real enough to assert
 * the exact SAVEPOINT/RELEASE/ROLLBACK TO sequence each method issues.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { createHash } from "crypto";
import { IdempotencyService } from "./idempotency.service";

/** Joins a tagged-template raw-SQL mock call's strings segments back into one string (params
 *  become "?"), so a test can assert WHICH statement fired without caring about bind order. */
const sqlText = (call: unknown[]): string => (call[0] as unknown as string[]).join("?");

describe("IdempotencyService (REG-IDEM-SVC)", () => {
  let service: IdempotencyService;
  let tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock };

  beforeEach(async () => {
    // F5 round 2 (N1): IdempotencyService takes no constructor dependencies at all any more —
    // check/save/acquireLock run entirely on the CALLER-supplied `tx`, never on a Prisma client
    // of its own.
    const mod: TestingModule = await Test.createTestingModule({
      providers: [IdempotencyService],
    }).compile();
    service = mod.get(IdempotencyService);
    tx = {
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn().mockResolvedValue(undefined),
    };
  });

  it("REG-IDEM-SVC-1 hashes sha256 of `${scope}:${key}` and separates scopes", () => {
    const expected = createHash("sha256").update("scope-a:key-1").digest("hex");
    expect(service.keyHash("key-1", "scope-a")).toBe(expected);
    // Same key, different scope — must NOT collide (this is what keeps two
    // callers, and two tenants, from reading each other's stored responses).
    expect(service.keyHash("key-1", "scope-b")).not.toBe(expected);
  });

  it("REG-IDEM-SVC-2 check() returns the parsed stored response, wrapped in a SAVEPOINT released on success", async () => {
    tx.$queryRaw.mockResolvedValue([{ response: JSON.stringify({ id: "ret-1", qty: 3 }) }]);

    await expect(service.check("key-1", "tenant-a", "scope-a", tx)).resolves.toEqual({
      id: "ret-1",
      qty: 3,
    });
    expect(sqlText(tx.$executeRaw.mock.calls[0])).toBe("SAVEPOINT idempotency_check");
    expect(sqlText(tx.$executeRaw.mock.calls.at(-1)!)).toBe("RELEASE SAVEPOINT idempotency_check");
  });

  it("REG-IDEM-SVC-3 check() reads with a 24h cutoff and returns null for no row", async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await expect(service.check("key-1", "tenant-a", "scope-a", tx)).resolves.toBeNull();

    // The cutoff parameter is interpolated into the tagged template; assert it
    // is ~24h ago so shortening/removing the window fails here.
    const params = tx.$queryRaw.mock.calls.at(-1)!.slice(1);
    const cutoff = params.find((p: unknown) => p instanceof Date) as Date;
    expect(cutoff).toBeInstanceOf(Date);
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("REG-IDEM-SVC-4 check() FAILS OPEN — returns null, never throws, and rolls back to ITS OWN savepoint (not the whole transaction) when the read rejects", async () => {
    tx.$queryRaw.mockRejectedValue(new Error('relation "IdempotencyKey" does not exist'));

    await expect(service.check("key-1", "tenant-a", "scope-a", tx)).resolves.toBeNull();

    expect(sqlText(tx.$executeRaw.mock.calls[0])).toBe("SAVEPOINT idempotency_check");
    expect(sqlText(tx.$executeRaw.mock.calls.at(-1)!)).toBe(
      "ROLLBACK TO SAVEPOINT idempotency_check",
    );
    // Never a plain ROLLBACK — that would abort the CALLER's whole transaction, which is exactly
    // what a fail-open guard must never do to the return it is protecting.
    expect(tx.$executeRaw.mock.calls.some((c) => sqlText(c) === "ROLLBACK")).toBe(false);
  });

  it("REG-IDEM-SVC-4b check() still resolves null even when the rollback-to-savepoint ITSELF fails — never throws out of check()", async () => {
    tx.$queryRaw.mockRejectedValue(new Error("read failed"));
    tx.$executeRaw.mockImplementation((strings: TemplateStringsArray) =>
      (strings[0] ?? "").includes("ROLLBACK TO SAVEPOINT")
        ? Promise.reject(new Error("rollback failed too"))
        : Promise.resolve(undefined),
    );

    await expect(service.check("key-1", "tenant-a", "scope-a", tx)).resolves.toBeNull();
  });

  it("REG-IDEM-SVC-5 save() upserts on keyHash and stores the JSON response, wrapped in a SAVEPOINT released on success", async () => {
    await service.save("key-1", "tenant-a", "scope-a", { id: "ret-1" }, tx);

    const insertCall = tx.$executeRaw.mock.calls.find((c: unknown[]) =>
      sqlText(c).includes('INSERT INTO "IdempotencyKey"'),
    )!;
    expect(insertCall).toBeDefined();
    const sql = sqlText(insertCall);
    expect(sql).toContain('INSERT INTO "IdempotencyKey"');
    expect(sql).toContain('ON CONFLICT ("keyHash") DO UPDATE');
    expect(insertCall.slice(1)).toContain(JSON.stringify({ id: "ret-1" }));
    expect(insertCall.slice(1)).toContain(service.hashFor("key-1", "tenant-a", "scope-a"));
    expect(sqlText(tx.$executeRaw.mock.calls[0])).toBe("SAVEPOINT idempotency_save");
    expect(sqlText(tx.$executeRaw.mock.calls.at(-1)!)).toBe("RELEASE SAVEPOINT idempotency_save");
  });

  it("REG-IDEM-SVC-6 save() FAILS OPEN — swallows a rejecting write and rolls back to ITS OWN savepoint", async () => {
    tx.$executeRaw.mockImplementation((strings: TemplateStringsArray) => {
      const s = strings[0] ?? "";
      if (s.includes("INSERT INTO")) return Promise.reject(new Error("boom"));
      return Promise.resolve(undefined);
    });

    await expect(
      service.save("key-1", "tenant-a", "scope-a", { id: "ret-1" }, tx),
    ).resolves.toBeUndefined();
    expect(sqlText(tx.$executeRaw.mock.calls.at(-1)!)).toBe(
      "ROLLBACK TO SAVEPOINT idempotency_save",
    );
  });

  it("REG-IDEM-SVC-7 F6: tenantId is required and folded into the hash — the same key+scopeSuffix under two different tenants never collides", () => {
    // Before F6, `check`/`save` took a pre-built scope string a caller could
    // assemble without ever mentioning tenantId — "every caller must
    // remember" was a hope, not a guarantee. tenantId is now a required
    // positional argument, so a caller cannot even COMPILE a scope that
    // omits it.
    const hashA = service.hashFor("key-1", "tenant-a", "returns.create:user-1:ord-1");
    const hashB = service.hashFor("key-1", "tenant-b", "returns.create:user-1:ord-1");
    expect(hashA).not.toBe(hashB);
    // null (no tenant context) is its own distinct bucket, not a silent
    // collision with any real tenantId string.
    const hashNull = service.hashFor("key-1", null, "returns.create:user-1:ord-1");
    expect(hashNull).not.toBe(hashA);
    expect(hashNull).not.toBe(hashB);
    // hashFor is exactly the hash check()/save() use internally — the F5 lock
    // key (returns.service.ts) can never drift from the row it protects.
    expect(hashA).toBe(service.keyHash("key-1", "tenant-a:returns.create:user-1:ord-1"));
  });

  it("REG-IDEM-SVC-8 F5 round 2 (N1): acquireLock takes a transaction-scoped pg_advisory_xact_lock on the given hash", async () => {
    const hash = service.hashFor("key-1", "tenant-a", "scope-a");

    await service.acquireLock(hash, tx);

    const lockCall = tx.$executeRaw.mock.calls.find((c: unknown[]) =>
      sqlText(c).includes("pg_advisory_xact_lock"),
    )!;
    expect(lockCall).toBeDefined();
    expect(lockCall.slice(1)).toContain(hash);
    // A distinct namespace, not `hashtext(hash)` alone — keeps this xact-scoped lock in its own
    // slice of Postgres's shared advisory-lock keyspace.
    expect(lockCall.slice(1)).toContain("idempotency");
  });

  it("REG-IDEM-SVC-9 F5 round 3 (independent review round 3): acquireLock FAILS CLOSED — a lock error propagates unchanged, no SAVEPOINT, no swallow", async () => {
    // Deliberately the ONE method in this class that does NOT fail open: proceeding unlocked
    // after a failed acquire would silently defeat the whole reason F5 exists (closing the
    // check-then-act race). check()/save() can safely fail open because the cumulative
    // over-return guard backstops THEM; nothing backstops a lost lock the same way.
    const boom = new Error("lock failed");
    tx.$executeRaw.mockImplementation((strings: TemplateStringsArray) => {
      const s = strings[0] ?? "";
      if (s.includes("pg_advisory_xact_lock")) return Promise.reject(boom);
      return Promise.resolve(undefined);
    });

    await expect(service.acquireLock("some-hash", tx)).rejects.toBe(boom);
    // No SAVEPOINT dance at all for this method — a bare, unwrapped statement.
    expect(tx.$executeRaw.mock.calls.some((c) => sqlText(c).startsWith("SAVEPOINT"))).toBe(false);
    expect(
      tx.$executeRaw.mock.calls.some((c) => sqlText(c).startsWith("ROLLBACK TO SAVEPOINT")),
    ).toBe(false);
  });
});
