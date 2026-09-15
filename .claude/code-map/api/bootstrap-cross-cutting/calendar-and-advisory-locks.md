# api — Bootstrap & cross-cutting — calendar dates & advisory-lock concurrency

> Split from [`../bootstrap-cross-cutting.md`](../bootstrap-cross-cutting.md) (verbatim, lines 336-453 of the pre-split file) on 2026-09-15. See [`../../INDEX.md`](../../INDEX.md).

## Bootstrap & cross-cutting

- **`src/common/calendar-date.ts` (F25, 2026-09-04, B59/B90/B91/B118)** — the ONE api helper for
  date-only fields: `calendarDateFromIso`/`isoFromCalendarDate` (UTC-midnight string <-> ISO
  round-trip), `calendarDayBounds`/`startOfCalendarDay`/`endOfCalendarDay` (day boundaries in a
  given IANA `timeZone`, argument order `date, timeZone`, never local getters). There is
  deliberately NO tenant-timezone resolver here: every caller passes `cfg?.timezone ?? null` and
  relies on these functions' own UTC fallback, so an unconfigured tenant never silently acquires an
  `America/New_York` boundary. The B91 repair-day rule is NOT here either: `recoverCalendarDay` and
  `classifyRepairRow` (the repair's EXPIRING-NOW / FAR-EAST hold-back gates — pure, clock passed in)
  live once in `scripts/lib/recover-calendar-day.cjs` (no API caller), executed by both
  `scripts/repair-f25-licence-dates.mjs` and its pin `src/common/recover-calendar-day.spec.ts`.
  Mirrored verbatim
  (same exported names/signatures) in `apps/web/lib/calendar-date.ts`
  and `apps/mobile/lib/calendar-date.ts` — see L-047. `analytics.service.ts` on-time-% calls
  `endOfCalendarDay(run.scheduledDate, cfg?.timezone ?? null)` through its own
  `resolveCurrentTenantTimezone`, so an unconfigured tenant keeps the UTC day-end (T11 pin,
  `analytics.service.calendar.spec.ts`). Two host-local siblings in `analytics.service.ts` were
  swept with it: `getRevenueTrend`'s month key (now `toISOString().slice(0, 7)`) and `dateRange`'s
  default `fromDate` (now `Date.UTC(getUTCFullYear(), 0, 1)`); both are pinned in a describe block
  that pins `process.env.TZ` west of UTC, because a UTC runner cannot tell the two bodies apart.
  `src/analytics/demand-range.ts` carries only a retensed docblock naming that pair as the
  cautionary tale.
  `invoices.service.ts`'s only change: its private `startOfCalendarDay` moved here and its four
  `issueDate` call sites took the new argument order; the licence-expiry WRITER fix is
  `apps/mobile/app/(operator)/customers/[id]/licenses.logic.ts#buildExpiresAtIso` (see mobile.md).
  Specs: `analytics.service.calendar.spec.ts` (DST fixture), `calendar-date.pins.spec.ts` (pinned
  UTC-midnight/round-trip behaviour).
- **`src/common/db-locks.ts` (PR-2, `imp-02-order-merge-advisory-lock`, 2026-09-03; per-family
  pools PR-2b, 2026-09-04)** — exports
  `withAdvisoryLock<T>({family,key,mode:"wait"|"try",waitMs?}, fn): Promise<LockResult<T>>` where
  `LockResult<T> = {acquired:true,value:T}|{acquired:false}`, plus `LOCK_FAMILIES`
  (`["order-merge","cron","billing"] as const`) / `LockFamily`, `LockTimeoutError`/
  `LockUnavailableError` and a test-only `_resetLockPoolForTests()` (ends+clears ALL pools).
  Cross-process critical
  section on a Postgres advisory lock (`pg_advisory_lock(hashtext(family), hashtext(key))`), held
  on DEDICATED `pg.Pool`s it owns itself — **one pool per family, sized per family** (`cron`
  `max: 12`, `order-merge` `max: 8`, **`billing` `max: 4` (B342, 2026-09-13)**): a cron winner
  pins a slot for
  its whole tick (≤ 7
  concurrently at the monthly peak, plus a straggling hourly sweep), which out of one shared
  `max: 8` pool left merges 1–3 slots and 503s. ALL THREE pools set `keepAlive: true` /
  `keepAliveInitialDelayMillis: 30_000` — a lock connection is SOCKET-IDLE for the whole hold (a
  cron tick's work runs on the Prisma pool), so an intermediate idle-reap would end the session,
  release the advisory lock mid-tick and let another replica win an election for a running job.
  `withAdvisoryLock` throws `TypeError` for a family outside `LOCK_FAMILIES`
  BEFORE connecting, so a typo cannot stand up a fourth pool. **RETIRED (F5 round 2 / N1,
  independent review round 2, PR-2, 2026-09-15):** a fourth `"idempotency"` family briefly lived
  here (round 1, `max: 6`) backing `ReturnsService#create`'s check-then-create-then-save guard —
  the review judged a dedicated 6-connection pool an unjustified extra failure surface; it now
  takes a TRANSACTION-scoped `pg_advisory_xact_lock` on its own transaction's connection instead
  (`common/idempotency.service.ts#acquireLock` — see the Returns row below), needing no pool
  here at all. **`billing`'s two call sites
  (B342 admin path; F1 2026-09-13 tenant path):** `addon.service.ts enableAddon()` (admin grant)
  and `subscription-mutation.service.ts enableAddon()` (tenant self-serve, `POST
/billing/addons/:sku/enable`) each wrap their existing-check → row-write window in ONE lock,
  the SAME key shape `addon:<tenantId>:<sku>`, `mode:"wait"`, `waitMs:10_000` — so the two paths
  now serialise against EACH OTHER too, not just within themselves. Admin path closes a race
  where two concurrent enables both passed the sequential "already active" guard, both created a
  live Stripe item, and the final upsert kept only one `stripeItemId` (double billing); tenant
  path has no such refusal (delta-quantity model) — serialisation + a fresh re-read nets a
  genuine re-enable to a zero delta instead. Full writeup in `feature-modules-4.md`'s `billing/`
  section. Prisma's pool is private and offers no
  connection-pinning API, so this module never touches it and cannot deadlock against it. `wait`
  blocks up to `waitMs` (default 20s; SQLSTATE 55P03 on `lock_timeout` → `LockTimeoutError`); `try`
  returns `{acquired:false}` without calling `fn` or issuing UNLOCK when the lock is already held.
  `client.release(err)` on any failure destroys the connection (server drops the session lock with
  it) — the clean path releases plain. **Call sites:** orders.controller.ts:~147 (staff `create()`
  merge branch), orders.service.ts:~824 (`mergeAllPendingForCustomer`), orders.service.ts:~1169
  (`forceConsolidateCustomer`), buyer.controller.ts:~547 (buyer `createOrder`). The in-process Map
  is deleted. family `order-merge`, key `ctx.customerId`/`dto.customerId`, `mode:"wait"` for all
  four — **but `waitMs` is NOT a flat 20_000**: staff `create()` and buyer `createOrder` pass
  `waitMs:10_000` (the mobile client aborts at 15s, so a 20s wait can only ever surface as a
  client-side timeout, never the 409 that tells the caller to retry); `mergeAllPendingForCustomer`/
  `forceConsolidateCustomer` pass `waitMs:20_000` (no client attached, so the default stands).
  Request-path post-commit callers (the sibling sweep / post-create auto-consolidation) pass
  `{ lockMode: "try" }` instead — a contended lock is skipped with a warning, never blocks the
  request. `LockTimeoutError` → 409 `MERGE_IN_PROGRESS`, `LockUnavailableError` → 503.
- **`src/common/cron-lock.ts` (PR-2b, `imp-02b-cron-leader-lock`, 2026-09-04)** — exports
  `LeaderCron(cronTime, name, options?): MethodDecorator`, `CRON_LOCK_FAMILY = "cron"` and the
  `LeaderCronOptions` type (a DISTRIBUTIVE `Omit<CronOptions,"name">` — a plain `Omit` collapses
  the library's `timeZone` XOR `utcOffset` union into one object that no longer satisfies
  `CronOptions`). Replaces `descriptor.value` with a wrapper that runs the tick inside
  `withAdvisoryLock({family:"cron", key:name, mode:"try"}, …)` and THEN applies
  `Cron(cronTime,{...options,name})`. **Order matters:** `@nestjs/schedule`'s `Cron` is
  metadata-only (`SetMetadata` writes onto `descriptor.value`) and `schedule.explorer` registers
  `instance[method]` after reading that metadata off it — applying `Cron` first would register the
  UNWRAPPED original. `name` is also the `SchedulerRegistry` key (`addCron` falls back to a
  per-process random UUID without it) and the advisory-lock key, so it must be a literal,
  `<area>.<method>`, validated by `NAME_RE` at class-definition time. Skips are never errors:
  `acquired:false` → `logger.debug`, `LockUnavailableError` → `logger.warn`, both return
  `undefined`; anything the BODY throws propagates (the scheduler's own try/catch logs it).
  ⚠️ **Behaviour change:** an overlapping tick on the SAME process is skipped too — all 13 jobs
  are idempotent sweeps, so that is the safer default. ⚠️ **A skipped tick does NOT cost the same
  everywhere** (header, "WHAT A SKIPPED TICK ACTUALLY COSTS"): 11 jobs re-derive from state and
  self-repair, but `tobacco-report.generateMonthlyReports` (only `now − 1 month`) and
  `order-templates.generateDailyOrders` (only today's weekday) lose a whole month/day that needs a
  manual re-run — follow-on is a catch-up window in those two. Residual, deliberate: a body that
  never settles pins the lock forever (a hold cap is rejected — it cannot cancel the body, so it
  would license two concurrent money ticks). Specs: `src/common/cron-lock.spec.ts`
  (mocks `./db-locks`; case (f) registers a job in a `ScheduleModule.forRoot()` test module and
  then `fireOnTick()`s it, asserting the REGISTERED tick went through `withAdvisoryLock` with
  family `cron`/key/`mode:"try"`), `src/common/no-bare-cron.spec.ts` (static tripwire: 0 bare
  `@Cron(` in `src`, exactly 13 `@LeaderCron(` sites with 13 unique names, and — spec files
  included — no file but `common/cron-lock.ts` IMPORTS the `Cron` identifier from
  `@nestjs/schedule`), `src/common/cron-lock.db.spec.ts` (real Postgres — two concurrent ticks run
  the body once).
- **`src/orders/merge-contention.ts` (PR-2, `imp-02-order-merge-advisory-lock`, 2026-09-03)** —
  the ONE code-tagged mapping from a `db-locks` failure to its wire contract, plus the
  post-commit-swallow helper: exports `MERGE_IN_PROGRESS`/`LOCK_UNAVAILABLE` (response `code`
  constants), `mapLockError(e): never` (`LockTimeoutError`→409 `{code:MERGE_IN_PROGRESS}`,
  `LockUnavailableError`→503 `{code:LOCK_UNAVAILABLE}`, anything else rethrown), and
  `isMergeContention(e)` (recognises those two by `code`, never by exception type — a plain
  409/503 elsewhere in the merge path is NOT contention). Raised ONLY before any write.
  ⚠️ the sibling sweep and the response read stay OUTSIDE the lock —
  `mergeAllPendingForCustomer` takes the SAME (family, key) on a different pooled connection, so
  nesting it self-blocks until `lock_timeout`. Spec: `src/buyer/buyer.merge-lock.spec.ts`; the
  pre-existing `src/buyer/buyer.controller.merge.spec.ts` now mocks `../common/db-locks` with a
  pass-through. Specs: `src/common/db-locks.spec.ts` (`jest.mock("pg")`),
  `src/common/db-locks.db.spec.ts` (real Postgres, `*.db.spec.ts` lane).
