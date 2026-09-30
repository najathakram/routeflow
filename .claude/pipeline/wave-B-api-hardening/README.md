# Wave B — API hardening (one PR)

Scope note (owner, 2026-09-03): 2b cron lock is EXCLUDED from this branch — it depends on PR-2
and ships as its own small PR after PR-2 lands; this branch = 3B + 9/P4-a + P4-b/c.

Branch `feat/imp-wave-b-api-hardening` from `master` **after PR-2 (#TBD, advisory lock) lands**
(hard dependency: `apps/api/src/common/db-locks.ts`). Worktree `rf-imp-03` re-pointed
(`git -C rf-imp-03 checkout -B feat/imp-wave-b-api-hardening origin/master` after the merge).
Commit type `feat:`; subject ≤ 72 chars: `feat(api,ci): cron leader lock, migration lint, verify audit, tenancy pins (wave B)` → too long;
use `feat(api,ci): wave B — cron leader lock, migration lint, verify audit` (70). Loop: dev-pipeline
`major` on `pipeline-v3-c8.js`.

## Items (the per-item briefs are the specs; read all four first)

| Item                                                     | Brief                                                                             | Risk                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------- |
| 2b cron leader lock (`@LeaderCron`)                      | `../2026-09-03-imp-02b-cron-leader-lock/{discovery,spec,test-plan,build-plan}.md` | HIGH (money crons)  |
| 3B destructive-migration lint (Squawk)                   | `2026-09-03-imp-03b-migration-lint-squawk/brief.md`                               | MED (CI, lockfile)  |
| 9 + P4-a bypass audit, `--continue`, API health SHA gate | `2026-09-03-imp-09-verify-bypass-audit-health-sha/brief.md`                       | MED (hook, CI gate) |
| P4-b/c guard-order + `findUnique` pins                   | `2026-09-03-imp-p4-guard-order-findunique-pins/brief.md`                          | LOW (test-only)     |

## Added scope (from Wave D's findings, 2026-09-03)

- **`pB10` login-throttle knob (Sonnet medium, small):** `/auth/login` is throttled 10 requests / 5 min per IP
  (`@Throttle`, RF-160). Against the local Docker stack every Playwright login, retry and other
  local session shares 127.0.0.1, so the local E2E lane exhausts it and fails with a literal
  "Invalid username or password". Make the limit/TTL env-configurable — `AUTH_LOGIN_THROTTLE_LIMIT`
  / `AUTH_LOGIN_THROTTLE_TTL_MS` read once at module init with the **production defaults unchanged
  (10 / 300000)** — and set a generous local value in `docker-compose.yml`'s `api` environment
  (e.g. 1000 / 60000, throwaway, localhost-only). Spec: the decorator value is the env value when
  set and the default when not; `security-findings-index.md`/RF-160 note updated ("prod default
  unchanged; local override documented"). Files: the auth controller/guard that carries the
  decorator, `docker-compose.yml`, `apps/api/.env.example` (names only), one spec, docs line.

## Shared prefix for every agent

RouteFlow monorepo; API NestJS 11 + Prisma 7.10; `*.db.spec.ts` lane (`npm run local:test:db`, compose
Postgres) exists; `withAdvisoryLock` exists in `apps/api/src/common/db-locks.ts` (PR-2). Test tenants only.
Targeted edits; a gap in a brief is a finding. Never touch other worktrees or `apps/api/prisma/**`
(the `schema.prisma` comment exception does not apply here).

## Combined package layout (disjoint file ownership)

Test packages (Sonnet; `high` where money/auth):

- `tpB1` cron-lock specs (`cron-lock.spec.ts`, `no-bare-cron.spec.ts`, `cron-lock.db.spec.ts`)
- `tpB2` lint-migrations spec (`lint-migrations-script.spec.ts`)
- `tpB3` skip-verify-audit spec + `app.service.spec.ts`
- `tpB4` `guard-chain.security.spec.ts`, `app.module.guards.spec.ts` (regression pin — out of red gate), `tenant-findunique.db.spec.ts`

Red gate: `cd apps/api && npx jest src/common/cron-lock.spec.ts src/common/no-bare-cron.spec.ts src/common/lint-migrations-script.spec.ts src/common/skip-verify-audit-script.spec.ts src/app.service.spec.ts src/auth/guards/guard-chain.security.spec.ts` — expect fail.

Implementation packages:

- `pB1` `common/cron-lock.ts` (Opus high) → `pB2` 13 decorator sites (Sonnet low) + `pB3` 5 spec mocks (Sonnet low)
- `pB4` `.squawk.toml`, `scripts/lint-migrations.mjs`, root `package.json` devDep (Sonnet medium) — **owns root `package.json` and `package-lock.json`** (one real `npm install`, lock-edge `missing 0`)
- `pB5` `scripts/skip-verify-audit.mjs`, `.husky/pre-push` (Sonnet medium) — note: `verify` script `--continue` edit goes through `pB4` (same file owner); `pB5` hands it the exact token
- `pB6` `apps/api/src/app.service.ts` + `scripts/post-deploy-check.mjs` one line (Sonnet medium)
- `pB7` `.github/workflows/ci.yml` (readiness-gate API check + header/`--continue` comments) and `.github/workflows/db-migrations.yml` (Squawk step + paths) (Opus high — CI is the authority; YAML validity)
- `pB8` `app.module.ts` guard-order comment (Sonnet low)
- `pB9` docs/bookkeeping: `apps/api/railway.toml`, `entitlements.service.ts` comment, `CLAUDE.md` lines (scheduled jobs use `@LeaderCron`; Squawk; `SKIP_VERIFY_REASON`), code map (`api.md`, root scripts, `_meta.json`), `docs/IMPROVEMENTS.md` (item 3 text → Squawk; rows 2 `shipped`, 3 `shipped`, 9 `shipped (wave B)`; P4 note), lessons: L-05x for Squawk-vs-Atlas (from 3B brief) only; `_meta.json`; `validate-lessons` exit 0.

Verify: perRound `npx tsc -p apps/api/tsconfig.build.json --noEmit`, `npm run lint -w apps/api`; final `npm run verify`.
Mutation probe: `cron-lock.ts` (body runs when not acquired), one cron site reverted to bare `@Cron`, `lint-migrations.mjs` (exclusion list emptied → hygiene rules fire), `skip-verify-audit.mjs` (reason check dropped), `app.service.ts` (`commit` removed), `db-locks.ts` untouched (PR-2's).

## Acceptance (close-out)

Per-item acceptance lines from the four briefs, plus: `npm run local:test:db` (all lanes), `gh workflow run db-migrations.yml` on the branch (Squawk step executes; a scratch destructive migration on a throwaway branch is rejected — log attached), `SKIP_VERIFY=1 git push --dry-run` refusals/acceptances, `verify` with an injected lint error shows all three task results (`--continue`), post-deploy: API `/api/v1/health` returns `commit` = merge SHA; the deploy-triggered E2E run's readiness log shows the API sha check.

Red-gate bookkeeping: `guard-chain.security.spec.ts` and `app.module.guards.spec.ts` are regression
pins the P4-b/c brief commissions GREEN (the invariants already hold), so they are verification-only
and are not red-bar tests — do not count them toward, or re-run them against, the red gate. The
`*.db.spec.ts` lane (`tenant-findunique.db.spec.ts`, `tenant-findunique-pins.db.spec.ts`) is excluded
by `apps/api/package.json`'s `jest.testPathIgnorePatterns` and is collected only by
`npm run local:test:db` (`jest.db.config.js`), never by `npm test -w apps/api` — a gate that does not
run that lane explicitly reports those cases as not-run, not as passing.

## pB10 facts

Read-only recon for the login-throttle knob (see "Added scope" above).

- **Login-route decorator** — `apps/api/src/auth/auth.controller.ts:66`:

  ```ts
  @Throttle({ default: { ttl: 300_000, limit: 10 } }) // RF-160: 10 attempts per 5 min per IP to block brute-force
  ```

  (300_000 ms = 5 min, matches the brief's "10 requests / 5 min per IP".) Limits are expressed as a
  **literal object per decorator** (`{ default: { ttl, limit } }`), not a named throttler pulled from
  config — same pattern repeats at `auth.controller.ts:85` (`ttl: 60_000, limit: 20`), `:126`
  (`ttl: 60_000, limit: 10`), `:146`/`:156`/`:164` (`ttl: 900_000, limit: 5`), `:362`
  (`ttl: 60_000, limit: 30`), and `apps/api/src/route-optimization/route-optimization.controller.ts:9`
  (`const OPTIMIZE_THROTTLE = { default: { ttl: 60_000, limit: 10 } } as const;`, reused at 6 call
  sites) — so pB10's env-read constant follows the same local-const-then-spread shape, not a new
  module-wide pattern.

- **Global throttler module** — `apps/api/src/app.module.ts:83-93`:

  ```ts
  // ─── Rate limiting (100 req / 60 s per IP, Redis-backed across all instances)
  // forRootAsync with storage option is required — forRoot([...]) (array format)
  // always creates a new in-memory ThrottlerStorageService(), ignoring any
  // custom storage override. Only the object format honours options.storage.
  ThrottlerModule.forRootAsync({
    inject: [ConfigService],
    useFactory: (config: ConfigService) => ({
      throttlers: [{ ttl: 60_000, limit: 100 }],
      storage: new RedisThrottlerStorage(config),
    }),
  }),
  ```

  This registers the app-wide **default** throttler (100/60s, Redis-backed via
  `RedisThrottlerStorage`); each `@Throttle({ default: { ttl, limit } })` call overrides just the
  `default` named throttler's ttl/limit for that route, it does not add a new throttler.

- **No existing env knob**: `grep -rn "THROTTLE" apps/api/.env.example apps/api/src/config` and a
  repo-wide `apps/api/src` grep for `THROTTLE` (excluding `*.spec.ts`) turn up nothing besides the
  `route-optimization` decorator constant and its security-spec storage-key strings
  (`route-optimization.security.spec.ts:15-16`, `"THROTTLER:LIMITdefault"` / `"THROTTLER:TTLdefault"`
  — the Nest Throttler's internal Redis key naming, useful if pB10's spec needs to assert the
  effective limit/ttl directly from storage). `AUTH_LOGIN_THROTTLE_LIMIT` /
  `AUTH_LOGIN_THROTTLE_TTL_MS` do not exist yet anywhere in `apps/api` — pB10 introduces both fresh.
