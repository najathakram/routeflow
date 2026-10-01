# F9-DRIVER-FLOW

## Plan (5 bullets)

1. **RF-016 (auto-complete run)** — Inside `completeStop()` transaction, after marking stop COMPLETED, query all sibling stops; if every one is COMPLETED or SKIPPED, update `RouteRun.status → COMPLETED` with `completedAt = now()`. Same logic replicated in the new `completeWithPayment()`.

2. **RF-005 (atomic complete + payment)** — New `completeWithPayment()` service method + `POST /route-runs/:runId/stops/:stopId/complete-with-payment` controller endpoint. Both the stop-completion writes and the invoice-payment write share one `prisma.tenantTransaction`. Mobile `payment.tsx` calls this instead of two sequential fetches; on rollback, neither the stop nor the payment is committed.

3. **RF-006 (pre-submit guard)** — Payment screen: block submit when `method ∈ {Cash, Card, Cheque}` and `receivedNum === 0`. Check fires in both client (inline error message, red box) and server (`completeWithPayment` validates `amount > 0` for physical-money methods before entering the transaction).

4. **RF-019 (idempotency)** — SHA-256 hash of `<scope>:<client-key>` stored in a new `IdempotencyKey` table via raw SQL (`INSERT … ON CONFLICT DO UPDATE`). Read side also raw SQL so the feature degrades gracefully if the migration hasn't been applied. TTL = 24 h. Both `completeStop` and `completeWithPayment` check/store the key outside the write transaction to avoid holding locks.

5. **NEW-m1-1 (React #185 white-screen)** — The crash on DELIVERED stop came from `itemsFromStop(stop)` being called inline every render (returning a new array reference) while a parent component holding state watched `items.length`. Wrapping `items = useMemo(() => itemsFromStop(stop), [stop])` memoizes the array — it only recomputes when the actual `stop` object from `useRouteRun` changes, breaking the infinite re-render loop.

6. **NEW-rmob-1 (no refresh token on web)** — Already fixed in the existing codebase: `auth.ts` uses a `storage` wrapper with a `Platform.OS === "web" ? localStorage : SecureStore` branch, and `api-client.ts` has the same `storageGet/storageSet` helpers. No code change required; confirmed and documented.

---

## RFs addressed

| RF         | Sev | Status | Files                                                                           | Commit                                                 | Test added                                   | Migration?          |
| ---------- | --- | ------ | ------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------- | ------------------- |
| RF-016     | P1  | ✅     | `routes.service.ts`                                                             | fix(driver): RF-016/005/006/019/m1-1 driver flow fixes | Integration (auto-complete run on last stop) | No                  |
| NEW-m1-1   | P1  | ✅     | `app/(driver)/route/stop/[stopId]/index.tsx`                                    | same                                                   | Unit-level (useMemo prevents render loop)    | No                  |
| NEW-rmob-1 | P1  | ✅     | Already fixed — `auth.ts` + `api-client.ts`                                     | —                                                      | —                                            | No                  |
| RF-005     | P1  | ✅     | `routes.service.ts`, `routes.controller.ts`, `lib/api/routes.ts`, `payment.tsx` | same                                                   | Integration (complete+payment in 1 tx)       | No                  |
| RF-006     | P1  | ✅     | `payment.tsx`, `routes.service.ts`                                              | same                                                   | Integration (CASH amount=0 → 400)            | No                  |
| RF-019     | P1  | ✅     | `routes.service.ts`, `schema.prisma`, migration SQL                             | same                                                   | Integration (duplicate key returns cache)    | **YES — see below** |
| RF-167     | —   | ✅     | `routes.service.ts` (findMyRuns unchanged)                                      | same                                                   | Regression (my-runs returns data)            | No                  |

---

## Notes / blockers

### RF-019 Migration (MANUAL APPLY REQUIRED)

File: `apps/api/prisma/migrations/20260501200000_add_idempotency_key_table/migration.sql`

```sql
CREATE TABLE "IdempotencyKey" (
    "id"        TEXT NOT NULL DEFAULT gen_random_uuid(),
    "keyHash"   TEXT NOT NULL,
    "response"  TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdempotencyKey_keyHash_key" ON "IdempotencyKey"("keyHash");
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");
```

The service uses raw SQL (`$queryRaw`/`$executeRaw`) so it degrades gracefully if the table doesn't exist — the idempotency feature simply won't activate until the migration is applied.

### Prisma client regeneration needed

After applying the migration, run `npx prisma generate` to surface the `IdempotencyKey` model in the generated client. The `schema.prisma` model definition has been added.

---

## User-visible proof of fix

- **RF-016**: Completing the last stop on a run now automatically sets the run card to "Completed" — driver no longer sees a stuck "In Progress" badge after the final delivery.
- **RF-005**: If the server crashes between `completeStop` and `recordPayment`, the stop is no longer orphaned as "completed but unpaid" — both succeed or both roll back.
- **RF-006**: Tapping "Receive payment & close" with $0 entered now shows a red inline error: _"Enter the cash amount received before closing."_ — no spinner, no silent failure.
- **RF-019**: Tapping submit twice (e.g. on slow network) does not create duplicate deliveries — second request returns the first response immediately.
- **NEW-m1-1**: Navigating to a DELIVERED stop no longer white-screens. Items list renders correctly with checkmarks.
- **NEW-rmob-1**: Web driver login persists the refresh token to `localStorage` via the existing `storage` wrapper — "No refresh token" toast no longer appears on payment submit.
