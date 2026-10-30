---
name: bug-pipeline
description: The house pipeline for BUG FIXES — a known defect with an observable wrong behavior (a bug-registry id, a regression, a repro, "X is broken") goes through evidence gathering, adversarial root-cause refutation, one Opus fix ruling, repro-first tests that must fail on the bug's own wrong value, then the shared dev-pipeline engine in bugfix mode (radius-scoped review on Opus for HIGH-risk, sibling sweep, fix-revert probes, harness-integrity check). Use whenever the user asks to fix a bug, defect, regression, or broken/incorrect behavior with a known symptom, cites a bug id, pastes an error or repro, or says "bug pipeline" or "/bug-pipeline". For NEW features, capabilities, refactors, or hardening with no single defect, use dev-pipeline instead. Skip only for trivial typo-class escapes.
---

# Bug pipeline

> **Routing (2026-10-22):** a batch of 3 or more **LOW** bugs goes to `/bug-swarm` (`.claude/skills/bug-swarm/`).
> This pipeline remains the path for every HIGH-risk bug (money, ledger, units, locks, tenancy, migrations,
> billing, auth), for single bugs, and for any swarm cluster that turns out to touch a HIGH path.

A bug fix is not a small feature. It starts from a **known wrong behavior**, so the value is not in discovering
what to build — it is in proving the **cause**, making the **minimal correct fix**, proving the fix **bites**
(the repro test fails without it), and proving the defect's **twin does not ship elsewhere**. This skill owns
those stages and then runs the **same engine as dev-pipeline** with `mode: 'bugfix'` — one engine, two presets,
so the machinery never forks (`~/.claude/skills/dev-pipeline/pipeline.js`; stage the engine inside the repo per
dev-pipeline's launch rules).

Grounded in measured runs (see `references/BUGFIX-NOTES.md`): in the F13 bug batch every one of the 31 surviving
review findings sat inside the bug's blast radius; the costliest blocker was a stale test mock reported by six
lenses; the design-system lens produced only overturned findings; and in F11 **every** suggested fix in the bug
registry was refuted on investigation. Bug work is test-heavy and cause-skeptical, and this pipeline spends there.

## MODEL POLICY (same rule as dev-pipeline)

> **OWNER RULING 2026-10-15 — CURRENT: we do not use Fable.** Every "Fable" role below is **Opus** (generic alias `opus`,
> always the latest Opus, never a pinned version); the unused `CFG.models.fable` entry stays defined in the engine until R7-d removes it.

> **OWNER RULING 2026-09-29 — CURRENT, supersedes the Fable roles below:** every role this file gives to Fable (S3 fix
> ruling, S4/S5 rulings, final-pass rulings) is **Opus @ high** now; Opus also reviews EVERY task (medium
> routine, high HIGH-risk), including the routine reviewer and the sibling-sweep judge (`medium`; `high` when any
> task is HIGH-risk); Sonnet 5.5 (`claude-sonnet-5-5`) builds at medium, never low for code. Fable is not used (owner ruling 2026-10-15).

> **HISTORICAL (superseded for every Fable role by the 2026-09-29 and 2026-10-15 rulings above) — OWNER
> RULINGS 2026-09-13 ("Fable never implements") + 2026-09-14 (lead: "verdicts on Opus, Fable
> only plans"), which superseded the "brain/hands" framing and the 2026-09-10
> "Fable replaces Opus everywhere" ruling below.** Fable is **not called anywhere inside the
> shared engine** (`~/.claude/skills/dev-pipeline/pipeline.js`, run here with `mode: 'bugfix'`) —
> it authors the **S3 fix ruling** and the **S4/S5 test-plan and build-plan rulings** in the
> session, from a Sonnet-transcribed brief, and rules on final-pass candidates in the session too.
> (`CFG.models.fable` is still defined but unused since 2026-10-15; R7-d removes it.)

**Opus 5.5** (`claude-opus-5-5`) is the engine's HIGH-risk judgment tier: the **HIGH-risk reviewer** on a `fix` or
`docs` task touching a HIGH-risk file (money, auth, tenancy, schema, PII) — the only two task types whose chain
runs `reviewStage` at all; `root-cause`'s own implementer-risk routing (next paragraph) instead; `repro-test`'s
RED check is purely mechanical; `revert-probe` is deliberately Haiku-only (a scripted mechanical operation,
never a judgment call) — the **HIGH-risk `root-cause` investigation** whenever its dependent `fix` is
HIGH-risk, direct or transitive, even when the `root-cause` task's own file is routine; and, from **round 3 of
the fix loop onward, the fix DESIGNER** — a separate Sonnet call always executes that design (the old
`executorIsDesigner` round-4 collapse into one call is retired, unreachable since 2026-09-13). Once Final pass
lands, Opus also does the final-pass read on a `major` diff touching a HIGH-risk file. Every Opus call is
wrapped by `withToolCap()` (`CFG.caps.toolCalls` = 12). Opus is a **peer tier chosen directly** for these
roles, not a fallback.

**Sonnet 5.5 (`claude-sonnet-5-5`) does all in/out** (token-class routing, owner ruling 2026-09-10, model updated by the 2026-09-13/
2026-09-14 rulings above; plan: `model-routing/references/ROUTING-PLAN.md`): the S1 evidence brief, root-cause
investigation and its review on non-HIGH-risk tasks, the repro-test author, **every `fix` implementer including
HIGH-risk** (`implementHigh` effort), (the routine reviewer — Opus @ medium since 2026-09-29), **the fix EXECUTOR in every round** (rounds 1–2
with no designer; round 3+ executing Opus's design), and the sibling-sweep judge — one call over the run's
whole batch of `git grep` hits, run on Sonnet unless any task anywhere in the run is HIGH-risk, in which case
Opus takes that single call (never a per-hit decision).

**Haiku 4.5 runs every mechanical step:** Baseline's gates/manifest, the S5.5 grounding pass, per-task
checkpoints, the post-loop sibling-sweep `git grep` over `args.siblingPatterns`, and the `revert-probe`
`checksum:after` verification against Baseline's recorded digests — never a judgment call, always at `low`.

`CFG.models.fallbackModel` (also `claude-opus-5-5`) is a leftover refusal-fallback constant that only backs the
now-dead `executorIsDesigner` path — it is not evidence Opus is "fallback only": Opus is chosen directly for
every role named above.

Every agent gets an explicit full model id and an explicit effort; nothing inherits the session's (see
`model-routing`). The routing scorecard reverts any demotion whose confirmed-finding rate fell — a bug
pipeline that stops catching real causes is the one failure this ruling forbids.

## LEARNING CLAUSE — mandatory (owner ruling 2026-09-10)

Every bug run must leave the next one faster, cheaper, or more accurate, with evidence — quality is the floor:
**read** the newest RUN-LOG entries, the project's `LESSONS-DIGEST.md` and the ledger `summary` before the cause
brief, and cite the lesson ids and fix-cards that apply (a bug in a family with a recorded lesson starts from
that lesson's Guard); **measure** with `scripts/closeout.mjs <runDir>` — true cost, active time, cache-hit,
findings per phase, probes caught; **record** one RUN-LOG entry, the lesson this bug paid for (Symptom / Root
cause / Lesson / Guard — the register's Guard is the regression pin), the bug-registry flip and the code-map
entries in the same PR; **act** every ten true-telemetry runs via the ten-run rules and escalate a knob candidate
that recurs in 3+ entries to the owner (the "failing REG command is the red bar" rule took six entries — that is
the failure this clause exists to prevent); **prove** every change to this skill or the engine with its own
check and RUN-LOG line. Full text: `dev-pipeline/references/LEARNING-CLAUSE.md`.

## Stages

### S0 — Triage (you, in-session; one minute)

- Run `route-task.mjs --json` on the ask (the `UserPromptSubmit` hook already printed `--advise`); its
  route and ultracode call are the triage default — override only with a stated reason.
- **Lane (SS1, 2026-09-16).** The router also returns a `lane` — `surgical` | `standard` | `high-risk` —
  alongside `route`/`reason`. Write it into **`args.lane`** next to the existing `args.scale`/`args.profile`;
  override only with a stated reason. This pipeline always runs the shared engine in `mode: 'bugfix'`, so the lane
  is what picks **how much of it the bug earns**: a `high-risk` lane (the bug sits in auth, tenancy, money, schema
  or permissions, or its radius is genuinely wide) takes the full bugfix-mode `pipeline.js` path — cause
  refutation, repro-first red gate, radius-scoped Opus review, sibling sweep, revert probes. A `surgical` or
  `standard` lane routes to `scripts/light-loop.js` (`args.lane` passed through; 1 fix round surgical, 2
  standard) — **correction (Opus review 2026-09-16): `light-loop.js` has no bugfix mode.** It has no red-gate
  stage, no `wrongValue` handling, and no repro-first check of any kind — it is the same generic
  build/pack/review/fix loop dev-pipeline uses. On this lane the repro-first discipline is NOT engine-enforced;
  it lives entirely in the BRIEF the S1 authoring step writes: the brief must itself instruct the builder to
  write a failing repro test before the fix, and light-loop's Opus reviewer is the only backstop that catches a
  brief that skipped this. Building an actual bugfix mode into `light-loop.js` (§2/§3 of the redesign plan named
  this as new, unbuilt work) is tracked as follow-up, not done here. The scoped tests, `npm run verify`, and
  `pre-merge-review` at close-out remain genuinely non-negotiable in both lanes — only the repro-first RED GATE
  is engine-enforced on `high-risk` and brief-enforced (weaker) on `surgical`/`standard`.
- Is it actually a bug (an observable behavior contradicting intended behavior), or a feature request in disguise?
  Feature-shaped → dev-pipeline. No repro and no defensible expected behavior → get one first; a bug you cannot
  state as "input X gives Y, should give Z" is not ready.
- **Trivial escape**: typo-class fixes (a string, a label, an off-by-one in a message) skip the pipeline — fix,
  add or adjust the one obvious test, done.
- Batch decision: bugs in the SAME subsystem may share one run (shared radius, shared tests); unrelated bugs never
  do — one slow fix round blocks everything and the radius stops meaning anything.
- Read the project's `LESSONS-DIGEST.md` (open a full `LESSONS.md` entry only for an id carried into the plan) and the bug registry brief when they exist.

### S1 — Evidence brief (Sonnet @ medium, read-only agent)

Start with `get_node` plus radius on the implicated symbol; callers and covering specs at file:line (`graph@<sha>`; an empty graph answer is UNKNOWN, not "none" — grep). One agent gathers, verbatim into `cause-brief.md` (template, **≤ 8 KB**): the registry row / issue text; the
repro and the exact wrong value; the suspected cause AS A CLAIM (never as truth); `git log`/`git blame` of the
implicated lines (when did this last change, in what commit, what else changed with it); the failing code path
with excerpts; the tests that exist around it and what they assert today; production evidence if any (log
lines, corrupted rows — ids and amounts only, never client identifiers); the applicable lesson ids from
`LESSONS-DIGEST.md`, each with its one-line Lesson; and excerpts of any prior fix-cards for the same area. No
judgment, no fix proposals.

### S2 — Cause refutation (Opus @ medium routine / Opus @ high HIGH-risk — a verdict over the S1 brief, ≤ 12 tool calls, read-only)

Trace with `shortest_path`; no path refutes nothing (the graph is blind to env vars, Prisma and some cross-package edges). One agent whose job is to **refute the suspected cause**: "assume the suspicion is wrong; find the evidence that
proves or disproves it; trace the actual path from repro input to wrong output; name the exact line where behavior
diverges from intent, or the reason the suspicion cannot be the cause." It must end with a verdict —
`confirmed` (with the diverging line), `refuted` (with the disproof and, if visible, the actual cause), or
`undetermined` (with the missing evidence). This stage exists because suggested fixes are wrong often enough to
have burned whole batches; a fix built on an unverified cause is the most expensive kind of green.

### S3 — Fix ruling (Opus @ high; Fable (retired) before 2026-09-29 — a decision over the brief + refutation, no repo access)

> **Design Gate (owner R19, mandatory):** before this ruling is approved, apply the `future-proof` skill's "Fixing: the area, not the symptom" section (big-picture fix, area sweep and chunked fixes, owner questions batched now) and put its Lite gate in `cause-ruling.md`; a P0 hotfix carries the Hotfix gate and files its area sweep as the follow-up. No build without it (`.claude/skills/future-proof/SKILL.md`).

Opus (Fable, retired, before 2026-09-29) receives S1 + S2 verbatim and rules once, into `cause-ruling.md` (template):

1. **Cause verdict** — accept, or send S2 back with the specific question (one round; still undetermined →
   surface to the owner, do not build).
2. **Fix design** — what changes, where, and what must NOT change (the minimal-diff line: name the files and the
   shape of each edit); the **invariant** the fix must preserve.
3. **Regression tests** — for each bug: the REG-tagged repro test and the exact wrong value it must fail on
   today; the pins that freeze correct neighboring behavior.
4. **Blast radius** (it is the radius: graph callers reconciled with `git grep`, grep-only files read first; the sibling sweep stays grep, regex over literals) — the review-context depth for each `fix` task, as a `[before, after]` context-line pair
   (feeds that task's `radius:` field, read by `review-pack.mjs --radius before,after`); the pack's radius FILES
   are auto-discovered by the script itself from call-site hits of the fix's changed/exported symbols — this
   ruling sets only how much surrounding code the reviewer sees around each hit, never a file list.
5. **Sibling pattern** — the defect's shape as grep-able regex(es) with a note each (feeds the engine-level
   `siblingPatterns` array — read once for the whole run, not per task); "none plausible" is an allowed answer
   and is recorded.
6. **Data repair** — did the bug corrupt persisted data? If plausibly yes: a read-only report script first, owner
   decides the repair; the fix never ships bundled with an unreviewed backfill.
7. **Probe plan** — which fixed files need a `revert-probe` task (`{file, test}`, one per probed file) and which
   named REG test must go red for each; the engine runs these strictly sequentially after the wave loop and
   verifies every restore with one shared `checksum:after` agent (see S6).

### S4 — Test plan (Opus 5.5 @ high rules; Sonnet 5.5 @ medium transcribes)

Opus 5.5 rules the decisions — REG token per bug id, the exact expected value TODAY (the wrong one) and AFTER the
fix, the harness note — as a compact ruling. A Sonnet `medium` agent expands that ruling into the full
`bug-test-plan.md` template (per test: id T#, REG token, setup, Given/When/Then, the harness note the engine's
harness-integrity check will verify) and returns a **≤ 1.5K diff brief**: what it filled, what it could not
decide (raised to Opus, never guessed). Opus rules on the brief; it does not re-read the expanded file. Pins
carry no REG token and stay outside the red gate. **The red bar is behavioral**: each REG test must fail on its
own wrong value, not merely fail — reproduction is the point, and the engine enforces it in bugfix mode (a red
set that stays non-behavioral after remediation is a major blocker, not a note).

### S5 — Build plan + args (Opus 5.5 @ high rules; Sonnet 5.5 @ medium transcribes; the args block is mandatory)

Same split as S4: Opus's ruling covers the package boundaries, file ownership, the hard lines and the tiered
commands; a Sonnet `medium` agent transcribes `build-plan.md` with the standard package structure (see
dev-pipeline's template) plus the **"## Pipeline args"** block containing, beyond the standard fields:
`mode: 'bugfix'`, an `args.tasks[]` array typed `'root-cause' | 'repro-test' | 'fix' | 'revert-probe'` (plus
`'docs'` when a bug batch also needs a documentation-only task — there is no `'sibling-sweep'` task type; the
sibling sweep is a post-loop ENGINE step gated on `mode:'bugfix'`, never something the plan schedules as a
task), each `fix` task carrying its own `radius:[before,after]` from S3.4 and each `revert-probe` task carrying
`{file, test}` from S3.7, an engine-level `siblingPatterns` array (from S3.5, or omitted — read once for the
whole run, never per task), REG-scoped `redGate.commands`, tiered `verifyCommands` scoped to the touched
workspaces (never a repo-wide suite), `lessonsPath`/`startedAt`, and `runDir` (the run's absolute artifact
directory — enables the per-phase Haiku `low` checkpoint cards and the `result.json` summary). Sonnet returns
the same ≤ 1.5K diff brief as S4. Per-package `effort`: bug diffs are small — `medium` default, `high` only for
money/auth/tenancy files.

### S5.5 — Grounding pass (Haiku `low`)

Before approval, one Haiku 4.5 agent verifies every fact the build plan asserts against the tree — each path
exists, each verification command's script exists in the manifest, the base sha equals the integration
branch's head, every `revert-probe` task's `file` names a real path, and the engine-level `siblingPatterns`
(when present) are well-formed regexes — and returns a pass/fail list. A fail blocks S6; the plan is corrected,
not annotated.

### S6 — Execute (the shared engine, bugfix mode)

Approval writes the `/handoff` card (run dir, branch, base sha, args path, decisions, open owner questions)
and then `/compact` — or a fresh session for a larger batch — before launch: the engine needs only artifact
paths, and every later turn would otherwise re-read the planning context for nothing. Launch per dev-pipeline's
S7 launch rules (staged versioned engine copy inside the repo, worktree installed, RESUME card written BEFORE
launch). What `mode: 'bugfix'` changes inside the engine:

| Engine behavior                                      | feature (default)                                             | bugfix (`mode:'bugfix'`)                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Red-gate bar                                         | per task, structural (every named test fails on an assertion) | same, plus **behavioral** for `repro-test` tasks — the failure output must contain the bug's own wrong value; either shortfall survives one test-author remediation, then a `(red-gate)` blocker                                                                                                                                                                                                                                |
| Task types available                                 | `feature`, `docs`, `ui-verify`                                | adds `root-cause`, `repro-test`, `fix`, `revert-probe` — a `fix` starts only once its `root-cause` ancestor reports `reproduced && causeConfirmed` (else a Ruling and that chain stops), and needs both a `root-cause` and a `repro-test` ancestor                                                                                                                                                                              |
| Review input (`pack.md`, built by `review-pack.mjs`) | Diff + Call sites                                             | same script and sections; a `fix` task typically carries the S3.4 `radius:[before,after]` pair so the script's own call-site-derived excerpts show more (or less) surrounding code                                                                                                                                                                                                                                              |
| Sibling sweep (`Verify` phase)                       | — (`args.siblingPatterns`, if any, is ignored and logged)     | post-loop engine step: Haiku `git grep` over `args.siblingPatterns` → judge (ONE call over the whole hit batch — Opus `medium`, or Opus `high` if any task in the run is HIGH-risk) classifies each hit `defect \| same-class-but-guarded \| unrelated`; each `defect` becomes a `remainingFindings` entry, source `sibling-sweep`                                                                                              |
| Mutation / revert probes                             | — unless a `revert-probe` task is in the plan                 | `revert-probe {file, test}` tasks run strictly sequentially (never through `parallel()`) after the wave loop: backup outside the repo, `git show HEAD:<file> > <file>`, run ONLY the named test (must fail on an assertion), restore, then exactly ONE separate `checksum:after` Haiku agent verifies every probed file's restore via `git hash-object` against Baseline's recorded digests — never the probe's own self-report |
| Harness check                                        | —                                                             | Baseline step, Sonnet `low`, read-only: touched specs' mocks/fixtures vs the planned surface → notes only, never blocks                                                                                                                                                                                                                                                                                                         |

Everything else — explicit routing, Opus-designed / Sonnet-executed fixes from round 3 (`fix`/`dispute`/`defer` per finding), the
Baseline-digest-vs-`checksum:after` restore verification, final pass on HIGH-risk diffs — is identical to
dev-pipeline. The final pass stays: in the F13 bug batch (pre-rebuild engine) it caught a major
money-durability defect the seven-lens fan-out missed; that fan-out itself was dropped repo-wide in the
2026-09-12 task-loop rebuild (superseded by the single per-task reviewer — see dev-pipeline `SKILL.md`'s MODEL POLICY section), so
nothing in this skill still routes findings through it.

### S7 — Close-out (owed regardless of verdict)

- **One command:** `node ~/.claude/skills/dev-pipeline/scripts/closeout.mjs <run dir> [--project <dir>] [--session <id>|--latest]`
  persists `result.json`'s ledger row (`pipeline-ledger.mjs append`, with true `--usage` telemetry when a
  session is found, else `--telemetry legacy`), inserts the RUN-LOG.md stub (run slug · mode · scale · cost ·
  active wall-clock · Caught/Wasted pre-filled · Knob candidate/Deviation left `TODO`) — since this pipeline
  always runs in `mode: 'bugfix'`, the LESSONS.md stub always fires too, bumping `_meta.json.nextId`. `--dry`
  previews every write first. See dev-pipeline `SKILL.md` S8 for the full behavior; the old `--subagent-tokens`
  flag never existed as a real mechanism and is gone from every command in this chain.
- **`pre-merge-review` — EVERY lane, EVERY PR, no exceptions (SS3b, 2026-09-16).** Before this fix's PR enters a
  merge window, invoke the **`pre-merge-review`** skill on its diff. It is independent of the in-lane review and is
  the only stage the 2026-09-14 cost investigation found with a measured catch rate distinct from an embedded
  reviewer (13 defects / 12 PRs / 36h). It was previously wired to **neither** pipeline's close-out and ran only
  when a landing coordinator happened to remember it. A light-lane bug fix carries the same obligation as a
  high-risk one; `result.json`'s `preMergeReview` object (`required:true, ran:false`) exists so a run that
  skipped it is visible rather than silent.
- **Bug registry** (when the project has one): flip each fixed id with its proof line — the REG test names and the
  probe results are the proof; T2/deployed-only claims stay pending-deploy.
- **Lessons register** (when the project has one): append the entry (Symptom / Root cause / Lesson / Guard) — the
  root cause is already written in S2/S3, so this costs minutes; a genuinely lesson-free fix bumps the register's
  `updatedAt` alone.
- Deferred findings and the S3.6 data-repair question go to the owner verbatim.
- Update the code map entries for touched files.

## Reading the result (beyond dev-pipeline's fields)

`mode` · `siblingSweep.{ran, supplied, patterns, hits, findings, skipped}` ·
`harnessCheck.{ran, issues, skipped}` ·
`mutationProbe.{ran, skipped, probed, allCaught, restoredVerified, results}` — every `results[]` entry is one
`revert-probe` task's outcome (`caught`, `restored`, `evidence`, `backupPath`, `fallback`); there is no separate
"mutation" probe kind anymore (every probe is a `revert-probe`), and there is no `radiusPack`/`lensesRun` field
— the lens fan-out and its dedicated radius pack were dropped in the 2026-09-12 task-loop rebuild, superseded
by the single per-task reviewer over `pack.md` (see dev-pipeline `SKILL.md`'s MODEL POLICY section). An UNVERIFIED oracle is never
neutral: a skipped sibling sweep is fine when S3.5 said "none plausible"; `restoredVerified:false` means the
in-script `git hash-object` comparison against Baseline's digests — never a probe agent's own self-report —
did not confirm every reverted file came back byte-identical.

## Cost expectations and guards

A single-subsystem bug batch should land around **$8–14 output and 45–70 minutes** — the savings come from
skipping discovery/spec/UX, radius-scoped review input, and smaller diffs, never from removing a check (this
pipeline runs MORE checks than a feature run: cause refutation, harness integrity, revert probes, sibling sweep).
Guards: every `repro-test` task's `behaviorallyRed` ends true (no task left blocked at the Red gate);
`mutationProbe.allCaught`/`restoredVerified` true; the single per-task reviewer still confirms real findings on
comparable batches (per-phase confirmed counts in the ledger); post-merge defect rate per batch not worse than
the F13 baseline (measured on the pre-rebuild engine). Trades are made on ledger rows, never on taste
(`model-routing`).

**Repro-first and anti-tamper checks (DARK, R4).** Before opening the PR, run `node scripts/fix-revert-probe.mjs` and paste its table in the PR body: at least one test file should read `repro` (fails without the fix, passes with it); `not-repro` means that test does not prove the fix. `node scripts/test-tamper-check.mjs` flags a weakened test (removed assertion, loosened matcher, `.skip`); an intended edit carries `// tamper-ok: <reason>`. Both exit 0 and only report until the flip review.

## DO NOT

- Do not fork the engine — `mode` is the only divergence point; a hand-edited engine copy drifts silently.
- Do not widen the fix beyond the S3 design; improvements discovered en route become registry/backlog entries.
- Do not let a repro test pass today for any reason ("close enough" reproduction is non-reproduction).
- Do not run repo-wide suites or Playwright as gates; scope every command.
- Do not ship a data repair bundled with the fix; report first, owner decides.
- **The failing REG-scoped baseline command IS the red bar** — do not re-run it "to be sure" or treat a
  second red as stronger evidence; one behaviorally-red run per REG test is the proof, and re-running invites
  a flake to overwrite it (RUN-LOG: this distinction recurred across six entries).
