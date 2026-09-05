# F25-location (B185) — dev-pipeline RESUME card

Written at launch, before the engine runs. The resume key is `{scriptPath, resumeFromRunId, args}` and
**args are NOT stored by the tool** — that is why `pipeline-args.json` sits beside this file.

## Status (re-anchored 2026-09-05)

- **Branch:** `fix/F25-location-b185`, checked out from `origin/master`.
- **Base sha:** `8f136b9a9e7760a816127490ac83682f75c4a2ff` (#618, "discharge f13 and f25 — 6 rows done;
  recount banner"), which carries `1f6483ec` (#617, the F25 calendar-correctness fix) as an ancestor.
- **Ready to launch after the calendar batch shipped as #617.** Run A's close-out landed on master:
  `.claude/campaign/status/F25.jsonl` already carries B59/B90/B91/B118 (B90/B118 `done`; B59/B91
  `proven-pending-deploy` — pending rows are an E2E-serialization artifact unrelated to B185, not a
  blocker for this run), and `.claude/lessons/LESSONS.md` already has `L-047`. The sequencing rule
  below and WP-DOCS-LOC's precondition are both satisfied.
- Baseline re-verified clean on this base: `prisma generate`, `apps/api` tsc (`tsconfig.build.json`),
  `apps/mobile` tsc, `apps/mobile` full jest (109 suites / 1383 tests), `apps/api` `src/drivers` jest
  (16/16) — all exit 0.
- `pipeline-args.json` / `build-plan.md`'s embedded args block had an invalid `dependsOn: ['TP-LOC']`
  on both `WP-MOB-LOC` and `WP-API-LOC` (a work package naming a test package — dropped silently by
  the engine's separate TP/WP namespaces, per `RUN-LOG.md`'s prior WP-WEB→TP-WEB/WP-MOB→TP-MOB note).
  Removed on both; test-first ordering is still guaranteed by phase order alone. All three ruling/
  build-plan line anchors (`location-tracker.native.ts:32-39`/`:78-85`, `post-location.dto.ts:20`/`:27`,
  `drivers.service.ts:105-116`) were checked against the current tree and are unchanged — no drift.

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

- **Superseded 2026-09-05:** original HEAD at launch-planning time was `f60bd27c893bc0b1058d6dcdfff8180cdd92b42d`
  (pre-#617). The worktree has since been re-anchored to a fresh branch, `fix/F25-location-b185`, cut from
  `origin/master` at `8f136b9a9e7760a816127490ac83682f75c4a2ff` (post-#617/#618). Re-verified at that sha:
  `location-tracker.native.ts:32-39`/`:78-85` (payload construction, unchanged from the citations above —
  note the corrected `:78-85` vs. this card's earlier `:74-85` typo), `post-location.dto.ts:20`/`:27`
  (`@Min(0)`), `drivers.service.ts:105-116` (`recordLocation`'s `create()` call) — all still line-for-line
  as `cause-ruling.md`/`build-plan.md` describe. Re-verify again with `git rev-parse HEAD` if it moves further.
- Run A's `WP-DOCS` is confirmed landed: `.claude/campaign/status/F25.jsonl` carries `B59`/`B90`/`B91`/`B118`
  (rows discussed in the Status section above), and `.claude/lessons/LESSONS.md` has `L-047`.
- This worktree's `npx prisma generate` was re-run clean on the new base (2026-09-05). `apps/api` and
  `apps/mobile` tsc, `apps/mobile` full jest, and `apps/api src/drivers` jest were also re-run clean —
  see the Status section. `npm ci` itself was not re-run this pass; run it first if `node_modules` looks
  stale before trusting these results blindly.

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
