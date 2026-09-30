# Fix ruling — B59, B90, B91, B118 (F25-calendar)

> Fable @ high rules over the S1 brief + S2 refutation verbatim; it opens no file. One ruling per run.
> Planner ruling date: 2026-09-04. Pinned sha for every cited file:line: `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d`.

## S2 verdict (quoted from `refutation.md`)

| id   | Verdict                                        | One-line reason (quoted)                                                                                                                                                                                                                                                                                            |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B59  | **confirmed**                                  | "Local getters on a UTC-midnight instant (`EditRunModal.tsx:21`), and the shifted day is written back unconditionally (`:56`); the API applies no normalisation that could absorb it."                                                                                                                              |
| B90  | **confirmed**                                  | "Pure device-local filtering (`exceptions.tsx:61`) applied to a field the API stores as a UTC-midnight calendar stamp (`routes.service.ts:907`, `:1343`) — a local-midnight floor is the wrong operation for that contract."                                                                                        |
| B91  | **confirmed** (cited site list partly refuted) | "5 of the 8 cited render sites are genuine calendar-date fields; 3 render real timestamps and are correct today; and one cited field is heterogeneous per row. One writer (`mobile (operator)/customers/[id]/licenses.tsx:84`) breaks the calendar contract at the source."                                         |
| B118 | **confirmed** (two premises corrected)         | "`setUTCHours(23,59,59,999)` at `analytics.service.ts:337` vs the comparison at `:342` is real, but 'TenantConfig.timezone … is ignored' holds only for analytics — a tenant-tz day-start helper already exists and is spec-covered; and the UTC rule is documented at `:325`, making this a specification defect." |

---

## 1. Cause verdict

**All four ACCEPTED as confirmed by `refutation.md`**, with these refinements adopted from S2:

- **B59** — diverging lines `EditRunModal.tsx:19-21` (local getters `getFullYear`/`getMonth`/`getDate` on a UTC-midnight instant) and `:56` (`if (!isInProgress) body.scheduledDate = date;` — date re-sent on every save regardless of dirtiness, contrasted with `:55`'s own dirty check on `driverId`). `apps/api/src/routes/routes.service.ts:1343` persists `new Date("YYYY-MM-DD")` verbatim = UTC midnight with no normalisation of its own — **no API change**. Two mount points: `apps/web/app/(dashboard)/routes/[id]/page.tsx:876` and `apps/web/app/(dashboard)/routes/page.tsx:348-356`.
- **B90** — diverging line `exceptions.tsx:61` (`scheduled.setHours(0,0,0,0)` on a UTC-anchored calendar instant), comparison at `:62`. Negative-offset only (refutation's scope note). The query at `:36` (`useOperatorRouteRuns({ status: "IN_PROGRESS", limit: 20 })`) sends no date parameter, so this is client-side filtering and the correct frame for "today" is the DEVICE's local day compared against the run's CALENDAR day string.
- **B91** — the nine confirmed display sites EXACTLY as `refutation.md` lists them: `dashboard/page.tsx:86` · `routes/my-runs/page.tsx:52` · `routes/[id]/dispatch/page.tsx:534` · `deliveries/page.tsx:75` (`scheduledDate` branch of `:74` only) · `customers/_components/AuthorizationsTab.tsx:273` · `buyer/portal/[seller]/licenses/page.tsx:199` · `finance/reports/page.tsx:1234` (INVOICE rows only) · `mobile (customer)/payments.tsx:145` (`expiresAt` only) · `mobile (auth)/role-picker.tsx:103` — plus the ONE writer `mobile (operator)/customers/[id]/licenses.tsx:84`. The card's other cited sites are REFUTED and must NOT be touched: `promotions/page.tsx:57-62`, buyer `shop/page.tsx:449` (real instants), mobile `statement.tsx:154`, `suppliers/[id].tsx:152`, `(customer)/finances.tsx:145` (timestamps). Undetermined field kinds are NON-GOALS: buyer `templates/page.tsx:85` (`nextFireDate`), `shelf.tsx:41-43`, `CostHistorySheet.tsx:53`.
- **B118** — diverging line `analytics.service.ts:337` (`setUTCHours(23,59,59,999)`), comparison `:342`; the doc comment `:319-334` states the UTC rule and MUST be rewritten with the code; the "offline replay" half of the register claim is dropped as unverified (refutation.md's Missing Evidence: "how much later than real-world completion a replayed `completedAt` lands is unknown").

No S2 round-trip needed — all four verdicts stand as `confirmed`, and none are sent back.

## 2. Fix design (minimal diff)

**Shared helpers.** NEW `apps/api/src/common/calendar-date.ts` exporting `startOfCalendarDay` (moved from `invoices.service.ts:69-89` — invoices then imports it; behaviour pinned), `endOfCalendarDay`, `resolveTenantTimezone`, `recoverCalendarDay`. NEW `apps/mobile/lib/calendar-date.ts` and `apps/web/lib/calendar-date.ts` with the pure helpers (bodies below, under "Exact code — calendar helpers"); `fmtCalendarDate` is RE-EXPORTED from the existing formatting modules (`apps/web/lib/formatting.ts:55`, `apps/mobile/lib/format-date.ts:25`), never reimplemented. Invariant: for any ISO `${D}T00:00:00.000Z`, `calendarDateFromIso` returns `D` in every process timezone; `isoFromCalendarDate(D)` returns `${D}T00:00:00.000Z`.

**B59.** `EditRunModal` seeds its date input from `calendarDateFromIso(run.scheduledDate)`; on save it includes `scheduledDate` ONLY when the input differs from the seeded value (dirty check) and keeps the existing `isInProgress` gate; the value sent stays the `YYYY-MM-DD` string. Must NOT change: the api PATCH contract (`routes.controller.ts:271-280`, no DTO — a validated DTO would be a behaviour change for the DRIVER role too, which shares this endpoint per `:273` `@Roles(OPERATOR, DRIVER)` and `routes.service.ts:1336-1338`), the inline controller body type, the driver-role path, `formatLocalDate`'s other callers (none — `git grep -n formatLocalDate` at this sha returns only `EditRunModal.tsx` itself). Both mount points keep working (`EditableRun` props unchanged).

**B90.** NEW pure `apps/mobile/lib/run-lateness.ts` exporting `isRunPastDue(scheduledDateIso: string, now: Date): boolean` = `scheduledDateIso.slice(0,10) < localYmd(now)` where `localYmd` formats `now` with LOCAL getters (device day). `exceptions.tsx:58-62` calls it; `today` at `:42-43` stays for the other loops (urgent orders, returns — neither reads it). Must NOT change: the memo dependency array (`[urgentOrdersQ.data, pendingReturnsQ.data, activeRunsQ.data]`, `:94`), the urgent-orders and returns loops.

**B91 readers.** Each of the nine sites renders through `fmtCalendarDate` (web `apps/web/lib/formatting.ts`, mobile `apps/mobile/lib/format-date.ts`) — for the two POLYMORPHIC sites split by the discriminator already at hand: `deliveries/page.tsx:74` renders `run?.scheduledDate` with `fmtCalendarDate` and `createdAt` with the existing local formatter; `finance/reports/page.tsx:1234` uses `fmtCalendarDate` when `r.type === "INVOICE"` else the existing local `fmtDate` (`r.type` is already carried on the row per `bookkeeping.service.ts:2137/2149/2161` and already drives `<StatusBadge status={r.type}>` at `:1237`). `AuthorizationsTab.tsx:278` (`verifiedAt`) and `payments.tsx:144` (`c.date`) stay LOCAL. The shared local formatters (`fmtDate`, `formatDate`, payments' file-local `fmtDate`) are NOT converted (they serve correct timestamp callers too — `payments.tsx:32-38`'s `fmtDate` also renders `c.date`/`createdAt` at `:144` and `p.paidAt` at `:291`).

**B91 writer.** `mobile (operator)/customers/[id]/licenses.tsx:84` stores `isoFromCalendarDate(expiresAt.trim())` (UTC midnight), matching the other three writers (`AuthorizationsTab.tsx:64`, `buyer/portal/[seller]/licenses/page.tsx:106`, mobile `(customer)/licenses.tsx:117-130`). Coupled with the data question in §6.

**B118.** `accumulateRunMetrics` gains a `timeZone: string | null` parameter threaded from BOTH callers (`analytics.service.ts:400` route perf and `:447` driver perf), which resolve it ONCE per query via a new private helper reading `TenantConfig.timezone` — the same select `invoices.service.ts:233` uses, quoted verbatim: `select: { invoiceNotes: true, invoiceTerms: true, timezone: true }` (analytics only needs `{ timezone: true }`, a narrower projection of the identical field). The cutoff becomes `endOfCalendarDay(run.scheduledDate, timeZone)`.

**Fallback correction established this pass (F2):** `endOfCalendarDay`'s own internal fallback is `timeZone || "UTC"` (see the "Exact code" block below) — it is UTC, not `resolveTenantTimezone`'s `America/New_York` default (that default exists for the _invoices_ module's day-**start** use, where an un-configured tenant is overwhelmingly on `America/New_York` in practice). For analytics, the new private helper must pass the raw `cfg?.timezone` (possibly `null`) straight into `endOfCalendarDay` and must **NOT** route it through `resolveTenantTimezone`'s New-York fallback — otherwise a tenant with no `TenantConfig` row changes its on-time arithmetic from the existing UTC cutoff to an `America/New_York` cutoff, breaking `analytics.service.spec.ts`'s six existing `onTimeRate` assertions (`:910, :939, :958, :1001, :1067, :1102`), none of which mock `tenantConfig.findUnique` or reference `TenantConfig.timezone`. F2 confirms this is safe to do: `createMockPrisma()` (`apps/api/src/testing/prisma-mock.ts:31-56`) defaults every unstubbed `findUnique` to resolve `null` (never `undefined`, never a throw), so every existing fixture's `this.prisma.tenantConfig.findUnique(...)` call — left unstubbed by those six tests — returns `null`, the new helper returns `null` for `timeZone`, and `endOfCalendarDay(date, null)` falls back to UTC internally — byte-identical to today's `setUTCHours(23,59,59,999)` arithmetic. This keeps the six existing fixtures green with NO edits to them (T11 pin). `analytics.service.ts`'s constructor (`:138-142`) is `(prisma: PrismaService, addonService: AddonService, systemConfig: SystemConfigService)` — no new provider is needed; the helper uses the already-injected `this.prisma`.

The doc comment `analytics.service.ts:319-334` is rewritten to state the tenant-timezone rule (dropping "(UTC)"), matching the code.

Must NOT change: the metric names, the response shapes, the private/public surface, anything under `routes.service.ts`. History changes on read for tenants west of UTC — accepted; state it in the PR body.

**Invariants:** `startOfCalendarDay` extraction is byte-for-byte behaviour-preserving (pinned, T10); no calendar column's STORED shape changes except the mobile licence writer's future writes; the rendered strings at the nine sites are the same format they produce today for a viewer in UTC.

## 3. Regression tests

See `bug-test-plan.md` for the full G/W/T table (REG tokens B59/B90/B91/B118; T10-T12 un-tokened pins, outside the gate). Summary: T1-T2 REG-B59 (read seam, write seam); T3-T4 REG-B90 (`isRunPastDue` today-vs-past); T5-T6 REG-B91 (`isoFromCalendarDate` + licence-writer seam, `fmtCalendarDate` render); T7-T9 REG-B118 (NY 23:30 on-time, 00:30-next-day late, 2026-03-08 DST edge).

Pins (no REG token, outside the red gate): T10 `startOfCalendarDay` fixtures identical before/after extraction; T11 the six existing `analytics.service.spec.ts` `onTimeRate` fixtures stay green under the UTC fallback (no edits to that file); T12 — **omitted this run**: F1 established this repo is on the **WEB-JEST** branch (`apps/web/package.json` already has `"test": "jest"` and `apps/web/jest.config.js` exists), so web's pure helpers get their own REG tests directly (T1, T5, T6) rather than being proven only through mobile plus a mirror-identity pin. `apps/web/lib/calendar-date.ts` and `apps/mobile/lib/calendar-date.ts` still both exist (both apps have production call sites — web's EditRunModal, mobile's licence writer) and share byte-identical bodies for the functions they both export, but that identity is a design constraint carried in the build plan's "Exact code" section, not a jest-enforced pin on this run.

## 4. Blast radius (`radiusFiles`)

- `apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx`
- `apps/web/app/(dashboard)/routes/page.tsx`
- `apps/web/app/(dashboard)/routes/[id]/page.tsx`
- `apps/web/lib/api/routes.ts`
- `apps/api/src/routes/routes.service.ts` (read-only reference `:907`, `:1343`)
- `apps/mobile/app/(operator)/exceptions.tsx`
- `apps/mobile/app/(driver)/route/index.tsx` (the correct pattern, read-only)
- `apps/web/app/(dashboard)/dashboard/page.tsx`
- `apps/web/app/(dashboard)/routes/my-runs/page.tsx`
- `apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx`
- `apps/web/app/(dashboard)/deliveries/page.tsx`
- `apps/web/app/(dashboard)/customers/_components/AuthorizationsTab.tsx`
- `apps/web/app/buyer/portal/[seller]/licenses/page.tsx`
- `apps/web/app/(dashboard)/finance/reports/page.tsx`
- `apps/mobile/app/(customer)/payments.tsx`
- `apps/mobile/app/(auth)/role-picker.tsx`
- `apps/mobile/app/(operator)/customers/[id]/licenses.tsx`
- `apps/api/src/authorizations/authorizations.service.ts` (`:200`/`:266`/`:354`, read-only)
- `apps/api/src/analytics/analytics.service.ts`
- `apps/api/src/analytics/analytics.service.spec.ts`
- `apps/api/src/invoices/invoices.service.ts`
- `apps/api/src/invoices/invoices.service.spec.ts` (`:7041-7083` pins, read-only reference)
- `apps/api/src/common/calendar-date.ts`
- `apps/web/lib/formatting.ts`
- `apps/web/lib/format.ts`
- `apps/mobile/lib/format-date.ts`
- `apps/web/lib/calendar-date.ts`
- `apps/mobile/lib/calendar-date.ts`
- `apps/mobile/lib/run-lateness.ts`
- `apps/web/e2e/34-calendar-dates.spec.ts`
- `apps/web/playwright.config.ts`
- `scripts/report-f25-licence-dates.mjs`
- `scripts/repair-f25-licence-dates.mjs`
- `scripts/REPAIR-RUNBOOK.md`

(31 files.)

## 5. Sibling pattern (`siblingPatterns`)

- (a) `(scheduledDate|expiresAt|issueDate)[^\n]{0,80}toLocaleDateString` — local render of a calendar field.
- (b) `toLocaleDateString\([^\n]{0,80}(scheduledDate|expiresAt|issueDate)` — same, reversed order.
- (c) `(scheduledDate|expiresAt|issueDate)[^\n]{0,60}\.get(FullYear|Month|Date)\(` — local getters on a calendar field.
- (d) `scheduledDate[\s\S]{0,160}setHours\(0` — local day floor on a calendar field (B90 shape).
- (e) `T23:59:59` — a local end-of-day literal written to a calendar column (B91 writer shape).
- (f) `setUTCHours\(23,\s*59,\s*59` — a UTC day-end cutoff compared with a real instant (B118 shape).

**Explicit EXCLUSIONS the judge must respect:** `Promotion.startsAt`/`endsAt`, `verifiedAt`, `createdAt`, `paidAt`, any `date` built from `createdAt` (bookkeeping `:2147`/`:2159`, customers `:342`/`:355`) are real instants; the expiry-comparison semantics (`expiresAt < now` in authorizations/credit-notes) are a POLICY question filed to the owner as a registry candidate, NOT a defect for this batch.

## 6. Data repair

Plausibly YES for `CustomerAuthorization.expiresAt` rows written by the mobile operator form (local 23:59:59 instants). Ship (i) `scripts/report-f25-licence-dates.mjs` — READ-ONLY: per tenant, count rows whose `expiresAt` has a non-midnight UTC time-of-day, sample ids, tenant timezone; (ii) `scripts/repair-f25-licence-dates.mjs` — dry-run by default, `--live` gated exactly like `scripts/repair-f11-stranded-orders.mjs` (`assertTestTenant` / `--live-tenant-override` + type-back confirmation), rewrites each such row to UTC midnight of `recoverCalendarDay(stored, tenantTz)`, JSONL before-state under `local-assets/`. The PR ships both scripts; NEITHER runs in the pipeline; the owner decides after reading the report. Section added to `REPAIR-RUNBOOK.md`.

## 7. Probe plan

| File                                          | `revertFix` | REG test that must go red     |
| --------------------------------------------- | ----------- | ----------------------------- |
| `apps/mobile/lib/run-lateness.ts`             | true        | REG-B90                       |
| `apps/web/lib/calendar-date.ts`               | true        | REG-B59, REG-B91              |
| `apps/mobile/lib/calendar-date.ts`            | true        | REG-B91 (licence-writer seam) |
| `apps/api/src/analytics/analytics.service.ts` | true        | REG-B118                      |
| `apps/api/src/common/calendar-date.ts`        | true        | REG-B118 (DST fixture)        |

Choose-a-defect probes (not revert): **none for the nine B91 display sites** — they are proven post-deploy by e2e spec 34 (T2 tier), not by jest, so there is no jest-reachable red bar to mutation-probe there. State this explicitly at close-out so a missing probe there is read as "by design," not "skipped."
