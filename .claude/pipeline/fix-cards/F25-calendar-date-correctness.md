# F25 · Calendar-date correctness

**Bug IDs (5):** B59, B90, B91, B118, B185

**Root cause:** UTC-midnight calendar dates parsed with new Date() and read with local getters. B59 is the destructive one — Edit Route Run pre-fills yesterday and PERSISTS it on every save, so a driver reassignment silently moves the run's date. The helper is named formatLocalDate (EditRunModal.tsx:17, called at :33) — it reads like a safe utility, which is why it survived.

**Ships as:** One PR. Scope is the CLASS, not the cited lines — 15 confirmed offenders (9 web, 6 mobile), several the register never names: promotions/page.tsx:59,60 (startsAt/endsAt), buyer/portal/[seller]/shop/page.tsx:449, templates/page.tsx:85 (nextFireDate), mobile role-picker.tsx:103, customers/[id]/statement.tsx:154, suppliers/[id].tsx:152, (customer)/finances.tsx:145, CostHistorySheet.tsx:53, (customer)/shelf.tsx:42. Also collapse THREE duplicate local formatters (web/lib/format.ts, web/lib/formatting.ts, mobile/utils/format.ts:8, 2 importers) and add the toISOString().slice|split write-side signature to the scanner (81 hits across 55 files — add to G1 as a scan signature even where the sweep does not convert it). Several sites are ALREADY CORRECT and must not be "fixed" — inline timeZone:"UTC", iso+"T00:00:00", new Date(y,m-1,d) from split parts — name them in the spec's non-goals.

**Files:** EditRunModal.tsx · web dashboard/my-runs/dispatch/deliveries/promotions/buyer-shop/templates · mobile role-picker/statement/suppliers/finances/shelf/CostHistorySheet · analytics.service.ts

**Together because:** One shared UTC-safe helper ALREADY EXISTS on both surfaces (apps/web/lib/formatting.ts:55, apps/mobile/lib/format-date.ts:25) with adoption already broad (179 call sites/62 files) — this is a residue sweep, not a new abstraction.

**Guardrails / shared infra:** Delivers G4 — finish the calendar-date conversion.

**Dependencies / lane notes:** None named as blocking, but delivers the shared helper other batches' web/mobile date logic should already be using.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F25.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B59  | T2   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B90  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B91  | T2   | e5b0af8e       | AMBIGUOUS_FILE               |
| B118 | T1   | 0cd59277       | MOVED (disambiguate in-file) |
| B185 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B59 — Edit Route Run silently rolls scheduledDate back one day on every save

**Area:** apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx

**Meant to do:** Opening Edit Route Run shows the run's actual scheduled calendar date, and saving any field (e.g. reassigning the driver) never changes that date.

**Actually does:** formatLocalDate parses the UTC-midnight scheduledDate with `new Date(value)` then reads it back with LOCAL getters, rendering one day early for any negative-UTC-offset viewer; handleSave then includes `scheduledDate: date` in the PATCH for every save of a non-IN_PROGRESS run, regardless of which field was actually edited.

**The gap:** The date input pre-fills yesterday for US-timezone operators and every save persists that shifted-back date — the run's real scheduled date is destroyed by an edit that never intended to touch it, and shifts again on each subsequent save.

**Evidence:** apps/web/app/(dashboard)/routes/_components/EditRunModal.tsx:17-23 (formatLocalDate), :33, :50-56 (`if (!isInProgress) body.scheduledDate = date;` — unconditional), :99-101; apps/api/src/routes/routes.service.ts:875, :1289, :968 (UTC-midnight round-trip); apps/web/lib/format.ts:21-30 documents this exact anti-pattern as forbidden for calendar-date fields; apps/mobile/app/(driver)/route/index.tsx:182-186 shows the correct UTC-safe parse already used for the same field.

**Suggested fix:** Replace formatLocalDate with a UTC-based extraction (`value.slice(0,10)`) and only include scheduledDate in the PATCH when the date input was actually changed.

### B90 — Mobile Exceptions screen flags on-schedule runs as "Late route"

**Area:** apps/mobile/app/(operator)/exceptions.tsx

**Meant to do:** Exceptions flags a run as Late only when its scheduled calendar date is before today.

**Actually does:** Both today and the scheduled date go through `new Date(x).setHours(0,0,0,0)`; scheduledDate is UTC-midnight, so on negative-UTC-offset devices it collapses to the previous local day.

**The gap:** A run scheduled for today is read as scheduled yesterday on US-timezone devices, so on-schedule runs appear in the exception list.

**Evidence:** apps/mobile/app/(operator)/exceptions.tsx:42-43, :58-65; apps/api/src/routes/routes.service.ts:874 (UTC-midnight storage); the correct pattern already in apps/mobile/app/(driver)/route/index.tsx:179-184.

**Suggested fix:** Compare YYYY-MM-DD calendar-date strings instead of Date + setHours, matching route/index.tsx.

### B91 — Calendar-date fields rendered with local-time formatters — dates show one day early

**Area:** web dispatch/deliveries/dashboard/my-runs, customer + buyer licenses, finance reports; mobile customer payments

**Meant to do:** UTC-midnight calendar-date fields render through the UTC-anchored fmtCalendarDate regardless of viewer timezone.

**Actually does:** Multiple sites use raw toLocaleDateString or the local-time fmtDate on scheduledDate, license expiresAt, Receivable Summary issueDate and credit-note expiresAt.

**The gap:** Every cited site renders one day early for negative-UTC-offset viewers — including a regulated-license expiry shown to both operators and buyers.

**Evidence:** apps/web/app/(dashboard)/dashboard/page.tsx:86, routes/my-runs/page.tsx:52, routes/[id]/dispatch/page.tsx:534, deliveries/page.tsx:74-75; customers/_components/AuthorizationsTab.tsx:273 and app/buyer/portal/[seller]/licenses/page.tsx:199; finance/reports/page.tsx:1234 (Receivable Summary date = issueDate per apps/api/src/bookkeeping/bookkeeping.service.ts:2082); apps/mobile/app/(customer)/payments.tsx:32-38, :145 vs the correct apps/mobile/app/(operator)/credit-notes/[id].tsx:165.

**Suggested fix:** Swap fmtDate/toLocaleDateString for fmtCalendarDate at each cited site, web and mobile.

### B118 — On-Time % cutoff is UTC day-end — evening local deliveries scored late

**Area:** Analytics · API Operations tab

**Meant to do:** A stop delivered on its scheduled calendar day counts on-time; a route finishing every stop that day shows ~100% On-Time.

**Actually does:** dayEnd = scheduledDate (stored UTC midnight) + setUTCHours(23,59,59,999), i.e. 7:59pm EDT / 6:59pm EST local; completedAt is server-stamped at completion (or offline replay) time, so evening deliveries and next-morning replays score late. TenantConfig.timezone exists and is ignored.

**The gap:** Headline On-Time % KPI (red under 90%) is systematically deflated for US tenants running evening routes or offline drivers.

**Evidence:** apps/api/src/analytics/analytics.service.ts:335-343 (dayEnd via setUTCHours at :336-337, comparison :342), :363 (onTimeRate); apps/api/src/routes/routes.service.ts:886 (new Date(dto.scheduledDate) — date-only string parses as UTC midnight), :1705 (completedAt: new Date(), unconditionally server-time); apps/api/prisma/schema.prisma:467 (TenantConfig.timezone default America/New_York), :1196 (RouteRun.scheduledDate DateTime).

**Suggested fix:** Compute the day-end in the tenant's TenantConfig.timezone (or add a fixed grace, e.g. scheduledDate + 30-36h) and, for offline completions, accept a client-supplied completedAt on the completion DTO so replays don't inflate lateness.

### B185 — iOS sends -1 for unavailable heading and speed, and the DTO's minimum rejects the whole ping

**Area:** Driver GPS tracking · API + mobile

**Meant to do:** A breadcrumb feed driving a live operator map accepts every valid fix, and rejects implausible or low-confidence ones.

**Actually does:** iOS reports course and speed as -1 when unavailable and the tracker forwards them unchanged; the DTO's non-negative minimums then 400 the entire ping, and the post helper's empty catch swallows it. Separately, no accuracy is captured or validated and any in-range coordinate passes, including the null island.

**The gap:** The validation that exists silently rejects legitimate stationary and indoor fixes, while the plausibility gate that would matter does not exist.

**Evidence:** apps/mobile/lib/location-tracker.native.ts:31-39 and :72-84 (the payload is built from the sample's coords with no accuracy field and no sentinel mapping), :17-24 (the post helper's empty catch); apps/api/src/drivers/dto/post-location.dto.ts (full file: latitude/longitude range checks, heading and speed minimums of 0, battery, recordedAt, runId — no accuracy field and no null-island check); apps/api/src/drivers/drivers.service.ts:99-116 (the only extra check is that recordedAt parses); apps/api/src/routes/routes.service.ts:733-742, 766-776 (the latest row within five minutes is passed through with no quality signal).

**Suggested fix:** Map the iOS -1 sentinels for heading and speed to null client-side (or relax the DTO minimums) so valid pings stop 400-ing, and add an optional accuracy field the tracker populates so fixes above a threshold — or at exactly (0,0) — can be dropped or flagged.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
