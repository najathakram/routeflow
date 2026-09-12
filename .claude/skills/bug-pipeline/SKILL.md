---
name: bug-pipeline
description: The house pipeline for BUG FIXES — a known defect with an observable wrong behavior (a bug-registry id, a regression, a repro, "X is broken") goes through evidence gathering, adversarial root-cause refutation, one Fable fix ruling, repro-first tests that must fail on the bug's own wrong value, then the shared dev-pipeline engine in bugfix mode (radius-scoped review, sibling sweep, fix-revert probes, harness-integrity check). Use whenever the user asks to fix a bug, defect, regression, or broken/incorrect behavior with a known symptom, cites a bug id, pastes an error or repro, or says "bug pipeline" or "/bug-pipeline". For NEW features, capabilities, refactors, or hardening with no single defect, use dev-pipeline instead. Skip only for trivial typo-class escapes.
---

# Bug pipeline

A bug fix is not a small feature. It starts from a **known wrong behavior**, so the value is not in discovering
what to build — it is in proving the **cause**, making the **minimal correct fix**, proving the fix **bites**
(the repro test fails without it), and proving the defect's **twin does not ship elsewhere**. This skill owns
those stages and then runs the **same engine as dev-pipeline** with `mode: 'bugfix'` — one engine, two presets,
so the machinery never forks (`.claude/skills/dev-pipeline/pipeline.js`; stage the engine inside the repo per
dev-pipeline's launch rules).

Grounded in measured runs (see `references/BUGFIX-NOTES.md`): in the F13 bug batch every one of the 31 surviving
review findings sat inside the bug's blast radius; the costliest blocker was a stale test mock reported by six
lenses; the design-system lens produced only overturned findings; and in F11 **every** suggested fix in the bug
registry was refuted on investigation. Bug work is test-heavy and cause-skeptical, and this pipeline spends there.

## MODEL POLICY (same brain/hands rule as dev-pipeline)

**Fable 5.1 is the brain, never the hands.** It reads briefs (≤ 8 KB), never the repository; it rules, never
runs. Its decision points here: the **fix ruling** (S3), and inside the engine the tie-break judge, the final-pass
decider and the fix planner. **Token-class routing (owner ruling 2026-09-10; plan:
`model-routing/references/ROUTING-PLAN.md`):** **Sonnet 5** does all in/out — gathers evidence, builds the evidence
and radius packs, writes tests and code, sweeps for siblings, probes, and casts the verdict on routine files at
`high`; **Opus 5** gives the verdicts the difficulty earns — refutes the suspected cause when the bug sits in a
HIGH-risk file (money, auth, tenancy, schema, PII), reviews and refutes findings on HIGH-risk files, audits the
red gate, executes HIGH-risk fixes — always over a ≤ 40 KB pack with a 12-tool-call cap, never exploring the
repo; the cause refutation on a routine-file bug is Sonnet @ `high` with the same adversarial contract. **Haiku**
runs gates, grounding and checkpoints at `low`. Every agent gets an explicit full model id and an explicit effort;
nothing inherits the session's (see `model-routing`). The routing scorecard reverts any demotion whose
confirmed-finding rate fell — a bug pipeline that stops catching real causes is the one failure this ruling
forbids.

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
- Is it actually a bug (an observable behavior contradicting intended behavior), or a feature request in disguise?
  Feature-shaped → dev-pipeline. No repro and no defensible expected behavior → get one first; a bug you cannot
  state as "input X gives Y, should give Z" is not ready.
- **Trivial escape**: typo-class fixes (a string, a label, an off-by-one in a message) skip the pipeline — fix,
  add or adjust the one obvious test, done.
- Batch decision: bugs in the SAME subsystem may share one run (shared radius, shared tests); unrelated bugs never
  do — one slow fix round blocks everything and the radius stops meaning anything.
- Read the project's `LESSONS-DIGEST.md` (open a full `LESSONS.md` entry only for an id carried into the plan) and the bug registry brief when they exist.

### S1 — Evidence brief (Sonnet @ medium, read-only agent)

One agent gathers, verbatim into `cause-brief.md` (template, **≤ 8 KB**): the registry row / issue text; the
repro and the exact wrong value; the suspected cause AS A CLAIM (never as truth); `git log`/`git blame` of the
implicated lines (when did this last change, in what commit, what else changed with it); the failing code path
with excerpts; the tests that exist around it and what they assert today; production evidence if any (log
lines, corrupted rows — ids and amounts only, never client identifiers); the applicable lesson ids from
`LESSONS-DIGEST.md`, each with its one-line Lesson; and excerpts of any prior fix-cards for the same area. No
judgment, no fix proposals.

### S2 — Cause refutation (Opus @ high, read-only agent)

One agent whose job is to **refute the suspected cause**: "assume the suspicion is wrong; find the evidence that
proves or disproves it; trace the actual path from repro input to wrong output; name the exact line where behavior
diverges from intent, or the reason the suspicion cannot be the cause." It must end with a verdict —
`confirmed` (with the diverging line), `refuted` (with the disproof and, if visible, the actual cause), or
`undetermined` (with the missing evidence). This stage exists because suggested fixes are wrong often enough to
have burned whole batches; a fix built on an unverified cause is the most expensive kind of green.

### S3 — Fix ruling (Fable @ high — a decision over the brief + refutation, no repo access)

Fable receives S1 + S2 verbatim and rules once, into `cause-ruling.md` (template):

1. **Cause verdict** — accept, or send S2 back with the specific question (one round; still undetermined →
   surface to the owner, do not build).
2. **Fix design** — what changes, where, and what must NOT change (the minimal-diff line: name the files and the
   shape of each edit); the **invariant** the fix must preserve.
3. **Regression tests** — for each bug: the REG-tagged repro test and the exact wrong value it must fail on
   today; the pins that freeze correct neighboring behavior.
4. **Blast radius** — the files review depth belongs to (feeds `radiusFiles`).
5. **Sibling pattern** — the defect's shape as grep-able regex(es) with a note each (feeds `siblingPatterns`);
   "none plausible" is an allowed answer and is recorded.
6. **Data repair** — did the bug corrupt persisted data? If plausibly yes: a read-only report script first, owner
   decides the repair; the fix never ships bundled with an unreviewed backfill.
7. **Probe plan** — which fixed files get `revertFix: true` probes and which named REG test must go red for each.

### S4 — Test plan (Fable @ high rules; Sonnet @ medium transcribes)

Fable rules the decisions — REG token per bug id, the exact expected value TODAY (the wrong one) and AFTER the
fix, the harness note — as a compact ruling. A Sonnet `medium` agent expands that ruling into the full
`bug-test-plan.md` template (per test: id T#, REG token, setup, Given/When/Then, the harness note the engine's
harness-integrity check will verify) and returns a **≤ 1.5K diff brief**: what it filled, what it could not
decide (raised to Fable, never guessed). Fable rules on the brief; it does not re-read the expanded file. Pins
carry no REG token and stay outside the red gate. **The red bar is behavioral**: each REG test must fail on its
own wrong value, not merely fail — reproduction is the point, and the engine enforces it in bugfix mode (a red
set that stays non-behavioral after remediation is a major blocker, not a note).

### S5 — Build plan + args (Fable @ high rules; Sonnet @ medium transcribes; the args block is mandatory)

Same split as S4: Fable's ruling covers the package boundaries, file ownership, the hard lines and the tiered
commands; a Sonnet `medium` agent transcribes `build-plan.md` with the standard package structure (see
dev-pipeline's template) plus the **"## Pipeline args"** block containing, beyond the standard fields:
`mode: 'bugfix'`, `radiusFiles` (from S3.4), `siblingPatterns` (from S3.5, or omitted), `mutationProbe.targets`
with `revertFix: true` where S3.7 says so, REG-scoped `redGate.commands`, tiered `verifyCommands` scoped to the
touched workspaces (never a repo-wide suite), `lessonsPath`/`startedAt`, and `runDir` (the run's absolute
artifact directory — enables the per-phase Haiku `low` checkpoint cards and the `result.json` summary). Sonnet
returns the same ≤ 1.5K diff brief as S4. Per-package `effort`: bug diffs are small — `medium` default, `high`
only for money/auth/tenancy files.

### S5.5 — Grounding pass (Haiku `low`)

Before approval, one Haiku 4.5 agent verifies every fact the build plan asserts against the tree — each path
exists, each verification command's script exists in the manifest, the base sha equals the integration
branch's head, `radiusFiles`/`siblingPatterns` name real paths — and returns a pass/fail list. A fail blocks
S6; the plan is corrected, not annotated.

### S6 — Execute (the shared engine, bugfix mode)

Approval writes the `/handoff` card (run dir, branch, base sha, args path, decisions, open owner questions)
and then `/compact` — or a fresh session for a larger batch — before launch: the engine needs only artifact
paths, and every later turn would otherwise re-read the planning context for nothing. Launch per dev-pipeline's
S7 launch rules (staged versioned engine copy inside the repo, worktree installed, RESUME card written BEFORE
launch). What `mode: 'bugfix'` changes inside the engine:

| Engine behavior       | feature (default)              | bugfix                                                                                                    |
| --------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Red-gate bar          | structural                     | **behavioral**; persistent shortfall = major blocker                                                      |
| design-system lens    | always                         | only when the diff touches UI files                                                                       |
| Review input          | whole diff                     | **radius pack** (Sonnet-built diff hunks + call sites); out-of-radius findings need reachability evidence |
| Verify pre-refutation | HIGH-risk / mis-cited findings | same, minus findings **corroborated by ≥ 2 lenses** (drop rule unchanged)                                 |
| Sibling sweep         | —                              | Sonnet grep → Opus judge, beside Verify; `defect` verdicts join the fix rounds                            |
| Mutation probes       | choose-a-defect                | **fix-revert** where flagged: restore HEAD content by copy, the REG test must go red                      |
| Harness check         | —                              | Sonnet checks touched specs' mocks/fixtures against the planned surface; notes feed the test author       |

Everything else — explicit routing, lessons-fed lenses, verify-on-dispute, Fable-planned fixes, checksum bracket,
final pass on HIGH-risk diffs — is identical to dev-pipeline. The final pass stays: in the F13 bug batch it
caught a major money-durability defect the lenses missed.

### S7 — Close-out (owed regardless of verdict)

- **One command:** `node .claude/skills/dev-pipeline/scripts/closeout.mjs <run dir> [--project <dir>] [--session <id>|--latest]`
  persists `result.json`'s ledger row (`pipeline-ledger.mjs append`, with true `--usage` telemetry when a
  session is found, else `--telemetry legacy`), inserts the RUN-LOG.md stub (run slug · mode · scale · cost ·
  active wall-clock · Caught/Wasted pre-filled · Knob candidate/Deviation left `TODO`) — since this pipeline
  always runs in `mode: 'bugfix'`, the LESSONS.md stub always fires too, bumping `_meta.json.nextId`. `--dry`
  previews every write first. See dev-pipeline `SKILL.md` S8 for the full behavior; the old `--subagent-tokens`
  flag never existed as a real mechanism and is gone from every command in this chain.
- **Bug registry** (when the project has one): flip each fixed id with its proof line — the REG test names and the
  probe results are the proof; T2/deployed-only claims stay pending-deploy.
- **Lessons register** (when the project has one): append the entry (Symptom / Root cause / Lesson / Guard) — the
  root cause is already written in S2/S3, so this costs minutes; a genuinely lesson-free fix bumps the register's
  `updatedAt` alone.
- Deferred findings and the S3.6 data-repair question go to the owner verbatim.
- Update the code map entries for touched files.

## Reading the result (beyond dev-pipeline's fields)

`mode` · `lensesRun` · `verify.corroboratedSkipped` · `radiusPack.{built,truncated,files}` ·
`siblingSweep.{ran,patterns,hits,findings}` · `harnessCheck.issues` · probe `kind` (`revert-fix` | `mutation`).
An UNVERIFIED oracle is never neutral: a skipped sibling sweep is fine when S3.5 said "none plausible"; a dead
radius pack means the lenses read wide (more tokens, not less coverage).

## Cost expectations and guards

A single-subsystem bug batch should land around **$8–14 output and 45–70 minutes** — the savings come from
skipping discovery/spec/UX, radius-scoped review input, and smaller diffs, never from removing a check (this
pipeline runs MORE checks than a feature run: cause refutation, harness integrity, revert probes, sibling sweep).
Guards: `redGate.behaviorallyRed` must end true; `allCaught`/`restoredVerified` true; every surviving lens still
confirms on comparable batches (`lensesRun` + per-phase confirmed counts); post-merge defect rate per batch not
worse than the F13 baseline. Trades are made on ledger rows, never on taste (`model-routing`).

## DO NOT

- Do not fork the engine — `mode` is the only divergence point; a hand-edited engine copy drifts silently.
- Do not widen the fix beyond the S3 design; improvements discovered en route become registry/backlog entries.
- Do not let a repro test pass today for any reason ("close enough" reproduction is non-reproduction).
- Do not run repo-wide suites or Playwright as gates; scope every command.
- Do not ship a data repair bundled with the fix; report first, owner decides.
- **The failing REG-scoped baseline command IS the red bar** — do not re-run it "to be sure" or treat a
  second red as stronger evidence; one behaviorally-red run per REG test is the proof, and re-running invites
  a flake to overwrite it (RUN-LOG: this distinction recurred across six entries).
