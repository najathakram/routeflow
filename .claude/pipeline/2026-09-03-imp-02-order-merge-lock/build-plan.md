# Build plan — PR-2 · Cross-replica-safe order merges (customer advisory lock)

Status: APPROVED · scale: major · ui: false · branch `fix/imp-02-order-merge-advisory-lock`
Discovery `./discovery.md` · Spec `./spec.md` · Test plan `./test-plan.md` · Lessons
`.claude/lessons/LESSONS.md` (carry L-021, L-027, L-034, L-039, L-041).

Repo: RouteFlow monorepo; API = NestJS 11 + Prisma 7.10 over `@prisma/adapter-pg` + `pg`
(`apps/api/src/prisma/prisma.service.ts:10-12` builds a private `Pool` from `process.env.DATABASE_URL`).
Jest config under `"jest"` in `apps/api/package.json` (`rootDir: src`, `testRegex .*\.spec\.ts$`,
`*.db.spec.ts` excluded — run those with `npm run test:db -w apps/api` from PR-1). Prettier: `npx prettier --write`.
Test tenants only. **Rules:** targeted edits only; a gap in this plan is a finding, never a guess;
never touch files outside your package; never touch `apps/api/prisma/**` or other worktrees; the
money math and every Prisma call in the merge paths stay byte-identical (R4).

## Test packages (Sonnet 5 @ medium; the money/lock ones `high`)

| id              | effort | files                                               | brief                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tp-db-locks`   | high   | `apps/api/src/common/db-locks.spec.ts`              | T1 (a)–(f) with `jest.mock("pg")`; guarded require of `./db-locks`; assert query SQL strings + parameter arrays in order via `client.query.mock.calls`.                                                                                                                                                                                                                                 |
| `tp-controller` | high   | `apps/api/src/orders/orders.scan-hardening.spec.ts` | Add the four NEW `it` blocks of T2 inside the existing describe at `:593` (do not alter the existing test's assertions; retitle it per R5 only in the implementation package, not here). Mock `../common/db-locks` with the in-memory per-key serializer described in the test plan; export fake `LockTimeoutError`/`LockUnavailableError` classes from the mock with matching `name`s. |
| `tp-service`    | high   | `apps/api/src/orders/orders.merge-lock.spec.ts`     | T3 (a)(b)(c). Read `orders.service.ts:814-835` and `:1135-1150` first to mock exactly what the pre-transaction reads touch; build the service through `Test.createTestingModule` with every other dependency mocked at the module boundary (house convention).                                                                                                                          |
| `tp-db-lane`    | medium | `apps/api/src/common/db-locks.db.spec.ts`           | T4 (a)–(d) using `describeDb`/`requireLocalDatabaseUrl` from `../common/testing/db-spec`; timings with `Date.now()`; `afterAll` resets the pool.                                                                                                                                                                                                                                        |

## Red gate

```
cd apps/api && npx jest src/common/db-locks.spec.ts src/orders/orders.merge-lock.spec.ts -t "advisory|MERGE_IN_PROGRESS|mergeLocksByOrder|LockUnavailable"
cd apps/api && npx jest src/orders/orders.scan-hardening.spec.ts -t "advisory lock|MERGE_IN_PROGRESS|no in-process|LockUnavailable"
```

expect: **fail** (the retitled legacy test is excluded by `-t`; every selected test fails on its
own oracle). T4 is proven at close-out on the lane, not in the red gate (needs Postgres).

## Implementation packages

| id                 | model @ effort           | files                                                                                                                                                                                                               | dependsOn   | satisfies                 | provenBy         |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------- | ---------------- |
| `p1-db-locks`      | claude-opus-5 @ high     | `apps/api/src/common/db-locks.ts`                                                                                                                                                                                   | —           | R1                        | T1, T4           |
| `p2-controller`    | claude-opus-5 @ high     | `apps/api/src/orders/orders.controller.ts`, `apps/api/src/orders/orders.scan-hardening.spec.ts` (retitle + scope comment only)                                                                                      | p1-db-locks | R2, R5                    | T2               |
| `p3-service`       | claude-opus-5 @ high     | `apps/api/src/orders/orders.service.ts`                                                                                                                                                                             | p1-db-locks | R3, R4                    | T3               |
| `p4-config-docs`   | claude-sonnet-5 @ low    | `apps/api/railway.toml`, `docs/IMPROVEMENTS.md`, `CLAUDE.md`, `.claude/code-map/api.md`, `.claude/code-map/_meta.json`, `.claude/lessons/LESSONS.md`, `.claude/lessons/_meta.json`                                  | p1, p2, p3  | R6, R7                    | validate-lessons |
| `p5-pr1-followups` | claude-sonnet-5 @ medium | `apps/api/src/common/prod-migrate-script.spec.ts`, `apps/api/src/common/local-env-script.spec.ts`, `apps/api/src/common/railway-db-url.spec.ts` (new), `apps/api/src/common/local-scripts-forwarding.spec.ts` (new) | —           | (PR-1 review carry-overs) | own specs        |

### p5 — PR-1 review carry-overs (test-only; no production file changes)

- `prod-migrate-script.spec.ts`: the third case lets the real Prisma child exhaust connect
  retries against `127.0.0.1:1` (~40 s). Stub the drift child the same way T3(h) stubs the CLI
  (`SCHEMA_DRIFT_PRISMA_CLI` + `JEST_WORKER_ID`) so the case proves the post-deploy branch's exit
  mapping in < 5 s; keep one assertion that the real path is used when the stub is unset.
- `local-env-script.spec.ts`: the seven spawns take ~20 s each because each runs `node -e` under
  `shell:true` through npm-less cmd; keep the contract but run the shim once per case with a
  trivial child (`node -e "process.exit(0)"`), target ≤ 3 s per case.
- `railway-db-url.spec.ts` (new, direct unit): `resolveDatabaseUrl` — proxy vars win over
  `DATABASE_URL`; `requireProxy: true` throws on any missing var and never falls back; partial vars
  without `requireProxy` fall back to `DATABASE_URL`; `redactUrl` on an unparseable string returns
  `<unparseable url>`; `scrubSecrets` with an empty password returns the input unchanged; the URL
  for `POSTGRES_USER=u POSTGRES_PASSWORD="p w" POSTGRES_DB=d DOMAIN=h PORT=5` is exactly
  `postgresql://u:p%20w@h:5/d` (username unencoded, password encoded — byte-identical to the
  pre-PR-1 `prod-migrate.mjs` construction).
- `local-scripts-forwarding.spec.ts` (new): reads root `package.json`, asserts `local:drift`
  contains `-- --local`, `local:test:db` contains `--db --db-specs`, `local:validate` ends with
  `npm run local:drift`, and every `local:*` script that sets env goes through
  `scripts/local-env.mjs` (no `VAR=` prefix, no `sh -c`).

### p1 — `db-locks.ts` (exact code; Opus verifies against `pg` typings)

```ts
import { Pool, type PoolClient } from "pg";

export type LockMode = "wait" | "try";
export interface AdvisoryLockOptions {
  family: string;
  key: string;
  mode: LockMode;
  waitMs?: number;
}
export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export class LockTimeoutError extends Error {
  constructor(
    public readonly family: string,
    public readonly key: string,
    public readonly waitMs: number,
  ) {
    super(`advisory lock ${family}:${key} not acquired within ${waitMs}ms`);
    this.name = "LockTimeoutError";
  }
}
export class LockUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super("advisory lock connection unavailable");
    this.name = "LockUnavailableError";
  }
}

let pool: Pool | null = null;
function lockPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  return pool;
}
/** Test hook: drop the lazily-created pool so a suite can start clean. */
export async function _resetLockPoolForTests(): Promise<void> {
  const p = pool;
  pool = null;
  if (p) await p.end();
}

const LOCK_SQL = {
  wait: "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
  try: "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS ok",
} as const;
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))";

/**
 * Cross-process critical section on Postgres advisory locks, held on a DEDICATED pinned
 * connection (the Prisma pool is private and cannot pin). `wait` blocks up to waitMs (SQLSTATE
 * 55P03 → LockTimeoutError); `try` returns { acquired:false } instead of waiting. fn never runs
 * without the lock. Keys are (hashtext(family), hashtext(key)) so families cannot collide.
 */
export async function withAdvisoryLock<T>(
  opts: AdvisoryLockOptions,
  fn: () => Promise<T>,
): Promise<LockResult<T>> {
  const waitMs = Number.isFinite(opts.waitMs)
    ? Math.max(1, Math.floor(opts.waitMs as number))
    : 20_000;
  let client: PoolClient;
  try {
    client = await lockPool().connect();
  } catch (e) {
    throw new LockUnavailableError(e);
  }
  const args = [opts.family, opts.key];
  let failure: unknown;
  try {
    try {
      await client.query(`SET lock_timeout = '${waitMs}ms'`);
    } catch (e) {
      failure = e;
      throw new LockUnavailableError(e);
    }
    let acquired = true;
    try {
      const res = await client.query(LOCK_SQL[opts.mode], args);
      if (opts.mode === "try") acquired = res.rows[0]?.ok === true;
    } catch (e: any) {
      failure = e;
      if (e?.code === "55P03") throw new LockTimeoutError(opts.family, opts.key, waitMs);
      throw e;
    }
    if (!acquired) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      try {
        await client.query(UNLOCK_SQL, args);
      } catch (e) {
        failure = failure ?? e;
      }
    }
  } finally {
    // release(err) destroys the connection: the server drops any session lock with it.
    client.release(failure instanceof Error ? failure : undefined);
  }
}
```

Opus: confirm `SET lock_timeout` cannot take a bind parameter (it cannot — the interpolated value
is an integer we validated); confirm `client.release(err)` semantics in the installed `pg` version;
keep the try-mode path from issuing `UNLOCK` when not acquired (the code above returns before the
inner try — verify by reading).

### p2 — controller (Opus, HIGH risk: money path)

- Delete `mergeLocksByOrder` (`:45-48`) and `withOrderMergeLock` (`:50-109`). Replace the doc
  comment with 6 lines: cross-replica safety now comes from `withAdvisoryLock` in
  `common/db-locks.ts` (customer key, dedicated connection); do not reintroduce an in-process lock.
- In `create()`, replace `const merged = await this.withOrderMergeLock(activeOrder.id, async () => { … })`
  with:
  ```ts
  let lock: LockResult<{ orderId: string; replayed: boolean }>;
  try {
    lock = await withAdvisoryLock(
      { family: "order-merge", key: dto.customerId, mode: "wait", waitMs: 20_000 },
      async () => {
        /* the existing body, byte-identical */
      },
    );
  } catch (e) {
    if (e instanceof LockTimeoutError)
      throw new ConflictException({
        code: "MERGE_IN_PROGRESS",
        message: "Another merge for this customer is in progress — retry.",
      });
    if (e instanceof LockUnavailableError)
      throw new ServiceUnavailableException("Merge lock unavailable");
    throw e;
  }
  if (!lock.acquired) throw new ServiceUnavailableException("Merge lock unavailable"); // unreachable in wait mode
  const merged = lock.value;
  ```
  Import `ServiceUnavailableException` from `@nestjs/common`; import the helper + error classes.
- The sweep at `:237-240` and everything after stay exactly where they are.
- `orders.scan-hardening.spec.ts`: retitle the `it` at `:709` per R5 and rewrite its scope comment
  (`:769-781`) — nothing else in the spec file.

### p3 — service (Opus, HIGH risk)

- `mergeAllPendingForCustomer` (`:814`): rename the current body into an inner arrow inside
  `withAdvisoryLock({ family: "order-merge", key: customerId, mode: "wait", waitMs: 20_000 }, async () => { …existing body… })`,
  return `result.value`; wrap with the same `try/catch` mapping as the controller
  (`ConflictException` `MERGE_IN_PROGRESS` / `ServiceUnavailableException`). Indentation change
  only inside the body; **no token of the body changes** — verify with `git diff -w`.
- `forceConsolidateCustomer` (`:1135` region): identical treatment with its customer id.
- Nothing else in the file.

### p4 — config + docs + lesson (Sonnet @ low)

Exactly R6 and R7. Lesson **L-054** (L-053 was taken by PR-1's cross-platform lesson) from
`spec.md`, ≤ 1,000 bytes, category `domain`. Also: in
`.claude/pipeline/2026-09-03-imp-03a-ddl-drift-gate/spec.md` the R1 row's regex pipes were
interpreted as table separators by Prettier at ship time — escape them as `\|` (and the same in
any other artifact table where a `|` sits inside backticks) so the committed record renders;
`docs/IMPROVEMENTS.md` row 3: `shipped (PR-1)` → `shipped #<PR-1 number>`.

## Verification commands

- `perRound`: `npx tsc -p apps/api/tsconfig.build.json --noEmit` · `npm run lint -w apps/api`
- `final`: `npm run verify`

## Mutation probe — see `test-plan.md` (three targets; all HIGH-risk files).

## Deviation policy

A `mergeAllPendingForCustomer` or `forceConsolidateCustomer` shape that differs from the extract
(`:814-1133`, `:1135`), a `pg` API that does not match `release(err)`, or any need to touch
`updateOrderItems` → stop and report as a finding with file:line.
