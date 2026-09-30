# Build plan — train 1: driver session teardown + POD persistence

Mode `bugfix`, scale `minor` (mobile pure-logic; no schema, no API). Worktree per `pipeline-args.json`, branch
`fix/train1-driver-teardown` off master 1dca1242. Design `cause-ruling.md` §3; tests `bug-test-plan.md`; binding
facts `cause-refutation.md`. Option-B bookkeeping: no map/lessons/ledger edits. Never Expo/Playwright.

## Packages

- **P1 teardown (Sonnet high)** — `lib/session-teardown.ts` + wiring in `lib/auth-store.ts` (before `apiLogout`)
  and the session-expired path; `lib/query-client.ts` exporting the client the layout uses; `reset()` on the 7
  user-scoped stores; operator sign-out path calls the same function. D1.
- **P2 queue identity (Sonnet high)** — `store/offlineQueue.ts`, `lib/queue-drain.ts`, `components/OfflineBanner.tsx`:
  stamps, per-user filtering, `different-user` failures, legacy adoption. D2.
- **P3 POD/settlement persistence (Sonnet high)** — `store/podStore.ts`, `store/runSettlementStore.ts` persist +
  hydrate; `lib/pod-reconcile.ts`; stop screen attaches only pending artifacts. D3.
- **P4 attach visibility (Sonnet high)** — `payment.tsx` / `photo.tsx`: convert `file://` fallbacks, surface attach
  errors with retry, keep captures. D4.
- **TP (Sonnet high)** — T1–T4.

## Gates

Per round: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json`; `cd apps/mobile && npx jest --runInBand`.
Final: `cd apps/mobile && npx jest --silent`; `npm run lint -w apps/mobile`; `node scripts/validate-lessons.mjs`.
Red gate: `cd apps/mobile && npx jest __tests__/session-teardown.test.ts __tests__/offline-queue-identity.test.ts __tests__/pod-persistence.test.ts __tests__/pod-attach-visibility.test.ts --runInBand -t "REG-B1"` must FAIL before P1–P4.

## Landing (Lead): commit (trailer) → merge origin/master → reports → campaign-check → hook push → draft PR

`fix(mobile): sign-out teardown, identity-stamped offline queue, persisted POD (B111 B136 B137 B140 B150)` → window
(mobile-only → SKIPPED rows) → docs follow-up.
