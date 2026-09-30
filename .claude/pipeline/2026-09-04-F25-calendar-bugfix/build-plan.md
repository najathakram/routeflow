# Build plan: F25-calendar bugfix — B59, B90, B91, B118

> **Stage S5 — "how".** Authored by Fable 5 on 2026-09-04.
> Status: `DRAFT`
> Written AFTER [bug-test-plan.md](./bug-test-plan.md) — the tests decide the shape of the work.
> This file is the ONLY context the implementation and review agents receive. It must stand alone.
> Inputs: [cause-brief.md](./cause-brief.md) (S1 evidence), [refutation.md](./refutation.md) (S2 verdict),
> [cause-ruling.md](./cause-ruling.md) (S3 — the fix design binds every package below),
> [bug-test-plan.md](./bug-test-plan.md) (T#).
> `mode: 'bugfix'`, `scale: 'major'` — see `cause-ruling.md` for the full evidentiary trail; this file
> restates only what a builder needs to act.

**Gate to pass before S6:** every work package declares `satisfies:` (R#s) and `provenBy:` (T#s).

---

## Objective

Four confirmed date/timezone defects share one root class — calendar-date fields (`RouteRun.scheduledDate`,
`CustomerAuthorization.expiresAt`) are stored as UTC-midnight instants but read, compared, or written with
local-time or fixed-UTC operations instead of the shared calendar-day helpers. This batch: (1) stops
Edit Route Run from silently rolling `scheduledDate` back a day on every save (B59); (2) stops the mobile
Exceptions screen from flagging on-schedule runs as late (B90); (3) fixes nine display sites that render a
calendar date one day early for negative-UTC-offset viewers, and one writer that stores a licence expiry as
a local end-of-day instant instead of UTC midnight (B91); (4) makes the On-Time % metric's day-end
tenant-timezone-aware instead of a fixed UTC cutoff (B118).

**In scope:** the exact diverging lines and sites named in `cause-ruling.md` §1/§2, the four new pure
modules it names, the doc-comment rewrite in `analytics.service.ts`, the read-only report + gated repair
script pair for the licence-writer data question, the e2e proof for B59/B91 (deploy-only tier).

**Explicitly out of scope (scope fence, from `cause-ruling.md`):** the nine display sites' e2e proof does
NOT gate this pipeline run (T2-tier, post-deploy only); the promotions/statement/finances/CostHistorySheet
sites refuted or left undetermined in S2; the `expiresAt < now` instant-comparison POLICY question
(authorizations/credit-notes) — filed to the owner as a registry candidate, not fixed here; any change to
`routes.service.ts` beyond read-only citation; B185 (location) — that is `2026-09-04-F25-location-bugfix`,
a separate run.

---

## Constraints & conventions

- **Stack:** NestJS 11 + Prisma 7 (api), Next.js 14 App Router (web), Expo 55 / RN 0.83 (mobile).
- **Test runners:** api — Jest, `*.spec.ts`, run from `apps/api` (`npx jest <path> --runInBand`). Web —
  Jest + RTL, `*.test.ts(x)`, run from `apps/web` (`npx jest <path>`); `apps/web/jest.config.js` exists and
  `apps/web/package.json` already has `"test": "jest"` (**F1 confirmed: WEB-JEST branch** — web pure helpers
  get their own tests here, not only a mobile mirror-identity pin). Mobile — Jest, pure-logic only,
  `apps/mobile/__tests__/*.test.ts`, `testEnvironment: "node"`.
- **Lint/format:** ESLint flat config per workspace (`npm run lint`, never bare `eslint`); Prettier via the
  scoped `formatCommand` below — never run un-scoped across `.claude/pipeline/`.
- **Existing patterns to copy:** `apps/api/src/invoices/invoices.service.ts:69-89`'s `startOfCalendarDay`
  is the pattern this batch extracts and generalizes; `apps/mobile/app/(driver)/route/index.tsx:178-183`'s
  `NEW-rweb-7` comment is the in-repo statement of the correct calendar-date-read pattern.
- **Must NOT change:** the api PATCH `/route-runs/:id` contract (no DTO is added — see `cause-ruling.md`
  §2's B59 "must not change" list); `routes.service.ts`; the response shape of `getRoutePerformance`/
  `getDriverPerformance`; any of the REFUTED or UNDETERMINED B91 sites listed in `cause-ruling.md` §1.
- **Do-not-introduce list (repo-wide):** Vitest, Biome, Supabase, Vercel, a second HTTP client, a
  root-level test runner or root ESLint config.
- **Landmines:** `analytics.service.ts`'s six existing `onTimeRate` fixtures encode the CURRENT UTC boundary
  as expected behavior (`:910, :939, :958, :1001, :1067, :1102`) — the new `timeZone` parameter must resolve
  to `null` (not `America/New_York`) for an unconfigured tenant, or these silently start failing (see
  `cause-ruling.md` §2's fallback-correction note and `bug-test-plan.md`'s harness notes). `EditRunModal` is
  reachable from two screens with two differently-shaped call sites — anything added to its props must be
  satisfiable at both. `apps/web/playwright.config.ts` has DRIFTED from the stale 2026-09-03 plan's cited
  line numbers (`:393-418`) — at this sha the project array runs to line 456 with the last entries at
  `:438` and `:452`; WP-E2E places the new `calendar-dates` project after the last existing entry, not at
  the old plan's cited location.

---

## Exact code — calendar helpers (write ONCE here; WP-WEB and WP-MOB paste it verbatim)

**Reused verbatim from `.claude/pipeline/2026-09-03-F25-calendar-dates/build-plan.md`** ("Exact code —
calendar helpers" section) per the planner's explicit instruction — this text, including its own
documented divergence note, is unchanged from that plan:

Ruling requires `apps/web/lib/calendar-date.ts` and `apps/mobile/lib/calendar-date.ts` to share
byte-identical pure-function bodies for `calendarDateFromIso`, `isoFromCalendarDate`, and
`calendarDayBounds` (plus the three private helpers they call). Both files paste the block below verbatim;
only their `fmtCalendarDate` re-export differs (mobile already has one at `apps/mobile/lib/format-date.ts:25`;
web's lives at `apps/web/lib/formatting.ts:55`).

**Divergence from a literal "add 24h then startOfCalendarDay" description, reported per L-026** (a plan's
description of an algorithm is a hypothesis, not evidence — worked by hand before trusting it): that literal
composition does NOT produce the right boundary for a negative-UTC-offset zone — `startOfCalendarDay`
converts an INSTANT → the calendar day it falls on IN `tz` (backward direction); feeding it a UTC-midnight
instant that already symbolically encodes "day X+1" makes it read back as day X's OWN calendar day for any
zone west of UTC. The code below instead solves the actual needed direction (a calendar day's LOCAL midnight
→ the true UTC instant) with a standard offset-correction pass, verified by hand against both a non-DST
fixture and the March 2026 spring-forward day (T9).

```ts
/**
 * A "calendar date" is a YYYY-MM-DD string — the meaningful part of a stored
 * UTC-midnight instant (RouteFlow's storage convention for every calendar-date
 * field: scheduledDate, expiresAt, startsAt/endsAt, issueDate, dueDate). These
 * functions are the ONLY sanctioned way to move between the two
 * representations and to find a real wall-clock day boundary — never
 * `new Date(x).getFullYear()`/`setHours` on a calendar-date field.
 */

function readCalendarParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const at = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return { year: at("year"), month: at("month"), day: at("day") };
  } catch {
    // Unknown/invalid IANA zone — fall back to UTC, never throw.
    return {
      year: instant.getUTCFullYear(),
      month: instant.getUTCMonth() + 1,
      day: instant.getUTCDate(),
    };
  }
}

function addUtcCalendarDays(
  year: number,
  month: number,
  day: number,
  days: number,
): { year: number; month: number; day: number } {
  // Date.UTC normalizes an out-of-range day/month itself (day 32 rolls into
  // next month) — plain calendar arithmetic, never touches a real clock.
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The true UTC instant of 00:00:00 local wall-clock time, on the given
 * calendar day, in `timeZone`. DST-safe: reads the zone's actual UTC offset
 * AT the midnight instant itself (one Intl pass), never assumes a fixed
 * offset. Midnight is never the literal DST-transition moment in any IANA
 * zone this codebase targets (US transitions land at 2am local), so this
 * single-correction approach never lands on the transition's own
 * ambiguous/skipped hour.
 */
function localMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  let offsetMs = 0;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(guess));
    const at = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const shownAsUtc = Date.UTC(
      at("year"),
      at("month") - 1,
      at("day"),
      at("hour") === 24 ? 0 : at("hour"),
      at("minute"),
      at("second"),
    );
    offsetMs = shownAsUtc - guess;
  } catch {
    offsetMs = 0; // unknown zone — fall back to UTC, never throw
  }
  return new Date(guess - offsetMs);
}

/** UTC-midnight instant (`iso.slice(0,10)`) → its calendar-date string. `""` for null/invalid. */
export function calendarDateFromIso(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** A calendar-date string ("2026-09-03") → its UTC-midnight storage instant. */
export function isoFromCalendarDate(calendarDate: string): string {
  return `${calendarDate}T00:00:00.000Z`;
}

/**
 * [start, end) of the calendar day containing `now`, as observed in
 * `timeZone` — REAL UTC instants (not the UTC-midnight SYMBOLIC stamp
 * `calendarDateFromIso`/`isoFromCalendarDate` use for storage).
 */
export function calendarDayBounds(
  timeZone: string,
  now: Date | string = new Date(),
): { start: Date; end: Date } {
  const at = typeof now === "string" ? new Date(now) : now;
  const { year, month, day } = readCalendarParts(at, timeZone);
  const start = localMidnightUtc(year, month, day, timeZone);
  const next = addUtcCalendarDays(year, month, day, 1);
  const end = localMidnightUtc(next.year, next.month, next.day, timeZone);
  return { start, end };
}
```

**api-only additions** (`apps/api/src/common/calendar-date.ts` pastes the three private helpers above PLUS
these three exports — also reused verbatim from the 09-03 plan):

```ts
/**
 * The calendar day (as a UTC-midnight SYMBOLIC stamp — the storage convention
 * for every calendar-date field in this schema) that `date` falls on, as
 * observed in `timeZone`. Extracted byte-for-byte from
 * invoices.service.ts's private startOfCalendarDay (pinned: T10).
 * Argument order reversed (date first) to read naturally at analytics' new
 * call sites, which pass a real value, not a config-shaped call.
 */
export function startOfCalendarDay(
  date: Date | string = new Date(),
  timeZone?: string | null,
): Date {
  const instant = typeof date === "string" ? new Date(date) : date;
  const { year, month, day } = readCalendarParts(instant, timeZone || "UTC");
  return new Date(
    `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  );
}

/**
 * The last instant (− 1 ms) of the calendar day `date` encodes, evaluated at
 * `timeZone`'s real wall-clock day boundary. `date`'s own UTC year/month/day
 * is read directly (never re-derived through `timeZone`) because every
 * calendar-date field in this schema is written as UTC midnight OF the
 * intended day. DST-safe: see `localMidnightUtc`. Falls back to UTC when
 * `timeZone` is null/undefined/invalid — this is the fallback the analytics
 * caller relies on for tenants with no `TenantConfig` row (see WP-API-CAL).
 */
export function endOfCalendarDay(date: Date | string, timeZone?: string | null): Date {
  const instant = typeof date === "string" ? new Date(date) : date;
  const next = addUtcCalendarDays(
    instant.getUTCFullYear(),
    instant.getUTCMonth() + 1,
    instant.getUTCDate(),
    1,
  );
  const nextMidnightLocal = localMidnightUtc(next.year, next.month, next.day, timeZone || "UTC");
  return new Date(nextMidnightLocal.getTime() - 1);
}

/**
 * Normalizes a fetched TenantConfig-shaped row to the timezone it carries,
 * falling back to the SCHEMA's own default (`schema.prisma:467`) — never UTC.
 * NOTE (this run's fix-design correction, cause-ruling.md §2): this helper is
 * for the INVOICES module's day-START use, where an un-configured tenant is
 * overwhelmingly on America/New_York in practice. Analytics' new
 * `resolveCurrentTenantTimezone` (WP-API-CAL, in analytics.service.ts) does
 * NOT call this — it passes `cfg?.timezone ?? null` straight to
 * `endOfCalendarDay`, relying on THAT function's own UTC fallback, so a
 * tenant with no TenantConfig row keeps today's exact UTC-boundary arithmetic
 * (T11 pin) instead of silently shifting to an America/New_York boundary.
 */
export function resolveTenantTimezone(config?: { timezone?: string | null } | null): string {
  return config?.timezone || "America/New_York";
}

/**
 * Recovers the intended calendar day of a row written with a LOCAL
 * `${date}T23:59:59` instant (never UTC) instead of UTC midnight. Returns the
 * recovered day as "YYYY-MM-DD", or `null` when `storedIso` is ALREADY a
 * UTC-midnight row (time-of-day exactly 00:00:00.000) — such a row needs no
 * recovery. MUST stay byte-identical to the copy in
 * scripts/repair-f25-licence-dates.mjs (mirrors the
 * RELEASED_CHANGE_REQUEST_REASON convention in
 * scripts/repair-f11-stranded-orders.mjs — no cross-package import exists
 * between scripts/*.mjs and apps/api/src today).
 */
export function recoverCalendarDay(storedIso: string, timeZone: string): string | null {
  const d = new Date(storedIso);
  if (Number.isNaN(d.getTime())) return null;
  const isUtcMidnight =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;
  if (isUtcMidnight) return null; // already correct — skip, never "recover" a good row
  const { year, month, day } = readCalendarParts(d, timeZone);
  return `${String(year)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
```

`analytics.service.ts` changes (new — not from the 09-03 plan, reflects this run's fallback correction):

```ts
import { endOfCalendarDay } from "../common/calendar-date";

// accumulateRunMetrics gains a third parameter; the UTC setUTCHours line is replaced:
private accumulateRunMetrics(agg: RunMetricAgg, run: RunMetricSource, tenantTimezone: string | null) {
  const dayEnd = endOfCalendarDay(run.scheduledDate, tenantTimezone);
  let runCompletedStops = 0;
  for (const stop of run.stops) {
    if (!stop.completedAt) continue;
    runCompletedStops += 1;
    if (stop.completedAt <= dayEnd) agg.onTimeStops += 1;
  }
  agg.completedStops += runCompletedStops;
  // ...unchanged duration/validRun accumulation below this line
}

// NEW private helper — resolved ONCE per call, not per row. Deliberately does
// NOT call resolveTenantTimezone (see the exported function's own doc comment
// above) — an unconfigured tenant must keep today's UTC boundary, not shift
// to America/New_York.
private async resolveCurrentTenantTimezone(): Promise<string | null> {
  const tenantId = this.prisma.getTenantId();
  if (!tenantId) return null;
  const cfg = await this.prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  return cfg?.timezone ?? null;
}

// getRoutePerformance (:378) and getDriverPerformance (:419) each gain, right after their
// existing opening lines and BEFORE their `runs = await …findMany(…)` call:
const tenantTimezone = await this.resolveCurrentTenantTimezone();
// …then their existing `this.accumulateRunMetrics(map[id].metrics, run)` calls (:400, :447)
// become:
this.accumulateRunMetrics(map[id].metrics, run, tenantTimezone);
```

The docblock at `analytics.service.ts:319-334` ("…the END of its run's `scheduledDate` calendar day
**(UTC)**") is reworded to say "in the tenant's configured timezone (falling back to UTC when unset)"
instead of "(UTC)" as part of WP-API-CAL.

---

## Test packages

### TP-WEB — web seam extraction + REG tests (T1, T2, T6)

- **writes:** `apps/web/app/(dashboard)/routes/_components/edit-run-modal.logic.ts` (NEW — seam, today's
  buggy bodies), `apps/web/app/(dashboard)/routes/_components/edit-run-modal.logic.test.ts` (NEW, T1/T2),
  `apps/web/lib/formatting.test.ts` (NEW, T6). Edits (behaviour-preserving only, no fix yet):
  `apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx` (delete `formatLocalDate` and the inline
  `handleSave` body-building lines; import and call the two new seam exports instead).
- **tests:** T1, T2, T6
- **brief:** T1/T2 exercise `readCalendarInput`/`buildRunPatchBody` with the exact setup in
  `bug-test-plan.md`; T6 asserts `fmtCalendarDate("2026-11-01T00:00:00.000Z")` renders "Nov 1, 2026" under
  `TZ=America/Los_Angeles` while the existing local formatter on the same input renders "Oct 31, 2026" (the
  wrong-value comparator, asserted in the same test per the ruling).
- **must fail with:** T1 `expected "2026-06-10" received "2026-06-09"`; T2 `expected undefined received
"2026-06-10"`; T6 the local-formatter comparator assertion passes today (it is not itself red), but
  `fmtCalendarDate`'s own assertion is unaffected by the bug (it is already correct) — **T6's red bar is
  carried entirely by T1/T2's seam extraction being reachable from the component; `fmtCalendarDate` itself
  needs no fix**. Record this explicitly: T6 is a proof that the correct helper exists and behaves as
  intended, run alongside T1/T2 in the same red-gate pass so the eventual site swap (deploy-only, e2e) has
  a unit-level anchor.

### TP-MOB — mobile seam extraction + REG tests (T3, T4, T5)

- **writes:** `apps/mobile/lib/run-lateness.ts` (NEW — seam, today's buggy body),
  `apps/mobile/__tests__/run-lateness.test.ts` (NEW, T3/T4),
  `apps/mobile/app/(operator)/customers/[id]/licenses.logic.ts` (NEW — seam, today's buggy body),
  `apps/mobile/__tests__/licence-expiry-iso.test.ts` (NEW, T5). Edits
  (behaviour-preserving only): `apps/mobile/app/(operator)/exceptions.tsx` (`:58-62` calls `isRunPastDue`),
  `apps/mobile/app/(operator)/customers/[id]/licenses.tsx` (`:84` calls `buildExpiresAtIso`).
- **tests:** T3, T4, T5
- **brief:** exact G/W/T + oracle for each in `bug-test-plan.md`.
- **must fail with:** T3 `expected false received true`; T5 `expected "2027-01-01T00:00:00.000Z" received
"2027-01-02T04:59:59.000Z"`; T4 is a pin-shaped REG test (passes both before and after — recorded so a fix
  cannot flip the correct direction unnoticed).

### TP-API — api REG tests + pins (T7, T8, T9, T10, T11)

- **writes:** `apps/api/src/analytics/analytics.service.calendar.spec.ts` (NEW, T7/T8/T9),
  `apps/api/src/common/calendar-date.pins.spec.ts` (NEW, T10 — imports the not-yet-created
  `apps/api/src/common/calendar-date.ts`, so this file is written but stays red/non-compiling until
  WP-API-CAL creates the module; standard test-first ordering, the engine runs test packages before the
  first implementation wave).
- **tests:** T7, T8, T9, T10; T11 is verified against the EXISTING `analytics.service.spec.ts` — no new
  lines are written for it in this package.
- **brief:** exact G/W/T + oracle for each in `bug-test-plan.md`; T10's fixtures are copied from
  `invoices.service.spec.ts:7041-7049`/`:7075-7083` and re-asserted against the new module's
  `startOfCalendarDay` export, unchanged inputs/outputs.
- **must fail with:** T7 `expected 100 received 0`; T9 `expected 100 received 0`; T10/T11 are pins and are
  expected to be GREEN once the extraction exists (T10 cannot even run before `calendar-date.ts` exists —
  that non-existence IS its pre-fix red state, satisfying the same "must fail today" rule via a compile
  error rather than an assertion failure, which is acceptable for a pin proving an extraction is
  byte-identical only after the extraction happens).

**Red gate command** (only the REG-tagged tests, every one must fail on an assertion or a reachable-seam
compile error, none may pass):

```bash
cd apps/api && npx jest src/analytics/analytics.service.calendar.spec.ts -t "REG-B" --runInBand && cd ../web && npx jest edit-run-modal.logic.test authorizations-expiry.logic.test -t "REG-B" && cd ../mobile && npx jest run-lateness.test licence-expiry-iso.test -t "REG-B"
```

---

## Work packages

### WP-API-CAL — shared api calendar-date helper + analytics wiring

- **files:** `apps/api/src/common/calendar-date.ts` (NEW), `apps/api/src/invoices/invoices.service.ts`
  (delete the private `startOfCalendarDay` at `:69-89` and its docblock; import the four exports from
  `../common/calendar-date`; update its 4 call sites at `:489, :628, :2412, :2637` from
  `startOfCalendarDay(tenantDefaults.timezone)` to `startOfCalendarDay(new Date(), tenantDefaults.timezone)`
  — same semantics, `now` now explicit since the new signature takes it first; `addCalendarDays` at `:96-100`
  is UNRELATED and stays exactly where it is), `apps/api/src/analytics/analytics.service.ts`
  (`accumulateRunMetrics` at `:335-353`, its docblock `:319-334`, its two call sites `:400`/`:447`, plus the
  new `resolveCurrentTenantTimezone` private helper), `apps/api/src/invoices/invoices.service.spec.ts`
  (import + arg-order update only — no fixture value changes).
- **satisfies:** the B118 fix design and the shared-helper requirement B59/B90/B91-writer depend on
- **provenBy:** T7, T8, T9, T10, T11
- **dependsOn:** none (test packages run first per engine order)
- **effort:** high (money-adjacent metric — On-Time % feeds tenant-facing KPIs)
- **brief:** paste the "Exact code — calendar helpers" block above (shared + api-only exports) into the new
  file; wire `invoices.service.ts` and `analytics.service.ts` exactly as shown there.

### WP-WEB — EditRunModal fix + the seven web display sites

- **files:** `apps/web/lib/calendar-date.ts` (NEW), `apps/web/lib/formatting.ts` (additive: no change to
  `fmtCalendarDate`'s existing signature — it already exists and is correct; this package only re-exports
  it from the new `calendar-date.ts`), `apps/web/app/(dashboard)/routes/_components/edit-run-modal.logic.ts`
  (replace the two seam bodies with the fixed logic), `apps/web/app/(dashboard)/dashboard/page.tsx:86`,
  `apps/web/app/(dashboard)/routes/my-runs/page.tsx:52`,
  `apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx:534`,
  `apps/web/app/(dashboard)/deliveries/page.tsx:74-75`,
  `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx:273`,
  `apps/web/app/buyer/portal/[seller]/licenses/page.tsx:199`,
  `apps/web/app/(dashboard)/finance/reports/page.tsx:1234`.
- **satisfies:** B59 (full fix), B91 (7 of 9 display sites — the two mobile sites are WP-MOB's)
- **provenBy:** T1, T2, T6 (unit); e2e spec 34 proves the deployed round-trip (not a gate here)
- **dependsOn:** TP-WEB (the seam module must exist before this package edits its bodies)
- **effort:** medium
- **brief:** `edit-run-modal.logic.ts`'s `readCalendarInput` body becomes `calendarDateFromIso(scheduledDate)`;
  `buildRunPatchBody` adds an `initialDate` parameter and only sets `scheduledDate` when
  `date !== initialDate` (still gated by `isInProgress` first, unchanged). The seven display sites swap
  `toLocaleDateString`/local `fmtDate` for `fmtCalendarDate` at exactly the cited lines;
  `deliveries/page.tsx` keeps its `createdAt` fallback branch on the existing local formatter (a timestamp,
  not a calendar date — untouched); `finance/reports/page.tsx:1234` branches on `r.type === "INVOICE"`
  (discriminator already present on the row) before choosing `fmtCalendarDate` vs the existing local `fmtDate`.

### WP-MOB — exceptions fix, licence-writer fix, two display sites

- **files:** `apps/mobile/lib/calendar-date.ts` (NEW — same shared pure helpers, plus
  `export { fmtCalendarDate } from './format-date'`), `apps/mobile/lib/run-lateness.ts` (replace the seam
  body with the fixed string-comparison formula), `apps/mobile/app/(operator)/customers/[id]/licenses.logic.ts`
  (replace the seam body with `isoFromCalendarDate(expiresAt.trim())`),
  `apps/mobile/app/(customer)/payments.tsx:145`, `apps/mobile/app/(auth)/role-picker.tsx:103`.
- **satisfies:** B90 (full fix), B91 (the writer + the 2 remaining display sites)
- **provenBy:** T3, T4, T5
- **dependsOn:** TP-MOB
- **effort:** medium
- **brief:** `isRunPastDue`'s body becomes
  `calendarDateFromIso(scheduledDateIso) < localYmd(now)` where `localYmd(d)` is a small local helper using
  `d.getFullYear()`/`getMonth()`/`getDate()` (device-local, correct for "today" — see `cause-ruling.md`
  §2's exact formula). `licenses.logic.ts`'s `buildExpiresAtIso` body becomes
  `isoFromCalendarDate(expiresAt.trim())`. `payments.tsx:145` and `role-picker.tsx:103` swap their local
  render calls for `fmtCalendarDate` from the new module.

### WP-E2E — spec 34 + playwright project entry (deploy-only proof, not a gate)

- **files:** `apps/web/e2e/34-calendar-dates.spec.ts` (NEW), `apps/web/playwright.config.ts`.
- **satisfies:** the B59/B91 deploy-only proof tier
- **provenBy:** T1, T2 (as the deployed-round-trip anchor — this package does not introduce new T#s)
- **dependsOn:** WP-WEB
- **effort:** low
- **brief:** NEW `calendar-dates` project (`testMatch: /34-calendar-dates\.spec\.ts/`,
  `dependencies: ["setup"]`, `use: {...devices['Desktop Chrome'], storageState: operator.json,
timezoneId: 'America/Los_Angeles'}`), appended AFTER the current LAST project entry in
  `playwright.config.ts` (confirmed at this sha: the array runs to line 456, with `31-impersonation-signout`
  at `:438` and `32-active-sessions` at `:452` — NOT near `:393-418` as the stale 09-03 plan cited; that
  drift is recorded here, not silently followed). `34-calendar-dates.spec.ts` follows
  `23-run-settlement-note.spec.ts`'s self-provisioning fixture idiom (`page.goto('/routes')`,
  `operatorAccessToken(page)`, `apiBase(page.url())`, `Date.now()`-suffixed throwaway names) for two flows:
  (1) create a run with a known `scheduledDate`, open Edit Route Run, change only the driver, save, re-fetch,
  assert `scheduledDate` unchanged; (2) create/renew a licence with a known expiry, assert the Authorizations
  tab renders the correct calendar day under `timezoneId: "America/Los_Angeles"`.

### WP-SCRIPTS — D6 (licence data) report + gated repair script

- **files:** `scripts/report-f25-licence-dates.mjs` (NEW), `scripts/repair-f25-licence-dates.mjs` (NEW),
  `scripts/REPAIR-RUNBOOK.md`.
- **satisfies:** the §6 data-repair requirement
- **provenBy:** (no REG test — read-only report + gated script; verified by manual dry-run in
  `verifyCommands.final`'s local-tenant smoke, not the red gate)
- **dependsOn:** WP-API-CAL (needs `apps/api/src/common/calendar-date.ts#recoverCalendarDay` to exist to
  duplicate byte-identically)
- **effort:** medium
- **brief:** `report-f25-licence-dates.mjs` — READ-ONLY: per tenant, counts `CustomerAuthorization` rows
  whose `expiresAt` time-of-day is not exactly `00:00:00.000` UTC, samples ids, prints the tenant's
  `TenantConfig.timezone`. `repair-f25-licence-dates.mjs` — safety model copied from
  `repair-f11-stranded-orders.mjs` (dry-run default, one transaction per row with an in-transaction re-read,
  JSONL before-state log under `local-assets/`) combined with the test-tenant gate (`assertTestTenant` from
  `scripts/lib/test-tenants.cjs`; a live tenant needs `--live-tenant-override` + the type-back confirm).
  Duplicates `recoverCalendarDay` with a "MUST stay byte-identical to `apps/api/src/common/calendar-date.ts`"
  comment (no cross-package import exists between `scripts/*.mjs` and `apps/api/src`). `REPAIR-RUNBOOK.md`
  gains a new table row + `###` section in the shape of the existing `repair-f11-stranded-orders.mjs` entry.

### WP-DOCS — close-out bookkeeping (no app code)

- **files:** `.claude/campaign/status/F25.jsonl`, `.claude/code-map/api.md`, `.claude/code-map/web.md`,
  `.claude/code-map/mobile.md`, `.claude/code-map/_meta.json`, `.claude/code-map/CHANGELOG.md`,
  `.claude/lessons/LESSONS.md`, `.claude/lessons/_meta.json`.
- **satisfies:** (process — proves the campaign/lessons gates)
- **provenBy:** verified by `node scripts/campaign-check.mjs` and `node scripts/validate-lessons.mjs` in
  `verifyCommands.final`
- **dependsOn:** WP-API-CAL, WP-WEB, WP-MOB, WP-E2E, WP-SCRIPTS
- **effort:** low
- **brief:** `F25.jsonl` — REPLACE each line in place: `B90`, `B118` → `"state":"proven"` (`proof`/
  `evidence` naming this spec file + T7-T9 for B118, T3-T5 for B90 — note B90 evidence is T3/T4, B91's
  writer half is T5); `B59`, `B91` → `"state":"proven-pending-deploy"` (evidence naming spec 34 + the
  `calendar-dates` project entry + T1/T2/T6). Code map: surgical entries for every NEW/touched file above in
  the matching area file; `_meta.json`: `mappedSha` → this run's merge sha (filled at merge time, not now),
  `generatedAt` → the run's timestamp, `notes` REPLACED (never accumulated) with a one-line note plus the
  standard CHANGELOG.md pointer; a new dated bullet is ALSO added at the top of
  `.claude/code-map/CHANGELOG.md`. `.claude/lessons/LESSONS.md`: append **exactly** this entry under
  `## domain` (reused verbatim from the 09-03 plan, which pre-allocated this id):

```
### L-047 · 2026-09-04 · domain · F25

- **Symptom:** run dates, licence expiries and dashboard dates shifted a day for viewers west of
  UTC; on-time % was judged against the UTC day-end for tenants in New York; a driver location
  POST was rejected on a platform sentinel `-1`.
- **Root cause:** calendar dates stored as UTC midnight were read with local getters or
  `toLocaleDateString`; one writer stored local `23:59:59`; analytics never read
  `TenantConfig.timezone`; a sentinel reached a `@Min(0)` DTO unmapped.
- **Lesson:** **A calendar date is a string, not an instant: store it as UTC midnight, render and
  edit it only through the shared calendar-date helper (web/mobile mirrors), and evaluate day
  boundaries in the TENANT's timezone through the one api helper — never `setHours`, local
  getters or `toLocaleDateString` on a date-only field.**
- **Guard:** REG-B59 e2e under `timezoneId`; REG-B118 tenant-tz jest with a DST fixture;
  REG-B90/B91 mobile helper tests + the mirror-identity pin; REG-B185 DTO spec ([[L-026]] client
  sentinels never reach a validator unmapped).
```

**Date note:** the 09-03 plan's copy of this entry is dated `2026-09-04` in its own header despite being
authored 09-03 — reused verbatim including that date, per the instruction to copy the lesson text
as-is; do not silently "correct" it. `.claude/lessons/_meta.json`: `nextId` stays `58` (confirmed current
on this branch — do NOT reset it; L-047 is pre-allocated and does not consume it), `activeCount` `35` →
`36`, `updatedAt` bumped. **This run's PR body must note that B185's half of the Guard line discharges
only once `2026-09-04-F25-location-bugfix` (Run B) also lands** — L-047 is written once, covering the
whole F25 batch, per SEQUENCE.

### Package map

| WP         | provenBy             | dependsOn                                      | Wave           |
| ---------- | -------------------- | ---------------------------------------------- | -------------- |
| TP-WEB     | T1, T2, T6           | —                                              | 0 (test-first) |
| TP-MOB     | T3, T4, T5           | —                                              | 0 (test-first) |
| TP-API     | T7, T8, T9, T10, T11 | —                                              | 0 (test-first) |
| WP-API-CAL | T7, T8, T9, T10, T11 | —                                              | 1              |
| WP-WEB     | T1, T2, T6           | TP-WEB                                         | 1              |
| WP-MOB     | T3, T4, T5           | TP-MOB                                         | 1              |
| WP-E2E     | T1, T2               | WP-WEB                                         | 2              |
| WP-SCRIPTS | (none)               | WP-API-CAL                                     | 2              |
| WP-DOCS    | (none)               | WP-API-CAL, WP-WEB, WP-MOB, WP-E2E, WP-SCRIPTS | 3              |

---

## Acceptance criteria

1. Opening Edit Route Run and saving with only the driver changed leaves `scheduledDate` byte-identical in
   the database (B59).
2. A run scheduled for the operator's current calendar day never appears in mobile Exceptions as a "Late
   route", for a device west of UTC (B90).
3. Each of the nine named B91 sites renders the stored calendar day, not one day early, for a viewer west of
   UTC; the refuted/undetermined sites are untouched.
4. The mobile-operator licence-expiry form writes UTC midnight, matching the other three writers (B91
   writer).
5. `getRoutePerformance`/`getDriverPerformance`'s On-Time % counts a stop completed before the tenant's
   configured local day-end as on-time; an unconfigured tenant's arithmetic is byte-identical to today's
   (B118).
6. The six existing `analytics.service.spec.ts` `onTimeRate` assertions pass unedited.
7. `invoices.service.spec.ts:7041-7083`'s `startOfCalendarDay` fixtures pass against the extracted module
   with only the import (`startOfCalendarDay` from `../common/calendar-date`) and the argument order
   (`startOfCalendarDay(date, tz)`) updated — no fixture value changes.
8. Every REG-tagged test in `bug-test-plan.md` fails on its stated wrong value before the corresponding fix
   package runs, and passes after.
9. No change touches `routes.service.ts`, the PATCH `/route-runs/:id` wire contract, or any REFUTED/
   UNDETERMINED B91 site.

---

## Verification commands

Per round:

```bash
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
cd apps/api && npx jest src/common src/analytics src/drivers --runInBand
cd apps/mobile && npx tsc --noEmit
cd apps/mobile && npx jest run-lateness.test licence-expiry-iso.test
cd apps/web && npx jest edit-run-modal.logic.test authorizations-expiry.logic.test formatting.calendar-date.test EditRunModal.test calendar-date.test
cd apps/web && npx tsc --noEmit
```

EditRunModal.test.tsx (the component-level proof that EditRunModal is WIRED to the B59 seam) and
apps/web/lib/calendar-date.test.ts were matched by NO command in the original list — both were added
to the per-round web jest line above after the final pass caught it.

Final:

```bash
cd apps/api && npx jest --silent
cd apps/mobile && npx jest --silent
node scripts/campaign-check.mjs
node scripts/validate-lessons.mjs
cd apps/web && npx playwright test --list --reporter=list
```

---

## UI verification

Not configured for this run's jest-scoped gate. The B59/B91 UI round-trip is proven by `WP-E2E`'s spec 34,
which runs post-deploy only (T2 tier) — see `RESUME.md`'s oracle notes for why this is not a live
`uiVerify` block here.

---

## Risks & rollback

| Risk                                                                                                            | Likelihood                                               | Blast radius                                                                                                                                                       | Mitigation                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `resolveCurrentTenantTimezone` accidentally routes through `resolveTenantTimezone`'s `America/New_York` default | low (explicit code + T11 pin)                            | On-Time % shifts for every unconfigured tenant, silently                                                                                                           | T11 pin + the mutation probe on `analytics.service.ts`                                             |
| `endOfCalendarDay`'s DST offset-correction has a sign error                                                     | low (worked by hand for T9, cross-checked against T7/T8) | On-Time % wrong at exactly the DST transition day, twice a year                                                                                                    | T9's dedicated DST fixture; mutation probe on `calendar-date.ts`                                   |
| Licence-writer fix changes stored data shape going forward while old rows stay local-23:59:59                   | confirmed present (deviant writer)                       | Existing rows read wrong under `fmtCalendarDate` until repaired                                                                                                    | WP-SCRIPTS ships the read-only report + gated repair; neither runs in this pipeline; owner decides |
| `finance/reports/page.tsx`'s type-branch misses a third row type introduced later                               | low                                                      | A future row type falls through to the local formatter (safe default — timestamps render correctly; only a calendar-date row type would need adding to the branch) | Acceptance criterion 3 names the branch explicitly for review                                      |

- **Rollback:** revert the diff; no schema/migration involved.
- **Migration reversibility:** N/A — no schema change in this run.
- **Feature flag:** none — behavioral fix, not gated.
- **Deploy day:** existing `RouteRun`/`CustomerAuthorization` rows are unaffected until next written; the
  On-Time % KPI's historical trend line will show a step change on deploy for tenants west of UTC — expected
  and stated in the PR body.
- **Observability:** no new logging; the licence-writer repair report gives the owner a one-time count.

---

## Pipeline args

```js
{
  planPath: '.claude/pipeline/2026-09-04-F25-calendar-bugfix/build-plan.md',
  testPlanPath: '.claude/pipeline/2026-09-04-F25-calendar-bugfix/bug-test-plan.md',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '2026-09-04T13:15:00Z',
  mode: 'bugfix',
  scale: 'major',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25',
  context: 'F25 calendar/date correctness batch A — B59 Critical, B90/B91/B118 Medium; no schema change; three apps; spec 34 deploy-only',
  formatCommand: "git ls-files -mo --exclude-standard | grep -E '\\.(ts|tsx|js|jsx|json|md)$' | grep -v '^\\.claude/pipeline/' | xargs -r npx prettier --write",

  radiusFiles: [
    'apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx',
    'apps/web/app/(dashboard)/routes/page.tsx',
    'apps/web/app/(dashboard)/routes/[id]/page.tsx',
    'apps/web/lib/api/routes.ts',
    'apps/api/src/routes/routes.service.ts',
    'apps/mobile/app/(operator)/exceptions.tsx',
    'apps/mobile/app/(driver)/route/index.tsx',
    'apps/web/app/(dashboard)/dashboard/page.tsx',
    'apps/web/app/(dashboard)/routes/my-runs/page.tsx',
    'apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx',
    'apps/web/app/(dashboard)/deliveries/page.tsx',
    'apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx',
    'apps/web/app/buyer/portal/[seller]/licenses/page.tsx',
    'apps/web/app/(dashboard)/finance/reports/page.tsx',
    'apps/mobile/app/(customer)/payments.tsx',
    'apps/mobile/app/(auth)/role-picker.tsx',
    'apps/mobile/app/(operator)/customers/[id]/licenses.tsx',
    'apps/api/src/authorizations/authorizations.service.ts',
    'apps/api/src/analytics/analytics.service.ts',
    'apps/api/src/analytics/analytics.service.spec.ts',
    'apps/api/src/invoices/invoices.service.ts',
    'apps/api/src/invoices/invoices.service.spec.ts',
    'apps/api/src/common/calendar-date.ts',
    'apps/web/lib/formatting.ts',
    'apps/web/lib/format.ts',
    'apps/mobile/lib/format-date.ts',
    'apps/web/lib/calendar-date.ts',
    'apps/mobile/lib/calendar-date.ts',
    'apps/mobile/lib/run-lateness.ts',
    'apps/web/e2e/34-calendar-dates.spec.ts',
    'apps/web/playwright.config.ts',
    'scripts/report-f25-licence-dates.mjs',
    'scripts/repair-f25-licence-dates.mjs',
    'scripts/REPAIR-RUNBOOK.md'
  ],

  siblingPatterns: [
    { pattern: '(scheduledDate|expiresAt|issueDate)[^\\n]{0,80}toLocaleDateString', note: 'local render of a calendar field' },
    { pattern: 'toLocaleDateString\\([^\\n]{0,80}(scheduledDate|expiresAt|issueDate)', note: 'same, reversed order' },
    { pattern: '(scheduledDate|expiresAt|issueDate)[^\\n]{0,60}\\.get(FullYear|Month|Date)\\(', note: 'local getters on a calendar field' },
    { pattern: 'scheduledDate[\\s\\S]{0,160}setHours\\(0', note: 'local day floor on a calendar field (B90 shape)' },
    { pattern: 'T23:59:59', note: 'a local end-of-day literal written to a calendar column (B91 writer shape)' },
    { pattern: 'setUTCHours\\(23,\\s*59,\\s*59', note: 'a UTC day-end cutoff compared with a real instant (B118 shape)' }
  ],
  siblingExclusions: [
    'Promotion.startsAt/endsAt', 'verifiedAt', 'createdAt', 'paidAt',
    'any date built from createdAt (bookkeeping.service.ts:2147/:2159, customers.service.ts:342/:355)',
    'expiresAt < now instant comparisons in authorizations/credit-notes (POLICY question, filed to owner, not a defect this batch)'
  ],

  testPackages: [
    {
      id: 'TP-WEB', title: 'web seam extraction + REG tests',
      files: [
        'apps/web/app/(dashboard)/routes/_components/edit-run-modal.logic.ts',
        'apps/web/app/(dashboard)/routes/_components/edit-run-modal.logic.test.ts',
        'apps/web/lib/formatting.test.ts'
      ],
      brief: 'T1/T2 extract EditRunModal\'s current buggy read/write bodies verbatim into a named seam module the component calls (behaviour-preserving); T6 asserts fmtCalendarDate vs the local formatter on the same UTC-midnight input. Exact setup/oracle in bug-test-plan.md.'
    },
    {
      id: 'TP-MOB', title: 'mobile seam extraction + REG tests',
      files: [
        'apps/mobile/lib/run-lateness.ts',
        'apps/mobile/__tests__/run-lateness.test.ts',
        'apps/mobile/app/(operator)/customers/[id]/licenses.logic.ts',
        'apps/mobile/__tests__/licence-expiry-iso.test.ts'
      ],
      brief: 'T3/T4 extract exceptions.tsx\'s current device-local-floor predicate verbatim; T5 extracts licenses.tsx\'s current local-23:59:59 write verbatim. Both seams are called from their components unchanged (behaviour-preserving). Exact setup/oracle in bug-test-plan.md.'
    },
    {
      id: 'TP-API', title: 'api REG tests + pins',
      files: [
        'apps/api/src/analytics/analytics.service.calendar.spec.ts',
        'apps/api/src/common/calendar-date.pins.spec.ts'
      ],
      brief: 'T7-T9 tenant-tz on-time fixtures incl. a 2026-03-08 DST edge; T10 pins startOfCalendarDay byte-identical pre/post extraction (against invoices.service.spec.ts\'s existing DST/invalid-zone fixtures). T11 is verified against the EXISTING analytics.service.spec.ts, no new file.'
    }
  ],
  redGate: {
    commands: [
      'cd apps/api && npx jest src/analytics/analytics.service.calendar.spec.ts -t "REG-B" --runInBand',
      'cd apps/web && npx jest edit-run-modal.logic.test authorizations-expiry.logic.test -t "REG-B"',
      'cd apps/mobile && npx jest run-lateness.test licence-expiry-iso.test -t "REG-B"'
    ],
    expect: 'fail'
  },

  packages: [
    {
      id: 'WP-API-CAL', title: 'shared api calendar-date helper + analytics wiring',
      files: ['apps/api/src/common/calendar-date.ts', 'apps/api/src/invoices/invoices.service.ts', 'apps/api/src/invoices/invoices.service.spec.ts', 'apps/api/src/analytics/analytics.service.ts'],
      brief: 'NEW common/calendar-date.ts exports startOfCalendarDay(date, timeZone), endOfCalendarDay(date, timeZone), resolveTenantTimezone(config) [unused by analytics — see its own doc comment], recoverCalendarDay(storedIso, timeZone). invoices.service.ts deletes its private copy, updates 4 call sites to the new arg order; invoices.service.spec.ts gets the matching import + arg-order update only (no fixture value changes). analytics.service.ts\'s accumulateRunMetrics gains a tenantTimezone param and calls endOfCalendarDay instead of setUTCHours(23,59,59,999); a new resolveCurrentTenantTimezone helper resolves it ONCE per call via prisma.tenantConfig.findUnique, returning cfg?.timezone ?? null (NEVER resolveTenantTimezone\'s America/New_York fallback) so an unconfigured tenant keeps today\'s exact UTC boundary. Doc comment at :319-334 rewritten to name the tenant timezone rule.',
      satisfies: ['B118'],
      provenBy: ['T7', 'T8', 'T9', 'T10', 'T11'],
      effort: 'high'
    },
    {
      id: 'WP-WEB', title: 'EditRunModal fix + 7 web display sites',
      files: [
        'apps/web/lib/calendar-date.ts', 'apps/web/lib/formatting.ts',
        'apps/web/app/(dashboard)/routes/_components/edit-run-modal.logic.ts',
        'apps/web/app/(dashboard)/dashboard/page.tsx',
        'apps/web/app/(dashboard)/routes/my-runs/page.tsx',
        'apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx',
        'apps/web/app/(dashboard)/deliveries/page.tsx',
        'apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx',
        'apps/web/app/buyer/portal/[seller]/licenses/page.tsx',
        'apps/web/app/(dashboard)/finance/reports/page.tsx'
      ],
      brief: 'NEW lib/calendar-date.ts (shared pure helpers + `export { fmtCalendarDate } from \'./formatting\'`). edit-run-modal.logic.ts\'s two seam bodies replaced: readCalendarInput -> calendarDateFromIso; buildRunPatchBody gains initialDate and only sets scheduledDate when date !== initialDate. Seven display sites swap toLocaleDateString/local fmtDate for fmtCalendarDate at the cited lines; deliveries/page.tsx keeps its createdAt fallback branch untouched; finance/reports/page.tsx branches on r.type === "INVOICE".',
      satisfies: ['B59', 'B91-web'],
      provenBy: ['T1', 'T2', 'T6'],
      dependsOn: ['TP-WEB']
    },
    {
      id: 'WP-MOB', title: 'exceptions + licence-writer fix + 2 mobile display sites',
      files: [
        'apps/mobile/lib/calendar-date.ts', 'apps/mobile/lib/run-lateness.ts',
        'apps/mobile/app/(operator)/customers/[id]/licenses.logic.ts',
        'apps/mobile/app/(customer)/payments.tsx',
        'apps/mobile/app/(auth)/role-picker.tsx'
      ],
      brief: 'NEW lib/calendar-date.ts (same shared pure helpers + fmtCalendarDate re-export from ./format-date). run-lateness.ts\'s isRunPastDue body replaced with calendarDateFromIso(scheduledDateIso) < localYmd(now) (device-local). licenses.logic.ts\'s buildExpiresAtIso body replaced with isoFromCalendarDate(expiresAt.trim()). payments.tsx:145 and role-picker.tsx:103 swap to fmtCalendarDate.',
      satisfies: ['B90', 'B91-mobile', 'B91-writer'],
      provenBy: ['T3', 'T4', 'T5'],
      dependsOn: ['TP-MOB']
    },
    {
      id: 'WP-E2E', title: 'spec 34 + playwright project entry',
      files: ['apps/web/e2e/34-calendar-dates.spec.ts', 'apps/web/playwright.config.ts'],
      brief: 'NEW calendar-dates project (dependencies:[setup], storageState operator.json, timezoneId America/Los_Angeles) appended AFTER the current last project entry (this sha\'s array runs to line 456 — NOT the stale 09-03 plan\'s cited :393-418). NEW spec follows 23-run-settlement-note.spec.ts\'s self-provisioning idiom for the B59 modal round-trip and a B91 licence render.',
      satisfies: ['B59-e2e', 'B91-e2e'],
      provenBy: ['T1', 'T2'],
      dependsOn: ['WP-WEB'],
      effort: 'low'
    },
    {
      id: 'WP-SCRIPTS', title: 'licence-date report + gated repair script',
      files: ['scripts/report-f25-licence-dates.mjs', 'scripts/repair-f25-licence-dates.mjs', 'scripts/REPAIR-RUNBOOK.md'],
      brief: 'Read-only report of non-UTC-midnight CustomerAuthorization.expiresAt rows per tenant. Dry-run-by-default repair using recoverCalendarDay; test-tenant gated per CLAUDE.md policy; live tenant needs --live-tenant-override + type-back confirm. Duplicates recoverCalendarDay with a byte-identical comment. REPAIR-RUNBOOK.md gains a matching section.',
      satisfies: ['B91-data-repair'],
      provenBy: [],
      dependsOn: ['WP-API-CAL']
    },
    {
      id: 'WP-DOCS', title: 'close-out bookkeeping',
      files: [
        '.claude/campaign/status/F25.jsonl', '.claude/code-map/api.md', '.claude/code-map/web.md',
        '.claude/code-map/mobile.md', '.claude/code-map/_meta.json', '.claude/code-map/CHANGELOG.md',
        '.claude/lessons/LESSONS.md', '.claude/lessons/_meta.json'
      ],
      brief: 'F25.jsonl: B90/B118 -> proven; B59/B91 -> proven-pending-deploy. Code-map surgical entries + _meta.json mappedSha/generatedAt/notes replaced + CHANGELOG bullet. LESSONS.md appends L-047 verbatim (text from the 09-03 plan); _meta.json nextId stays 58, activeCount 35 -> 36, updatedAt bumped.',
      satisfies: [],
      provenBy: [],
      dependsOn: ['WP-API-CAL', 'WP-WEB', 'WP-MOB', 'WP-E2E', 'WP-SCRIPTS'],
      effort: 'low'
    }
  ],

  verifyCommands: {
    perRound: [
      'cd apps/api && npx tsc -p tsconfig.build.json --noEmit',
      'cd apps/api && npx jest src/common src/analytics src/drivers --runInBand',
      'cd apps/mobile && npx tsc --noEmit',
      'cd apps/mobile && npx jest run-lateness.test licence-expiry-iso.test',
      'cd apps/web && npx jest edit-run-modal.logic.test authorizations-expiry.logic.test formatting.calendar-date.test EditRunModal.test calendar-date.test',
      'cd apps/web && npx tsc --noEmit'
    ],
    final: [
      'cd apps/api && npx jest --silent',
      'cd apps/mobile && npx jest --silent',
      'node scripts/campaign-check.mjs',
      'node scripts/validate-lessons.mjs',
      'cd apps/web && npx playwright test --list --reporter=list'
    ]
  },

  mutationProbe: {
    targets: [
      { file: 'apps/mobile/lib/run-lateness.ts', revertFix: true, behavior: 'isRunPastDue compares calendar days, not device-local floors', test: 'REG-B90' },
      { file: 'apps/web/lib/calendar-date.ts', revertFix: true, behavior: 'calendarDateFromIso/isoFromCalendarDate round-trip UTC midnight', test: 'REG-B59,REG-B91' },
      { file: 'apps/mobile/lib/calendar-date.ts', revertFix: true, behavior: 'isoFromCalendarDate feeds the licence writer, never a local 23:59:59 construction', test: 'REG-B91' },
      { file: 'apps/api/src/analytics/analytics.service.ts', revertFix: true, behavior: 'on-time compares against the tenant-tz day end, not a fixed UTC cutoff', test: 'REG-B118' },
      { file: 'apps/api/src/common/calendar-date.ts', revertFix: true, behavior: 'endOfCalendarDay is DST-safe', test: 'REG-B118' }
    ]
  }
}
```
