# Discovery — PR-2 · Cross-replica-safe order merges (customer advisory lock)

Status: APPROVED
Scale: major · ui: false · Branch: `fix/imp-02-order-merge-advisory-lock` off `master` after PR-1

## Problem, and whose it is

Staff order merges are a read → fold → write of **absolute** line totals: the controller re-reads
the customer's active order, folds the incoming items into it (`foldMergeItems`), and writes the
complete new line set through `updateOrderItems(…, { replaceAll: true })`
(`apps/api/src/orders/orders.controller.ts:192-236`). The only thing serializing two such merges is
`withOrderMergeLock` — a promise-chain `Map` on the controller **instance** (`:45-109`). Two API
replicas (or a queue replay landing on a different instance than the live request) read the same
snapshot and the second write clobbers the first's delta: merged order lines become silently
wrong (B199's cross-replica case, deferred on 2026-08-31 "deliberately, on evidence" that the
service runs exactly one instance — `:66-95`). The same read-fold-write shape exists in
`mergeAllPendingForCustomer` (`orders.service.ts:814-1133`: read pending orders at `:815`, compute
contributions, write in a transaction at `:958`) and `forceConsolidateCustomer` (`:1258`), both
outside any lock today.

Whose: the operator whose merged order is short or double lines, and the owner who would never see
an error — "the money is simply wrong" (the code's own words at `:75-77`). Frequency: zero today
(one replica); certain the day the service scales, with nothing able to self-detect it (Railway
injects no replica-count variable, `:80`).

## Cost today

An undocumented-to-operators footgun guarded only by a comment in `apps/api/railway.toml`. The
architecture review rated it P0 🔴. It blocks horizontal scaling of the API entirely.

## Current workaround and why it fails

"Run exactly one replica." It holds only as long as everyone who can touch the Railway service
knows about a comment; a mis-scale is silent money corruption, not a crash.

## Why now

PR-1 just delivered the DB-backed spec lane (`*.db.spec.ts` against real Postgres) this fix needs
to _prove_ cross-session serialization rather than assert it from a mocked service. PR-3 (cron
leader lock) reuses the helper built here.

## If we ship nothing

The constraint stays a comment. Every later scaling decision (or an autoscaler default) risks
silent lost updates on money.

## Success signal (observable) and baseline

- `db-locks.db.spec.ts`: two concurrent merges on one customer key run strictly one after the other
  on a real Postgres — baseline: no test can show this (the only concurrency test mocks the service
  and states it proves single-instance behaviour only, `orders.scan-hardening.spec.ts:769-781`).
- `grep -n "mergeLocksByOrder" apps/api/src` → 0 — baseline: 1 Map + 1 method.
- The `railway.toml` guard comment no longer names order merges as a single-replica dependency.

## Who else is affected

`mergeAllPendingForCustomer` is called from three paths (staff sweep `controller:239`, non-staff
auto-consolidate `:257`, and `forceConsolidateCustomer`); all become serialized per customer. A
merge that waits > 20 s for the lock now returns 409 `MERGE_IN_PROGRESS` instead of racing.
Connection budget: one extra short-lived Postgres connection per merge from a dedicated pool of 4.

## Symptom or root cause?

Root cause: the read the totals are folded from is outside any cross-process lock. The fix moves
the _lock_, not the money math.

## Strongest objection

"Fold inside `updateOrderItems`' transaction — the 'full' fix (comment design 3)." That method is
1,300 lines (`orders.service.ts:2940-4238`), reads before its transaction, and does deliberately
post-commit work (invoice resync, a second Serializable credit-note transaction at `:4190`, gateway
emit, revision). Reshaping it, or threading an outer transaction through it (which would nest the
second transaction on a second pooled connection), is the larger money risk. The comment's own
cheapest design — a cross-process lock around the same critical section — closes the race without
touching the fold or the write. Choosing Postgres over Redis for that lock removes a new fail-closed
dependency: Postgres being down already stops every merge.

## Stop conditions

None triggered. Proceed.

## Reuse before re-deriving

- The verbatim critical section and lock comment (`orders.controller.ts:45-109, 143-263`);
  `tenantTransaction` (`prisma.service.ts:36-51`; its proxy forwards every `$`-method to the raw
  tx, `:76-86`); the Prisma pool is constructor-local (`:10-12`) — the lock helper owns its own.
- No advisory lock, `lock_timeout`, `55P03`, or `P2028` handling exists anywhere in `apps/api/src`
  (grepped) — the error mapping is new.
- Lessons: L-021, L-027, L-034, L-039; L-041 (a skip is not a discharge) for the retitled spec.
