# watchdog-spec-host-speed — bug-pipeline RESUME card

## Status: DONE (closed out 2026-09-04)

`wf_c8b07b1f-a0a` ran to completion: 28 agents, 2,592,687 subagent tokens, 284 tool uses, ~81 min
wall-clock, estimatedCostUsd 7.37. Red gate `properlyRed`/`structurallyRed`/`behaviorallyRed` all
true in 1 attempt. Fix rounds: round 1 = 5 actions, round 2 = 1 mechanical action. Sibling sweep:
2 patterns, 2 hits, verdicts guarded 1 / unrelated 1 / defect 0. `harnessCheck.issues` = 0. Final
gate all pass: spec 8/8, `apps/api` tsc clean, `npx jest src/common --runInBand` 463/463 (31
suites), `validate-lessons.mjs` 36/40 entries · 36.3/40.0 KB · nextId 62 — no byte-cap fallback
needed. Result persisted at `result.json` beside this card (reconstructed from the workflow
journal — the engine's own return value was truncated by the harness; see its `provenance`
field). Ledger row appended to `.claude/pipeline/cost-ledger.jsonl`; RUN-LOG entry appended.

Written at plan time, BEFORE launch (per bug-pipeline S6 / dev-pipeline S7 launch rules: RESUME card
written before the Workflow call). The resume key is `{scriptPath, resumeFromRunId, args}` and
**args are NOT stored by the tool** — that is why `pipeline-args.json` sits beside this file.

## Resume key

|              |                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runId`      | **not yet launched** — this run has not been started; fill in once `Workflow(...)` is actually called                                                                                                                                                                  |
| `scriptPath` | `C:\ClaudeCode\routeflow\.claude\worktrees\rf-watchdog\local-assets\tooling\pipeline.js` (staged copy — not yet created; copy from `~/.claude/skills/dev-pipeline/pipeline.js` before launch, since the Workflow tool only accepts paths inside the working directory) |
| `args`       | `pipeline-args.json` in this directory — pass its parsed contents verbatim                                                                                                                                                                                             |
| transcript   | not yet created                                                                                                                                                                                                                                                        |

```
Workflow({ scriptPath: "C:\\ClaudeCode\\routeflow\\.claude\\worktrees\\rf-watchdog\\local-assets\\tooling\\pipeline.js",
           args: <contents of pipeline-args.json> })
```

`local-assets/` is gitignored; `pipeline.js` there must be a fresh copy of
`~/.claude/skills/dev-pipeline/pipeline.js`. Copy it before launch if missing — do not assume it is
already staged in this worktree.

## Context — why this is on the critical path

The "defaults" test in `apps/api/src/common/visibility-watchdog-script.spec.ts` gates readiness with
a fixed 500 ms `setTimeout` instead of an observable signal. It fails
(`expected substring "minutes=45 repo=najathakram/routeflow", received ""`) on any loaded/slow host
even though `scripts/visibility-watchdog.mjs` behaves correctly — CI's faster runner happens to clear
the 500 ms bar, local/loaded hosts do not. This blocks the local pre-push gate
(`npm run verify` runs the `apps/api` Jest lane) and, transitively, blocks pushing PR #597 (the
in-repo bug registry), which needs a clean local verify pass first.

## Lead rulings applied at plan time — a builder must not undo these

- **The fix stays entirely inside the spec file.** `scripts/visibility-watchdog.mjs` does not change
  (see `cause-ruling.md` §2). Do not "fix" the race by adding any in-script delay, flag, or readiness
  hook — none is needed; the script already writes its `" start "` log line synchronously before any
  async work (cause-brief.md §c, refutation.md Trace).
- **No lane-wide `testTimeout`.** Only the two async tests (T1, T2) get an explicit third-argument
  `35_000`. The four `spawnSync`-based sibling tests stay synchronous and must keep failing loudly if
  they ever hang elsewhere (refutation.md: a synchronous body cannot trip Jest's timer regardless of
  wall clock — confirmed by the `public-forever` sibling burning 7.6 s and still reporting green).
- **`b9c8e840` (branch `fix/e2e-freshness-guard-fail-open`) is SUPERSEDED, not adopted.** That commit
  polls with a 10 s budget but declares no per-test timeout, so under this lane's undeclared 5 s Jest
  default its budget is unreachable and nominal, not functional (cause-ruling.md §1). It is **not**
  an ancestor of the pinned sha and will **collide at merge** with this fix — whoever merges next
  resolves in favor of this ruling's poll+cap+kill+explicit-timeout design.
- **No B-id filing here.** The in-repo bug registry does not exist on master yet (lands with #597).
  `REG-WATCHDOG-SLOWBOOT` stands in as the reproduction token; the PR body asks the owner to file a
  B-id once the registry lands.

## Setup needed in this worktree — verify, do not redo blindly

- **As of writing this card, another agent is running `npm ci` in this worktree
  (`.claude/worktrees/rf-watchdog`).** Do not start a second install, do not touch `node_modules`
  here, and do not launch the pipeline until that install has finished and been confirmed by whoever
  owns that session.
- After `npm ci` completes: this fix touches no Prisma schema, but the worktree's own
  `node_modules`/generated clients should still be sane before trusting `verifyCommands` — if
  `apps/api` typecheck fails at Baseline for unrelated reasons, suspect a stale generated client
  before blaming this plan (`npx prisma generate` if so).
- Confirm husky hooks are present (`.husky/_`) so commit-msg/pre-push actually run in this worktree.
- Stage `local-assets/tooling/pipeline.js` (see Resume key above) before calling `Workflow(...)`.

## On resume

Trust the resumed run's own `phaseReport`. Do NOT reconstruct progress from WIP diffs — Baseline
treats whatever is present as the baseline, and a half-finished phase looks exactly like a finished
one.

## Oracles to check individually (a skipped phase is neutral; an UNVERIFIED one is not)

- `redGate.behaviorallyRed` — T1 must fail on the exact wrong value
  (`received ""`), not on an import/setup error; the bugfix-mode red bar is behavioral, not
  structural.
- No `mutationProbe` ran (scale is small — see cause-ruling.md §7). In its place, the **manual check
  below** is the only mutation evidence for this run.
- `harnessCheck.issues` — should be empty; `fakeEnv`/`readLog`/`newLogPath` keep their current
  signatures, so no existing mock/fixture in this spec should break.
- `siblingSweep.hits` — expect the two documented existing hits (`db-locks.db.spec.ts:22`, excluded
  as a reusable sleep helper, and the defect's own line) and no new ones; a third hit anywhere else in
  `apps/api/src/**/*.spec.ts` or `scripts/**/*.spec.*` is new information, not noise.
- `finalPass` — not expected to run (no HIGH-risk diff; test/docs-only change), but confirm rather
  than assume.

## Manual mutation check (owner-visible, in place of an automated probe)

Scale is small, so the engine runs no `mutationProbe` phase. Before closing this run out, hand-verify
the fix actually bites: temporarily revert `awaitStartLine`'s body to a single read after a fixed
500 ms delay (i.e., the pre-fix shape — spawn, wait 500 ms, read the log once, kill the child), rerun
the red-gate command below, and confirm T1 (`REG-WATCHDOG-SLOWBOOT`) goes red again. Then restore the
real fix. This is the only fix-bites evidence this run has; do not skip it.

```bash
cd apps/api && npx jest src/common/visibility-watchdog-script.spec.ts -t "boots slowly" --runInBand
```

## BEFORE facts (from `refutation.md`, measured on the reporting Windows host)

- **Measurement A** (spawn → `"minutes=45 repo=…"` visible, 5 runs): 1255, 777, 1005, 1586, 1414 ms.
- **Measurement B** (the OLD test's exact shape — read the log 500 ms after spawn): 5/5 runs read an
  absent log (`exists=false log=""`), elapsed 543–579 ms — reproduces the reported failure with zero
  injection.
- **Measurement C** (bare `node -e 0` startup, 5 runs): 1083, 1142, 622, 890, 799 ms — below the 500 ms
  budget on every run.
- **Measurement D** (sibling wall-clock via `spawnSync`): success 3741 ms, public-forever 7646 ms,
  edit-fail 3193 ms — all synchronous, none can trip Jest's 5 s timer regardless of wall clock.
- Slow-boot injection verified working against the ESM entry: with the 1.5 s preload set, the start
  line appeared at 2844 ms versus the 777–1586 ms baseline (measurement A) — a ~1.5 s delta matching
  the injected sleep.

## Owed after the run, regardless of verdict

- **File a B-id** once the in-repo bug registry lands with #597; reference `REG-WATCHDOG-SLOWBOOT` as
  the reproduction token in that filing. The PR body for this fix says so explicitly (owner-owed,
  still open as of close-out).
- **The owner's lessons-cap ruling (PR #594, `maxBytes` 25600→40960) is still owed for the OTHER
  pending batches.** This run itself landed under the existing cap with room to spare (36/40 · 36.3/
  40.0 KB) and needed no fallback, but the register-wide headroom problem flagged elsewhere
  (MEMORY.md: "lessons register has ZERO headroom — the caps ruling is BLOCKING") is unaffected by
  this run and remains the owner's to resolve before other queued batches can append their own
  entries.
- **Lessons cap decision**: if `node scripts/validate-lessons.mjs` reports the byte cap exceeded at
  close-out, WP-DOCS holds back the L-061 entry (bumps `_meta.json.updatedAt` alone). The full entry
  text is reproduced below for the owner's caps ruling — do not lose it:

  ```
  ### L-061 · 2026-09-04 · testing · watchdog spec

  - **Symptom:** a spec green on CI failed on every loaded dev box, pushing people to skip the pre-push gate.
  - **Root cause:** a fixed 500 ms `setTimeout` stood in for "the spawned child has booted"; bare Node boot here is 0.6–6 s. A poll alone still fails: the api lane's undeclared Jest cap is 5 s.
  - **Lesson:** **A fixed delay is never a readiness signal. Wait on the observable (log line, exit, stream) with a capped poll, kill the child in `finally`, and give the async test its own timeout above the cap.**
  - **Guard:** `visibility-watchdog-script.spec.ts` slow-boot repro (`NODE_OPTIONS=--require slow-boot.cjs`, 1.5 s) stays green.
  ```

- **Before `git push`:** run the FULL `apps/api` suite once (`cd apps/api && npx jest src/common
--runInBand`, part of `verifyCommands.final`) so the campaign reporter's `.campaign/runs/api.json`
  reflects the whole lane, not just this scoped spec — a partial artifact fails the pre-push
  campaign-check on unrelated grounds.
- Merge-order note: land this before (or as part of resolving a conflict with) `b9c8e840` on
  `fix/e2e-freshness-guard-fail-open` — that branch's own attempt at this exact fix is superseded here
  and will conflict textually on the same lines.
- Ledger + RUN-LOG: append the ledger row and the ≤10-line RUN-LOG entry per the pipeline-law owner
  ruling once S6 actually executes — this card only covers the plan (S1–S5).

## Deviations

- **Seam extraction is harness preparation, not the fix.** TP1 (test package) and WP1 (implementation
  package) both touch `apps/api/src/common/visibility-watchdog-script.spec.ts` — the file lists are
  not disjoint, which departs from the usual dev-pipeline package-disjointness rule. This is
  deliberate: the "production code" being fixed here is itself test-harness code (the `setTimeout`
  wait), so TP1 must extract it verbatim into a named helper before WP1 can replace its body with the
  real design, and T1 must fail on the bug's exact wrong value at that intermediate step (proving the
  extraction didn't accidentally fix or break anything). No `dependsOn` edge encodes this — phase
  order (all TPs before the first WP wave) already guarantees the sequencing, and a work package must
  never declare `dependsOn` naming a test package.
- **TP1 added a `logFile` param and an `onSpawn` hook to `awaitStartLine`** beyond the build-plan's
  exact-code sketch (which only listed `{argv, env, capMs, intervalMs}`), adapting to the file's
  existing test-seam signature rather than a byte-for-byte pattern match — allowed by the plan's own
  "this is the shape, not a drop-in file" clause. WP1 implemented the real body against that same
  signature unchanged.
- **Fix round 1 added a new T5 pin** (not in the original test plan): `awaitStartLine` now also
  rejects promptly — with the child's exit code and a stderr tail — when the child dies before the
  start line ever appears, instead of burning the full 30 s cap with a diagnosis-free error. Round 1
  also rewrote two stale TP1/WP1-era comment blocks that described the pre-fix state as current, and
  corrected the code-map's `awaitStartLine` signature. Round 2 was one mechanical code-map fix (case
  count / async-test count in `api.md`).
- **Args corrected at close-out, not at launch.** `pipeline-args.json` as it actually launched the
  run carried relative `planPath`/`testPlanPath` and `siblingPatterns` as plain description strings;
  both were corrected on-disk post-hoc (absolute paths; `siblingPatterns` as `{pattern, note}`
  objects) once the discrepancy was noticed during close-out — the run itself was not re-launched.
- **The persisted `result.json` is reconstructed, not a captured engine return.** The Workflow's
  overall return value was truncated by the harness; `result.json` was built from
  `journal.jsonl` (28 agents' `started`/`result` rows, spot-checked against the numbers above) plus
  the aggregate cost/token/tool-use/wall-clock facts supplied at close-out time, which were not
  independently re-summed from the 28 per-agent transcript files.
