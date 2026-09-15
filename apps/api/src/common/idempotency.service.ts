import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "crypto";

/**
 * Shared replay guard over the global `IdempotencyKey` table (platform.prisma).
 *
 * COPIED from the three private RF-019 helpers on `RoutesService`
 * (makeKeyHash / checkIdempotencyKey / saveIdempotencyKey) — same
 * sha256(`${scope}:${key}`) hashing, same 24h read window, same ON CONFLICT
 * upsert, same FAIL-OPEN catches. This is NOT a lift-and-delete: RoutesService
 * still owns its own three private copies and still uses them for production
 * driver traffic (route dispatch/completion). There are now TWO
 * implementations to reason about, not one. Any change to the hashing, the
 * window, the upsert, or the fail-open behaviour here must be mirrored by
 * hand in `RoutesService`'s copies (RF-019) — RouteFlow's server-side scope
 * fence (RULINGS R7) keeps `RoutesService` out of this diff, so consolidating
 * the two is left for a future pass, not done here.
 *
 * FAIL-OPEN IS DELIBERATE, not an oversight: a replay guard must never 500 a
 * legitimate request. A DB error inside `check` returns null (so the request
 * proceeds and a duplicate can land) and a failing `save` is swallowed. Every
 * caller therefore keeps its own domain-level backstop — for returns that is
 * the cumulative over-return guard plus PENDING status, which means no money
 * moves without an operator approving it.
 *
 * Raw SQL (rather than the Prisma delegate) is also inherited verbatim: it is
 * what lets the guard degrade quietly on an environment where the table has
 * not been provisioned yet.
 *
 * SCOPING (F6, independent review round 1, PR-2): `keyHash` is GLOBALLY unique and these
 * queries run on the un-scoped client, so a caller that built its own scope string could always
 * forget the tenantId — "every caller must remember" is not a guarantee, it is a hope.
 * `check`/`save` take `tenantId` as a REQUIRED positional argument and build the final scope
 * internally (`${tenantId ?? "none"}:${scopeSuffix}`), so a caller cannot construct a scope that
 * omits it — the type system enforces the half of "SCOPING WARNING" that used to be a comment.
 * `keyHash` itself is unchanged (a pure hash of whatever scope string it is given) so
 * RoutesService's own three private RF-019 copies — which build their OWN scope strings by hand
 * and are explicitly OUT of this fix (see below) — are untouched.
 *
 * TRANSACTIONAL + SAVEPOINT-GUARDED (F5 round 2 / N1, independent review round 2, PR-2):
 * `check`/`save` now REQUIRE a transaction client (`tx`) and run entirely on ITS connection,
 * inside their own `SAVEPOINT`. Two things forced this:
 *
 * 1. ATOMICITY: round 1 called `save()` on a SEPARATE connection, after the caller's own
 *    transaction had already committed. That left a real (if narrow) gap — a crash between
 *    commit and `save()` landed a return with no idempotency record at all. Running `save()`
 *    INSIDE the same transaction as the row it caches means the row and its cache entry commit
 *    or roll back TOGETHER, by construction.
 * 2. THE SAVEPOINT IS NOT OPTIONAL: naively running `check`/`save` inside the caller's
 *    transaction WITHOUT one would have made fail-open a LIE. Postgres aborts an ENTIRE
 *    transaction on the first statement error — catching that error in JavaScript does not
 *    un-abort it, so the very next statement (the caller's own `FOR UPDATE`, or the row insert)
 *    would fail too, with a confusing "current transaction is aborted" error. A missing
 *    `IdempotencyKey` table would then take the WHOLE return down with it — exactly the
 *    500-on-a-missing-table outcome fail-open exists to prevent. Each method opens its own
 *    `SAVEPOINT`, and on any failure issues `ROLLBACK TO SAVEPOINT` (never plain `ROLLBACK`) —
 *    that undoes only this method's own statements and returns the surrounding transaction to a
 *    clean, continuable state. If even the rollback-to-savepoint itself fails, the transaction is
 *    genuinely unrecoverable and the caller's NEXT statement will surface that on its own; there
 *    is nothing further this guard can do about it, and pretending otherwise would swallow a
 *    real error.
 *
 * `acquireLock` (F5 round 2 / N1) is the same story for the replay guard's LOCK: a
 * TRANSACTION-scoped `pg_advisory_xact_lock` on the caller's own connection, auto-released at
 * that transaction's commit/rollback — no separate connection, no pool to size or exhaust,
 * and (via the same savepoint discipline) no new way for the lock itself to fail the return it
 * is protecting. This replaces round 1's dedicated `"idempotency"` advisory-lock family in
 * `common/db-locks.ts` (a session-level lock on its own pinned pool) — the independent review
 * judged that pool an unjustified extra failure surface for what a transaction-scoped lock on
 * the connection the caller already holds gives for free.
 *
 * RoutesService's existing scopes are left exactly as they are — retrofitting a tenantId into
 * them would silently invalidate in-flight driver keys, and RULINGS R7 keeps RoutesService out
 * of this diff.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  /** Namespace for the `hashtext()` pair `acquireLock` locks on — keeps this xact-scoped lock
   *  in its own slice of Postgres's shared advisory-lock keyspace, distinct from any
   *  session-level family in `common/db-locks.ts` (LOCK_FAMILIES no longer lists this at all —
   *  round 2 retired the dedicated pool, but the two lock FUNCTIONS still share one keyspace). */
  private static readonly LOCK_NAMESPACE = "idempotency";

  /** sha256 of `${scope}:${key}` — the row's globally unique `keyHash`. */
  keyHash(key: string, scope: string): string {
    return createHash("sha256").update(`${scope}:${key}`).digest("hex");
  }

  /** Builds the tenant-qualified scope every `check`/`save` call is keyed on — the one place
   *  that string is assembled, so it can never be built without a tenantId. */
  private scopeFor(tenantId: string | null, scopeSuffix: string): string {
    return `${tenantId ?? "none"}:${scopeSuffix}`;
  }

  /** The EXACT `keyHash` a `check`/`save` call for these arguments will use — public so a caller
   *  that needs to serialize its own check-then-act sequence (`acquireLock`, below) can never
   *  compute a lock key that drifts from the row it is actually protecting. */
  hashFor(key: string, tenantId: string | null, scopeSuffix: string): string {
    return this.keyHash(key, this.scopeFor(tenantId, scopeSuffix));
  }

  /**
   * Acquire a TRANSACTION-scoped advisory lock (`pg_advisory_xact_lock`) on `hash` (from
   * `hashFor`), on `tx`'s own connection — released automatically at `tx`'s commit or rollback,
   * no explicit unlock. FAIL-OPEN, savepoint-guarded (see class docstring): a failure to acquire
   * degrades to "proceed without the lock" rather than failing the caller's transaction. Callers
   * still see check-then-act protection in the overwhelmingly common case; what they never see is
   * a 500 caused BY the lock itself.
   */
  async acquireLock(hash: string, tx: any): Promise<void> {
    try {
      await tx.$executeRaw`SAVEPOINT idempotency_lock`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${IdempotencyService.LOCK_NAMESPACE}), hashtext(${hash}))`;
      await tx.$executeRaw`RELEASE SAVEPOINT idempotency_lock`;
    } catch (e) {
      this.logger.warn(
        `idempotency lock acquisition degraded (fail-open, proceeding unlocked): ${(e as Error)?.message ?? e}`,
      );
      try {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT idempotency_lock`;
      } catch {
        // Transaction is genuinely unrecoverable — the caller's next statement surfaces that.
      }
    }
  }

  /** The stored response for this key, scoped to tenant+scopeSuffix, inside the 24h window,
   *  else null. Runs on `tx`'s connection, inside its own SAVEPOINT (see class docstring). */
  async check<T = unknown>(
    key: string,
    tenantId: string | null,
    scopeSuffix: string,
    tx: any,
  ): Promise<T | null> {
    const hash = this.keyHash(key, this.scopeFor(tenantId, scopeSuffix));
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    try {
      await tx.$executeRaw`SAVEPOINT idempotency_check`;
      const rows = await tx.$queryRaw<{ response: string }[]>`
        SELECT response FROM "IdempotencyKey"
        WHERE "keyHash" = ${hash} AND "createdAt" >= ${cutoff}
        LIMIT 1
      `;
      await tx.$executeRaw`RELEASE SAVEPOINT idempotency_check`;
      if (!rows || rows.length === 0) return null;
      return JSON.parse(rows[0].response) as T;
    } catch (e) {
      this.logger.warn(`idempotency check degraded (fail-open): ${(e as Error)?.message ?? e}`);
      try {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT idempotency_check`;
      } catch {
        // Transaction is genuinely unrecoverable — the caller's next statement surfaces that.
      }
      return null; // table doesn't exist yet, or any other read failure — degrade gracefully
    }
  }

  /** Best-effort store of this request's response under key, scoped to tenant+scopeSuffix. Runs
   *  on `tx`'s connection, inside its own SAVEPOINT (see class docstring) — committing or rolling
   *  back atomically with whatever else `tx` does. */
  async save(
    key: string,
    tenantId: string | null,
    scopeSuffix: string,
    response: unknown,
    tx: any,
  ): Promise<void> {
    const hash = this.keyHash(key, this.scopeFor(tenantId, scopeSuffix));
    try {
      await tx.$executeRaw`SAVEPOINT idempotency_save`;
      const responseJson = JSON.stringify(response);
      await tx.$executeRaw`
        INSERT INTO "IdempotencyKey" ("id", "keyHash", "response", "createdAt")
        VALUES (gen_random_uuid(), ${hash}, ${responseJson}, now())
        ON CONFLICT ("keyHash") DO UPDATE
          SET response   = EXCLUDED.response,
              "createdAt" = now()
      `;
      await tx.$executeRaw`RELEASE SAVEPOINT idempotency_save`;
    } catch (e) {
      this.logger.warn(`idempotency save degraded (fail-open): ${(e as Error)?.message ?? e}`);
      try {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT idempotency_save`;
      } catch {
        // Transaction is genuinely unrecoverable — the caller's next statement surfaces that.
      }
    }
  }
}
