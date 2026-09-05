# Bug test plan — B59, B90, B91, B118 (F25-calendar)

> Fable @ high writes this from `cause-ruling.md`; Sonnet types the tests inside the engine. The red bar is
> BEHAVIORAL: each REG test must fail today on its own exact wrong value — reproduction is the point.

## Seam extraction (harness preparation, not the fix)

Per the common ruling: where the wrong value lives in a component or a duplicated inline expression with no
pure seam, the TEST package first extracts the CURRENT expression VERBATIM into a named pure module (a
behaviour-preserving move — the component calls it, unchanged output) so the REG test fails on the wrong
value today, not on a missing import. Three seams this run:

1. **B59 (`EditRunModal.tsx`)** — NEW `apps/web/app/(dashboard)/routes/_components/edit-run-modal.logic.ts`:
   - `export function readCalendarInput(scheduledDate: string): string` — body copied verbatim from today's
     `formatLocalDate` (`:17-23`: `new Date(value)` + local `getFullYear`/`getMonth`/`getDate`).
   - `export function buildRunPatchBody(args: { id: string; driverId: string; initialDriverId: string; date: string; notes: string; isInProgress: boolean }): { id: string; driverId?: string | null; scheduledDate?: string; notes: string }` —
     body copied verbatim from today's `handleSave` (`:50-56`): unconditional `if (!isInProgress) body.scheduledDate = date;`, no dirty check against an initial date.
   - `EditRunModal.tsx` is updated to call both (`formatLocalDate`'s definition and `handleSave`'s inline
     body-construction are deleted from the component; the component imports and calls the two exports)
     — output is byte-identical to today, so this step alone changes no existing behavior.
2. **B90 (`exceptions.tsx`)** — NEW `apps/mobile/lib/run-lateness.ts`:
   - `export function isRunPastDue(scheduledDateIso: string, now: Date): boolean` — body copied verbatim
     from today's `:58-62` (`new Date(scheduledDateIso)` + local `setHours(0,0,0,0)`, compared against `now`
     similarly floored).
   - `exceptions.tsx`'s late-route loop (`:58-62`) calls `isRunPastDue(run.scheduledDate, new Date())` in
     place of the inline block — behaviour-preserving.
3. **B91 writer (`licenses.tsx`)** — NEW `apps/mobile/app/(operator)/customers/[id]/licenses.logic.ts`:
   - `export function buildExpiresAtIso(expiresAt: string): string` — body copied verbatim from today's
     `:84` (``new Date(`${expiresAt.trim()}T23:59:59`).toISOString()``).
   - `licenses.tsx:84` calls it in place of the inline expression — behaviour-preserving.

WP-WEB / WP-MOB (the implementation packages) then replace ONLY the bodies of these four functions with the
fixed logic from `cause-ruling.md` §2 — call sites and exported names do not change again.

## Red set (REG-tagged; in the red gate)

| T#  | Title (starts with REG-<bug id>)                                                                        | Setup                                                                                                                                                                                                                                                                                                                     | Asserts                                                                    | Fails TODAY with                                                                                                                                                                                                                               | File                                                                           |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| T1  | `REG-B59 pre-fills the day before the stored calendar date`                                             | `process.env.TZ = "America/Los_Angeles"` set as the FIRST line of the test file, before any import; call `readCalendarInput("2026-06-10T00:00:00.000Z")` (from the seam module)                                                                                                                                           | `expect(result).toBe("2026-06-10")`                                        | `expected "2026-06-10" received "2026-06-09"`                                                                                                                                                                                                  | `apps/web/app/(dashboard)/routes/_components/edit-run-modal.logic.test.ts`     |
| T2  | `REG-B59 omits scheduledDate from the PATCH when the date field is unchanged`                           | Call `buildRunPatchBody({ id: "r1", driverId: "d2", initialDriverId: "d1", date: "2026-06-10", notes: "x", isInProgress: false })` where `date` equals the seeded/initial date                                                                                                                                            | `expect(body.scheduledDate).toBeUndefined()`                               | `expected undefined received "2026-06-10"` (today's body always includes `scheduledDate` when `!isInProgress`, regardless of dirtiness)                                                                                                        | same file as T1                                                                |
| T3  | `REG-B90 does not flag a run scheduled for today as late`                                               | `process.env.TZ = "America/New_York"` set as the FIRST line of the test file; call `isRunPastDue("2026-06-10T00:00:00.000Z", new Date("2026-06-10T13:00:00Z"))` (09:00 local on the scheduled day)                                                                                                                        | `expect(result).toBe(false)`                                               | `expected false received true`                                                                                                                                                                                                                 | `apps/mobile/__tests__/run-lateness.test.ts`                                   |
| T4  | `REG-B90 still flags a genuinely past run as late`                                                      | Same TZ; call `isRunPastDue("2026-06-08T00:00:00.000Z", new Date("2026-06-10T13:00:00Z"))`                                                                                                                                                                                                                                | `expect(result).toBe(true)`                                                | passes today too (recorded to prove the fix does not flip the correct direction, not to prove the bug)                                                                                                                                         | same file as T3                                                                |
| T5  | `REG-B91 writes UTC midnight for the licence expiry, never a local end-of-day instant`                  | `process.env.TZ = "America/New_York"` (UTC−5 outside DST — 2027-01-01 is EST) set as the FIRST line; call `buildExpiresAtIso("2027-01-01")` (seam), then separately assert `isoFromCalendarDate("2027-01-01") === "2027-01-01T00:00:00.000Z"` (new pure helper, no seam needed — already correct by construction)         | `expect(buildExpiresAtIso("2027-01-01")).toBe("2027-01-01T00:00:00.000Z")` | `expected "2027-01-01T00:00:00.000Z" received "2027-01-02T04:59:59.000Z"` (today's local-`23:59:59` construction, per `cause-brief.md`'s repro)                                                                                                | `apps/mobile/app/(operator)/customers/[id]/licenses.logic.test.ts`             |
| T6  | `REG-B91 renders the calendar date, not one day early, for a negative-offset viewer`                    | `process.env.TZ = "America/Los_Angeles"` set as the FIRST line; call `fmtCalendarDate("2026-11-01T00:00:00.000Z")` — the already-existing, already-UTC-anchored export at `apps/web/lib/formatting.ts:55` — AND, as the "wrong value" comparator, the existing LOCAL formatter (`fmtDate`/`formatDate`) on the same input | `expect(fmtCalendarDate(...)).toMatch(/Nov 1, 2026/)`                      | today's LOCAL formatter (the one the 9 sites currently call) renders `Oct 31, 2026` on the same input — asserted as the "wrong value" comparator in the same test, per the ruling's instruction to assert against the local formatter's output | `apps/web/lib/formatting.test.ts` (NEW — no existing spec for `formatting.ts`) |
| T7  | `REG-B118 counts an 8:15pm-local delivery on-time for an America/New_York tenant`                       | `resolveCurrentTenantTimezone`-equivalent fixture: run `scheduledDate = "2026-06-10T00:00:00.000Z"`, tenant timezone `"America/New_York"` (EDT), stop `completedAt = "2026-06-11T00:15:00.000Z"` (8:15pm EDT local)                                                                                                       | `expect(row.onTimeRate).toBe(100)`                                         | `expected 100 received 0` (today's UTC day-end of `2026-06-10T23:59:59.999Z` is 7:59:59pm EDT, so 8:15pm is past it)                                                                                                                           | `apps/api/src/analytics/analytics.service.calendar.spec.ts`                    |
| T8  | `REG-B118 still counts a genuinely-next-day (local) completion as late`                                 | Same tenant timezone; `completedAt` at 2:00am EDT the FOLLOWING calendar day (tenant-local)                                                                                                                                                                                                                               | `expect(row.onTimeRate).toBe(0)`                                           | passes today too (recorded so the fix doesn't just always return on-time)                                                                                                                                                                      | same file as T7                                                                |
| T9  | `REG-B118 DST edge — 2026-03-08 (America/New_York spring-forward day) resolves the correct UTC day-end` | Tenant timezone `"America/New_York"`; `scheduledDate = "2026-03-08T00:00:00.000Z"`; `completedAt` at 11:45pm local on the 8th (post-spring-forward, EDT = UTC−4 from 2am that day)                                                                                                                                        | `expect(row.onTimeRate).toBe(100)`                                         | today's fixed UTC cutoff (`2026-03-08T23:59:59.999Z` = 6:59:59pm EDT / 7:59:59pm EST — ambiguous without DST awareness) mis-scores an EDT-local 11:45pm completion as late: `expected 100 received 0`                                          | same file as T7                                                                |

**TZ-pinning method (applies to T1, T3, T5, T6):** `process.env.TZ = "<zone>"` set as the literal first
executable line of the test file, BEFORE any `import` that could construct a `Date` (Node reads `TZ` lazily
on first use of its ICU/timezone data per process, so a later assignment can be ignored once a `Date` has
already been touched in that worker process). This is the only viable method for these four tests because
the functions under test (`readCalendarInput`, `isRunPastDue`, `buildExpiresAtIso`, and the local formatter
compared against `fmtCalendarDate` in T6) read the RUNTIME's local timezone via `getFullYear`/`getMonth`/
`getDate`/`setHours`/`toLocaleDateString` with no explicit timezone parameter — unlike the API's
`startOfCalendarDay`/`endOfCalendarDay`, which take an explicit IANA-zone argument and therefore need no TZ
env manipulation (T7-T9 pass the zone as a function argument instead, matching `invoices.service.spec.ts`'s
existing DST tests, which also pass the zone explicitly rather than setting `process.env.TZ`). Because a
Jest worker process can be reused across files, each of these test files restores `process.env.TZ` to its
original value in an `afterAll` for hygiene, and no other spec in `apps/web`/`apps/mobile` may assume a
default `TZ` — none currently does (grep confirms no existing spec reads `process.env.TZ`).

## Pins (no REG token; outside the red gate)

| T#  | Frozen behavior                                                                                                                                                                                                                                                                                                                          | File                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| T10 | `startOfCalendarDay`'s fixtures (from `invoices.service.spec.ts:7041-7049`, `:7075-7083` — tenant-tz, DST, invalid-zone) produce byte-identical output before and after the extraction into `apps/api/src/common/calendar-date.ts`                                                                                                       | `apps/api/src/common/calendar-date.pins.spec.ts`                                                             |
| T11 | The six existing `onTimeRate` assertions in `apps/api/src/analytics/analytics.service.spec.ts` (`:910`, `:939`, `:958`, `:1001`, `:1067`, `:1102`) stay green, unedited, once `accumulateRunMetrics` takes a `timeZone` parameter and every existing fixture leaves `tenantConfig` unstubbed (defaults to `null` per `createMockPrisma`) | `apps/api/src/analytics/analytics.service.spec.ts` (no new lines — verified by re-running the existing file) |

T12 (mirror-identity pin, MIRROR branch only) is **not written this run** — F1 established apps/web already
has its own Jest runner (WEB-JEST branch), so web's calendar-date helpers are proven directly (T1, T5, T6)
rather than only via mobile plus a body-diff pin.

## Harness notes (verified by the engine's harness-integrity check)

- **`analytics.service.spec.ts`'s Prisma mock tolerates a `tenantConfig` read returning `null`.**
  `apps/api/src/testing/prisma-mock.ts:31-56` gives every model (including `tenantConfig`, listed at
  `:115`) a `findUnique` that resolves `null` by default when a test does not stub it — confirmed by reading
  the file. No mock change is needed for the six existing `onTimeRate` fixtures to keep working under the
  new `timeZone` parameter (see `cause-ruling.md` §2's fallback-correction note) — this is the one-line
  remedy the harness-integrity check should find already satisfied, not a gap to fix.
- **`drivers.service.spec.ts` is out of this run's radius** (its `driverLocation` mock gap belongs to
  `2026-09-04-F25-location-bugfix`'s harness notes, not this one).
- **`apps/web/jest.config.js`** uses `testEnvironment: "jsdom"` with `setupFilesAfterEnv:
["<rootDir>/jest.setup.ts"]` and a `moduleNameMapper` pinning a single `react` instance — no TZ-related
  setup exists there today; T1/T6's `process.env.TZ` assignment is local to each test file and does not
  need a jest.config change.
- **`apps/mobile/jest.config.js`** uses `preset: "ts-jest"`, `testEnvironment: "node"`, `testMatch:
["**/__tests__/**/*.test.ts"]` — `run-lateness.test.ts` and `licenses.logic.test.ts` fit this glob
  unchanged; no config edit needed.

## Commands

- `redGate.commands`: scoped jest filtered to the REG tokens (`-t "REG-B"`); `expect: 'fail'` — see
  `build-plan.md`'s "## Pipeline args" block for the exact strings.
- The REG token(s) double as the registry proof lines at close-out: B90/B118 → `proven`; B59/B91 →
  `proven-pending-deploy` (their T2-tier oracle is e2e spec 34, deploy-only, per `feedback` L-041 — the
  jest REG tests here prove the client-side/server-side logic in isolation, but the full round-trip needs a
  deployed web build).

---

## Remediation-round amendments (2026-09-04, after the RED-gate audit)

The tables above are kept as written; these amendments override them where they conflict.

1. **The `process.env.TZ` pinning method is void.** An in-file `process.env.TZ = "<zone>"` is INERT
   under Jest — the worker gets a sandboxed `process.env`, so Node never reconfigures its zone
   (proved: `TZ=UTC npx jest edit-run-modal.logic.test` turned T1 green despite the pin). Every
   such line has been removed. **The zone is now passed as DATA**, via a test-only optional
   `timeZone` argument on each seam (`readCalendarInput`, `isRunPastDue`, `renderLicenceExpiry`) —
   the same pattern the API side already used (`startOfCalendarDay(date, timeZone)`). When the
   argument is omitted — the only way the production call sites call these — the body is
   byte-for-byte today's expression, so the extraction stays behavior-preserving. T5's oracle needed
   no zone at all: `"2027-01-01T00:00:00.000Z"` is unreachable in every zone, TZ=UTC included.
2. **T5 moved to `apps/mobile/__tests__/licence-expiry-iso.test.ts`.** Mobile's
   `testMatch` only collects `__tests__/**/*.test.ts`, so the old location under
   `app/(operator)/...` was never run. The seam file itself stays where it is (correctly wired).
3. **T6 rewritten and relocated** to
   `apps/web/app/(dashboard)/customers/_components/authorizations-expiry.logic.test.ts`, asserting a
   NEW seam `renderLicenceExpiry` (extracted verbatim from `AuthorizationsTab.tsx:273`'s
   `fmtDate(auth.expiresAt)`). The old oracle could not fail: `fmtCalendarDate` is already
   UTC-anchored and already correct, and the `fmtDate` comparator asserted today's
   to-be-removed behavior. `apps/web/lib/formatting.calendar-date.test.ts` survives as a
   **pin** (no REG token, outside the gate) covering `fmtCalendarDate`'s UTC anchoring.
4. **T4 and T8 renamed `GUARD-B90` / `GUARD-B118`** — they pass today by design, so the REG token
   put a passing test inside a gate where every selected test must fail. They stay in their files
   and in the full suite.
5. **`apps/api/src/common/calendar-date.ts` now holds a SIGNATURE-ONLY STUB.** The pins spec's
   unresolvable import was an ERROR that never reached an assertion and turned
   `npx jest src/common` and the whole API suite red for a harness reason. WP-API-CAL replaces
   the file wholesale. The pin's calls carry `?.` so the stub's `undefined` produces an assertion
   failure rather than a TypeError.
6. **Red-gate commands updated** in `pipeline-args.json` and `build-plan.md` to match the new
   filenames (`licence-expiry-iso.test`, `authorizations-expiry.logic.test`). The old mobile
   pattern `licenses.logic.test` also matched the unrelated pre-existing
   `__tests__/buyer-licenses-logic.test.ts`; the new one does not.

### ⚠️ Owed by the implementation packages (production edits were forbidden in this round)

- **WP-WEB must wire `EditRunModal.tsx` to `edit-run-modal.logic.ts`** (delete `formatLocalDate`
  at `:17-23` and the inline body construction at `:50-56`; import and call `readCalendarInput` +
  `buildRunPatchBody`, passing the seeded `initialDate`). Until then T1/T2 assert on an
  unreferenced duplicate and would go green with the shipped component still carrying both B59
  defects. Add `EditRunModal.tsx` to WP-WEB's file list.
- **WP-WEB must wire `AuthorizationsTab.tsx:273` to `renderLicenceExpiry`** (and add both
  `AuthorizationsTab.tsx` and `authorizations-expiry.logic.ts` to its file list). Same false-green
  risk for T6 otherwise.
