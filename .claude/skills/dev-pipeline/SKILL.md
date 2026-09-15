---
name: dev-pipeline
description: >-
  The house development pipeline for ALL non-trivial coding work: understand WHY, specify WHAT,
  derive the design system, plan the TESTS that prove it, then build a task-loop engine that runs each
  task's tests, implementation and one adversarial review in dependsOn-ordered parallel waves. Fable 5.1
  rules only on planning (S1-S5) and the session-side final-pass read — it is never called inside the
  engine to implement, execute, or review; Opus 5 is a peer tier for HIGH-risk judgment calls — the
  reviewer, UI judge, and root-cause call, and the fix designer from round 3 of the fix loop onward;
  Sonnet 5 does every implementer role including HIGH-risk (at higher effort), the test author, the
  routine reviewer, and the fix executor in every round; Haiku 4.5 runs every mechanical step —
  Baseline's gates/manifest, the `task-brief`/`review-pack`/`fix-brief` scripts, the structural/
  behavioral RED check, and per-task checkpoints; every agent at an
  explicit model and effort; every run closes with true telemetry and the learning clause. Use whenever
  the user asks to implement, build, add, refactor, change, design, or spec code or UI — apps, scripts,
  skills, tooling — or asks "why are we building this", for a spec, a UX or design pass, a test plan,
  test-first/TDD work, or says "dev pipeline", "run the pipeline", or "/dev-pipeline". For fixing a KNOWN
  bug, defect, or regression with an observable wrong behavior, use the bug-pipeline skill instead (same
  engine, `mode: 'bugfix'`). Skip only for trivial one-line edits.
---

# Dev pipeline — why → what → design → tests → build → proof

Start with the problem: whose it is, what it costs, what they do instead, what signal says we fixed it. Then define
"complete", derive the design system the repo already has, and specify the tests that prove it. Code comes fifth, and
is not done until a test that **could have failed** — RED before the implementation, mutation-probed after — proves it.

Model and effort policy for every agent in this house lives in the `model-routing` skill; this file states how the
pipeline applies it. The long-form history behind each rule is in [ENGINE-NOTES](references/ENGINE-NOTES.md).

## MODEL POLICY — read before anything else

> **OWNER RULINGS 2026-09-13 ("Fable never implements") + 2026-09-14 (lead: "verdicts on Opus,
> Fable only plans") — CURRENT, AUTHORITATIVE, supersede every conflicting line below and the
> 2026-09-10 "Fable replaces Opus everywhere" ruling.** Fable 5.1 is **not called anywhere inside
> the engine**: it authors the S1–S5 planning artifacts (from a Sonnet-built context pack; Sonnet
> transcribes) and rules on the final-pass candidates, both in the interactive *session* —
> `CFG.models.fable` stays defined only for that session-side use. Inside `pipeline.js` the engine
> routes:
> - **Opus 5** (`claude-opus-5`) — the HIGH-risk task's reviewer (`review:` and the UI judge, at
>   `review: high`), the HIGH-risk `root-cause` call, and the fix DESIGNER from round 3 of the fix
>   loop onward (`fixDesign: high`) — a SEPARATE Sonnet call always executes that design; the old
>   round-4 `executorIsDesigner` collapse into one Opus call is retired (unreachable since
>   2026-09-13 — one model must never both decide and implement). Opus also does the final-pass
>   read once that phase runs. Every Opus call is wrapped by `withToolCap()` (`CFG.caps.toolCalls`
>   = 12) — `fableSafe()` covers these Opus calls too, not only Fable's session-side ones. Opus is
>   a **peer tier** chosen directly for these roles — not "refusal-fallback only". (
>   `CFG.models.fallbackModel`, also `claude-opus-5`, is a leftover refusal-fallback constant for
>   the now-dead `executorIsDesigner` path — that is the one place "fallback" still applies, and it
>   backs a call that never runs.)
> - **Sonnet 5** (`claude-sonnet-5`) — every implementer, including HIGH-risk (`implementHigh:
>   high` effort), the test author, the routine reviewer (`lean` profile: always), the fix EXECUTOR
>   in every round (rounds 1–2 with no designer; round 3+ executing Opus's design), the `ui-verify`
>   driver, the harness-integrity check.
> - **Haiku 4.5** (`claude-haiku-4-5`) — preflight, Baseline's gates/manifest/grounding, the
>   `task-brief`/`review-pack`/`fix-brief` scripts, the red-check, packs, checkpoints, sha reads,
>   probes/checksums.
>
> Where the per-role prose below still says "Fable" for an implementer, reviewer, root-cause,
> fix-designer/executor, or sibling-judge role, or says Opus is fallback-only, it is **historical,
> superseded 2026-09-13/2026-09-14**; trust this callout and `pipeline.js` over it.

**Planning decisions (S1–S5) run ONLY on Fable 5.1. Never Sonnet. Never Haiku. Opus 5 is the fallback solely when
Fable is genuinely unavailable — never a peer choice** (owner policy 2026-08-31, effort and drop rules amended
2026-09-02, gather/transcribe exemption 2026-09-10). Three agents sit inside the planning band without deciding
anything: the S0.5 context pack (Sonnet, read-only), the S5 transcription expansion (Sonnet, from Fable's ruling)
and the S5.5 grounding pass (now folded into the engine's own Baseline phase, Haiku, fact checks). They gather and
transcribe; a decision they cannot find is raised
to Fable, never made.
The plan is the *sole* context every downstream agent gets; a weak planner poisons every later stage, and review
cannot recover a spec that framed the wrong problem.

- Session already **Fable 5.1** ⇒ write S1–S5 **inline** at `high` effort (long artifacts drafted at `xhigh`/`max`
  are written twice — once in thinking, once as the reply). Use `ultrathink` for the one framing decision of
  money/auth/tenancy/schema work, not for the whole session. Otherwise ⇒ one planning subagent per stage with
  `model: 'claude-fable-5-1'`, `effort: 'high'`.
- **Sonnet does not plan. Ever.** What Sonnet receives in S7 — the `tasks[]` graph, each task's brief, files and
  tests — is a *transcription* of Fable's artifacts; a Sonnet agent that finds the plan ambiguous RAISES that as a
  finding and stops at the gap. Never route planning to a cheap model because tokens are tight: cut scope or phases
  instead.
- **Downstream, the engine sets model AND effort per role; nothing inherits the interactive session's effort**
  (12 of 25 agent calls did until 2026-09-02 — a Fable session at `xhigh` ran every lens at `xhigh`). The task-loop
  engine (rebuilt 2026-09-12, `docs/superpowers/plans/2026-09-12-task-loop-rebuild.md`) routes per TASK, not per
  fan-out lens. **Per the 2026-09-13/2026-09-14 owner rulings, Fable 5.1 is not called anywhere inside the
  engine** — see the MODEL POLICY callout above for the live table. In short: **Opus 5** (`claude-opus-5`) is the
  HIGH-risk task's reviewer (`high`) and UI judge, the HIGH-risk `root-cause` call, and the fix DESIGNER from
  round 3 of the fix loop onward, plus the final-pass read once that phase runs. **Sonnet 5** (`claude-sonnet-5`)
  does all in/out — the separate test author (`medium`), every implementer including HIGH-risk (`implementHigh`
  effort), the routine reviewer (`high`), the fix EXECUTOR in every round (`medium`, executing Opus's design from
  round 3 on), the re-reviewer on routine files (`high`) and the `ui-verify` driver (`medium`). **Haiku 4.5**
  (`claude-haiku-4-5`) runs every mechanical step — Baseline's gate/grounding/manifest agents, the three Node
  scripts (`task-brief.mjs`, `review-pack.mjs`, `fix-brief.mjs`), the structural/behavioral RED check, the
  `revert-probe` checksum agents and every checkpoint — all at `low`. Full ids, never aliases; the per-role table
  is `CFG.models`/`CFG.effort` atop [pipeline.js](pipeline.js), the caps `CFG.caps` (token-class ruling 2026-09-10).
- **Opus 5 (`claude-opus-5`) is the judgment-and-design tier for HIGH-risk work (owner rulings 2026-09-13,
  2026-09-14 — supersedes the 2026-09-03 "Fable is the brain, never the hands" framing this bullet used to carry).**
  In the task-loop engine it decides at exactly the HIGH-risk points: the HIGH-risk task's reviewer and UI judge;
  the **fix DESIGNER** from round 3 onward — at round 3+ ONE Opus call designs (over a Haiku-built `fix-brief.mjs`
  brief, ≤ 8 KB, deciding fix / dispute / defer, the design, the invariant and the test per finding) and a
  SEPARATE Sonnet call executes that same design (the old round-4 `executorIsDesigner` collapse into one call is
  retired — unreachable since 2026-09-13, one model must never both decide and implement); and — once Final pass
  lands — the final-pass read on a `major` diff with a HIGH-risk file. Every executor implements the design and
  never improvises (a design that does not fit is reported in `notes` rather than silently reinterpreted). Opus is
  a **peer tier chosen directly** for these roles, not a fallback: `CFG.models.fallbackModel` (also
  `claude-opus-5`) is a leftover refusal-fallback constant that only backs the now-dead `executorIsDesigner` path.
  History: [ENGINE-NOTES](references/ENGINE-NOTES.md).
- **Light loop** (owner ruling 2026-09-03 for bounded work and for finishing runs that lost agents): see [LIGHT-LOOP](references/LIGHT-LOOP.md) — Fable plans and rules, Opus executes HIGH-risk and reviews, Sonnet writes.
- **Fable decides, Sonnet gathers and transcribes — in planning too (owner ruling 2026-09-10).** Measured: the
  orchestrating Fable session held 58–193 KB of planning artifacts plus every source read for 6–14 h, and one such
  session cost $103 in cache reads that no ledger saw. So S1–S5 keep Fable as the only author of *decisions* (the
  problem framing, every `R#`, every `T#` oracle, the hard lines, package boundaries, verification commands), but
  Fable reads a Sonnet-built **context pack** (S0.5) instead of the code map, lessons, fix-cards and sources, and
  a Sonnet `medium` agent **transcribes** Fable's decided `test-plan.md`/`build-plan.md` into the full templates and
  returns a ≤ 1.5K diff brief for Fable to rule on. That is transcription, not planning — "Sonnet does not plan"
  stands; a Sonnet transcriber that finds a decision missing raises it and stops.

## LEARNING CLAUSE — mandatory (owner ruling 2026-09-10)

Every run must leave the next one faster, cheaper, or more accurate, with evidence — quality is the floor:
**read** the newest RUN-LOG entries, `LESSONS-DIGEST.md` and the ledger `summary` before planning and cite
what applies; **measure** with `scripts/closeout.mjs <runDir>` (true cost, active time, cache-hit, findings
per phase — never an estimate); **record** one RUN-LOG entry + a lesson for every surprise + the code-map
entries in the same PR; **act** every ten true-telemetry runs via the ten-run rules, escalating any knob
candidate that recurs in 3+ entries to the owner as a proposal; **prove** every skill/engine change with its
own check and its own RUN-LOG line. Full text: [LEARNING-CLAUSE](references/LEARNING-CLAUSE.md).

## Artifacts

```
.claude/pipeline/<YYYY-MM-DD>-<slug>/context-pack.md discovery.md spec.md ux-spec.md test-plan.md build-plan.md
.claude/pipeline/<YYYY-MM-DD>-<slug>/RESUME.md phases/NN-<phase>.json result.json session-usage.json
.claude/pipeline/design-system.md      # repo-level cache, derived once, reused
.claude/pipeline/cost-ledger.jsonl     # one line per run, appended at S8 by scripts/closeout.mjs (true telemetry)
.claude/handoffs/<date>-<slug>.md      # ≤ 2 KB session card written at S6 approval and by /handoff
```

Templates: [DISCOVERY](templates/DISCOVERY.md) · [SPEC](templates/SPEC.md) · [UX-SPEC](templates/UX-SPEC.md) ·
[TEST-PLAN](templates/TEST-PLAN.md) · [BUILD-PLAN](templates/BUILD-PLAN.md). Each artifact is the **only** context
downstream agents get — write it standalone, never "as discussed". Legacy `.claude/pipeline/plans/<date>-<slug>.md`
maps to `build-plan.md`.

## S0 — Triage (the token gate)

Run `route-task.mjs --json` on the ask (the `UserPromptSubmit` hook already printed `--advise`); its
route and ultracode call are the triage default — override only with a stated reason.

**Route first:** a KNOWN bug/defect/regression (an observable wrong behavior, a bug-registry id, a repro)
belongs to the **bug-pipeline** skill — same engine, `mode: 'bugfix'`, but its own stages (cause refutation,
repro-first tests, radius-scoped review). This pipeline is for new capability, refactors, and hardening.

Classify first, and set a **`ui` flag**: does this change any user-visible surface?

- **Trivial** — one-liner, typo, config value. **Never enters the pipeline.**
- **Small** — 1–2 production files (test files don't count), low blast radius, clear change. `scale: 'small'`.
- **Major** — 3+ files, new feature, refactor, cross-cutting, or risky (auth, money, tenancy, PII, migrations,
  anything irreversible). Full artifacts. `scale: 'major'`.
- **`ui: true`** — any new/changed screen, component, copy or state ⇒ S3 mandatory and `uxSpecPath`/`designSystemPath`
  passed (that pair adds the `design-system` lens). `UI verify` is a separate switch: no `uiVerify` object, no browser
  evidence.
- Escalate on blast radius, not file count. `scale` sets the plan-size cap and, with risk, the profile default.

**Profile** (`args.profile`, `CFG.profiles`, S6): the engine defaults to `lean` (superpowers parity — no separate
test author, the implementer pastes its own RED then GREEN in `report.md`, Baseline runs grounding + existence +
`perRound` once with no `final` check, no probes, the reviewer is always Sonnet regardless of risk, Opus enters
only as the round-3+ fix designer) when `scale: 'small'` **and** no task declares `risk: 'HIGH'` **and** Baseline's
manifest finds no HIGH-risk file; otherwise `standard` (the full task-loop design below — separate test author,
full Baseline, HIGH-risk depth on Opus, probes). Pass `profile: 'lean' | 'standard'` to override either way. The
ledger's scorecard (`pipeline-ledger.mjs summary`) splits by `profile` so a knob change is judged lean-vs-standard,
never pooled.

**Small-scale policy:** no separate `discovery.md`/`spec.md` — a **ten-line preamble** atop `build-plan.md` (problem ·
user · workaround · success signal · non-goals · deploy-day answer). S4 is still required. One merged review agent
(`correctness` + `test-quality`; `design-system` stays its own). No refutation, no mutation probe, and therefore the
red gate keeps its full behavioral bar there.

## S0.5 — Context pack (→ `context-pack.md`, Sonnet `medium`, read-only)

One Sonnet 5 agent at `medium` builds `.claude/pipeline/<run>/context-pack.md`, **≤ 8 KB**, for the area the ask
touches: the relevant `code-map/INDEX.md` rows and the area-file entries they point to (signatures, not bodies); the
lesson ids from `LESSONS-DIGEST.md` that apply, each with its one-line Lesson; excerpts of any `fix-cards/` and prior
run artifacts for the area (paths + the decisive lines); the repo facts a build plan needs (package-manifest scripts,
test runner and config, workspaces, the base sha of the integration branch); the project's `CONTEXT.md` terms it will
use; and an "unknowns" list of what it could not establish. Paths everywhere, content only where a decision hinges on
it. Fable reads the pack — not the sources. Skip the pack only for `small` work whose files the ask already names.

## S1 — Discovery: why (→ `discovery.md`)

**Reuse before re-deriving:** read the context pack (S0.5) — it carries the code map, lessons, fix-cards and prior
artifacts for this area; open a source file only when the pack's "unknowns" say a decision depends on it. Then
state, in the requester's words: the problem and whose it
is (role, frequency, cost); the current workaround and why it fails; why now; **what happens if we ship nothing**; the
one observable success signal with today's baseline; who else is affected; whether the request is a **symptom**; and
whether we are solving the problem or building the solution someone already picked. Answer the strongest objection a
hostile reviewer would raise. Full question set: [ARCHITECT-QUESTIONS](references/ARCHITECT-QUESTIONS.md). **STOP** if
shipping nothing costs little, if the request is a symptom, or if the user, the workaround or the success signal
cannot be stated.

## S2 — Spec: what (→ `spec.md`)

Every requirement gets an `R#`, a priority and a verification method. **Completeness sweep:** the core object's
lifecycle (create, read, list/filter, edit, delete + undo, permissions, audit, notification, export, and the reverse of
every action) and the states every surface must handle (empty, loading, partial, error, offline, unauthorized,
too-much-data, stale, concurrent edit). What you skip goes in **non-goals**. **Deploy-day / entitlement trap** —
always in writing: what happens on deploy day to existing users and data, is a backfill needed, and if the feature is
gated, **which UI or script grants the gate and does it write the exact key the gate reads?** Record the rollback story.

## S3 — UX & design system (UI work only)

**Derive before you design.** Extract what the codebase already has — theme config, CSS custom properties, the
component directory and variants, spacing/type/radius/shadow scales, icons, motion, existing empty/loading/error
patterns, the a11y baseline — and cache it at `.claude/pipeline/design-system.md`. Route via
[DESIGN-ROUTING](references/DESIGN-ROUTING.md). Never invent a token the repo has; every surface ships the full state
set; a11y is a requirement; the visual result is verified with a Playwright screenshot, never from source.

## S4 — Test plan: how we'll know (→ `test-plan.md`)

**No requirement without a test, no test without a requirement.** Every `R#` maps to ≥1 `T#`; every `T#` names its
`R#`, a level (unit / property / contract / integration / e2e), Given/When/Then, and an **oracle** — the expected
value known *independently* of the implementation, stated **concretely** (a number, a status, a row) so the test fails
on *its own* value before implementation, not merely on a stub's `undefined`. Prefer the lowest level that can fail
for the right reason. Method, anti-vacuity rules and Playwright house rules: [TESTING-PLAYBOOK](references/TESTING-PLAYBOOK.md).

## S5 — Build plan: how (→ `build-plan.md`)

1. **Self-contained** — subagents see only these artifacts, never the conversation.
2. **Disjoint work packages** by file ownership; shared file ⇒ `dependsOn`, never a fake overlap. A `dependsOn` that
   names no package, or a cycle, is a `(build-plan)` blocker. Test and implementation packages resolve `dependsOn`
   in ONE namespace now — the engine's `tasks[]` graph (S7) has no separate test/implementation id space; each task
   owns both its `tests[]` and its `files[]`. Size packages so no wave has a single long-pole package.
3. **Every package declares `satisfies:` (R#s) and `provenBy:` (T#s)**, with **exact code for the tricky parts** — 20
   hard lines from the planner beat Sonnet guessing. Per-package `effort` is omitted (= `medium`) except `high` for the
   money/tenancy/auth package; `model` upgrades only the one risky package.
4. **Real, tiered verification commands:** `perRound` = typecheck/lint scoped to the touched workspaces; `final` = the
   full suite once. Scope them to what this change can affect — a repo-wide gate that needs state a fresh worktree
   lacks fails at Baseline, is excluded as a broken command, and leaves the run with no gate at all.
5. **Never put a post-deploy test in a task's `tests[]`**, and keep regression pins out of the red-gate scope — the
   red gate's whole job is that every test in scope fails.
6. Pass `lessonsPath` (the project's `.claude/lessons/LESSONS.md`), `startedAt` (an ISO timestamp taken at launch)
   and `runDir` (the run's absolute artifact directory — enables per-phase checkpoints and the `result.json` summary).
7. **Transcription split (2026-09-10):** Fable writes the decisions of S4 and S5 — the `R#`→`T#` matrix with each
   oracle's concrete value, the package boundaries with file ownership, the hard lines, the tiered commands — as a
   compact ruling (≤ 12 KB across both). A Sonnet `medium` agent expands that ruling into the full
   [TEST-PLAN](templates/TEST-PLAN.md) / [BUILD-PLAN](templates/BUILD-PLAN.md) templates (Given/When/Then wording,
   package boilerplate, the `## Pipeline args` block) and returns a ≤ 1.5K brief: what it filled, what it could not
   decide (raised, never guessed). Fable rules on the brief; it does not re-read the expanded files.

## S5.5 — Grounding pass

Grounding is Baseline's first step now: the engine's own Baseline phase (S7) opens the run with the manifest/
existence/digest check that used to be this separate pre-approval pass — there is nothing to author here anymore.

## S6 — Approval

**Major, UI or destructive** work: show the discovery summary, requirement list, non-goals and coverage matrix before
executing — unless the user already said proceed or the session is autonomous. Small: proceed. Never auto-proceed on
anything destructive or outward-facing.

**Handoff before launch (2026-09-10):** approval writes `.claude/handoffs/<date>-<slug>.md` (the `/handoff` card:
run dir, branch, base sha, args path, decisions, open owner questions) and then `/compact` — or a fresh session for a
`major` run. The engine needs only artifact paths; the planning context has no further use in the session and every
later turn re-reads it.

## S7 — Execute (`pipeline.js` via the Workflow tool)

Launch rules (the long form of each, with the incidents behind it, is in [ENGINE-NOTES](references/ENGINE-NOTES.md)):

- **Fresh branch off the integration target, clean tree.** Baseline records the tree exactly as you leave it —
  unrelated uncommitted work becomes "the baseline" and is reviewed as yours.
- **A worktree needs its own hook install and its own `node_modules`** before the first commit or the first check —
  otherwise git runs no hooks there, and nested dependencies are structurally invisible (a green typecheck in a fresh
  worktree is a cache hit, not evidence).
- **Regenerate generated clients** (`npx prisma generate` and kin) in a fresh worktree or after a rebase across a
  schema change — otherwise typecheck and tests fail at Baseline and are excluded as broken commands.
- **Pass artifact PATHS, never content**; pass the absolute path of the `pipeline.js` next to this SKILL.md; pass the
  args as a real object, never a JSON string. Note the launch time for `startedAt`.
- **Stage the engine inside the repo before launching.** The Workflow tool accepts script paths only inside the
  working directory, so copy `~/.claude/skills/dev-pipeline/pipeline.js` to the repo's gitignored
  `local-assets/tooling/pipeline-<version>.js` and pass THAT path — a new file per engine version, never overwriting
  the copy a live or resumable run depends on (its RESUME card names it).
- **`scriptsDir` still points at the REAL skill directory, not the staged copy.** Only `pipeline.js` itself gets
  staged into `local-assets/tooling/` per the bullet above — the helper scripts (`task-brief.mjs`,
  `review-pack.mjs`, `fix-brief.mjs`) are never copied there. Pass `args.scriptsDir` as the absolute path to
  `~/.claude/skills/dev-pipeline/scripts`, not a same-named folder next to the staged `pipeline-<version>.js` —
  that sibling scripts folder doesn't exist.
- **Write the RESUME card at launch** (`.claude/pipeline/<run>/RESUME.md`: runId, persisted scriptPath, the exact args)
  — a killed session cannot be asked for them later.

```js
{
  buildPlanPath: '.claude/pipeline/<run>/build-plan.md',   // REQUIRED in practice — task-brief.mjs/review-pack.mjs read it
  scriptsDir: 'C:/Users/<user>/.claude/skills/dev-pipeline/scripts',   // REQUIRED in practice — absolute path to
  // dev-pipeline's OWN scripts dir; this sandboxed engine has no os.homedir()/process.env to derive it itself, so
  // task-brief.mjs/review-pack.mjs/fix-brief.mjs are unbuildable without it. The REAL skill directory, never the
  // staged pipeline-<version>.js copy's (nonexistent) sibling scripts folder — see the staging bullet above.
  testPlanPath: '.claude/pipeline/<run>/test-plan.md',     // optional — cited in review-pack.mjs's Test-plan excerpt
  lessonsPath: '.claude/lessons/LESSONS.md',   // every implementer, reviewer and fixer carry it; omit only when the project has none
  startedAt: '<ISO timestamp taken at launch>',  // echoed into the result for the ledger
  runDir: '.claude/pipeline/<run>',   // per-task artifacts + checkpoints land under here (C1-style)
  scale: 'small' | 'major',   // default 'small' — sets the plan-size cap and, with risk, the profile default
  mode: 'feature' | 'bugfix',   // default 'feature'; 'bugfix' turns on Baseline's harness-integrity read and the post-loop sibling sweep
  profile: 'lean' | 'standard',   // optional override; default per S0/S6 (small + no HIGH risk -> lean, else standard)
  workdir: '', context: '',   // optional worktree + one line of task context
  baselineSha: '',   // optional — review-pack.mjs's diff base; default 'worktree' (diff against HEAD)
  siblingPatterns: [ { pattern: '<git grep -n -E pattern>', note: '<why this pattern matches the bug class>' } ],
  // ^ mode:'bugfix' only — an ENGINE step run once after every fix task's loop closes, never a task type.

  // ---- the task graph (REQUIRED, non-empty) — replaces the legacy testPackages/packages/redGate args with ONE array ----
  tasks: [
    {
      id: 'T1', title: '<title>', type: 'feature',   // type: feature (default) | root-cause | repro-test | fix | revert-probe | docs | ui-verify
      files: ['<path/a>', '<path/b>'],       // exact repo-relative paths this task owns
      tests: ['<test file path (name the T# it proves in brief)>'],
      // NO agent reads a `brief:` string. Every agent reads <runDir>/tasks/<id>/brief.md, which task-brief.mjs
      // slices from this task's `### <id> — <title>` heading in build-plan.md. Write the brief (what to do, the
      // R#/T# it satisfies/proves, exact code for the tricky parts) UNDER THAT HEADING. CFG.caps.briefBytes is
      // declared but not enforced. The engine scans an inline `brief` only for the INTRODUCES-OBSERVABLE
      // token; prefer `introducesObservable: true` instead.
      dependsOn: [],                          // the ONLY ordering mechanism; disjoint-file tasks in the same wave run in parallel
      risk: 'HIGH',                           // optional; explicit risk always wins over Baseline's classifier
      radius: [5, 10],                        // optional — [before, after] context lines; review-pack.mjs --radius 5,10 excerpts that window
                                              // around each call-site hit. Never paths (a path is a usage error, exit 2). Omit = no Radius flag.
    },
    { id: 'T2', title: '<title>', type: 'feature', files: ['<path/c>'], tests: ['<test file path>'], brief: '<...>', dependsOn: ['T1'] },

    // A bugfix chain: every `fix` must depend (directly or transitively) on a `root-cause` AND a `repro-test`, and
    // every `revert-probe` must depend on its `fix` -- an unmet ancestor is a `(build-plan)` blocker before any
    // agent runs (validateTasks).
    { id: 'RC1', title: '<confirm the cause>', type: 'root-cause', files: [], tests: [], dependsOn: [],
      brief: '<reproduce the bug on the current tree and confirm the named cause with the smallest probe>' },
    { id: 'RT1', title: '<repro test>', type: 'repro-test', files: [], tests: ['<repro spec path>'], dependsOn: ['RC1'],
      brief: '<must fail on the bug\'s own wrong value -- name the exact wrongValue the RED check greps for>' },
    { id: 'FIX1', title: '<the fix>', type: 'fix', files: ['<path>'], tests: [], dependsOn: ['RC1', 'RT1'],
      brief: '<the minimal correct change; a fix task has no tests of its own>' },
    // revert-probe takes SINGULAR `file` (the fix file to revert) and `test` (the ONE test command that must go RED
    // reverted) -- the probe prompt and checksum:after read only t.file / t.test; `files`/`tests` arrays are ignored.
    { id: 'RP1', title: '<revert probe>', type: 'revert-probe', file: '<path>', test: '<the one test command>', dependsOn: ['FIX1'] },

    // A `ui-verify` task (D6) carries its own driver config on the task record.
    { id: 'UI1', title: '<verify the flow>', type: 'ui-verify', files: [], tests: [], dependsOn: ['T2'],
      url: '<url>', startCommand: '<command or empty; whatever it starts, it must stop>',
      flows: ['<plain-language flow + its assertion>'], viewports: ['desktop'],
      checks: ['console-errors', 'network-failures', 'a11y', 'design-system'],
      brief: '<what this flow must do>' },
  ],

  // ---- gates: every command must already exist in this repo ----
  verifyCommands: { perRound: ['<scoped typecheck/lint>'], final: ['<full suite>'] },
  // perRound runs scoped after each task's implement/fix round; final runs once, at Final, deciding the result.

  // The exact formatter command for THIS repo; omit it and each agent looks up the repo's own (or skips when none).
  formatCommand: '<e.g. npm run format>',
}
```

Every arg is optional except `buildPlanPath`, `scriptsDir`, and a non-empty `tasks[]`; `validateTasks` blocks the
run before any agent call on a structurally invalid graph (unknown `type`, a `fix` missing its
`root-cause`/`repro-test` ancestor, a `revert-probe` missing its `fix`, or two tasks sharing a file with no
`dependsOn` path between them). A missing `scriptsDir` isn't caught there — it's not part of the task graph — it
instead hard-blocks each task individually the moment its `(brief)`/`(pack)` stage tries to build an unbuildable
`scriptCmd()` call.
After S4, make sure every task's `tests[]` is populated and check `status`/`review` on every task you expected the
reviewer to visit — a task the wave loop never reached still reports `pending`, which is not evidence of anything.

### The task loop — what each phase proves, and what it costs

Tasks run from `args.tasks[]` in `dependsOn`-ordered parallel waves (disjoint-file tasks in the same wave run
concurrently, `buildWaves`); each task's own chain is *pipelined* (the `pipeline()` primitive) so its later stages
start as soon as its own agents finish, not the whole wave.

| Phase | Agents (model @ effort) | Proves |
|---|---|---|
| Baseline | 3 × Haiku @ low, concurrent (+ Sonnet @ low harness-integrity read, non-blocking, when `mode:'bugfix'`) | which verify commands work at all (a failure here = broken COMMAND, excluded from every gate); every mechanically checkable artifact claim; per-file HIGH/LOW risk (`tasks[].risk` always wins over the classifier — unknown/unreadable is HIGH); per planned file `exists:true\|false` plus a `git hash-object` digest, so a file the plan EDITS is never mistaken for one it CREATES; the plan-size cap by `scale` |
| Per task — brief | Haiku @ low runs `node "<scriptsDir>/task-brief.mjs" --plan <buildPlanPath> --task <id> --out <runDir>/tasks/<id>/brief.md` | the task's own `brief.md` — a fence-aware, heading-sliced excerpt of the build plan, capped |
| Per task — Author tests (`standard` profile) | Sonnet @ medium writes exactly `t.tests`, no implementation | the tests exist, and the RED run is captured verbatim in `tests-report.md`; skipped in `lean` — the implementer pastes its own RED then GREEN in `report.md` instead |
| Per task — Red gate | Haiku @ low structural check: every named test failed on an assertion, none errored/skipped/passed; ONE Sonnet remediation attempt on failure, else a `(red-gate)` blocker; BEHAVIORAL on a `repro-test` task (the failure output must contain the brief's named `wrongValue`) | the tests can actually fail before anything is made to pass |
| Per task — Implement | Sonnet @ medium (`implementHigh` = `high` effort, still Sonnet, when the task or any file it owns is HIGH risk) | `t.tests` go GREEN, `verifyCommands.perRound` passes scoped to this task, deviations from the brief are reported in `report.md` |
| Per task — pack | Haiku @ low runs `node "<scriptsDir>/review-pack.mjs" --plan <buildPlanPath> --files <files> --base <base> --cap <packBytes> --out <runDir>/tasks/<id>/pack.md` (sections in order: Spec excerpt, Diff, Call sites, Radius, Test-plan excerpt, Lessons cited; capped `CFG.caps.packBytes` = 40 KB) | the reviewer's whole evidence base in one artifact — it opens no other file unless a hunk in the pack cites it |
| Per task — review | ONE adversarial reviewer: Sonnet @ high (`lean`: always; `standard`: routine files) or Opus @ high (`standard`, HIGH-risk task) | `specCompliance`, `findings[]` (`critical\|important\|minor`), `assessment` — spec compliance vs this task's R#/T#, code quality, test quality (real behavior, not mocks), correctness; only `critical`/`important` block, `minor` is a progress-line only |
| Per task — fix loop (`CFG.maxFixRounds` = 4) | r1–r2: Sonnet @ medium executes, no separate designer; r3+: ONE Opus @ high call designs from a Haiku-built `fix-brief.mjs` brief (≤ 8 KB), then a SEPARATE Sonnet @ medium call executes that design (the old round-4 collapse into one designer-and-executor call is retired, unreachable since 2026-09-13 — one model never both decides and implements); re-review after every round (Sonnet @ high routine / Opus @ high HIGH-risk) scoped to the fix diff only | confirmed findings resolved to a design, never an executor's improvisation; a round of nothing but a design that doesn't fit is reported in `notes`, not silently reinterpreted; hitting the cap writes a `Ruling: <decision> — <why> — <cost if wrong>`, leaves the task `open`, and keeps `clean:false` |
| Bugfix task types (`root-cause` / `repro-test` / `fix` / `revert-probe`) | `root-cause`: Sonnet @ high (Opus @ high, HIGH-risk) reproduces the bug and confirms the brief's named cause; `repro-test`: test-author only, behavioral RED; `fix`: implement → pack → review, no tests of its own; `revert-probe`: Haiku backs the file up outside the repo, `git show HEAD:<file> > <file>`, runs ONLY `t.test` (must fail on assertion), restores, and ONE separate Haiku checksum agent verifies the restore against Baseline's digests — strictly sequential across probes | a `fix` never starts unless its `root-cause` reports `reproduced && causeConfirmed` (else a Ruling and that chain stops); the repro test fails on the bug's own wrong value, not merely "some" red; every reverted file is provably a defect and provably restored |
| `ui-verify` task type (D6) | Sonnet @ medium drives (writes and runs the Playwright spec, owns and stops `startCommand`, captures screenshots/console/network/a11y per flow × viewport as facts) → the task's own reviewer judges the evidence (Sonnet @ high routine, Opus @ high HIGH-risk) | flows, console, network, a11y and design-system fidelity per viewport; a blocked or undriven flow is a blocker; re-runs after any fix round whose files intersect `t.files` |
| Post-loop sibling sweep (`mode:'bugfix'`, an ENGINE step, not a task type) | Haiku @ low `git grep -n -E` over `args.siblingPatterns` → judge (Sonnet @ high, Opus @ high on a HIGH-risk task) classifies each hit `defect \| same-class-but-guarded \| unrelated` | every place the same bug class could recur; each `defect` hit becomes an owner question in `remainingFindings` (source `sibling-sweep`), never silently dropped |
| Final | Haiku @ low runs `verifyCommands.final` beside an Opus @ high final-pass read when any task is HIGH risk (Opus is chosen directly for this read, not as a fallback; skipped and recorded when no task is HIGH risk) | the full suite once, deciding `clean`; what every per-task reviewer and fix loop missed on the HIGH-risk files |

The old ten-phase names (`Verify`, `Mutation probe`) stay in `meta.phases` for ledger/telemetry compatibility, but
the task-loop engine has no separate fan-out for them: refutation voting is gone (folded into the one reviewer per
task above), and mutation probing is the `revert-probe` task type. `result.verify`/`result.mutationProbe` are the
revert-probe outcome, not a five-agent slate.

### Model table (S3) — who does what, and why

- **Risk sets DEPTH, never COVERAGE.** HIGH means the CHANGE (the diff hunks, or the intended change for a file
  that does not exist yet) touches money/tax/pricing math, auth/permissions/session, tenancy/ownership scoping,
  migrations/schema, PII, or payments — never merely that the file lives in such a module; config strings,
  allow-lists, labels, docs and code-map edits are LOW even inside a finance/admin module. Unknown or unreadable is
  HIGH. `tasks[].risk` explicit always wins over Baseline's classifier, file by file.
- **Opus 5** = the HIGH-risk task's reviewer (`high`) and UI judge; the **fix designer** from round 3 of the fix
  loop onward — round 3+ is a design call (over a Haiku-built brief) followed by a SEPARATE Sonnet execute call
  (the old round-4 collapse of designer+executor into one call is retired, unreachable since 2026-09-13 — Opus
  never also executes); the root-cause call on a HIGH-risk bugfix task; the Final-pass read once that phase lands.
  **Sonnet 5** = every implementer including HIGH-risk (`implementHigh` effort), the separate test author
  (`medium`), the routine reviewer (`high`), the fix executor in EVERY round (`medium`), the re-reviewer on
  routine files (`high`), the `ui-verify` driver (`medium`). **Haiku 4.5** = every Baseline gate/grounding/manifest
  agent, all three Node scripts (`task-brief.mjs`, `review-pack.mjs`, `fix-brief.mjs`), the structural/behavioral
  RED check, the `revert-probe` checksum agent, and every checkpoint — all `low`. **Fable 5.1 is not called inside
  the engine at all** (owner rulings 2026-09-13, 2026-09-14) — it stays session-side for S1–S5 planning and the
  session's own final-pass rulings; `CFG.models.fable` is defined only for that use. `CFG.models`/`CFG.effort` hold
  the table; `CFG.caps.toolCalls` (12) caps every Opus call via `withToolCap()`.
- **`lean` vs `standard` profile** (`CFG.profiles`, S6, `args.profile` override): `lean` = superpowers parity — no
  separate test author (the implementer pastes its own RED then GREEN in `report.md`), Baseline skips the `final`
  verify check, no probes, the reviewer is always Sonnet regardless of risk, Opus enters only as the round-3+ fix
  designer. `standard` = every row above as written. Default: `lean` when `scale: 'small'` and no task/manifest
  file is HIGH risk; else `standard`. The ledger's `profile` column (`pipeline-ledger.mjs summary`) splits the
  routing scorecard by profile so a knob change is judged lean-vs-standard-vs-the-previous-ten, never pooled.
- **Cache.** No cross-model transfer exists — caches are model-scoped — so `warmUp`/`warmUpWave` fires one
  lightweight call per (model, effort) pair before a wave that shares it. Every prompt opens with the same
  `RUN_PREFIX()` (repo note, lessons register, the grounded-claims instruction, scratch/scope/batch notes), then
  the `PHASE: <phase> · LABEL: <label>` tag (the middle dot is a literal U+00B7 at runtime —
  `model-routing/scripts/session-usage.mjs` attributes tokens per phase by matching it), then the role.
- **Opus designs, Sonnet executes** (`CFG.maxFixRounds`: 4): from round 3, one Opus decision per round over that
  task's still-open findings; the Sonnet executor implements the design, never improvises — a design that does not
  fit the code comes back in the executor's `notes` rather than being silently reinterpreted. Only
  `critical`/`important` findings enter the loop at all; `minor` is a `progress.md` line, never a fix round.
  Hitting the round cap writes `Ruling: <decision> — <why> — <cost if wrong>` into `rulings[]` and leaves that task
  `open`, `clean:false`.
- **Bugfix-only cost**: the harness-integrity read (Baseline, `mode:'bugfix'`) and the post-loop sibling sweep are
  ENGINE steps, not extra task types — they run once per plan, not once per task, and never block (`harnessCheck`
  and `sibling-sweep` hits both surface as findings/owner-questions, never a red run).
- **Final pass only where its rationale holds**: no HIGH-risk task, no Opus read; `finalPass.skipped` says so.

### Speed

- Verify and UI verify run beside each other; the final full gate runs beside the final pass; the mutation probe
  (which mutates files) always runs alone. Overlapped phases share one token bracket — the secondary reports
  `tokens: null` and `overlappedWith`, never a guessed split.
- Tiered gates by default: `perRound` cheap every round, `final` once, deciding `clean`.
- Lower effort is shorter turns; lazy refutation halves Verify's agents; the structural red bar removes a remediation
  round on most major runs; no phase re-runs a suite a cache would replay (gates force execution and report `executed`).
- `CFG.overlapImplementWithRedAudit` (off, measured): implementation wave 1 beside the red audit; judge it from
  `overlap.redAuditWithImplement` in the ledger before defaulting it on.

### Measured trades — both OFF, both unproven

`CFG.cascadeReview` (Sonnet on the LOW-risk partition, audited by `cascadeAudit.missedFindings`) and
`CFG.densityEscalation` (skip non-floor lenses on a tiny green diff, audited by `escalation.lensesSkipped`) stay off
until the ledger holds ten runs that justify them. The floor holds at any setting: `correctness` and `test-quality`
cover every changed file; a dead agent is never success. Detail: [ENGINE-NOTES](references/ENGINE-NOTES.md).

### Reading the result

`clean` = no remaining `blocker`/`major` findings ∧ Baseline gate ok (baseline-filtered) ∧ every entry in `tasks[]`
is `complete` (never `open` or `blocked`) ∧ every `revert-probe` caught its mutant with the restore verified,
when any ran ∧ no `ui-verify` flow left `blocked`. A skipped phase is neutral; an *unverified* one is not. Report
the one-shot oracles separately: `baseline.badCommands`/`baseline.gate`, `manifest` (per-file `exists`/`digest`/
`risk`), `harnessCheck` (`mode:'bugfix'` only), each task's own `redRun`/`redAudit` (`structurallyRed`, or
`behaviorallyRed` on a `repro-test`), `review` (`specCompliance`, `findings[]`, `assessment`), `mutationProbe`
(the `revert-probe` outcomes: `allCaught`/`restoredVerified`/`skipped`/`baselineDisturbed`), `uiVerify.ran/
reVerify/evidence` (from the `ui-verify` task, when the plan has one), `siblingSweep` (`mode:'bugfix'` only,
`ran/supplied/patterns/hits/findings/skipped`), `finalPass.ran/skipped/model/completed`, `riskSummary`,
`estimatedCostUsd` (output-only, at `pricesAsOf`), `phaseReport[]` (tokens, `estUsd`, effort, `overlappedWith`,
`note`). Legacy fields with no task-loop equivalent (`overlap`, `cascadeAudit`, `escalation`, `redGate.attempts`
as a run-wide count) are nulled with a `note`, never silently dropped.

**NEW in the task-loop result** (S5): `tasks[]` — one entry per task, `{id, type, status ('complete'|'open'|
'blocked'), rounds, reviewVerdict, reportPath}` — walk this before anything else; a `status:'open'` task hit the
fix-round cap with confirmed findings still unresolved, and a `blocked` one never got past its own red gate or a
`fix`'s missing `root-cause`/`repro-test` ancestor. `rulings[]` — every `Ruling: <decision> — <why> — <cost if
wrong>` the run made (a fix-round cap, a `root-cause` that never confirmed, a deferred finding) — a ruling is a
decision a person should see, never a silent discard; walk every entry, not just the count. `profile` —
`'lean'|'standard'`, which routing table actually ran (S6); the ledger's scorecard groups by it, so a lean run
and a standard run are never averaged together.

**Resuming:** the Workflow *tool result* carries the `runId` and persisted `scriptPath`; with the exact `args` (not
stored) they are the whole resume key — that is why the RESUME card is written at launch. On resume trust the
resumed run's own `phaseReport`, never WIP diffs in the tree. A killed run's hand-run gates are evidence about the
checks that ran, never about the review that did not. `ckSeq` restarts at 0 on a resumed run, so a replay with a
different fix-round count can leave two differently-numbered card sets under `phases/` — on a resumed run, trust the
newest card by mtime, not by its `NN` sequence number.

**C1 checkpoints (`args.runDir`):** pass the same directory the RESUME card lives in (`.claude/pipeline/<run>/`) and a
Haiku @ low agent writes one card per phase to `<runDir>/phases/<NN>-<phase-slug>.json` — the phase's own
`phaseReport` row, the running totals so far, findings by severity, and one-line (never `detail`-length) finding
summaries — right after that phase's `endPhase()`. At the first green `Gate & Review`, one of those cards also makes
the run's one snapshot commit (`wip(pipeline): <run-slug> checkpoint <phase>`, refused on `main`/`master`, never
pushed). At run end one more card writes `<runDir>/result.json`: the full result minus `confirmedFindings`,
`fixReports`, `phaseReport[].note` bodies, `uiVerify.evidence` and `mutationProbe.results` (those stay in the phase
files), capped at `CFG.checkpoint.maxSummaryKb`, plus the list of phase files already written. Every attempt — written
or not — lands in `result.checkpoints[]`; a dead or malformed checkpoint agent is logged there and never fails the
run. Omit `runDir` for the exact legacy behavior (zero extra agents, byte-identical prompts otherwise).

## S8 — Close out

1. **Walk the coverage matrix out loud** — every `R#` → its `T#`s → the actual result; a requirement whose proof is
   missing is *unproven*, not done. Quote the gate, red-gate and mutation-probe results: a cached replay is not evidence.
2. **One command does the rest:**
   `node ~/.claude/skills/dev-pipeline/scripts/closeout.mjs <run dir> [--project <dir>] [--session <id>|--latest] [--branch <name>] [--pr <n>]`
   — resolves mode/scale/startedAt/runId from `result.json` (falling back to `RESUME.md`/`pipeline-args.json`),
   runs `session-usage.mjs` for true telemetry (falls back to `--telemetry legacy` when no session is found),
   appends the ledger row (`pipeline-ledger.mjs append`, with `--usage` when telemetry was found), inserts a
   RUN-LOG.md stub (Caught/Wasted pre-filled from `confirmedByPhase` and the result's own fields; Knob candidate
   and Deviation left `TODO` for you), inserts a LESSONS.md stub on bugfix runs (bumps `_meta.json.nextId`, body
   left `TODO`), prints — never edits — a `code-map: TODO entry for <path>` line for every touched file with no
   existing map entry, and writes a `.claude/handoffs/<date>-<slug>.md` card. Idempotent by run slug: re-running
   it after a partial close-out only fills the gaps, never duplicates a row/entry. `--dry` previews every write
   as a diff and writes nothing — run it first on an unfamiliar run. `node closeout.mjs selftest` self-checks the
   script in a throwaway temp project.
3. **`/closeout` is this same script**, not a second mechanism — the command walks the MANUAL items below
   for you; run either, never both. **MANUAL, every time — the script cannot do these, and its own printed checklist names them so:** set the
   Status line on every artifact (IMPLEMENTED / CLOSED); write the RUN-LOG entry's real Knob candidate (with
   ledger evidence) and Deviation lines; write the LESSONS entry's Symptom/Root cause/Lesson/Guard body on
   bugfix runs; reconcile the printed code-map TODOs into the real `.claude/code-map/` area files. Then report
   what shipped, what proved it, what remains.
4. **If the close-out claims the change landed, compare CONTENT, never ancestry** (`git diff <target> -- <files>`
   empty), never `--merged` or commit ancestry.

## Token & performance rules

Pass paths, never content; trivial work never enters the workflow; small work gets the ten-line preamble (never skip
S4). Derive `design-system.md` once per repo; batch related asks into one run; iterate with `resumeFromRunId`. Keep
the interactive session on Fable 5.1 at `high` and let subagents carry the volume at their own explicit efforts. Caps:
`maxConcurrent` 16 inside a run (the house cap of **four background agents** still binds the orchestrating session),
`maxFixRounds` 2, `maxTestRemediationRounds` 1, `budgetFloor` 30k.

## Tuning — where to change what

| Change | Edit |
|---|---|
| Models, every effort ceiling, lazy voting, the red-gate bar, final-pass skip, prices, refute gate, fix rounds, the measured-trade flags | `CFG` atop [pipeline.js](pipeline.js) |
| Triage thresholds, small-scale policy, approval, stage order, close-out | this file |
| The routing ladder itself, Fable prompting, the ledger and the ten-run rules | the `model-routing` skill |
| The architect question set and its stop conditions | [references/ARCHITECT-QUESTIONS.md](references/ARCHITECT-QUESTIONS.md) |
| Test method, anti-vacuity rules, Playwright rules, mutation probe | [references/TESTING-PLAYBOOK.md](references/TESTING-PLAYBOOK.md) |
| Which design skill handles which need | [references/DESIGN-ROUTING.md](references/DESIGN-ROUTING.md) |
| The incidents and long-form cautions behind the rules above | [references/ENGINE-NOTES.md](references/ENGINE-NOTES.md) |
| The zero-token branch check to run after any engine edit | [scripts/dry-run.mjs](scripts/dry-run.mjs) |
| Artifact structure | the matching file in [templates/](templates/) |

Canonical install is user-level (`~/.claude/skills/dev-pipeline/`); edits take effect on the next invocation. For one
repo's own variant, copy this folder into its `.claude/skills/dev-pipeline/`.

### Checking `pipeline.js` after an edit — syntax, then the dry run

`pipeline.js` is a **Workflow-tool script**, not a Node module: `export const meta` comes first and is a pure literal,
the body ends in a top-level `return`, and only `agent`, `parallel`, `pipeline`, `log`, `phase`, `args`, `budget`,
`workflow` exist as globals (no `require`/`import`, no fs, no `Date.now()`, no `Math.random()`). A bare `node --check
pipeline.js` reports `Illegal return statement` — expected, not a defect. Reproduce the runtime's wrapper first:

```bash
{ echo '(async () => {'; sed 's/^export const meta = {/const meta = {/' pipeline.js; echo '})()'; } \
  > /tmp/check-pipeline.mjs && node --check /tmp/check-pipeline.mjs && echo "SYNTAX OK"
```

Syntax proves nothing about the branches. `scripts/dry-run.mjs` executes the whole engine with stubbed Workflow
globals and canned agent answers — zero API calls — and asserts the promises above: an explicit full model id and
effort on every call, `xhigh` lenses only with HIGH-risk files, the structural red bar (and the behavioral bar on
small), the lazy slate and the Fable tie-break, Verify beside UI verify, the final pass skipped on a no-HIGH diff and
falling back to Opus when Fable declines, the hollow-gate rule, and the pricing fields. Run it after **every** edit:

```bash
node scripts/dry-run.mjs          # add --calls to print every agent call with its model and effort
```

Then run the three scripts' own selftests plus the light-loop dry run in one shot:

```bash
node scripts/selftest-all.mjs     # dry-run.mjs + light-loop-dry-run.mjs + task-brief/review-pack/fix-brief --selftest; one PASS/FAIL line each, exit 1 on any failure
```
