---
name: dev-pipeline
description: >-
  The house development pipeline for ALL non-trivial coding work: understand WHY, specify WHAT,
  derive the design system, plan the TESTS that prove it, then build. Fable 5.1 rules over its cache
  (discovery/spec decisions, fix designs, tie-breaks) from Sonnet-built packs; Sonnet 5 does all in/out —
  packs, tests, code, probes, pattern lenses and routine verdicts; Opus 5 gives the verdicts the difficulty
  earns — the correctness lens, deep lenses and refutation on HIGH-risk files, the red-gate audit, the
  final-pass read, HIGH-risk fixes — over a ≤ 40 KB pack with a 12-tool-call cap; Haiku runs gates,
  grounding and per-phase checkpoints; every agent at an explicit model and effort; every run closes with
  true telemetry and the learning clause. Use whenever the user asks to implement, build,
  add, refactor, change, design, or spec code or UI — apps, scripts, skills, tooling — or asks "why
  are we building this", for a spec, a UX or design pass, a test plan, test-first/TDD work, or says "dev
  pipeline", "run the pipeline", or "/dev-pipeline". For fixing a KNOWN bug, defect, or regression with an
  observable wrong behavior, use the bug-pipeline skill instead (same engine, `mode: 'bugfix'`). Skip only
  for trivial one-line edits.
---

# Dev pipeline — why → what → design → tests → build → proof

Start with the problem: whose it is, what it costs, what they do instead, what signal says we fixed it. Then define
"complete", derive the design system the repo already has, and specify the tests that prove it. Code comes fifth, and
is not done until a test that **could have failed** — RED before the implementation, mutation-probed after — proves it.

Model and effort policy for every agent in this house lives in the `model-routing` skill; this file states how the
pipeline applies it. The long-form history behind each rule is in [ENGINE-NOTES](references/ENGINE-NOTES.md).

## MODEL POLICY — read before anything else

**Planning decisions (S1–S5) run ONLY on Fable 5.1. Never Sonnet. Never Haiku. Opus 5 is the fallback solely when
Fable is genuinely unavailable — never a peer choice** (owner policy 2026-08-31, effort and drop rules amended
2026-09-02, gather/transcribe exemption 2026-09-10). Three agents sit inside the planning band without deciding
anything: the S0.5 context pack (Sonnet, read-only), the S5 transcription expansion (Sonnet, from Fable's ruling)
and the S5.5 grounding pass (Haiku, fact checks). They gather and transcribe; a decision they cannot find is raised
to Fable, never made.
The plan is the _sole_ context every downstream agent gets; a weak planner poisons every later stage, and review
cannot recover a spec that framed the wrong problem.

- Session already **Fable 5.1** ⇒ write S1–S5 **inline** at `high` effort (long artifacts drafted at `xhigh`/`max`
  are written twice — once in thinking, once as the reply). Use `ultrathink` for the one framing decision of
  money/auth/tenancy/schema work, not for the whole session. Otherwise ⇒ one planning subagent per stage with
  `model: 'claude-fable-5-1'`, `effort: 'high'`.
- **Sonnet does not plan. Ever.** What Sonnet receives in S7 — test packages, the red-gate contract, work packages —
  are _transcriptions_ of Fable's artifacts; a Sonnet agent that finds the plan ambiguous RAISES that as a finding and
  stops at the gap. Never route planning to a cheap model because tokens are tight: cut scope or phases instead.
- **Downstream, the engine sets model AND effort per role; nothing inherits the interactive session's effort**
  (12 of 25 agent calls did until 2026-09-02 — a Fable session at `xhigh` ran every Opus lens and the Fable final pass
  at `xhigh`). Sonnet 5 (`claude-sonnet-5`) does all in/out — packs, tests and implementation at `medium`, probes
  at `medium`, pattern lenses, routine-file refutation, the UI judge on routine surfaces and routine fixes at
  `high`; Opus 5 (`claude-opus-5`) gives the verdicts the difficulty earns at `high` — the correctness lens on
  every file, deep lenses and refutation on HIGH-risk files, the red-gate audit, the final-pass read, HIGH-risk
  fixes — over a ≤ 40 KB pack with a 12-tool-call cap (`xhigh` only for deep lenses with HIGH-risk files); Haiku
  4.5 (`claude-haiku-4-5`) runs gates, manifest, grounding, checksums and checkpoints at `low`. Full ids, never
  aliases; the per-role table is `CFG.routing`, the caps `CFG.caps` (token-class ruling 2026-09-10).
- **Fable 5.1 (`claude-fable-5-1`) is the brain, never the hands (owner ruling 2026-09-03):** it reads no file and
  runs no command in the engine. It decides at exactly three decision points — the tie-break judge on a split
  refutation vote (decides from the refuters' cited evidence); the **Final pass decider** on a `major` diff with
  HIGH-risk files (an Opus reader produces candidates from a Sonnet-built digest; Fable rules on them and names the
  gaps that earn one focused re-read) — and the **fix planner**: once per fix round, over a Sonnet-built brief of
  every confirmed finding (excerpts, callers, the reviewer's scenario), Fable decides fix / dispute / defer, the
  design, the invariant, the test and the executor tier; Sonnet and Opus implement designs and never improvise (a
  design that does not fit comes back as `designMismatch`). Opus @ xhigh decides if Fable declines — for the planner
  and the final pass alike; the final pass is skipped and recorded when the diff has no HIGH-risk file. The security
  lens stays on Opus. History: [ENGINE-NOTES](references/ENGINE-NOTES.md).
- **Light loop** (owner ruling 2026-09-03 for bounded work and for finishing runs that lost agents): see [LIGHT-LOOP](references/LIGHT-LOOP.md) — Fable plans and rules, Opus executes HIGH-risk and reviews, Sonnet writes.
- **Fable decides, Sonnet gathers and transcribes — in planning too (owner ruling 2026-09-10).** Measured: the
  orchestrating Fable session held 58–193 KB of planning artifacts plus every source read for 6–14 h, and one such
  session cost $103 in cache reads that no ledger saw. So S1–S5 keep Fable as the only author of _decisions_ (the
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
- Escalate on blast radius, not file count. `scale` sets the lens list, refutation and the mutation probe only.

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
value known _independently_ of the implementation, stated **concretely** (a number, a status, a row) so the test fails
on _its own_ value before implementation, not merely on a stub's `undefined`. Prefer the lowest level that can fail
for the right reason. Method, anti-vacuity rules and Playwright house rules: [TESTING-PLAYBOOK](references/TESTING-PLAYBOOK.md).

## S5 — Build plan: how (→ `build-plan.md`)

1. **Self-contained** — subagents see only these artifacts, never the conversation.
2. **Disjoint work packages** by file ownership; shared file ⇒ `dependsOn`, never a fake overlap. A `dependsOn` that
   names no package, or a cycle, is a `(build-plan)` blocker. `testPackages` and `packages` resolve `dependsOn` in
   separate namespaces. Size packages so no wave has a single long-pole package.
3. **Every package declares `satisfies:` (R#s) and `provenBy:` (T#s)**, with **exact code for the tricky parts** — 20
   hard lines from the planner beat Sonnet guessing. Per-package `effort` is omitted (= `medium`) except `high` for the
   money/tenancy/auth package; `model` upgrades only the one risky package.
4. **Real, tiered verification commands:** `perRound` = typecheck/lint scoped to the touched workspaces; `final` = the
   full suite once. Scope them to what this change can affect — a repo-wide gate that needs state a fresh worktree
   lacks fails at Baseline, is excluded as a broken command, and leaves the run with no gate at all.
5. **Never put a post-deploy test in `testPackages`**, and keep regression pins out of the red-gate scope — the red
   gate's whole job is that every test in scope fails.
6. Pass `lessonsPath` (the project's `.claude/lessons/LESSONS.md`), `startedAt` (an ISO timestamp taken at launch)
   and `runDir` (the run's absolute artifact directory — enables per-phase checkpoints and the `result.json` summary).
7. **Transcription split (2026-09-10):** Fable writes the decisions of S4 and S5 — the `R#`→`T#` matrix with each
   oracle's concrete value, the package boundaries with file ownership, the hard lines, the tiered commands — as a
   compact ruling (≤ 12 KB across both). A Sonnet `medium` agent expands that ruling into the full
   [TEST-PLAN](templates/TEST-PLAN.md) / [BUILD-PLAN](templates/BUILD-PLAN.md) templates (Given/When/Then wording,
   package boilerplate, the `## Pipeline args` block) and returns a ≤ 1.5K brief: what it filled, what it could not
   decide (raised, never guessed). Fable rules on the brief; it does not re-read the expanded files.

## S5.5 — Grounding pass (Haiku `low`)

Before approval, one Haiku 4.5 agent verifies every fact about the tree the build plan asserts — each path exists,
each verification command's script exists in the manifest, the base sha equals the integration branch's head, every
`dependsOn` names a package — and returns a pass/fail list. A fail blocks S6; the plan is corrected, not annotated.
(RUN-LOG: three runs launched on a stale or imagined tree fact.)

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
  the copy a live or resumable run depends on (its RESUME card names it). In a fresh clone the same file is
  available at `.claude/skills/dev-pipeline/pipeline.js`; stage from there.
- **Write the RESUME card at launch** (`.claude/pipeline/<run>/RESUME.md`: runId, persisted scriptPath, the exact args)
  — a killed session cannot be asked for them later.

```js
{
  planPath,                   // REQUIRED — the build plan
  discoveryPath, specPath, uxSpecPath, testPlanPath, designSystemPath,  // each path passed is ground-checked
  lessonsPath: '.claude/lessons/LESSONS.md',   // every reviewer, refuter, fixer and the final pass carry it
  startedAt: '<ISO timestamp taken at launch>',  // echoed into the result for the ledger
  scale: 'small' | 'major',   // default 'small'
  workdir: '', context: '',   // optional worktree + one line of task context
  formatCommand: '',          // this repo's formatter; omitted ⇒ agents find the repo's own
  testPackages: [ { id, title, files, brief, effort?, model?, dependsOn? } ],  // authored BEFORE impl
  redGate: { commands: ['<test command scoped to the new tests>'], expect: 'fail' },
  packages: [ { id, title, files, brief, effort?, model?, dependsOn?, satisfies?, provenBy? } ],
  verifyCommands: { perRound: ['<scoped typecheck/lint>'], final: ['<full suite>'] },  // tiered is the default shape
  uiVerify: { url: '', startCommand: '', flows: [...], viewports: ['desktop'],
              checks: ['console-errors','network-failures','a11y','design-system'] },   // all keys optional
  mutationProbe: { targets: [ { file, behavior, test } ] },   // major scale only
  runDir: '',   // C1 CHECKPOINTS — absolute path; absent = legacy path, byte-identical, zero extra agents
}
```

Every arg is optional except `planPath` and `packages`; a phase whose arg is absent is skipped, and a skipped phase
proves nothing while still letting `clean` go true — after S4 pass `testPackages` **and** `redGate`, and check `ran:`
on every phase you expected.

### The ten phases — what each proves, and what it costs

| Phase                                                         | Agents (model @ effort)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline                                                      | 3 × Haiku @ low, concurrent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | which verify commands work at all (a failure here = broken COMMAND, excluded from the verdict); every mechanically checkable artifact claim; the context manifest with a HIGH/LOW risk class per file                                                                                                                                                                                                                                                    |
| Author tests                                                  | Sonnet @ medium per package, waves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the tests exist, name their T#/R#, assert concrete oracles; implementation forbidden                                                                                                                                                                                                                                                                                                                                                                     |
| Red gate                                                      | Haiku run + audit: Opus @ high when the package touches a HIGH-risk file, Sonnet @ high otherwise (`CFG.routing`) — the audit reads the run report, never the repo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **structural RED** (every test fails on an assertion; none passes/errors/skips) — one Opus remediation round if not; **behavioral RED** (each fails on its own value) — a shortfall is recorded and proven by probing every mutation target instead of a round that never converted (F06, F14)                                                                                                                                                           |
| Implement                                                     | Sonnet @ medium per package, waves (optionally beside the red audit, flag off)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | the packages, exactly as planned; deviations reported                                                                                                                                                                                                                                                                                                                                                                                                    |
| Gate & Review                                                 | Haiku gate → build-fix on failure (Sonnet @ high on routine files, Opus @ high on HIGH-risk) → re-gate → radius pack (Sonnet @ low, ≤ 40 KB, feature and bugfix alike) → lenses over the pack: deep lenses `correctness` (every file, ruling A4), `spec-compliance`, `edge-cases-and-security`, `operability` on **Opus @ high** (`xhigh` when any HIGH-risk file) — the engine's `DEEP_LENSES` list; pattern lenses `test-quality`, `scope-coverage`, `design-system` on **Sonnet @ high**; every lens ≤ 12 tool calls, opens a source file only for a hunk the pack cites (`CFG.routing`, `CFG.caps`) → Haiku dedupe                                                        | a tree that builds, then every lens over the same evidence base, each carrying the lessons digest; a gate that executed zero tests is not green; duplicate findings merged before any refuter votes                                                                                                                                                                                                                                                      |
| Verify (major)                                                | Sonnet @ low location check (one agent) → refuters, **one per FILE**: Sonnet @ high on routine files, Opus @ high on HIGH-risk files; pre-refuting only HIGH-risk or mis-cited findings; the rest go to the refute-first fixer and reach this same slate only if disputed; Fable @ high tie-break on a split (from cited evidence, ≤ 8 KB brief)                                                                                                                                                                                                                                                                                                                              | a finding is dropped only when the full slate agrees or the judge rules — before the fixer for HIGH-risk findings, after a dispute for the rest; runs **beside UI verify**                                                                                                                                                                                                                                                                               |
| UI verify                                                     | **Sonnet @ medium drives** (writes and runs the Playwright spec, captures screenshots, console, network, a11y per flow and viewport as facts) → **Sonnet @ high judges** the evidence on routine surfaces, **Opus @ high** when the manifest has a HIGH-risk file                                                                                                                                                                                                                                                                                                                                                                                                             | flows, console, network, a11y, design-system fidelity per viewport; a blocked or undriven flow is a blocker; evidence nobody ruled on is unverified; re-driven and re-judged after any fix round                                                                                                                                                                                                                                                         |
| Mutation probe (major; ≥ 1 probe per HIGH-risk file on small) | Haiku checksums · Sonnet @ medium probes, strictly sequential; a surviving mutant goes back to the Sonnet test author for one remediation before it becomes a finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | each named test turns RED on a deliberate defect; restore verified by the script's own before/after digests — unless the probes' own `preHash`/`postHash` agree with each other and with the final state, which means the BASELINE moved under the run (something outside it wrote the tree) and is recorded in `baselineDisturbed` rather than charged as a restore failure; every HIGH-risk target, and every target when the red gate had a shortfall |
| Fix                                                           | Sonnet @ low brief (excerpts + callers) → **Fable @ high plans every fix at once** (fix / dispute / defer, design, invariant, test, route, waves) → executors in conflict-free waves: Sonnet @ low mechanical, Sonnet @ medium designed routine-file fixes, Opus @ high HIGH-risk, `ui-verify` and broad keys; refute-first and design-mismatch reports return to Fable next round; scoped re-check beside the dispute slate (Sonnet @ high on routine files, Opus @ high on HIGH-risk); on `major` the Final pass runs BEFORE this round so its findings join the one plan (`CFG.finalPassBeforeFix`); a round of nothing but synthetic keys skips the brief and the planner | confirmed findings resolved, nothing else moved, and each one resolved to a design rather than an executor's improvisation; a dispute is dropped only by the slate, an upheld one returns marked so neither the planner nor the next fixer may dispute it again, and a deferred one stays open as an owner question in `fixPlanning.deferred`                                                                                                            |
| Final pass (major)                                            | **Sonnet @ low packages** the HIGH-risk files' complete diff hunks plus every changed export's call sites → **Opus @ xhigh reads** it adversarially and hands over candidates with evidence → **Fable @ high decides** from a brief (real or not, severity, and the specific gaps that earn ONE focused re-read); Fable opens no file and runs nothing; Opus @ xhigh decides if Fable declines; skipped and recorded when no file is HIGH risk; runs **beside the final full gate**                                                                                                                                                                                           | what every Opus lens, refuter and probe missed; findings land in `remainingFindings` and keep `clean` false                                                                                                                                                                                                                                                                                                                                              |

### Cost mechanics (on by default, no coverage trade)

- **Risk sets DEPTH, never COVERAGE.** HIGH = money/pricing/tax, auth/permissions, tenancy/ownership, migrations/schema,
  PII, payments; unknown ⇒ HIGH. Every lens reads every file in scope.
- **Every effort is explicit** (`CFG.effort`): gates/manifest/grounding/checksums/checkpoints/mechanical fixes/
  location check/final-pass digest/radius pack/**the fix brief** `low`; tests, implementation, the UI driver, probes
  and **the Sonnet designed-fix executor** `medium` (a package's own `effort` wins); every verdict `high` — Sonnet
  lenses/refuters/UI judge on routine files, Opus lenses/refuters/red audit/judgment fixes on HIGH-risk files,
  tie-break, **the fix plan** and the final-pass decision on Fable; deep Opus lenses and the final-pass reader
  `xhigh` only with HIGH-risk files (the Opus fallback decider and fallback fix planner `xhigh`).
- **Token-class routing** (owner ruling 2026-09-10, supersedes "verdicts on Opus" of 2026-09-03; the plan is
  `model-routing/references/ROUTING-PLAN.md`): measured on a 113-agent run, 98% of Opus's $180 was cache reads
  and writes — Opus re-reading a growing context — not verdicts. So **Sonnet does all in/out** (gathering,
  packs, drivers, packaging, tests, code, and the verdict on routine files at `high`); **Opus gives the verdicts
  the difficulty earns** (HIGH-risk files, blocker/major refutation there, the red-gate audit, the final-pass read,
  security, HIGH-risk fixes) over a ≤ 40 KB pack with a **12-tool-call cap** and never explores the repo;
  **Fable rules over its cache** from ≤ 8 KB briefs; Haiku runs mechanics. `CFG.routing` holds the model per role
  and `CFG.caps` the byte and tool-call caps; the routing scorecard (cost × quality × minutes per task level)
  re-derives every row every ten true-telemetry runs and **reverts any demotion whose confirmed-finding rate
  fell** (quality is the floor). Uniform effort per fan-out is also what lets agents share the prompt-prefix
  cache — every prompt opens with the same run prefix (repo note, artifacts, manifest, grounded-claims line),
  then the `PHASE · LABEL` tag, then the role; a wave is warmed by one agent before the rest launch.
- **Verify on dispute** (`CFG.verify.mode`, owner ruling 2026-09-02): only findings where a wrong fix is expensive —
  HIGH-risk files, or a citation the Sonnet location check could not confirm — get an independent slate before the
  fixer, **one refuter per file** (Opus on HIGH-risk files, Sonnet @ high otherwise); every other finding goes to the fixer, which refutes first and marks what it
  disputes, and disputes get the same slate beside the re-check. Lazy slate throughout (`CFG.lazySecondVote`): the
  rest of the votes and the Fable tie-break are cast only on a first "refuted". Refute rates run 1–12% of votes; F06
  spent ~22% of its tokens pre-verifying everything, F13 cast 30 first votes to overturn 2.
- **Refutation is severity × risk gated** (`CFG.refuteSeverities`, blocker/major + every HIGH-risk file); a skipped
  finding goes to the fix loop unrefuted, never dropped.
- **Fable plans the fixes** (owner ruling 2026-09-03, `CFG.fixPlanning`): one decision per round over all findings;
  executors implement designs, never improvise; a design that does not fit comes back as `designMismatch`, matched by
  the `[#index]` the executor was given (summary second). The engine — not the prompt — forces HIGH-risk files, broad
  synthetic keys and any `ui-verify` group onto Opus, refuses a second dispute of an upheld finding, and re-derives
  write-conflict safety from the plan's waves. **Planning floor:** a round whose findings are all synthetic keys
  (`(gate)`, `(red-gate)`, `(mutation)`, `(tests)`) buys no brief and no planner — there is no code to design against.
  `defer` is for a decision the run cannot make, never for difficulty; deferrals surface in `fixPlanning.deferred` and
  keep `clean` false until a person answers them. `fixPlanning: false` (or `args.fixPlanning: false` for one run)
  restores the routing below exactly.
- **Complexity-routed, waved fixers** (unplanned rounds, and the flag-off path): `mechanical` → Sonnet @ low;
  `judgment`, anything on a HIGH-risk file, anything from `ui-verify`, and every synthetic key except
  `(artifact)`/`(gate-command)` → Opus @ high.
- **Risk-gated mutation probe**: HIGH-risk targets always; every target when the red gate was not properly red; a LOW-
  risk target behind a red gate that went properly red is skipped and recorded — never evidence of anything.
- **Final pass only where its rationale holds** (`CFG.finalPassWhenNoHighRisk = 'skip'`): no HIGH-risk file, no Fable
  read; `finalPass.skipped` says so.

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

`clean` = no remaining findings ∧ gate ok (baseline-filtered) ∧ no dead lens ∧ red ok (structural bar on major,
behavioral on small) ∧ mutation caught and restore verified ∧ every package `done`. A skipped phase is neutral; an
_unverified_ one is not. Report the one-shot oracles separately: `redGate.structurallyRed/behaviorallyRed/attempts`,
`verify` (votes cast, first-vote refute rate, tie-breaks), `mutationProbe.allCaught/restoredVerified/skipped`,
`uiVerify.ran/reVerify`, `finalPass.ran/skipped/model/fallback/completed`, `baseline.badCommands`, `riskSummary`,
`fixRouting` (`mechanical` / `sonnetDesigned` / `judgment` — what RAN, against `routes` below, what Fable ASKED FOR),
`fixPlanning.rounds[]` (`completed`, `skipped`, `model`, `fallback`, `actions`, `routes`) and `fixPlanning.deferred[]`
(the owner questions this run could not answer), `mutationProbe.baselineDisturbed`, `overlap`, `estimatedCostUsd` (output-only, at `pricesAsOf`), `phaseReport[]` (tokens, `estUsd`,
effort, `overlappedWith`, `note`). `cascadeAudit`/`escalation` are `null` when their flag is off.

**Resuming:** the Workflow _tool result_ carries the `runId` and persisted `scriptPath`; with the exact `args` (not
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
   missing is _unproven_, not done. Quote the gate, red-gate and mutation-probe results: a cached replay is not evidence.
2. **One command does the rest:**
   `node .claude/skills/dev-pipeline/scripts/closeout.mjs <run dir> [--project <dir>] [--session <id>|--latest] [--branch <name>] [--pr <n>]`
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

| Change                                                                                                                                  | Edit                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Models, every effort ceiling, lazy voting, the red-gate bar, final-pass skip, prices, refute gate, fix rounds, the measured-trade flags | `CFG` atop [pipeline.js](pipeline.js)                                  |
| Triage thresholds, small-scale policy, approval, stage order, close-out                                                                 | this file                                                              |
| The routing ladder itself, Fable prompting, the ledger and the ten-run rules                                                            | the `model-routing` skill                                              |
| The architect question set and its stop conditions                                                                                      | [references/ARCHITECT-QUESTIONS.md](references/ARCHITECT-QUESTIONS.md) |
| Test method, anti-vacuity rules, Playwright rules, mutation probe                                                                       | [references/TESTING-PLAYBOOK.md](references/TESTING-PLAYBOOK.md)       |
| Which design skill handles which need                                                                                                   | [references/DESIGN-ROUTING.md](references/DESIGN-ROUTING.md)           |
| The incidents and long-form cautions behind the rules above                                                                             | [references/ENGINE-NOTES.md](references/ENGINE-NOTES.md)               |
| The zero-token branch check to run after any engine edit                                                                                | [scripts/dry-run.mjs](scripts/dry-run.mjs)                             |
| Artifact structure                                                                                                                      | the matching file in [templates/](templates/)                          |

Canonical install is user-level (`~/.claude/skills/dev-pipeline/`); edits take effect on the next invocation. For one
repo's own variant, copy this folder into its `.claude/skills/dev-pipeline/` — RouteFlow already carries this
vendored copy at that exact path, so a fresh clone or cloud sandbox with no `~/.claude` runs the same pipeline.

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
