---
name: model-routing
description: >-
  Routing per owner rulings 2026-09-29 and 2026-10-15: Opus (generic alias `opus`, always the latest) plans and reviews
  every task, Sonnet 5.5 builds, Haiku 4.5 does mechanics; Fable is not used. How to get the best coding work out of Claude while spending the
  fewest tokens and the least wall-clock: which model (Opus / Sonnet 5.5 / Haiku 4.5) and which effort
  level to give every task and subagent, what the planner should write itself versus delegate, how to prompt Opus, how to keep
  fan-outs cache-friendly and fast, and how to measure a run so trades are made on numbers. Use whenever
  the user asks which model or effort to use, mentions Opus, Sonnet, Haiku, cost, tokens, budget,
  "too expensive", "too slow", speed, delegation, subagents, "optimize tokens", "model routing", or
  "/model-routing" — and read it before starting any multi-agent, Workflow, or dev-pipeline work.
---

# Model routing — decisions and verdicts on Opus, volume on Sonnet 5.5, mechanics on Haiku

> **OWNER RULING 2026-10-15 — CURRENT, supersedes every "Fable" line below: we do not use Fable.** Every role below that
> names Fable (planning, framing, fix design, final-pass decisions, tie-breaks, verdicts, the lead/orchestrator) is **Opus**,
> addressed by the generic alias `opus` (always the latest Opus; never write a pinned Opus version into a model
> string or routing table). Sonnet and Haiku roles are unchanged. Fable's price row below is kept for history, to read old
> ledger rows and transcripts.

> **OWNER RULING 2026-09-29 (question box) — CURRENT; supersedes every "Fable decides / Sonnet verdicts on routine"
> line below, which is HISTORICAL.** (1) **Planning, framing, fix design and every judgment read: Opus @ high**
> (alias `opus`; $4 in / $20 out, cache read $0.20 at the Opus rates) — Fable is not used (owner ruling 2026-10-15). (2) **Opus
> reviews EVERY task**: `medium` on routine tasks, `high` on HIGH-risk (dev-pipeline `reviewTier()`, light-loop
> `reviewEffort()`, `route-task.mjs` `review`/`verdict` roles; both `lean` and `standard`). (3) **Builders: Sonnet 5.5**
> (`claude-sonnet-5-5`, $2/$10, cache read $0.20, 1h write $4) @ `medium` — never `low` for a code-writing role
> (at `low` it "sometimes reports a code change as done without a check that exercises it"), and every
> code-writing prompt carries Anthropic's verification paragraph. Haiku 4.5 unchanged (mechanics, `low`).
> Evidence: Anthropic 2026-09: Opus >= the retired Fable 5.1 on all 9 published benchmarks at 40% of the price; Sonnet 5.5 =
> half Opus's per-token price, strongest at well-scoped tasks and bug fixes; Opus stronger at open-ended judgment
> and code review (72% vs 56% known bugs caught vs Opus 5).
> **Measure:** the next ten true-telemetry runs compare review findings, folds, CI rolls and cost per task against the
> pre-2026-09-29 rows; a lane or role that ships more defects reverts.

The interactive session is Opus, the decider tier ($4 in / $20 out per
MTok at the Opus rates). Its output tokens are where the money goes, and effort is where the time goes. Everything below
follows from three facts: **decision density decides the model, difficulty decides the effort, and no
subagent ever inherits the session's effort** (they do by default, so an Opus session at `xhigh` silently
runs every Opus reviewer and Sonnet implementer at `xhigh` too).

Prices, capabilities and traps per model: [MODEL-CARDS](references/MODEL-CARDS.md). Prompt snippets and
the subagent prompt template: [FABLE-PROMPTING](references/FABLE-PROMPTING.md) (the file name is kept for history; the snippets apply to Opus). Lever order, measured
expectations, the ledger and the ten-run rules: [COST-AND-TIME-LEVERS](references/COST-AND-TIME-LEVERS.md).

## 0. Token-class routing (owner ruling 2026-09-10 — read this before the table)

The full per-level plan — model, effort, input/output/tool-call caps, cache pattern, target $ and minutes
per call, and the signal that reverts each row — is [ROUTING-PLAN](references/ROUTING-PLAN.md). This
section is its summary.

Price per MTok, the four classes that matter:

| Model                                                         | Fresh input | Cache write (5m / 1h)  | **Cache read** | **Output** |
| ------------------------------------------------------------- | ----------- | ---------------------- | -------------- | ---------- |
| Fable 5.1 (NOT USED — owner 2026-10-15; historical rows only) | $10         | $12.50 / $20           | **$0.25**      | **$50**    |
| Opus (current)                                                | $4          | 1h write not published | **$0.20**      | $20        |
| Opus 5 (historical)                                           | $5          | $6.25 / $10            | $0.50          | $25        |
| Sonnet 5.5 (current)                                          | $2          | $2.50 / $4             | $0.20          | $10        |
| Sonnet 5 (historical)                                         | $2          | $2.50 / $4             | $0.20          | $10        |
| Haiku 4.5                                                     | $1          | $1.25 / $2             | $0.10          | $5         |

Measured on one 113-agent engine run ($205 true): Opus $180, of which **$109 was cache reads and $67
cache writes — $2.70 was verdict output**; retired Fable $11 was cache writes for a 20-token reply; Sonnet did all
the volume for $11.50. The waste is not "Opus is expensive": it is Opus (and the retired Fable) doing **in/out and
cache work** — reading repos, re-reading a growing context on every tool call — that Sonnet does for a
fifth of the price at the same quality on saturated coding. Hence the classes:

- **Opus (the decider; formerly Fable, retired) = cache work only.** The long-lived orchestrator over a stable, cached prefix (its cache read is
  the cheapest of the three judgment models) plus short rulings. Almost never fresh in/out: it reads no
  file, receives ≤ 300-token agent summaries (agents write artifacts to disk), and rules in ≤ 2 KB. Inside
  the engine an Opus decider call gets a ≤ 8 KB brief and answers in one turn.
- **Sonnet = all in/out.** Reading, exploring, gathering, packing, transcribing, implementing, testing,
  packaging, driving the browser, mechanical and designed fixes — and the **verdict on routine work**
  (non-HIGH-risk files) at `high`. Difficulty sets its effort: `low` mechanics, `medium` transcription,
  `high` judgment.
- **Opus = verdicts the difficulty earns, over a compact input.** The correctness lens on every file (A4 — cross-family check on Sonnet-written code), deep lenses on HIGH-risk files
  (money, auth, tenancy, schema, PII), refutation of blocker/major findings there, the red-gate audit, the
  final-pass read, security, HIGH-risk fix execution. Always over a Sonnet-built pack (≤ 40 KB), never
  exploring the repo itself, hard-capped at ~12 tool calls — an Opus agent that reads 50 files has been
  routed wrong. Not for "cache work": never the model that re-reads a big shared prefix across a fan-out.
- **Haiku = mechanics** with a checkable output.
- **Difficulty decides, not habit:** trivial/mechanical → Haiku; routine read/write/transcribe → Sonnet
  `medium`; judgment on routine files → Opus `medium` (2026-09-29; was Sonnet `high`); judgment on HIGH-risk files or a split vote → Opus
  `high`; framing, architecture, tie-breaks, fix design → Opus `high` (Fable retired 2026-10-15). A demotion that drops a
  phase's confirmed findings across ten true-telemetry runs is reverted (learning clause, quality floor).
- **Three axes, one scorecard.** Every routing choice is judged on cost **and** quality **and** time, per
  task level, from the ledger — never on price alone. `session-usage.mjs` records each agent's true cost
  and duration (first → last message); `pipeline-ledger.mjs summary` emits the **routing scorecard**: for
  each task level (mechanical · routine build/test · routine verdict · HIGH-risk verdict · framing) and
  each model/effort actually used — mean $/task, mean minutes/task, and the quality signal for that level
  (reviewers: confirmed findings per agent and the refutation-overturn rate; test authors: behavioral-red
  rate; implementers: fix rounds their packages caused; refuters: dropped-finding rate; probes: caught rate).
  The cheapest model that holds the level's quality signal within the last ten runs, at the shortest
  time, wins the row. Speed facts to weigh: Sonnet emits fastest, then Opus per token; one
  effort step down is ≈ 40% faster; a fan-out of small-input agents beats one long-context agent on
  wall-clock because each tool call re-reads its whole context.

### Ultracode vs effort (owner question 2026-09-10)

Effort is a **depth** dial on one call; ultracode is a **breadth** switch on the session (a Workflow with
fan-outs, judge panels and adversarial verification for every substantive task — ~15× the tokens of a
single agent by Anthropic's own measurement, paying only on breadth-first, parallelisable, high-value
work). Use ultracode for audits, reviews of large diffs, research sweeps, wide design decisions,
migrations and HIGH-risk verification; not for bounded edits, dependent chains, or anything one Sonnet
pass plus a checker already gets right (the dev/bug pipelines are already multi-agent and ledger-tuned).
When it is on, this skill still governs: the token-class ruling (§0) applies to every workflow agent,
`effort` is explicit per agent (`low` for mechanics), `pipeline()` over barriers, paths not content,
schemas not prose, two refutation votes except on HIGH-risk, loop-until-dry with ≤ 2 dry rounds, worktree
isolation only for concurrent editors, and a `+Nk` budget directive on the turn as the hard ceiling.
Ultracode is never cheaper per turn than one low-effort call; it is cheaper per _accepted result_ only
where single-pass error rates are high — the scorecard decides where that is.

**Telling the owner when to switch (automatic advisory).** The switch is the owner's; the advice is not
optional: `scripts/route-task.mjs` scores a task's shape — breadth (audit / review / research / migrate /
design / "all" / "thoroughly"), risk (money, auth, tenancy, schema, PII paths), boundedness (fix / rename /
one file), novelty (no lesson or fix-card covers it), verifiability (tests exist) — and returns the engine
(light loop / full pipeline / workflow), **ultracode ON or OFF with the reason**, and per-role model +
effort from the scorecard. It runs three times: as a `UserPromptSubmit` hook on every new request
(prints the recommendation into context), at S0 triage (on the real task shape), and at close-out ("next
task: OFF unless …"). One Opus session is the lead; workers are Sonnet/Opus/Haiku subagents at explicit
efforts — never additional lead sessions as an effort ladder (each one re-pays its cached prefix and its
$4/$20 in/out); parallel sessions only for independent workstreams.

### `route-task.mjs` contract

`~/.claude/skills/model-routing/scripts/route-task.mjs` scores one ask against the five signals above —
breadth, risk, boundedness, novelty, verifiability — and never calls a model itself. Three flags:
`--advise` (the `UserPromptSubmit` hook's mode, ≤ 400 bytes, prints engine + ultracode + per-role
model/effort into context and nothing else); `--json` (the same verdict as a machine-readable object, for
S0 triage and close-out to consume); `--explain` (the scored signals plus the reasoning trace, for an
owner reviewing a routing call — never piped into an agent prompt). Output: the engine (light loop / full
pipeline / workflow), **ultracode ON/OFF with the reason**, and per-role model + effort. **Scorecard
override:** once `pipeline-ledger.mjs summary` holds **≥ 10 true-telemetry runs** for a task level, that
level's routing comes from the scorecard's own cost×quality×minutes row instead of the static tables
below — the script reads `summary` first and falls back to §1/ROUTING-PLAN only when a level has no
scorecard history yet. Runs three times per task (unchanged): `UserPromptSubmit` (advisory only), S0
triage (on the real task shape), close-out (the next-task recommendation) — never a fourth session, never
a peer to the lead Opus session.

## 1. Routing table

| Work                                                                                                                                                                                                                                                                                                                                                                                                                                                | Model                                                                                                                                       | Effort                                                                                                                                          | Why                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Planning, specs, architecture, decisions under ambiguity, cross-file invariants, the final-pass DECISION over candidates an Opus reader produced from a Sonnet-built digest, tie-break judgments from cited evidence, the design of every fix over a Sonnet-built brief, the bug-pipeline fix ruling over an evidence brief and an Opus cause refutation                                                                                            | **Opus** (alias `opus`) — since 2026-09-29 (Fable retired 2026-10-15)                                                                       | `high`; `ultrathink` (one turn) or `xhigh` only for framing money / auth / tenancy / schema work                                                | Best on above-frontier work; a wrong plan poisons every cheaper stage after it. Hand it the gathered facts and let it judge: at higher effort it over-gathers context on its own                                                                                                                                         |
| The correctness lens on EVERY file (ruling A4: ~64% of self-generated errors survive same-family self-checking, so Sonnet code needs an Opus correctness read), deep lenses (spec-compliance, edge-cases-and-security, operability) on HIGH-risk files, refutation of blocker/major findings there, red-gate audit, final-pass read, HIGH-risk judgment fixes, UI verdicts on HIGH-risk surfaces — always over a Sonnet-built pack, ≤ 12 tool calls | **Opus** (alias `opus`) — reviews EVERY task since 2026-09-29                                                                               | `medium` routine / `high` HIGH-risk; `xhigh` for deep lenses only when the diff has HIGH-risk files                                             | Top-tier verdicts at the Opus price — but its cache read ($0.20 on Opus; $0.50 on the historical Opus 5) is not free, so it judges a compact pack and never explores (token-class ruling, §0). Inside dev-pipeline's task-loop engine this role is Opus on every task (2026-09-29; the 2026-09-12 Fable role is retired) |
| Pattern review lenses (style, consistency, test-quality, design-system), refutation of findings on routine files, mutation probes, UI verdicts on routine surfaces, build repair on routine files (HISTORICAL for reviews/verdicts: since 2026-09-29 those run on Opus @ medium)                                                                                                                                                                    | **Sonnet 5.5** (`claude-sonnet-5-5`)                                                                                                        | `medium`                                                                                                                                        | Same quality on saturated coding at a fifth of Opus's in/out price; the scorecard reverts any row where its confirmed-finding rate drops                                                                                                                                                                                 |
| Tests and implementation transcribed from an Opus plan, mechanical fixes, migrations, sweeps, reading / exploration fan-outs, context packs, mechanical checks (does a cited location exist)                                                                                                                                                                                                                                                        | **Sonnet 5.5** (`claude-sonnet-5-5`)                                                                                                        | `medium` for transcription and every code edit (`high` for the one money/tenancy package); `low` only for read-only readers and non-code checks | Executes a decided spec well; never plans — a gap in the plan is a finding, not a guess                                                                                                                                                                                                                                  |
| Running commands, checksums, manifests, anything with a checkable output                                                                                                                                                                                                                                                                                                                                                                            | **Haiku 4.5** (`claude-haiku-4-5`)                                                                                                          | `low`                                                                                                                                           | Cheapest and fastest; wrong on judgment                                                                                                                                                                                                                                                                                  |
| Context pack / repo facts gathering (read-only)                                                                                                                                                                                                                                                                                                                                                                                                     | **Sonnet 5.5** (`claude-sonnet-5-5`)                                                                                                        | `medium` (read-only)                                                                                                                            | Gathers paths and facts for a planner to decide from; never rules on what it finds                                                                                                                                                                                                                                       |
| Plan transcription (test/build plan from the Opus ruling)                                                                                                                                                                                                                                                                                                                                                                                           | **Sonnet 5.5** (`claude-sonnet-5-5`)                                                                                                        | `medium`                                                                                                                                        | Expands a decided ruling into the full template; a gap it finds is raised, never guessed                                                                                                                                                                                                                                 |
| Grounding / tree-fact checks / per-phase checkpoints / close-out                                                                                                                                                                                                                                                                                                                                                                                    | **Haiku 4.5** (`claude-haiku-4-5`)                                                                                                          | `low`                                                                                                                                           | Mechanical verification and verbatim summarization only; wrong on judgment                                                                                                                                                                                                                                               |
| Blast radius (callers, covering specs)                                                                                                                                                                                                                                                                                                                                                                                                              | **A script, not an agent** (`graph.mjs radius`, run by `task-brief`/`review-pack`); Haiku only runs the graph refresh, canary and G0 checks | n/a                                                                                                                                             | Graph plus grep, no model tokens; Opus never explores and never runs a radius (design: `rf-specs-handoff/specs/graphify/DESIGN.md`)                                                                                                                                                                                      |

Pin full model ids in scripts and agent definitions: a bare alias resolves to whatever the harness maps it
to today (a bare `sonnet` can land on Sonnet 4.6 at $3/$15). Effort names do not mean the same depth
across models — re-sweep after any migration.

**Owner trial, never enabled and now void (Fable retired 2026-10-15):** vendor-published SWE-bench Pro figures have the retired Fable 5.1 at `low`
beating Sonnet 5 default (88.6% vs 77.4%) at 35% less cost per solved task, and Opus 5 `low` +
rerun-failures beating all-default at half cost — both in tension with §0's cache-work-only framing for
Fable (retired). Proposal on the table, not adopted: a 10-run trial of retired Fable @ `low` as the implementer for the one
HIGH-risk package per run, scored on fix rounds and confirmed findings against the Sonnet baseline.
Requires the owner's explicit yes before any run uses it; nothing in this file enables it today.

## 2. Effort ladder

- `high` is the default everywhere (the API default and Claude Code's default). Set it explicitly anyway.
- `xhigh`: HIGH-risk depth (money, pricing, tax, auth, tenancy, schema, PII, payments) and nothing else.
- `medium`: Sonnet transcription, refuters on LOW-risk findings, the mutation probe; a routine Opus turn that is dragging can drop to `medium`.
- `low`: Haiku-class mechanics and Sonnet mechanical fixes. measure before reaching for a cheaper model on judgment-shaped reads.
- `max`: never by default. At `xhigh`/`max` the decider drafts long deliverables twice (once in thinking, once
  as the reply). Write specs, test plans and documents at `high`.
- Do not change the session's effort mid-task: an `effort` change invalidates the messages cache. Raise
  one turn with `ultrathink`; set the session default with `/effort <level>` or
  `settings.json → modelSettings[model].effortLevel`.
- **Sweep effort before escalating model** (owner ruling 2026-09-10): before moving a task up a model
  tier, try one step up the effort ladder on the _same_ model first and let `route-task.mjs` log
  score-vs-spend at each step; escalate the model only when the effort sweep does not close the quality
  gap.

## 3. Decider-session rules (what Opus writes, what it hands off; formerly "Fable-session rules", retired)

1. **[Fable retired 2026-10-15: read "Fable" in §3 as "Opus @ high".] The decider writes decisions, not volume.** The 20 hard lines, the R#/T# matrix, the verdict, the spec.
   Sonnet types tests, boilerplate, mechanical edits and long documents from an exact brief. In the pipeline that is
   literal: the plan, the fix designs, the final verdicts — never the reading, the driving, the packaging or the
   execution.
2. **Every subagent gets an explicit `model` and `effort`.** Workflow `agent()` takes both. The Agent
   tool takes only `model` — set `effort:` in the agent's frontmatter (`.claude/agents/*.md`) or accept
   inheritance knowingly. Reader/Explore fan-outs: `model: "sonnet"`.
3. **Cap background agents at four**, in waves; each is a ~500 MB process and fourteen took a session
   down. Inside a Workflow the runtime queues the excess — that cap is not permission to multiply sessions.
4. **Launch a fan-out together.** Agents with the same model, effort and tools started within a few
   seconds share the prompt-prefix cache; serializing them to "save tokens" loses both cache and time.
5. **Shared prefix first.** Subagent prompts open with the block every agent in the run shares (repo
   note, artifact paths, manifest, lessons register), then the role line, then the task specifics.
6. **Targeted edits, never whole-file rewrites** (a frontier-model tendency worth naming in every editing
   prompt). **Ground every claim in a tool result** before reporting it.
7. **Reuse before re-deriving.** The graph → code map → lessons register → prior run artifacts (`.claude/pipeline/`,
   `fix-cards/`, `design-system.md`) → then read source. Planning turns should not rediscover what the
   last batch recorded.
8. **Security-flavoured asks may be declined by a model.** Route security review to Opus; treat a dead
   agent as "declined", retry once on Opus at a higher effort, and never report an unverified read as clean.
9. **The decider is the brain, never the hands.** The Opus decider reads no file and runs no command when a Sonnet
   agent can bring it the facts; it decides from briefs. In an Opus decider session that means delegating reads,
   forensics, mechanical edits and long writing, and keeping its own turns to rulings.
10. **Executors never delete, move, stash or checkout.** Ownership is stated per brief (which files this
    agent may touch); scratch goes to the session scratchpad, never a repo path; agents editing one repo
    concurrently get `isolation: "worktree"` or disjoint files — never a shared checkout with overlapping writes.
11. **Cost is read from the transcript** (`model-routing/scripts/session-usage.mjs`), never from an
    in-engine counter (`budget.spent()` silently read 0 on 26% of phases in one measured run) or by feel.
12. **Learning clause (mandatory, owner ruling 2026-09-10).** Every routed run leaves the next one faster,
    cheaper or more accurate with evidence: read the newest RUN-LOG entries + `LESSONS-DIGEST.md` + the ledger
    `summary` before planning; measure with `closeout.mjs` / `session-usage.mjs --all`; record; act every ten
    true-telemetry runs (ten-run rules), escalating a knob candidate that recurs in 3+ entries to the owner;
    prove every routing or effort change with its own check and RUN-LOG line. Quality is the floor — an
    effort or model step-down that drops a phase's confirmed findings is reverted, not defended. Canonical
    text: `dev-pipeline/references/LEARNING-CLAUSE.md`.

## 4. Speed rules

- Effort ceilings are the first speed lever: lower effort is documented roughly 40% faster per problem.
- Run read-only phases beside each other (refutation beside UI verification; final full gate beside the
  final pass); anything that mutates the tree (a mutation probe) runs alone.
- Tier the gates: cheap scoped typecheck/lint every round, the full suite once at the end.
- Escalate on failure instead of pre-paying: Sonnet at `medium` first, Opus repairs a red gate.
- Verify on dispute, not everything: pre-verify only where a wrong fix is expensive (HIGH-risk files, mis-cited
  findings), one Opus refuter per file; let the fixer refute first elsewhere and send only disputes to the slate.
  Measured: 30 first votes overturned 2 findings on F13; the slate's value is in the disputed tail, not the bulk.
- Delegate asynchronously and keep working; write the RESUME card when a long run _starts_, not after a
  kill. Opus **fast mode** (2.5× tokens/s, priced at a premium, main loop only) is the right choice for an
  interactive mechanical loop where latency matters more than reasoning.
- Drop phases the ledger says never convert (see §6); never drop coverage.
- **Run cheap, rerun failures at default** (owner ruling 2026-09-10): checkable phases — test authoring,
  gates, mechanics — run at `low`/`medium` first and rerun only the failures at the default effort,
  rather than paying default effort on every call up front.
- **Fan-out value gate** (owner ruling 2026-09-10): fan out only when sub-tasks are genuinely independent
  and the stakes match the ~15× token multiplier of running several agents where one would do; the
  ultracode advisor applies this same gate before turning breadth on.

## 5. Prompting Opus agents (snippets in the FABLE-PROMPTING file, name kept for history)

State the goal, the constraints and the acceptance check; keep numbered choreography only for fragile,
single-safe-sequence steps (destructive commands, restore-by-copy) and for Sonnet transcription. Prompts
written for older models are usually too prescriptive for current models and lower their output quality. Add the
autonomy and scope blocks for unattended runs, the grounded-claims line to every reporter, the
targeted-edit line to every editor, and the long-deliverable note only when a request must run at
`xhigh`/`max`. Snippets, verbatim, in [FABLE-PROMPTING](references/FABLE-PROMPTING.md) (name kept for history).

## 6. Measure, then tune

- After every dev-pipeline run, close out with one command:
  `node ~/.claude/skills/dev-pipeline/scripts/closeout.mjs <runDir> --latest` — it runs
  `scripts/session-usage.mjs` (true tokens from the session transcript, per phase via the engine's
  `PHASE · LABEL` tags), then `pipeline-ledger.mjs append … --usage <session-usage.json>`
  → `.claude/pipeline/cost-ledger.jsonl`, then the RUN-LOG / lessons / code-map stubs. Read `summary`
  before touching any `CFG` knob; only `telemetry: true` rows count toward the ten-run rules.
- Session context is the largest cost term (COST-AND-TIME-LEVERS lever 0): a 4.6K-message session
  cost $103 in cache reads alone. Keep the always-on prefix small and stable; one task per session;
  `/handoff` then `/compact` before a major run.
- The ten-run rules live there: cut a finding-producing phase with zero confirmed findings across ten
  runs; enable a measured trade only when its audit field held across ten runs.
- `/usage` at the end of a session shows tokens per model and cache reads; a fan-out whose cache reads do
  not rise is not sharing its prefix.
- Prices in the cards are dated. Refresh from the `claude-api` skill's Current Models table when they age.

### Approach routing

Which **methodology** runs a task — `dev-pipeline` (profile `lean`/`standard`), `superpowers`, `raw` (no
framework), or `bug-pipeline` (dev-pipeline's own bugfix mode) — is a separate decision from the routing
table above (that table picks the _engine_/model/effort once an approach is already running).
`model-routing/scripts/approach.mjs next --task "<head>"` pins the decision **before** the session
launches (isolation is a per-session plugin-enable switch that cannot flip mid-session), via
`route-task.mjs`'s `decideApproach`:

| Precedence | Condition                                                                | Approach                                                               |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| 1          | an explicit pin is already set for this session                          | whatever it pins                                                       |
| 2          | known-defect signal (registry id, "crash"/"broken"/"regression" wording) | `bug-pipeline`                                                         |
| 3          | HIGH-risk, or major/wide-breadth, or UI work                             | `dev-pipeline` `standard`                                              |
| 4          | trivial (bounded, LOW breadth, LOW risk)                                 | `raw`                                                                  |
| 5          | everything else ("small LOW-risk")                                       | rotation `dev-pipeline → superpowers → raw`, advanced once per session |

Full protocol — the quality rubric every ledger row carries, the one-task-per-session isolation rule,
contamination rules, minimum n = 10 before `compare` ranks an arm, and how to read
`pipeline-ledger.mjs compare`'s output — is [EVAL-PROTOCOL](references/EVAL-PROTOCOL.md).

## 7. How the house taxonomies map onto this ladder

`dev-pipeline` routes by **stage** (since 2026-09-29: Opus plans and reviews every task, Sonnet 5.5
builds and executes fixes, Haiku gates; Fable retired 2026-10-15); the RouteFlow `team`
agents route by **role** (tech-lead Opus/high,
builder Sonnet/medium, qa-engineer Sonnet/high, feature-reviewer Opus/high); `bug-hunt` routes by
**defect class** (conservation invariants, forensics, concurrency and security on Opus,
mechanical sweeps on Sonnet behind a strong verifier). All three are the same ladder. The one open
disagreement — money judgment defaults to Sonnet-at-high in `qa-engineer` but to Opus in the global
rule — is the owner's call; until ruled, escalate money/tenancy verification to Opus per invocation.
