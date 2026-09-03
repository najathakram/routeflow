# Discovery — why F25 calendar-date correctness

**Status:** `APPROVED`
**Stage:** S1 — Discovery (why) · **Author:** Fable 5 · **Date:** 2026-09-03
**Lives at:** `.claude/pipeline/2026-09-03-F25-calendar-dates/discovery.md`
**Next:** [spec.md](./spec.md) — do not start it until the STOP GATE at the bottom passes.

> **This file is the only context downstream agents receive about _why_ this work exists.**
> No chat history, no ticket, no link is read for them. If a fact matters, write it here in
> full. `TBD` is a blocker, not a placeholder — chase it or record the assumption you made
> in §12 instead.

_Citations below are in the `G#·Q#` form used by gates G1, G2 and G3 of
`references/ARCHITECT-QUESTIONS.md` in the dev-pipeline skill folder._

---

## 1. The problem, in the requester's own words (G1·Q1)

> "UTC-midnight calendar dates parsed with new Date() and read with local getters. B59 is the
> destructive one — Edit Route Run pre-fills yesterday and PERSISTS it on every save, so a
> driver reassignment silently moves the run's date. The helper is named formatLocalDate
> (EditRunModal.tsx:17, called at :33) — it reads like a safe utility, which is why it
> survived." — `.claude/pipeline/fix-cards/F25-calendar-date-correctness.md`

**Restated in our words:** A family of calendar-date fields (`RouteRun.scheduledDate`,
`CreditNote.expiresAt`, license `expiresAt`, promotion `startsAt`/`endsAt`) are stored as
UTC-midnight instants whose only meaningful content is the calendar day. Several call sites
across web and mobile decode that instant with the viewer's LOCAL clock (`new Date(x)` plus
`getFullYear`/`getMonth`/`getDate`, or `setHours(0,0,0,0)`, or bare `toLocaleDateString()`)
instead of the UTC-anchored path the codebase already established
(`fmtCalendarDate` in `apps/web/lib/formatting.ts:55` and `apps/mobile/lib/format-date.ts:25`).
For any viewer at a negative UTC offset (all of the Americas) this renders, compares, and in
one case **persists**, the wrong calendar day. Separately, the analytics on-time KPI compares
`completedAt` against a UTC day-end instead of the tenant's own configured timezone
(`TenantConfig.timezone`, `apps/api/prisma/schema.prisma:467`, already exists and is read by
zero lines of `analytics.service.ts`), and the mobile GPS tracker forwards iOS's `-1`
unavailable-sentinel for heading/speed straight into a DTO whose `@Min(0)` rejects the whole
ping.

**Source:** RouteFlow bug campaign, batch F25 (`.claude/pipeline/fix-cards/F25-calendar-date-correctness.md`),
covering register bug ids B59 (Critical), B90, B91, B118 (all Medium), B185 (Low).

## 2. Who has this problem (G1·Q1)

| Role                                                            | How often they hit it                                                                                                                                                                                                               | What it costs them today (time / money / errors / risk)                                                                                                                                  | How we know (evidence, not guess)                                                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Operator editing a route run (web)                              | Every time `EditRunModal.tsx` is opened by a US-timezone operator and saved (driver reassignment, notes edit) — the date field is included in the PATCH unconditionally (`EditRunModal.tsx:56`) whenever the run is not IN_PROGRESS | The run's real scheduled date is silently rolled back one day on every save; a driver can be dispatched to the wrong day (A1, unverified — no telemetry on how often this modal is used) | Code read directly: `EditRunModal.tsx:17-23` (`formatLocalDate`), `:33`, `:50-56`                                                       |
| Operator using the mobile Exceptions screen                     | Every IN_PROGRESS run scheduled for "today" that is viewed on a negative-UTC-offset device                                                                                                                                          | On-schedule runs appear in the "Late route" exception list, training operators to ignore real exceptions                                                                                 | `apps/mobile/app/(operator)/exceptions.tsx:42-43,58-65`                                                                                 |
| Operators and buyers viewing license/promotion/finance dates    | Every render of the 8 verified display sites (dashboard, my-runs, dispatch, deliveries, authorizations tab, buyer licenses, finance reports, mobile payments)                                                                       | Dates read one calendar day early; a regulated license shown as expiring a day sooner than it does is a compliance-adjacent display bug                                                  | Per-site citations in [spec.md](./spec.md) §9 and the discovery report                                                                  |
| Tenant owners reading the On-Time % KPI (Operations tab)        | Every query window that includes an evening delivery or an offline-driver replay, for any tenant on a negative-UTC offset (the schema default is `America/New_York`)                                                                | Headline KPI (red under 90%) is systematically deflated; a route that finished every stop on schedule can show below the alert threshold                                                 | `analytics.service.ts:335-343` (`dayEnd` via `setUTCHours(23,59,59,999)`), confirmed zero `timezone` reads in the file                  |
| Drivers on iOS whose device reports course/speed as unavailable | Any GPS sample taken while stationary or indoors, where iOS returns `-1` for heading/speed                                                                                                                                          | The entire location ping 400s and is silently swallowed (`location-tracker.native.ts:17-24`'s empty catch) — the live operator map loses that driver's breadcrumb                        | `apps/api/src/drivers/dto/post-location.dto.ts` (`@Min(0)` on both fields, full 44-line file), `location-tracker.native.ts:35-36,81-82` |

_The frequency figures above ("every time", "every render") are read off the code paths that
reach these lines, not off usage telemetry — RouteFlow has none for modal-open or screen-view
counts. See §12 A1._

## 3. What they do instead today (G1·Q2)

- **Current workaround:** None. An operator who notices a shifted date in `EditRunModal`
  either re-types the correct date (which then shifts again on the NEXT save) or gives up and
  edits the run through a different flow that does not touch `scheduledDate`. For the On-Time
  KPI, tenant owners have no workaround at all — the number is simply read as-is and, per the
  register, already sits under the 90% alert threshold for some tenants because of this bug.
- **Why it fails:** `formatLocalDate`'s output is fed straight back into the date `<input>`
  (`EditRunModal.tsx:33,100`) with no server-side truth shown alongside it, so there is no
  signal to the operator that the field is already wrong before they even touch it.
- **Cost of the workaround:** A driver reassignment that should touch only `driverId` instead
  rewrites `scheduledDate` to the day before on every single save (compounds a second time if
  saved twice) — this is the one bug in the batch with a destructive, persistent write, not
  just a misleading render.

_No workaround exists for the KPI or the GPS-ping cases; both are silent to the end user._

## 4. Why now (G1·Q3)

This is scheduled batch **F25** in the RouteFlow bug-hunt campaign's Wave A completion
sequence (`.claude/pipeline/2026-09-02-wave-a-completion/F25.md`; order F11 → F13 → **F25** →
F08 → F18, chosen because F25 "touches no line of routes.service.ts" and can run independently
of the other in-flight batches). The five bug ids were confirmed present on `origin/master`
at `0cfad7ed` by a discovery pass immediately preceding this file
(`C:\Users\nakram\AppData\Local\Temp\claude\...\scratchpad\f25-discovery.md`). There is no
external deadline; the trigger is the campaign's own scheduling, not a new incident.

**Deadline / external date, if any:** none.

## 5. If we ship nothing (G1·Q4)

B59 keeps silently rewriting `RouteRun.scheduledDate` on every non-IN_PROGRESS save from a
negative-UTC-offset browser — the one Critical-severity id in this batch, because it is a
destructive write, not a misleading render. The On-Time % KPI stays systematically deflated
for tenants on the (default) `America/New_York` timezone, which can trip alert thresholds that
should not fire. The eight display-site misreads keep showing regulated license expiries and
run dates one day early to operators and buyers. GPS breadcrumbs from iOS devices reporting
`-1` sentinels keep silently vanishing from the live operator map. None of this is data loss in
the sense of unrecoverable rows (the underlying `scheduledDate`/`expiresAt` values are UTC
midnight and recoverable via the D4 repair script for the one known bad writer), but B59
specifically continues to corrupt `scheduledDate` on every affected save until fixed.

## 6. Success signal — one, observable (G1·Q5)

| Signal                                                                                                                                                   | Today's baseline                                                                                                                                                                               | Target                                                                                                                                                                                                                        | Where it is measured                                                                                                                                                                 | When we check                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| A calendar-date field renders and round-trips the same calendar day for a viewer in Los Angeles as for one in New York, for every verified site in scope | Today: `EditRunModal` pre-fills and PERSISTS the day before for a US-timezone operator; the 8 display sites render one day early; a mobile-written license row can already carry a shifted day | After: the e2e spec (running with `timezoneId: "America/Los_Angeles"`) shows the correct calendar day at every asserted site, and `EditRunModal`'s PATCH carries the unchanged date when the date field itself was not edited | `apps/web/e2e/34-calendar-dates.spec.ts` (deploy-only, T2); the eight display sites' code (T2 asserts one representative site; the rest are code-reviewed against the shared helper) | Post-deploy, off the `deployment_status` e2e run (per L-041 — read STEP conclusions) |

_Two secondary, also-observable signals ride along and are worth stating even though only one
is the ★ signal: On-Time % for a `America/New_York` tenant counts a 23:30-local completion as
on-time (today it is scored late), proven by T5/T6 (api jest, exact instants). A location POST
with `heading: -1` or `speedKph: -1` is accepted with those fields mapped to `undefined`
instead of 400ing the whole ping, proven by T9/T12._

## 7. Everyone else affected that nobody asked (G1·Q6)

| Party                             | How this touches them                                                                                                                                                                                     | What they need from us                                                                                                             | Consulted?                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Support                           | Fewer "my route date is wrong" / "the map lost my driver" tickets after ship; may field a question about why On-Time % rose after deploy                                                                  | The PR body and HANDOFF note (ruling 3) explaining the KPI shift so support can answer "did something change?" honestly            | n/a — handled by the deploy-day note                                           |
| Ops / operators                   | See corrected dates and a truthful On-Time % the next time they load the Operations tab; no UI or workflow change                                                                                         | Nothing beyond the fix itself — `ui: false` per the scale ruling, output strings are unchanged, only which code path produces them | n/a                                                                            |
| Finance / billing                 | None — no money math is touched (confirmed: none of the five bug ids reach `pricing.ts`, `computeLineSubtotal`, or `roundMoney`)                                                                          | n/a                                                                                                                                | n/a                                                                            |
| Admin / owner                     | Runs the D4 repair script (`scripts/repair-f25-licence-dates.mjs`) after deploy to normalize the one identified mobile-writer's pre-fix rows; decides whether/when to run it live                         | A dry-run report and a runbook section before touching any live tenant row                                                         | Deferred to the owner by ruling 4 — not consulted yet, flagged as an open item |
| Downstream systems / integrations | None identified — no webhook or external API surface reads these fields differently after the fix (the wire format of `scheduledDate`/`expiresAt` is unchanged; only which local code reads them changes) | n/a                                                                                                                                | n/a                                                                            |

## 8. Root-cause check — is this a symptom? (G1·Q7, G1·Q8)

- **Symptom or cause:** symptom, of an established but incompletely-adopted convention. The
  UTC-safe calendar-date helper already exists and is broadly adopted (179 `fmtCalendarDate`
  call sites across 62 files per the discovery report) — these five bug ids are residue: call
  sites that predate the helper, or that reimplemented local-time logic in a new file without
  reusing it.
- **If a symptom, the root cause is:** no compile-time or lint-time signal distinguishes a
  calendar-date field (`scheduledDate`, `expiresAt`, `startsAt`/`endsAt`, `issueDate`,
  `dueDate`) from a real timestamp (`createdAt`, `paidAt`, `completedAt`) at the type level —
  both are `string` (wire) or `Date` (server). A developer reaching for `new Date(x)` has no
  signal that this particular field needs the UTC-anchored path.
- **Would fixing the root cause delete this request entirely?** No. A branded type
  (`CalendarDateString` vs `TimestampString`) that made the wrong helper a type error would
  prevent the NEXT instance of this class, but it would not by itself correct the five bug ids
  already shipped — those still need the sweep this batch performs. A branded-type follow-up
  is out of scope here (see Non-goals) and is not requested by the card.
- **Are we solving the problem, or building the solution the requester already picked?** The
  card's suggested fix ("swap fmtDate/toLocaleDateString for fmtCalendarDate at each cited
  site") is also the only defensible fix given the existing, adopted helper — there is no
  live alternative abstraction to weigh against building a new one, because one already exists
  and already has 179 adopters. The one place this file diverges from "just apply the
  suggested fix" is B118 (day-end must move from UTC to tenant-timezone, which is new
  plumbing, not a call-site swap) and B185 (sentinel mapping plus an additive DTO field, not a
  formatter swap).
- **Prior art (G3·Q3):** `apps/mobile/app/(driver)/route/index.tsx:183` already parses
  `scheduledDate` UTC-safely (`.slice(0, 10).replace(/-/g, "/")` then local-midnight parse) —
  this is the correct-pattern reference the discovery report and the register both point to.
  `apps/api/src/invoices/invoices.service.ts:69-89` (`startOfCalendarDay`) is the existing,
  tested tenant-timezone primitive B118 will extract and reuse rather than reinvent.

## 9. Riskiest assumption and the cheapest way to kill it (G3·Q1, G3·Q6)

| #   | Assumption                                                                                                                                                | If it is wrong, what breaks                                                                                                          | Cheapest thing that would kill it                                                                                          | Cost               | Result                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | The e2e spec number for this batch is **34**, not the "29" the stale F25 plan file's prose still says in three places                                     | Spec ships at the wrong number, collides with F08's allocation (spec 29), or never runs (no matching `playwright.config.ts` project) | Read SEQUENCE.md R6 directly (it states "THIS list wins" over the cards)                                                   | one file read      | **killed** — confirmed 34; the plan file's "spec 29" mentions are its own stale artifact, R6 is authoritative, and the plan's own Files list already says "34-run-calendar-dates.spec.ts (per R6)"                                                                                                                                                               |
| A2  | `TenantConfig.timezone` and `DriverLocation.accuracy` both already exist on `schema.prisma` at master, so this batch needs zero migration                 | If either is missing, R5/R6 require a schema change this batch's scale/rulings explicitly rule out                                   | Read `schema.prisma:467` and `:928-931` directly                                                                           | two file reads     | **killed** — both confirmed present verbatim (see build-plan.md's quoted excerpts)                                                                                                                                                                                                                                                                               |
| A3  | No scripts/ jest project exists today, so T16 (the repair-script's pure classifier) cannot live under `scripts/__tests__/` as a runnable-by-default suite | If a scripts/ jest project DOES exist, T16 is misplaced and the repair script's logic goes untested by any gate                      | `ls scripts/__tests__`, grep `scripts/*.mjs` for any import from `apps/api/src`, check root `package.json`'s `test` script | three quick checks | **killed** — no `scripts/__tests__` directory exists, no `scripts/*.mjs` imports from `apps/api/src` today (grepped, zero hits), root `test` is `turbo run test` which only runs the workspaces' own test scripts. T16 lives in `apps/api/src/common/calendar-date.spec.ts`; the repair script duplicates the pure function with its own pin (build-plan.md TP1) |

## 10. Non-goals — the scope fence (G2·Q5)

- **`nextFireDate` render sites** (`apps/mobile/app/(customer)/standing-orders.tsx:23-34`,
  `apps/web/app/buyer/portal/[seller]/templates/page.tsx:85`) — no writer of `nextFireDate`
  was located under `apps/api/src/order-templates` in discovery, so its storage convention
  (calendar-date vs timestamp) is unestablished. Fixing the reader without knowing the
  writer's convention risks trading one wrong render for another (the same class of mistake
  B91's writer-outlier already demonstrates). Recorded as a follow-up, not chased here (L-008).
- **A repo-wide `toLocaleDateString`/`toISOString().slice|split` sweep** — the card's own "81
  hits / 55 files" scanner claim is unverified (a repo-wide grep timed out in discovery) and
  explicitly not the batch's job; the card states scope is "the class, not the cited lines" but
  the planner bounds that to the verified sites enumerated in spec.md, not an unbounded sweep.
- **Adding a scanner signature** for the `toISOString().slice|split` write-side pattern to G1 —
  named in the card as a nice-to-have; deferred, no owner or vehicle assigned in this batch.
- **Any change to `fmtCalendarDate`'s rendered output format** — this batch changes which code
  PATH reaches a render, never what a render PRODUCES. `ui: false` for this reason.
- **A timezone-selection UI** — `TenantConfig.timezone` is read, never written, by this batch;
  no admin screen for setting it is added or changed.
- **`routes.service.ts`** — deliberately untouched (Wave A lead ruling: F25 "touches no line of
  routes.service.ts"; the `latestLocation` reader that would surface `DriverLocation.accuracy`
  to the live map, and any write-normalisation belt, are follow-ups for a different batch).
- **Client-supplied `completedAt`** for offline-replay completions — the register's B118
  suggested fix bundles this with the day-end fix; the lead plan splits it into its own row,
  not part of F25.
- **A branded `CalendarDateString` type** or any other root-cause-level type system change (see
  §8) — would prevent future instances of this class but is not requested and is out of scope.
- **The three duplicate local formatters' consolidation** (`web/lib/format.ts`,
  `web/lib/formatting.ts`, `mobile/utils/format.ts`) — the card asks to "collapse" them; this
  batch adds the new UTC-safe surfaces it needs (`apps/web/lib/calendar-date.ts`,
  `apps/mobile/lib/calendar-date.ts`) without deleting or merging the existing formatters,
  which are also used for non-calendar-date fields. Full consolidation is out of scope.

## 11. Open questions for the requester

| #   | Question                                                                                                               | What decision it unblocks                                                                        | Blocking S2? | Answer / assumption made                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Is the e2e spec number 34 or 29?                                                                                       | Which `playwright.config.ts` project entry and spec filename to write                            | yes          | Answered — **34** (SEQUENCE.md R6; ruling 1)                                                                                                                                                                                                               |
| Q2  | How should pre-fix mobile-operator-written licence rows (non-midnight UTC `expiresAt`) be normalized?                  | Whether/how to ship a repair script                                                              | yes          | Answered — ship `scripts/repair-f25-licence-dates.mjs`, owner-run, dry-run by default (ruling 4)                                                                                                                                                           |
| Q3  | Is it acceptable that On-Time % rises for tenants west of UTC once B118 ships, with no backfill of historical figures? | Whether the PR needs a release note / whether historical data is corrected                       | yes          | Answered — accepted; no backfill; PR body and HANDOFF state it (ruling 3)                                                                                                                                                                                  |
| Q4  | Does the e2e tenant carry a regulated tracked category the B91 oracle could use for the Authorizations-tab site?       | Whether T2's e2e spec can assert against that specific site or must use a different one of the 8 | no           | Not confirmed in discovery (open question 6 in the discovery report). Assumption: the spec asserts against the licence-expiry site created via API fixture (buyer/operator licenses), which needs no pre-existing regulated category — see test-plan.md T2 |

## 12. Assumptions (unverified) — MANDATORY

Everything above reads as settled fact downstream: agents get this file and no chat history, no
ticket, no call. This block is where you mark the lines nobody actually checked. **Fill it before
this file leaves `DRAFT`.** An empty table is itself a claim — that every statement in §1–§11 came
from a named source. Make that true, or write rows.

| #   | Claim, as this file states it (and its §)                                                         | Basis                                                                                                                                                                                                | What would confirm it                                                                                                                                      | What breaks if it is wrong                                                                                                                                    | Status                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | "§2: 'every time'/'every render' frequency figures for each affected role"                        | inferred from which code paths reach the buggy lines, not from usage telemetry (RouteFlow has none for modal-opens or screen-views)                                                                  | product analytics on modal-open / screen-view counts, if any exist                                                                                         | §2's cost framing is directional, not measured — does not change scope or the fix itself                                                                      | unverified                                                                                                                                   |
| A2  | "§1: e2e spec number is 34"                                                                       | SEQUENCE.md R6, read directly                                                                                                                                                                        | already confirmed — see §9 A1                                                                                                                              | spec ships at the wrong number / collides with F08                                                                                                            | confirmed 2026-09-03 (§9 A1)                                                                                                                 |
| A3  | "§1: `TenantConfig.timezone` and `DriverLocation.accuracy` already exist, no migration needed"    | read `schema.prisma:467` and `:928-931` directly                                                                                                                                                     | already confirmed                                                                                                                                          | R5/R6 would need a migration this batch's scale forbids                                                                                                       | confirmed 2026-09-03 (§9 A2)                                                                                                                 |
| A4  | "§9 A3: no scripts/ jest project exists, T16 goes in `apps/api/src/common/calendar-date.spec.ts`" | `ls scripts/__tests__` (does not exist), grep for `apps/api/src` imports under `scripts/` (zero hits), root `package.json` `test` = `turbo run test`                                                 | already confirmed                                                                                                                                          | T16 misplaced; repair script's pure logic untested by any gate                                                                                                | confirmed 2026-09-03 (§9 A3)                                                                                                                 |
| A5  | "§7: no downstream integration reads `scheduledDate`/`expiresAt` differently after this fix"      | inferred — no webhook/external-API code was found referencing these fields during discovery's file reads, but discovery was scoped to the cited files, not a repo-wide search for external consumers | grep the whole repo for `scheduledDate`/`expiresAt` outside `apps/{api,web,mobile}`                                                                        | an unnoticed external consumer could read a field's format differently — unlikely since the WIRE VALUE never changes, only which local code renders/writes it | unverified, low risk (wire format is provably unchanged — see spec.md R1–R6)                                                                 |
| A6  | "§11 Q4: the e2e spec's oracle site does not need a pre-existing regulated tracked category"      | assumption, not confirmed — discovery's open question 6 was left unanswered ("I did not read [09-regulated-compliance.spec.ts] far enough to confirm the fixture survives for spec 34 to reuse")     | read `apps/web/e2e/09-regulated-compliance.spec.ts` for its fixture, or simply choose a licence oracle site that self-provisions (as test-plan.md T2 does) | if wrong, T2 needs a different oracle site or an extra fixture step                                                                                           | assumption made — T2 self-provisions a licence via API rather than depending on a pre-existing regulated category, sidestepping the question |

Rules:

- IDs share one namespace with §9: an assumption carried down from there keeps its number, new
  ones continue from the highest used. §9 names the one worth killing _before_ the spec; this
  table is the full ledger of what is still unchecked when the file ships.
- **Every number above that was not read off a system belongs here** — the frequencies and costs
  in §2, the baseline in §6.
- Repeat here every `TBD`, every "assumed X" from §11, and every §9 row still `pending`.
- List what you assumed about things **outside this repo** too: what a third party returns, what
  production data looks like, what a role is permitted to do, what a person will actually do.
- Never state an assumption as fact in the prose above. Hedge it there, or cite the row — "(A3)".
- Name a real path, command, script, config key or exported symbol in the confirm column whenever
  one exists.

---

## STOP GATE — S1 → S2

- [x] Problem stated in the requester's own words **and** restated in ours
- [x] User named: role + frequency + cost today
- [x] Current workaround named, and why it fails
- [x] One observable success signal **with today's baseline**
- [x] "If we ship nothing" answered honestly
- [x] Root-cause check done — we are not building a solution to a symptom by reflex
- [x] Riskiest assumption named, with a check that costs less than the build
- [x] Non-goals written down
- [x] Every blocking open question answered, or the assumption recorded
- [x] Assumptions block filled — every unchecked claim, what would confirm it, what it breaks (§12)

**If problem, user, workaround, or success signal is blank or `TBD`, do not write the spec.**
Go back to the requester. A spec built on a blank _why_ produces code nobody uses, and every
downstream stage inherits the error.

## Stage log — did the gate fire?

Record the answer, not the intention. Nothing in the pipeline engine evaluates the checklist above:
its Baseline phase only grounds this file's mechanical claims against the repo, and no later phase
reads a STOP condition at all. A blank block means the gate did not happen.

| Stop condition                                 | Evaluated? | What it answered                                                                                                                                             | Evidence   | Verdict |
| ---------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------- |
| Shipping nothing is materially bad             | yes        | B59 keeps corrupting `scheduledDate` on every affected save; KPI stays deflated; GPS breadcrumbs keep silently dropping                                      | §5         | pass    |
| The ask is a cause, not a symptom              | yes        | Symptom of incomplete adoption of an already-built, already-broadly-used helper; root cause (no type-level distinction) is named but explicitly out of scope | §8         | pass    |
| User, workaround and success signal all stated | yes        | §2 names five affected roles; §3 names the workaround (none, or a self-defeating re-edit); §6 names one e2e-observable signal                                | §2, §3, §6 | pass    |
| Every blocking open question answered          | yes        | Q1–Q3 answered by named rulings; Q4 answered by an explicit, recorded assumption (A6)                                                                        | §11        | pass    |

- **Gate outcome:** PASS — S2 may start
- **Overridden by:** n/a — no override used
- **Assumptions carried into S2:** A1, A5, A6 (A2–A4 confirmed above)

`Evaluated? no` is a legitimate answer and more useful than a tick nobody earned. Report this block
at close-out beside the run's `phaseReport`: a gate that has answered PASS on every run it has ever
seen is filtering nothing — after ten real runs with no **STOP**, tighten it or drop it.

**Approved by:** planner (F25 campaign batch owner) · **on:** 2026-09-03
