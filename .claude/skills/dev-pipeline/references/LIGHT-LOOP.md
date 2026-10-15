# Light loop — `light-loop.js`, a bounded-work Workflow script

> **OWNER RULING 2026-09-29:** Sonnet 5.5 (`claude-sonnet-5-5`) builds at `medium` (never `low` for code); Opus 5.5 (`claude-opus-5-5`) reviews every task — `medium` routine, `high` when any package is HIGH-risk — and rules the fix plan at `high` (was Fable 5.1). Fable is never called by this script.

Owner ruling 2026-09-10 (skills-build wave 2): the light loop is now a real Workflow script,
`~/.claude/skills/dev-pipeline/scripts/light-loop.js`, not a manual S1–S5 checklist. It shares
pipeline.js's PROMPT CONVENTIONS — a byte-identical RUN PREFIX, a `PHASE: <alias> · LABEL:
<slug>` tag on every agent call, per-phase Haiku checkpoints — so `session-usage.mjs` and the
ledger need no new parsing. It is **not** a `mode:'light-loop'` fork of the pipeline.js engine
and it has **not** moved to its own skill directory: `dev-pipeline/SKILL.md` and bug-pipeline
both still link this file.

Design: `routeflow/.claude/pipeline/skills-design-2026-09-10.md` §3. Ruling:
`skills-upgrade-ruling-2026-09-10.md` C1. Brief: `skills-build-brief-2026-09-10.md` §3.

> Note (2026-09-12 task-loop rebuild): `pipeline.js` was rebuilt on the superpowers task-loop shape
> (`references/ENGINE-NOTES.md`'s `## 2026-09-12 — task-loop rebuild`); `light-loop.js` is untouched and
> stays the brief-driven BOUNDED variant — one brief, no `tasks[]` plan, a `maxFixRounds` cap — for small
> bounded work, while `pipeline.js` is the full plan-driven engine.

## Invoking it

Run it as a Workflow (`scriptPath` pointing at `dev-pipeline/scripts/light-loop.js`, staged
like `pipeline.js` — copy to `local-assets/tooling/light-loop-<version>.js`, never overwriting
a copy a live run still depends on). A brief (S1, written by the calling Opus 5.5 turn or one
preceding `agent({model:'claude-opus-5-5', effort:'high'})`) is an **input** — the script
starts at S2 and reads no source of its own about WHY this work exists, only WHAT the brief
says to do.

> **2026-09-16 redesign — this script is now the DEFAULT execution path.** `route-task.mjs` used to send
> only bounded/LOW/LOW work here and let everything else fall through to `pipeline.js`'s catch-all (20–90 agents
> for work a 2–4-agent loop does). SS1 inverted that: anything that is not a HIGH-risk domain or genuinely wide
> breadth routes **here**, and `pipeline.js` became the rare, explicit escalation. Two things came with the
> promotion — a `lane`, and a **hard agent-call ceiling enforced in code** (below).

**Args** — `{ briefPath*, runDir*, workdir, lessonsPath, startedAt, runId, concurrentEditors:false,
isolation:'shared'|'worktree' (default 'worktree' once concurrentEditors:true — see below),
spansSkillAndRepo:false, lane:'standard'|'surgical', maxFixRounds:(lane default), maxAgentCalls:(lane default),
fixPlanOverride }` (`*` required).

### Lane and the agent-call ceiling (SS3, 2026-09-16)

| `args.lane`          | `maxFixRounds` | `maxAgentCalls` | When the router picks it              |
| -------------------- | -------------- | --------------- | ------------------------------------- |
| `surgical`           | 1              | 20              | bounded change, LOW breadth, LOW risk |
| `standard` (default) | 2              | 32              | everything else that is not HIGH-risk |

`surgical` takes **one** fix round: a bounded change its single review round did not resolve wants a human
decision, not a second automated attempt. An explicit `args.maxFixRounds` / `args.maxAgentCalls` still wins
over the lane default.

**The ceiling is real code, not prose.** `askAgent()` counts every call except `warmup` (cache priming); on
breach the run throws to a halt path that writes an `agent-cap` checkpoint, pushes a blocker finding naming the
ceiling, and closes out with `haltedAt: 'agent-cap'` — **never a silent continue and never a silent re-spawn**.
Close-out itself is exempt (a `closeoutMode` flag), so breaching the cap can never destroy the evidence of
breaching it.

Sizing, so a future retune has the reasoning: the redesign plan wrote this cap as "surgical ~2 calls, standard
~4". That is the count of **work** agents the loop's shape has (build / review / fix / re-check), not a whole-run
total — a total of 4 would halt during Ground, before the run did any work. The ceilings above are sized from the
loop's real structure instead (a healthy surgical run is ~15 calls end to end; a standard run with two packages,
two lenses and two rounds ~26), with headroom, so the cap fires on a **runaway** — the 108-agent incident this
redesign exists to prevent — and never on a healthy run. `result.json` reports `agentCalls`,
`workAgentCalls` (the substantive 2–4 the plan cares about), `warmupCalls` and `maxAgentCalls` so these
numbers get retuned from ledger evidence, never from taste.

### `pre-merge-review` is owed by this lane too (SS3b, 2026-09-16)

Every run's `result.json` carries `preMergeReview: { required:true, ran:false, note }`. The script cannot
invoke a Skill, so the **session** that launched the loop owns actually running `pre-merge-review` on the PR
diff before it enters a merge window. A grep on 2026-09-16 found that skill wired to **neither** engine's
close-out — it ran only when a landing coordinator remembered it — and it is the one stage the 2026-09-14 cost
investigation measured a distinct catch rate for (13 defects / 12 PRs / 36h). Cheap, and no lane's cost target
buys its way out of it.

- `briefPath` — the brief file. Ground (phase 1) verifies every file/script/sha it names
  actually exists before Build ever runs.
- `runDir` — this run's own directory: `<runDir>/phases/*.json` (checkpoints),
  `<runDir>/review-pack.md` (the pack), `<runDir>/result.json` (the close-out artifact),
  `<runDir>/RESUME.md` (written at preflight).
- `runId` — optional; defaults to `wf_<runDir's own basename>` when omitted. Prefixes every
  checkpoint's idempotency key and is how `pipeline-ledger.mjs`/`session-usage.mjs` attribute
  true per-run token usage back to this run.
- `concurrentEditors` — **false by default**. Only when explicitly `true` does Build/Execute
  fan its packages/fixes out at all, and that fan-out now defaults to `isolation:'worktree'`
  (owner ruling 2026-09-11, F6): `concurrentEditors:true` **alone**, with no `isolation` key
  given at all, is enough to get worktree isolation. `isolation:'shared'` only wins when the
  caller passes it **explicitly** — which also falls the fan-out back to sequential, since
  parallel work is never safe unisolated. Otherwise every package or fix runs **sequentially,
  one agent at a time, with no isolation** (see "Single-agent default" below). A shared file
  across packages must still be **declared** in the brief (`dependsOn`), never inferred from a
  path prefix.
- `spansSkillAndRepo` — set when the change touches both an engine/skill file and a
  docs/repo file. Turns Review into **two parallel Opus lenses** instead of one (see below).
- `maxFixRounds` — hard cap on Fix-brief → Fix-plan → Execute → Re-check cycles. A run that is
  still dirty at the cap ends `clean:false` with `remainingFindings` populated — it never
  silently attempts a round beyond the cap, and the owner decides from there. A `BLOCK` review
  verdict does **not** bypass this pipeline (owner ruling 2026-09-11, F7) — it is a hard stop
  _into_ Fix brief/plan, with the same round cap as any other dirty run.
- `fixPlanOverride` — optional. When the calling session itself IS Opus 5.5 (or Fable, when the owner asked) and has already ruled
  the fix plan inline (no agent hop needed), pass that ruling here; `runFixPlan` returns it
  verbatim and never spawns the fix-plan agent for that round.

## The phases (alias = the `PHASE_ORDER` name emitted — the ledger needs no change)

| #   | Phase     | alias                                                         | model · effort                                                                                                                                | contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | --------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Preflight | Baseline                                                      | Haiku 4.5 `low`                                                                                                                               | host-contention check, ≤3 retries; a still-contended host makes the run abort **before any further agent call of any kind** — `{aborted:'host-contention', phaseReport:[]}`                                                                                                                                                                                                                                                                                                     |
| 1   | Ground    | Baseline                                                      | Haiku 4.5 `low`                                                                                                                               | every file/script/sha the brief names must exist; a fail blocks Build and closes the run out immediately (with a blocker finding), never a silent skip                                                                                                                                                                                                                                                                                                                          |
| 2   | Build     | Implement                                                     | Sonnet 5.5 `medium` (`high` for a HIGH-risk package)                                                                                          | per package, disjoint files; scoped gates; a deviation from the brief is a finding, never an unlogged improvisation                                                                                                                                                                                                                                                                                                                                                             |
| 3   | Pack      | folded into Gate & Review (first pass) / Final pass (refresh) | Sonnet 5.5 `low`, read-only (not a code-writing role)                                                                                         | `review-pack.md` ≤ 40 KB: spec excerpt + acceptance criteria **first** (ruling A1), then diff hunks, then call sites, then lesson ids — truncation drops the lowest-priority section first, never the spec/diff                                                                                                                                                                                                                                                                 |
| 4   | Review    | Gate & Review                                                 | Opus 5.5 `medium` routine / `high` when any package is HIGH-risk, ≤ 12 tool calls                                                             | refute-first correctness lens; **two parallel lenses** (engine/scripts, docs/repo) when `spansSkillAndRepo` — see below; every finding is `plausible` until execution-verified (ruling A2), never self-confirmed                                                                                                                                                                                                                                                                |
| 5   | Fix brief | folded into Fix                                               | Sonnet 5.5 `low` (not a code-writing role)                                                                                                    | packages open findings for the planner; proposes no design itself                                                                                                                                                                                                                                                                                                                                                                                                               |
| 6   | Fix plan  | Fix                                                           | Opus 5.5 `high`; Opus 5.5 `xhigh` retry once if it returns nothing (was Fable 5.1)                                                            | brief text only, **zero repo access**; decides fix / dispute / defer per finding, writes the design + invariant + `testPin` + `executorTier` for every "fix"; the brief itself is capped at 8192 bytes with a `[truncated at 8 KB — packager must tighten]` marker (F5, mirrors pipeline.js's `capFableBrief()`), built once and reused verbatim on the Opus fallback — the fallback call stays **exempt** from the 12-tool-call cap below (F8), since it reads brief text only |
| 7   | Execute   | Fix                                                           | Sonnet 5.5 `medium` (mechanical and designed-low; never `low` for code) / Sonnet 5.5 `high` (HIGH-risk; Opus decides only, never writes code) | implements exactly the planner's design; a design that does not fit the code returns `status:'blocked'`, never an improvised substitute; disjoint files per executor; an **Opus-tier** executor carries the same 12-tool-call budget clause as Review/Re-check (F8)                                                                                                                                                                                                             |
| 8   | Re-check  | Final pass                                                    | Sonnet 5.5 `low` pack refresh → **one** Opus 5.5 re-check (`medium` routine / `high` HIGH-risk)                                               | scoped to only the fixes just applied — no new lenses, no re-reading files outside this round; the Opus reader carries the 12-tool-call budget clause (F8); loops back to Fix brief when dirty, capped at `maxFixRounds` — including when the round was entered on a `BLOCK` verdict (F7)                                                                                                                                                                                       |
| 9   | Result    | folded into Final pass                                        | Haiku 4.5 `low`                                                                                                                               | writes `<runDir>/result.json` in the shape `closeout.mjs`/`pipeline-ledger.mjs buildRow()` reads: `mode:'light-loop'`, `scale`, `runId`, `startedAt`, `endedAt`, `fixRounds` (also `rounds`, kept for back-compat), `clean`, `remainingFindings[]`, `confirmedByPhase{}`, `phaseReport[]`, `checkpoints[]`                                                                                                                                                                      |

**Alias rule.** Every `agent()` call's `PHASE:` tag is a real `PHASE_ORDER` name (copied
verbatim from `pipeline-ledger.mjs`: Baseline, Author tests, Red gate, Implement, Gate &
Review, Verify, UI verify, Mutation probe, Fix, Final pass). The three steps with no row of
their own in the phase table above (Pack, Fix brief, Result) are folded into the alias of the
step they materially serve — Pack tags `Gate & Review` on its first pass and `Final pass` on
the re-check refresh; Fix brief tags `Fix`; Result tags `Final pass`. This is strictly stronger
than "some phases have no alias" — every alias this run ever emits is checkable against one
list, which is exactly what `light-loop-dry-run.mjs` asserts.

## Single-agent default (ruling C1)

Coherent sequential work gets **one agent, sequentially, no isolation** — this is the default
whether or not `concurrentEditors` is set. Fan-out with `isolation:'worktree'` happens **only**
when the caller explicitly set `concurrentEditors:true`, and even then only for genuinely
independent files (a package's own file list, a fix's own target file). Do not set
`concurrentEditors` to get "faster" on a brief with two packages that both touch the same
file — that is exactly the case worktree isolation cannot make safe on its own; the brief must
declare the dependency, and the honest answer is to run it sequentially.

## The two-review rule

When `spansSkillAndRepo` is true, Review runs as **two parallel Opus 5.5 lenses (`medium` routine / `high` HIGH-risk)** instead
of one: one reads the engine/scripts side of the diff, the other reads the docs/repo side. A
single reviewer covering both drifts toward whichever half it read first — this is the same
reasoning `dev-pipeline`'s engine applies to bugfix-mode's multi-lens review, carried over
unchanged. Do not collapse this to one lens to save a call; if the change is small enough that
one lens genuinely covers both sides, `spansSkillAndRepo` should not have been set in the
first place — that is a brief-authoring decision, not something the script infers.

## Checkpoints

A Haiku 4.5 `low` agent writes `<runDir>/phases/NN-<alias>.json` after every phase that
actually ran, with an idempotency key `${runId}:${phase}:${attempt}` so a re-run of the same
step does not double-write. One more checkpoint fires at the very end regardless of how the
run finished (clean, dirty at the cap, or a Ground failure) — so `checkpoints.length` always
equals `phaseReport.filter(p => p.ran).length + 1`, the same invariant pipeline.js's own C1
checkpoints hold. A null/declined agent return is **itself a finding**, logged and carried
into the fix pipeline — never treated as "nothing reported, so clean" (a dead fix-brief agent
in particular carries `openFindings` forward unchanged rather than collapsing to `items: []`,
F1). `confirmedByPhase` credits each resolved finding to the phase that **originally raised
it** (Implement, Gate & Review, a prior round's Final pass, ...), never a blanket `'Fix'` or
`'Final pass'` for wherever the fix happened to execute (F4, mirrors pipeline.js's own
`confirmedByPhase`, which keys off each finding's `.phase`).

## Cache warm-up

Before any wave of more than one concurrent agent call (a parallel Build fan-out, the two
review lenses, a parallel Execute fan-out), one lightweight "reply OK" call fires per distinct
`(model, effort)` pair the wave is about to use. Agents launched in the same instant all miss
the prompt cache and each write their own copy — measured, `ROUTING-PLAN.md` §3 — so the wave's
real calls land warm instead.

## Close-out

`node ~/.claude/skills/dev-pipeline/scripts/closeout.mjs <runDir>` — **no `--light` flag
needed**, because `light-loop.js` writes a real `result.json` before it returns (Result, phase
9 above). `--light` remains available for a light loop that lost its agents mid-run and never
reached Result — `closeout.mjs` auto-triggers the same synthesis whenever `<runDir>` has no
`result.json` at all, `--light` only forces reconstruction of one that already exists. There is
no un-ledgered escape either way: a run with no ledger row counts toward no ten-run rule and is
not closed.

## Rules carried over unchanged

- Agent preamble: foreground commands only (`timeout: 600000`); never end a turn with a
  command running; never pipe a gate through `| tail`/`| head`. Docker builds serial, never
  parallel, never in a timed-out wrapper.
- One full `verify` per PR at push (the pre-push hook); scoped suites everywhere else.
- ≤ 4 background agents; ≤ 1 pipeline engine; the local Docker stack is one instance — gate
  runs queue.
- Fix rounds stay Opus-designed, Sonnet-executed (phases 6–7 above) — never let an
  executor improvise a fix the planner did not design.
- `/handoff` before any pause longer than the current turn — a killed or paused session
  cannot be asked for its RESUME card later.

## Learning clause (mandatory, owner ruling 2026-09-10)

Applies to the light loop exactly as to the engine: read the newest `RUN-LOG.md` entries,
`LESSONS-DIGEST.md`, and the ledger `summary` before the brief; measure with `closeout.mjs`
(never estimate); record the RUN-LOG entry + lessons + map entries; act on the ten-run rules
and escalate a 3×-recurring knob candidate to the owner; prove every skill change with its own
check (`light-loop-dry-run.mjs` for this script). Quality is the floor: a light loop that skips
a review lens must say which defects that lens caught in the last ten runs and why this change
cannot have them. Canonical text: [LEARNING-CLAUSE](LEARNING-CLAUSE.md).

## Its check

`node ~/.claude/skills/dev-pipeline/scripts/light-loop-dry-run.mjs` — zero API calls, stubs
`agent()`/`parallel()`/`pipeline()` exactly as `dry-run.mjs` does for pipeline.js. Run it after
ANY edit to `light-loop.js`; `node --check light-loop.js` proves syntax, the dry-run proves the
branches: PHASE/LABEL tagging, PHASE_ORDER-only aliases, checkpoint count, isolation
propagation, the host-contention early return, `maxFixRounds`, and the `result.json` shape
`closeout.mjs` reads.
