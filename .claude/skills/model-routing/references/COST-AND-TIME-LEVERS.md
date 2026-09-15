# Cost and time levers — order, expectations, the ledger, the ten-run rules

## Lever order (free wins before trades; apply one at a time, measure, keep or revert)

0. **Session context (measured 2026-09-10 — the largest term).** Cost is context-size × turns × rate:
   one RouteFlow session re-read ≈ 96K cached tokens on every one of 4,637 messages — $103.66, 97% of
   it cache reads, in no ledger. So: the always-on prefix (CLAUDE.md, `code-map/INDEX.md`,
   `LESSONS-DIGEST.md`, `CONTEXT.md`) stays ≤ ~50 KB total and is never edited mid-session; heavy reads
   run in subagents that return ≤ 2K-token briefs; one task per session, `/handoff` then `/compact`
   (or a fresh session) before a major engine run; planning reads a Sonnet-built context pack, not the
   sources. Measure with `scripts/session-usage.mjs` (below) — not by feel.
1. **Prompt caching.** Stable content first (system prompt, tool list, shared run prefix), volatile
   content last. Never vary effort or model inside one fan-out (each change splits the cache); keep the
   interactive session on one model and do not change `/effort` mid-task. Verify with `/usage`: cache
   reads should rise across a fan-out.
2. **Input hygiene.** Paths not content; code map before source; capped manifests; scoped re-checks
   (only what the fixers touched); the final pass reads HIGH-risk files only.
3. **Loop hygiene.** Tiered gates (cheap per round, full once); no re-running a suite a cache would
   replay — force execution and assert tests ran; cap fix rounds; one remediation round.
4. **Output hygiene.** Targeted edits, not rewrites; Fable writes decisions, Sonnet writes volume; long
   artifacts at `high`, never `xhigh`/`max` (double drafting).
5. **Effort.** The first trade that touches capability. `high` default; `xhigh` only where a miss is
   expensive; `medium`/`low` where the work is transcription or mechanics. Sweep on real tasks, one setting
   per run, and re-sweep after any model change — level names do not map across models.
6. **Model.** Last, deliberately: price candidates in cost per *completed* task, including the stronger
   model at lower effort; step down one tier at a time against a checker.
7. **Parallelism and overlap.** Launch fan-outs together; run read-only phases beside each other; keep
   anything that mutates the tree alone; escalate on failure instead of pre-paying.

## Token-class ruling (owner, 2026-09-10) — where a run's dollars actually go

One 113-agent RouteFlow engine run, true cost $205 (ledger said $14.94):

| Model | Cost | Cache read | Cache write | Output | Reading |
|---|---|---|---|---|---|
| Opus 5 | $179.67 | 219M tok → $109 | 10.8M → $67 | 108K → $2.70 | 98% of Opus spend was re-reading its own growing context |
| Sonnet 5 | $11.54 | 30.7M | 2.1M | 16K | all the volume, a fifth of the price |
| Fable 5.1 | $11.19 | 0 | 895K → $11 | **20 tokens** | a huge brief written to cache for a one-line (or declined) reply |
| Haiku 4.5 | $2.85 | 15.1M | 1.1M | 2K | mechanics |

Rules that follow (full text: `model-routing/SKILL.md` §0): Fable does cache work only (stable prefix,
≤ 8 KB briefs, short rulings); Sonnet does all in/out; Opus gives verdicts over a ≤ 40 KB pack with a
12-tool-call cap and never explores; difficulty, not habit, picks the model; every row of the routing
table is re-derived from the ledger's **routing scorecard** (cost × quality × minutes per task level per
model) every ten true-telemetry runs. Empirical calibration for RouteFlow:
`.claude/pipeline/routing-scorecard-2026-09-10.md`.

## Measured expectations (Anthropic's published runs unless marked *owner*)

| Lever | Expectation |
|---|---|
| Effort, research / knowledge work | nearly flat: `low` −1…3 pts for 33–50% off; `medium` = default accuracy at 70–85% cost |
| Effort, long-horizon coding (Opus 5) | `medium` −2 pts for ½ cost; `low` −8 pts for ¼ cost |
| Cheap pass + re-run failures at default | same pass rate for about ½ the cost when a checker exists |
| Lower effort, wall-clock | 4.5 vs 7.9 min per problem on one benchmark |
| Orchestrator with cheaper workers | −55% cost only when work exceeds one context; loses on a dependent chain |
| Refutation (*owner*, F06) | 35 votes → 2 refutations at ~22% of run tokens; 1–12% refute rates elsewhere |
| Red gate behavioral bar (*owner*, F06/F14) | failed 2 of 3 runs; the remediation round changed nothing; the mutation probe was the proof |
| Final pass on a no-HIGH-risk diff (*owner*, code read) | fell back to reading the whole diff at Fable prices |

## The dev-pipeline knobs this skill governs (`~/.claude/skills/dev-pipeline/pipeline.js → CFG`)

| Knob | Default | What it trades | Evidence to change it |
|---|---|---|---|
| `effort.*` (every role) | explicit per role; no inheritance | tokens and turn time vs depth | a lens phase's `confirmedByPhase` falling to 0 → raise that lens first |
| `effort.lensDeep` / `lensDeepHighRisk` | `high` / `xhigh` when any HIGH file | depth where misses cost | ledger: findings per HIGH-risk run before and after |
| `lazySecondVote` | on | half the refuters on average | `verify.firstVoteRefutedRate` stays low; drops unchanged |
| `verify.mode` | `on-dispute` | pre-refutation only for HIGH-risk / mis-cited findings; the rest are refuted by the fixer and escalated on dispute | `verify.disputed` vs `disputesDropped`: a rising drop count means fixers are catching what the slate used to; a needless fix that shipped means `all` is worth its price |
| `verify.batchPerFile` / `verify.locationCheck` | on / on | one Opus refuter per file (task loop: Fable, Opus fallback); one Sonnet location check | `verify.locationInvalid` > 0 shows the check pays; per-file agents count in `phaseReport` |
| `uiDriverModel` + `effort.uiDrive` / `effort.uiJudge` | Sonnet `medium` drives, Opus `high` judges (task loop: Fable, Opus fallback) | the long browser-driving turn moves off Opus; the verdict stays | `uiVerify.evidence.completed` true on every run; judge findings not systematically fewer than the single-agent runs before 2026-09-03 |
| `finalPassReaderModel` @ `xhigh` → `finalPassModel` @ `high` (+ Sonnet packager @ `low`) | Opus reads, Fable decides (task loop: Fable, Opus fallback) | the adversarial read is Fable's own (over the Sonnet-built digest of the HIGH-risk diff), not a separate Opus reader stage — Opus runs only if Fable declines | `finalPass.candidates` vs `finalPass.findings` (Fable's reject rate) and `finalPass.gaps` (how often coverage was thin); the first post-merge defect on a run whose decider rejected a candidate ends the argument |
| `fixPlanning` (+ `fixBriefModel`, `fixPlannerModel`, `fixPlannerFallbackModel`, `effort.fixBrief/fixPlan/fixPlanFallback/fixExecuteSonnet`) | on: Sonnet brief @ `low` → Fable plans the whole round @ `high` → executors implement (a round of synthetic keys only skips both) | one Fable decision buys designed fixes and moves LOW-risk designed work off Opus onto Sonnet @ `medium` (task loop: Fable, Opus fallback); it costs a brief and a planner every round, and a wrong design is executed faithfully | fix rounds per run (a plan that converges in one round pays for itself), `fixRouting.sonnetDesigned` (how much left Opus), the `designMismatch` count (designs that did not fit the code), and post-merge defects on Sonnet-executed fixes — the first of those ends the argument |
| `redGate.remediateOn` | `structural` (major) | one Opus round per run (task loop: Fable, Opus fallback) | `mutationProbe.allCaught` not worse than the baseline runs |
| `args.mode: 'bugfix'` (the bug-pipeline preset; default `'feature'` = byte-identical engine) | behavioral red bar; design-system lens gated on UI files; corroborated (≥2-lens, well-cited) findings skip pre-refutation; Sonnet radius pack as lens input (scope-coverage exempt); sibling sweep (Sonnet grep → Opus judge; task loop: Fable, Opus fallback); fix-revert probes; Sonnet harness-integrity check | lens input shrinks to the blast radius (F13: 31/31 survivors in-radius) and refuter votes drop (corroboration substitutes for the confirm side only — the two-must-agree DROP rule is untouched); adds four cheap Sonnet/Opus checks a bug batch needs | `verify.corroboratedSkipped` vs overturns among skipped (any overturn-after-skip ends the skip), `radiusPack.built` rate, `siblingSweep.findings` that survive, `harnessCheck.issues` caught pre-authoring, out-of-radius findings the pack suppressed (post-merge defects outside the radius end the pack) |
| `finalPassWhenNoHighRisk` | `skip` | 1 Fable agent on LOW-risk majors | any post-merge defect on a run that skipped it |
| `refuteSeverities` | blocker, major (+ every HIGH-risk file) | refuters on minors | minors that later proved false and were "fixed" |
| `cascadeReview` | off | Opus on the LOW-risk partition | `cascadeAudit.missedFindings` = 0 across ten runs |
| `densityEscalation` | off | non-floor lenses on tiny green diffs | non-floor lenses contributed 0 confirmed across ten qualifying runs |
| `overlapImplementWithRedAudit` | off | the red audit's wall-clock | `overlap.redAuditWithImplement.redGateMetBar` true across ten runs |
| `prices` | dated table | the estUsd labels | refresh from `/claude-api` Current Models |

## The ledger

Each dev-pipeline run persists its result object and appends one line to the project's
`.claude/pipeline/cost-ledger.jsonl`:

```
node ~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs append <result.json> \
  --run <name> --started <iso> --ended <iso> [--branch <b>] [--pr <n>] [--project <dir>]
node ~/.claude/skills/model-routing/scripts/pipeline-ledger.mjs summary [--project <dir>] [--last N]
```

The orchestrating session notes the start time before launching the Workflow (`args.startedAt`), writes
the returned object to `.claude/pipeline/<run>/result.json`, and appends at S8 close-out. A row carries:
scale, clean, duration, `estimatedCostUsd` (output-only estimate at the dated prices), per-phase tokens /
estUsd / agents / raw / confirmed / effort / overlap notes, the red-gate two-level verdict and attempts,
refutation economics, mutation-probe and final-pass outcomes, the overlap flags, cascade and escalation
audits, and remaining findings by severity. No client data ever enters it.

`summary` prints the phase ranking, the ten-run rules' inputs, verify economics, red-gate and final-pass
distributions, overlap counts, mean duration and mean cost.

## The ten-run rules (from the dev-pipeline skill; evaluable only from the ledger)

- **Cut rule.** A finding-producing phase (Baseline, Red gate, Gate & Review, Mutation probe, Final pass)
  with zero confirmed findings across ten real runs is paying only for noise — cut or narrow it. Verify,
  UI verify and Fix consume findings rather than author them; judge Verify by the drop rate it applies.
  The final pass routes its findings to `remainingFindings`, so use its raw count.
- **Measured trades.** `cascadeReview`, `densityEscalation` and `overlapImplementWithRedAudit` stay off
  until their audit field held across ten runs with the flag on (or, for escalation, ten qualifying runs
  with it off). A dead auditor measured nothing, not zero.
- **Too aggressive.** If gated refutation or an effort ceiling drops a lens phase's confirmed count to
  zero, widen `refuteSeverities` or raise that lens's effort before blaming the lens.

## Session-level measurement

- **The true source is the transcript.** `node ~/.claude/skills/model-routing/scripts/session-usage.mjs
  <sessionId|--latest> --project <dir> --wf all` sums every message's `usage` (input, cache write
  5m/1h, cache read, output) per model for the orchestrating session and for each Workflow run's
  subagents (attributed to phases by the `PHASE: … · LABEL: …` line the engine writes), prices them,
  and reports `cacheHitRatio` and `activeMs`. `pipeline-ledger.mjs append --usage <file>` lands it on
  the ledger row (`tokensSource: session-usage`, `trueCostUsd`); rows without it are `telemetry: legacy`
  and the ten-run clocks count only true-telemetry rows. After `TRUE_TELEMETRY_CUTOFF =
  2026-09-12T12:00:00Z`, `dev-pipeline/scripts/closeout.mjs <runDir>` refuses a close-out that lacks
  `--usage <session-usage.json>` (its `violatesTrueTelemetryCutoff` check) unless the run passes
  `--no-usage --reason "<why>"`, which records the reason on the ledger row as `usageOverrideReason`.
  `closeout.mjs <runDir>` runs the whole chain. The Workflow `agent()` return exposes no usage and the engine's `budget.spent()`
  delta silently read 0 on 26% of phases — never trust either for cost.
- `/usage` at the end of a session: tokens per model, cache reads and writes, plan usage.
- `/insights`: a local report over recent sessions.
- Wall-clock is measured outside the Workflow (scripts cannot read the clock): note the launch time,
  stamp the end when the result returns, and let the ledger compute the duration.
