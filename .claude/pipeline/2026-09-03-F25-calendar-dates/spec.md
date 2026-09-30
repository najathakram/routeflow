# Spec — what F25 calendar-date correctness must do

**Status:** `APPROVED`
**Stage:** S2 — Spec (what) · **Author:** Fable 5 · **Date:** 2026-09-03
**Lives at:** `.claude/pipeline/2026-09-03-F25-calendar-dates/spec.md`
**Prev:** [discovery.md](./discovery.md) · **Next:** [test-plan.md](./test-plan.md)
(this batch changes no design — `ux-spec.md` is NOT written, `ui: false`)

> **This file is the only context downstream agents receive about _what_ to build.** The test
> plan, the build plan, the implementers and the review lenses read these requirement IDs and
> nothing else. An unwritten requirement will not be built, will not be tested, and will not be
> reviewed.

---

## 1. Core capability, in one sentence (G2·Q1)

> A calendar-date field (a run's scheduled date, a licence's expiry, a promotion's window, the
> On-Time % day boundary) shows, edits, and evaluates the same calendar day no matter which
> timezone the viewer, the server, or the tenant sits in — and a driver's GPS ping is accepted
> whenever iOS reports "unavailable" for heading or speed instead of being silently rejected.

## 2. Core use cases, in priority order (G2·Q2)

| #   | Use case (actor → action → outcome)                                                                                                                                          | Priority | Justifies shipping |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------ |
| U1  | As an operator, I edit a route run's driver in `EditRunModal` so that the run's scheduled date is NEVER changed by an edit that did not touch the date field                 | must     | ★                  |
| U2  | As an operator or buyer, I view a licence expiry, a run's scheduled date, or a promotion window so that it shows the correct calendar day regardless of my device's timezone | must     |                    |
| U3  | As a tenant owner, I read the On-Time % KPI so that a delivery completed in the evening, local time, on its scheduled day counts as on-time                                  | must     |                    |
| U4  | As an operator, I view the mobile Exceptions screen so that an on-schedule IN_PROGRESS run is never flagged "Late route"                                                     | must     |                    |
| U5  | As a driver on iOS, my GPS ping is accepted by the server even when my device reports heading or speed as unavailable (`-1`)                                                 | should   |                    |
| U6  | As the platform owner, I run a repair script to normalize pre-fix licence rows a known writer stored with a non-midnight UTC time-of-day                                     | should   |                    |

_U1 carries the ★: it is the only use case in this batch with a destructive, persistent write
(B59, Critical severity) — a driver reassignment must never silently corrupt the run's date.
Every other use case is a read-side or additive-validation fix._

## 3. Completeness sweep (G2·Q3)

| Lifecycle step                                                                    | What it means for this feature                                                         | Decision | Req IDs | Note / why deferred                                                                                                                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create                                                                            | A run/licence/promotion is created with a calendar-date field                          | n/a      | —       | Creation paths for these fields are unchanged by this batch; only edit (R1) and read (R2, R3) paths move                                                 |
| Read (detail)                                                                     | Viewing one run/licence/promotion/finance row                                          | keep     | R2      | The 8 verified display sites                                                                                                                             |
| List / filter / search                                                            | Analytics KPI aggregation over many runs                                               | keep     | R5      | On-Time % is a list-level aggregate, not a single detail read                                                                                            |
| Edit / update                                                                     | Editing a run's scheduled date via `EditRunModal`                                      | keep     | R1      | The only write path this batch touches                                                                                                                   |
| Delete / archive                                                                  | n/a                                                                                    | n/a      | —       | No delete/archive path touches a calendar-date field in this batch's scope                                                                               |
| Undo / reverse                                                                    | Re-opening `EditRunModal` and saving again without changing the date                   | keep     | R1      | R1's fix is precisely what makes repeated saves idempotent on the date                                                                                   |
| Permissions                                                                       | Which role may edit a run / GPS ping auth                                              | n/a      | —       | Unchanged — this batch adds no new permission surface; existing role gates on `EditRunModal`'s save action and `POST /drivers/me/location` are untouched |
| Audit trail                                                                       | n/a                                                                                    | n/a      | —       | No new audit trail; existing `AuditLog` writes (if any) on these paths are unchanged                                                                     |
| Notification                                                                      | n/a                                                                                    | n/a      | —       | No notification touches a calendar-date field in this batch                                                                                              |
| Export / print / share                                                            | n/a                                                                                    | n/a      | —       | No export/PDF path is in the verified-site list                                                                                                          |
| Repair (added row — this batch is a residue sweep with known-bad historical data) | Pre-fix licence rows written by one mobile screen carry a non-midnight UTC time-of-day | keep     | R7      | Owner-run, dry-run by default (D4)                                                                                                                       |
| Ingest / validate (added row — B185)                                              | A driver's GPS ping reaches the server and is validated                                | keep     | R6      | DTO gains an optional `accuracy`; sentinel mapping happens client-side before POST                                                                       |

_Every action kept above has its reverse considered: R1's "undo" is a second save with the same
date, which must be a true no-op on `scheduledDate` (T1 asserts exactly this)._

## 4. States, per surface (G2·Q4)

### Surface: EditRunModal — web (R1)

| State                    | Required behavior (what the user sees and can do)                                                                                                                       | Req ID |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Empty                    | n/a — the modal always opens against an existing run                                                                                                                    | R1     |
| Loading                  | Unchanged — existing `useDrivers`/`useDriver` loading states, not touched by this fix                                                                                   | n/a    |
| Partial                  | n/a — no partial-load state exists for this modal today                                                                                                                 | n/a    |
| Error                    | Unchanged — `onError` toast on a failed PATCH, not touched                                                                                                              | n/a    |
| Offline / request failed | Unchanged — no offline queueing for this modal                                                                                                                          | n/a    |
| Unauthorized             | Unchanged — existing role gate on the update-run endpoint                                                                                                               | n/a    |
| Too much data            | n/a                                                                                                                                                                     | n/a    |
| Stale                    | n/a — the date input value comes from `run.scheduledDate` at modal-open time, unchanged behavior                                                                        | n/a    |
| Concurrent edit          | Unchanged — last-write-wins on the PATCH, as today; R1 does not change concurrency semantics, only which date value is computed and whether it is included in the PATCH | n/a    |

### Surface: the 8 verified display sites — web + mobile (R2)

| State                    | Required behavior (what the user sees and can do)                                                                                                                           | Req ID |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Empty                    | Unchanged per site (e.g. `AuthorizationsTab.tsx:273` already guards `auth.expiresAt ?` before formatting) — this batch changes only which formatter runs on a present value | R2     |
| Loading                  | Unchanged                                                                                                                                                                   | n/a    |
| Partial                  | Unchanged                                                                                                                                                                   | n/a    |
| Error                    | Unchanged — `fmtCalendarDate` already returns `"—"`/`""` for null/invalid input at every site                                                                               | R2     |
| Offline / request failed | Unchanged                                                                                                                                                                   | n/a    |
| Unauthorized             | Unchanged — no auth change                                                                                                                                                  | n/a    |
| Too much data            | Unchanged — no pagination/rendering-volume change                                                                                                                           | n/a    |
| Stale                    | Unchanged                                                                                                                                                                   | n/a    |
| Concurrent edit          | n/a — display-only sites                                                                                                                                                    | n/a    |

### Surface: Operations tab On-Time % — web, reading api/analytics (R5)

| State                    | Required behavior (what the user sees and can do)                                                                                            | Req ID |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Empty                    | No completed stops in the window → `onTimeRate: null` (unchanged; `finalizeRunMetrics` already returns `null` for a zero-denominator window) | R5     |
| Loading                  | Unchanged                                                                                                                                    | n/a    |
| Partial                  | n/a — the aggregation is a single query per call                                                                                             | n/a    |
| Error                    | Unchanged                                                                                                                                    | n/a    |
| Offline / request failed | n/a                                                                                                                                          | n/a    |
| Unauthorized             | Unchanged — existing role gate on analytics endpoints                                                                                        | n/a    |
| Too much data            | Unchanged — no change to the query's row volume                                                                                              | n/a    |
| Stale                    | n/a                                                                                                                                          | n/a    |
| Concurrent edit          | n/a — read-only aggregate                                                                                                                    | n/a    |

### Surface: mobile Exceptions screen (R4)

| State                    | Required behavior (what the user sees and can do)                                                                                                                       | Req ID |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Empty                    | No IN_PROGRESS runs / no late runs → unchanged empty state                                                                                                              | R4     |
| Loading                  | Unchanged (`isLoading` combinator, not touched)                                                                                                                         | n/a    |
| Partial                  | Unchanged — the three source queries (`urgentOrdersQ`, `pendingReturnsQ`, `activeRunsQ`) are independently loaded today; this fix touches only the late-route predicate | n/a    |
| Error                    | Unchanged                                                                                                                                                               | n/a    |
| Offline / request failed | Unchanged                                                                                                                                                               | n/a    |
| Unauthorized             | Unchanged                                                                                                                                                               | n/a    |
| Too much data            | Unchanged (`limit: 20` on the source query, not touched)                                                                                                                | n/a    |
| Stale                    | Unchanged                                                                                                                                                               | n/a    |
| Concurrent edit          | n/a                                                                                                                                                                     | n/a    |

### Surface: `POST /drivers/me/location` — api + mobile tracker (R6)

| State                    | Required behavior (what the user sees and can do)                                                            | Req ID |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------ |
| Empty                    | n/a                                                                                                          | n/a    |
| Loading                  | n/a — fire-and-forget from the tracker's perspective (`postLocation`'s catch is silent by design, unchanged) | n/a    |
| Partial                  | n/a                                                                                                          | n/a    |
| Error                    | A ping missing `accuracy` (older app build) still validates — the field is `@IsOptional()`                   | R6     |
| Offline / request failed | Unchanged — the tracker's existing silent catch stands; this batch does not add retry/queueing               | n/a    |
| Unauthorized             | Unchanged — existing driver-auth guard on the endpoint                                                       | n/a    |
| Too much data            | n/a                                                                                                          | n/a    |
| Stale                    | n/a                                                                                                          | n/a    |
| Concurrent edit          | n/a — inserts only, no update-in-place                                                                       | n/a    |

## 5. Non-functional requirements

| Area                                        | Requirement                                                                                                                                                                                        | Budget / rule                                                                                                                                         | Req ID |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Performance (G4·Q6)                         | Timezone resolution for On-Time % must not add a query per run — resolve the tenant's timezone ONCE per `getRoutePerformance`/`getDriverPerformance` call, not per row                             | one `tenantConfig.findUnique` (or equivalent) per API call, not per `RouteRun`                                                                        | R5     |
| Security and authorization (G4·Q12)         | No new endpoint is added; the one DTO change (`accuracy`) is additive and optional, so no existing caller is newly rejected                                                                        | `@IsOptional()` on the new field                                                                                                                      | R6     |
| Tenancy / ownership scoping (G4·Q5, G4·Q12) | Timezone resolution reads `TenantConfig` scoped to the current tenant, never cross-tenant                                                                                                          | uses the existing `prisma.getTenantId()` / tenant-scoped Prisma client pattern already used by `invoices.service.ts`'s `resolveTenantInvoiceDefaults` | R5     |
| Observability (G4·Q8)                       | None added — this batch does not introduce a new failure mode that needs new logging; the existing silent-catch in `location-tracker.native.ts` is unchanged                                       | n/a                                                                                                                                                   | —      |
| Accessibility                               | Unchanged — no markup or interaction change on any surface (`ui: false`); the date `<input>` in `EditRunModal` keeps its existing (already imperfect) label association, not touched by this batch | n/a                                                                                                                                                   | —      |
| Idempotency (G4·Q3)                         | Saving `EditRunModal` twice in a row without touching the date field must leave `scheduledDate` byte-identical both times                                                                          | PATCH omits `scheduledDate` when the date input was not changed from its loaded value                                                                 | R1     |
| Data retention / PII                        | Unchanged — no new PII field. `accuracy` is a GPS precision radius in meters, already provisioned on `DriverLocation` for this exact purpose (`schema.prisma:928-931`)                             | n/a                                                                                                                                                   | —      |

## 6. Overlap and scope fence (G2·Q6)

- **Existing feature this overlaps:** `apps/web/lib/formatting.ts#fmtCalendarDate` and
  `apps/mobile/lib/format-date.ts#fmtCalendarDate` (the existing UTC-safe formatters) →
  **decision:** extend/wrap, never replace. New `apps/web/lib/calendar-date.ts` and
  `apps/mobile/lib/calendar-date.ts` add the parse/round-trip functions
  (`calendarDateFromIso`, `isoFromCalendarDate`, `calendarDayBounds`) that do not exist yet,
  and re-export (web) or mirror (mobile, already present) `fmtCalendarDate` rather than moving
  or duplicating its implementation.
- **In scope:** the 5 register bug ids' verified sites (R1–R6), the extraction of
  `startOfCalendarDay` into a shared api helper (R5), the D4 repair script (R7), and shipping
  e2e spec 34 in this PR (R8).
- **Out of scope:** everything named in discovery.md §10 — `nextFireDate` sites, a repo-wide
  sweep, the G1 scanner signature, any change to `fmtCalendarDate`'s output, timezone-selection
  UI, `routes.service.ts`, client-supplied `completedAt`, a branded date type, and formatter
  consolidation.
- **Do-not-introduce check (G4·Q10):** No new dependency. `common/calendar-date.ts` and both
  `lib/calendar-date.ts` mirrors use only `Date` + `Intl.DateTimeFormat` — already the pattern
  `invoices.service.ts#startOfCalendarDay` uses. No second HTTP client, no second test runner,
  no Vitest, no Biome — all test additions are Jest (api, mobile) or Playwright (web e2e),
  matching CLAUDE.md's stack.

## 7. Deploy day (G2·Q7)

- **Existing users on deploy day:** operators/buyers immediately see corrected dates at the 8
  display sites and in `EditRunModal` on their very next page load — no migration, no
  transition state. Tenant owners on a negative-UTC-offset `TenantConfig.timezone` see their
  On-Time % rise the next time the Operations tab is loaded (see B118 history-on-read note
  below). Drivers on iOS whose app already ships the sentinel-mapping fix stop losing GPS
  pings the moment their app build updates; drivers on an older mobile build are unaffected
  either way (`accuracy` is optional, `-1` sentinels are unchanged from their app's own code
  until it updates).
- **Existing data:** `RouteRun.scheduledDate`, `CreditNote.expiresAt`, licence `expiresAt`,
  promotion `startsAt`/`endsAt` are UNCHANGED by this deploy — the fix is entirely in which
  code reads/writes them, not a data migration. The ONE known exception: rows written by
  `apps/mobile/app/(operator)/customers/[id]/licenses.tsx:84` before this fix carry a
  non-midnight UTC time-of-day (local 23:59:59) and will render one day later than intended
  even after the read-side fix, until repaired (R7).
- **Backfill:** `scripts/repair-f25-licence-dates.mjs` (R7) — dry-run by default, owner-run
  after deploy, scoped to test tenants unless `--live-tenant-override` + type-back
  confirmation is used (build-plan.md WP-SCRIPT). No automatic/deploy-time backfill.
- **Migration (G4·Q5):** none. `TenantConfig.timezone` (`schema.prisma:467`, default
  `"America/New_York"`) and `DriverLocation.accuracy` (`schema.prisma:928-931`,
  `Decimal? @db.Decimal(8,2)`) both already exist on master — confirmed by direct read, quoted
  verbatim in build-plan.md's Constraints section. The running (old) code tolerates both
  columns already existing (they are simply unread/unwritten by it), so there is no rollout-
  window compatibility concern in either direction.

**This feature is not gated by a flag, plan, or entitlement.** §7's gate table is n/a —
ungated.

## 8. Rollback (G2·Q9)

- **Kill switch:** none — this is a bug fix to existing, always-on surfaces, not a
  flag-gated feature. Rollback is a code revert.
- **Code rollback:** safe to revert the PR's commit(s). Reverting restores the pre-fix
  read/write code paths against the SAME stored data (no schema change), so nothing new is
  left dangling. The one caveat: if `scripts/repair-f25-licence-dates.mjs` has already been run
  live by the owner, reverting the code re-introduces the read-side bug against NOW-CORRECTED
  rows — those repaired rows would then render one day early again until the fix is
  re-applied. This is the same shape as any D4 repair-then-revert scenario in this repo
  (see `scripts/REPAIR-RUNBOOK.md`'s existing rollback section for the pattern).
- **Data rollback:** the repair script's own JSONL before-state log
  (`local-assets/f25-licence-repair-<ts>.jsonl`) is the rollback source for any row it touched
  — see build-plan.md WP-SCRIPT for the exact rollback SQL shape (mirrors
  `repair-f11-stranded-orders.mjs`'s documented rollback row in `REPAIR-RUNBOOK.md` §4).
- **Blast radius (G4·Q1):** worst case is a rendering/comparison error (wrong calendar day
  shown, wrong on-time classification) — no money math is touched (confirmed: none of the five
  ids reach `pricing.ts`), no cross-tenant leak (R5's timezone read is tenant-scoped), and the
  one write path this batch touches (R1, `EditRunModal`'s PATCH) writes a date, not an amount.
  The repair script (R7) is the only path that mutates historical data, and it is dry-run by
  default with per-tenant confirmation gating.
- **Detection:** T1/T2 (e2e, post-deploy) catch a regression at the two riskiest sites
  (`EditRunModal`, one display site) the next deploy-signal run. T5–T8 (api jest, on every
  push) catch any regression to the On-Time % day-end logic before merge. A tenant owner
  reporting "my On-Time % looks wrong" after this ships is the expected, accepted signal for
  B118 (see §9 R5's note) — not a bug.

## 9. Requirements table

| ID            | Requirement (observable behavior, not implementation)                                                                                                                                                                                                                                                                                                                                                     | Priority | Verification method                                                                                    | Test IDs                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| R1            | `EditRunModal.tsx` reads `run.scheduledDate` as a UTC calendar date and writes back UTC midnight; saving the modal without changing the date input leaves the run's `scheduledDate` byte-identical (`YYYY-MM-DDT00:00:00.000Z`) before and after, in any viewer timezone                                                                                                                                  | must     | e2e (Playwright, deploy-only, T2)                                                                      | T1                                                    |
| R2            | The 8 verified display sites (web: dashboard, my-runs, dispatch, deliveries, authorizations tab, buyer licenses, finance reports; mobile: payments) render their calendar-date field through `fmtCalendarDate` (web) or its mobile mirror — never `toLocaleDateString`/local getters on a date-only field — and the rendered STRING is unchanged from today's `fmtCalendarDate` output for the same input | must     | e2e for one representative site (T2) + code-level parity for the rest (mirror-identity pin, T15)       | T2, T15                                               |
| R3            | The mobile operator licence editor (`(operator)/customers/[id]/licenses.tsx`) stores `expiresAt` as UTC midnight of the chosen calendar day, not local end-of-day                                                                                                                                                                                                                                         | must     | mobile unit (jest)                                                                                     | T14                                                   |
| R4            | The mobile Exceptions screen's late-route predicate derives its day bounds from the shared mobile helper `calendarDayBounds`, matching the semantics of the driver route screen's already-correct pattern (`(driver)/route/index.tsx:183`)                                                                                                                                                                | must     | mobile unit (jest)                                                                                     | T13                                                   |
| R5            | On-time = `completedAt ≤ endOfCalendarDay(scheduledDate, tenantTimezone)`, where `tenantTimezone` is resolved from `TenantConfig.timezone` through the shared api helper `common/calendar-date.ts`; the boundary is correct across a DST transition                                                                                                                                                       | must     | api unit (jest)                                                                                        | T5, T6, T7                                            |
| R6            | The mobile GPS tracker maps a platform sentinel (negative or null `accuracy`/`speed`/`heading`) to `undefined` before POSTing; `POST /drivers/me/location`'s DTO accepts an optional `accuracy` (`@IsOptional() @IsNumber() @Min(0)`) and `drivers.service.ts` persists it to the existing `DriverLocation.accuracy` column                                                                               | should   | api unit + mobile unit (jest)                                                                          | T9, T10, T12                                          |
| R7            | `scripts/repair-f25-licence-dates.mjs` recovers the intended calendar day of a pre-fix licence row by interpreting its stored instant in the row's tenant's `TenantConfig.timezone`, and rewrites `expiresAt` to UTC midnight of that day; a true UTC-midnight row is left unchanged                                                                                                                      | should   | api or scripts unit (jest, on the script's imported pure function)                                     | T16                                                   |
| R8            | e2e spec 34 (`34-calendar-dates.spec.ts`) and its `playwright.config.ts` project entry (`calendar-dates`, `dependencies: ["setup"]`, `storageState: operator.json`, `use.timezoneId: "America/Los_Angeles"`) ship in this PR and are discoverable by `--list`                                                                                                                                             | must     | `npx playwright test --list` (proof wiring; the spec itself runs post-deploy only)                     | — (process check, not a T#; see test-plan.md §6 note) |
| R9 (negative) | A calendar-date field's stored UTC value is NEVER re-derived from a viewer-local `Date` construction anywhere this batch touches — i.e. the fix must not introduce a NEW local-time read/write at any of the touched files                                                                                                                                                                                | must     | code review against the mutation-probe targets (build-plan.md) + T1/T14 assert the write side directly | T1, T14                                               |

Rules:

- One observable behavior per row. If it needs "and" twice, split it.
- Write it so it **can fail**. If no run of the system could falsify the row, it is not a
  requirement — rewrite it (G5·Q5).
- Priority is `must` | `should` | `could`. `must` rows block the release; `could` rows must
  survive being cut. (No `could` rows in this batch — everything named traces to a register
  bug id or the proof-wiring requirement R8.)
- Verification method is the **lowest level that can fail for the right reason**. R1/R2 are
  e2e because web has no unit runner (campaign decision D1) — everything else that CAN be a
  jest unit test is one.
- Test IDs stay blank here and are filled in at S4 from [test-plan.md](./test-plan.md). No row
  may still be blank when S4 closes.
- R9 is the negative requirement this spec's STOP GATE requires.
- R1, R5, R7 rest on assumptions carried from discovery.md §12 — see §10 below.

## 10. Assumptions (unverified) — MANDATORY

| #   | Claim, as this file states it (and its §)                                                                                         | Basis                                                                                                                                                               | What would confirm it                                                               | R#s that fall with it                                                                            | What breaks if it is wrong                                                                                                                                                                              | Status                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A5  | "§7: no downstream integration reads `scheduledDate`/`expiresAt` differently after this fix — the wire value never changes"       | carried from discovery.md §12 A5: inferred from the files read during discovery, not a repo-wide search for external consumers                                      | grep the whole repo for `scheduledDate`/`expiresAt` outside `apps/{api,web,mobile}` | R1–R4, R7 (all of them assume the wire/stored VALUE is untouched except where explicitly stated) | an unnoticed external consumer reading a different format would be unaffected regardless, since the fix changes only which LOCAL code renders/writes — low risk even if unconfirmed                     | unverified, low risk                                                                                                           |
| A6  | "§9 R2: T2's e2e oracle site (a licence expiry) needs no pre-existing regulated tracked category — it self-provisions via API"    | carried from discovery.md §12 A6 — a design choice made to sidestep an unanswered discovery question, not a verified fact about the seed tenant                     | run T2 once against the deployed site and confirm the fixture creation succeeds     | R2, R8                                                                                           | if the licence-creation API used by the fixture requires a category that must pre-exist, T2's fixture step needs an extra setup call — test-plan.md T2 names the exact endpoint to confirm this against | unverified — test-plan.md T2 is written defensively (creates its own category if the API requires one; see T2's expanded case) |
| A7  | "§4/§7: reverting this PR's code after the repair script has run live re-introduces the read-side bug against now-corrected rows" | logical consequence of R7 rewriting stored data while R2/R3's code path is what makes that data render correctly — not independently verified against a real revert | would require an actual revert-after-repair drill, not performed                    | R7 (its interaction with rollback)                                                               | if wrong in some other direction, the rollback section's guidance is incomplete rather than wrong — low risk, documentation-only consequence                                                            | unverified, accepted as the safe-side assumption (documented in §8 rather than silently ignored)                               |

---

## STOP GATE — S2 → S3 / S4

- [x] Core capability is one sentence a customer would recognise
- [x] Exactly one ★ use case
- [x] Completeness sweep has an explicit decision on every row
- [x] Every surface has all nine states, or an `n/a` with a reason
- [x] NFRs cover performance, authorization, tenancy/ownership scoping, observability, accessibility
- [x] Deploy day answered — ungated, so the gate-key match table is explicitly n/a
- [x] Rollback and blast radius written
- [x] Every requirement has an ID, a priority, and a verification method
- [x] No requirement restates the implementation ("calls function X") instead of the behavior
- [x] At least one negative requirement (R9)
- [x] Assumptions block filled — every unverified premise, what would confirm it, the R#s that fall with it (§10)

## Stage log — did the gate fire?

| Stop condition                                                              | Evaluated?    | What it answered                                                              | Evidence | Verdict    |
| --------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------- | -------- | ---------- |
| Completeness sweep has a decision on every row                              | yes           | every lifecycle row is `keep` or `n/a` with a reason                          | §3       | pass       |
| Every surface covers all nine states, or `n/a` with a reason                | yes           | 5 surfaces enumerated, every state row filled                                 | §4       | pass       |
| The key the gate reads is the key the granting path writes                  | n/a — ungated | this feature carries no flag/plan/entitlement gate                            | §7       | pass (n/a) |
| Rollback, blast radius and detection written                                | yes           | code revert + repair-script JSONL rollback source + detection via T1/T2/T5–T8 | §8       | pass       |
| Every R# has a priority and a verification method; at least one negative R# | yes           | R1–R9, R9 is the negative row                                                 | §9       | pass       |

- **Gate outcome:** PASS — S4 may start (no UI change → `ux-spec.md` skipped, straight to test-plan.md)
- **Overridden by:** n/a
- **Assumptions carried into S4:** A5, A6, A7

**Next:** No UI work in this batch (`ui: false`) → straight to [test-plan.md](./test-plan.md) (S4).

**Approved by:** planner (F25 campaign batch owner) · **on:** 2026-09-03
