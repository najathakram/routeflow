# CRM cloud session status

**2026-09-15 ~21:45Z** · session `routeflow-62` · branch `feat/crm-phase1` · run dir
`.claude/pipeline/2026-09-15-crm-core-phase1/`

**Engine: `02d58b81…`, 224,133 B, `node --check` passes, worktree clean.**

| Stage | State |
|---|---|
| S0 · S0.5 · S1 · S2 | done |
| **S3 UX + design system** | **done** |
| S4 test plan | next |
| S5 build plan | after S4 |
| S6 approval | **your "S5 approved" gates every code push** |

## S3 found three places where my own spec described an app we don't have

All three verified against source before I changed anything. This is the value of S3 — S4 would
otherwise have written tests for fiction.

1. **Mobile offline: writes are NOT blocked, they QUEUE.** The shipped interceptor
   (`apps/mobile/lib/api-client.ts:120-166`) queues every non-FormData mutation on a hard
   transport failure; a *timeout* is deliberately excluded (REG-B196, because a timeout may have
   committed server-side). My spec said "writes blocked, no queue". Corrected — and it creates a
   real requirement, **new R34**: a queued CRM write can replay, so `POST /crm/activities` and
   `POST /crm/tasks` must not duplicate. Convert is already idempotent (R19), notes and tasks are
   not. Mechanism (client idempotency key vs. a dedupe tuple) is S5's call; the no-duplicate
   property is the requirement.
2. **`refetchOnWindowFocus` is `false` globally** (`apps/web/app/providers.tsx:67`) and no screen
   overrides it. My spec's "stale → refetch on focus" would have made CRM the one exception in the
   app. Corrected to the repo's actual 30 s `staleTime` + invalidate-on-mutation.
3. **There is no 403 page.** The role guard redirects to `/dashboard`
   (`apps/web/app/(dashboard)/layout.tsx:303-313`). My spec said a typed URL gives a 403 page.
   Corrected. **R23's API-level 403 is unchanged** — that contract still holds and is still tested.

## Component inventory — and what is genuinely MISSING

17 shared web exports, 5 app composites, 17 mobile exports, all cited. Missing as *shared*
components, each currently local markup somewhere: Pagination, Load-more (no `useInfiniteQuery`
anywhere in the repo), Tooltip (native `title=`), Popover/Combobox, Checkbox (raw input), a single
DatePicker, a live-region helper, **any web offline pattern at all**, and **any 403 page**.

I am **not** proposing to build a shared component library for CRM — that would be a visible
change to RouteFlow and is outside this slice. CRM copies the neighbouring screen's local pattern,
exactly as `estimates` and `deliveries` already do. Flagging the list because "there is no shared
pagination component" is a fact the build plan must not trip over.

## The shared design-system cache already existed — I re-derived it and put back what was dropped

`.claude/pipeline/design-system.md` was **not** new: 17.7 KB, derived 2026-08-31 @ `26037bd4`. Per
the routing rule ("cache exists → re-check") S3 re-derived it from current source, which is right —
but it also dropped a `## Order-edit page notes` section belonging to a different run. I restored
that section. Re-deriving stale content is correct; deleting another run's notes out of a shared
repo-level cache is not. Now 13,099 B.

## Questions

**Q5 — cap-403 upgrade prompt is bigger than CRM.** R20 wants the convert 403 to surface as a real
upgrade prompt. No mutation path in the app renders one today — only GETs do (`PlanGateNotice`,
plus the `READ_ONLY` branch in `providers.tsx:44-52`). Doing it "properly" means a `PLAN_GATE`
branch in `MutationCache.onError`, which touches **every mutation in the app**, not just CRM.
I have spec'd it as a **handler scoped to the convert call only**. Say the word if you want the
global branch instead — but that is a cross-cutting change and I will not make it on my own.

**Q6 — CALL `outcome` enum.** Mobile offers Reached / No answer / Left voicemail (via the existing
`chooseAction` helper). Confirm those three or give me the set.

**Q4 still open** (owner's own unassign with other assignees remaining — I encoded re-derive).
**#12** phone normaliser placement · **#13** advisory-lock family name (**still a hard blocker for
R19 by S5** — `withAdvisoryLock` throws on an unregistered family) · **Q1** hq merged · **Q2**
prospect count N · **Q3** second gate.

## What is pushed vs. committed

Pushed here: this file. **Committed locally but not yet pushed**: `spec.md` (with the three
corrections + R34), `ux-spec.md`, the re-derived `design-system.md`, and `discovery.md`'s refreshed
assumption rows. They land together in the S4 push — each MCP push has to re-send whole files, so I
am batching the artifacts rather than sending ~55 KB twice. Say if you want them sooner.

## Compliance

No code written. No bug or lesson id minted. No host-heavy step attempted. No PR. Docs-only pushes.
Test tenants and `acme` placeholders throughout. `spec.md` is now 17,933 B, over a 16 KiB target I
set myself — the overflow is R34, Q5 and Q6, which I would rather keep than trim to hit my own
number.
