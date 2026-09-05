# F25-location (B185) — dev-pipeline RESUME card

Written at launch, before the engine runs. The resume key is `{scriptPath, resumeFromRunId, args}` and
**args are NOT stored by the tool** — that is why `pipeline-args.json` sits beside this file.

## What this run is

Run B of the F25 batch (bug-pipeline, `mode: 'bugfix'`, `scale: 'small'`) — B185: iOS reports `heading`/
`speed` as `-1` when unavailable; the mobile tracker forwards them unmapped; `PostLocationDto`'s `@Min(0)`
rejects the whole GPS ping (a 400), and the tracker's empty `catch` swallows it silently — the live
operator map loses that driver's breadcrumb with no error anywhere. `DriverLocation.accuracy` is
pre-provisioned in the schema for this batch but has no reader/writer/DTO field yet. Full cause trail:
`cause-brief.md` (S1) → `refutation.md` (S2) → `cause-ruling.md` (S3) → `bug-test-plan.md` (S4) →
`build-plan.md` (S5, args duplicated standalone in `pipeline-args.json`).

**Sequencing rule: this run (Run B) starts ONLY AFTER `2026-09-04-F25-calendar-bugfix` (Run A)'s close-out
commit has landed.** Run A's `WP-DOCS` and this run's `WP-DOCS-LOC` both write
`.claude/campaign/status/F25.jsonl` and `.claude/lessons/_meta.json`; `WP-DOCS-LOC`'s brief explicitly
depends on Run A's `L-047` entry already existing (this run does NOT append its own lessons entry — it
bumps `_meta.json.updatedAt` only, on the assumption Run A's entry already covers B185's Guard line). Do not
launch this run concurrently with Run A, and do not launch it before Run A's `WP-DOCS` package has landed on
this branch.

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
working directory) — verify it exists and is current; re-copy if missing or stale. If Run A already staged
it in this same worktree, it should still be present — just re-verify the version, don't assume.

## Lead rulings applied at launch — a builder must not undo these

- **The DTO's `@Min(0)` on `heading`/`speedKph` is UNCHANGED.** The fix is entirely client-side (map the
  sentinel to `null` before sending); the server bound is never relaxed. Do not "simplify" this into
  lowering `@Min` to allow `-1` through — that would accept a genuinely bad value from a client that doesn't
  bother to map it, defeating the point of the validation.
- **Ordering constraint is load-bearing, not decorative:** the API's DTO gaining `accuracy` must merge and
  deploy BEFORE any mobile build sends that field, because `forbidNonWhitelisted: true` (`main.ts:148`)
  turns an unrecognized property into a 400 for the ENTIRE request. State this in the PR body; do not let a
  reviewer read the two packages as independently shippable in either order.
- **The seam-extraction step comes first**, same discipline as Run A: `location-payload.ts` is written with
  TODAY's incomplete/unmapped body (no `accuracy` handling at all, sentinel passthrough), called from both
  existing sites unchanged, before `WP-MOB-LOC` fixes the body.
- **The accuracy/null-island "hardening half" of the original bug card is explicitly NOT a REG claim.** No
  wrong-value repro exists for it (confirmed by both S1 and S2) — do not invent one under pressure to make
  the ledger row look more complete than the evidence supports.
- **`driverLocation`'s absence from the shared Prisma mock is a recorded fact, not a task for this run** —
  see `bug-test-plan.md`'s harness notes. None of T1-T5 exercises `DriversService`, so it does not block
  this run; do not scope-creep into fixing `apps/api/src/testing/prisma-mock.ts` here.

## Setup to verify in this worktree before launch — do not redo blindly

- Worktree HEAD at launch time: `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d` — matches the sha
  `cause-brief.md`/`refutation.md` pinned; re-verify with `git rev-parse HEAD` and re-read both evidence
  files if it has moved. **If Run A has landed by the time this launches, HEAD will have moved past this
  sha — that is expected and fine; re-confirm the B185-specific lines (`location-tracker.native.ts:32-39`/
  `:74-85`, `post-location.dto.ts` full 44-line file, `drivers.service.ts:93-116`) are still unchanged at
  the new HEAD before trusting this ruling's line citations verbatim.**
- Confirm Run A's `WP-DOCS` has actually landed (check `.claude/campaign/status/F25.jsonl` for `B59`/`B90`/
  `B91`/`B118` rows already updated, and `.claude/lessons/LESSONS.md` for `L-047` already present) before
  launching this run's engine.
- This worktree's own `npm ci` / `npx prisma generate` status was NOT re-verified this pass (read-only
  transcription task, no installs run) — confirm both before the engine's first `tsc`/`jest` round.

## On resume

Trust the resumed run's own `phaseReport`. Do NOT reconstruct progress from WIP diffs.

## Oracles to check individually (a skipped phase is neutral; an UNVERIFIED one is not)

- `redGate.behaviorallyRed` — T1-T4 must each fail on their stated wrong value (see `bug-test-plan.md`'s
  "Fails TODAY with" column); T4's dual-assertion construction is the one to read carefully — it is not a
  simple pass/fail flip.
- `mutationProbe.allCaught` / `.restoredVerified` — 2 targets declared, both `revertFix: true`.
- `harnessCheck.issues` — should note the `driverLocation` mock gap as an OUT-OF-SCOPE observation (per
  `bug-test-plan.md`'s harness notes), not block the run over it.
- `siblingSweep.hits` — expect a hit on Android's `bearing`/`speed` mapping in `expo-location`'s Kotlin layer
  (untracked, working-tree only — S2 traced it but it is not a repo file the sweep can grep) — this should
  NOT be treated as a missed sibling; the sweep only covers tracked repo files, and Android's false-zero
  behavior is a separately-unfiled defect anyway (recorded in `cause-ruling.md` §1, not this run's scope).
- `finalPass.ran` / `.completed` — Fable's last read over the HIGH-risk `WP-API-LOC` diff.
- `uiVerify` — **not configured**, correctly (no UI surface change).

## Deviations (seeded; append here as the run makes them)

- **Seam extraction for a two-site duplicate expression** — recorded per the common ruling, same rationale
  as Run A: `location-payload.ts` exists first with today's incomplete body so the red gate is behaviorally
  red before any fix logic lands.
- **T4's DTO test is intentionally more complex than a single assertion** — because `accuracy` does not
  exist pre-fix, "rejected for the right reason" cannot be checked with one assertion across both states;
  `bug-test-plan.md` spells out the two-part check. Do not simplify it back to a single assertion — that
  would either pass vacuously pre-fix or fail to distinguish `whitelistValidation` from `min` post-fix.

## Owed after the run, regardless of verdict

- Persist `result.json` beside this plan; append the ledger row via
  `~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append`.
- Append ONE ≤10-line entry to `~/.claude/skills/dev-pipeline/references/RUN-LOG.md` (shared file with
  Run A — two entries total for the F25 batch, one per run, per the pipeline-law close-out rule).
- `F25.jsonl`: `B185` → `proven` (jest-provable end to end — no deploy-only tier, unlike Run A's B59/B91).
- **No new LESSONS.md entry** — `L-047` (written by Run A) already covers B185's guard clause; this run
  bumps `.claude/lessons/_meta.json.updatedAt` only.
- PR body must state the deploy-ordering constraint (API merges/deploys before any mobile OTA) as a release
  note, not just a code comment — this is an operational hazard, not only a documentation nicety.
- No data repair owed (§6: rejected pings were never stored).
