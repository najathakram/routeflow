# F25-calendar (B59, B90, B91, B118) — dev-pipeline RESUME card

> **STATUS: DONE (2026-09-04).** Engine run `wf_3168b7a2-8f1` finished green (api 3737/3737, mobile
> 1426/1426, three typechecks clean); the final pass's remaining findings were applied in the
> close-out pass and every gate re-run. `result.json` sits beside this card.

Written at launch, before the engine runs. The resume key is `{scriptPath, resumeFromRunId, args}` and
**args are NOT stored by the tool** — that is why `pipeline-args.json` sits beside this file.

## What this run is

Run A of the F25 batch (bug-pipeline, `mode: 'bugfix'`, `scale: 'major'`) — the four calendar/timezone
defects: B59 (Edit Route Run rolls `scheduledDate` back a day), B90 (mobile Exceptions flags on-schedule
runs as late), B91 (nine display sites render a calendar date one day early + one writer stores a local
end-of-day instant), B118 (On-Time % cutoff is a fixed UTC day-end instead of tenant-timezone-aware). Full
cause trail: `cause-brief.md` (S1) → `refutation.md` (S2) → `cause-ruling.md` (S3) → `bug-test-plan.md` (S4)
→ `build-plan.md` (S5, this run's args are also duplicated standalone in `pipeline-args.json`).

**Sequencing rule: this run (Run A) goes FIRST.** `2026-09-04-F25-location-bugfix` (Run B, B185) only
starts after Run A's close-out commit lands — Run B's `WP-DOCS-LOC` bumps the SAME `.claude/lessons/
_meta.json`/`L-047` guard line and the SAME `.claude/campaign/status/F25.jsonl` file Run A's `WP-DOCS`
touches; running them concurrently would race both files. Do not launch Run B until this run's PR has
merged (or at minimum its WP-DOCS package has landed on this branch).

## Resume key

|              |                                                                            |
| ------------ | -------------------------------------------------------------------------- |
| `runId`      | _(not yet launched — fill in when the Workflow tool returns one)_          |
| `scriptPath` | `C:/ClaudeCode/routeflow/local-assets/tooling/pipeline.js`                 |
| `args`       | `pipeline-args.json` in this directory — pass its parsed contents verbatim |
| transcript   | _(fill in from the Workflow tool's return value at launch)_                |

```
Workflow({ scriptPath: "C:/ClaudeCode/routeflow/local-assets/tooling/pipeline.js",
           args: <contents of pipeline-args.json> })
```

`local-assets/` is gitignored; `pipeline.js` there must be a copy of `~/.claude/skills/dev-pipeline/
pipeline.js` staged into this worktree before launch (the Workflow tool only accepts paths inside the
working directory) — verify it exists and is current; re-copy if missing or stale.

## Lead rulings applied at launch — a builder must not undo these

- **`resolveCurrentTenantTimezone` (WP-API-CAL) must NOT call `resolveTenantTimezone`.** It passes
  `cfg?.timezone ?? null` straight to `endOfCalendarDay`, relying on that function's own `timeZone || "UTC"`
  fallback. Routing through `resolveTenantTimezone`'s `America/New_York` default would silently change the
  On-Time % arithmetic for every tenant without a `TenantConfig` row and break the six existing
  `analytics.service.spec.ts` `onTimeRate` fixtures (T11 pin). See `cause-ruling.md` §2 and `build-plan.md`'s
  "Exact code" section for the exact reasoning.
- **The seam-extraction step is mandatory and comes FIRST**, before any fix logic: `edit-run-modal.logic.ts`,
  `run-lateness.ts`, and `licenses.logic.ts` are each written with TODAY's buggy body (copied verbatim from
  the component), with the component updated only to call the new export — a behaviour-preserving move. Only
  the subsequent WP package replaces the body with the fix. Do not skip straight to writing the fixed body —
  the red gate must fail on the bug's own wrong value, not on a missing import.
- **No DTO is added to `PATCH /route-runs/:id`.** The B59 fix stays entirely client-side (dirty-check +
  `calendarDateFromIso`/`isoFromCalendarDate`); `routes.controller.ts`'s inline body type and
  `routes.service.ts:1343` are read-only references, never edited — a validated DTO there would be a
  behaviour change for the DRIVER role, which shares this endpoint.
- **The nine B91 display sites are NOT jest-probed.** Their proof is `WP-E2E`'s spec 34, deploy-only (T2
  tier) — `mutationProbe.targets` deliberately has no entry for any of the seven web / two mobile display
  sites. This is by design (stated in `cause-ruling.md` §7), not an oversight to "fix" mid-run.
- **`apps/web/playwright.config.ts` has drifted from the 2026-09-03 plan's citation.** The new
  `calendar-dates` project goes after the LAST existing project entry (this sha's file runs to line 456);
  do not place it near the stale `:393-418` the older plan cited.

## Setup to verify in this worktree before launch — do not redo blindly

- Worktree HEAD at launch time: `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d` (`fix(api): customer-keyed
advisory lock for order merges (imp-02) + wave D (#609)`) — matches the sha `cause-brief.md`/`refutation.md`
  pinned; re-verify with `git rev-parse HEAD` before launch and re-read both evidence files if it has moved.
- `apps/web` already has its own Jest runner confirmed this pass (F1): `apps/web/package.json` has
  `"test": "jest"` and `apps/web/jest.config.js` exists — **WEB-JEST branch**, not MIRROR. Do not add a
  mobile-only mirror-identity pin for the web helpers; each app proves its own pure helpers.
- `createMockPrisma()` (`apps/api/src/testing/prisma-mock.ts`) already stubs `tenantConfig` with a default
  `findUnique` resolving `null` — no mock change is needed for WP-API-CAL's new tenant-timezone read to keep
  the existing `analytics.service.spec.ts` fixtures green.
- `apps/mobile/lib/format-date.ts:25` and `apps/web/lib/formatting.ts:55` already export `fmtCalendarDate` —
  confirmed this pass (F3). Both new `calendar-date.ts` modules RE-EXPORT it; neither reimplements it.
- This worktree's own `npm ci` / `npx prisma generate` status was NOT re-verified this pass (read-only
  transcription task, no installs run) — confirm both before the engine's first `tsc`/`jest` round, per the
  project's standing "stale Prisma client after a fresh worktree" lesson.

## On resume

Trust the resumed run's own `phaseReport`. Do NOT reconstruct progress from WIP diffs — Baseline treats
whatever is present as the baseline, and a half-finished phase looks exactly like a finished one.

## Oracles to check individually (a skipped phase is neutral; an UNVERIFIED one is not)

- `redGate.behaviorallyRed` — every REG test must fail on its stated wrong value (see `bug-test-plan.md`'s
  "Fails TODAY with" column), not merely fail/error. T10 is the one exception noted in `build-plan.md`'s
  TP-API brief (a pre-extraction compile error stands in for its red state).
- `mutationProbe.allCaught` / `.restoredVerified` — 5 targets declared, all `revertFix: true`. Two targets
  (`apps/web/lib/calendar-date.ts`) and (`apps/mobile/lib/calendar-date.ts`) each carry two REG tokens —
  confirm the probe report shows both tokens catching the reverted file, not just one.
- `harnessCheck.issues` — should report the `tenantConfig` mock note as already-satisfied (see Setup above),
  not as an open issue.
- `siblingSweep.hits` — expect hits on the sibling observations already recorded in `refutation.md`'s own
  "Sibling observations" section (e.g. `routes.service.ts:1064-1067`'s local-getter day filter,
  `promotions/page.tsx`'s real-timestamp renders) — these should resolve to `not-a-defect` per the
  `siblingExclusions` list, not silently join the fix.
- `finalPass.ran` / `.completed` — Fable's last read over the HIGH-risk `WP-API-CAL` diff (money-adjacent
  metric).
- `baseline.badCommands` — anything here was excluded from pass/fail; check none of the six
  `verifyCommands.perRound` entries land there.
- `uiVerify` — **not configured** (all rows are jest; the B59/B91 UI round-trip is spec 34, deploy-only, not
  a live browser check inside this run).

## Deviations (seeded; append here as the run makes them)

### Appended by the run and its close-out

- **The launch args dropped `dependsOn` on WP-WEB and WP-MOB.**
  Both named a TEST package (`TP-WEB` / `TP-MOB`), which the engine does not accept as a
  work-package dependency; the run launched without them (test packages run first by engine order
  anyway, so the intent held). `pipeline-args.json` on disk has been corrected to what actually
  launched — `build-plan.md`'s mirrored block still shows the planned form.
- **`node scripts/campaign-check.mjs` was excluded at Baseline as a bad command.**
  The cause was `.campaign/runs/web-e2e.json` in this worktree: a stale PARTIAL Playwright
  artifact from an earlier local run (the documented clobber trap — a subagent running Playwright
  locally overwrites it). The gate reported 8 undischarged claims that the deployed report does
  discharge. At close-out the file was MOVED to the session scratchpad (never deleted), the api
  reporter regenerated `.campaign/runs/api.json` from a full `npx jest --silent`, and
  campaign-check re-run clean.
- **Dismissed with evidence: "a second bug-pipeline run (B185) is live in this worktree".**
  No such run ever started. `.claude/pipeline/2026-09-04-F25-location-bugfix/` holds planning
  artifacts only — S1-S5 documents, no `result.json`, no RESUME status beyond planned, no agent
  activity — and this card's own sequencing rule says Run B does not launch until Run A's
  close-out commit lands. The directory is left exactly where it is; it ships with this commit as
  planning material.
- **`apps/api/src/analytics/demand-range.ts` was edited as an undeclared sibling.**
  A docblock retense naming `getRevenueTrend` as the cautionary tale. KEPT — it is factually
  correct against the shipped diff — and the file is now listed in `radiusFiles`, described in the
  code map, and backed by the new `dateRange` pin in `analytics.service.calendar.spec.ts`.
- **Two `analytics.service.ts` siblings were swept beyond the declared package files.**
  `getRevenueTrend`'s month key (the run's own fix) and `dateRange`'s default `fromDate` (`new
Date(year, 0, 1)` → `Date.UTC(getUTCFullYear(), 0, 1)`, the January-1 drop). Behaviourally inert
  in production (the API image is UTC); both are the same host-local-components defect class, and
  the second made `demand-range.ts`'s new "both branches are UTC now" claim true. It also flipped
  an EXISTING pin — `analytics.service.spec.ts:1046` asserted `new Date(new Date().getFullYear(),
0, 1)`, i.e. the defect itself — so that assertion was re-pinned to the UTC anchor with the
  reason in a comment.
- **`resolveTenantTimezone` was deleted from `common/calendar-date.ts`.**
  It had no caller, and its doc comment instructed a future reader to adopt the `America/New_York`
  fallback the build plan lists as risk #1. Every caller passes `cfg?.timezone ?? null` and leans
  on the helpers' own UTC fallback, so nothing regressed.
- **The revenue-trend regression test uses a Date stub, not a `process.env.TZ` pin.**
  The planner's fixture assumed the fixed month key was derived in the TENANT zone; it is derived
  in UTC (`toISOString().slice(0, 7)`), which is correct for a UTC-midnight calendar-date field.
  Under `TZ=UTC` — CI and the API image — the pre-fix and post-fix bodies are then behaviourally
  identical, so no real-Date fixture can separate them, and an in-file `process.env.TZ` pin is
  inert under jest (measured: jest hands the sandbox a copy of `process.env`, so the assignment
  never reaches Node's timezone cache). A Date whose LOCAL getters report December while its
  ISO/UTC view reports January discriminates on every host, UTC included; a revert probe under
  `TZ=UTC` confirms it goes red on the pre-fix body.

- **Seam extraction is a planned deviation from "just fix the file directly"** — recorded per the common
  ruling: three named seam modules are written FIRST with today's buggy body, purely to give the red gate a
  reachable, behaviorally-red target. This is not scope creep; it is the harness-preparation step the bug
  pipeline requires whenever the wrong value lives inside a component with no pure export.
- **The analytics tenant-timezone resolver deliberately does NOT reuse `resolveTenantTimezone`** (see "Lead
  rulings" above) — a considered divergence from the shared helper's own most-obvious use, recorded so a
  later reviewer does not "simplify" it back to the shared default and silently reintroduce the fixture
  breakage this run's fallback correction avoids.

## Owed after the run, regardless of verdict

- Persist `result.json` beside this plan; append the ledger row via
  `~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append` (with `--subagent-tokens` from the
  Workflow usage line when available).
- Append ONE ≤10-line entry to `~/.claude/skills/dev-pipeline/references/RUN-LOG.md` per the pipeline-law
  learning loop (what caught real defects, what was wasted, one candidate knob change with evidence, any
  deviation the run forced — the two Deviations above are exactly that material).
- `F25.jsonl`: B90/B118 → `proven`; B59/B91 → `proven-pending-deploy` (their T2 oracle is spec 34, which
  only runs post-deploy).
- `L-047` is written ONCE by this run's `WP-DOCS` and covers the WHOLE F25 batch including B185 — note in
  the PR body that the Guard line's "REG-B185 DTO spec" clause discharges only once Run B also lands.
  `.claude/lessons/_meta.json`: `nextId` stays `58` (pre-allocated id, do not consume the counter),
  `activeCount` `35` → `36`.
- The §6 data-repair report/script pair (`scripts/report-f25-licence-dates.mjs`,
  `scripts/repair-f25-licence-dates.mjs`) ship in this PR but **NEITHER runs as part of this pipeline** — the
  owner reads the report and decides on the repair, post-merge.
- No e2e run inside this pipeline (WP-E2E only writes the spec + config entry); the deploy-only discharge of
  B59/B91's T2 tier happens on the next post-deploy check, not here.
