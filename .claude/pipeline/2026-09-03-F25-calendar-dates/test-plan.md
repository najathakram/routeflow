# Test plan: F25 calendar-date correctness

> **Stage S4 — "how we'll know".** Authored by Fable 5 on `2026-09-03`.
> Status: `APPROVED`
> **Written BEFORE the build plan and before any implementation code exists.**
> Requirement IDs `R#` come from [spec.md](./spec.md). Work packages in
> [build-plan.md](./build-plan.md) reference the `T#` ids defined here.
> No `ux-spec.md` — this batch is `ui: false`.

**Gate to pass before S5:** every `R#` maps to ≥1 `T#`; every `T#` names an `R#`; every
`T#` has an oracle; every `T#` has a stated reason it fails today.

**Numbering note:** T-ids in this plan are T1, T2, T5–T16 — T3 and T4 are deliberately unused
(reserved, not assigned to any test in this batch; there is no gap in coverage, see §3's
reverse check). Three additional artifacts are PINS with no T-number at all — T8, T11, and the
mobile mirror-identity pin — named explicitly in §6/§9 as outside the red gate and outside the
R↔T reverse check, since they protect an implementation detail (byte-identical extraction /
byte-identical mirror) rather than an independently observable behavior.

---

## 1. Strategy for this change

This is a **bug-fix residue sweep across three apps**: read-side formatter swaps (web, mobile),
one destructive-write fix (web), one new api helper extracted from existing tested code
(api), one additive DTO field (api + mobile), and one data-repair script (scripts). Nothing here
is a new user-facing surface. Web has no unit runner (campaign decision D1), so its two riskiest
sites (the destructive write, and one representative display site) are proven by a deploy-only
Playwright spec; every pure-logic piece that CAN be a jest unit is one, on the lowest level that
can fail for the right reason. Money is untouched throughout.

| Level       | Used here? | Why / why not                                                                                                                                                                                                                                                                                                                               |
| ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | yes        | the api day-boundary math, the DTO validation, the mobile pure helpers (calendar-date, location-sentinels) — all pure functions with hand-derivable expected values                                                                                                                                                                         |
| property    | no         | dates are touched, but the domain (calendar-day arithmetic across a fixed, known IANA zone) is small and enumerable — a hand-rolled table of boundary cases (T5–T7) gives the same confidence as a generator here without adding a dependency the repo does not have (`fast-check` is not installed; see spec.md §6 do-not-introduce check) |
| contract    | no         | no new wire shape serves multiple clients beyond the additive, optional `accuracy` field, which T9 already covers as a DTO unit                                                                                                                                                                                                             |
| integration | no         | `drivers.service.spec.ts`'s existing harness (mocked Prisma) is what T10 extends — one level up from a pure unit, but still not a real DB integration test, matching this file's existing convention                                                                                                                                        |
| e2e         | yes        | R1 (destructive write) and R2 (display-site render) are the two requirements a jest unit cannot prove, because they depend on the BROWSER's timezone, not the server's                                                                                                                                                                      |
| manual      | no         | nothing here is left to manual verification                                                                                                                                                                                                                                                                                                 |

**Rule applied:** prefer the lowest level that can fail for the right reason.

**Deliberately NOT tested, and why**:

- The other 6 of the 8 verified display sites beyond T2's one e2e assertion — proven instead by
  the mirror-identity pin (T15 covers the mobile mirror at the function level; the web sites all
  call the SAME `fmtCalendarDate` re-export, so once one e2e site is proven correct under a real
  browser timezone, the remaining sites' correctness reduces to "did this file import the right
  function", which is a code-review / mutation-probe concern, not a per-site e2e test — running 7
  more browser tests for the same formatter would be decoration, not evidence).
- `location-tracker.native.ts`'s iOS/Android platform branching itself (L-025) — the pure
  sentinel-mapping logic it CALLS is unit-tested (T12); the platform module that calls it is not
  executed by any automated runner in this repo (Expo Go cannot run it), so this file states
  plainly: the wiring from `location-tracker.native.ts:35-36,81-82` into `location-sentinels.ts`
  is verified by code review against the mutation-probe target, not by an executed test.
- `EditRunModal`'s other UI states (driver dropdown, notes field) — unchanged by this batch,
  already outside the scope fence (spec.md §4).

**Risk driving depth**: R1 (B59, Critical) is the one destructive, persistent write in this
batch — a driver reassignment silently corrupting a run's real scheduled date. That is the
highest-depth test in the plan (T1, asserting the exact ISO string on both the rendered page
AND the API's PATCH echo). R5 (B118) changes a reported KPI's historical meaning — proven with
three hand-derived instants including a DST boundary, because a day-boundary off-by-one-hour
bug is exactly the kind of thing that passes on non-DST test dates and fails in March/November.

**Characterization tests needed first?** Yes, one: T8 pins `startOfCalendarDay`'s current
behavior (3 fixtures including a DST day) BEFORE it is extracted from `invoices.service.ts`
into the new shared `common/calendar-date.ts` — the extraction must be provably behavior-
preserving, and `analytics.service.spec.ts`'s existing `onTimeRate` fixtures (`:910,:939,:958,
:1001`) must stay green throughout, since the null/unknown-zone → UTC fallback is exactly what
protects them.

---

## 2. Test table

| ID  | proves                                                        | level      | Given / When / Then                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Oracle — why the expected value is KNOWN                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | File                                                                                                                                                                                              | Fails today because                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | R1, R9                                                        | e2e        | **G** an API-created run scheduled for calendar day D (UTC midnight), viewed under `timezoneId: "America/Los_Angeles"` · **W** open `EditRunModal`, change the date to D+1, save · **T** the page shows D+1 and the API's own run detail returns `scheduledDate === "<D+1>T00:00:00.000Z"`                                                                                                                                                                                                                                                                                                                                                                       | Hand-computed ISO strings — D and D+1 are fixture-chosen dates, D+1's UTC-midnight ISO is arithmetic, not read off the implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `apps/web/e2e/34-calendar-dates.spec.ts`                                                                                                                                                          | `formatLocalDate` (EditRunModal.tsx:17-23) reads LA-local getters off a UTC-midnight instant, pre-filling and then persisting D−1, not D                                                                                                                                |
| T2  | R2, R8                                                        | e2e        | **G** a licence created via API with `expiresAt: "2026-11-01T00:00:00.000Z"` · **W** open the operator customers page (or buyer licenses page — see §2.1) under `timezoneId: "America/Los_Angeles"` · **T** the rendered text contains "Nov 1" (not "Oct 31")                                                                                                                                                                                                                                                                                                                                                                                                    | `fmtCalendarDate`'s own documented output format (`apps/web/lib/formatting.ts:55-65`, `toLocaleDateString("en-US",{timeZone:"UTC",month:"short",day:"numeric",year:"numeric"})` → `"Nov 1, 2026"`)                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/web/e2e/34-calendar-dates.spec.ts`                                                                                                                                                          | the site's current `new Date(x).toLocaleDateString()`/local `fmtDate` reads LA-local components off UTC midnight, rendering "Oct 31"                                                                                                                                    |
| T5  | R5                                                            | unit       | **G** tenant timezone `America/New_York`, `scheduledDate: "2026-06-10T00:00:00.000Z"` · **W** `completedAt: "2026-06-11T03:30:00.000Z"` (23:30 NY, still June 10 local) is folded via `accumulateRunMetrics` · **T** the stop counts on-time                                                                                                                                                                                                                                                                                                                                                                                                                     | Hand-derived: NY is UTC−4 in June (EDT); 2026-06-11T03:30Z = 2026-06-10T23:30 local — before the tenant-tz day-end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `apps/api/src/analytics/analytics.service.calendar.spec.ts`                                                                                                                                       | today's `dayEnd` is `setUTCHours(23,59,59,999)` on the UTC calendar date, i.e. `2026-06-10T23:59:59.999Z` = 19:59:59 EDT local — 03:30Z the NEXT UTC day already exceeds it                                                                                             |
| T6  | R5                                                            | unit       | **G** same tenant/run as T5 · **W** `completedAt: "2026-06-11T04:30:00.000Z"` (00:30 NY, now June 11 local) · **T** the stop counts LATE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Same NY UTC−4 offset arithmetic: 2026-06-11T04:30Z = 2026-06-11T00:30 local — past the tenant-tz day-end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `apps/api/src/analytics/analytics.service.calendar.spec.ts`                                                                                                                                       | today's UTC day-end (`2026-06-10T23:59:59.999Z`) already excludes this instant too, for the WRONG reason (it is comparing UTC-day to UTC-day, not tenant-day to tenant-day) — this case must be re-derived after the fix to confirm it is excluded for the RIGHT reason |
| T7  | R5                                                            | unit       | **G** tenant `America/New_York`, `scheduledDate: "2026-03-08T00:00:00.000Z"` (US spring-forward day; NY goes EST→EDT at 2am local) · **W** two sub-cases: `completedAt: "2026-03-09T03:59:59.000Z"` and `completedAt: "2026-03-09T04:00:00.000Z"` · **T** the first counts on-time, the second counts LATE                                                                                                                                                                                                                                                                                                                                                       | Hand-derived from IANA rules: March 8 is EST (UTC−5) until 2am March 9 EST-clock-time, then EDT (UTC−4); the tenant-tz day-end for March 8 is `2026-03-09T05:00:00.000Z` MINUS 1ms under the DST-safe derivation (build-plan.md's `endOfCalendarDay`: add 24h in UTC to March 8's UTC midnight → March 9T00:00:00Z, then take `startOfCalendarDay` of THAT instant in NY, which is 2026-03-09T05:00:00.000Z during EDT) — so `03:59:59Z` is before it (on-time) and `04:00:00Z` is at-or-after... **see §2.1 T7 for the exact derivation and the corrected boundary instant**, since the naive "add a fixed offset" approach silently gets DST wrong | `apps/api/src/analytics/analytics.service.calendar.spec.ts`                                                                                                                                       | today's UTC-only day-end never consults DST at all — it is a fixed `23:59:59.999Z` regardless of what date it is, so this exact case is not merely wrong, it is untested by the current code path                                                                       |
| T8  | (pin — protects R5's extraction, no independent R#)           | unit (pin) | **G** 3 fixtures for `startOfCalendarDay` (a plain UTC-offset date, a `America/New_York` date, a DST-transition date) captured from the CURRENT `invoices.service.ts` implementation · **W** the SAME 3 fixtures run against the extracted `common/calendar-date.ts#startOfCalendarDay` · **T** byte-identical output before and after the extraction                                                                                                                                                                                                                                                                                                            | The pin's own recorded "before" output — captured by running the CURRENT code first, not derived independently (this is what makes it a pin, not a fresh oracle)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `apps/api/src/common/calendar-date.pins.spec.ts`                                                                                                                                                  | does not exist yet — file is new; "fails" only in the sense that it cannot run until `common/calendar-date.ts` exists (see §6 wiring-error rule)                                                                                                                        |
| T9  | R6                                                            | unit       | **G** `PostLocationDto` validation · **W** three sub-cases: `accuracy: 4.5`, `accuracy: -1`, `accuracy` absent · **T** 4.5 passes validation, -1 fails validation (a `class-validator` error naming `accuracy`), absent passes validation                                                                                                                                                                                                                                                                                                                                                                                                                        | `@Min(0)` is the exact rule being added — the legal/illegal boundary is definitional, not derived                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `apps/api/src/drivers/dto/post-location.dto.spec.ts`                                                                                                                                              | `accuracy` does not exist on the DTO at all today — `class-validator`'s `whitelist:true`/`forbidNonWhitelisted:true` (main.ts:193-196) would 400 ANY payload carrying it, for the wrong reason (unknown property, not a range check)                                    |
| T10 | R6                                                            | unit       | **G** `drivers.service.spec.ts`'s existing mocked-Prisma harness · **W** `recordLocation` is called with a DTO carrying `accuracy: 3.2` · **T** the `driverLocation.create` call's `data` argument includes `accuracy: 3.2`                                                                                                                                                                                                                                                                                                                                                                                                                                      | Direct assertion on the mock's call arguments — the expected shape is the DTO's own field, not derived                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `apps/api/src/drivers/drivers.service.spec.ts` (existing file, new `describe("recordLocation")` block — none exists today per the discovery report)                                               | `recordLocation`'s `data` object (drivers.service.ts:105-116) has no `accuracy` key today — the assertion fails on `undefined`                                                                                                                                          |
| T11 | (pin — protects R6's untouched validators, no independent R#) | unit (pin) | **G** `PostLocationDto` · **W** `heading: -1` and `speedKph: -1` (unchanged from today) · **T** both still fail validation exactly as before (this batch does NOT relax those two fields — see spec.md non-goals; only the mobile CLIENT maps their sentinels away before sending)                                                                                                                                                                                                                                                                                                                                                                               | The DTO's own existing `@Min(0)` decorators — unchanged, so the pin's expected value is "still rejects", read directly off the current file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/api/src/drivers/post-location.pins.spec.ts`                                                                                                                                                 | does not exist yet — new pin file; would pass trivially today if written against the CURRENT dto.ts, which is exactly the point (it must keep passing after R6 ships)                                                                                                   |
| T12 | R6                                                            | unit       | **G** `normalizeLocationSample` (new pure mobile helper) · **W** four sub-cases: `{accuracy:-1, speed:-1, heading:-1, lat, lng}`; positive `accuracy`/`speed`/`heading`; `heading: null`; `speed: null` · **T** every negative or null sentinel on `accuracy`/`speed`/`heading` maps to `undefined`; positive values pass through unchanged; `lat`/`lng` are never touched                                                                                                                                                                                                                                                                                       | The sentinel mapping IS the requirement — iOS's documented `-1` for "unavailable" (per B185's evidence) and the existing `?? null` pass-through (location-tracker.native.ts:35-36,81-82) are the two states being normalized; expected values are definitional                                                                                                                                                                                                                                                                                                                                                                                       | `apps/mobile/__tests__/location-sentinels.test.ts`                                                                                                                                                | `lib/location-sentinels.ts` does not exist yet                                                                                                                                                                                                                          |
| T13 | R4                                                            | unit       | **G** a fixed "now" of `2026-03-08T12:00:00.000Z` (a DST-transition day, `America/New_York`) · **W** `calendarDayBounds("America/New_York", now)` · **T** returns `[start, end)` matching the driver route screen's already-correct semantics for the SAME calendar day                                                                                                                                                                                                                                                                                                                                                                                          | Hand-computed: March 8 00:00 NY local (EST, UTC−5) = `2026-03-08T05:00:00.000Z` (start); March 9 00:00 NY local (still EST until 2am, so still UTC−5 at midnight) = `2026-03-09T05:00:00.000Z` (end, exclusive) — see §2.1 T13 for the full derivation                                                                                                                                                                                                                                                                                                                                                                                               | `apps/mobile/__tests__/calendar-date.test.ts`                                                                                                                                                     | `calendarDayBounds` does not exist yet; the CURRENT exceptions.tsx pattern (`setHours(0,0,0,0)` on a `new Date(iso)`) uses the DEVICE's local zone, not the tenant's, and has no equivalent function to call                                                            |
| T14 | R1, R3, R9                                                    | unit       | **G** `isoFromCalendarDate`/`calendarDateFromIso` (new pure mobile helpers) · **W** `isoFromCalendarDate("2026-09-03")` · **T** returns `"2026-09-03T00:00:00.000Z"` exactly; `calendarDateFromIso(isoFromCalendarDate(x)) === x` for several fixture dates (round-trip); grep-level assertion that no helper path can produce a local-`23:59:59` string (the exact anti-pattern at `licenses.tsx:84` today)                                                                                                                                                                                                                                                     | UTC-midnight ISO construction is definitional (`YYYY-MM-DDT00:00:00.000Z`); round-trip is a property of the two functions being inverses, checked against several hand-picked dates including a DST-transition date and a year boundary                                                                                                                                                                                                                                                                                                                                                                                                              | `apps/mobile/__tests__/calendar-date.test.ts`                                                                                                                                                     | neither function exists yet; `licenses.tsx:84` currently constructs `` `${expiresAt}T23:59:59` `` — a string a correct `isoFromCalendarDate` would never produce                                                                                                        |
| T15 | R2                                                            | unit       | **G** `fmtCalendarDate` (mobile mirror, unchanged signature) · **W** input `"2026-11-01T00:00:00.000Z"`, formatted twice — once with the test process's `TZ` env var set to a UTC−8 zone, once to a UTC+9 zone (reset via `process.env.TZ` before/after each, in a `beforeEach`/`afterEach` pair — deterministic because `fmtCalendarDate` forces `timeZone:"UTC"` inside its own `toLocaleDateString` call, so the PROCESS-level `TZ` must NOT be able to change the output; asserting this at two opposite offsets is what proves the internal `timeZone:"UTC"` argument, not the environment, controls the result) · **T** both renders equal `"Nov 1, 2026"` | `fmtCalendarDate`'s own documented format string (`format-date.ts:32-38`, `style:"short"` branch) — same oracle basis as T2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/mobile/__tests__/calendar-date.test.ts`                                                                                                                                                     | this specific TWO-OFFSET assertion does not exist today — nothing currently proves the function is offset-independent, only that it happens to work in whatever zone the CI runner uses (UTC)                                                                           |
| T16 | R7                                                            | unit       | **G** the repair script's pure `recoverCalendarDay(storedIso, tz)` · **W** two sub-cases: `recoverCalendarDay("2026-11-02T04:59:59.000Z", "America/New_York")` (a pre-fix row: local 23:59:59 on Nov 1 EDT/UTC−4... see §2.1 for the exact offset check) and `recoverCalendarDay("2026-11-01T00:00:00.000Z", "America/New_York")` (an already-correct UTC-midnight row) · **T** the first returns `"2026-11-01"`; the second is reported unchanged/skipped                                                                                                                                                                                                       | Hand-derived: the first instant is exactly what `licenses.tsx:84`'s `` `${expiresAt}T23:59:59` `` construction would have produced for a user who typed "2026-11-01" while NY was on EDT (UTC−4) — `2026-11-01T23:59:59` local = `2026-11-02T03:59:59Z`... **see §2.1 T16** for the corrected instant and the EST/EDT boundary check on Nov 1 2026                                                                                                                                                                                                                                                                                                   | `apps/api/src/common/calendar-date.spec.ts` (imports the pure function from `apps/api/src/common/calendar-date.ts`; see build-plan.md WP-SCRIPT for how the `.mjs` script obtains the same logic) | `recoverCalendarDay` does not exist yet                                                                                                                                                                                                                                 |

### 2.1 Expanded cases

**T7 — DST boundary, exact derivation**

- **Given:** tenant timezone `America/New_York`; `RouteRun.scheduledDate =
"2026-03-08T00:00:00.000Z"` (the stored UTC-midnight symbolic stamp for calendar day March 8;
  the US 2026 spring-forward is 2026-03-08, 2:00am EST local → 3:00am EDT local, i.e. the
  transition instant is `2026-03-08T07:00:00.000Z`).
- **When:** `endOfCalendarDay("2026-03-08T00:00:00.000Z", "America/New_York")`, per
  build-plan.md's derivation: read `date`'s own UTC Y/M/D (March 8 — the storage convention
  guarantees this IS the intended calendar day), add one UTC calendar day to get March 9, then
  find the TRUE UTC instant of "March 9, 00:00:00" local wall-clock time in NY via the
  offset-correction pass (`localMidnightUtc`): guess `"2026-03-09T00:00:00.000Z"`, read what
  that guess shows as NY-local (`Intl.DateTimeFormat`) — at that instant NY has been on EDT
  (UTC−4) since the `07:00:00Z` transition many hours earlier, so the guess reads as
  `"2026-03-08T20:00:00"` local, i.e. the guess-as-shown, reinterpreted as UTC, is
  `"2026-03-08T20:00:00.000Z"` — 4 hours BEHIND the guess. The correction subtracts that
  (negative) 4-hour difference from the guess, i.e. ADDS 4 hours: `"2026-03-09T00:00:00.000Z" +
4h = "2026-03-09T04:00:00.000Z"`. Subtract 1ms for the day-end convention.
- **Then:** the boundary is `"2026-03-09T03:59:59.999Z"`; `completedAt:
"2026-03-09T03:59:59.000Z"` → on-time (before it); `completedAt: "2026-03-09T04:00:00.000Z"` →
  LATE (after it).
- **Oracle:** IANA `America/New_York` 2026 DST transition (`2026-03-08T07:00:00Z`) plus the
  single-correction `localMidnightUtc` derivation in build-plan.md, worked by hand above and
  cross-checked against T13 (which derives the adjacent START boundary independently and must
  agree with this END boundary, since both describe the same physical midnight).
- **Fails today because:** the current code's `dayEnd` is `new Date(run.scheduledDate)` with
  `setUTCHours(23,59,59,999)` — for `scheduledDate="2026-03-08T00:00:00.000Z"` that is always
  `"2026-03-08T23:59:59.999Z"` regardless of DST, so BOTH T7 sub-case instants (which are on
  March 9 UTC) already read as "late" today, for a reason unrelated to the tenant's actual
  calendar day.

**T13 — `calendarDayBounds`, exact derivation**

- **Given:** `America/New_York`, fixed "now" = `2026-03-08T12:00:00.000Z`. At this instant NY is
  already on EDT (UTC−4) — it is 5 hours after the `07:00:00Z` spring-forward transition — so
  local time is `08:00` on calendar day **March 8**.
- **When:** `calendarDayBounds("America/New_York", "2026-03-08T12:00:00.000Z")`.
- **Then:**
  - `start` = `localMidnightUtc(2026, 3, 8, "America/New_York")`: guess
    `"2026-03-08T00:00:00.000Z"`; at THAT instant (before the `07:00:00Z` transition) NY is still
    EST (UTC−5), so the guess reads as `"2026-03-07T19:00:00"` local — 5 hours behind the guess.
    Correction adds 5 hours: `start = "2026-03-08T05:00:00.000Z"`.
  - `end` (exclusive) = `localMidnightUtc(2026, 3, 9, "America/New_York")` = the SAME
    computation T7 performs for its next-day boundary = `"2026-03-09T04:00:00.000Z"`.
- **Oracle:** same IANA transition table as T7, worked independently for the START boundary
  (T7 works the END boundary of the PREVIOUS calendar day — the two must and do agree, since
  T13's `end` and T7's pre-subtraction boundary are the identical instant).
- **Fails today because:** no `calendarDayBounds` function exists; the closest analogue
  (`exceptions.tsx:42-43`'s `today.setHours(0,0,0,0)`) operates on the DEVICE's local zone, not
  `America/New_York`, and returns a single `Date` (start-of-day only), not a `[start, end)` pair.

**T16 — `recoverCalendarDay`, exact derivation**

- **Given:** `licenses.tsx:84` builds `expiresAt` as ``new Date(`${expiresAt.trim()}T23:59:59`).toISOString()``
  where `expiresAt.trim()` is a `YYYY-MM-DD` string typed by an operator on a device whose LOCAL
  zone is assumed, for this fixture, to be `America/New_York`. If the operator typed "2026-11-01"
  on 2026-11-01 (before the Nov 1 2026 fall-back at 2am EDT→1am EST, i.e. still EDT, UTC−4) then
  `"2026-11-01T23:59:59"` local (already past the 2am fall-back, so EST, UTC−5) serializes to
  `"2026-11-02T04:59:59.000Z"`.
- **When:** `recoverCalendarDay("2026-11-02T04:59:59.000Z", "America/New_York")`.
- **Then:** returns `"2026-11-01"` — the calendar day whose LOCAL 23:59:59 the stored instant
  falls on, found by subtracting a small epsilon or by asking `Intl.DateTimeFormat` for the
  NY-local calendar day of an instant a few hours before the stored one is not required; the
  correct implementation asks directly: the NY-local calendar day of
  `"2026-11-02T04:59:59.000Z"` itself (via `Intl.DateTimeFormat` with `timeZone:"America/New_York"`)
  is **November 1** (04:59:59 UTC = 23:59:59 EST local on Nov 1 — the fall-back already
  happened), so `recoverCalendarDay` is simply "format the stored instant's LOCAL calendar day in
  the tenant's tz" — no epsilon subtraction needed, because the writer always stored a LOCAL
  23:59:59, which never crosses into the next LOCAL calendar day.
- **Second sub-case:** `recoverCalendarDay("2026-11-01T00:00:00.000Z", "America/New_York")` — a
  row already written correctly (UTC midnight) — its NY-local calendar day is October 31 (UTC
  midnight = 20:00 local the PREVIOUS day), which is NOT what a correct row's intended day is (it
  is Nov 1). This is exactly why the script must check whether the stored instant's TIME-OF-DAY
  is midnight UTC first, and only apply the tz-local-day recovery to NON-midnight rows — the
  build-plan's script skips any row whose UTC time-of-day is already `00:00:00.000` (see
  build-plan.md WP-SCRIPT), reporting it unchanged rather than mis-recovering it.
- **Oracle:** the writer's own construction (`licenses.tsx:84`), worked forward by hand for a
  fixture date; the IANA NY fall-back transition for 2026-11-01.
- **Fails today because:** `recoverCalendarDay` does not exist yet.

---

## 3. Coverage matrix

| R# | Requirement (short) | Priority | Covered by | Deepest level of cover |
|---|---|---|---|
| R1 | EditRunModal reads/writes UTC calendar date, no destructive rewrite | must | T1 | e2e |
| R2 | 8 display sites render via fmtCalendarDate / mirror | must | T2, T15 | unit (T15) + e2e (T2) |
| R3 | mobile licence writer stores UTC midnight | must | T14 | unit |
| R4 | mobile Exceptions day-bounds match driver-screen semantics | must | T13 | unit |
| R5 | On-time = tenant-tz day-end, DST-safe | must | T5, T6, T7, T8 (pin) | unit |
| R6 | GPS sentinel mapping + optional accuracy DTO + persistence | should | T9, T10, T11 (pin), T12 | unit |
| R7 | repair script recovers pre-fix licence rows | should | T16 | unit |
| R8 | spec 34 + project entry ship in this PR | must | (process check, §6 note — not a T#) | n/a |
| R9 | no NEW local-time read/write introduced | must | T1, T14 (direct assertions) + mutation-probe targets (build-plan.md) | unit + e2e + review |

**Reverse check — every T# names an R#:**

| T#  | proves     | Would it still pass with the feature removed? (must be "no")                                                                                                                                                              |
| --- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | R1, R9     | no — reverting `EditRunModal` to `formatLocalDate` makes the PATCH echo the day BEFORE the edited date under `timezoneId: America/Los_Angeles`                                                                            |
| T2  | R2, R8     | no — reverting the display site to `toLocaleDateString`/local `fmtDate` renders "Oct 31" instead of "Nov 1" under the LA timezone                                                                                         |
| T5  | R5         | no — the current UTC-only `dayEnd` scores this stop late, not on-time                                                                                                                                                     |
| T6  | R5         | no — passes today for the wrong reason (see the test table's "fails today because"); the FIX changes what makes it pass, which the pin (T8) and the DST case (T7) jointly guard against a false-positive read of T6 alone |
| T7  | R5         | no — the current UTC-only day-end has no DST awareness at all; both sub-cases read against a fixed `23:59:59.999Z` regardless of the actual boundary                                                                      |
| T8  | (pin)      | no — a behavior-changing extraction would change at least one of the 3 fixture outputs                                                                                                                                    |
| T9  | R6         | no — `accuracy` does not exist on the DTO today; the whole test errors on an unknown property before it can assert pass/fail per case                                                                                     |
| T10 | R6         | no — `driverLocation.create`'s mock call today never includes an `accuracy` key                                                                                                                                           |
| T11 | (pin)      | no — if heading/speed validation is accidentally relaxed alongside R6, this pin catches it                                                                                                                                |
| T12 | R6         | no — `location-sentinels.ts` does not exist yet                                                                                                                                                                           |
| T13 | R4         | no — no `calendarDayBounds` function exists to call                                                                                                                                                                       |
| T14 | R1, R3, R9 | no — neither `isoFromCalendarDate` nor `calendarDateFromIso` exists yet                                                                                                                                                   |
| T15 | R2         | no — no test today proves `fmtCalendarDate` is offset-independent at two opposite process `TZ` settings                                                                                                                   |
| T16 | R7         | no — `recoverCalendarDay` does not exist yet                                                                                                                                                                              |

**Deliberately untested requirements:**

- `R8` — proven by a process check (`npx playwright test --list`), not a `T#` unit/e2e test; see
  §6's note. The compensating control is that the spec itself (T1/T2's file) is what `--list`
  discovers — if the project entry or spec file is malformed, `--list` fails loudly, and no
  human sign-off is substituted for that check.

---

## 4. Negative tests — what must NOT happen

| ID | Must NOT happen | Level | Assertion | File |
|---|---|---|---|
| T9 (sub-case) | An out-of-range `accuracy` (`-1`) is accepted by the DTO | unit | validation error naming `accuracy`; no downstream `recordLocation` call is reachable with that value | `apps/api/src/drivers/dto/post-location.dto.spec.ts` |
| T11 | `heading`/`speedKph` validation is accidentally loosened as a side effect of adding `accuracy` | unit (pin) | both fields still reject `-1` exactly as before | `apps/api/src/drivers/post-location.pins.spec.ts` |
| T1 (negative half) | `EditRunModal`'s PATCH includes `scheduledDate` when the date input was never touched | e2e | the API request body captured by the spec does NOT carry a `scheduledDate` key on a driver-only edit; the run's date is unchanged after save | `apps/web/e2e/34-calendar-dates.spec.ts` |
| T16 (sub-case) | An already-correct UTC-midnight row is "recovered" into the wrong (previous) day | unit | `recoverCalendarDay` on a midnight-UTC input returns "unchanged/skip", never a shifted day | `apps/api/src/common/calendar-date.spec.ts` |
| T8 | The `startOfCalendarDay` extraction silently changes behavior for ANY of the 3 pinned fixtures | unit (pin) | byte-identical output pre/post extraction | `apps/api/src/common/calendar-date.pins.spec.ts` |

---

## 5. Property-based invariants

Touched: `dates`

No generator-based property tests are added (see §1 — `fast-check` is not installed and the
domain is small/enumerable). The invariant "day-boundary comparisons are DST-safe" is instead
covered by T7's explicit spring-forward case table (hand-derived, §2.1) plus T13's independent
derivation of the START boundary on the same transition day — two independently-worked
boundaries on the same DST day stand in for a generator here, since a generator would still need
a hand-verified oracle function to compare against (which is what T7/T13 already are).

**Library:** none — hand-rolled table of cases (`fast-check` is not a dependency of `apps/api`
or `apps/mobile`; adding one would violate spec.md §6's do-not-introduce check for a batch this
small).

---

## 6. Red gate

```bash
# Runs ONLY the tests added by this plan — scoped by path, never the whole suite.
cd apps/api && npx jest src/analytics/analytics.service.calendar.spec.ts src/drivers/dto/post-location.dto.spec.ts src/common/calendar-date.spec.ts --runInBand && cd ../mobile && npx jest __tests__/calendar-date.test.ts __tests__/location-sentinels.test.ts
```

T10 is added to the EXISTING `apps/api/src/drivers/drivers.service.spec.ts` — if it lands there,
re-run the gate scoped further with `-t "REG-B185"` against that file so the whole (large,
pre-existing) spec file is not required to be red; if T10 instead lands in a new file (see
build-plan.md TP1's own note on this), add that file's path to the command above.

| T#  | Expected failure message (approximate)                                                                                                                                                                                                                                                           | Failure kind               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| T5  | `expected onTimeStops to include this stop, got 0` (or equivalent — stop excluded from on-time count)                                                                                                                                                                                            | assertion                  |
| T6  | test passes today for the wrong reason; after the fix's helper exists but before it is WIRED into `analytics.service.ts`, expect the SAME false-pass — this row is guarded by T7 and T8 catching the wiring gap, not by T6 alone going red pre-implementation                                    | assertion (via T7/T8)      |
| T7  | `expected late, received on-time` (first sub-case) or the reverse (second sub-case) — the current UTC-fixed boundary gets at least one of the two wrong                                                                                                                                          | assertion                  |
| T9  | `Cannot read property 'accuracy' of dto` or a `class-validator` "property accuracy should not exist" whitelist error (before the field is added) → after the field is added but before this test exists, expect a straightforward `expected validation to fail, but it passed` for the `-1` case | assertion                  |
| T12 | `Cannot find module './location-sentinels'` guarded per the wiring-error rule below — first assertion is `typeof normalizeLocationSample === "function"`, then behavioral assertions                                                                                                             | assertion (guarded import) |
| T13 | `calendarDayBounds is not a function` guarded the same way; then `expected start to equal 2026-03-08T05:00:00.000Z, received <import error / undefined>`                                                                                                                                         | assertion (guarded import) |
| T14 | `isoFromCalendarDate is not a function` guarded; then `expected 2026-09-03T00:00:00.000Z, received undefined`                                                                                                                                                                                    | assertion (guarded import) |
| T15 | `expected "Nov 1, 2026" at TZ=Pacific/Midway, received "Oct 31, 2026"` or similar offset leakage, OR a guarded-import failure if `apps/mobile/lib/calendar-date.ts` does not yet re-export it                                                                                                    | assertion                  |
| T16 | `recoverCalendarDay is not a function` guarded; then `expected "2026-11-01", received undefined`                                                                                                                                                                                                 | assertion (guarded import) |

Rules for the gate:

- A failure that is not an assertion means the test is broken, not the feature missing.
  Fix the test — one remediation round — then re-run.
- Every new-symbol test above (T9 partially, T12–T16 fully) targets a module this change
  CREATES — each guards its import (first assertion = "export exists", via a dynamic
  `require`/`import` in a `try/catch`, or by asserting `typeof fn === "function"` before calling
  it) so its absence surfaces as an assertion, per the TESTING-PLAYBOOK's wiring-error rule.
- A test that passes before implementation is vacuous. Delete or strengthen it; never carry it
  forward. (T6 is the one row in this plan that risks this — see its red-gate note above; T7 and
  T8 are what keep it honest.)
- Record the actual red output before implementation starts.
- **T1/T2 are NOT in this red gate** — they are e2e, deploy-only (T2 tier in the discovery
  report), and are proven post-deploy against the live site, matching every other T2-tier spec
  in this repo (`23-run-settlement-note.spec.ts`, `24-order-edit-pricing.spec.ts`,
  `27-cancelled-edit-banner.spec.ts`). `npx playwright test --list --reporter=list` (never
  `test` — never run locally, per house rule) is what discharges R8 pre-merge.
- **T8 and T11 (pins) are outside this gate** per ruling — they protect behavior-preservation of
  an extraction/an unchanged validator, not a new requirement; they still must exist and pass
  once the implementation lands, just not as part of the RED proof.

---

## 7. Test data and fixtures

| Need                                | How the test creates it                                                                                                                                                                                                                             | Scope / isolation                                                                                                            | Cleanup                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| An operator session (web e2e)       | `storageState: operator.json` via the `calendar-dates` Playwright project (`dependencies: ["setup"]`)                                                                                                                                               | shared pre-authenticated session, read-only use (no session-mutating action in this spec — unlike the L-050 quarantine case) | n/a — no session mutation                                                                                      |
| A throwaway route + run (T1)        | Self-provisioned via API inside the spec, named `E2E B59 Run <suffix>` where `<suffix> = Date.now()`, mirroring `23-run-settlement-note.spec.ts`'s own fixture pattern (`page.goto("/routes")`, `operatorAccessToken(page)`, `apiBase(page.url())`) | disposable, unique per run, on the approved `e2e-routeflow` tenant                                                           | not deleted — a throwaway SCHEDULED run reads as disposable, same residue tolerance as 21/22/23's own fixtures |
| A throwaway licence (T2)            | Self-provisioned via the licence-creation API with a unique holder/customer name `E2E B91 <suffix>`, `expiresAt: "2026-11-01T00:00:00.000Z"` fixed                                                                                                  | disposable, unique per run, approved tenant                                                                                  | not deleted — same tolerance                                                                                   |
| Tenant-timezone fixtures (api unit) | In-memory `TenantConfig` mock object / direct function args — `analytics.service.calendar.spec.ts` calls `accumulateRunMetrics`/the helper directly, no DB                                                                                          | fully isolated, no shared state                                                                                              | n/a — pure function calls                                                                                      |
| A mocked Prisma driver/tenant (T10) | The EXISTING harness in `drivers.service.spec.ts` (already used by `findAll`/`findOne`/etc. — see discovery report)                                                                                                                                 | isolated per test via the existing mock reset pattern                                                                        | n/a                                                                                                            |
| A fixed process `TZ` (T15)          | `process.env.TZ = "Pacific/Midway"` / `"Pacific/Apia"` (or equivalent UTC−8/UTC+9 zones) set in the test, restored in `afterEach` from a saved original value                                                                                       | isolated per test file — never left mutated for a later file in the same jest worker                                         | `afterEach` restores `process.env.TZ`                                                                          |

- Never assert against data anyone or anything else can change.
- Never reuse a shared long-lived record as a fixture; a parallel run will race it.
- Auth/session state: `operator.json` (the shared pre-authenticated storageState). This spec
  does not mutate shared auth, so it carries none of L-050's risk — no dedicated user is needed
  (L-050 applies only to a spec that REVOKES or otherwise mutates shared session state, which
  neither T1 nor T2 does).
- Any step that writes to a real environment targets only `e2e-routeflow` (the approved e2e
  regression tenant) — enforced at import time by `apps/web/e2e/helpers/constants.ts`'s
  `assertTestTenant`.

---

## 8. UI flows to drive (Playwright)

| #   | Flow (plain language)                                                                                                                         | Assertion                                                                                                                       | Viewport |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Create a run for calendar day D via API; open Edit Route Run under a Los-Angeles-timezone browser; change the date to D+1; save               | The modal's date field showed D (not D−1) on open; after save the page and the API's own run-detail read both show D+1, exactly | desktop  |
| 2   | Create a licence with `expiresAt` fixed to 2026-11-01T00:00:00.000Z via API; open the page that renders it under the same LA-timezone browser | The rendered text shows "Nov 1" (never "Oct 31")                                                                                | desktop  |

- **Page URL:** `/routes` (flow 1, opens `EditRunModal` from the route/run list) and the licence
  display page identified by T2's chosen site (buyer or operator licences — see §2.1's note that
  the fixture is self-provisioning and does not depend on a pre-existing regulated category) ·
  **Start command:** none — both flows run against the DEPLOYED site (`PLAYWRIGHT_BASE_URL`),
  never a local dev server, matching every other T2-tier spec in this repo.
- **Checks alongside:** `console-errors`, `network-failures` — no `a11y`/`design-system` checks,
  since `ui: false` (no design surface is added or changed).
- Locate by role/label where the existing markup allows it; the date `<input>` in
  `EditRunModal.tsx:99-104` has NO `data-testid` and its `<label>` is not `htmlFor`-bound
  (discovery report, verbatim) — the spec locates it structurally (nearest `input[type=date]`
  within the modal's container) rather than adding a test id, since adding one would be a UI
  change this batch's `ui: false` scope does not cover; if this proves unreliable in practice,
  build-plan.md's implementer package may add `data-testid="edit-run-scheduled-date"` as a
  minimal, non-visual exception — call this out explicitly in the PR if it happens.
- Assert with auto-retrying web-first assertions (`expect(locator).toHaveText(...)` etc.) —
  never a fixed wait.

---

## 9. Mutation probe targets

_Only the **Behavior to protect** column is handed to the probe agent. The **Defect to inject**
column is planning prose._

| #   | File                                                                    | Behavior to protect (→ `behavior`)                                           | Defect to inject (a real behavior change, not a syntax break)                   | Test that MUST go red |
| --- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------- |
| 1   | `apps/api/src/common/calendar-date.ts`                                  | `endOfCalendarDay` is the tenant-tz day end, DST-safe                        | replace the two-step `Intl` derivation with a flat `+24h` UTC add               | T5, T6, T7            |
| 2   | `apps/api/src/analytics/analytics.service.ts`                           | on-time compares against the TENANT-tz day end, not the UTC day end          | revert the comparison to `setUTCHours(23,59,59,999)` on the raw `scheduledDate` | T5                    |
| 3   | `apps/api/src/drivers/dto/post-location.dto.ts`                         | `accuracy < 0` is rejected                                                   | drop the `@Min(0)` decorator from `accuracy`                                    | T9                    |
| 4   | `apps/mobile/lib/location-sentinels.ts`                                 | negative/null sentinels become `undefined`                                   | invert the check (`>= 0` becomes the undefined case)                            | T12                   |
| 5   | `apps/mobile/lib/calendar-date.ts`                                      | `isoFromCalendarDate` yields UTC midnight, never local                       | append the local offset instead of forcing `T00:00:00.000Z`                     | T14                   |
| 6   | `apps/mobile/lib/calendar-date.ts`                                      | `calendarDayBounds` matches the driver-screen semantics on a DST day         | drop the DST-aware second `Intl` pass, falling back to a flat 24h add           | T13                   |
| 7   | `apps/api/src/common/calendar-date.ts` (the script's imported function) | `recoverCalendarDay` interprets the stored instant in the TENANT tz, not UTC | hardcode `"UTC"` instead of the passed `tz` argument                            | T16                   |

If the named test still passes with the defect in place, that test is decoration. Strengthen it
before the change ships.

---

## 10. Flake risks

| Risk                                                              | Where                          | How it is removed (removed, not retried)                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser/CI runner timezone (UTC) masking the bug                  | T1, T2                         | `use.timezoneId: "America/Los_Angeles"` on the `calendar-dates` Playwright project — the whole reason this spec exists is that GitHub runners are UTC, where these bugs are accidentally correct (discovery report, verbatim) |
| Process-level `TZ` bleeding between jest tests in the same worker | T15                            | explicit `beforeEach`/`afterEach` save/restore of `process.env.TZ`, never left mutated for a sibling test                                                                                                                     |
| Clock/timezone/date boundary                                      | T5–T8, T13, T16                | every date in this plan is a FIXED, hand-picked ISO string passed as a function argument — no test reads the real "now" except T13's `calendarDayBounds`, whose "now" is itself a fixed fixture argument, not `new Date()`    |
| Shared or mutable fixture data                                    | T1, T2                         | per-run unique `Date.now()`-suffixed names, self-provisioned via API, never asserting against a shared seed row                                                                                                               |
| Ordering dependence between tests                                 | all                            | every test builds its own state via direct function args or its own API fixture; no test reads state a sibling test wrote                                                                                                     |
| Network or third-party call                                       | T1, T2 only (by nature of e2e) | these two ARE the tagged, deploy-only, real-network tests; everything else is a pure unit with zero network                                                                                                                   |

---

## 11. Regression watch

- **Runs on every push:** T5–T12, T13–T16 (api + mobile jest, all cheap pure-function/mocked-
  Prisma unit tests) — cheap enough to run on every push, and this is exactly the api/mobile
  jest suite already wired into CI.
- **Runs post-deploy only (deploy-signal e2e, never dispatched manually):** T1, T2 — matching
  every other T2-tier spec in this repo (L-041: read STEP conclusions, not the job's).
- **How this regresses unnoticed in six months, and the check that catches it:** a future PR
  reimplementing a display site without importing `fmtCalendarDate`/the mirror would not be
  caught by T15 (which only pins the FORMATTER function itself, not every call site) — the
  compensating control is the mutation-probe targets recorded here plus a future batch's own
  L-008-scoped read of this file before touching any of the 8 sites again. The pins (T8, T11)
  catch silent behavior drift in the EXTRACTED/unchanged pieces specifically.
- A green replay from a build cache is not evidence a test ran (L-034) — trust only the runner's
  own report of work actually performed; `verifyCommands.final` in build-plan.md forces direct
  `npx jest`, not a cached `turbo run test`.
