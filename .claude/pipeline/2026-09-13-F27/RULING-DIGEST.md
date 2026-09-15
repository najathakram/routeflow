# RULING-DIGEST — F27 (Estimates carve-out)

**Tree:** `rf-F27` @ `2d353752` (= `origin/master`). **Branch:** `fix/F27` (from `plan/F27`).
**Schema/migration:** NONE — `issueDate`/`invoiceId` already migrated (`20260908000000_campaign_schema_foundation`).

## Cause verdicts (S2 Opus, refuted-first)

- **B15** medium — CONFIRMED, cause reframed (same-commit mismatch, not drift). +**B15-NAV** (new id): convert navigates to `/invoices/undefined` today (server returns `{id}`, web reads `.invoiceId`).
- **B16** low — **REFUTED, stale.** Already fixed in `60d10e66` (#621, L-072), guarded by `enum-parity.spec.ts`. Close, no fix. Residual (unvalidated `?status=` query) filed separately, not fixed here.
- **B17** high — CONFIRMED, cause reframed on both halves: `send()` status-only matches house pattern (invoices do the same); real gap is a lying toast + `convertToInvoice` never writing the already-migrated `invoiceId`.
- **B70** high — CONFIRMED. `send()`/`decline()` have no CONVERTED guard (unlike `accept()`); launderable to a second invoice. Widened to include `voidEstimate()` (same hole, TOCTOU).
- **B79** high — CONFIRMED. Two independent breaks: web drops `issueDate` from the submit DTO, API `create()` has a closed data literal that would drop it anyway.

## Data repair — NOT bundled (report-first, owner decides)

- **B70 (money-relevant):** any estimate laundered CONVERTED→SENT/DECLINED→ACCEPTED→CONVERTED has minted a duplicate invoice in prod. Read-only report proposed post-landing; owner decides remediation (credit-note/void per finding). Does not block the build.
- **B17:** every existing CONVERTED estimate has `invoiceId = NULL`. Read-only count; no backfill designed.
- **B79:** no backfill — existing rows keep falling back to `createdAt` by design.

## REG tests (all red on HEAD today, per the ruling) — 34 T-ids across:

`apps/api/src/estimates/estimates.service.spec.ts` (B70×9, B17×3, B79×3), new `estimates.issue-date.db.spec.ts` (B79 DB-lane), new `apps/web/app/(dashboard)/estimates/[id]/page.test.tsx` (B15×4), new `.../estimates/page.test.tsx` (B79 web), new date-formatter test (B79 PIN). Full detail: `bug-test-plan.md`.

## Blast radius

`estimates.service.ts` (+spec, +new DB spec), `[id]/page.tsx` (+new test), `page.tsx` (+new test), `apps/web/lib/api/estimates.ts`, `packages/types/api/misc.ts`, a new date-only formatter, `apps/web/e2e/*` specs matching the old Convert/toast text, conditional `customers.service.ts:1774` (if it writes `status`). Bookkeeping: code-map ×3 areas, lessons ×3 archived + L-117/L-118/L-119.

## DECIDE-30 conditions

| Condition                               | Status                                                                                                                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) no data repair                      | **PASS** — repair items are report-first/owner-decided, not bundled into the fix                                                                                                                                                             |
| (b) no migration, or additive-only      | **PASS** — no schema change at all                                                                                                                                                                                                           |
| (c) Opus cause refutation confirmed     | **PASS** — all 5 bugs refuted end-to-end this session (B16 refuted-stale; B15/B17/B70/B79 confirmed, 2 with reframed cause)                                                                                                                  |
| (d) REG test red on its own wrong value | **PENDING (self-enforcing at S6)** — every REG's "today X, expected Y" is specified; actual red-gate execution happens in S6, not at planning time. Bug-pipeline's own gate (`redGate.behaviorallyRed`) blocks the run if any REG is vacuous |

S5.5 grounding: **GROUNDED** (Haiku verified every path/command against the tree; one radiusFiles entry — `LESSONS-DIGEST.md` — is absent at HEAD by design, regenerated in WP4).

## One question for the owner (not blocking S6, but real)

None block starting the build. Post-landing: the **F27-DR-B70** prod report (duplicate invoices from laundered estimates) is money-relevant and needs an owner decision on remediation once real rows are seen — flag this now so it isn't dropped after merge.

## Recommendation

All four DECIDE-30 conditions hold ((d) by the process itself, not yet executed). **Ready for S6** under the standing go — no owner ruling needed to proceed to build.
