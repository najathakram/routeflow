# Discovery — Phase 0 W2 Tasks T12–T15 (house tenant bootstrap + MRR display closeout)

**Status:** `APPROVED`
**Stage:** S1 — Discovery (why) · **Author:** Fable 5.1 (planning subagent) · **Date:** 2026-09-14
**Lives at:** `.claude/pipeline/2026-09-14-phase0-t12-t15/discovery.md`
**Next:** [spec.md](./spec.md)

## 1. The problem, in the requester's own words

> "T1-T11 are already shipped ... build only: P0-T12 (PlatformConfig house-tenant key +
> bootstrap-house-tenant.mjs), P0-T13 (TenantMirrorService with @LeaderCron), P0-T14 (Web live
> catalog / plan labels / MRR field rename), P0-T15 (full verification pass)."

**Restated:** The Phase 0 truth layer (T1–T11, PR #743 stacked locally) now computes one real
MRR (`MrrService.computeOverview()`, PRODUCTION-tenant-scoped) and the billing page already reads
it directly — but the dashboard still renders that same true value through a stale `estMrrUsd`
alias under a misleading "Est." label, the ledger-reconciled figure the same call returns is
shown nowhere, and there is no house tenant (`routeflow-hq`) holding one Customer row per real
tenant, so nothing later (Phase 1 invoicing, Phase 4 messaging) has a record to bill or message
against. T12–T15 finish that wiring.

**Source:** the owner's task brief (this session), pointing at
`docs/superpowers/plans/2026-09-12-backoffice-phase-0-truth.md` Tasks 12–15 as the source of
truth for scope.

## 2. Who has this problem

| Role                                                     | How often                                    | Cost today                                                                                                                                                                                                                                  | Evidence                                                                                                                                  |
| -------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Platform admin (the owner)                               | Every dashboard/billing page view            | Pre-#743: dashboard showed "$499" vs billing "$0.00" for the same period — a trust problem in the platform's own money numbers. Post-#743 the _number_ agrees but the dashboard still labels it "Est." and hides the ledger reconciliation. | Parent spec `docs/superpowers/specs/2026-09-12-backoffice-phase-0-truth-design.md`; confirmed live by reading both pages' current source. |
| Every later phase (Phase 1 invoicing, Phase 4 messaging) | Blocked entirely until a house tenant exists | Cannot bill or message a real tenant from HQ with no record representing that tenant                                                                                                                                                        | `docs/superpowers/specs/2026-09-12-platform-backoffice-design.md`                                                                         |

## 3. What they do instead today

- **Current workaround:** none for the missing house tenant — later phases simply cannot start.
  For the dashboard label, the admin mentally discounts the "Est." figure.
- **Why it fails:** a mental discount on a real, now-correct number erodes trust in the platform's
  own tooling for no reason; a missing house tenant is a hard blocker, not a workaround.
- **Cost:** low-frequency but structural — every future Phase 0+ task inherits the gap.

## 4. Why now

T1–T11 already shipped the truth layer these four tasks complete (`Customer.representsTenantId`,
`TenantClass`, widened `TenantPlan`, `mrr`/`ledgerMrr` on `MrrService` all exist and are verified
present on this branch). T12–T15 is the last segment of Wave W2 ("Truth"); W4/W5/W6 all
`dependsOn: W2` per `waves.json` and cannot start until it closes.

**Deadline:** none externally imposed; internally gating (every downstream wave).

## 5. If we ship nothing

Dashboard keeps showing "Est." on a figure that is no longer an estimate; `ledgerMrr` stays
invisible; the `estMrrUsd` alias lingers as a trap for a future editor who removes it without
checking consumers and silently breaks the dashboard. No `routeflow-hq` tenant exists, so no
mirror rows exist, and Phase 1/4 cannot begin. GROWTH/SCALE tenants render with no plan badge
label and cannot be created from the admin form at all (hardcoded
`STARTER/PROFESSIONAL/ENTERPRISE`).

## 6. Success signal — one, observable

| Signal                                                                                                                                                  | Today's baseline                                                                                             | Target                                                                                                                                                            | Where measured                                                         | When                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| Dashboard MRR and billing-page MRR show the identical figure, and `routeflow-hq` exists with exactly one mirrored `Customer` per PRODUCTION/DEMO tenant | Dashboard shows a labeled "Est." figure; billing shows the true figure independently; no house tenant exists | Both pages show the same unlabeled figure; `SELECT count(*) FROM "Customer" WHERE "representsTenantId" IS NOT NULL` = number of PRODUCTION/DEMO tenants processed | Manual walkthrough + a DB count query on the compose stack (R33/T15-3) | At T15's verification pass |

## 7. Everyone else affected

| Party                             | How touched                                                                | What they need                                               | Consulted?                                               |
| --------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
| Support                           | None — internal admin surface only                                         | n/a                                                          | n/a                                                      |
| Finance/billing                   | The MRR figure they'd reference in reporting becomes internally consistent | Nothing new to learn — same number, clearer label            | n/a — no new behavior for them                           |
| Later-phase engineers (Phase 1/4) | Gain the house tenant + mirror rows to build on                            | The exact shape documented here and in the plan's file table | Yes — this pack cites the parent specs they'll read next |

## 8. Root-cause check

- **Symptom or cause:** Building the missing piece (cause), not patching a symptom.
- **Prior art:** none in this repo — `routeflow-hq` is new; the placeholder-identity pattern it
  needs already exists at `customers.service.ts:484-509` for an analogous problem (a Customer
  with no natural email), reused here for "a Customer with no natural login user."

## 9. Riskiest assumption and the cheapest way to kill it

| #   | Assumption                                                                                                                                                                       | If wrong                                                                                                                                                            | Cheapest kill                                                                                                                                                                                                     | Cost    | Result                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------- |
| A1  | A placeholder `User` row per mirrored tenant (no real login, `role: CUSTOMER`, non-routable email) is an acceptable design for satisfying `Customer.userId`'s required-unique FK | A hidden Prisma middleware/side-effect on `User.create` (welcome email, seat counting, Stripe sync) fires on the placeholder and does something wrong in production | Baseline grep: `apps/api/src` for `$use(`/`$extends(` on the Prisma client, or any User-create side effect near `customers.service.ts`'s own placeholder-user call (which has run in production without incident) | ~2 min  | pending — resolved at Baseline before implementation starts                      |
| A2  | `Customer.representsTenantId` is `@unique` (not merely indexed)                                                                                                                  | The "exactly one mirror per tenant" invariant has no DB backstop; `findUnique` would not type-check and a naive `findFirst` swap would silently allow duplicates    | `grep representsTenantId apps/api/prisma/schema/sales.prisma`                                                                                                                                                     | ~10 sec | **killed** — confirmed `@unique` during context-pack research (sales.prisma:135) |

## 10. Non-goals

- No new Prisma migration — T1's schema additions already cover everything T12–T15 need.
- No edit to `admin/billing/page.tsx` — it already reads `MrrService.computeOverview()` directly
  via its own `/billing/admin/mrr` endpoint (confirmed by reading the live controller).
- No edit to `admin/tenants/[id]/page.tsx` — its `estMrrUsd` is a different, unrelated per-tenant
  field from a different endpoint.
- T7/T9/T10/T11 are already built (on the locally-merged, still-open PR #743) — not re-planned.
- No admin endpoint to trigger the mirror sweep manually — the nightly cron plus the
  create/update-time best-effort calls are the only triggers this phase ships.
- No mirror-row deletion/undo when a tenant is deleted — a future phase's decision (see R-NG1).
- No cleanup script for mirror rows.

## 11. Open questions for the requester

None blocking — the task brief and the existing plan document fully specify scope; the two design
gaps found during research (T13's Customer/User schema mismatch, T14's narrower actual scope) are
resolved in [spec.md](./spec.md) §3's rulings using established in-repo precedent, not left open.

## 12. Assumptions (unverified)

| #   | Claim                                                        | Basis                                                                   | What would confirm it                                                 | What breaks if wrong                                                    | Status                                                           |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| A1  | (see §9) placeholder-user design is safe                     | precedent already in production                                         | Baseline grep for Prisma middleware/side-effects on User.create       | Placeholder rows could trigger an unwanted side effect (email, billing) | unverified — checked at Baseline                                 |
| A3  | `firstAdmin.username` is a reasonable `contactName` fallback | read off `tenant-mirror.service.ts`'s own fetch of `TENANT_ADMIN` users | none needed — it's a display-only convenience field, not load-bearing | Worst case: a slightly less friendly contact name; no functional break  | accepted as reasonable, not verified against a real admin roster |

---

## STOP GATE — S1 → S2

- [x] Problem stated in the requester's own words and restated in ours
- [x] User named: role + frequency + cost today
- [x] Current workaround named (none / mental discount), and why it's insufficient
- [x] One observable success signal with today's baseline
- [x] "If we ship nothing" answered honestly
- [x] Root-cause check done — this completes truth-layer wiring, not a symptom patch
- [x] Riskiest assumption named, with a check costing less than the build (A2 already killed)
- [x] Non-goals written down
- [x] No blocking open questions
- [x] Assumptions block filled

**Gate outcome:** PASS — S2 may start.
**Assumptions carried into S2:** A1 (checked at Baseline), A3 (accepted).

## Stage log

| Stop condition                                 | Evaluated? | What it answered                                                         | Evidence   | Verdict |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------ | ---------- | ------- |
| Shipping nothing is materially bad             | yes        | Structural blocker for every later phase; a live UX/trust papercut today | §5         | pass    |
| The ask is a cause, not a symptom              | yes        | Completes truth-layer wiring T9 deliberately deferred                    | §8         | pass    |
| User, workaround and success signal all stated | yes        | Platform admin; mental discount; one identical MRR figure + mirror count | §2, §3, §6 | pass    |
| Every blocking open question answered          | yes        | None were blocking                                                       | §11        | pass    |

**Approved by:** orchestrating session (Sonnet 5, on the owner's explicit task brief) · **on:** 2026-09-14
