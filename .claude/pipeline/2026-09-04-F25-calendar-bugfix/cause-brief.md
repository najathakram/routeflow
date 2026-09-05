# Cause brief — B59, B90, B91, B118 (F25-calendar)

> Written by the S1 evidence agent (Sonnet @ low, read-only). Facts with evidence only — every claim carries a
> file:line, a command output, or a quoted source. The suspected cause is recorded AS A CLAIM. No fix proposals.

Pinned master sha for all citations: `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d` (`git fetch origin master -q; git rev-parse origin/master`). All `git show`/`git blame` below are run against this sha unless noted.

---

## B59 — Edit Route Run silently rolls scheduledDate back one day on every save

### The bug as stated

- **Source (fix card `.claude/pipeline/fix-cards/F25-calendar-date-correctness.md`, register `local-assets/docs/routeflow-bug-register.html#b59`, verbatim):**
  - **Area:** `apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx`
  - **Meant to do:** Opening Edit Route Run shows the run's actual scheduled calendar date, and saving any field (e.g. reassigning the driver) never changes that date.
  - **Actually does:** formatLocalDate parses the UTC-midnight scheduledDate with `new Date(value)` then reads it back with LOCAL getters, rendering one day early for any negative-UTC-offset viewer; handleSave then includes `scheduledDate: date` in the PATCH for every save of a non-IN_PROGRESS run, regardless of which field was actually edited.
  - **The gap:** The date input pre-fills yesterday for US-timezone operators and every save persists that shifted-back date — the run's real scheduled date is destroyed by an edit that never intended to touch it, and shifts again on each subsequent save.
  - **Evidence (as cited):** `EditRunModal.tsx:17-23` (formatLocalDate), `:33`, `:50-56` (`if (!isInProgress) body.scheduledDate = date;` — unconditional), `:99-101`; `apps/api/src/routes/routes.service.ts:875, :1289, :968` (UTC-midnight round-trip); `apps/web/lib/format.ts:21-30` documents this exact anti-pattern as forbidden for calendar-date fields; `apps/mobile/app/(driver)/route/index.tsx:182-186` shows the correct UTC-safe parse already used for the same field.
  - **Suggested fix (registry, unverified claim):** Replace formatLocalDate with a UTC-based extraction (`value.slice(0,10)`) and only include scheduledDate in the PATCH when the date input was actually changed.
  - Register chip: Critical, Open. Ledger (`.claude/campaign/status/F25.jsonl`): `{"id":"B59","batch":"F25","tier":"T2","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"e5b0af8e"}`.

- **Repro (concrete example):** A run has `scheduledDate = "2026-06-10T00:00:00.000Z"` (UTC midnight, per B59/B118's cited UTC-midnight storage convention). A viewer in `America/Los_Angeles` (UTC-7 in June) opens Edit Route Run. `new Date("2026-06-10T00:00:00.000Z")` in that browser evaluates to `2026-06-09 17:00:00` local. `formatLocalDate` then reads `getFullYear()/getMonth()/getDate()` off that local instant, producing the string `"2026-06-09"` for the date `<input>`. The operator changes only the driver (does not touch the date field) and clicks Save. Because `isInProgress` is false, `handleSave` unconditionally sets `body.scheduledDate = date` (the pre-filled, already-wrong `"2026-06-09"`) in the PATCH — API receives `scheduledDate: "2026-06-09"` for a run whose true scheduled day was the 10th.
  - Input: PATCH body `{ id, driverId: <new>, notes, scheduledDate: "2026-06-09" }`
  - Observed: run's `scheduledDate` becomes `2026-06-09T00:00:00.000Z` (one day earlier)
  - Expected: `scheduledDate` stays `2026-06-10T00:00:00.000Z` — untouched, since the operator never edited the date field.

- **Suspected cause (claim, unverified, from the fix card):** "UTC-midnight calendar dates parsed with `new Date()` and read with local getters. B59 is the destructive one — Edit Route Run pre-fills yesterday and PERSISTS it on every save, so a driver reassignment silently moves the run's date. The helper is named formatLocalDate (EditRunModal.tsx:17, called at :33) — it reads like a safe utility, which is why it survived." — `.claude/pipeline/fix-cards/F25-calendar-date-correctness.md`

### Code path

1. `EditRunModal` receives `run.scheduledDate` (an ISO string, UTC midnight) as a prop.
2. `formatLocalDate` (file `apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx`, lines 17-23):

```ts
function formatLocalDate(value: string): string {
  const d = new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
```

3. Called at initial state (line 33): `const [date, setDate] = React.useState(formatLocalDate(run.scheduledDate));` — this is the only place the value is derived from the run; there is no re-derivation on prop change.
4. The date `<input type="date">` (component body, lines ~93-100) is bound to this `date` state and lets the operator change it, but nothing forces the operator to touch it.
5. `handleSave` (lines 50-56):

```ts
const handleSave = () => {
  const body: { id: string; driverId?: string | null; scheduledDate?: string; notes?: string } = {
    id: run.id,
    notes,
  };
  if (driverId !== initialDriverId) body.driverId = driverId || null;
  if (!isInProgress) body.scheduledDate = date;
  updateRun.mutate(body, { ... });
};
```

`body.scheduledDate = date` is gated only on `!isInProgress`, not on "did the user change the date field" — so any save of a SCHEDULED/COMPLETED/CANCELLED run round-trips the (possibly already wrong) `date` state back to the API. 6. API side: `apps/api/src/routes/routes.service.ts` accepts `scheduledDate` on the update DTO and does `data.scheduledDate = new Date(dto.scheduledDate)` (found at line 1343 on current master; registry cited `:1289`, see History below on line drift) — a date-only string (`"2026-06-09"`) parses as UTC midnight, so the round-trip **stores** the wrong day rather than merely displaying it.

### History

- `git blame -L 15,56 <sha> -- "apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx"` — every implicated line (17-23 `formatLocalDate`, 33 the initial-state call, 50-56 `handleSave`'s unconditional `body.scheduledDate = date`) blames to a single commit:
  - `8980490e2` — Najath Akram, 2026-05-02 21:39:16 -0500 — `Reapply "fix(qa): land all 32 findings from 2026-05-02 full-coverage QA"` (a revert of a revert: `This reverts commit 1379616a2ce696cdb39f916640886eeb05ccf323`).
  - `git show --stat 8980490e2` shows this commit touched 12+ files across API and web in one batch: `apps/api/prisma/schema.prisma`, `apps/api/src/auth/auth.service.ts` (91 lines), `apps/api/src/buyer/buyer.controller.ts`, `apps/api/src/invoices/dto/create-invoice.dto.ts`, `apps/api/src/invoices/invoice-pdf.service.ts`, `apps/api/src/invoices/invoices.service.ts` (100 lines), `apps/api/src/routes/routes.controller.ts`, `apps/api/src/routes/routes.service.ts` (95 lines), `apps/api/src/tenant/tenant-resolution.middleware.ts`, `apps/web/app/(auth)/login/page.tsx`, `apps/web/app/(dashboard)/invoices/[id]/edit/page.tsx`, `apps/web/app/(dashboard)/invoices/[id]/page.tsx` — i.e. `EditRunModal.tsx` and its date-handling bug were introduced as one item inside a 32-finding QA batch, not as a dedicated date-correctness change.
- Note on line-number drift: the fix card / register cite `:50-56` and `:99-101` and `routes.service.ts:875, :1289, :968`; reading current master, `handleSave`'s unconditional assignment is at lines 50-56 (confirmed verbatim above) and `routes.service.ts`'s date-write is at line 907 (`scheduledDate: new Date(dto.scheduledDate)`, create path) and line 1343 (`if (dto.scheduledDate) data.scheduledDate = new Date(dto.scheduledDate);`, update path) rather than exactly `:875/:1289/:968` — same construct, offset lines. Flagging for S2 per the citation table's `NO_TOKEN_UNVERIFIED` status on B59.

### Existing tests around this behavior

- No test file exists for `EditRunModal.tsx`: `git ls-tree -r --name-only <sha> -- "apps/web/app/(dashboard)/routes/_components"` lists only the component itself, no `.test.tsx`.
- No Playwright spec references `EditRunModal` or exercises the Edit Route Run modal: `git grep -n "EditRunModal" <sha> -- apps/web/e2e` returns nothing. `apps/web/e2e/23-run-settlement-note.spec.ts:105` is the only e2e hit for `scheduledDate`, and it only sets `scheduledDate: new Date().toISOString()` when creating a run via API fixture — it does not open or save the edit modal.
- **Gap:** nothing today asserts what the PATCH body contains on a driver-only edit, and nothing asserts the displayed date matches the stored UTC date for a negative-offset viewer.

### Production evidence

- None recorded in the sources reviewed (fix card, discovery.md, register). The register's `verinote` records only verification provenance (`Round 2 hunt — adversarially verified — Aug 29, 2026 — master@e5b0af8e — sweep C05`), not a production incident, row count, or amount.

---

## B90 — Mobile Exceptions screen flags on-schedule runs as "Late route"

### The bug as stated

- **Source (fix card / register `#b90`, verbatim):**
  - **Area:** `apps/mobile/app/(operator)/exceptions.tsx`
  - **Meant to do:** Exceptions flags a run as Late only when its scheduled calendar date is before today.
  - **Actually does:** Both today and the scheduled date go through `new Date(x).setHours(0,0,0,0)`; scheduledDate is UTC-midnight, so on negative-UTC-offset devices it collapses to the previous local day.
  - **The gap:** A run scheduled for today is read as scheduled yesterday on US-timezone devices, so on-schedule runs appear in the exception list.
  - **Evidence (as cited):** `apps/mobile/app/(operator)/exceptions.tsx:42-43, :58-65`; `apps/api/src/routes/routes.service.ts:874` (UTC-midnight storage); the correct pattern already in `apps/mobile/app/(driver)/route/index.tsx:179-184`.
  - **Suggested fix (registry, unverified claim):** Compare YYYY-MM-DD calendar-date strings instead of Date + setHours, matching route/index.tsx.
  - Register chip: Medium, Open. Ledger: `{"id":"B90","batch":"F25","tier":"T1","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"e5b0af8e"}`.

- **Repro (concrete example):** A run has `scheduledDate = "2026-06-10T00:00:00.000Z"` and status `IN_PROGRESS` (only `IN_PROGRESS` runs are queried: `useOperatorRouteRuns({ status: "IN_PROGRESS", limit: 20 })`). It is currently `2026-06-10 09:00` local time on an operator's device in `America/New_York` (UTC-4 in June, i.e. `2026-06-10T13:00:00Z`). Device-local `today = new Date()` → `setHours(0,0,0,0)` → local midnight `2026-06-10T04:00:00Z`. `scheduled = new Date("2026-06-10T00:00:00.000Z")` → `setHours(0,0,0,0)` also normalizes to **local** midnight, which for a UTC-midnight instant one bucket back is `2026-06-09T04:00:00Z` (i.e. the UTC-midnight timestamp, read via local `setHours`, is treated as `2026-06-09 20:00` local the previous evening, then floored to `2026-06-09` local midnight).
  - Input: `run.scheduledDate = "2026-06-10T00:00:00.000Z"`, device now = `2026-06-10 09:00 America/New_York`
  - Observed: `scheduled (2026-06-09T04:00:00Z) < today (2026-06-10T04:00:00Z)` → `true` → run is pushed into the Exceptions list as `late_route`
  - Expected: the run is scheduled for today, so it should NOT appear as late.

- **Suspected cause (claim, unverified, from the fix card / batch root cause):** "UTC-midnight calendar dates parsed with new Date() and read with local getters" — same class as B59; the fix card names `exceptions.tsx` as one of two sibling call sites (the other being B59) diverging from the "correct pattern already used" in `apps/mobile/app/(driver)/route/index.tsx`.

### Code path

File `apps/mobile/app/(operator)/exceptions.tsx`:

```ts
const exceptions = useMemo<ExceptionItem[]>(() => {
  const items: ExceptionItem[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  ...
  // Late routes — IN_PROGRESS but scheduled date is before today
  for (const run of activeRunsQ.data?.data ?? []) {
    const scheduled = new Date(run.scheduledDate);
    scheduled.setHours(0, 0, 0, 0);
    if (scheduled < today) {
      const stopsLeft = (run.stops ?? []).filter(
        (s) => s.status === "PENDING" || s.status === "IN_PROGRESS",
      ).length;
      items.push({ id: `run-${run.id}`, type: "late_route", ... });
    }
  }
```

Both `today` and `scheduled` use the JS `Date` object's device-local `setHours`, not `setUTCHours` — confirmed verbatim on current master at these exact lines (see History).

The registry-cited "correct pattern" (`apps/mobile/app/(driver)/route/index.tsx`, current master lines ~179-186):

```ts
// NEW-rweb-7: scheduledDate is a UTC ISO string whose date component is the
// intended calendar date. Parsing it directly with `new Date()` interprets
// midnight UTC as the previous evening in negative-offset timezones, making
// the label show yesterday. Fix: extract the YYYY-MM-DD part and parse it as
// a local date by replacing hyphens with slashes (unambiguous local parse).
const scheduledLocalDate = new Date((run.scheduledDate ?? "").slice(0, 10).replace(/-/g, "/"));
```

This sibling file's own comment (`NEW-rweb-7`) documents the exact failure mode `exceptions.tsx` exhibits, and fixes it by deriving the calendar day from the string's date component before any `Date` parsing — `exceptions.tsx` does not do this.

### History

- `git blame -L 40,44 <sha> -- "apps/mobile/app/(operator)/exceptions.tsx"` and `-L 55,66`: every implicated line (42-43 `today`/`setHours`; 58-62 `scheduled`/`setHours`/comparison) blames to:
  - `5b3d533e0` — Najath Akram, 2026-04-21 11:58:12 -0500. (Commit subject not separately captured in this pass; the `stopsLeft` filter two lines below blames to a later commit `a96713982`, 2026-06-19, "najathakram" — i.e. the late-route flagging logic itself predates a later edit that only touched the stop-count filter, not the date comparison.)

### Existing tests around this behavior

- `git ls-tree -r --name-only <sha> -- apps/mobile/__tests__` shows no test file matching `exception` (i.e. no `exceptions.test.ts`/`.tsx`). Mobile tests are pure-logic-only per CLAUDE.md convention (`__tests__/*.test.ts`), and this screen's date logic is currently untested.
- No web e2e applies (mobile-only screen).

### Production evidence

- None recorded in the sources reviewed.

---

## B91 — Calendar-date fields rendered with local-time formatters — dates show one day early

### The bug as stated

- **Source (fix card / register `#b91`, verbatim):**
  - **Area:** web dispatch/deliveries/dashboard/my-runs, customer + buyer licenses, finance reports; mobile customer payments
  - **Meant to do:** UTC-midnight calendar-date fields render through the UTC-anchored `fmtCalendarDate` regardless of viewer timezone.
  - **Actually does:** Multiple sites use raw `toLocaleDateString` or the local-time `fmtDate` on `scheduledDate`, license `expiresAt`, Receivable Summary `issueDate` and credit-note `expiresAt`.
  - **The gap:** Every cited site renders one day early for negative-UTC-offset viewers — including a regulated-license expiry shown to both operators and buyers.
  - **Suggested fix (registry, unverified claim):** Swap `fmtDate`/`toLocaleDateString` for `fmtCalendarDate` at each cited site, web and mobile.
  - **Verifier's note (register):** "Display-only; the write-side sibling is B59."
  - Register chip: Medium, Open. Ledger: `{"id":"B91","batch":"F25","tier":"T2","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"e5b0af8e"}`. Fix card flags citation status `AMBIGUOUS_FILE`.
  - Fix card additionally lists further offenders the register never names: `promotions/page.tsx:59,60` (startsAt/endsAt), `buyer/portal/[seller]/shop/page.tsx:449`, `templates/page.tsx:85` (nextFireDate), mobile `role-picker.tsx:103`, `customers/[id]/statement.tsx:154`, `suppliers/[id].tsx:152`, `(customer)/finances.tsx:145`, `CostHistorySheet.tsx:53`, `(customer)/shelf.tsx:42` — plus three duplicate local formatters (`web/lib/format.ts`, `web/lib/formatting.ts`, `mobile/utils/format.ts:8`).

- **Repro (concrete example, dashboard site):** A run has `scheduledDate = "2026-06-10T00:00:00.000Z"`. A viewer in `America/Los_Angeles` (UTC-7) opens the dashboard's runs table. The cell renders `new Date(row.original.scheduledDate).toLocaleDateString()`. `new Date("2026-06-10T00:00:00.000Z")` in that browser is `2026-06-09 17:00` local; `toLocaleDateString()` formats using local getters.
  - Input: `scheduledDate = "2026-06-10T00:00:00.000Z"`, viewer TZ `America/Los_Angeles`
  - Observed: cell shows `6/9/2026`
  - Expected: cell shows `6/10/2026` (the stored calendar day).

- **Suspected cause (claim, unverified):** same class root cause as B59/B90 — calendar-date instants decoded with local-time APIs (`new Date(iso).toLocaleDateString()` / local-time `fmtDate`) instead of the UTC-anchored `fmtCalendarDate` helper that already exists at `apps/web/lib/formatting.ts:55` and `apps/mobile/lib/format-date.ts:25` (per the fix card's "Together because" section, with 179 call sites/62 files already on the correct helper).

### Cited display sites — line and what each renders (current master, this pass's own read; some line numbers drifted from the registry's citations, called out per site)

| Site                                          | File:line (as read on master)                                                                                                                                                                             | What it renders                                                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard runs table                          | `apps/web/app/(dashboard)/dashboard/page.tsx` (cell ~line 86 region)                                                                                                                                      | `row.original.scheduledDate ? new Date(row.original.scheduledDate).toLocaleDateString() : "—"`                                                                        |
| My Runs list                                  | `apps/web/app/(dashboard)/routes/my-runs/page.tsx` (`RunRow`, ~line 52 region)                                                                                                                            | `dateLabel = run.scheduledDate ? new Date(run.scheduledDate).toLocaleDateString(undefined, {weekday:"short", month:"short", day:"numeric"}) : ...`                    |
| Dispatch header                               | `apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx` (~line 534 region)                                                                                                                               | `const scheduledDate = new Date(run.scheduledDate).toLocaleDateString([], {weekday:"long", month:"long", day:"numeric"});`                                            |
| Deliveries table                              | `apps/web/app/(dashboard)/deliveries/page.tsx` (~line 74-75 region)                                                                                                                                       | `new Date(run?.scheduledDate ?? row.original.createdAt).toLocaleDateString()`                                                                                         |
| Customer Authorizations tab (license expiry)  | `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx:273` (region confirmed)                                                                                                             | `` `· Expires ${fmtDate(auth.expiresAt)}` `` (local-time `fmtDate`, not `fmtCalendarDate`)                                                                            |
| Buyer portal licenses (license expiry)        | `apps/web/app/buyer/portal/[seller]/licenses/page.tsx:199` (region confirmed)                                                                                                                             | `` `Expires ${fmtDate(row.expiresAt)}` `` (same local `fmtDate`)                                                                                                      |
| Finance Receivable Summary                    | `apps/web/app/(dashboard)/finance/reports/page.tsx:1234` (region confirmed; `r.date = issueDate` per `apps/api/src/bookkeeping/bookkeeping.service.ts:2082` — not independently re-verified in this pass) | `fmtDate(r.date)`                                                                                                                                                     |
| Mobile customer payments (credit-note expiry) | `apps/mobile/app/(customer)/payments.tsx:32-38` (`fmtDate` definition), `:145` (call site)                                                                                                                | `fmtDate` defined as `new Date(s).toLocaleDateString(undefined, {month:"short", day:"numeric", year:"numeric"})`; called as `` `· expires ${fmtDate(c.expiresAt)}` `` |
| Correct sibling for comparison                | `apps/mobile/app/(operator)/credit-notes/[id].tsx:165` (region confirmed)                                                                                                                                 | Same field (`cn.expiresAt`) rendered via `fmtCalendarDate(cn.expiresAt)` — the UTC-safe helper                                                                        |

Note: the further offenders the fix card lists (`promotions/page.tsx`, `buyer/portal/[seller]/shop/page.tsx`, `templates/page.tsx`, mobile `role-picker.tsx`, `customers/[id]/statement.tsx`, `suppliers/[id].tsx`, `(customer)/finances.tsx`, `CostHistorySheet.tsx`, `(customer)/shelf.tsx`) were **not independently re-read in this pass** — listed here as sourced claims only; see Gaps.

### History

- Not individually blamed per site in this pass (nine+ sites named); flagging as a gap for S2 rather than guessing provenance. The fix card's citation status for B91 is `AMBIGUOUS_FILE`, meaning the register's own file attribution needs disambiguation before blame is meaningful.

### Existing tests around this behavior

- `git grep -n "fmtCalendarDate\|toLocaleDateString" <sha> -- apps/web/e2e` was not run in full in this pass (see Gaps); no e2e spec name in the e2e directory listing suggests calendar-date-display coverage (none titled `date`, `calendar`, or `timezone`).
- No `.test.tsx` exists for any of the nine display-site files listed above (spot-checked via directory listings during blame lookups; not exhaustively grepped for co-located specs — see Gaps).

### Production evidence

- None recorded in the sources reviewed.

---

## B118 — On-Time % cutoff is UTC day-end — evening local deliveries scored late

### The bug as stated

- **Source (fix card / register `#b118`, verbatim):**
  - **Area:** Analytics · API Operations tab
  - **Meant to do:** A stop delivered on its scheduled calendar day counts on-time; a route finishing every stop that day shows ~100% On-Time.
  - **Actually does:** `dayEnd = scheduledDate` (stored UTC midnight) `+ setUTCHours(23,59,59,999)`, i.e. 7:59pm EDT / 6:59pm EST local; `completedAt` is server-stamped at completion (or offline replay) time, so evening deliveries and next-morning replays score late. `TenantConfig.timezone` exists and is ignored.
  - **The gap:** Headline On-Time % KPI (red under 90%) is systematically deflated for US tenants running evening routes or offline drivers.
  - **Evidence (as cited):** `apps/api/src/analytics/analytics.service.ts:335-343` (dayEnd via setUTCHours at :336-337, comparison :342), `:363` (onTimeRate); `apps/api/src/routes/routes.service.ts:886` (`new Date(dto.scheduledDate)` — date-only string parses as UTC midnight), `:1705` (`completedAt: new Date()`, unconditionally server-time); `apps/api/prisma/schema.prisma:467` (`TenantConfig.timezone` default `America/New_York`), `:1196` (`RouteRun.scheduledDate DateTime`).
  - **Suggested fix (registry, unverified claim):** Compute the day-end in the tenant's `TenantConfig.timezone` (or add a fixed grace, e.g. `scheduledDate + 30-36h`) and, for offline completions, accept a client-supplied `completedAt` on the completion DTO so replays don't inflate lateness.
  - **Verifier's note (register, important correction):** "Two corrections: the cutoff is 7:59:59pm EDT in summer (6:59:59pm EST in winter), so the claim's '~7pm ET' and its 7:30pm-ET repro are wrong during daylight time — 7:30pm EDT (23:30Z) is still on-time. Also the `analytics.service.ts:322-328` comment documents the UTC-day-end definition as a **deliberate simplification**, so this is a knowingly coarse metric rather than an accident — but the effect on US evening routes stands. Not a duplicate: B59/B90/B91 are different date bugs."
  - Register chip: Medium, Open. Ledger: `{"id":"B118","batch":"F25","tier":"T1","state":"queued","pr":null,"proof":null,"evidence":null,"roundSha":"0cd59277"}`.

- **Repro (concrete example, corrected per the register's verifier note):** A run has `scheduledDate = "2026-06-10T00:00:00.000Z"` (UTC midnight). Tenant timezone is `America/New_York`, DST in effect (EDT, UTC-4) on this date. `dayEnd = new Date("2026-06-10T00:00:00.000Z"); dayEnd.setUTCHours(23,59,59,999)` → `2026-06-10T23:59:59.999Z`, which is `2026-06-10 19:59:59.999` local (7:59:59pm EDT). A driver completes the last stop at `2026-06-10 20:15:00 EDT` (8:15pm local, still the scheduled calendar day by any tenant-local reckoning) — `completedAt = "2026-06-10T00:15:00.000Z"` next day... more precisely `2026-06-11T00:15:00.000Z` UTC.
  - Input: `completedAt = 2026-06-11T00:15:00.000Z` (8:15pm EDT local on the scheduled day), `dayEnd = 2026-06-10T23:59:59.999Z`
  - Observed: `stop.completedAt (2026-06-11T00:15:00Z) <= dayEnd (2026-06-10T23:59:59.999Z)` → `false` → stop counted as **late**
  - Expected (per the bug's framing — tenant-local calendar day): the stop was completed at 8:15pm on the tenant's local calendar day the run was scheduled for, so it should count on-time under a tenant-timezone day-end.
  - Note: per the register's verifier correction, an earlier example (7:30pm EDT) is actually still on-time under the current UTC-day-end logic (23:30Z ≤ 23:59:59.999Z) — the repro above (8:15pm) is chosen specifically so it is late under BOTH the claimed "~7pm" framing and the verifier-corrected 7:59:59pm EDT cutoff.

- **Suspected cause (claim, unverified, from the register/fix card, with the register's own caveat):** the day-end is computed in UTC via `setUTCHours(23,59,59,999)` rather than in the tenant's configured timezone, even though `TenantConfig.timezone` exists and `invoices.service.ts` already reads it elsewhere in the codebase — BUT the implicated code's own comment documents this as a deliberate simplification, not an oversight (see Code path below).

### Code path

`apps/api/src/analytics/analytics.service.ts`, `accumulateRunMetrics` (lines 318-344 as verbatim on current master; registry cites `:335-343`, offset by the leading doc-comment block):

```ts
  /**
   * Folds one run's stop timings into the group accumulator.
   *
   * "On-time" definition: RouteRunStop carries no promised ETA (the schema has
   * no eta / time-window field anywhere), so a completed stop counts as
   * on-time when its completedAt falls on or before the END of its run's
   * scheduledDate calendar day (UTC). Completing early is on-time; anything
   * after the scheduled day is late. ...
   */
  private accumulateRunMetrics(agg: RunMetricAgg, run: RunMetricSource) {
    const dayEnd = new Date(run.scheduledDate);
    dayEnd.setUTCHours(23, 59, 59, 999);
    let runCompletedStops = 0;
    for (const stop of run.stops) {
      if (!stop.completedAt) continue;
      runCompletedStops += 1;
      if (stop.completedAt <= dayEnd) agg.onTimeStops += 1;
    }
    ...
```

The doc-comment explicitly states "on or before the END of its run's scheduledDate calendar day **(UTC)**" — i.e. the UTC framing is documented intent, not a silent bug, matching the register verifier's note.

`finalizeRunMetrics` reads `onTimeRate: agg.completedStops > 0 ? (agg.onTimeStops / agg.completedStops) * 100 : null` (matches the registry's `:363` citation for `onTimeRate`, confirmed on current master a few lines below `accumulateRunMetrics`).

Contrast — `apps/api/src/invoices/invoices.service.ts` already reads `TenantConfig.timezone` and threads it into a `startOfCalendarDay(timezone)` helper at three call sites on current master: line 489 (`: startOfCalendarDay(tenantDefaults.timezone)`), line 628 (`const issueDate = order.orderDate ?? startOfCalendarDay(tenantDefaults.timezone);`), line 2637 (same pattern). The timezone value itself is fetched via a private helper (`invoices.service.ts` ~line 222-238) that selects `timezone` off `TenantConfig` and defaults to `null` when absent:

```ts
   * plus its timezone — the calendar day a same-day invoice is dated in.
    timezone: string | null;
    if (!tenantId) return { notes: null, terms: null, timezone: null };
      select: { invoiceNotes: true, invoiceTerms: true, timezone: true },
      timezone: cfg?.timezone ?? null,
```

(Exact surrounding function signature not re-quoted here — this pass located these lines by grep for `timezone` in the file, not a full contiguous read; see Gaps.)

`apps/api/src/routes/routes.service.ts` — `completedAt` is set unconditionally server-side at four sites on current master (`grep -n "completedAt: new Date()"`): lines 2270, 2347, 2505, 2621 (all `RouteRunStatus.COMPLETED`/stop-completion paths) — none accept a client-supplied timestamp, confirming the registry's claim that offline replays cannot supply their own `completedAt`. The registry's cited line `:1705` does not match current master (nearest hits are 2270/2347/2505/2621) — line-number drift, same construct.

`scheduledDate` is written from a date-only string via plain `new Date(...)` at two sites in `routes.service.ts`: line 907 (`scheduledDate: new Date(dto.scheduledDate)`, run-creation path) and line 1343 (`if (dto.scheduledDate) data.scheduledDate = new Date(dto.scheduledDate);`, update path) — registry cited `:886`; same UTC-midnight-parsing construct, offset lines.

### Tests

- `apps/api/src/analytics/analytics.service.spec.ts` exists and asserts `onTimeRate` under several scenarios (grep hits, current master):
  - line 910: `expect(row.onTimeRate).toBeCloseTo((5 / 6) * 100, 5); // 6 completed, 1 late`
  - line 939: `expect(row.onTimeRate).toBe(100); // all 6 completed stops on-time`
  - line 958: `expect(row.onTimeRate).toBeNull();` (no-data case)
  - line 1001: `expect(row.onTimeRate).toBeCloseTo((2 / 3) * 100, 5); // 3 completed stops, 1 late`
  - lines 1067, 1102: `onTimeRate: 100` in two further scenario fixtures.
  - These specs assert the CURRENT (UTC-day-end) behavior's arithmetic — none construct a fixture at a tenant timezone boundary (e.g. a stop completed at 8pm local / next-day UTC) to assert what "late" should mean across timezones. None reference `TenantConfig.timezone`.
- `git blame -L 335,352 <sha> -- apps/api/src/analytics/analytics.service.ts`: every implicated line blames to a single commit:
  - `de3afd50a` — najathakram, 2026-08-28 21:24:54 -0500 — `feat(analytics): on-time %, stops/hour, avg duration on route & driver performance (#478)`. Commit body (from `git show`): "onTimeRate: RouteRunStop has no promised-ETA field, so a completed stop is on-time when completedAt falls on or before the end of its run's scheduledDate UTC calendar day; denominator = completed stops only." — i.e. the UTC framing was an explicit design choice recorded in the PR body at the metric's introduction, not a later regression.

### Production evidence

- None recorded in the sources reviewed. The register's `verinote` records verification provenance only (`Round 3 hunt — Fable-verified — Aug 29, 2026 — master@0cd59277`).

---

## Gaps

- **B59:** exact current line numbers for `routes.service.ts`'s scheduledDate-write sites differ from the registry's `:875/:1289/:968` (found instead at `:907` create-path and `:1343` update-path on current master) — same construct, but S2 should re-anchor before citing a line number in the ruling. `apps/web/lib/format.ts:21-30` (cited as documenting the anti-pattern) was not read in this pass.
- **B90:** the commit that introduced the `today`/`setHours` and `scheduled`/`setHours` lines (`5b3d533e0`) was not `git show --stat`'d for its subject/scope in this pass — only identified via blame; S2 should pull its commit message and stat.
- **B91:** citation status is `AMBIGUOUS_FILE` per the fix card itself — the nine additional offenders the fix card lists beyond the register's five (promotions/page.tsx, buyer shop page, templates/page.tsx, mobile role-picker.tsx, customers/[id]/statement.tsx, suppliers/[id].tsx, (customer)/finances.tsx, CostHistorySheet.tsx, (customer)/shelf.tsx) were **not independently read or line-verified** in this pass — only the five register-named sites (dashboard, my-runs, dispatch, deliveries, AuthorizationsTab/buyer-licenses, finance/reports, mobile payments) were confirmed against current master. No `git blame` was run for any B91 site — nine-plus files is out of this pass's budget; S2 should prioritize blame on whichever site the T2 e2e oracle will assert against. The three "duplicate local formatters" claim (`web/lib/format.ts`, `web/lib/formatting.ts`, `mobile/utils/format.ts:8`) was not verified — did not open any of the three to compare their exports.
- **B118:** the `invoices.service.ts` timezone-reading helper's exact function name/signature was located by `grep -n "timezone"` rather than a full contiguous read of lines ~215-240 — the surrounding function's name is not quoted here. `apps/api/prisma/schema.prisma:467` (`TenantConfig.timezone` default) and `:1196` (`RouteRun.scheduledDate` type) were not independently re-read in this pass — taken from the registry citation only. No production evidence of an actual deflated On-Time % reading (a tenant's real KPI value) was found in any source — the bug is argued from code + test behavior, not an observed metric.
- **Lessons register:** L-025, L-026, L-029, L-031, L-035 were read per the task's instruction, but none of their Symptom/Root-cause text is specific to calendar dates or timezones — they concern platform-branch test coverage (L-025), spec-vs-file drift (L-026), enumerating sibling mutation paths (L-029), re-deriving reachable call sites before fixing (L-031), and checking the schema for pre-provisioned columns (L-035). Their generalizable **Lesson** lines (quoted in full above under each id) are procedural cautions applicable to this batch's method (don't trust the registry's suggested fix or line numbers verbatim; sweep every sibling site; re-verify reachability) rather than dates-specific prior art — flagging this as an open question for S2/Fable rather than asserting a domain-specific lessons match that isn't there.
- **T2/e2e oracle uncertainty (from spec.md, not independently re-verified):** spec.md records an open question — whether the e2e tenant carries a regulated tracked category the B91 Authorizations-tab oracle could use — as unconfirmed in discovery, with an assumption (license-expiry via API fixture) recorded instead of a verified fact.
