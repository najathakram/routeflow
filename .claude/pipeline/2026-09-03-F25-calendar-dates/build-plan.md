# Build plan: F25 calendar-date correctness

> **Stage S5 — "how".** Authored by Fable 5 on `2026-09-03`.
> Status: `APPROVED`
> Written AFTER [test-plan.md](./test-plan.md).
> Inputs: [discovery.md](./discovery.md) (why), [spec.md](./spec.md) (`R#`),
> [test-plan.md](./test-plan.md) (`T#`). No `ux-spec.md` — `ui: false`.

**Gate to pass before S6:** every work package declares `satisfies:` (R#s) and
`provenBy:` (T#s).

**Scale: major.** 5 register bug ids, three apps (api, web, mobile), a DTO change; no money,
no schema change. The small-scale Preamble is DELETED per its own rule (3+ files, cross-cutting,
touches an analytics/on-time-KPI computation).

---

## Objective

Fix five related calendar-date/timezone defects (B59 Critical, B90/B91/B118 Medium, B185 Low)
so that a calendar-date field (a run's scheduled date, a licence/promotion expiry, the on-time
KPI's day boundary) is read, edited, and evaluated as the SAME calendar day regardless of
viewer, server, or tenant timezone — and so a driver's GPS ping is accepted when iOS reports its
"unavailable" sentinel for heading/speed instead of silently 400ing.

**In scope:** the 5 bug ids' verified sites (spec.md R1–R6), the `startOfCalendarDay` extraction
into a shared api helper (R5), the D4 repair script for one known bad writer's pre-fix rows (R7),
and shipping e2e spec 34 + its `playwright.config.ts` project entry in this PR (R8).

**Explicitly out of scope (the scope fence, from spec.md §6 / discovery.md §10):**
`nextFireDate` sites, a repo-wide sweep, the G1 scanner signature, any change to
`fmtCalendarDate`'s rendered output, timezone-selection UI, `routes.service.ts`, client-supplied
`completedAt`, a branded date type, and formatter consolidation.

---

## Constraints & conventions

- **Stack / framework:** NestJS 11 + Prisma 7 (api); Next.js 14 App Router (web, no unit
  runner — Playwright only, campaign decision D1); Expo 55 / RN 0.83 (mobile).
- **Test runner and layout:** api — Jest, `*.spec.ts` beside source (e.g.
  `apps/api/src/analytics/analytics.service.spec.ts`); mobile — Jest,
  `apps/mobile/__tests__/**/*.test.ts` ONLY (`apps/mobile/jest.config.js:11`
  `testMatch: ["**/__tests__/**/*.test.ts"]` — a component file like `exceptions.tsx` is
  unreachable by this runner, so its logic must be extracted to `lib/*.ts` to be testable, the
  established pattern per `lib/buyer-payments-logic.ts` etc.); web — Playwright,
  `apps/web/e2e/NN-slug.spec.ts`, wired via a `playwright.config.ts` project entry (no entry =
  the spec never runs, per the `08-create-order-escape` precedent cited at `:391-393` and
  `:411-413`).
- **Lint / format rules that will fail the gate:** repo ESLint flat config (per-workspace only —
  run via `npm run lint`, never bare `eslint` from root) + Prettier (`prettier.config.js`:
  semicolons, double quotes, `printWidth` 100, trailing commas).
- **Existing patterns to copy rather than invent:**
  - `apps/api/src/invoices/invoices.service.ts:69-89` (`startOfCalendarDay`) — the function
    being extracted; its `try { Intl.DateTimeFormat… } catch { UTC fallback }` shape is the
    house pattern for "never throw on an unknown/invalid IANA zone".
  - `apps/mobile/app/(driver)/route/index.tsx:178-190` — the ALREADY-CORRECT calendar-date
    parse this batch generalizes into a shared helper.
  - `scripts/repair-f11-stranded-orders.mjs` + `scripts/enable-developer-mode.mjs` — the two
    halves of the D4 repair script's safety model (see WP-SCRIPT).
  - `apps/web/playwright.config.ts:393-398,413-418` — the project-entry shape (`name`,
    `testMatch`, `dependencies: ["setup"]`, `use: { ...devices["Desktop Chrome"],
storageState: path.join(AUTH_DIR, "operator.json") }`) this batch's `calendar-dates` entry
    copies, adding `timezoneId`.
- **Design system source:** n/a — `ui: false`, no design surface added or changed.
- **Must NOT change:** `fmtCalendarDate`'s rendered output for any EXISTING (already-correct)
  call site; `routes.service.ts` (any line); the wire shape of `scheduledDate`/`expiresAt` on
  any DTO (both stay `string`); `heading`/`speedKph`'s existing `@Min(0)`/`@Max(...)` validation
  (T11 pins this).
- **Do-not-introduce list (from CLAUDE.md):** Vitest, Biome, Supabase, Vercel, a second HTTP
  client, a root-level test runner or root ESLint config. This batch adds none of them — no new
  npm dependency at all (`Date` + `Intl.DateTimeFormat` only, matching `invoices.service.ts`'s
  existing pattern; `fast-check` is deliberately NOT added, per test-plan.md §5).
- **Landmines:**
  - `EditRunModal.tsx:97` — the "Scheduled Date" `<label>` is NOT `htmlFor`-bound and the date
    `<input>` (`:99-104`) has no `data-testid` — the e2e spec locates it structurally (see
    WP-WEB-E2E); do not "fix" the label as a drive-by (`ui: false`).
  - `analytics.service.ts`'s `accumulateRunMetrics` is called from BOTH `getRoutePerformance`
    (`:400`) and `getDriverPerformance` (`:447`) — one behavior change covers both KPIs; miss
    either call site and one of the two performance endpoints silently keeps the old UTC boundary.
  - The `playwright.config.ts` spec-31/32 quarantine (`:420-462`) is COMMENTED OUT, not deleted
    — do not accidentally uncomment it or renumber around it; the new `calendar-dates` project
    goes with the other phase-2 (`dependencies: ["setup"]`) entries, unrelated to that block.
  - `scripts/` has NO jest project (`ls scripts/__tests__` → does not exist; no `scripts/*.mjs`
    imports from `apps/api/src` today — grepped, zero hits) — T16 lives in
    `apps/api/src/common/calendar-date.spec.ts`, and the repair script DUPLICATES
    `recoverCalendarDay` with a "MUST stay byte-identical to …" comment (the house convention
    already used for `RELEASED_CHANGE_REQUEST_REASON` in `repair-f11-stranded-orders.mjs`),
    never a cross-package import (none exists to reuse, and none is added by this batch).

---

## Two verbatim quotes (per the planner's task — facts (b))

**`apps/api/src/invoices/invoices.service.ts:69-89` (`startOfCalendarDay`) — the function this
batch extracts:**

```ts
export function startOfCalendarDay(timeZone?: string | null, now: Date = new Date()): Date {
  let y: string, m: string, d: string;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const at = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    [y, m, d] = [at("year"), at("month"), at("day")];
  } catch {
    // Unknown/invalid IANA zone stored on TenantConfig — fall back to UTC, never throw.
    [y, m, d] = [
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, "0"),
      String(now.getUTCDate()).padStart(2, "0"),
    ];
  }
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}
```

**`apps/api/src/invoices/invoices.service.ts:224-239` (`resolveTenantInvoiceDefaults` — how the
tenant timezone is read today):**

```ts
private async resolveTenantInvoiceDefaults(): Promise<{
  notes: string | null;
  terms: string | null;
  timezone: string | null;
}> {
  const tenantId = this.prisma.getTenantId();
  if (!tenantId) return { notes: null, terms: null, timezone: null };
  const cfg = await this.prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { invoiceNotes: true, invoiceTerms: true, timezone: true },
  });
  return {
    notes: cfg?.invoiceNotes ?? null,
    terms: cfg?.invoiceTerms ?? null,
    timezone: cfg?.timezone ?? null,
  };
}
```

`WP-API-CAL`'s `resolveTenantTimezone` (below) is the small pure piece this pattern is missing —
`.timezone ?? null` still needs a fallback to the schema's own default before it reaches
`startOfCalendarDay`/`endOfCalendarDay`, which `invoices.service.ts` currently achieves by
passing `timeZone: null` straight through (relying on `startOfCalendarDay`'s OWN `timeZone ||
"UTC"` fallback — note: **UTC**, not `TenantConfig`'s schema default of `America/New_York`).
`analytics.service.ts` uses the schema default instead (see WP-API-CAL) because B118's whole
point is a tenant-timezone-aware boundary, and `America/New_York` (the schema default every
un-configured tenant actually carries) is a materially different fallback than UTC for this
computation.

**Fact (c) — `apps/api/src/routes/routes.service.ts:790-798` (`latestLocation`, from the
discovery report, NOT touched by this batch per the scope fence):**

```ts
latestLocation: loc
  ? {
      lat: Number(loc.lat),
      lng: Number(loc.lng),
      recordedAt: loc.recordedAt.toISOString(),
      speedKph: loc.speedKph != null ? Number(loc.speedKph) : null,
      heading: loc.heading != null ? Number(loc.heading) : null,
    }
  : null,
```

No `accuracy` key — confirms the reader that would surface B185's new column to the live map is
untouched by design (F11's file; a follow-up, not F25's).

---

## Exact code — calendar helpers (write ONCE here; WP-WEB-CAL and WP-MOB-CAL paste it verbatim)

Ruling 6 requires `apps/web/lib/calendar-date.ts` and `apps/mobile/lib/calendar-date.ts` to
share byte-identical pure-function bodies for `calendarDateFromIso`, `isoFromCalendarDate`, and
`calendarDayBounds` (plus the three private helpers they call). Both files paste the block below
verbatim; only their `fmtCalendarDate` re-export differs (mobile already has one at
`apps/mobile/lib/format-date.ts:25`; web's lives at `apps/web/lib/formatting.ts:55` — see
WP-WEB-CAL/WP-MOB-CAL for the re-export lines each file adds around this block).

**Divergence from the ruling's literal description, reported per L-026** (a plan's description
of an algorithm is a hypothesis, not evidence — worked by hand before trusting it): the ruling
describes `endOfCalendarDay` as "`startOfCalendarDay(next calendar day) − 1 ms` — compute the
next day by adding 24h to the UTC-midnight calendar date, THEN taking `startOfCalendarDay` in
the tz, so DST cannot shift it." Worked through by hand (test-plan.md §2.1's T7/T13
derivations), that literal composition does **not** produce the right boundary for a
negative-UTC-offset zone: `startOfCalendarDay` converts an INSTANT → the calendar day it falls
on IN `tz` (backward direction); feeding it a UTC-midnight instant that already symbolically
encodes "day X+1" makes it read back as day X's OWN calendar day for any zone west of UTC (a
UTC-midnight instant is still evening-of-the-previous-day locally there) — the composition
returns the INPUT day unchanged, not day X+1's start. The code below instead solves the actual
needed direction (a calendar day's LOCAL midnight → the true UTC instant) with a standard
offset-correction pass, verified by hand against both a non-DST fixture and the March 2026
spring-forward day (test-plan.md T7/T13) before being written here. It satisfies the ruling's
INTENT ("DST cannot shift it" — the offset is read at the target boundary's own instant, never
assumed constant) via a provably correct construction rather than the literal one described.

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

---

## Test packages

### TP1 — api unit tests (authored before implementation)

- **writes:** NEW `apps/api/src/analytics/analytics.service.calendar.spec.ts` (T5, T6, T7);
  NEW `apps/api/src/drivers/dto/post-location.dto.spec.ts` (T9); `apps/api/src/drivers/drivers.service.spec.ts`
  (existing file — ADD a `describe("recordLocation", …)` block, T10); NEW
  `apps/api/src/common/calendar-date.pins.spec.ts` (T8); NEW
  `apps/api/src/drivers/post-location.pins.spec.ts` (T11); NEW
  `apps/api/src/common/calendar-date.spec.ts` (T16, importing `recoverCalendarDay` from the
  sibling `calendar-date.ts` this same package's implementation work adds it to).
- **tests:** T5, T6, T7, T8, T9, T10, T11, T16
- **brief:** Each test asserts EXACTLY the Given/When/Then and oracle recorded in
  test-plan.md §2/§2.1 — do not invent a different expected value. T5–T7 call
  `accumulateRunMetrics`/the shared helper directly with hand-derived instants (no DB). T8/T11
  are PINS (capture current behavior first, then assert it is unchanged — see test-plan.md §6).
  T9/T10 use `class-validator`'s `validate()` directly (T9) and the EXISTING mocked-Prisma
  harness already in `drivers.service.spec.ts` (T10). T16 imports the pure
  `recoverCalendarDay(storedIso: string, tz: string): string | null` function (returns `null`
  for an already-UTC-midnight row, signalling "skip, unchanged" — see WP-SCRIPT).
- **must fail with:** see test-plan.md §6's table (assertion failures on wrong-day/wrong-boolean
  values, or guarded import failures for the four brand-new symbols).

### TP2 — mobile unit tests (authored before implementation)

- **writes:** NEW `apps/mobile/__tests__/calendar-date.test.ts` (T13, T14, T15); NEW
  `apps/mobile/__tests__/location-sentinels.test.ts` (T12); NEW
  `apps/mobile/__tests__/calendar-date.pins.test.ts` (mirror-identity pin — no T#, see below).
- **tests:** T12, T13, T14, T15
- **brief:** T13/T14 call the shared pure helpers (`calendarDayBounds`,
  `isoFromCalendarDate`/`calendarDateFromIso`) with the exact fixture instants worked by hand in
  test-plan.md §2.1. T15 sets `process.env.TZ` to two opposite-offset zones around the call to
  `fmtCalendarDate`, restoring it in `afterEach`. T12 calls `normalizeLocationSample` with the
  four sub-cases in test-plan.md's T12 row. The mirror-identity pin reads BOTH
  `apps/web/lib/calendar-date.ts` and `apps/mobile/lib/calendar-date.ts` as text (`fs.readFileSync`),
  strips each file's header block comment (the `/** … */` block before the first
  `function`/`export`), and asserts the two remaining bodies are string-identical — this is what
  proves ruling 6's byte-identical-mirror requirement mechanically, not just by convention.
- **must fail with:** guarded-import assertion failures (T12–T14), a wrong-render assertion
  (T15), and — until BOTH `calendar-date.ts` files exist — a file-read error for the mirror pin,
  guarded the same way as every other new-symbol test in this plan.

**Red gate command** (from test-plan.md §6):

```bash
cd apps/api && npx jest src/analytics/analytics.service.calendar.spec.ts src/drivers/dto/post-location.dto.spec.ts src/common/calendar-date.spec.ts --runInBand && cd ../mobile && npx jest __tests__/calendar-date.test.ts __tests__/location-sentinels.test.ts
```

---

## Work packages

### WP-API-CAL — shared api calendar-date helper + its two call sites

- **files:** NEW `apps/api/src/common/calendar-date.ts`; `apps/api/src/invoices/invoices.service.ts`
  (delete the private `startOfCalendarDay` at `:69-89`, update its 4 call sites at `:489, :628,
:2412, :2637` to the new argument order); `apps/api/src/analytics/analytics.service.ts`
  (`accumulateRunMetrics` at `:335-353`, its two call sites at `:400, :447`, plus a new private
  timezone-resolution helper).
- **satisfies:** R5
- **provenBy:** T5, T6, T7, T8
- **dependsOn:** none (test packages run first per engine order; no WP dependency)
- **brief:** Add `startOfCalendarDay`, `endOfCalendarDay`, and `resolveTenantTimezone` to the
  new file (bodies below — `startOfCalendarDay`'s logic must byte-match the old private function
  for T8's pin, with its argument order reversed: `startOfCalendarDay(date: Date | string,
timeZone?: string | null)`, date first). Delete `invoices.service.ts`'s private copy and its
  docblock; import the three exports from `../common/calendar-date`; update all 4 call sites
  from `startOfCalendarDay(tenantDefaults.timezone)` / `startOfCalendarDay(tenantTimezone)` to
  `startOfCalendarDay(new Date(), tenantDefaults.timezone)` / `startOfCalendarDay(new Date(),
tenantTimezone)` (same semantics — `now` defaulted explicitly since the new signature takes it
  first). `addCalendarDays` (`:96-100`) is UNRELATED and stays exactly where it is — the ruling
  names only `startOfCalendarDay` for extraction.
- **exact code:**

```ts
// apps/api/src/common/calendar-date.ts
// (paste the shared readCalendarParts / addUtcCalendarDays / localMidnightUtc helpers from
// the "Exact code — calendar helpers" section above, unchanged, as private functions in this
// file — api cannot import from apps/web or apps/mobile, so each app keeps its own copy.)

/**
 * The calendar day (as a UTC-midnight SYMBOLIC stamp — the storage convention
 * for every calendar-date field in this schema) that `date` falls on, as
 * observed in `timeZone`. Extracted byte-for-byte from
 * invoices.service.ts's private startOfCalendarDay (pinned:
 * calendar-date.pins.spec.ts). Argument order reversed (date first) to read
 * naturally at analytics' new call sites, which pass a real value, not a
 * config-shaped call.
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
 * intended day — its UTC calendar components ARE the intended calendar day,
 * independent of tz (see the old function's own docblock, quoted above this
 * file in build-plan.md). DST-safe: see `localMidnightUtc`.
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
 * falling back to the SCHEMA's own default (`schema.prisma:467`) — never UTC,
 * unlike startOfCalendarDay's own internal fallback, because an un-configured
 * tenant is overwhelmingly on America/New_York in practice and B118's whole
 * point is a tenant-aware boundary, not a UTC one.
 */
export function resolveTenantTimezone(config?: { timezone?: string | null } | null): string {
  return config?.timezone || "America/New_York";
}
```

`analytics.service.ts` changes:

```ts
import { endOfCalendarDay, resolveTenantTimezone } from "../common/calendar-date";

// accumulateRunMetrics gains a third parameter; the UTC setUTCHours line is replaced:
private accumulateRunMetrics(agg: RunMetricAgg, run: RunMetricSource, tenantTimezone: string) {
  const dayEnd = endOfCalendarDay(run.scheduledDate, tenantTimezone);
  let runCompletedStops = 0;
  for (const stop of run.stops) {
    if (!stop.completedAt) continue;
    runCompletedStops += 1;
    if (stop.completedAt <= dayEnd) agg.onTimeStops += 1;
  }
  agg.completedStops += runCompletedStops;
  if (run.startedAt && run.completedAt) {
    const ms = run.completedAt.getTime() - run.startedAt.getTime();
    if (ms > 0) {
      agg.validRunCount += 1;
      agg.validRunMs += ms;
      agg.validRunStops += runCompletedStops;
    }
  }
}

// NEW private helper — resolved ONCE per call (spec.md R5's NFR), not per row:
private async resolveCurrentTenantTimezone(): Promise<string> {
  const tenantId = this.prisma.getTenantId();
  if (!tenantId) return resolveTenantTimezone(null);
  const cfg = await this.prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { timezone: true },
  });
  return resolveTenantTimezone(cfg);
}

// getRoutePerformance (:376) and getDriverPerformance (:417) each gain, right after their
// existing opening lines and BEFORE their `runs = await …findMany(…)` call:
const tenantTimezone = await this.resolveCurrentTenantTimezone();
// …then their existing `this.accumulateRunMetrics(map[id].metrics, run)` calls (:400, :447)
// become:
this.accumulateRunMetrics(map[id].metrics, run, tenantTimezone);
```

The docblock at `:319-334` ("…the END of its run's `scheduledDate` calendar day (UTC)") is
reworded to say "tenant timezone" instead of "(UTC)" as part of this package.

### WP-API-LOC — GPS DTO + persistence (api half of R6)

- **files:** `apps/api/src/drivers/dto/post-location.dto.ts`; `apps/api/src/drivers/drivers.service.ts` (`:105-116`).
- **satisfies:** R6
- **provenBy:** T9, T10, T11
- **dependsOn:** none
- **brief:** Add an optional, non-negative `accuracy` field to the DTO (no `@Max` — the schema
  column is an unbounded `Decimal? @db.Decimal(8,2)`, and no evidence names a plausible upper
  bound); persist it in `recordLocation`'s `create` call. `routes.service.ts:790-798`
  (`latestLocation`) is explicitly NOT touched — the discovery report and the lead plan both
  file surfacing `accuracy` to the live map as a follow-up, outside F25's scope fence.
- **exact code:**

```ts
// apps/api/src/drivers/dto/post-location.dto.ts — insert after the existing speedKph block (:24-29),
// before batteryPct:
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  accuracy?: number;
```

```ts
// apps/api/src/drivers/drivers.service.ts — recordLocation's create call (:105-116) gains one line:
await this.prisma.forTenant().driverLocation.create({
  data: {
    driverId: driver.id,
    runId: dto.runId ?? null,
    lat: dto.lat,
    lng: dto.lng,
    heading: dto.heading,
    speedKph: dto.speedKph,
    accuracy: dto.accuracy,
    batteryPct: dto.batteryPct,
    recordedAt,
  },
});
```

### WP-MOB-CAL — mobile shared calendar-date helper + its three call sites

- **files:** NEW `apps/mobile/lib/calendar-date.ts`; `apps/mobile/app/(operator)/exceptions.tsx`
  (`:42-43,58-65`); `apps/mobile/app/(operator)/customers/[id]/licenses.tsx` (`:84`).
- **satisfies:** R3, R4, R2 (mobile half)
- **provenBy:** T13, T14
- **dependsOn:** none
- **brief:** Create the file with the "Exact code — calendar helpers" block above verbatim,
  plus a re-export of the EXISTING mobile `fmtCalendarDate` (mobile already has one — fact (a) —
  so this is a re-export, never a reimplementation): `export { fmtCalendarDate } from
"./format-date";` and `export type { CalendarDateStyle } from "./format-date";`. Rewire
  `exceptions.tsx`'s late-route predicate to use `calendarDayBounds` with the DEVICE's own IANA
  zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) — matching the driver route screen's
  already-correct pattern, which is likewise device-local, not tenant-timezone-aware (mobile
  operators use their own device's clock; there is no tenant-timezone plumbing on the mobile
  client today, and adding one is out of scope). Rewire `licenses.tsx:84`'s writer to
  `isoFromCalendarDate` instead of the local-`23:59:59` construction.
- **exact code:**

```tsx
// apps/mobile/app/(operator)/exceptions.tsx — replace :42-43 and :58-65:
import { calendarDayBounds } from "../../lib/calendar-date"; // adjust relative depth to this file's actual nesting

  const exceptions = useMemo<ExceptionItem[]>(() => {
    const items: ExceptionItem[] = [];
    const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { start: todayStart } = calendarDayBounds(deviceTimeZone);

    // Urgent pending orders — unchanged, see full file for :46-56

    // Late routes — IN_PROGRESS but scheduled date is before today
    for (const run of activeRunsQ.data?.data ?? []) {
      const { start: scheduledStart } = calendarDayBounds(deviceTimeZone, run.scheduledDate);
      if (scheduledStart < todayStart) {
        const stopsLeft = (run.stops ?? []).filter(
          (s) => s.status === "PENDING" || s.status === "IN_PROGRESS",
        ).length;
        items.push({
          id: `run-${run.id}`,
          type: "late_route",
          title: `Late route — ${run.route?.name ?? "Unnamed route"}`,
          subtitle: `${stopsLeft} stop${stopsLeft === 1 ? "" : "s"} remaining · driver: ${run.driver?.contactName ?? "Unassigned"}`,
          severity: "warning",
          actionLabel: "View run",
          actionRoute: `/(operator)/routes`,
        });
      }
    }
```

```tsx
// apps/mobile/app/(operator)/customers/[id]/licenses.tsx — replace :84:
import { isoFromCalendarDate } from "…/lib/calendar-date"; // adjust relative depth

const payload = {
  licenseNumber: licenseNumber.trim(),
  expiresAt: isoFromCalendarDate(expiresAt.trim()),
};
```

### WP-MOB-LOC — mobile GPS sentinel mapping (mobile half of R6)

- **files:** NEW `apps/mobile/lib/location-sentinels.ts`; `apps/mobile/lib/location-tracker.native.ts`
  (`:8-15` interface, `:32-39`, `:78-85`).
- **satisfies:** R6
- **provenBy:** T12
- **dependsOn:** none
- **brief:** New pure helper mapping a negative-or-null sentinel to `undefined`. Wire it into
  both places `location-tracker.native.ts` builds a payload; `LocationPayload.accuracy` is new,
  `heading`/`speedKph` change from `number | null` to `number | undefined` since
  `normalizeLocationSample` never returns `null`. `expo-location`'s `LocationObjectCoords`
  already carries `.accuracy: number | null` — no new dependency, no new capture logic.
- **exact code:**

```ts
// apps/mobile/lib/location-sentinels.ts
export interface RawLocationSample {
  accuracy?: number | null;
  speed?: number | null;
  heading?: number | null;
}

export interface NormalizedLocationSample {
  accuracy?: number;
  speed?: number;
  heading?: number;
}

/**
 * Maps a platform "unavailable" sentinel to `undefined` for every GPS
 * quality/course field. iOS reports -1 for heading and speed when they
 * cannot be determined (stationary, indoor, or otherwise unavailable);
 * accuracy can likewise arrive negative or absent. `undefined` — never
 * `null`, never -1 — is what a downstream `@IsOptional()` DTO field treats as
 * "not provided"; a `null` would still fail `@IsNumber()`.
 */
export function normalizeLocationSample(raw: RawLocationSample): NormalizedLocationSample {
  const clean = (v: number | null | undefined): number | undefined =>
    v == null || v < 0 ? undefined : v;
  return {
    accuracy: clean(raw.accuracy),
    speed: clean(raw.speed),
    heading: clean(raw.heading),
  };
}
```

```ts
// apps/mobile/lib/location-tracker.native.ts
import { normalizeLocationSample } from "./location-sentinels";

interface LocationPayload {
  lat: number;
  lng: number;
  heading?: number;
  speedKph?: number;
  accuracy?: number;
  recordedAt: string;
  runId?: string | null;
}

// inside the TaskManager.defineTask callback (:32-39), replace the object literal:
const normalized = normalizeLocationSample({
  accuracy: sample.coords.accuracy,
  speed: sample.coords.speed,
  heading: sample.coords.heading,
});
await postLocation({
  lat: sample.coords.latitude,
  lng: sample.coords.longitude,
  heading: normalized.heading,
  speedKph: normalized.speed != null ? normalized.speed * 3.6 : undefined,
  accuracy: normalized.accuracy,
  recordedAt: new Date(sample.timestamp).toISOString(),
  runId: activeRunId,
});

// inside startLocationTracking (:78-85), the same shape:
const normalized = normalizeLocationSample({
  accuracy: current.coords.accuracy,
  speed: current.coords.speed,
  heading: current.coords.heading,
});
await postLocation({
  lat: current.coords.latitude,
  lng: current.coords.longitude,
  heading: normalized.heading,
  speedKph: normalized.speed != null ? normalized.speed * 3.6 : undefined,
  accuracy: normalized.accuracy,
  recordedAt: new Date(current.timestamp).toISOString(),
  runId,
});
```

### WP-WEB-CAL — web shared calendar-date helper + the two write/read sites

- **files:** NEW `apps/web/lib/calendar-date.ts`; `apps/web/lib/formatting.ts` (`fmtCalendarDate`,
  `:55-65` — additive overload only); `apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx`
  (`:17-23,33,50-56,99-104`); the 7 web display sites from the discovery report (B91): `dashboard/page.tsx:86`,
  `routes/my-runs/page.tsx:52`, `routes/[id]/dispatch/page.tsx:534`, `deliveries/page.tsx:73-75`,
  `customers/_components/AuthorizationsTab.tsx:273`, `buyer/portal/[seller]/licenses/page.tsx:51-56,199`,
  `finance/reports/page.tsx:1234`.
- **satisfies:** R1, R2
- **provenBy:** T1, T2 (post-deploy) + the mobile-authored mirror pin (TP2)
- **dependsOn:** none
- **brief:** Create `apps/web/lib/calendar-date.ts` with the "Exact code — calendar helpers"
  block verbatim, plus `export { fmtCalendarDate } from "./formatting";` (fmtCalendarDate STAYS
  in `formatting.ts` — the ruling says re-export, never move). `formatting.ts#fmtCalendarDate`
  gains an ADDITIVE overload for the two styled sites (dispatch, my-runs) that need
  `weekday`/`month:"long"` options `fmtCalendarDate` does not support today (discovery report:
  "no options overload… an additive optional `Intl.DateTimeFormatOptions` param is groundwork").
  Fix `EditRunModal` per R1 (below). Swap each of the 7 sites' `toLocaleDateString`/local
  `fmtDate` call for `fmtCalendarDate` (site 4, `deliveries/page.tsx`, keeps its `createdAt`
  fallback branch on `fmtDate` — that branch is a real timestamp, NOT a calendar date, per the
  discovery report's own "MIXED" note; only the `run.scheduledDate` branch changes). Site 5
  (`AuthorizationsTab.tsx:273`) changes only `:273`'s `expiresAt` — `:278`'s `verifiedAt` stays
  `fmtDate` (a timestamp).
- **exact code:**

```ts
// apps/web/lib/formatting.ts — fmtCalendarDate (:55-65) becomes an additive overload;
// EVERY existing 1-arg call site is byte-identical in output (same branch, unchanged):
export function fmtCalendarDate(d?: string | null): string;
export function fmtCalendarDate(
  d: string | null | undefined,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string;
export function fmtCalendarDate(
  d?: string | null,
  locale?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!d) return "\u2014";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return "\u2014";
  if (options) {
    return dt.toLocaleDateString(locale, { ...options, timeZone: "UTC" });
  }
  return dt.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
```

```tsx
// apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx
import { calendarDateFromIso, isoFromCalendarDate } from "@/lib/calendar-date";
// DELETE formatLocalDate (:17-23) entirely.

export function EditRunModal({ run, onClose }: { run: EditableRun; onClose: () => void }) {
  // …unchanged lines…
  const initialDate = React.useMemo(() => calendarDateFromIso(run.scheduledDate), [run.scheduledDate]);
  const [date, setDate] = React.useState(initialDate);
  // …unchanged lines…

  const handleSave = () => {
    const body: { id: string; driverId?: string | null; scheduledDate?: string; notes?: string } = {
      id: run.id,
      notes,
    };
    if (driverId !== initialDriverId) body.driverId = driverId || null;
    if (!isInProgress && date !== initialDate) body.scheduledDate = isoFromCalendarDate(date);
    updateRun.mutate(body, { /* unchanged */ });
  };
```

This fixes BOTH named defects at once: `formatLocalDate`'s local-getter misread (R9), AND the
unconditional `body.scheduledDate = date` echo (R1's idempotency requirement) — the PATCH now
omits `scheduledDate` entirely unless the operator actually changed the date input.

```tsx
// dashboard/page.tsx:86 — before: new Date(row.original.scheduledDate).toLocaleDateString()
{
  fmtCalendarDate(row.original.scheduledDate);
}

// routes/my-runs/page.tsx:52 — before: new Date(run.scheduledDate).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})
{
  fmtCalendarDate(run.scheduledDate, undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// routes/[id]/dispatch/page.tsx:534 — before: new Date(run.scheduledDate).toLocaleDateString([],{weekday:"long",month:"long",day:"numeric"})
const scheduledDate = fmtCalendarDate(run.scheduledDate, undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

// deliveries/page.tsx:73-75 — only the scheduledDate branch changes:
const run = row.original.runs?.[0];
const date = run?.scheduledDate;
// …render: date ? fmtCalendarDate(date) : fmtDate(row.original.createdAt)

// customers/_components/AuthorizationsTab.tsx:273 — before: `· Expires ${fmtDate(auth.expiresAt)}`
{
  auth.expiresAt ? ` · Expires ${fmtCalendarDate(auth.expiresAt)}` : "";
}
// :278 (verifiedAt) is UNCHANGED — a timestamp.

// buyer/portal/[seller]/licenses/page.tsx:51-56 — delete the page-local fmtDate, import fmtCalendarDate instead;
// :199 becomes: Expires {fmtCalendarDate(row.expiresAt)}

// finance/reports/page.tsx:1234 — before: {fmtDate(r.date)} where r.date is issueDate for INVOICE
// rows (bookkeeping.service.ts:2135) but createdAt for CREDIT_NOTE/PAYMENT rows (:2147,:2159) —
// only the INVOICE row's date is a calendar date (discovery report's "overstatement 1" correction):
{
  r.type === "INVOICE" ? fmtCalendarDate(r.date) : fmtDate(r.date);
}
```

### WP-WEB-E2E — proof wiring (R8)

- **files:** NEW `apps/web/e2e/34-calendar-dates.spec.ts`; `apps/web/playwright.config.ts`
  (new `calendar-dates` project entry, placed with the other phase-2 entries near `:393-418`).
- **satisfies:** R8 (and is what proves R1/R2 post-deploy)
- **provenBy:** T1, T2
- **dependsOn:** none
- **brief:** Self-provisioning fixtures on `e2e-routeflow`, unique `Date.now()` suffixes, never
  cleaned up (same residue tolerance as `21-destructive-guards`/`22-payment-truth`/
  `23-run-settlement-note`'s own fixtures). Does not mutate shared auth state, so L-050's
  dedicated-user rule does not apply — `operator.json`'s storageState is read-only here.
- **exact code:**

```ts
// apps/web/playwright.config.ts — new project entry (place after the cancelled-edit-banner
// entry at :413-418, before the F14 quarantine block at :420+):

    // ── Calendar-date correctness (F25, spec 34) ──────────────────────────────
    // REG-B59 / REG-B91: a UTC-midnight calendar-date field (a run's scheduledDate,
    // a licence's expiresAt) must render and round-trip the SAME calendar day for
    // a viewer west of UTC as for one at UTC — timezoneId pins the browser to
    // America/Los_Angeles so these assertions cannot pass by accident the way
    // they would on this repo's UTC CI runners. Mutating but self-contained:
    // creates its own throwaway `E2E B59 …` route/run and `E2E B91 …` licence on
    // the approved seed tenant; nothing is deleted (same residue tolerance
    // 21/22/23's own fixtures take). NOT part of F25's red gate — deploy-only,
    // per D1 (web has no unit runner).
    // WITHOUT THIS ENTRY THE SPEC NEVER RUNS — see 08-create-order-escape's
    // header for the precedent where exactly that happened and a spec sat dead.
    {
      name: "calendar-dates",
      testMatch: /34-calendar-dates\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: path.join(AUTH_DIR, "operator.json"),
        timezoneId: "America/Los_Angeles",
      },
    },
```

`34-calendar-dates.spec.ts` follows `23-run-settlement-note.spec.ts`'s exact fixture idiom
(`page.goto("/routes")`, `operatorAccessToken(page)`, `apiBase(page.url())`, a `suffix =
Date.now()`-named throwaway route/run/licence) — see test-plan.md §7/§8 for the two flows and
their assertions; the implementer transcribes those, not a third design.

### WP-SCRIPT — D4 repair script (R7, ruling 4)

- **files:** NEW `scripts/repair-f25-licence-dates.mjs`; `scripts/REPAIR-RUNBOOK.md` (new table
  row + a new `###` section, same shape as the existing `repair-f11-stranded-orders.mjs` entry);
  NEW `apps/api/src/common/calendar-date.ts` gains one more export (`recoverCalendarDay`, T16 —
  same file as WP-API-CAL, so this package's ONLY file addition here is the runbook + the
  script; the function itself is declared by WP-API-CAL's package and reused, never redeclared,
  to keep file lists disjoint — see the Package map's `dependsOn`).
- **satisfies:** R7
- **provenBy:** T16
- **dependsOn:** WP-API-CAL (needs `common/calendar-date.ts` to exist so `recoverCalendarDay`
  lands in the SAME file rather than a competing new one)
- **brief:** Safety model copied from `scripts/repair-f11-stranded-orders.mjs` (dry-run by
  default via `SET default_transaction_read_only = on`, one transaction per row with an
  in-transaction re-read, JSONL before-state log, refuses a non-`railway`/`routeflow` database
  without `--force-nonprod`) COMBINED with `scripts/enable-developer-mode.mjs`'s test-tenant
  gate (`assertTestTenant` from `scripts/lib/test-tenants.cjs`; a LIVE (non-test) tenant needs
  the explicit `--live-tenant-override` flag on top of `--execute`, PLUS a type-back
  confirmation via the same `readline`-based `confirm()` helper `enable-developer-mode.mjs`
  already defines) — this script, unlike F11's, defaults to scoping itself to approved test
  tenants because its target rows (mobile-operator-written licences) are far more likely to
  include live client data than F11's stranded-order class was.
  - **Scope query:** every `Customer` regulated-license-style `Authorization.expiresAt` (or
    the equivalent licence-holding table the operator screen writes — confirm the exact model
    name against `apps/api/prisma/schema.prisma` before implementing; `licenses.tsx`'s mutation
    hooks name it) whose UTC time-of-day component is NOT `00:00:00.000` (the tell-tale sign of
    a pre-fix local-`23:59:59` write) AND whose tenant is in scope (`--tenant <slug>`, or every
    tenant when `--live-tenant-override` is not required because the row's own tenant is a test
    tenant).
  - **Pure classifier, DUPLICATED (not imported) into the .mjs script** — see WP-API-CAL's
    landmine note on why no cross-package import exists to reuse. Marked, exactly like
    `RELEASED_CHANGE_REQUEST_REASON` in `repair-f11-stranded-orders.mjs`, with a "MUST stay
    byte-identical to …" comment naming `apps/api/src/common/calendar-date.ts#recoverCalendarDay`.
  - **Writes:** for each in-scope row, `expiresAt = isoFromCalendarDate(recoveredDay)`
    (UTC-midnight of the recovered day) — one transaction per row, re-reading the row's current
    `expiresAt` under lock and aborting that row (not the whole run) on drift, exactly like F11's
    per-run drift check.
  - **JSONL log:** `local-assets/f25-licence-repair-<ts>.jsonl`, one line per row:
    `{ id, tenantId, before: { expiresAt }, after: { expiresAt }, recoveredDay }`.
- **exact code (the pure classifier only — everything else follows the F11/enable-developer-mode
  patterns cited above):**

```ts
// apps/api/src/common/calendar-date.ts — ADD to the file WP-API-CAL creates:

/**
 * Recovers the intended calendar day of a row written by the pre-F25
 * (operator) mobile licence editor, which stored `${date}T23:59:59` LOCAL
 * time (never UTC) instead of UTC midnight. Returns the recovered day as a
 * "YYYY-MM-DD" string, or `null` when `storedIso` is ALREADY a UTC-midnight
 * row (time-of-day exactly 00:00:00.000) — such a row needs no recovery, and
 * running the tz-local-day formula on it would corrupt a good row (it is the
 * PREVIOUS day in most negative-offset zones — see test-plan.md T16's second
 * sub-case).
 *
 * MUST stay byte-identical to the copy in scripts/repair-f25-licence-dates.mjs
 * (mirrors the RELEASED_CHANGE_REQUEST_REASON convention in
 * scripts/repair-f11-stranded-orders.mjs — no cross-package import exists
 * between scripts/*.mjs and apps/api/src today, confirmed in discovery.md §9 A3).
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

```bash
node scripts/repair-f25-licence-dates.mjs                                    # dry run, all test tenants
node scripts/repair-f25-licence-dates.mjs --tenant e2e-routeflow --verbose   # dry run, one tenant
node scripts/repair-f25-licence-dates.mjs --live-tenant-override <live-slug> # dry run, live tenant named explicitly
railway run --service postgres node scripts/repair-f25-licence-dates.mjs \
  --execute --i-have-a-fresh-backup --confirm <rowId>                       # apply, per-row confirm
```

### WP-DOCS — close-out (no app code)

- **files:** `.claude/campaign/status/F25.jsonl`; `.claude/code-map/api.md`,
  `.claude/code-map/web.md`, `.claude/code-map/mobile.md`; `.claude/code-map/_meta.json`;
  `.claude/code-map/CHANGELOG.md`; `.claude/lessons/LESSONS.md`;
  `.claude/lessons/_meta.json`.
- **satisfies:** (process — proves R8's discharge bookkeeping and the campaign/lessons
  gates; no R# of its own)
- **provenBy:** (verified by `node scripts/campaign-check.mjs` and `node
scripts/validate-lessons.mjs` in `verifyCommands.final`)
- **dependsOn:** every other WP (it records what they did)
- **brief:**
  - `F25.jsonl` — REPLACE each line in place (one bug id per line, same JSONL shape as today):
    `B90`, `B118`, `B185` → `"state":"proven"`, `"pr":null` (filled by the PR-opening step
    outside this plan), `"proof"`/`"evidence"` naming the spec file + T-ids that discharge them
    (`B90`: T13; `B118`: T5–T8; `B185`: T9–T12). `B59`, `B91` → `"state":"proven-pending-deploy"`
    (T2-tier — L-041: their T2 spec runs post-deploy only), evidence naming spec 34 + the
    `calendar-dates` project entry + T1/T2.
  - Code map: surgical entries for every NEW/touched file above (purpose + exports/signatures +
    cross-refs) in the matching area file; `_meta.json`: `mappedSha` → `0cfad7ed`, `generatedAt`
    → the run's timestamp, `notes` REPLACED with this batch's one-line note plus the standard
    "history in CHANGELOG.md" pointer sentence (never accumulated — per
    `.claude/code-map/CHANGELOG.md`'s own convention, confirmed by reading it); a new dated
    bullet is ALSO added at the top of `.claude/code-map/CHANGELOG.md` itself.
  - The code-map CHANGELOG bullet at the top of the list (`.claude/code-map/CHANGELOG.md`), per
    `feedback_code_map_routine`'s convention — there is no repo-root `CHANGELOG.md` in this repo.
  - `.claude/lessons/LESSONS.md`: append **exactly** this entry under `## domain` (id
    pre-allocated per SEQUENCE R6 — do not renumber, do not take `nextId`):

```
### L-047 · 2026-09-03 · domain · F25

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

`.claude/lessons/_meta.json`: `nextId` stays `52` (L-047 was pre-allocated, does not consume
it), `activeCount` `29` → `30`, `updatedAt` bumped.

### Package map

| WP         | satisfies | provenBy                   | dependsOn  | Wave            |
| ---------- | --------- | -------------------------- | ---------- | --------------- |
| TP1        | —         | T5,T6,T7,T8,T9,T10,T11,T16 | —          | 0 (tests first) |
| TP2        | —         | T12,T13,T14,T15            | —          | 0 (tests first) |
| WP-API-CAL | R5        | T5,T6,T7,T8                | —          | 1               |
| WP-API-LOC | R6        | T9,T10,T11                 | —          | 1               |
| WP-MOB-CAL | R3,R4,R2  | T13,T14                    | —          | 1               |
| WP-MOB-LOC | R6        | T12                        | —          | 1               |
| WP-WEB-CAL | R1,R2     | T1,T2                      | —          | 1               |
| WP-WEB-E2E | R8        | T1,T2                      | —          | 1               |
| WP-SCRIPT  | R7        | T16                        | WP-API-CAL | 2               |
| WP-DOCS    | (process) | (gates)                    | ALL        | 3               |

Cross-check: every `R#` (R1–R9) appears in some package's `satisfies:` — R9 (the negative
requirement) is satisfied jointly by WP-WEB-CAL (T1/T14's direct assertions) and reviewed via
the mutation-probe targets, so it is not tied to one package's `satisfies:` list alone; note
this explicitly in the PR body per spec.md R9. Every `T#` (T1,T2,T5–T16) appears in some
package's `provenBy:`.

---

## Acceptance criteria

1. `R1` — Opening `EditRunModal` on a run scheduled for day D under any viewer timezone shows
   D; saving without touching the date input leaves `scheduledDate` byte-identical.
2. `R2` — The 7 web sites and 1 mobile site named in WP-WEB-CAL/discovery render through
   `fmtCalendarDate`/its mirror; no `toLocaleDateString`/local getter remains at any of them.
3. `R3` — `licenses.tsx:84` writes `isoFromCalendarDate(...)`, never a local-`23:59:59` string.
4. `R4` — `exceptions.tsx`'s late-route check uses `calendarDayBounds`, matching the driver
   screen's device-local semantics.
5. `R5` — `analytics.service.ts`'s on-time boundary is `endOfCalendarDay(scheduledDate,
tenantTimezone)`, resolved once per call; T5–T8 green.
6. `R6` — `PostLocationDto` accepts optional non-negative `accuracy`; `heading`/`speedKph`
   still reject `-1` (T11 pin green); the mobile tracker never forwards a negative/null
   sentinel unmapped.
7. `R7` — `scripts/repair-f25-licence-dates.mjs --help`-equivalent (its usage banner) documents
   the dry-run default and the live-tenant gate; `recoverCalendarDay` skips already-correct rows.
8. `R8` — `npx playwright test --list --reporter=list` (from the repo's Playwright config)
   shows `34-calendar-dates.spec.ts`'s test titles under the `calendar-dates` project.
9. `R9` (negative) — none of the touched files introduce a NEW `new Date(x).getFullYear()` /
   `getMonth()` / `getDate()` / `setHours()` / bare `toLocaleDateString()` on a calendar-date
   field — verified by the mutation-probe targets going red when such a change is injected.
10. Deploy day: no migration runs; `TenantConfig.timezone` and `DriverLocation.accuracy` are
    read/written for the first time by this PR but were already present on `schema.prisma`
    before it (confirmed by direct read, quoted above) — `npx prisma migrate status` shows no
    new pending migration from this PR.

---

## Verification commands

Per round:

```bash
cd apps/api && npx tsc -p tsconfig.build.json --noEmit
cd apps/api && npx jest src/common src/analytics src/drivers --runInBand
cd apps/mobile && npx tsc --noEmit
cd apps/mobile && npx jest __tests__/calendar-date.test.ts __tests__/location-sentinels.test.ts __tests__/calendar-date.pins.test.ts
cd apps/web && npx tsc --noEmit
```

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

`ui: false` — no design surface added or changed, so the standard `uiVerify` (a11y /
design-system pass) is skipped. Wiring-only checks instead:

- **URL:** n/a — no local dev server is started for this batch's proof; T1/T2 run post-deploy
  against `PLAYWRIGHT_BASE_URL`.
- **Start command:** none.
- **Flows:** the 2 flows in test-plan.md §8 (proof that they EXIST and are wired — not run
  locally): (1) EditRunModal date round-trip under `timezoneId: America/Los_Angeles`; (2) a
  licence's `expiresAt` renders the correct calendar day under the same timezone.
- **Viewports:** desktop only (both flows).
- **Checks:** `console-errors`, `network-failures` only — no `a11y`/`design-system` (no UI
  change).

---

## Risks & rollback

| Risk                                                                                                                            | Likelihood                                                                             | Blast radius                                                    | Mitigation / what the reviewer should watch                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endOfCalendarDay`'s DST-safe derivation has a sign/offset error the hand-worked test-plan cases missed                         | low (worked through twice independently for T7 and T13, cross-checked for consistency) | On-Time % wrong at exactly the DST transition day, twice a year | T7's two sub-cases straddle the exact boundary; the mutation probe (build-plan §9 target 1) proves T5–T7 actually depend on the DST-aware code path, not a coincidental pass            |
| `analytics.service.ts`'s two call sites (`getRoutePerformance`, `getDriverPerformance`) diverge — one gets the fix, one doesn't | low                                                                                    | one of the two KPI endpoints stays wrong silently               | both call sites are explicitly named in WP-API-CAL's file list and acceptance criterion 5; a reviewer should grep `accumulateRunMetrics(` to confirm exactly 2 call sites, both updated |
| `fmtCalendarDate`'s new 3-arg overload changes output for an EXISTING 1-arg caller                                              | very low (branch is `if (options)`, untouched callers take the unchanged branch)       | wrong date/style at an unrelated, already-correct site          | T15 + a manual grep of every existing `fmtCalendarDate(` call confirms none pass a 2nd/3rd argument before this PR                                                                      |
| The repair script's tenant-scope gate is misconfigured and a live tenant's rows are altered without `--live-tenant-override`    | low (copies two already-shipped, reviewed patterns)                                    | wrong `expiresAt` written to a live client's licence row        | dry-run by default; the JSONL log is the rollback source; `--i-have-a-fresh-backup` + per-row `--confirm` required for any write                                                        |
| The `calendar-dates` Playwright project collides with another phase-1/phase-2 project the way L-050's spec-31/32 did            | very low (this spec MUTATES nothing shared — no session revoke, no shared-row edit)    | a sibling spec's session breaks post-deploy                     | explicitly checked in WP-WEB-E2E's brief; no session-mutating call anywhere in `34-calendar-dates.spec.ts`                                                                              |

- **Rollback:** revert the PR's commit(s) — no migration, so a plain code revert is safe. If
  `scripts/repair-f25-licence-dates.mjs` has already been run `--execute` live, reverting
  re-introduces the read-side bug against the NOW-CORRECTED rows (spec.md §8's documented
  caveat) — re-apply the fix rather than leaving the revert in place if that has happened.
- **Migration reversibility:** n/a — no migration.
- **Feature flag / entitlement:** none — this batch is ungated.
- **Deploy day:** existing users see corrected dates on their next page load; tenant owners on a
  negative-UTC-offset timezone see On-Time % rise (accepted, no backfill, per ruling 3 — state
  this in the PR body and HANDOFF.md); the repair script is owner-run, after deploy, on its own
  schedule.
- **Observability:** none new — this batch adds no logging; T5–T8/T9–T12 running green on every
  push is the standing regression signal (test-plan.md §11).

---

## Pipeline args

```js
{
  planPath: '.claude/pipeline/2026-09-03-F25-calendar-dates/build-plan.md',
  discoveryPath: '.claude/pipeline/2026-09-03-F25-calendar-dates/discovery.md',
  specPath: '.claude/pipeline/2026-09-03-F25-calendar-dates/spec.md',
  testPlanPath: '.claude/pipeline/2026-09-03-F25-calendar-dates/test-plan.md',
  lessonsPath: '.claude/lessons/LESSONS.md',
  startedAt: '2026-09-03T00:00:00Z',

  scale: 'major',
  workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-F25',
  context: 'F25 calendar/date correctness — B59 Critical; no schema; three apps; spec 34 deploy-only',

  testPackages: [
    {
      id: 'TP1', title: 'api unit tests',
      files: [
        'apps/api/src/analytics/analytics.service.calendar.spec.ts',
        'apps/api/src/drivers/dto/post-location.dto.spec.ts',
        'apps/api/src/drivers/drivers.service.spec.ts',
        'apps/api/src/common/calendar-date.pins.spec.ts',
        'apps/api/src/drivers/post-location.pins.spec.ts',
        'apps/api/src/common/calendar-date.spec.ts',
      ],
      brief: 'T5-T8, T9-T11, T16 — see test-plan.md §2/§2.1 for exact G/W/T and oracles.',
    },
    {
      id: 'TP2', title: 'mobile unit tests',
      files: [
        'apps/mobile/__tests__/calendar-date.test.ts',
        'apps/mobile/__tests__/location-sentinels.test.ts',
        'apps/mobile/__tests__/calendar-date.pins.test.ts',
      ],
      brief: 'T12-T15 + the mirror-identity pin — see test-plan.md §2/§2.1.',
    },
  ],
  redGate: {
    commands: [
      'cd apps/api && npx jest src/analytics/analytics.service.calendar.spec.ts src/drivers/dto/post-location.dto.spec.ts src/common/calendar-date.spec.ts --runInBand && cd ../mobile && npx jest __tests__/calendar-date.test.ts __tests__/location-sentinels.test.ts',
    ],
    expect: 'fail',
  },

  packages: [
    {
      id: 'WP-API-CAL', title: 'shared api calendar-date helper',
      files: [
        'apps/api/src/common/calendar-date.ts',
        'apps/api/src/invoices/invoices.service.ts',
        'apps/api/src/analytics/analytics.service.ts',
      ],
      brief: 'Extract startOfCalendarDay; add endOfCalendarDay + resolveTenantTimezone; wire analytics.service.ts to resolve tenant tz once per call.',
      satisfies: ['R5'], provenBy: ['T5','T6','T7','T8'],
    },
    {
      id: 'WP-API-LOC', title: 'GPS DTO + persistence',
      files: ['apps/api/src/drivers/dto/post-location.dto.ts', 'apps/api/src/drivers/drivers.service.ts'],
      brief: 'Additive optional accuracy field; persist it in recordLocation.',
      satisfies: ['R6'], provenBy: ['T9','T10','T11'],
    },
    {
      id: 'WP-MOB-CAL', title: 'mobile calendar-date helper + call sites',
      files: [
        'apps/mobile/lib/calendar-date.ts',
        'apps/mobile/app/(operator)/exceptions.tsx',
        'apps/mobile/app/(operator)/customers/[id]/licenses.tsx',
      ],
      brief: 'Shared pure helpers + fmtCalendarDate re-export; fix the exceptions predicate and the licence writer.',
      satisfies: ['R3','R4','R2'], provenBy: ['T13','T14'],
    },
    {
      id: 'WP-MOB-LOC', title: 'mobile GPS sentinel mapping',
      files: ['apps/mobile/lib/location-sentinels.ts', 'apps/mobile/lib/location-tracker.native.ts'],
      brief: 'normalizeLocationSample maps -1/null to undefined; wire into both tracker call sites.',
      satisfies: ['R6'], provenBy: ['T12'],
    },
    {
      id: 'WP-WEB-CAL', title: 'web calendar-date helper + 8 sites',
      files: [
        'apps/web/lib/calendar-date.ts',
        'apps/web/lib/formatting.ts',
        'apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx',
        'apps/web/app/(dashboard)/dashboard/page.tsx',
        'apps/web/app/(dashboard)/routes/my-runs/page.tsx',
        'apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx',
        'apps/web/app/(dashboard)/deliveries/page.tsx',
        'apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx',
        'apps/web/app/buyer/portal/[seller]/licenses/page.tsx',
        'apps/web/app/(dashboard)/finance/reports/page.tsx',
      ],
      brief: 'Shared helpers + additive fmtCalendarDate overload; fix EditRunModal read+write; swap 7 display sites to fmtCalendarDate.',
      satisfies: ['R1','R2'], provenBy: ['T1','T2'],
    },
    {
      id: 'WP-WEB-E2E', title: 'spec 34 + project entry',
      files: ['apps/web/e2e/34-calendar-dates.spec.ts', 'apps/web/playwright.config.ts'],
      brief: 'New calendar-dates project (timezoneId America/Los_Angeles) + the two-flow spec.',
      satisfies: ['R8'], provenBy: ['T1','T2'],
    },
    {
      id: 'WP-SCRIPT', title: 'D4 repair script',
      files: ['scripts/repair-f25-licence-dates.mjs', 'scripts/REPAIR-RUNBOOK.md'],
      dependsOn: ['WP-API-CAL'],
      brief: 'Dry-run-by-default repair using recoverCalendarDay; test-tenant gated per CLAUDE.md policy.',
      satisfies: ['R7'], provenBy: ['T16'],
    },
    {
      id: 'WP-DOCS', title: 'close-out bookkeeping',
      files: [
        '.claude/campaign/status/F25.jsonl',
        '.claude/code-map/api.md', '.claude/code-map/web.md', '.claude/code-map/mobile.md',
        '.claude/code-map/_meta.json', '.claude/code-map/CHANGELOG.md',
        '.claude/lessons/LESSONS.md', '.claude/lessons/_meta.json',
      ],
      dependsOn: ['WP-API-CAL','WP-API-LOC','WP-MOB-CAL','WP-MOB-LOC','WP-WEB-CAL','WP-WEB-E2E','WP-SCRIPT'],
      brief: 'Ledger rows, code-map entries, a dated bullet at the top of the code-map CHANGELOG (.claude/code-map/CHANGELOG.md), and the pre-allocated L-047 lesson entry (exact text in build-plan.md).',
      satisfies: [], provenBy: [],
    },
  ],

  verifyCommands: {
    perRound: [
      'cd apps/api && npx tsc -p tsconfig.build.json --noEmit',
      'cd apps/api && npx jest src/common src/analytics src/drivers --runInBand',
      'cd apps/mobile && npx tsc --noEmit',
      'cd apps/mobile && npx jest __tests__/calendar-date.test.ts __tests__/location-sentinels.test.ts __tests__/calendar-date.pins.test.ts',
      'cd apps/web && npx tsc --noEmit',
    ],
    final: [
      'cd apps/api && npx jest --silent',
      'cd apps/mobile && npx jest --silent',
      'node scripts/campaign-check.mjs',
      'node scripts/validate-lessons.mjs',
      'cd apps/web && npx playwright test --list --reporter=list',
    ],
  },

  formatCommand: "git ls-files -mo --exclude-standard | grep -E '\\.(ts|tsx|js|jsx|json|md)$' | grep -v '^\\.claude/pipeline/' | xargs -r npx prettier --write",

  mutationProbe: {
    targets: [
      { file: 'apps/api/src/common/calendar-date.ts', behavior: 'endOfCalendarDay is the tenant-tz day end, DST-safe', test: 'T5,T6,T7' },
      { file: 'apps/api/src/analytics/analytics.service.ts', behavior: 'on-time compares against the tenant-tz day end, not UTC', test: 'T5' },
      { file: 'apps/api/src/drivers/dto/post-location.dto.ts', behavior: 'accuracy < 0 is rejected', test: 'T9' },
      { file: 'apps/mobile/lib/location-sentinels.ts', behavior: 'negative/null sentinels become undefined', test: 'T12' },
      { file: 'apps/mobile/lib/calendar-date.ts', behavior: 'isoFromCalendarDate yields UTC midnight, never local', test: 'T14' },
      { file: 'apps/mobile/lib/calendar-date.ts', behavior: 'calendarDayBounds matches the driver-screen semantics on a DST day', test: 'T13' },
      { file: 'apps/api/src/common/calendar-date.ts', behavior: 'recoverCalendarDay interprets the stored instant in the tenant tz', test: 'T16' },
    ],
  },
}
```

**Restated house rules** (CLAUDE.md, quoted where exact wording matters):

- **Money discipline:** "All line/tax/total math goes through `pricing.ts` helpers…" — n/a to
  this batch; confirmed none of the five bug ids reach `pricing.ts`, `computeLineSubtotal`, or
  `roundMoney` (discovery report, "Money math: none of the five touches pricing.ts").
- **Conventions:** "Tests: NestJS `Test.createTestingModule`; mock at the module boundary;
  `class-validator` DTOs. **No snapshot tests, no Vitest.**" — every new api test in this plan
  uses direct function calls or the existing mocked-Prisma harness, never a snapshot.
  "Commits: Conventional Commits (enforced by commitlint)." "Mobile mirrors web: reuse the same
  API endpoints/DTOs/flows; only the UI differs" — this batch's mobile/web mirrors
  (`calendar-date.ts` × 2) are the literal embodiment of this rule for a shared pure-logic
  layer. "Prettier: semicolons, double quotes, `printWidth` 100, trailing commas."
- **Test tenants & real-client data (POLICY — no exceptions):** "Approved test tenants: `test`,
  `e2e-routeflow`, `routeflow-demo`, and throwaway slugs matching `qa-*`, `e2e-*`, or
  `ux-audit-*`. ALL testing, seeding, QA, and cleanup — local or production — happens ONLY on
  these, with dummy retailers/buyers." — `34-calendar-dates.spec.ts` targets `e2e-routeflow`
  only (enforced by `helpers/constants.ts`'s `assertTestTenant`); `repair-f25-licence-dates.mjs`
  defaults to the same set and requires `--live-tenant-override` + type-back for anything else.
  "Never hardcode credentials or production connection strings anywhere; read `DATABASE_URL` …
  from the environment." — the repair script follows `repair-f11-stranded-orders.mjs`'s
  `resolveUrl()` pattern exactly, no hardcoded connection string.
- No Playwright is ever run locally in this pipeline — `--list` only, per house rule.
- `*.pins.spec.ts` / `*.pins.test.ts` files are OUTSIDE the red gate (test-plan.md §6).
- Never run `npm run format`/`npm run verify` inside an agent's own turn — use the scoped
  `formatCommand` above.
- Conventional Commits for any commit this plan's implementation produces.
