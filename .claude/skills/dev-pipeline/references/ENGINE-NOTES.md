# Engine notes — the history and the long-form cautions behind dev-pipeline

> Moved out of SKILL.md on 2026-09-02 so the skill body carries rules, not archaeology. Nothing here was
> deleted; each section is quoted verbatim from the SKILL.md that shipped through 2026-09-02. SKILL.md keeps
> one-line pointers. Read a section when the pointer is not enough.

## Why Fable helps the Opus review at exactly two points (from MODEL POLICY)

> Superseded 2026-09-12 — the task-loop rebuild removes Opus from the review/fix path entirely: Fable
> reviews and implements HIGH-risk tasks, Sonnet reviews and implements routine ones, Opus is kept only
> as `CFG.fallbackModel` for a Fable refusal. See `## 2026-09-12 — task-loop rebuild` below.

Downstream the engine fixes the rest: **Sonnet** authors tests, implementation and mechanical fixes; **Opus 5**
(`claude-opus-5`) runs the review lenses, refuters, red-gate audit, UI verification, mutation probes, judgment fixes
and the re-check; **Haiku** at `effort: 'low'` runs the baseline gate, manifest, grounding, gates, red-run and
checksums. **Fable helps the Opus review at exactly two built-in points** (`CFG.tieBreakModel` /
`CFG.finalPassModel`), scope-limited so the strongest model reads the least text that still carries the risk: a
**split refutation vote** goes to a Fable tie-break judge instead of defaulting to keep (a disputed false positive
would otherwise send a fixer to mutate working code), and every **major** run ends with a Fable **Final pass** over
the HIGH-risk portion of the finished diff — the in-pipeline generalization of the house money-batch rule that
caught a CRITICAL on PR #421 after three clean Opus lenses. Final-pass findings land in `remainingFindings` and keep
`clean` false; the orchestrator fixes or resumes. (Money batches no longer need a separate manual Fable pass — it is
this phase.)

## S7 launch cautions — worktrees, hooks, baselines, generated clients, nested node_modules

## S7 — Execute (`pipeline.js` via the Workflow tool)

Launch from a **fresh branch off the integration target, with a clean tree**. **If that branch lives in a git worktree, install into the worktree before the first commit** — hook managers (husky and kin) point `core.hooksPath` at a directory the install generates (`.husky/_`), which a fresh worktree does not have, so until then git runs NO hooks there: commit-msg lint and the pre-push verify are skipped silently, and a green CI afterwards is not evidence the local gates ran. Baseline records the
tree exactly as the caller left it: unrelated uncommitted work becomes "the baseline", so a
verification command it breaks is excluded from the pass/fail decision, and every file it touches
enters the manifest as part of this change and is reviewed as yours. Commit, stash or drop anything
that is not this run's work before launching.

Pass the absolute path of the `pipeline.js` next to this SKILL.md (user-level; a project-level copy wins inside that
repo). **Pass artifact PATHS — never paste their content.**
A fresh `workdir` worktree — or a branch just rebased across a schema change — carries a stale
generated client (ORM, API or other codegen). Regenerate it there (e.g. `npx prisma generate`)
**before** launching: otherwise typecheck and test fail at Baseline, are excluded as broken
commands rather than read as defects, and the run proceeds with no real gate at all.

⚠️ **A worktree without its own `node_modules` cannot see NESTED dependencies — give it its own install before trusting any check on the package that nests them.** Resolution from `<worktree>/apps/<pkg>` walks the _worktree's_ ancestors up to the main checkout's **root** `node_modules`; it never traverses the main checkout's `apps/<pkg>/node_modules`. So whatever the package manager nested there is **structurally invisible** to every worktree: its typecheck and suites fail with "cannot find module" — and a build cache can hide that for days, replaying a green nobody ever ran (a green check-types in a fresh worktree is evidence of a cache hit, not of correctness). **Run the package manager's clean install INSIDE the worktree** (it creates the worktree's own `node_modules` and does not touch the shared checkout) before launching a run that touches that package; a workdir with its own install also makes codegen (e.g. `prisma generate`) local rather than shared. Treat such suites as authoritative only from an installed tree or CI, and **check `<main>/apps/<pkg>/node_modules` before concluding a package is missing** — a bare "absent" is meaningless without the path it was read from. (Nesting is sometimes a version-conflict symptom that realigning the shared tree happens to dissolve, but never rely on that: the per-worktree install fixes it.

## The ten phases, and what each proves (long form)

> Superseded 2026-09-12 — the ten fixed phases below are replaced by a per-task chain (waved by
> `dependsOn`): Baseline → {brief → test-author → RED check → implement → pack → review → fix loop} per
> task → Final. See `## 2026-09-12 — task-loop rebuild` below for the new shape and `dev-pipeline/SKILL.md`'s
> task-loop table for the current phase-by-phase detail.

### The ten phases, and what each proves

1. **`Baseline`** — three Haiku agents concurrently, before any agent has written anything.
   - **baseline gate** runs the union of `perRound` and `final`. A command failing _here_ is a **broken COMMAND, not a
     defect**: excluded from the pass/fail decision (it can never make `clean` false), still run every round so a
     behavior change stays visible, and raising one `(gate-command)` major finding saying to fix it **in the plan**,
     not in the code. **Honest caveat: the baseline is the tree exactly as the caller left it, uncommitted work
     included** — a dirty tree IS the baseline. A dead agent here means no command is known-broken, so every later
     failure counts against the run.
   - **artifact grounding** checks every mechanically checkable claim the passed artifacts make — paths, directories,
     commands, manifest scripts, config keys, exported symbols — against the repo. Missing path/script/key = `major`,
     unresolvable symbol = `minor`, filed under `(artifact)`; a blocker is downgraded to major, since an existence
     check must never open the run with one. It ignores wording and design, and never flags what the artifacts say the
     change _will create_. _Kills confabulation._
   - **context manifest** — facts only: every changed/untracked file plus every file the plan intends to touch, each
     with status, `changedLines` and a **HIGH/LOW risk class**; which supplied commands could statically run; which
     artifact paths exist. Pasted into every later prompt, capped at 80 files. It carries **no interpretation of the
     change** — one shared reading would give every lens the same blind spot.
2. **`Author tests`** (on `testPackages`) — Sonnet writes tests only; implementation is forbidden.
3. **`Red gate`** (on `redGate`) — Haiku runs, Opus audits: every new test must fail on an _assertion_, not a
   syntax/import/config error, and none may pass. One remediation round; a dead auditor is not a pass.
   A red must also be _behavioral_: a gate where every test fails identically on a stub's `undefined`
   has proven the wiring, not the oracles — each test must fail on its own expected value from the test
   plan. If the one allowed remediation round still leaves `properlyRed` false, the `(red-gate)` blocker
   stands and `clean` stays false; where a mutation probe is declared (major scale) the engine then
   probes **every** target rather than only the HIGH-risk ones, because the red gate is no longer
   overlapping evidence. That probe, plus one hand-run probe on a sibling behaviour the same change
   touches, is the only test-quality evidence the run has — say so in the close-out instead of
   reporting the red gate as satisfied.
4. **`Implement`** — Sonnet, one agent per package, in conflict-free waves.
5. **`Gate & Review`** — **the gate runs FIRST, not beside the lenses**, because a broken build wastes a whole review
   round on code that does not compile: gate → on failure one Opus build-fix agent → re-gate → then the lenses (which
   run either way, since their findings explain the breakage). Lenses on `major`: `correctness`, `spec-compliance`,
   `test-quality`, `edge-cases-and-security`, `operability`, **`scope-coverage`** (+ `design-system` when a UX/design
   path was passed). `scope-coverage` is the only lens asking **"what did the plan forget?"** instead of "is what is
   here correct?" — orphan files, call sites, migrations or config in no package; packages satisfying no requirement;
   requirements no package satisfies; sibling code that will now drift. It greps the repo, not just the diff.
6. **`Verify`** — 2 adversarial refuters per non-synthetic finding (major only). A finding is dropped only if the
   **full** slate ran and every one refuted it: a dead refuter is no-evidence, never a vote.
7. **`UI verify`** — Playwright in the repo's own e2e location (fallback: browser MCP): flows, console errors, network
   failures, a11y, design-system fidelity, per viewport. After any fix round it **re-runs**, because the fix loop
   checks itself by reading source, which cannot prove a rendered result; a completed re-verify answers a dead first
   pass, and what it still sees keeps `clean` false.
8. **`Mutation probe`** — pre-checksum (Haiku) → strictly sequential probes (Opus) → post-checksum (Haiku), and **the
   script compares the two digest sets itself**. The probe's own `restored: true` is a self-report from the only party
   that could have broken the file, so it can never clear itself; any mismatch, or a dead checksum agent, sets
   `restoredVerified: false` and raises a `(mutation)` blocker. Backups go to the **OS temp dir**, never beside the
   file. **Restore is by file copy — never `git checkout/restore/stash/reset`, and a git worktree cannot be used here
   at all: the code under test is the uncommitted implementation this run just wrote, so a fresh worktree would not
   contain it and any git restore would destroy it.**
9. **`Fix`** — fixers on confirmed findings in conflict-free waves, a scoped re-check, then the final full gate when
   `verifyCommands` is tiered.
10. **`Final pass`** (major only) — one Fable agent reads the spec/test-plan/build-plan plus the finished diff of
    exactly the HIGH-risk files, told what the run already found so it hunts only for what every Opus lens, refuter
    and probe MISSED: cross-file invariants, spec-in-spirit violations, money/tenancy/authorization edges in the
    interaction between packages. Its findings get no fix round here — they land in `remainingFindings` and keep
    `clean` false for the orchestrator. A dead final-pass agent raises a `(final-pass)` major finding: an unverified
    last read is not a clean one. (In `Verify`, Fable also judges any split refutation vote — see MODEL POLICY.)

## Cost mechanics and the measured trades (long form, with the F06 measurement)

> Superseded 2026-09-12 — the lens fan-out, complexity-routed fixer tags and lens-scoped refutation
> described below belong to the pre-rebuild ten-phase engine. The task-loop engine keeps the risk-sets-
> depth principle and the risk-gated mutation probe (now a `revert-probe` task type) but replaces the
> lens machinery with one reviewer per task (Sonnet routine / Fable HIGH-risk) and a four-round fix table
> (S3). See `## 2026-09-12 — task-loop rebuild` below.

### Cost mechanics (on by default, no quality trade)

- **Risk sets DEPTH, never COVERAGE.** HIGH = the path or content touches money/pricing/tax, auth/permissions,
  tenancy/ownership scoping, migrations/schema, PII or payments; **unknown, unreadable, unlisted or garbled ⇒ HIGH**,
  and no manifest at all ⇒ every file HIGH. Every lens still reads every file in scope; HIGH files get maximum depth,
  HIGH findings judgment fixers, HIGH targets the mutation probe.
- **Effort tiering** (`CFG.effort`): gate/manifest/grounding/checksum/mechanical-fix `low`; `test-quality`,
  `design-system`, `scope-coverage` `medium`; `correctness`, `spec-compliance`, `edge-cases-and-security`,
  `operability` inherit the session's effort. Refutation never drops below `medium` and the red-gate audit is never
  tiered down — those two decide what evidence survives.
- **Refutation is severity × risk gated** (`CFG.refuteSeverities`, default `['blocker','major']`). Refutation exists to
  stop a fixer mutating working code on a false positive: real for a money/auth claim, negligible for a stale comment,
  where a wrong fix costs less than the two Opus agents spent avoiding it. A finding skips refutation only when it is
  **both** below the severity bar **and** on a LOW-risk file — and skipping is not dropping, it goes to the fix loop
  unrefuted. Measured on F06 (major, 2026-09-01): 35 votes → 2 refutations at ~22% of the run's tokens, with 13 of 22
  raw findings minor. Watch `confirmedByPhase`: if gated refutation ever drops a phase's confirmed count to zero, the
  gate is too aggressive — widen `refuteSeverities` before blaming the lens.
- **Complexity-routed fixers.** Every finding carries `fixComplexity`, tagged by the reviewer that found it (free — it
  already understands the defect): `mechanical` (wrong path, broken link, stale cross-reference, renumbering, missing
  import) → Sonnet at low effort; `judgment` (logic, edge cases, security, API shape) → Opus. **Forced to judgment
  whatever the tag:** anything on a HIGH-risk file, anything sourced from `ui-verify`, every synthetic key except
  `(artifact)` and `(gate-command)`, and any finding with a missing tag.
- **Waved fixers.** Fixers use the implementers' wave logic, keyed on the declared file group: disjoint fixers run
  concurrently, overlapping ones serialize, and broad fixes (broken build, unrestored mutation, test package) share
  one sentinel and run last. Residual risk, knowingly accepted: a fixer may edit a file outside its group, invisibly
  to the conflict key. The **scoped re-check** after each round then reads only the fixers' `filesChanged` plus the
  locations the findings cite — nothing else moved — while still reporting regressions it trips over on the way.
- **Risk-gated mutation probe.** A target is probed when its file is HIGH risk, or when the red gate never ran;
  otherwise the red gate already proved those tests fail for the right reason. Every skip is logged into
  `mutationProbe.skippedTargets` with its reason — **a skipped probe is never evidence of anything**, and `allCaught`
  speaks only for probes that ran.

### Measured trades — both OFF by default, both unproven

Neither has been shown safe on real runs. Enable on a number, never on taste.

- **`CFG.cascadeReview`** (false): Sonnet reviews the LOW-risk partition, Opus reviews HIGH plus every file Sonnet
  flagged. **Risk: a subtle defect in a LOW-risk file that Sonnet misses is never seen by Opus.** When on, an Opus
  **spot audit** re-reviews the three largest LOW-risk files Sonnet cleared (by changed lines; deterministic — this
  runtime has no randomness) and records `cascadeAudit.missedFindings`. **Justified only if that number is 0 across
  ten real runs with the cascade on; one missed defect ends the argument.** A dead auditor measured nothing, not zero.
- **`CFG.densityEscalation`** (false): if the floor lenses find nothing, the gate is green and the diff is under
  `CFG.densityThreshold` (8 files / 400 changed lines; unknown counts as over), skip the remaining lenses. **Risk:
  exactly what the floor lenses do not look for — spec holes, security, operability, forgotten scope.**
  `escalation.lensesSkipped` names every dimension not reviewed. **Justified only if, across ten runs meeting all
  three conditions with the flag OFF, the non-floor lenses contributed zero confirmed findings** — count those from
  `confirmedFindings` (findings carry a phase, not a lens), since the flag can never produce that evidence itself.

The floor holds at any flag setting: `correctness` and `test-quality` **cover every changed file** — no flag narrows
that coverage; planning, refutation, the red-gate audit and UI verification stay on the review model; a dead agent is
never success. **Coverage is the floor, not model strength:** `cascadeReview` is the one setting that moves the floor
lenses' LOW-risk partition onto `CFG.cascadeModel` — the trade `cascadeAudit.missedFindings` exists to measure.

## Reading the result, resuming, and session-limit resilience (long form)

> Superseded 2026-09-12 — most `result.json` fields below carry over unchanged, but the `clean` formula's
> lens-era terms (`lensDied`, etc.) are gone and the result gains `tasks[]` and `rulings[]`. See
> `## 2026-09-12 — task-loop rebuild` below and the S5 field list it points to.

### Reading the result

`clean` is `findings.length === 0 && gateOk && !lensDied && redOk && mutationOk && restoredVerifiedOk && implOk &&
testsOk` — `gateOk` is **baseline-filtered** (a command broken at baseline cannot fail the run; a dead gate agent
still can), and `implOk`/`testsOk` read package status from the phase results, so dropping a blocked package's
finding never clears it. A skipped phase is neutral; an _unverified_ one is not. Non-empty `remainingFindings` ⇒
fix, resume or surface — never silently call it done. Report the one-shot oracles separately: `redGate.properlyRed`,
`mutationProbe.allCaught` / `.restoredVerified` / `.skippedTargets`, `uiVerify.ran` / `.reVerify`,
`finalPass.ran` / `.completed` / `.findings` (the Fable last read; `completed: false` means it died and the run is
dirty by construction), `baseline.badCommands`, `manifest.completed`, `riskSummary`, `fixRouting`. `cascadeAudit` and `escalation` are `null`
when their flag is off — null means the trade was **not taken**, never that it was taken and found harmless.
**Resuming:** the Workflow _tool result_ (not the return value) carries the `runId` and persisted script
path; call `Workflow({ scriptPath, resumeFromRunId, args })` with the same args (they are not stored) — unchanged
agent calls replay from cache.
**Session-limit resilience:** the `runId`, the persisted `scriptPath` and the exact `args` object are
the whole resume key, and **args are not stored** — write all three down the moment the tool result
returns, because a killed session cannot be asked for them later. Put them in a **RESUME card inside
the worktree** (`.claude/pipeline/<run>/RESUME.md`), not a session-scoped scratchpad: there it
survives the session and ships with the PR, so whoever picks the work up inherits it. The card
records the resume key, the transcript dir, what completed _per the run's own result_, what died and
must re-run, the still-open findings, and — the part that earns its keep — **which oracles have NO
result at all**. On resume, trust the resumed run's own `phaseReport`; never reconstruct progress
from WIP diffs in the tree, since Baseline treats whatever is there as the baseline and a
half-finished phase looks exactly like a finished one.

**A killed run's hand-run gates are evidence about the checks that ran, never about the review that
did not.** A green `tsc`/lint/test tree after the lenses, mutation probe or final pass died is not a
reviewed change — and an unexecuted mutation probe stays unexecuted: a passing suite cannot tell you
whether the tests bite, which is the entire reason the probe exists. Say so in the card, and treat
`mutationProbe`/`finalPass` with no result as work owed, not as work that would have passed.

## S8 close-out (long form)

## S8 — Close out

1. **Walk the coverage matrix out loud** — every `R#` → its `T#`s → the actual result; a requirement whose proof is
   missing is _unproven_, not done. Quote the gate, red-gate and mutation-probe results: a cached replay is not
   evidence a test ran.
2. **Report `phaseReport`** — per phase `{ phase, ran, agents, rawFindings, tokens, model }`, where `tokens: null`
   means the reading was unavailable and an unknown cost is never reported as free — plus `confirmedByPhase`, how many
   of each phase's raw findings survived refutation. **Rule: cut any finding-producing phase with no confirmed finding
   across ten real runs** — high `rawFindings` with `confirmed: 0`, run after run, is a phase paying only for noise.
   **`Verify` is exempt**: it authors no findings, it only removes them, so its `confirmed` is 0 by construction —
   judge it by the refutation drop rate it applies to the lens phases, never by its own count.
3. Set the Status line on every artifact (IMPLEMENTED / CLOSED), update the status tracker (e.g. `HANDOFF.md`) and the
   `.claude/code-map/` entries for touched files, then report what shipped, what proved it, what remains.
4. **If the close-out claims the change landed, compare CONTENT, never ancestry.** Squash merges
   rewrite SHAs, and even a three-dot diff misleads when the merge-base is old: prove it by diffing
   the files against the integration branch (`git diff <target> -- <files>` empty, or the shipped
   lines present there), never with `--merged` or commit ancestry.

## Rulings of 2026-09-02/03 — the token, time and quality upgrade (summary for history)

- 2026-09-02: every agent call carries an explicit full model id and effort (12 of 25 had inherited the session's
  effort, including the Fable final pass); deep lenses `high`, `xhigh` only with HIGH-risk files; shared run prefix
  opens every prompt; lenses carry the project's lessons register and checklists from L-025/L-029/L-031/L-036/L-037/
  L-044; gates must report tests executed (a green that ran nothing is red); per-phase `estUsd` and a run ledger.
- 2026-09-02 (owner): lazy second refuter; structural red-gate bar on major runs (a behavioral shortfall is proven by
  probing every target, not by a remediation round — F06 and F14 had burned that round for nothing); Fable final pass
  skipped and recorded when the diff has no HIGH-risk file (the old fallback read the whole diff at Fable prices);
  Verify beside UI verify; final gate beside the final pass.
- 2026-09-02 evening (owner): verify on dispute — only HIGH-risk or mis-cited findings are pre-refuted, one Opus
  refuter per file, a Sonnet location check first; fixers refute first and disputes go to the same slate; the drop
  rule (two Opus agree or the judge rules) never changed. Basis: F13 cast 30 first votes to overturn 2.
- 2026-09-03 (owner): gathering on Sonnet, verdicts on Opus and Fable — UI verify split into a Sonnet driver and an
  Opus judge; final pass into a Sonnet packager, an Opus reader at `xhigh` and a Fable decider that names coverage
  gaps for one focused re-read; the tie-break judge decides from cited evidence and opens no file. "Fable is the
  brain, never the hands."
- 2026-09-03 (owner): Fable plans the fixes — per round a Sonnet brief, one Fable decision over every finding (fix /
  dispute / defer, design, invariant, test, tier, waves), executors on Sonnet (mechanical, designed LOW-risk) and
  Opus (HIGH-risk, broad keys, ui-verify); index-based dispute matching; a floor that skips planning on
  synthetic-only rounds; `defer` surfaced as owner questions.
- 2026-09-03 (incident): another session stashed and re-applied the F13 worktree's tracked files during its run; the
  pre-probe checksum agent ran inside that four-minute window and the engine would have reported two healthy files
  as "not restored" and sent a fixer to reconstruct them. Probes now report their own before/after digests and a
  disturbed baseline is classified as such, never as a restore failure. A worktree with a RESUME card beside its
  pipeline args is a live run — never touch it.

## 2026-09-10 — checkpoints, tags, true telemetry

- Measured: the engine's own `budget.spent()` silently read 0 on 26% of phases; one run ledgered $14.94 that truly
  cost $205 + $41 across its two sessions; the Workflow `agent()` return exposes no usage at all. Cost is now read
  only from the session transcript (`model-routing/scripts/session-usage.mjs <sid|--latest> --project <dir> --all`)
  — never from an in-engine counter or by feel.
- **Checkpoint agent**: a Haiku `low` agent writes one card per phase to `<runDir>/phases/NN-<phase>.json` right
  after that phase's `endPhase()`, plus a flat `result.json` at run end (capped `CFG.checkpoint.maxSummaryKb`,
  32 KB) listing the phase files. A dead or malformed checkpoint agent is logged, never fatal.
- **`askAgent` tag**: every prompt now carries `PHASE: <phase> · LABEL: <label>` (`ROLE_TAG`) after the shared
  run prefix, so true telemetry can attribute tokens to a phase from the transcript alone.
- **`args.runDir`**: same directory the RESUME card lives in; absence is the exact legacy path (zero extra
  agents, byte-identical prompts otherwise).
- **Snapshot commit**: at the first green `Gate & Review`, a checkpoint card runs
  `git add -u && git add "<runDir>"` then commits `wip(pipeline): <run-slug> checkpoint <phase>` — never
  `git add -A`; refused on `main`/`master`.
- **`ckSeq` restarts at 0 on a resumed run** — a replay with a different fix-round count can leave two
  differently-numbered card sets under `phases/`; trust the newest card by mtime, never its `NN` number.
- Three Opus-found majors, and why they mattered: (1) the ledger's `append` silently refuses a
  `{result: {...}}`-wrapped object — a wrapped `result.json` looked like a successful append and produced no
  row; (2) a string `"0"` for `remainingFindings` reads truthy in a naive check but `0` in a numeric one — the
  two disagreed on `clean`; (3) `git add -A` in a checkpoint's snapshot commit swept up other agents' untracked
  files in the same worktree — fixed by the `git add -u && git add "<runDir>"` pairing above.

## 2026-09-11 — package P1: sibling sweep alive again + gate cwd/exitCode proof

Two defects, both from RUN-LOG evidence. (1) Every real caller since 2026-09-08 has passed
`siblingPatterns` as `[{regex, note}]` objects (see
`.claude/pipeline/2026-09-08-numbering-siblings/pipeline-args.json`), but the engine's filter kept
only entries with a literal string `.pattern` — so `siblingSweep.skipped === 'no-patterns'` fired on
every one of 4/4 bugfix runs on 2026-09-10 despite patterns being supplied, and the sweep never ran.
Fix: `siblingPatterns` is now normalised — a string becomes `{pattern, note: ''}`, an object with
`.regex` and no `.pattern` gets `pattern = regex`, `.note` is kept when present — and an entry with
neither key is dropped rather than silently accepted. `siblingSweep.supplied` (raw array length) and
`siblingSweep.patterns` (kept length) are both recorded; when `supplied > 0` and `kept === 0`, or
`supplied !== kept`, the engine pushes a `blocker` finding ("siblingPatterns supplied but not usable")
and logs an ERROR instead of skipping quietly. `siblingGrepPrompt` interpolates the normalised
`pattern`. Invariant: `result.siblingSweep.patterns === args.siblingPatterns.length` or the run
carries that blocker. (2) `GATE_SCHEMA` had no way to learn where a gate agent actually ran —
`askAgent` has no cwd option — so a wrong-directory "environment repair" round cost $21 on a
one-file fix (RUN-LOG train4-run-c) and two runs recorded green Jest gates that had executed
nothing. Fix: `GATE_SCHEMA` now requires a top-level `cwd` (the verbatim first line of `pwd`/
`process.cwd()`, reported before any command) and a per-result `exitCode`; every gate prompt
(baseline, red-run, gate, regate, final-gate) instructs the agent to print and report both. A new
`enforceCwd()` runs on every `GATE_SCHEMA` result the instant it comes back — before any call site
reads `.pass` — and when `workdir` is set and the reported `cwd` (normalised for separators/case,
tolerant of PowerShell's `Get-Location` table output) doesn't resolve to it, the result is corrected
to `pass:false` with a top-level `cwdMismatch` reason rather than a synthetic per-command row (a row
would flow through Baseline's `badCommandSet` exclusion and let a repeated mismatch hide as
"already broken at baseline"). This is detection only, logged as such in the code, since the engine
cannot force where an agent runs. `dry-run.mjs` gained scenarios for: a normalised `{regex, note}`
pattern sweeping correctly (`ran===true`, `patterns===1`, `supplied===1`); an unusable pattern
producing the blocker with `ran===false`; a gate result with `cwd` outside `workdir` failing the
gate; and a Jest command with `--reporters=default` out of last position (or targeting only
nonexistent paths without `--passWithNoTests`) blocking at Baseline. All green.

## 2026-09-11 — package P4: Fable 5.1 prompt blocks into the shared prefix

`RUN_PREFIX()` (`pipeline.js`) and its light-loop mirror (`scripts/light-loop.js`) each gained two blocks copied
verbatim from Anthropic's Fable 5.1 prompting guide, appended at the END of the prefix array so the prefix stays
byte-identical across every agent in a run (the prompt-cache invariant is unchanged): `SCOPE_NOTE` ("Keep changes and
tests to what the task asks for" — cuts unrequested fixes/extensions and over-committed test files) and `BATCH_NOTE`
("Batch independent tool calls in agent loops" — the one-sentence "First privately list what you need next…"
nudge). Neither pushed any Fable-model prompt over the measured 8,192-byte cap (`node dry-run.mjs` still reports
"no Fable-model prompt exceeds 8,192 bytes after the PHASE/LABEL tag" green). `FABLE-PROMPTING.md` gained three more
snippets by purpose, each with a one-line use-when: **Compaction preserve list** (the six-item `<summary>` instruction
for client-side compaction only — server-side compaction already does this), **Quoting retrieved sources** (the full
worked example — request, response, rationale — for an agent summarizing/comparing fetched documents, so it rewords
instead of reproducing source passages), and **Search triggering at low effort** (the one-paragraph system line for
`effort: low`, where a confidently-recognized name may still be stale and is worth verifying before answering).
Addendum (03:40Z, after both loops aborted at preflight on a two-session host): `light-loop.js`'s `preflightPrompt`
was counting every node/npm process as contention, so Claude Code's and MCP's own ~8 node processes per open session
tripped the >6 threshold on their own. Fixed to count only processes whose command line names a build tool (jest,
tsc, next, turbo, vitest, playwright, webpack, esbuild, docker, matlab, `npm run`/`npm test`) via command-line
inspection (`Get-CimInstance Win32_Process` / `wmic process get commandline`), explicitly excluding Claude Code and
MCP processes, and to require CPU >90% across two samples rather than one. `light-loop-dry-run.mjs` gained three
checks (scenario A) pinning that the preflight prompt names command-line inspection, excludes Claude/MCP processes,
and lists the build-tool set — all green.

## 2026-09-11 — package P5: final pass reordered before the LAST budgeted fix round (major scale)

> Superseded 2026-09-12 — `CFG.finalPassBeforeLastRound` and the single global fix-round `while` loop it
> reordered are gone from the rebuild (`grep -n "finalPassBeforeLastRound" pipeline.js` returns nothing);
> the fix loop is now per-task (inside `runTask`) and Final is one run-level step after every task
> completes. See `## 2026-09-12 — task-loop rebuild` below.

In 9/9 ledger rows where the terminal Final pass found a `major`, `fixRounds` was already at the cap
(`CFG.maxFixRounds`), so the finding could only ever land in `remainingFindings` — it never reached a paid fix round.
Fix: a new `CFG.finalPassBeforeLastRound` flag (default `true`). Inside the fix-round `while` loop, when
`scale === 'major'` and the iteration about to start is the LAST budgeted round (checked on the pre-increment
`round === CFG.maxFixRounds - 1`, i.e. before `round++`) and `fpPlan.run` is true (so `CFG.finalPassWhenNoHighRisk`'s
own skip decision is still respected — the reorder never forces a final pass the flag says should not run), the
engine calls `runFinalPass()` right there, tags every finding it returns `phase: 'Final pass'` /
`origin: 'pre-last-round'`, merges them into `findings` (through the existing `dedupe()`), and re-derives that
round's `toFix` from the merged set before planning and executing the round exactly as before. The terminal
`runFinalPass()` call after the loop — the sign-off read — is untouched and always still runs, so a major-scale run
that reaches this path now pays for the final pass twice (once mid-loop, once at the end); `phaseStats['Final pass']`
already accumulates `agents`/`rawFindings`/`sum` with `+=` across calls, so its ledger row folds both correctly.
**Restructuring note**: `finalPassResult`, `finalPassPlan()` and the `fpPlan` const it computes had to move from
their old spot right after the fix loop to right before the `while` loop — the pre-last-round call needs `fpPlan`
before the loop's first iteration, and every value `finalPassPlan()` reads (`scale`, `riskMap`, `CFG`) is already
settled long before the loop starts, so the move changes nothing about what it decides. This was the only
restructuring the package needed (~30 lines relocated verbatim, no logic rewritten); the loop's shape, round
counter and existing dedupe/merge conventions are unchanged. Dry-run (`P5a`/`P5b`): a major-scale scenario that
forces two fix rounds (scenario G's dispute-and-uphold mechanic) and hands the reader one fresh candidate on its
first `final-pass:read` only (a mock modeling that the terminal re-read would not re-find something round 2 already
fixed) asserts the call order `final-pass:package → fix-plan:r2 → final-pass:package` and that the pre-last-round
finding actually reached a `fix:` agent, not just `remainingFindings`; a matching small-scale scenario with the same
two-round mechanic asserts no `final-pass` call runs at all. Both were run RED against the unfixed engine first (the
reorder assertions failed: the only final-pass calls landed after `fix-plan:r2`, and the finding never reached a
fixer) before the fix, then green after.

**Gap closed**: `endPhase` now takes an `opts` parameter (`{ skipCheckpoint }`); the pre-last-round call inside the
P5 reorder passes `{ skipCheckpoint: true }` so it accumulates `phaseStats['Final pass']` (`sum`/`agents`/
`rawFindings`) as before but does not fire the C1 checkpoint agent a second time for the same phase title. The
terminal `endPhase('Final pass', ...)` call after the loop is unchanged and keeps its checkpoint, so a major-scale
run that hits this reorder now fires exactly one 'Final pass' checkpoint, matching the dry-run invariant "one
checkpoint per ran phase, plus one final".

**Sandbox host-global crash (2026-09-11e, post-P5 Opus re-check)**: a run died on `ReferenceError: Buffer is
not defined` inside `capFableBrief` — the Workflow sandbox that runs `pipeline.js`/`light-loop.js` provides NO
host globals (no `Buffer`, `process`, `require`, `fs`, or Node's ambient `Date`/`Math` beyond stock JS). Both
engines' `utf8ByteLength`/`utf8Truncate` are pure JS (a code-point walk over `for...of`, no `TextEncoder`
either — that trades one unproven host global for another) for exactly this reason. `scripts/dry-run.mjs` and
`scripts/light-loop-dry-run.mjs` now each run a SOURCE SCAN: strip comments, quoted-string bodies and
template-literal literal text from the loaded engine source (walking every `${...}` substitution as real code)
and assert what remains never calls `Buffer.`, `process.`, `require(`, `fs.`, `Date.now(`, `Math.random(`, or
`new Date()`. Each dry-run self-tests the scanner, repro-first, against its own pre-fix `.bak-2026-09-11e` copy
(real `Buffer.from`/`Buffer.byteLength` calls) and asserts it IS flagged there, before asserting the live file is
clean — proof the check would have caught this crash before it shipped, not a vacuous pass.

**Manual check (not wired into any gate)**: `scripts/test-cap-fable-brief.mjs` — standalone UTF-8-safety
assertions for `capFableBrief`/`utf8ByteLength`/`utf8Truncate` (multi-byte and surrogate-pair boundaries). Passes
as of this fix; run it by hand after touching either function, it is not referenced by `dry-run.mjs`,
`light-loop-dry-run.mjs`, or any package script.

## 2026-09-12 — task-loop rebuild

Owner ruling: `pipeline.js` (382 KB / 5,551 lines) was too expensive and too slow for what it proved —
one comparable finished run cost $31.12 / 1h34m; another in-flight run (a 4-file config change) spent
329K tokens / 23 min on planning alone, then 15 agents / 98K tokens through Implement, and produced two
false findings (a "files this run will create" blocker on files that already existed; a wrong SDK
version claim) plus one malformed checkpoint card. Full plan:
`~/.claude/skills/dev-pipeline/docs/superpowers/plans/2026-09-12-task-loop-rebuild.md` (S1-S6 +
Refinements own the design; task lists A1-A17/A10b and B1-B21 implement it). Old engine preserved at
`pipeline.js.bak-2026-09-12`.

Rulings (D1-D6):

- **D1 success test** — a ledger head-to-head over the next 10 small runs: true $/run, wall-clock,
  confirmed-finding rate vs the previous 10 (the engine's own ten-run rule).
- **D2 target shape** — rebuild `pipeline.js` on the superpowers shape (not trim-in-place, not
  light-loop-as-default).
- **D3 bugfix mode** — the same per-task loop plus superpowers' debugging shape: a `root-cause` task
  must finish before any `fix` task, and a `repro-test` must fail on the bug's own wrong value. The four
  bugfix-only features become plan TASK TYPES, not engine phases — one engine, never forked.
- **D4 approach** — task-loop engine, parallel waves, a pipelined per-task chain, Haiku baseline,
  fire-and-forget checkpoints, ledger tags unchanged.
- **D5** — a SEPARATE test-author agent per task; the implementer never writes the test it must pass
  (the `standard` profile; `lean` drops this — see profiles below).
- **D6 UI verify** — kept as a TASK TYPE `ui-verify {url, startCommand, flows[], viewports[], checks[]}`:
  a Sonnet `medium` driver writes and runs the Playwright spec and returns evidence (screenshots,
  console, network, a11y per flow x viewport); the task's own reviewer judges the evidence (Sonnet
  `high`; Fable on HIGH-risk); a blocked/undriven flow is a blocker; the task re-runs after any fix round
  that touches its `files`.

**Shape** (replaces "the ten phases" above): **Baseline** (Haiku — artifact grounding, planned-file
existence check, plan-size caps, bugfix harness-integrity read) -> **task loop** (tasks from
`args.tasks[]` in `dependsOn` order, disjoint-file tasks in parallel waves, per-task chain pipelined:
brief -> test-author -> RED check -> implement -> pack -> review -> fix loop -> fire-and-forget
checkpoint) -> **Final** (full verify suite plus HIGH-risk-only mutation/revert probes and a Fable final
read) -> `result.json`.

**Task contract**: `args.tasks[]` replaces `testPackages`/`packages`/`redGate`:
`{ id, title, files[], tests[] (paths + T# ids), dependsOn[], risk?: 'HIGH'|'LOW', radius?: [before, after],
introducesObservable?: true, type?: 'feature'|'root-cause'|'repro-test'|'fix'|'revert-probe'|'docs'|'ui-verify' }`;
a `revert-probe` task takes singular `file` and `test` strings instead of `files[]`/`tests[]`. `radius` is a
numeric context-line pair passed as `review-pack.mjs --radius <before>,<after>`; a path is a usage error.
**The brief is the `### <id>` heading section of build-plan.md**, sliced by task-brief.mjs into
`tasks/<id>/brief.md`, which is the only brief any agent reads. An inline `tasks[].brief` string is never
read by an agent: the engine only scans it for the INTRODUCES-OBSERVABLE token. `CFG.caps.briefBytes` is
declared but unenforced.
`verifyCommands.{perRound,final}`, `lessonsPath`, `runDir`, `startedAt`, `scale`, `mode`, `workdir`,
`context` stay. Three Node scripts (`dev-pipeline/scripts/{task-brief,review-pack,fix-brief}.mjs`), run
by Haiku agents, slice the plan/test-plan/findings into per-task artifacts under
`<runDir>/tasks/<id>/{brief.md,tests-report.md,report.md,pack.md,review.json,fix-r<N>.md}`.

**Model table (Opus removed as a reviewer/implementer):** Fable 5.1 = session planning, HIGH-risk
reviewer, HIGH-risk implementer (first pass) and executor, fix designer from round 3, final read on
HIGH-risk files; Sonnet 5 = test author, routine implementer, routine reviewer, fix-round 1-2 executor,
re-reviewer on routine files; Haiku 4.5 = baseline gates, the three scripts, the RED check, checkpoints,
the result writer. **Opus 5 is kept only as `CFG.fallbackModel`** for a Fable refusal — it no longer
runs a review lens, the red-gate audit, or a fix by default (task loop: Fable, Opus fallback).

**Profiles** (`CFG.profiles`, `args.profile` overrides): `lean` = superpowers parity — the implementer
writes its own tests and pastes observed RED then GREEN in `report.md`, Baseline is grounding + planned-
file existence + `perRound` commands once (no probes), the reviewer is always Sonnet `high`, and Fable
appears only as the round-3+ fix designer. `standard` = the full shape above (separate test author, full
Baseline, Haiku RED check, HIGH-risk extras, sibling sweep/harness check under `mode:'bugfix'`). Default:
`lean` when `scale:'small'` and no HIGH-risk file (by the tightened risk classifier or an explicit
`tasks[].risk`); else `standard`. Ledger rows gain a `profile` field (null-safe for older rows).

**Bugfix task types** (`mode:'bugfix'`): `root-cause`, `repro-test`, `fix`, `revert-probe`, `docs` (plus
the always-available `ui-verify`); a `fix` depends on both a `root-cause` (must report
`reproduced && causeConfirmed`) and a `repro-test` (RED check is BEHAVIORAL — the failure output must
contain the bug's `wrongValue`). Sibling sweep and the harness-integrity read stay ENGINE steps under
`mode:'bugfix'`, not task types, so bug-pipeline's `siblingPatterns` arg is unchanged.
