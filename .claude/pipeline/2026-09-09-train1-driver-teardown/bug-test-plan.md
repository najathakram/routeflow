# Bug test plan — train 1 (B111 · B136 · B137 · B140 · B150)

Design of record: `cause-ruling.md` §3. Mobile Jest = `apps/mobile/__tests__/**/*.test.ts`, node, pure logic; native
modules mocked (copy `network-sync-wiring.test.ts`); source-text specs read files relative to `__dirname`,
COMMENT-STRIPPED, tolerate prettier wrapping. Every REG test states its wrong value TODAY; one oracle per `it`.

## Red gate

### T1 — `__tests__/session-teardown.test.ts` (pure, mocked natives) — REG-B150 / REG-B140

- REG-B150-A `logout stops background location before apiLogout`: order of calls recorded by mocks → `stop` precedes
  `apiLogout`. TODAY: `stop` never called (0 calls).
- REG-B150-B `operator sign-out stops tracking too` (source-text on the operator path or the shared function):
  TODAY: no stop site.
- REG-B140-A `logout clears the query cache after cancelling queries`: `cancelQueries` then `clear` called once each.
  TODAY: 0 calls.
- REG-B140-B `user-scoped stores reset on logout`: each of the 7 stores' `reset` called. TODAY: 0.
- Pin: tenant store NOT cleared on logout (GREEN today and after).

### T2 — `__tests__/offline-queue-identity.test.ts` (pure) — REG-B137

- A `enqueue stamps userId+tenantId` (TODAY: no stamp fields).
- B `drain replays only the current user's entries` (two stamped entries, one other-user → `failedActions` with
  `different-user`, never executed). TODAY: both executed.
- C `failedActions listed per user` (selector returns only the current user's). TODAY: all.
- D `legacy unstamped entry adopted once then stamped`.

### T3 — `__tests__/pod-persistence.test.ts` (pure) — REG-B136

- A `podStore persists under a user+tenant+stop key` (persist config present; hydrate round-trip). TODAY: in-memory.
- B `runSettlementStore persists` likewise.
- C `pendingPodArtifacts skips artifacts the server already holds` (by id/hash) — TODAY: helper absent.

### T4 — `__tests__/pod-attach-visibility.test.ts` (source-text on payment.tsx / photo.tsx) — REG-B111

- A `file:// fallback photos are not filtered out` (the `startsWith("data:")` filter is gone / replaced by a convert
  step). TODAY: filter present.
- B `attach failure is surfaced` (the catch block references the error feedback + queue, no empty catch). TODAY:
  bare `catch {}`.

## Pins outside the gate: existing `session-expired-wiring.test.ts`, `network-sync-wiring.test.ts`, `queue-drain`

tests (B143) stay green; `scan-*` specs untouched.

## Harness notes: mock `expo-location`/`expo-task-manager` via the tracker module mock; zustand persist storage

mocked with an in-memory map; no renderer.
