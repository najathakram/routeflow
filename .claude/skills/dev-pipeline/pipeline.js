export const meta = {
  name: 'dev-pipeline',
  description: 'Fable-planned, test-first delivery engine. ALL planning is already done by FABLE before this engine starts — the discovery (why/who/cost), spec (R#s), test plan (T#s: oracle, vacuity, mutation) and build plan it executes are Fable-authored artifacts; Sonnet NEVER plans. Here: a Haiku baseline proves the verify commands, grounds the Fable artifacts and builds the risk manifest; Sonnet transcribes the Fable-planned tests into code; a verified RED proves they can fail; Sonnet implements to the Fable build plan; then the review lenses run through lessons-fed lenses (deep lenses — correctness, spec-compliance, edge-cases-and-security, operability — on Opus 5, xhigh only on a HIGH-risk file; pattern lenses — test-quality, design-system, scope-coverage — on Sonnet 5 at high), refute lazily (Sonnet 5 for a routine finding, Opus 5 only for a blocker/major finding on a HIGH-risk file), judge the UI a Sonnet driver exercised (Sonnet 5 unless the manifest has a HIGH-risk file), mutation-probe on Sonnet 5, and execute HIGH-risk fixes on Opus 5 — TOKEN-CLASS ROUTING, owner ruling 2026-09-10: Opus is reserved for the verdicts the difficulty earns — while Fable 5.1 decides: split votes, the final pass over an Opus read of a Sonnet-built digest, and the design of every fix that Sonnet and Opus implement. Every agent runs at an explicit model AND effort; nothing inherits the interactive session.',
  whenToUse: 'Invoked by the dev-pipeline skill after FABLE has authored the planning artifacts (S1-S5: the why/what/proof questions — see the skill MODEL POLICY; planning is never Sonnet or Haiku). args: { planPath, discoveryPath?, specPath?, uxSpecPath?, testPlanPath?, designSystemPath?, lessonsPath?, startedAt?, scale, workdir, context, testPackages?, redGate?, packages, verifyCommands, uiVerify?, mutationProbe?, formatCommand?, fixPlanning?, mode?, radiusFiles?, siblingPatterns? }. mode: \'bugfix\' selects the bug-fix preset (behavioral red bar, radius pack, harness check, sibling sweep, fix-revert probes); absent or anything else is the default \'feature\' preset. Corroboration-skip in Verify (owner ruling 2026-09-11, CFG.skipRefuteOnCorroborated) applies in BOTH modes, not a bugfix-only behaviour.',
  phases: [
    { title: 'Baseline', detail: 'Haiku runs the verify commands against the untouched tree to find broken ones, ground-checks every FABLE-authored planning artifact against the repo, and builds the context manifest: changed/planned files, each with a HIGH or LOW risk class', model: 'claude-haiku-4-5' },
    { title: 'Author tests', detail: 'Sonnet transcribes the FABLE-authored test plan into failing tests in conflict-free waves — Sonnet plans nothing: a gap in the plan is raised as a finding, never improvised; implementation code is forbidden', model: 'claude-sonnet-5' },
    { title: 'Red gate', detail: 'run the new tests and audit the RED at two levels: STRUCTURAL (every test fails on an assertion, none pass/error/skip — remediated once if not) and BEHAVIORAL (each fails on its own expected value — a shortfall is recorded and proven later by probing every mutation target)', model: 'claude-opus-5' },
    { title: 'Implement', detail: 'Sonnet engineers execute the FABLE build plan, one per work package, in conflict-free waves — deviations are reported, not decided', model: 'claude-sonnet-5' },
    { title: 'Gate & Review', detail: 'Haiku build/test gate FIRST — one build-fix agent and a re-gate on failure — then the review lenses over the integrated diff, carrying the project lessons register, at a depth set by the risk class of the files: deep lenses on Opus 5 (xhigh only with a HIGH-risk file), pattern lenses (test-quality, design-system, scope-coverage) on Sonnet 5 at high', model: 'claude-opus-5 + claude-sonnet-5' },
    { title: 'Verify', detail: 'lazy adversarial refutation (major scale): one refuter per finding, on Sonnet 5 at high unless the finding is a blocker/major on a HIGH-risk file (then Opus 5); a second refuter and the Fable tie-break only when the first one refutes. Runs beside UI verify', model: 'claude-sonnet-5 + claude-opus-5' },
    { title: 'UI verify', detail: 'Playwright-driven (fallback: browser MCP) exercise of the real UI at every viewport — a Sonnet driver, then a Sonnet judge unless the manifest has a HIGH-risk file (then Opus 5). Runs beside Verify', model: 'claude-sonnet-5 (claude-opus-5 with a HIGH-risk file)' },
    { title: 'Mutation probe', detail: 'one deliberate defect per target must turn its test RED, then restore-and-verify (major scale only; every target when the red gate had a behavioral shortfall) — mechanical with one judgment call, on Sonnet 5', model: 'claude-sonnet-5' },
    { title: 'Fix', detail: 'a Sonnet brief (excerpts + call sites, read-only) then ONE Fable 5.1 decision over every finding in the round — fix / dispute / defer, the design, the invariant, the test, the executor tier and the waves — and executors that implement the design instead of improvising: mechanical on Sonnet @ low, designed LOW-risk on Sonnet @ medium, HIGH-risk files and broad synthetic keys on Opus 5 @ high; a design that does not fit comes back as designMismatch and Fable re-decides it; then a scoped re-check beside the dispute slate; the final full gate runs beside the Final pass', model: 'claude-opus-5' },
    { title: 'Final pass', detail: 'Fable 5.1 adversarial pass over the HIGH-risk files of the finished diff (major scale, skipped and recorded when the diff has no HIGH-risk file; retried once on Opus if Fable declines): hunts what the Opus lenses missed; anything found lands in remainingFindings and keeps clean false', model: 'claude-fable-5-1' },
  ],
}

// ══════════════ CONFIG — every tuning knob lives here ══════════════
const CFG = {
  // MODELS — full ids, never bare aliases: an alias resolves to whatever the harness
  // currently maps it to (a bare 'sonnet' can land on the pricier Sonnet 4.6).
  testModel: 'claude-sonnet-5',        // test authors
  implementModel: 'claude-sonnet-5',   // implementation engineers
  reviewModel: 'claude-opus-5',        // review lenses, refuters, red auditor, UI verifier, mutation probes, fixers
  // FABLE IS THE BRAIN, NEVER THE HANDS (owner ruling 2026-09-03): Fable does no
  // reading, gathering or long writing in this engine — it DECIDES from briefs
  // that Sonnet and Opus prepare. It helps the review at exactly two points
  // (owner policy 2026-08-31, amended 2026-09-02/03): the tie-break judge on a
  // split refutation vote (decides from the refuters' cited evidence, opens no
  // file), and the FINAL PASS decider on a major diff with HIGH-risk files: a
  // Sonnet packager gathers the diff, an Opus reader does the adversarial read
  // and produces candidates with evidence, and Fable rules on the candidates —
  // real or not, severity, and where the reader must look again if its coverage
  // was thin (one focused re-read, then a final decision).
  tieBreakModel: 'claude-fable-5-1',
  finalPassReaderModel: 'claude-opus-5',
  finalPassModel: 'claude-fable-5-1',
  // Fable's safety classifiers can decline a request outright (it surfaces here as
  // a dead agent). An unadjudicated last read is never clean, so the decision is
  // retried once on this model and the result records who actually decided.
  finalPassFallbackModel: 'claude-opus-5',
  // 'skip' (default, owner ruling 2026-09-02): a major diff with NO HIGH-risk file
  // gets no final pass — its rationale (money/tenancy/authorization edges between
  // packages) does not apply, and the old fallback quietly read the WHOLE diff at
  // Fable prices. 'opus' = read the whole diff on finalPassFallbackModel instead.
  // 'fable' = the old behaviour. Whatever happens is recorded in finalPass.skipped.
  finalPassWhenNoHighRisk: 'skip',
  gateModel: 'claude-haiku-4-5',       // mechanical command-runner (build/test/lint/red-run/manifest)
  // C1 CHECKPOINTS (plan Part 3 §C1): a Haiku agent writes a durable phase card
  // after every endPhase, so a dead session resumes from the last one instead of
  // losing the whole run. It never decides anything — it writes the JSON it is
  // handed, verbatim, and (once per run) makes the snapshot commit.
  checkpointModel: 'claude-haiku-4-5',
  // Fixes whose content is fully determined once the defect is named. Anything
  // needing a decision about what the code SHOULD do stays on reviewModel.
  mechanicalFixModel: 'claude-sonnet-5',
  // FIX PLANNING (owner ruling 2026-09-03): Fable DECIDES every fix in a round, in
  // one pass, from a brief a Sonnet agent builds — it reads no file and runs no
  // command. Executors then implement the design and never improvise: a design that
  // does not fit the code comes back as `designMismatch` and Fable re-decides it
  // next round. false — or args.fixPlanning === false for one run — restores
  // exactly today's per-group routing (fixRoute: mechanical vs judgment).
  fixPlanning: true,
  fixBriefModel: 'claude-sonnet-5',        // builds the brief (excerpts + callers), read-only
  fixPlannerModel: 'claude-fable-5-1',     // decides
  fixPlannerFallbackModel: 'claude-opus-5',// decides if Fable declines (a dead agent), at xhigh
  // The DESIGNED-fix executor tier: a planned change on a LOW-risk file. Same model
  // as the mechanical fixer, one tier of effort above it (it implements a design
  // rather than transcribing a named defect). HIGH-risk files and broad synthetic
  // keys are upgraded to reviewModel BY THE ENGINE, whatever the planner says.
  fixExecuteSonnetModel: 'claude-sonnet-5',
  // Breadth pass over the LOW-risk partition — used ONLY when cascadeReview is on.
  cascadeModel: 'claude-sonnet-5',
  // ── BUGFIX MODE (args.mode === 'bugfix') — the same engine, one preset. Every
  // agent below runs ONLY in that mode; feature mode never launches them.
  // radius pack: the diff hunks, touched export signatures and call sites of the
  // files the fix changes, gathered once so every review lens reads the evidence
  // instead of re-deriving it. Mechanical gathering — the cheap tier.
  radiusPackModel: 'claude-sonnet-5',
  // harness check: the existing specs' mocks and fixtures against the service-surface
  // changes the build plan names. F13's costliest blocker cascade was ONE stale mock
  // that six review lenses each reported independently, after the fact.
  harnessCheckModel: 'claude-sonnet-5',
  // sibling sweep: grep the defect's SHAPE across the repo (mechanical), then judge
  // each hit (a decision — it runs on reviewModel).
  siblingGrepModel: 'claude-sonnet-5',
  // Output-token list prices per MTok [input, output] used ONLY to estimate what
  // each phase cost (phaseReport[].estUsd). Refresh from the claude-api skill's
  // "Current Models" table and bump asOf; an estimate at stale prices is labelled.
  prices: {
    asOf: '2026-06-24',
    'claude-fable-5-1': [10, 50],
    'claude-opus-5': [5, 25],
    'claude-sonnet-5': [2, 10],
    'claude-haiku-4-5': [1, 5],
  },
  lenses: {
    small: ['correctness', 'test-quality'],
    major: ['correctness', 'spec-compliance', 'test-quality', 'edge-cases-and-security', 'operability', 'scope-coverage'],
    // 'design-system' is appended below when uxSpecPath or designSystemPath is present.
  },
  // On `small`, run ONE reviewer carrying every base lens brief instead of one
  // agent per lens. Reviewer independence is worth paying for on a large diff,
  // not on one or two files. The conditional 'design-system' lens stays its own
  // agent, and a dead merged agent still blocks on BOTH lens names.
  mergeLensesOnSmall: true,
  // Adversarial verifiers per finding. A finding is dropped only if ALL
  // refuters ran AND all of them refuted it (conservative: better to fix a
  // maybe-real issue than silently drop a blocker; a dead refuter is
  // no-evidence, never a refutation). 0 = skip the Verify phase.
  refuteVotes: { small: 0, major: 2 },
  // LAZY SECOND VOTE (owner ruling 2026-09-02). Measured refute rates are 1–12%
  // of votes, yet every refutable finding paid the full slate up front (F06: 35
  // votes, 2 refutations, ~22% of the run's tokens). Now the first refuter votes
  // alone; the remaining votes — and the Fable tie-break — are cast ONLY when it
  // says refuted. The drop rule is unchanged: a finding is discarded only when
  // the full slate ran and agreed (or the judge ruled), so a first vote to keep
  // ends the matter exactly as two votes to keep did before.
  lazySecondVote: true,
  // VERIFY ON DISPUTE (owner ruling 2026-09-02, evening). Pre-verifying every
  // finding paid ~30 Opus refuters per run to overturn one or two (F13 on the
  // lazy slate: 30 first votes, 2 refuted; F06 before it: 35 votes, 2 refuted).
  // Now only findings where a WRONG FIX is expensive get an independent slate
  // before the fixer: those on HIGH-risk files, plus any finding whose cited
  // location does not check out. Everything else goes to the fixer, which
  // REFUTES FIRST and marks what it disputes; disputed findings then get the lazy
  // Opus slate (and the Fable tie-break) before anything is dropped. The drop
  // rule never changes: two Opus refuters agree, or the judge rules. Sonnet's
  // only part is the mechanical location check — it never casts a vote.
  verify: {
    mode: 'on-dispute',   // 'on-dispute' | 'all' (pre-refute every refutable finding, as before)
    // ONE cheap agent checks every finding's cited location up front; a finding
    // that cites code that is not there is pre-refuted whatever its risk class.
    locationCheck: true,
    // Pre-refutation is batched: ONE refuter per FILE judges every finding on
    // that file (one read of the plan, the prefix and the file instead of N).
    // Independence comes from the escalation, not from the first vote.
    batchPerFile: true,
  },
  locationCheckModel: 'claude-sonnet-5',
  // UI VERIFY is two agents (owner ruling 2026-09-03): a Sonnet DRIVER writes and
  // runs the Playwright spec and captures the evidence (screenshots, console,
  // network, a11y, per flow and viewport) as facts; an Opus JUDGE reads that
  // evidence and the screenshots and decides what is a defect. Driving is
  // transcription of the UX spec's flows; the verdict stays on the review model.
  uiDriverModel: 'claude-sonnet-5',
  // FINAL PASS gets a Sonnet PACKAGER: the complete diff hunks of the HIGH-risk
  // files plus the call sites of every changed export, written to one digest
  // Fable reads first. Fable's 87k-token F14 pass was mostly context gathering,
  // which it over-does at higher effort; the read and the verdict stay on Fable.
  finalPassPackagerModel: 'claude-sonnet-5',
  // RED GATE VERDICT (owner ruling 2026-09-02). The audit reports two levels:
  // STRUCTURAL (every new test fails on an assertion — none passes, errors, or is
  // skipped) and BEHAVIORAL (each test fails on its OWN expected value, not on a
  // stub's uniform `undefined`). Two of three measured runs (F06, F14) failed only
  // the behavioral bar, burned the remediation round without changing the outcome,
  // and were proven by the mutation probe instead. So on 'structural' the
  // remediation round and the blocker fire only for a structural failure; a
  // behavioral shortfall becomes a minor `(red-gate)` note and forces the mutation
  // probe over EVERY target (major scale — small has no probe, so it keeps the
  // full 'behavioral' bar). 'behavioral' = the old rule at both scales.
  redGate: { remediateOn: 'structural' },
  // MEASURED TRADE, OFF: start implementation wave 1 while the red audit runs.
  // Saves the audit's wall-clock; costs a wasted wave when the audit finds a
  // requirement already satisfied. overlap.redAudit records what happened so the
  // flag can be judged from the ledger before it is ever defaulted on.
  overlapImplementWithRedAudit: false,
  // WHICH findings are worth two Opus refuters. Refutation exists to stop a
  // fixer mutating working code on a false positive — that risk is real for a
  // money/auth/tenancy claim and negligible for a stale comment or a naming nit,
  // where a wrong fix costs less than the agents spent avoiding it. Measured on
  // a real major run (F06, 2026-09-01): 35 votes cast, 2 refutations, ~22% of
  // the whole run's tokens, and 13 of the 22 raw findings were minor. So: refute
  // by severity, and ALWAYS refute anything on a HIGH-risk file whatever its
  // severity (that is where a wrongly-dropped finding is expensive). Everything
  // else goes straight to the fix loop, where the scoped re-check still catches
  // a bad fix. Set to ['blocker','major','minor'] to restore refute-everything.
  refuteSeverities: ['blocker', 'major'],
  maxFixRounds: 2,
  // P5 (owner ruling 2026-09-11e): in 9/9 ledger rows where the terminal final
  // pass found a major, fixRounds was already at the cap, so the finding never
  // got a paid fix — only remainingFindings. On major scale, when the iteration
  // about to run is the LAST budgeted round, run the final pass FIRST and fold
  // its findings into that round instead of only reading the diff after the
  // loop is already over. The terminal final pass (the sign-off read) is
  // unaffected and always still runs.
  finalPassBeforeLastRound: true,
  // Exactly ONE remediation round is allowed on broken/vacuous tests before
  // implementation starts. More than one means the test plan is wrong, not the tests.
  maxTestRemediationRounds: 1,
  // Runtime cap: never have more than this many agents in flight at once.
  maxConcurrent: 16,
  // When the user set a "+Nk" token budget, don't open a new fix round
  // with fewer than this many tokens remaining.
  budgetFloor: 30000,
  // EFFORT — a per-role decision made HERE. No agent inherits the interactive
  // session's effort: subagents inherit it by default, so a Fable session at
  // xhigh/max used to run every Opus lens, fixer, probe and the Fable final pass
  // at xhigh/max too (12 of 25 call sites had no ceiling). Effort drives thinking
  // tokens AND turn duration, so every ceiling below is a cost and a speed lever;
  // depth where a miss is expensive (HIGH risk) is the one place it steps up.
  // `high` is the API's and Claude Code's default; `xhigh` is reserved; `max`
  // is never a default. Uniform effort inside one fan-out also lets the harness
  // share the prompt-prefix cache across those agents.
  effort: {
    gate: 'low',
    manifest: 'low',
    checksum: 'low',
    grounding: 'low',
    mechanicalFix: 'low',
    // FIX PLANNING. The brief is mechanical gathering (excerpts + call sites); the
    // plan is the round's one real decision, so it takes the Fable default; the
    // fallback decider gets xhigh because it is deciding without Fable. A designed
    // fix on a LOW-risk file is a transcription of Fable's design, hence medium.
    fixBrief: 'low',
    fixPlan: 'high',
    fixPlanFallback: 'xhigh',
    fixExecuteSonnet: 'medium',
    // Sonnet TRANSCRIBES Fable's test plan and build plan; medium first, and the
    // Opus build-fix agent is the escalation when a gate fails. A plan may still
    // raise one package to high (or another model) with its own effort/model.
    tests: 'medium',
    // A9 (CFG.cheapFirst): the FIRST attempt at an unrisen package, before any
    // plan-set effort override. A package that comes back not "done" is rerun
    // once at `tests` (above) — never a third attempt.
    testsCheap: 'low',
    implement: 'medium',
    // "Never tiered down" now means never below the Opus default. It is the
    // evidence that the tests can fail.
    redAudit: 'high',
    // R1 CALIBRATION: test-remediation now runs on CFG.routing.testRemediationModel
    // (Sonnet) — medium matches its L2 (transcribe/build) level, not the Opus
    // verdict tier it left.
    redRemediate: 'medium',
    // R1 CALIBRATION: build-fix runs on CFG.routing.buildFixRoutineModel (Sonnet)
    // unless the manifest has a HIGH-risk file (buildFixModelFor()) — high either
    // way, since a fully-specified break is the same amount of work regardless of
    // which model reads it.
    buildFix: 'high',
    judgmentFix: 'high',
    // R1 CALIBRATION: recheck runs on CFG.routing.recheckRoutineModel (Sonnet)
    // unless the manifest has a HIGH-risk file (recheckModelFor()) — high either
    // way, matching the L3 routine-verdict tier this role now sits at.
    recheck: 'high',
    // correctness / spec-compliance / edge-cases-and-security / operability read
    // for defects that only show up when you trace the whole path. high on an
    // ordinary diff; xhigh when the manifest classed any file HIGH risk.
    lensDeep: 'high',
    lensDeepHighRisk: 'xhigh',
    // test-quality / design-system / scope-coverage match patterns against a
    // known list. TOKEN-CLASS ROUTING (2026-09-10): these now run on
    // CFG.routing.patternLensModel (Sonnet), not Opus — Sonnet's routine-verdict
    // tier is `high`, not `medium`. Their FILE COVERAGE is never reduced.
    lensPattern: 'high',
    // Refuter effort. TOKEN-CLASS ROUTING (2026-09-10): a routine refuter (no
    // HIGH-risk file, or a HIGH-risk file with nothing worse than a minor
    // finding) now runs on CFG.routing.routineRefuterModel (Sonnet) at `high` —
    // the same "Sonnet does the routine verdict at high" tier as the lenses
    // above. refuteHighRisk (a blocker/major finding on a HIGH-risk file) stays
    // on Opus, where a wrongly-dropped finding is expensive.
    refute: 'high',
    refuteHighRisk: 'high',
    tieBreak: 'high',
    // Mechanical: does the cited code exist where the finding says it does.
    locationCheck: 'low',
    // C1 checkpoint writer: verbatim JSON write (+ once-per-run commit). Floor effort.
    checkpoint: 'low',
    // UI verify: the Sonnet driver authors and runs the spec (careful, not deep);
    // the Opus judge reads the evidence and rules.
    uiDrive: 'medium',
    uiJudge: 'high',
    // Final pass: the Sonnet packager only collects diff hunks and call sites.
    finalPassPackage: 'low',
    // The probe injects one defect and restores by file copy — a mechanical
    // script with one judgment call (which defect). medium.
    mutate: 'medium',
    // A5: the test-author remediation on a surviving mutant is the same tier as
    // authoring tests generally (CFG.effort.tests) — it is a designed test change,
    // not a mechanical script.
    mutationRemediate: 'medium',
    cascadeAudit: 'high',
    // BUGFIX MODE. Three mechanical gatherers at the floor, and one judgment call
    // (which sibling hits are the same defect) one tier above it.
    radiusPack: 'low',
    harnessCheck: 'low',
    siblingGrep: 'low',
    siblingJudge: 'medium',
    // The last read is on Opus at xhigh (where a miss is expensive); the decision
    // is on Fable at high over a compact brief — F14's 87k-token single Fable
    // agent was mostly context gathering, which is no longer Fable's job. The
    // fallback decider (Opus) gets xhigh because it is deciding without Fable.
    finalPassRead: 'xhigh',
    finalPass: 'high',
    finalPassFallback: 'xhigh',
  },
  // ── MEASURED TRADES — unproven, OFF by default. Each one trades evidence for
  // cost, so each ships with the audit field that says whether the trade held.
  // Never flip one on without reading that number from real runs.
  // cascadeReview: Sonnet covers the LOW-risk partition, Opus covers HIGH plus
  // everything Sonnet flagged. Risk: a subtle defect in a LOW-risk file that
  // Sonnet misses is never seen by Opus. Audited by cascadeAudit.missedFindings.
  cascadeReview: false,
  // densityEscalation: if the floor lenses find nothing on a green, small diff,
  // skip the remaining lenses. Risk: defects the floor lenses do not look for.
  // Audited by escalation.lensesSkipped.
  densityEscalation: false,
  // The stated size threshold for densityEscalation. A bigger diff never
  // escalates, and an UNKNOWN size counts as over the threshold.
  densityThreshold: { files: 8, changedLines: 400 },
  // C1 CHECKPOINTS. enabled requires args.runDir too (see endPhase) — no runDir,
  // no checkpoints, and the legacy call shape is byte-identical. snapshotCommit
  // gates the ONE per-run `wip(pipeline):` commit at the first green Gate & Review;
  // it never pushes and it refuses on main/master. maxSummaryKb bounds the FINAL
  // checkpoint's result.json (details live in the per-phase files, not there).
  // payloadFindingChars bounds each one-line finding summary a phase card carries
  // — never `detail`, which can be arbitrarily long.
  checkpoint: { enabled: true, snapshotCommit: true, maxSummaryKb: 32, payloadFindingChars: 200 },
  // TOKEN-CLASS ROUTING (owner ruling 2026-09-10). Measured on a 113-agent run
  // ($205 total): Opus $180 — of which $109 was cache READS (219M tokens) plus
  // $67 cache WRITES and only $2.70 output; Fable $11, almost entirely cache
  // writes for a ~20-token reply; Sonnet $11.50 for ALL of the run's volume. The
  // rule this run bought: Fable = cache work only — short rulings over a compact
  // brief (CFG.caps.fableBriefBytes); Sonnet = all the in/out — reading, writing,
  // packing, and routine verdicts, at `high`; Opus = verdicts the difficulty
  // actually earns (a HIGH-risk file, a blocker/major refutation there, the
  // red-gate audit, the final-pass read, security, HIGH-risk fix execution) read
  // over a compact pack under a tool-call cap (CFG.caps.opusToolCalls); Haiku =
  // mechanics. highRiskOnlyOpus records the one thing that is allowed to escalate
  // a routine role back to Opus: a HIGH-risk file (or a blocker/major finding on
  // one) — never scale or lens name alone. A demotion that drops a phase's
  // confirmed findings over ten true-telemetry runs (see pipeline-ledger.mjs
  // routingScorecard) is reverted.
  routing: {
    patternLensModel: 'claude-sonnet-5',    // test-quality / design-system / scope-coverage lenses
    routineRefuterModel: 'claude-sonnet-5', // refuters on a non-HIGH-risk file, or a minor finding even on one
    probeModel: 'claude-sonnet-5',          // mutation probe: inject a defect, restore, one judgment call
    uiJudgeModel: 'claude-sonnet-5',        // UI verdict when the manifest has no HIGH-risk file
    highRiskOnlyOpus: true,
    // R1 CALIBRATION (owner ruling 2026-09-11, ROUTING-PLAN.md §9b — 23 engine
    // runs / 1,342 agent-calls). Three roles the scorecard showed paying Opus
    // prices for a Sonnet-shaped decision: test-remediation ($3.51/call vs
    // $1.10 for sibling labels — always Sonnet, no risk gate), recheck (always
    // Opus, $109/run — more than the final-pass read; Sonnet unless the
    // manifest has a HIGH-risk file), build-fix ($6.09/call for a fully
    // specified break; Sonnet-first, Opus only on a HIGH-risk file). The
    // correctness lens (A4) is the deliberate exception and is NEVER routed
    // through these — see unitModel()'s assertion.
    testRemediationModel: 'claude-sonnet-5',
    recheckRoutineModel: 'claude-sonnet-5',
    buildFixRoutineModel: 'claude-sonnet-5',
  },
  // INPUT / TURN CAPS (owner ruling 2026-09-10). Every Opus prompt in this engine
  // (lenses, refuters, the red-gate audit, the final-pass reader, judgment
  // fixers) carries a standing clause capping it to opusToolCalls tool calls
  // before it must stop and report `needsMoreContext` — Opus reads the pack
  // Sonnet already built, it does not re-discover the repo. Every Fable prompt
  // (the fix planner, the final-pass decider, the tie-break judge) gets its
  // brief truncated to fableBriefBytes, with a marker, when a packager handed it
  // too much. packBytes bounds the packs/digests Sonnet builds for those two
  // roles to read.
  caps: { opusToolCalls: 12, fableBriefBytes: 8192, packBytes: 40960 },
  // A2 EXECUTION-VERIFIED CONFIRMED (owner ruling 2026-09-11, skills-upgrade
  // ruling §A2 — ADOPT NOW). A lens finding is 'plausible' by default; it
  // becomes 'execution' when a fixer's verifiedFixes entry (a named test, red
  // on the original tree, green on the patched one) is corroborated by that
  // round's own independent re-gate, or 'ruled' when Fable's fix-plan decision
  // confirms it from cited evidence for a finding with no runnable check.
  // confirmedByPhase and confirmedFindings count 'execution' + 'ruled' only;
  // 'plausible' survivors are listed separately in resultObj.plausibleFindings.
  // false restores the old behaviour byte-for-byte: every survivor of
  // refutation counts as confirmed, and plausibleFindings is always empty.
  executionVerified: true,
  // A3 SKIP REFUTATION ON INDEPENDENT AGREEMENT (owner ruling 2026-09-11,
  // skills-upgrade ruling §A3 — ADOPT NOW). A finding 2+ independent lenses
  // reported (corroborationCount(f) >= 2, from the SAME dedupe/cluster output
  // that produces corroboratedBy) is not the kind a refuter overturns — it
  // bypasses the pre-refutation slate entirely and goes straight to the
  // refute-first fixer, exactly like a bugfix-mode radius-pack finding always
  // has. Previously this only ran in bugfix mode (`bugfix ? ... : []`); this
  // flag makes it the general rule in feature mode too. A mis-cited finding is
  // STILL pre-refuted whatever its corroboration — the location signal costs
  // nothing and corroboration is not evidence for a citation that does not
  // check out. false restores exactly the old bugfix-only gate.
  skipRefuteOnCorroborated: true,
  // A5 MUTANT FEEDBACK WITH ACCEPTANCE BAR (owner ruling 2026-09-11, skills-upgrade
  // ruling §A5 — ADOPT NOW). A surviving mutant (a probe whose named test did NOT
  // catch the injected defect) returns to ONE Sonnet test-author for ONE
  // remediation round; the test it adds/strengthens is kept ONLY if a re-probe of
  // the SAME mutation shows it now caught AND the gate stays green
  // (mutationAcceptanceBar: 'kills-mutant') — otherwise it is reverted from the
  // backup the remediator is required to take, and the round is recorded either
  // way in mutationResult.remediation. false skips this entirely (today's
  // behaviour: a surviving mutant is only ever a finding, never remediated here).
  mutationRemediate: true,
  mutationAcceptanceBar: 'kills-mutant',
  // A6 FLAKY QUARANTINE AT THE GATE (owner ruling 2026-09-11, skills-upgrade
  // ruling §A6 — ADOPT NOW). On a gate failure whose report names the specific
  // failedTests, spend this many EXTRA reruns of exactly the failing command(s)
  // on the SAME, unmodified tree. A test that fails in SOME but not ALL of those
  // reruns is flaky: recorded in result.quarantined[] (name, runs, failures) and
  // excluded from the red-bar/fix trigger — but it never counts as green either,
  // so a command is only forced to pass:true once EVERY one of its originally-
  // failing tests is accounted for as flaky or non-reproducing; a test failing
  // every rerun is left exactly as reported, a genuine blocker. 0 = off: a gate
  // failure is trusted on the first read, exactly as before A6.
  flakyReruns: 3,
  // A8 CACHE DISCIPLINE DEFAULTS (owner ruling 2026-09-11, skills-upgrade ruling
  // §A8 — ADOPT NOW). cacheWarmup: one trivial agent per DISTINCT model about to
  // be used in a lens wave, run to completion and discarded before the real
  // fan-out — its only job is writing the shared RUN_PREFIX into that model's
  // cache so every real agent in the wave reads warm instead of each writing
  // its own copy (measured: a fan-out launched in the same instant showed
  // cache_read=0 on every agent). uniformLensEffort: every unit in ONE lens
  // wave shares the DEEPEST effort any OTHER UNIT ON THE SAME MODEL would have
  // used alone (corrected 2026-09-11c, C1 — was per-wave, now per model family,
  // since prompt caches never cross models and per-wave could push a Sonnet
  // pattern lens up to an Opus deep lens's xhigh it never earned). Model
  // routing (unitModel/DEEP_LENSES) is untouched, only the effort number.
  // false on either restores exactly today's behaviour (no warmer; each unit's
  // own unitEffort()).
  cacheWarmup: true,
  uniformLensEffort: true,
  // A9 RUN CHEAP, RERUN FAILURES (owner ruling 2026-09-11, skills-upgrade ruling
  // §A9 — ADOPT NOW). Author-tests packages run at CFG.effort.testsCheap first;
  // only a package that comes back NOT "done" is rerun, once, at the ordinary
  // default (CFG.effort.tests) — the rerun's result is authoritative either way.
  // A package the plan itself gave an explicit effort is never cheapened (a
  // plan's own call overrides this knob, exactly as it already overrides
  // CFG.effort.tests). rerunCount is recorded on testAuthoring. Gates and other
  // already-floor ('low') mechanical steps have no cheaper tier to run at, so
  // this knob has no further effect there today — it exists so a future role
  // that gains a real cheap/default split does not need a new flag.
  cheapFirst: true,
}
// A3 HARD CAPS (owner ruling 2026-09-11): corroboration-skip removes a
// pre-refutation safety net for the findings it applies to, so these ceilings
// are ENFORCED here, not just documented in a comment. maxFixRounds ≤ 3 on
// major scale; refuteVotes ≤ 2 automated votes per finding (a split first/
// second vote always resolves on Fable's tie-break — never a third automated
// refuter round; see judgeFindings()). A run that wants more must raise the
// cap here deliberately, not drift past it silently.
if (CFG.maxFixRounds > 3) throw new Error(`A3 hard cap: CFG.maxFixRounds is ${CFG.maxFixRounds}, must be <= 3`)
for (const k of Object.keys(CFG.refuteVotes)) {
  if (CFG.refuteVotes[k] > 2) throw new Error(`A3 hard cap: CFG.refuteVotes.${k} is ${CFG.refuteVotes[k]}, must be <= 2 automated votes (a split goes to Fable's tie-break, never a third automated round)`)
}
// ═══════════════════════════════════════════════════════════════════

// The Workflow runner may deliver `args` as a JSON string (scriptPath mode) or
// as an object — normalize so destructuring works either way.
const _args = typeof args === 'string' ? JSON.parse(args) : (args || {})
const {
  planPath,
  discoveryPath = '',
  specPath = '',
  uxSpecPath = '',
  testPlanPath = '',
  designSystemPath = '',
  // The project's lessons register (`.claude/lessons/LESSONS.md` where one exists).
  // Every reviewer, refuter, fixer and the final pass carry it: the rules a project
  // has already paid for are the cheapest quality it can buy.
  lessonsPath = '',
  // ISO timestamp the orchestrator took when it launched the run. Scripts cannot
  // read the clock (it would break resume), so wall-clock is measured outside and
  // this is only echoed back into the result for the ledger.
  startedAt = '',
  packages = [],
  testPackages = [],
  scale = 'small',
  verifyCommands = [],
  context = '',
  workdir = '',
  // C1 checkpoints: absolute path a Haiku agent writes phase cards and the final
  // result summary into. Absent (the default) = the legacy, checkpoint-free path.
  runDir = '',
} = _args
// args.fixPlanning === false turns the Fable fix planner OFF for THIS run (the fix
// loop then routes exactly as it did before the planner existed: mechanical fixes
// on the cheap model, everything else on the review model). Any other value — and
// an absent key — leaves CFG.fixPlanning in charge. It is a per-run escape hatch,
// never a way to turn the planner ON where CFG has it off.
const fixPlanningOn = !!CFG.fixPlanning && _args.fixPlanning !== false

// ONE ENGINE, TWO PRESETS (owner ruling 2026-09-03). args.mode === 'bugfix' is what
// the bug-pipeline skill passes; anything else — including an absent key — is
// 'feature', which is byte-identical to the engine before this preset existed.
// EVERY bugfix behaviour below is gated on this flag and nothing else.
const MODE = _args.mode === 'bugfix' ? 'bugfix' : 'feature'
const bugfix = MODE === 'bugfix'

if (!planPath) throw new Error('args.planPath is required (path to the Fable-authored build plan)')
if (!Array.isArray(packages) || !packages.length) {
  throw new Error('args.packages must be a non-empty array of { id, title, files, brief }')
}

// verifyCommands: a plain array runs the same commands every gate round (legacy).
// {perRound: [...], final: [...]} runs the cheap set on the initial gate and every
// fix-round regate, then one authoritative FULL gate after the loop — the full
// suite still decides `clean`, it just stops re-running on every intermediate round.
const vc = Array.isArray(verifyCommands)
  ? { perRound: verifyCommands, final: verifyCommands }
  : {
      perRound: verifyCommands.perRound || [],
      final: verifyCommands.final || verifyCommands.perRound || [],
    }

// New optional stages. Each is skipped entirely when its arg is absent, so a
// legacy { planPath, packages, scale, verifyCommands, context, workdir } call
// runs exactly as it did before (plus the new review lenses).
const testPkgs = Array.isArray(testPackages) ? testPackages : []
const redGateCfg = _args.redGate && Array.isArray(_args.redGate.commands) && _args.redGate.commands.length
  ? { commands: _args.redGate.commands, expect: _args.redGate.expect || 'fail' }
  : null
// Presence of the object is the whole switch — nothing inside it is required.
// uiDrivePrompt already derives a missing url from the repo's dev-server config
// and defaults an empty flow list to "the surface this change touches". Rejecting
// the config because one key was omitted would hand back a browser-less run that
// can still report clean, with nothing in the output saying the phase was skipped.
const uiCfg = _args.uiVerify && typeof _args.uiVerify === 'object' && !Array.isArray(_args.uiVerify)
  ? _args.uiVerify
  : null
const mutationTargets = _args.mutationProbe && Array.isArray(_args.mutationProbe.targets)
  ? _args.mutationProbe.targets.filter((t) => t && t.file && t.test)
  : []
const mutationEnabled = scale === 'major' && mutationTargets.length > 0

// ---------- bugfix-mode inputs (all inert in feature mode) ----------
// The blast radius the review lenses are pointed at. Default: the union of every
// package's declared files — the TEST packages' as well as the work packages'. The
// pack is handed to the lenses as PRIMARY EVIDENCE, and a pack that omitted the new
// spec files would tell the test-quality lens that the tests are outside its evidence.
const radiusFiles = bugfix
  ? uniquePaths(
      Array.isArray(_args.radiusFiles) && _args.radiusFiles.length
        ? _args.radiusFiles
        : [].concat(...testPkgs.map((p) => p.files || []), ...packages.map((p) => p.files || [])),
    )
  : []
// Regexes naming the SHAPE of the defect being fixed (Fable's ruling in the bug
// skill authors them). Absent = no sweep, in either mode.
// Every real caller since 2026-09-08 passes {regex, note} objects, not {pattern,
// note} (see .claude/pipeline/2026-09-08-numbering-siblings/pipeline-args.json) —
// the old filter kept only a literal .pattern string and silently dropped every
// one of those, so 4/4 bugfix runs on 2026-09-10 never swept. Normalise both
// shapes to {pattern, note}; an entry with neither is dropped here and counted
// in the supplied-vs-kept mismatch check below (never a silent skip).
const rawSiblingPatterns = Array.isArray(_args.siblingPatterns) ? _args.siblingPatterns : []
const siblingPatterns = rawSiblingPatterns
  .map((p) => {
    if (!p || typeof p !== 'object') return null
    const src = typeof p.pattern === 'string' && p.pattern.trim() ? p.pattern : (typeof p.regex === 'string' && p.regex.trim() ? p.regex : null)
    return src ? { pattern: src, note: typeof p.note === 'string' ? p.note : '' } : null
  })
  .filter(Boolean)
// Existing spec files whose mocks/fixtures are checked against the plan's
// service-surface changes BEFORE a test author touches them.
const harnessFiles = bugfix ? uniquePaths([].concat(...testPkgs.map((p) => p.files || []))) : []
const wantRadiusPack = bugfix && radiusFiles.length > 0
const wantHarnessCheck = bugfix && harnessFiles.length > 0
const wantSiblingSweep = bugfix && siblingPatterns.length > 0
// mutationProbe.targets[].revertFix is a bugfix-mode field: it asks the probe to put
// the FIX back to its committed content instead of inventing a defect. In feature mode
// there is no fix to revert, so it is ignored — loudly, never silently.
if (!bugfix && mutationTargets.some((t) => t.revertFix === true)) {
  log('Note: mutationProbe.targets[].revertFix is a BUGFIX-MODE field — this run is in feature mode, so every target gets the standard mutation probe')
}

let lenses = (CFG.lenses[scale] || CFG.lenses.small).slice()
if (uxSpecPath || designSystemPath) lenses.push('design-system')
const votes = CFG.refuteVotes[scale] || 0

// One review agent per UNIT, not per lens. Off the small-scale merge every unit
// carries exactly one lens, so nothing changes; on `small` the base lenses share
// one agent while the conditional 'design-system' lens keeps its own (it is
// scale-independent and reads different artifacts). unit.lenses is what the
// dead-agent handler names, so a merged agent that dies blocks on every lens it
// was carrying.
// Rebuilt, not mutated, when bugfix mode gates a lens off after Baseline — the
// unit list and the lens list must never disagree about what ran.
const mergeSmall = !!CFG.mergeLensesOnSmall && scale === 'small'
function buildReviewUnits(lensList) {
  const units = []
  if (mergeSmall) {
    const base = lensList.filter((l) => l !== 'design-system')
    if (base.length) units.push({ label: base.length > 1 ? 'small-combined' : base[0], lenses: base })
    if (lensList.indexOf('design-system') !== -1) units.push({ label: 'design-system', lenses: ['design-system'] })
  } else {
    for (const l of lensList) units.push({ label: l, lenses: [l] })
  }
  return units
}
let reviewUnits = buildReviewUnits(lenses)

// THE FLOOR: these two always run, at full strength, over ALL changed files —
// no flag, no risk class and no escalation may narrow their file coverage.
const FLOOR_LENSES = ['correctness', 'test-quality']
// Lenses that must trace whole paths to find anything keep the session's effort;
// everything else matches patterns and runs at CFG.effort.lensPattern.
const DEEP_LENSES = ['correctness', 'spec-compliance', 'edge-cases-and-security', 'operability']
// A unit carrying several lenses takes the DEEPEST effort any of them needs.
// Deep lenses step up to xhigh only when Baseline classed a file HIGH risk — the
// place a missed defect is expensive. Called only after Baseline (riskSummary is
// filled there); on the small-scale merged unit this means test-quality runs at
// the deep lens's effort, which is documented and accepted.
function unitEffort(unitLenses) {
  if (!unitLenses.some((l) => DEEP_LENSES.indexOf(l) !== -1)) return CFG.effort.lensPattern
  return riskSummary.high > 0 ? CFG.effort.lensDeepHighRisk : CFG.effort.lensDeep
}
// A8 UNIFORM LENS EFFORT (owner ruling 2026-09-11, CFG.uniformLensEffort; CORRECTED
// 2026-09-11c, engine wave 3C, C1: PER MODEL FAMILY, not per wave). Prompt caches
// never cross models, so sharing ONE effort number across every unit in a wave
// only paid off for whichever model family happened to set it — and could
// silently escalate a Sonnet pattern lens to xhigh it never earned, something a
// HIGH-risk wave used to do every time (see the corrected dry-run scenario A and
// the new A8b). Sonnet units carry pattern lenses ONLY (see unitModel/DEEP_LENSES)
// and always resolve to CFG.effort.lensPattern regardless of what the Opus units
// in the same wave need, so in practice this only ever changes anything for the
// Opus family. Returns a Map<model, effort> — one shared (deepest) effort per
// DISTINCT model in the wave, never mixed across models.
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh']
function waveEffortByModel(units) {
  const byModel = new Map()
  for (const u of units) {
    const model = unitModel(u.lenses)
    const e = unitEffort(u.lenses)
    const cur = byModel.get(model)
    if (cur === undefined || EFFORT_ORDER.indexOf(e) > EFFORT_ORDER.indexOf(cur)) byModel.set(model, e)
  }
  return byModel
}
// A8 CACHE WARMUP (owner ruling 2026-09-11, CFG.cacheWarmup). ONE trivial agent
// per DISTINCT model about to be used in a wave, dispatched and awaited BEFORE
// the real fan-out — its result is never read, only its cache write matters.
// opusCapped() is applied unconditionally (a no-op for anything but Opus) so an
// Opus warmer never violates the standing tool-call-cap invariant every other
// Opus prompt in this engine carries.
const WARM_SCHEMA = { type: 'object', properties: { ack: { type: 'string', description: "reply with exactly 'OK'" } }, required: ['ack'] }
async function warmModels(models, phaseName) {
  if (!CFG.cacheWarmup || !models || !models.length) return
  const distinct = [...new Set(models)]
  await parallel(distinct.map((m) => () =>
    askAgent(opusCapped(`${RUN_PREFIX()}\n\nReply with exactly: OK`, m), { label: `warm:${m}`, phase: phaseName, model: m, effort: 'low', schema: WARM_SCHEMA })))
}
// TOKEN-CLASS ROUTING (owner ruling 2026-09-10, CFG.routing). A unit carrying
// any DEEP lens (it has to trace the whole path, not match a pattern) stays on
// Opus, xhigh only kicking in via unitEffort above when a file is HIGH risk. A
// unit carrying ONLY pattern lenses (test-quality / design-system /
// scope-coverage) now runs on the cheaper Sonnet tier instead — same floor
// coverage, same effort ladder, different model.
function unitModel(unitLenses) {
  const hasDeep = unitLenses.some((l) => DEEP_LENSES.indexOf(l) !== -1)
  const model = hasDeep ? CFG.reviewModel : CFG.routing.patternLensModel
  // A4 ASSERTION (owner ruling 2026-09-11): the correctness lens must never be
  // demoted off Opus by ANY calibration routing change — it is the deliberate
  // exception the R1 Sonnet-routing rows do not touch. A future edit that
  // routes 'correctness' through a cheaper model trips this immediately
  // instead of silently shipping.
  if (unitLenses.indexOf('correctness') !== -1 && model !== CFG.reviewModel) {
    throw new Error(`A4 violation: correctness lens routed to ${model}, must stay on ${CFG.reviewModel}`)
  }
  return model
}
// R1 CALIBRATION (owner ruling 2026-09-11, ROUTING-PLAN.md §9b). recheck and
// build-fix default to their CFG.routing.*RoutineModel (Sonnet) and escalate
// to CFG.reviewModel (Opus) ONLY when the manifest carries a HIGH-risk file —
// the same riskSummary.high signal the UI-judge escalation already uses.
function recheckModelFor() {
  return riskSummary.high > 0 ? CFG.reviewModel : CFG.routing.recheckRoutineModel
}
function buildFixModelFor() {
  return riskSummary.high > 0 ? CFG.reviewModel : CFG.routing.buildFixRoutineModel
}
const isFloorUnit = (u) => u.lenses.some((l) => FLOOR_LENSES.indexOf(l) !== -1)
// OPUS TOOL-CALL CAP (owner ruling 2026-09-10, CFG.caps.opusToolCalls). Applied
// at the call site — not baked into a prompt builder — so a role that sometimes
// routes to Sonnet (lenses, refuters, UI judge, judgment fixers) carries the
// clause only on the runs where it actually lands on Opus. The two Fable
// deciders (fix planner, final-pass decider) are deliberately exempt even on
// their Opus fallback: their prompt already says outright "you do not read the
// repository, run commands or gather anything", so a tool-call cap would
// contradict the contract those prompts already carry.
const OPUS_MODEL_ID = 'claude-opus-5'
function opusCapped(promptText, model) {
  if (model !== OPUS_MODEL_ID) return promptText
  return `${promptText}\n\nRead the pack / brief provided. Open a source file only for a hunk the pack cites. Hard cap: ${CFG.caps.opusToolCalls} tool calls; if you need more, stop and report \`needsMoreContext\` with what is missing.`
}
// FABLE BRIEF CAP (owner ruling 2026-09-10, CFG.caps.fableBriefBytes). Fable
// decides from a compact brief and never gathers, so a brief over the cap is
// truncated HERE, in the script, rather than trusted to fit on its own — the
// packager that built it gets the marker as a note to tighten next round.
// Applied to the brief text whichever model actually reads it (Fable, or its
// Opus fallback when Fable declines): it is the same content either way.
// Twin of scripts/light-loop.js's utf8ByteLength/utf8Truncate (kept
// byte-for-byte identical — see the comment there). Buffer-free so a cut
// never lands inside a multi-byte UTF-8 sequence or a surrogate pair.
function utf8ByteLength(s) {
  let n = 0
  for (const ch of s) { const c = ch.codePointAt(0); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4 }
  return n
}
function utf8Truncate(s, maxBytes) {
  let bytes = 0
  let result = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + size > maxBytes) break
    bytes += size
    result += ch
  }
  return result
}
function capFableBrief(promptText) {
  const cap = CFG.caps.fableBriefBytes
  if (utf8ByteLength(promptText) <= cap) return { text: promptText, truncated: false }
  // E6 (owner ruling 2026-09-11, wave 3): the marker names the ACTUAL cap in
  // force, not a hardcoded "8 KB" that silently goes stale the moment
  // CFG.caps.fableBriefBytes is retuned.
  const marker = `\n\n[truncated at ${cap} bytes — packager must tighten]`
  const keepBytes = Math.max(0, cap - utf8ByteLength(marker))
  return { text: utf8Truncate(promptText, keepBytes) + marker, truncated: true }
}

// Findings raised before the review phase (test authoring, red gate) that must
// still reach the fix loop and keep `clean` false.
const carried = []

// Defect (owner ruling 2026-09-11e): args.siblingPatterns supplied>0 with kept===0,
// or supplied!==kept after normalisation (see siblingPatterns above), must never
// read as an ordinary "no-patterns" skip — that hid 4/4 real sweeps on 2026-09-10.
// A '(build-plan)' finding is UNFIXABLE (bypasses the fix loop, keeps `clean`
// false) because the defect is in the args this run was called with, not in code.
// Pushed here (immediately after `carried` exists), not beside the rest of the
// sibling-sweep section below, because `findings.push(...carried)` runs BEFORE
// that section — a later push would silently miss the cutoff, same class of bug
// as the one this whole package fixes.
if (rawSiblingPatterns.length && siblingPatterns.length !== rawSiblingPatterns.length) {
  if (bugfix) {
    log(`ERROR: siblingPatterns supplied but not usable — ${rawSiblingPatterns.length} supplied, ${siblingPatterns.length} kept after normalisation`)
    carried.push({
      file: '(build-plan)',
      severity: 'blocker',
      phase: 'Baseline',
      summary: 'siblingPatterns supplied but not usable',
      detail: `args.siblingPatterns carried ${rawSiblingPatterns.length} entr${rawSiblingPatterns.length === 1 ? 'y' : 'ies'}; only ${siblingPatterns.length} normalised to a usable {pattern, note} (a string .pattern or .regex). The rest carried neither key, so no sweep ran for them.`,
      fixHint: 'Pass each sibling pattern as { pattern: "<regex>", note: "..." } (or { regex: "<regex>", note: "..." } — both are normalised), never an object with neither key.',
    })
  } else {
    log('Note: args.siblingPatterns supplied but unusable; ignored in feature mode (sibling sweep does not run)')
  }
}

// ---------- schemas ----------
const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    filesChanged: { type: 'array', items: { type: 'string' } },
    deviations: { type: 'string', description: 'anything the plan asked for that you did not or could not do, and why; empty string if none' },
    notes: { type: 'string', description: 'anything the reviewer must know; empty string if none' },
  },
  required: ['status', 'filesChanged', 'deviations', 'notes'],
}
const GATE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    // cwd (owner ruling 2026-09-11e, RUN-LOG train4-run-c): the verbatim first line
    // of `pwd`, printed BEFORE any verify command — the only way this engine can
    // learn where a gate agent actually ran, since askAgent has no cwd option. A
    // wrong-directory "environment repair" round cost $21 on a one-file fix, and
    // two runs recorded green Jest gates that executed nothing.
    cwd: { type: 'string', description: 'run `node -p process.cwd()` (works in bash and PowerShell) and report its single output line verbatim as `cwd`' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          pass: { type: 'boolean' },
          summary: { type: 'string', description: 'one line if passed; the key error lines verbatim if failed' },
          executed: { type: 'number', description: 'how many tests (or files checked) the tool reports it actually ran; 0 when it ran nothing (cache replay, skipped step, empty filter); -1 when the tool prints no count' },
          exitCode: { type: 'number', description: "this command's real exit code" },
          // A6 FLAKY QUARANTINE (owner ruling 2026-09-11, CFG.flakyReruns). Optional.
          // When a command failed, name the SPECIFIC failing tests (not just files) —
          // this is what lets a later rerun tell a flaky test apart from a genuinely
          // broken one. Omit or leave empty for a passing command, or when the tool's
          // output does not name individual tests.
          failedTests: { type: 'array', items: { type: 'string' }, description: 'exact names of the tests that failed, when the command failed and the tool names them' },
        },
        required: ['command', 'pass', 'summary', 'executed', 'exitCode'],
      },
    },
  },
  required: ['pass', 'cwd', 'results'],
}
// The red gate EXPECTS failure, so pass/fail is meaningless there — the auditor
// needs the raw runner output instead.
const RED_RUN_SCHEMA = {
  type: 'object',
  properties: {
    ran: { type: 'boolean', description: 'true if every command actually executed — a FAILING test run still counts as executed' },
    // Optional (unlike GATE_SCHEMA's cwd): the red run is audited by redAuditPrompt
    // from its `results[].output`, not gated on workdir by the engine, but it gets
    // the same CWD_NOTE instruction so a wrong-directory red run is at least
    // visible on the transcript. See CWD_NOTE's comment.
    cwd: { type: 'string', description: 'the verbatim first line of `pwd`, printed before any command in this run' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          exitCode: { type: 'number' },
          output: { type: 'string', description: 'runner output verbatim: every failing test name with its failure message and first stack lines, plus the pass/fail/skip counts' },
        },
        required: ['command', 'exitCode', 'output'],
      },
    },
  },
  required: ['ran', 'results'],
}
const RED_AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    structurallyRed: { type: 'boolean', description: 'true ONLY if every new test ran and failed on an ASSERTION — none passed, none errored (syntax/import/config/fixture), none was skipped or left uncollected' },
    behaviorallyRed: { type: 'boolean', description: 'true ONLY if, on top of structurallyRed, each test failed on its OWN expected value from the test plan — a suite where every assertion fails identically on a stub\'s undefined has proven the wiring, not the oracles' },
    properlyRed: { type: 'boolean', description: 'structurallyRed AND behaviorallyRed' },
    tests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          test: { type: 'string', description: 'test name and file' },
          outcome: { type: 'string', enum: ['assertion-failure', 'error', 'passed', 'not-run'] },
          note: { type: 'string' },
        },
        required: ['test', 'outcome', 'note'],
      },
    },
    blockers: { type: 'array', items: { type: 'string' }, description: 'one line per problem; prefix structural problems with "STRUCTURAL:" and behavioral shortfalls with "BEHAVIORAL:"' },
    remediation: { type: 'string', description: 'the exact edits a test author should make to fix the STRUCTURAL problems; empty string if structurallyRed' },
  },
  required: ['structurallyRed', 'behaviorallyRed', 'properlyRed', 'tests', 'blockers', 'remediation'],
}
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          summary: { type: 'string', description: 'one-sentence statement of the defect' },
          detail: { type: 'string', description: 'concrete failure scenario: inputs/state -> wrong behavior' },
          fixHint: { type: 'string' },
          // Routes the fix to the right model. The reviewer that found the defect
          // classifies it: it already understands the finding, so this is free.
          fixComplexity: {
            type: 'string',
            enum: ['mechanical', 'judgment'],
            description: 'mechanical = the fix is fully determined once the defect is named (wrong path, broken link, stale cross-reference, renumbering, missing import, budget overrun); judgment = the fix requires deciding what the code should do (logic, edge cases, security, API shape, or any HIGH-risk file). When unsure, say judgment.',
          },
        },
        required: ['file', 'severity', 'summary', 'detail', 'fixComplexity'],
      },
    },
  },
  required: ['findings'],
}
// The preflight manifest: facts about the tree, never an interpretation of the change.
const MANIFEST_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'repo-relative path with forward slashes' },
          status: { type: 'string', description: 'modified | added | untracked | deleted | planned' },
          risk: { type: 'string', enum: ['HIGH', 'LOW'], description: 'HIGH if the path or content touches money/pricing/tax, auth/permissions, tenancy or ownership scoping, migrations/schema, PII, or payments; LOW otherwise; unknown or unreadable is HIGH' },
          changedLines: { type: 'number', description: 'added+deleted lines from `git diff --numstat`; 0 when the file does not exist yet' },
        },
        required: ['path', 'status', 'risk', 'changedLines'],
      },
    },
    validCommands: { type: 'array', items: { type: 'string' }, description: 'the supplied verify commands that can actually run in this repo, spelled exactly as given' },
    artifacts: { type: 'array', items: { type: 'string' }, description: 'the supplied artifact paths that exist on disk' },
  },
  required: ['files', 'validCommands', 'artifacts'],
}
const MUTATION_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    defect: { type: 'string', description: 'the one deliberate defect you injected, in one line' },
    caught: { type: 'boolean', description: 'true ONLY if the named test FAILED on an assertion while the defect was in place' },
    restored: { type: 'boolean', description: 'true ONLY if the file is byte-identical to the backup you took before mutating' },
    evidence: { type: 'string', description: 'the assertion failure message, or the passing output that proves the test is blind to this behavior' },
    backupPath: { type: 'string', description: 'absolute path of the backup you took, in the OS temp directory; still set it when the restore failed and you left the backup in place' },
    // The probe's OWN before/after digests. They are the only evidence that can tell
    // an unrestored file apart from one whose pre-probe baseline was taken on
    // different content (another process wrote the tree between the two).
    preHash: { type: 'string', description: 'lowercase hex SHA-256 of the file as you found it, computed BEFORE you mutated it; empty string if you could not compute one' },
    postHash: { type: 'string', description: 'lowercase hex SHA-256 of the file AFTER you restored it; empty string if you could not compute one' },
    // Optional, bugfix mode: which probe procedure actually ran. The engine fills it
    // in when the agent omits it, so a probe is never recorded as the wrong kind.
    kind: {
      type: 'string',
      enum: ['mutation', 'revert-fix'],
      description: 'mutation = you injected a deliberate defect; revert-fix = you reverted the file to its committed content to prove the test fails without the fix',
    },
    fallback: {
      type: 'string',
      description: 'set to the exact string "untracked" ONLY when you were asked to revert the fix but the file has no committed version to revert to, so you ran the standard mutation probe instead; empty string otherwise',
    },
  },
  required: ['file', 'defect', 'caught', 'restored', 'evidence'],
}
// A5 MUTANT FEEDBACK (owner ruling 2026-09-11, CFG.mutationRemediate).
const MUTATION_REMEDIATE_SCHEMA = {
  type: 'object',
  properties: {
    filesChanged: { type: 'array', items: { type: 'string' }, description: 'every test file you actually edited; empty if you made no change' },
    backupPath: { type: 'string', description: 'absolute path, in the OS temp directory, of the backup you took before editing (the FIRST file if you touched more than one)' },
    note: { type: 'string', description: 'one line: what you strengthened and why it now catches the mutation, or why you made no change' },
  },
  required: ['filesChanged', 'backupPath', 'note'],
}
const MUTATION_REVERT_SCHEMA = {
  type: 'object',
  properties: {
    restored: { type: 'boolean', description: 'true ONLY if you byte-compared the restored file against the backup and they matched' },
    note: { type: 'string' },
  },
  required: ['restored', 'note'],
}
// BUGFIX MODE: the radius pack — the diff hunks, touched export signatures and call
// sites the review lenses read as PRIMARY EVIDENCE instead of re-deriving the change.
const RADIUS_PACK_SCHEMA = {
  type: 'object',
  properties: {
    pack: { type: 'string', description: 'the assembled pack text, ready to paste into a reviewer prompt' },
    truncated: { type: 'boolean', description: 'true ONLY if you had to leave content out to stay inside the size cap' },
    files: { type: 'array', items: { type: 'string' }, description: 'the radius files the pack actually covers' },
  },
  required: ['pack', 'truncated', 'files'],
}
// BUGFIX MODE: what the existing test harness will break on, found BEFORE the tests
// are written rather than after six lenses each report the same stale mock.
const HARNESS_SCHEMA = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'repo-relative path of the spec, fixture or mock helper' },
          line: { type: 'number' },
          issue: { type: 'string', description: 'what will break, concretely: which mock/fixture, against which planned change' },
          remedy: { type: 'string', description: 'one line: the edit that fixes it' },
        },
        required: ['file', 'line', 'issue', 'remedy'],
      },
    },
  },
  required: ['issues'],
}
// BUGFIX MODE: the sibling sweep, in two halves — mechanical hits, then verdicts.
const SIBLING_HITS_SCHEMA = {
  type: 'object',
  properties: {
    hits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'the pattern that matched, copied exactly as given' },
          file: { type: 'string', description: 'repo-relative path with forward slashes' },
          line: { type: 'number' },
          excerpt: { type: 'string', description: 'the matching line verbatim, trimmed to about 200 characters' },
        },
        required: ['pattern', 'file', 'line', 'excerpt'],
      },
    },
    truncated: { type: 'array', items: { type: 'string' }, description: 'the patterns whose hit list you had to cap; empty when none was capped' },
  },
  required: ['hits'],
}
const SIBLING_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'the [#index] of the hit this verdict is about' },
          verdict: { type: 'string', enum: ['defect', 'same-class-but-guarded', 'unrelated'] },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'], description: 'the severity this hit deserves if it is a defect; for the other verdicts give "minor"' },
          evidence: { type: 'string', description: 'ONE sentence: for "defect" the concrete failure scenario; for "same-class-but-guarded" the guard that prevents it; for "unrelated" why the match is incidental' },
        },
        required: ['index', 'verdict', 'severity', 'evidence'],
      },
    },
  },
  required: ['verdicts'],
}
// The restore is verified by two agents that never touch the files, one before
// the probes and one after — self-report is not verification.
const CHECKSUM_SCHEMA = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'the path exactly as it was given to you' },
          checksum: { type: 'string', description: 'lowercase hex SHA-256 digest with no spaces; the exact string "unreadable" if the file could not be read' },
        },
        required: ['file', 'checksum'],
      },
    },
  },
  required: ['files'],
}
// C1 checkpoint agent (Haiku, low): writes the phase card (or the final result
// summary) to disk and, at most once per run, the snapshot commit. A malformed
// or dead checkpoint agent is non-fatal — see endPhase — so every field here
// must default safely.
const CHECKPOINT_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'boolean', description: 'true only if the JSON file was actually written to disk' },
    path: { type: 'string', description: 'the absolute path you wrote, exactly as given to you' },
    committed: { type: 'boolean', description: 'true only if you ran git commit and it succeeded' },
    sha: { type: ['string', 'null'], description: 'the short commit sha if committed=true, else null' },
    note: { type: 'string', description: 'one line: what happened, or why written/committed is false' },
  },
  required: ['written', 'path', 'committed', 'sha', 'note'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true ONLY if you demonstrated the finding is wrong or cannot happen' },
    reason: { type: 'string' },
  },
  required: ['refuted', 'reason'],
}
// One refuter, several findings on the same file: one verdict per index.
const BATCH_VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'the [#index] of the finding this verdict is about' },
          refuted: { type: 'boolean', description: 'true ONLY if you demonstrated THIS finding is wrong, impossible, or explicitly intended by the plan' },
          reason: { type: 'string' },
        },
        required: ['index', 'refuted', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}
// What the UI driver hands the UI judge: facts per flow per viewport, no verdicts.
const UI_EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    completed: { type: 'boolean', description: 'true ONLY if every listed flow was driven at every listed viewport (a flow that could not be driven is reported with status "blocked", and completed=false)' },
    specPath: { type: 'string', description: 'repo-relative path of the Playwright spec you wrote and ran; empty if the browser MCP fallback was used' },
    flows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          flow: { type: 'string' },
          viewport: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
          screenshot: { type: 'string', description: 'absolute or repo-relative path of the screenshot taken at the end of this flow at this viewport' },
          assertions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, passed: { type: 'boolean' } }, required: ['text', 'passed'] } },
          consoleErrors: { type: 'array', items: { type: 'string' }, description: 'every console error or unhandled rejection captured during this flow, verbatim' },
          networkFailures: { type: 'array', items: { type: 'string' }, description: 'every request that 4xx/5xx, aborted or timed out: method, URL, status' },
          a11y: { type: 'array', items: { type: 'string' }, description: 'accessibility facts observed: focus order, missing accessible names, contrast or target-size measurements' },
          notes: { type: 'string', description: 'anything else observed, stated as fact (what rendered, what the DOM classes were), never as a verdict' },
        },
        required: ['flow', 'viewport', 'status', 'screenshot', 'assertions', 'consoleErrors', 'networkFailures', 'a11y', 'notes'],
      },
    },
    processesStopped: { type: 'boolean', description: 'true ONLY if every server, browser and port you started is stopped' },
  },
  required: ['completed', 'specPath', 'flows', 'processesStopped'],
}
// What the final-pass packager hands Fable.
const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    digestPath: { type: 'string', description: 'absolute path of the digest file you wrote in the OS temp directory' },
    files: { type: 'number', description: 'how many files the digest covers' },
    hunks: { type: 'number', description: 'how many diff hunks it contains' },
    note: { type: 'string', description: 'anything Fable must know about gaps in the digest (a file that could not be diffed, a binary, a truncated hunk)' },
  },
  required: ['digestPath', 'files', 'hunks', 'note'],
}
// What the final-pass decider (Fable) returns: a ruling per candidate and, when
// the reader's coverage looks thin, where it must look again.
const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'the [#index] of the candidate' },
          real: { type: 'boolean', description: 'true if the candidate is a genuine defect in the finished change, judged from its evidence' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          reason: { type: 'string', description: 'one or two sentences: why it is (or is not) real, from the evidence given' },
        },
        required: ['index', 'real', 'severity', 'reason'],
      },
    },
    gaps: { type: 'array', items: { type: 'string' }, description: 'specific places or interactions the reader did not cover but should have (a file pair, a state path, a caller) — empty when the read was sufficient. Each entry becomes the focus of ONE more read.' },
    note: { type: 'string', description: 'the decision in one paragraph, for the close-out' },
  },
  required: ['verdicts', 'gaps', 'note'],
}
// The mechanical location check: does the cited code exist where the finding says.
const LOCATION_SCHEMA = {
  type: 'object',
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          locationValid: { type: 'boolean', description: 'true ONLY if the cited file exists and the code at or near the cited line is what the finding describes (the named function, call, branch, query or statement is there)' },
          note: { type: 'string' },
        },
        required: ['index', 'locationValid', 'note'],
      },
    },
  },
  required: ['checks'],
}
const FIX_SCHEMA = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' }, description: 'summaries of findings you fixed' },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'the [#index] of the finding, from the numbered list in your task. Always include it: a paraphrased summary cannot be matched back, and an unmatched report is a finding nobody acts on' },
          summary: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['summary', 'reason'],
      },
      description: 'findings that are real but cannot be fixed here, with the concrete reason',
    },
    // REFUTE FIRST: a finding the fixer can show is not real. It is never dropped
    // on the fixer's word — an adversarial slate re-judges every dispute.
    disputed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'the [#index] of the finding, from the numbered list in your task. Always include it: it is how a dispute is matched back when the summary is paraphrased' },
          summary: { type: 'string', description: 'the finding summary, copied EXACTLY as given' },
          reason: { type: 'string', description: 'the exact code or plan line that proves the finding is wrong, impossible, or intended' },
        },
        required: ['summary', 'reason'],
      },
      description: 'findings you did NOT fix because you can demonstrate they are not real; independent refuters re-judge them before anything is dropped',
    },
    filesChanged: { type: 'array', items: { type: 'string' } },
    // A2 EXECUTION-VERIFIED CONFIRMED (owner ruling 2026-09-11). Optional and
    // additive to `fixed` — only when you actually ran a NAMED test that failed
    // on the original code and passes after your change, report it here so the
    // finding counts as execution-verified rather than merely plausible.
    verifiedFixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'the [#index] of the finding this verifies, from your numbered list' },
          summary: { type: 'string', description: 'the finding summary, copied EXACTLY as given' },
          test: { type: 'string', description: 'the exact test name or command you ran' },
          redOn: { type: 'string', description: 'what you saw running it against the ORIGINAL code (must show the defect)' },
          greenOn: { type: 'string', description: 'what you saw running it against your PATCHED code (must show it fixed)' },
        },
        required: ['summary', 'test', 'redOn', 'greenOn'],
      },
      description: 'ONLY findings you proved with a real red-then-green test run. Never invent one to inflate confidence.',
    },
  },
  required: ['fixed', 'skipped', 'filesChanged'],
}
// What the Sonnet brief builder hands the fix planner: facts around each finding,
// gathered mechanically. No judgment, no proposed fix.
const FIX_BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'the [#index] of the finding this item is about' },
          file: { type: 'string', description: 'the path exactly as the finding spells it' },
          line: { type: 'number', description: 'the cited line, or 0 when the finding cites none' },
          excerpt: { type: 'string', description: 'the code around the cited line — about 60 lines centred on it, or the whole file when it is under 80 lines; the empty string for a synthetic key in parentheses, a missing file, or code you could not locate' },
          callers: { type: 'array', items: { type: 'string' }, description: 'up to 8 call sites of the exported symbol enclosing the cited line, each "path:line — calling expression"' },
          note: { type: 'string', description: 'ONE line of anything mechanical the planner must know (file missing, line past the end of the file, symbol not found, excerpt truncated); empty string when there is nothing to say' },
        },
        required: ['index', 'file', 'line', 'excerpt', 'callers', 'note'],
      },
    },
  },
  required: ['items'],
}
// What the Fable fix planner returns: one decision per finding, plus the concurrency
// it wants. The engine enforces the HIGH-risk / broad-key upgrade to 'opus' and
// re-derives conflict safety itself — the plan names order, never write safety.
const FIX_PLAN_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'the [#index] of the finding this decision is about' },
          action: { type: 'string', enum: ['fix', 'dispute', 'defer'] },
          design: { type: 'string', description: 'for "fix": 2-6 sentences — what changes, where, and what must NOT change; empty for the other actions' },
          invariant: { type: 'string', description: 'for "fix": the invariant the change must preserve' },
          tests: { type: 'string', description: 'for "fix": the test to add or strengthen, naming the T#/REG token when one exists' },
          route: { type: 'string', enum: ['mechanical', 'sonnet', 'opus'], description: 'mechanical = the design is a pure transcription; sonnet = a designed change on a LOW-risk file; opus = a HIGH-risk file, a synthetic key, or a design that still leaves a judgment to the executor' },
          reason: { type: 'string', description: 'for "dispute": the proof the finding is not real; for "defer": the question this run cannot answer; for "fix": why this design and this route' },
          // A2 EXECUTION-VERIFIED CONFIRMED (owner ruling 2026-09-11). Optional.
          // Set true ONLY for a "fix" you are confirming as REAL from evidence
          // already cited in this brief, for a finding with NO runnable check
          // (no test could show it red/green either way). Never set it as a
          // substitute for a runnable check that exists but nobody ran.
          ruled: { type: 'boolean', description: 'true only when confirming a no-runnable-check finding as real from cited evidence' },
        },
        required: ['index', 'action', 'design', 'invariant', 'tests', 'route', 'reason'],
      },
    },
    waves: {
      type: 'array',
      items: { type: 'array', items: { type: 'number' } },
      description: 'groups of "fix" indices that may execute concurrently; a later wave depends on the earlier ones. Every index you marked "fix" appears in exactly one wave, and two findings on the same file share a wave.',
    },
    note: { type: 'string', description: 'the round\'s plan in one paragraph, for the close-out' },
  },
  required: ['decisions', 'waves', 'note'],
}

// ---------- prompts ----------
const REPO_NOTE =
  (workdir
    ? `ALL work happens in the git worktree at "${workdir}" — your process may start elsewhere, so \`cd\` into it before ANY command (git, npm, node) and use ABSOLUTE paths under it for every file read/edit. Do not touch files outside it. `
    : 'You are working in the current directory, a git working tree on Windows. ') +
  'Never commit, stage, revert, or delete files unless the plan explicitly says to. ' +
  'New files from earlier stages may be untracked, so `git diff` alone can miss them — ' +
  'use `git status --short` and read untracked files directly.'

// Formatting is a REPO convention, not a universal one — Prettier, Biome, dprint,
// eslint --fix, gofmt, black, or nothing at all. This skill runs in any repo, so
// never hardcode a tool: use the exact command the build plan supplies in
// args.formatCommand, otherwise tell the agent to find and run whatever formatter
// THIS repo already configures (and to skip the step when there is none).
const formatCommand = typeof _args.formatCommand === 'string' ? _args.formatCommand.trim() : ''
const FORMAT_NOTE = formatCommand
  ? `Before reporting, run \`${formatCommand}\` (from the repo root${workdir ? ` at "${workdir}"` : ''}) on the files you modified so formatting hooks never trip downstream.`
  : `Before reporting, format the files you modified the way THIS repo formats code: look for a formatter in its package.json scripts (format / fmt / lint:fix) or a formatter config file, and run that tool on the files you touched, so formatting hooks never trip downstream. If this repo configures no formatter, or it does not handle the file types you changed, skip this step — never install a formatter and never reformat to a tool this repo does not use.`

// Extra planning artifacts, listed only when they exist — a legacy invocation
// keeps the exact prompts it had before.
const extraArtifacts = [
  discoveryPath ? `- discovery (WHY: problem, user, success signal): "${discoveryPath}"` : '',
  specPath ? `- spec (WHAT: requirements R#, priorities, verification method): "${specPath}"` : '',
  uxSpecPath ? `- UX spec (screens, states, copy, a11y): "${uxSpecPath}"` : '',
  testPlanPath ? `- test plan (HOW WE KNOW: tests T#, oracles, R#->T# coverage matrix): "${testPlanPath}"` : '',
  designSystemPath ? `- design system derived from this codebase (tokens, components, states): "${designSystemPath}"` : '',
  lessonsPath ? `- lessons register (rules THIS project has already paid for — read it and apply every entry relevant to what you review, write or fix; cite the entry id when one changes your conclusion): "${lessonsPath}"` : '',
].filter(Boolean)
const ARTIFACT_NOTE = extraArtifacts.length
  ? `Planning artifacts — read the ones your task depends on; they are the only context you get:\n${extraArtifacts.join('\n')}`
  : ''

// Two lines every agent that reports gets, and one for every agent that edits.
// Progress claims audited against tool results nearly eliminate fabricated status
// on current models; targeted edits are cheaper and regress less than rewrites.
const GROUNDED_NOTE =
  'Before reporting, audit each claim against a tool result from this session. Report only what you can point to evidence for; if something is not verified, say so explicitly. If tests fail, say so with the output; if a step was skipped, say that.'
const EDIT_NOTE =
  'Edit files surgically: change the lines the task needs and leave the rest byte-identical. Never rewrite a whole file when a targeted edit gives the same result.'
// Gate runners: a cached task runner replays an old green with zero tests run.
const EXECUTION_NOTE =
  'Test commands must actually EXECUTE: when a command goes through a caching task runner (turbo, nx, a warm test cache) add that runner\'s cache-bypass flag or invoke the underlying test runner directly with the SAME filter — never a narrower one. Report `executed` = the number of tests (or files checked) the tool says it ran, -1 when it prints no count. A test command that ran 0 tests, or a step reported as skipped, is pass:false with the summary "ran nothing": a green that ran nothing is not green.'
// CWD PROOF (owner ruling 2026-09-11e, RUN-LOG train4-run-c: a wrong-cwd
// "environment repair" round cost $21 on a one-file fix, and two runs recorded
// green Jest gates that executed nothing). askAgent has no cwd option, so this is
// the only way the engine learns where a gate agent actually ran: every gate
// prompt makes the agent print it, verbatim, first. Detection only — it cannot
// stop a wrong-directory run, only catch it after the fact.
const CWD_NOTE =
  'Before running anything else, run `node -p process.cwd()` (works in bash and PowerShell) and report its single output line VERBATIM as `cwd` (top-level, not per-command). Report every command\'s real exit code as `exitCode`.'

// SCOPE_NOTE and BATCH_NOTE (owner ruling 2026-09-11, package P4): copied
// verbatim from Anthropic's Fable 5.1 prompting guide (fable-5-1-guide.md,
// "Keep changes and tests to what the task asks for" and "Batch independent
// tool calls in agent loops") into the shared RUN_PREFIX. Appended at the END
// of the prefix so every agent in a run still shares one byte-identical
// prefix for the prompt cache.
const SCOPE_NOTE =
  "If, while working or testing, you find a pre-existing bug, a performance concern, or behavior the task doesn't mention, don't fix, optimize or extend it in this change unless the requested behavior cannot work without it; report it as a follow-up in your summary. Where the task is ambiguous, implement the reading its wording and the surrounding code most directly support, state that assumption in your summary, and don't build for the other readings as well. Verify your work however you like; scratch scripts and quick checks need not be kept. Commit tests only where the task asks for them or this repository already keeps tests for this kind of change, sized like the neighboring test files — roughly one focused test per stated behavior — and don't turn scratch checks into additional permanent test files. This is about extras only: implement every behavior the task asks for, completely."
const BATCH_NOTE =
  "First privately list what you need next; then request every item that doesn't depend on another's result in this one response."

// The block every prompt opens with. It is IDENTICAL for every agent in a run, so
// agents launched together on the same model and effort read it from the prompt
// cache instead of paying for it again — which is why the role line comes AFTER
// it, not before. manifestNote is filled by Baseline, so this is a function.
function RUN_PREFIX() {
  return [REPO_NOTE, ARTIFACT_NOTE, manifestNote, GROUNDED_NOTE, SCOPE_NOTE, BATCH_NOTE]
    .filter(Boolean)
    .join('\n')
}

// PHASE/LABEL ATTRIBUTION (C2, plan Part 3 §C2). Every prompt gets a one-line tag
// so a transcript replay (model-routing/scripts/session-usage.mjs) can attribute
// tokens to a phase and a label without guessing from prose. The tag goes AFTER
// the shared RUN_PREFIX() block when the prompt opens with it — RUN_PREFIX must
// stay byte-identical at the START of the prompt so agents sharing model+effort
// in one wave still share the prompt-prefix cache; the tag differs per agent, so
// it can never be part of the cached prefix itself. A prompt that does not open
// with RUN_PREFIX() (the mechanical Haiku runners below, which inline REPO_NOTE
// instead) gets the tag as its first line.
const ROLE_TAG = (phase, label) => `PHASE: ${phase} · LABEL: ${label}`

// Every real call site already passes both; 'unknown' only guards a future call
// site that forgets one — it must never throw.
function askAgent(prompt, opts) {
  const o = opts || {}
  const tag = ROLE_TAG(o.phase || 'unknown', o.label || 'unknown')
  const prefix = RUN_PREFIX()
  // Prompts opening with the full RUN_PREFIX() get the tag after it (existing
  // behaviour). The mechanical Haiku runners (redRunPrompt et al.) instead open
  // with REPO_NOTE alone — those must ALSO get the tag after that shared block,
  // not before it, so two gate prompts on the same model+effort still share
  // REPO_NOTE as their common byte prefix for the prompt cache. Anything else
  // (a prompt with no shared opening block at all) gets the tag first, as before.
  let tagged
  if (prefix && prompt.indexOf(prefix) === 0) {
    tagged = prompt.slice(0, prefix.length) + '\n' + tag + prompt.slice(prefix.length)
  } else if (REPO_NOTE && prompt.indexOf(REPO_NOTE) === 0) {
    tagged = prompt.slice(0, REPO_NOTE.length) + '\n' + tag + prompt.slice(REPO_NOTE.length)
  } else {
    tagged = tag + '\n' + prompt
  }
  return agent(tagged, opts)
}

// ---------- shared preflight facts ----------
// Filled by the Baseline phase and pasted into every later prompt. It is a
// manifest of FACTS (paths, statuses, risk classes, what exists), never a summary
// of the change: sharing an INTERPRETATION would hand every lens the same blind
// spot, which is exactly what having several lenses is for. Empty until Baseline
// runs — every prompt function reads it at call time, which is always after.
let manifestNote = ''
// BUGFIX MODE: what the harness-integrity check found, per TEST PACKAGE id. Filled in
// Baseline and pasted into that package's author prompt, so the stale mock is fixed in
// the same edit that writes the test instead of surfacing as a blocker cascade later.
// Empty in feature mode, which leaves authorTestsPrompt byte-identical.
const harnessNotes = new Map()
// Harness issues whose file belongs to no test package, parked on the first package.
const harnessSharedNotes = new Map()
// BUGFIX MODE: the radius pack text every review lens carries as PRIMARY EVIDENCE.
// Empty string = no pack (feature mode, no radius files, a dead packer, or a truncated
// pack), and the lenses then read the repo exactly as they do in feature mode.
let radiusPackText = ''
// Files this run intends to touch, from the plan's own package file lists. They
// do not exist yet at preflight, so they are classified alongside the diff.
const plannedFiles = uniquePaths(
  [].concat(...testPkgs.map((p) => p.files || []), ...packages.map((p) => p.files || [])),
)

// Every finding must be routed to a fixer, so every agent that emits findings
// must classify them. Stated identically everywhere so the tags mean one thing.
const FIX_COMPLEXITY_NOTE = [
  `Every finding MUST carry fixComplexity — you found the defect, so you already know which kind of fix it needs:`,
  `- "mechanical": the fix is fully determined the moment the defect is named — a wrong path, a broken link, a stale cross-reference, a renumbering, a missing import, a budget overrun.`,
  `- "judgment": the fix requires deciding what the code SHOULD do — logic, edge cases, security, API shape, or anything in a HIGH-risk file.`,
  `When you are unsure, say "judgment". Findings on HIGH-risk files are routed to a judgment fixer whatever you tag them.`,
].join('\n')

// Risk sets DEPTH per file; it never sets COVERAGE. Every file in scope is read.
const RISK_DEPTH_NOTE = [
  `DEPTH BY RISK: spend maximum depth on every HIGH-risk file — trace each branch, each caller, each failure mode, adversarially. LOW-risk files get a careful standard read.`,
  `Depth is per file, never a filter: read EVERY file in your scope, and never skip one because it is LOW. A file the manifest does not classify is HIGH by default.`,
].join('\n')

function pkgIdLine(p) {
  const bits = []
  if (p.satisfies) bits.push(`satisfies requirement(s): ${[].concat(p.satisfies).join(', ')}`)
  if (p.provenBy) bits.push(`proven by test(s): ${[].concat(p.provenBy).join(', ')}`)
  return bits.length ? `This package ${bits.join('; ')}. Those IDs are the acceptance criteria you are judged on.` : ''
}

function authorTestsPrompt(p) {
  return [
    RUN_PREFIX(),
    `You are the test author for ONE test package. You write TESTS ONLY — writing implementation or production code in this phase is FORBIDDEN. ${EDIT_NOTE}`,
    context ? `Task context from the orchestrator: ${context}` : '',
    `1. Read ${testPlanPath ? `the test plan at "${testPlanPath}"` : `the plan at "${planPath}"`} in full. Your package is "${p.id}: ${p.title}".`,
    `2. Package brief: ${p.brief}`,
    // BUGFIX MODE: inconsistencies a read-only check already found between the
    // EXISTING harness and the service-surface changes this plan makes.
    harnessNotes.get(p.id)
      ? `HARNESS NOTES — fix these in the same edit:\n${harnessNotes.get(p.id)}`
      : '',
    // Issues in a file NO package owns (a shared fixture, a mock helper) go to the
    // FIRST test package, deterministically: an issue handed to every author would
    // put several concurrent editors on one file none of them owns.
    harnessSharedNotes.get(p.id)
      ? `SHARED HARNESS (owned by no package) — fix in your edit:
${harnessSharedNotes.get(p.id)}`
      : '',
    pkgIdLine(p),
    `3. Read the repo's EXISTING tests first and match them: the runner, its config, the directory layout, the naming convention, the fixtures and helpers. Do not introduce a new test runner, assertion library, or mocking library — use what is already there.`,
    `4. Write or extend ONLY these files: ${(p.files || []).join(', ') || '(as specified in the test plan for this package)'}. If a test genuinely needs another file, do NOT touch it — report it under deviations.`,
    `5. Every test must: name the requirement/test ID it proves (T#/R#) in its title or a comment; assert OBSERVABLE behavior against the CONCRETE expected value the plan names (a number, a status, a row, a message) so that it fails on ITS OWN value rather than merely on a stub's undefined, never a value read out of an implementation; have one reason to fail; and include the negative/error case the plan names. No sleeps or time-based waits — wait on a deterministic condition. No skipped or focused tests. No snapshot assertions unless the repo already relies on them.`,
    `6. These tests run BEFORE the implementation exists, so they MUST fail — and they must fail on an ASSERTION, not on a syntax error, an unresolvable import, or a broken config. Run only your own new test file(s) once to confirm the failure is an assertion failure. If an import cannot resolve because the module does not exist yet, you may create the smallest possible signature-only stub (the exported name, no behavior, returning undefined/null — never throwing, never returning a value that would satisfy an assertion); the implementation phase replaces it.`,
    `7. Never make a test pass by weakening it, deleting an assertion, skipping it, or asserting on a mock you configured yourself.`,
    `8. ${FORMAT_NOTE}`,
    `9. Report honestly: status=done only if every test in the package is written and fails for the right reason; partial/blocked otherwise, with deviations explaining exactly what is missing.`,
  ].filter(Boolean).join('\n')
}

function redRunPrompt(commands, expect) {
  return [
    REPO_NOTE,
    `You are a mechanical test runner for the RED gate.`,
    `Run these commands from the repo root, one at a time, in order:`,
    ...commands.map((c) => `- ${c}`),
    `These commands are EXPECTED to ${expect === 'pass' ? 'PASS' : 'FAIL'} — a nonzero exit is the expected outcome here, NOT a problem for you to solve.`,
    `Rules: do NOT fix anything, do NOT modify any file, do NOT narrow the test filter. The ONE flag you may add is a caching task runner's cache-bypass flag (or call the underlying test runner directly with the same filter): a replayed cached result would hide the RED. For each command report its exit code and the runner output VERBATIM: every failing test name with its failure message and the first lines of its stack, plus the pass/fail/skip counts. Truncate only the middle of very long output — never truncate a failure message. ran=false only if a command could not be executed at all, or if it executed zero tests.`,
    CWD_NOTE,
  ].join('\n')
}

function redAuditPrompt(runOut, testFileList, attempt) {
  return [
    RUN_PREFIX(),
    `You are the RED-gate auditor. The tests for this change were just written and NOTHING has been implemented against them yet. Decide whether they are RED, at two levels.`,
    `Test runner output (attempt ${attempt}): ${JSON.stringify(runOut)}`,
    `New/changed test files: ${testFileList || '(discover them yourself with `git status --short` and `git diff --name-only`)'}`,
    `1. READ the test files themselves. Runner output alone cannot tell you whether an assertion is vacuous — open every new test.`,
    `2. Classify EVERY new test: "assertion-failure" = it ran and failed on an assertion about behavior (GOOD); "error" = syntax, unresolved import/module-not-found, type, config, fixture or setup failure, i.e. it never reached its assertion (BAD); "passed" (BAD); "not-run" = skipped, filtered out, or never collected (BAD).`,
    `3. structurallyRed = true ONLY if every new test is "assertion-failure". A single error, pass, or not-run makes it false — those are STRUCTURAL problems, and remediation must name the exact edits that fix them.`,
    `4. behaviorallyRed = true ONLY if, on top of that, each test failed on its OWN expected value from the test plan. A suite where every assertion fails identically on a stub's undefined has proven the wiring, not the oracles — report that as a BEHAVIORAL shortfall (one line per test, prefixed "BEHAVIORAL:"), which a later mutation probe will test directly. properlyRed = structurallyRed AND behaviorallyRed.`,
    `5. A PASSING new test is a structural blocker, not a bonus. It means one of two things and you must say which: the assertion is vacuous/tautological, or the behavior already exists and the requirement needs rewriting (in which case the work package may be unnecessary).`,
    `6. Also flag tests that will later pass for the WRONG reason: no meaningful assertion, asserting on a mock the test itself configured, expected values that could only have come from an implementation, sleeps or time-based waits, skipped/focused tests, or no requirement ID.`,
    `Put one line per problem in blockers (prefixed STRUCTURAL: or BEHAVIORAL:), and in remediation write the exact edits a test author should make for the structural ones. Do NOT edit any file yourself.`,
  ].filter(Boolean).join('\n')
}

function testRemediationPrompt(audit, testFileList) {
  return [
    RUN_PREFIX(),
    `You are the test-remediation engineer. This is the ONE remediation round allowed before implementation starts. ${EDIT_NOTE}`,
    `The RED-gate auditor rejected the new tests: ${JSON.stringify(audit)}`,
    `Test files in scope: ${testFileList || '(the new/changed test files — find them with `git status --short`)'}`,
    `Fix the TEST files only. Implementation/production code is FORBIDDEN in this round.`,
    `A test failing because the behavior does not exist yet is CORRECT and must stay failing — your job is to make it fail on an ASSERTION instead of on an error: import the exact module path the plan specifies, build the inputs, and assert the expected observable value. If the module does not exist yet you may create a signature-only stub (exported name, no behavior, returning undefined/null — never throwing, never returning a value that satisfies an assertion).`,
    `Never make a test pass by weakening it, deleting it, skipping it, or asserting on a mock. If a test now passes, say so plainly in skipped with the reason — a passing pre-implementation test means the requirement or the assertion is wrong, and faking it is worse than reporting it.`,
    FORMAT_NOTE,
  ].filter(Boolean).join('\n')
}

function implementPrompt(p) {
  return [
    RUN_PREFIX(),
    `You are the implementation engineer for ONE work package of a planned code change. ${EDIT_NOTE}`,
    context ? `Task context from the orchestrator: ${context}` : '',
    `1. Read the plan file at "${planPath}" in full. Your package is "${p.id}: ${p.title}".`,
    `2. Package brief: ${p.brief}`,
    pkgIdLine(p),
    testPlanPath
      ? `2b. The tests for this change were written FIRST and are currently RED. Make them pass by implementing the behavior. You may NOT edit, weaken, skip or delete a test to get green — if a test looks wrong, leave it and report it under deviations.`
      : '',
    `3. Implement exactly what the plan specifies for this package. Where the plan gives exact code, use it; where it gives intent, follow the surrounding code's style and conventions.`,
    `4. Edit or create ONLY these files: ${(p.files || []).join(', ') || '(as specified in the plan for this package)'}. If correctness genuinely requires touching another file, do NOT touch it — report it under deviations instead.`,
    `5. Do not run builds, dev servers, or test suites — a later gate stage does that. Quick syntax sanity checks are fine.`,
    `6. ${FORMAT_NOTE}`,
    `7. Report honestly: status=done only if the package is fully implemented; partial/blocked otherwise, with deviations explaining exactly what is missing.`,
  ].filter(Boolean).join('\n')
}

// The baseline gate answers one question: which of these commands work AT ALL,
// on the tree as the caller left it? A command that already fails here is broken,
// and its later failures say nothing about the change.
function baselineGatePrompt(commands) {
  return [
    REPO_NOTE,
    `You are the BASELINE gate. Nothing has been written yet: you run the project's verification commands against the working tree exactly as you find it, to learn which of them work AT ALL.`,
    `Run these commands from the repo root, one at a time, in order:`,
    ...commands.map((c) => `- ${c}`),
    `Rules: do NOT fix anything, do NOT create, modify or delete any file, do NOT install anything, and do NOT adjust, re-flag or substitute a command that fails — run each one EXACTLY as written. A failure here is the information we want, not a problem to solve.`,
    `Report each command: pass:true only if it actually ran and succeeded; pass:false if it exits nonzero, errors, or cannot be run at all (missing script, missing binary, wrong path, wrong directory) — with the key error lines quoted verbatim in summary. Also report \`executed\` = the number of tests (or files checked) the tool says it ran, -1 when it prints no count; at baseline a zero count is information, not a failure. Overall pass = every command passed.`,
    CWD_NOTE,
  ].join('\n')
}

// The manifest removes the one thing every later agent would otherwise re-derive
// independently: what changed and what to open. It does NOT tell them what the
// change means — reviewers still read the diff themselves.
function manifestPrompt(planned, commands, artifactPaths) {
  return [
    REPO_NOTE,
    `You are the context manifest builder. Report FACTS about this repository as it is right now. Do NOT summarize, interpret, judge or review the change — later agents read the diff themselves and must not inherit your reading of it.`,
    `1. FILES. Run \`git status --short\` and \`git diff --numstat\` and list every changed and untracked file. ALSO list every file the plan intends to touch, even if it does not exist yet (status "planned"):`,
    ...(planned.length ? planned.map((f) => `   - ${f}`) : ['   (none supplied)']),
    `   For each file report: path (repo-relative, forward slashes), status (modified | added | untracked | deleted | planned), and changedLines (added+deleted from --numstat; 0 when the file does not exist yet or no count is available).`,
    `2. RISK. Classify every file HIGH or LOW. HIGH if its path OR its content touches money/pricing/tax, auth/permissions/session, tenancy or ownership scoping, migrations/schema, PII, or payments. LOW otherwise. If you cannot read a file, or you are not sure, classify it HIGH — unknown is HIGH, never LOW.`,
    commands.length
      ? `3. COMMANDS. For each command below decide STATICALLY whether it could run at all here (the npm script exists in the right package manifest, the file or binary it names exists, the directory it needs exists). Do NOT execute any of them — another agent is running them right now. Return in validCommands only the ones that look runnable, spelled EXACTLY as given:\n${commands.map((c) => `   - ${c}`).join('\n')}`
      : `3. COMMANDS. None were supplied — return an empty validCommands.`,
    artifactPaths.length
      ? `4. ARTIFACTS. Return in artifacts the subset of these paths that EXIST on disk:\n${artifactPaths.map((p) => `   - ${p}`).join('\n')}`
      : `4. ARTIFACTS. None were supplied — return an empty artifacts list.`,
    `Read only. Do NOT modify, create or delete any file, do NOT run builds, tests or installs, and do NOT run any command that writes.`,
  ].join('\n')
}

// Artifacts assert things about the repo; some of those assertions are invented,
// and downstream agents then treat them as fact. This is a mechanical existence
// check, nothing more.
function groundingPrompt(paths) {
  return [
    REPO_NOTE,
    `You are the artifact grounding check. The planning artifacts below make factual claims about THIS repository. Find the claims that are false.`,
    `Artifacts — read every one in full:`,
    ...paths.map((p) => `- ${p}`),
    `Extract every MECHANICALLY CHECKABLE claim: file paths, directory paths, shell commands, package-manifest scripts, config keys, and exported symbols (functions, classes, constants, types) attributed to a specific file. Ignore every other kind of statement.`,
    `Verify each against the repo as it is right now: the path exists; the script exists in the package manifest; the config key exists in that config file; the symbol is actually exported by the file said to export it. Use \`ls\`, \`cat\` and \`grep\` — do not guess, and do not edit anything.`,
    `Report ONLY claims that do not hold. Use file: '(artifact)' for every finding, and in detail give the artifact path, the claim quoted exactly, and what the repo actually contains instead. severity: major for a path, directory, command, script or config key that does not exist; minor for a symbol you could not resolve.`,
    `Do NOT report a path, file or symbol the artifacts say this change WILL CREATE — it is supposed to be missing. Do NOT critique wording, design, completeness, feasibility, or quality; other reviewers own that and anything of the sort from you is noise. An empty findings list is a good answer.`,
    `Correcting a false claim in an artifact is normally "mechanical" — tag it that way unless fixing it would need a decision about what the code should do.`,
    FIX_COMPLEXITY_NOTE,
  ].join('\n')
}

function gatePrompt(commands) {
  return [
    REPO_NOTE,
    `You are a mechanical verification gate.`,
    `Run these commands from the repo root, one at a time, in order:`,
    ...commands.map((c) => `- ${c}`),
    `Rules: do NOT fix anything, do NOT modify any file. Report each command honestly — a nonzero exit or error output = pass:false with the key error lines quoted verbatim in summary. Overall pass = every command passed.`,
    `When a command fails, also report failedTests: the exact name of every individual test that failed (not just the file) whenever the tool's output names them. This is what lets a later rerun on the SAME tree tell a flaky test apart from a genuinely broken one — leave it empty only when the tool truly does not name individual tests.`,
    EXECUTION_NOTE,
    CWD_NOTE,
  ].join('\n')
}

// ---------- bugfix-mode prompts ----------
// THE RADIUS PACK (Sonnet, low, read-only): one gathering pass so that six review
// lenses do not each re-derive the same diff, and so that a bug review stays inside
// the defect's blast radius (F13: 31/31 surviving findings were inside it, 0 outside).
function radiusPackPrompt(files) {
  return [
    RUN_PREFIX(),
    `You are the RADIUS PACK builder — mechanical and read-only. Assemble ONE text pack that lets a reviewer judge this change without running git or hunting for call sites. Gather; judge nothing, and propose nothing.`,
    `Radius files — the files this change touches:`,
    ...files.map((f) => `- ${f}`),
    `For EACH radius file, in this order: (1) its complete current diff hunks (\`git diff HEAD -- <file>\`) with about 30 lines of context around each hunk — never summarize or elide a hunk, and include an untracked file whole; (2) the signature of every exported function, method, class or constant the diff touches; (3) up to 6 call sites per touched export, each as "path:line — the calling expression" (\`grep -rn\` over the source tree, excluding node_modules, dist, build output and .next).`,
    `SIZE CAP: about 40,000 characters for the whole pack. If it does not fit, drop CALL SITES first and keep every diff hunk whole — and set truncated=true. Report truncated honestly: a pack that claims to be complete and is not would send every reviewer a partial view of the change as if it were the whole one.`,
    `Return the pack text in \`pack\`, the files it covers in \`files\`, and truncated. Read only: do NOT modify, create or delete any file, and do NOT run builds, tests or installs.`,
  ].filter(Boolean).join('\n')
}

// THE HARNESS CHECK (Sonnet, low, read-only): the existing specs' mocks and fixtures
// against the service-surface changes the build plan names. F13's costliest blocker
// cascade was ONE stale mock, reported after the fact by six lenses independently.
function harnessCheckPrompt(files) {
  return [
    RUN_PREFIX(),
    `You are the TEST-HARNESS INTEGRITY check — read-only, and you run BEFORE any test is written. The build plan changes a service surface; the test files below already exist or are about to be extended. Find where the EXISTING harness will break against that change.`,
    `Test files this run will write or extend:`,
    ...files.map((f) => `- ${f}`),
    `1. Read the build plan at "${planPath}"${testPlanPath ? ` and the test plan at "${testPlanPath}"` : ''} and list the service-surface changes they name: methods added or renamed, DTO fields added/removed/renamed, validation added, constructor or dependency changes, changed return shapes.`,
    `2. For every one of those test files that ALREADY EXISTS — and every shared fixture, factory, builder or mock helper it imports — check its mocks and fixtures against that list: a mocked service missing a method the plan adds a call to, a fixture value a new validator will reject, a stub whose return shape no longer matches, a hardcoded DTO literal missing a newly required field, a spy asserting a signature that changed. Skip files that do not exist yet; say nothing about them.`,
    `3. Report ONE issue per inconsistency: file, line, what will break (concretely, naming the mock or fixture and the planned change it contradicts), and a one-line remedy. Report NOTHING else — no coverage opinions, no style, no review of the plan or the code. An empty issues list is a good answer.`,
    `Read only: do NOT modify, create or delete any file, and do NOT run builds, tests or installs.`,
  ].filter(Boolean).join('\n')
}

// THE SIBLING GREP (Sonnet, low, read-only): mechanical hits for the defect's shape.
function siblingGrepPrompt(patterns) {
  return [
    RUN_PREFIX(),
    `You are the SIBLING SWEEP grepper — mechanical and read-only. A defect is being fixed in this run; the patterns below name its SHAPE. Find every other place in this repository that matches, so a judge can decide which of them are the same bug in a second place. You judge NOTHING.`,
    `Patterns — run each one separately and report which pattern produced each hit:`,
    ...patterns.map((p, i) => `  ${i + 1}. /${p.pattern}/${p.note ? ` — ${p.note}` : ''}`),
    `Use ripgrep (or \`grep -rnE\`) over the source tree, EXCLUDING node_modules, dist, build output and .next. Report each hit as its pattern, the repo-relative path, the line number, and the matching line verbatim (trimmed to about 200 characters).`,
    `Cap each pattern at 40 hits: if one matches more, report the first 40 and name that pattern in \`truncated\` — never silently drop the rest.`,
    `Read only: do NOT modify, create or delete any file, and do NOT run builds, tests or installs.`,
  ].filter(Boolean).join('\n')
}

// THE SIBLING JUDGE (reviewModel, medium): which hits are the same defect, live.
function siblingJudgePrompt(patterns, hits) {
  return [
    RUN_PREFIX(),
    `You are the SIBLING SWEEP judge. A defect is being fixed in this run. The hits below match its SHAPE elsewhere in the repository. Decide, for each hit, whether the same defect is live there.`,
    context ? `Task context from the orchestrator: ${context}` : '',
    `Read the plan at "${planPath}" for what the defect actually is, then open each hit's location and enough of its surroundings to decide. The patterns that produced these hits:`,
    ...patterns.map((p, i) => `  ${i + 1}. /${p.pattern}/${p.note ? ` — ${p.note}` : ''}`),
    `Verdicts: "defect" = the same defect is live here, and you can state the concrete failure scenario; "same-class-but-guarded" = the shape matches but something already prevents the failure, and you can NAME that guard; "unrelated" = the match is incidental.`,
    `Hits:`,
    ...hits.map((h, i) => `[#${i}] ${h.file}:${h.line || '?'} — ${String(h.excerpt || '').slice(0, 200)}   (pattern: ${h.pattern || '?'})`),
    `One verdict per index, each with ONE sentence of evidence and the severity it deserves. "same-class-but-guarded" requires the guard by name: if you cannot name it, say "defect" and put what you could not rule out in evidence — every finding you raise goes to a fixer that refutes before it changes anything, and to an adversarial slate before anything is dropped.`,
  ].filter(Boolean).join('\n')
}

// THE FIX-REVERT PROBE (bugfix mode, reviewModel): the mutation probe's inverse. A bug
// fix already HAS the defect the test must catch — the one in the committed content —
// so the probe puts that back instead of inventing a new one. No git restore command
// ever touches this tree: uncommitted work from this very run lives in it.
function revertProbePrompt(t) {
  return [
    RUN_PREFIX(),
    `You are the FIX-REVERT probe for ONE target. The fix in this file is what makes a named test pass. You will put the file back to its COMMITTED content, prove the test fails without the fix, and then restore the fix EXACTLY as it was.`,
    `Target file: ${t.file}`,
    `Behavior the fix restores: ${t.behavior || '(the behavior the named test claims to prove)'}`,
    `Test that MUST FAIL without the fix — run ONLY this, nothing else: ${t.test}`,
    `Do exactly this, in order:`,
    `1. CHECK IT IS TRACKED: run \`git ls-files -- "${t.file}"\`. If it prints nothing — or if \`git show HEAD:${t.file}\` cannot produce content — then this file has no committed version to revert to. In that case run the STANDARD MUTATION PROBE instead: back the file up outside the repo, inject exactly ONE small behavior-breaking defect that still compiles (flip a comparison, drop a rounding/normalization call, skip a filter or a scope condition, move a boundary by one), run the named test, then restore from the backup and byte-compare. Report kind="mutation" and fallback="untracked", and skip steps 2-4.`,
    `2. BACK UP, OUTSIDE THE REPO: copy the file into the OS temp directory (Git Bash: "$TMPDIR" when set, else /tmp; a Windows shell: %TEMP%) under a unique name such as "revertprobe-<package-or-target>-<basename>". Use a file copy (\`cp\`), never git. NEVER put the backup beside the file or anywhere else inside the repo — a leftover backup in the tree becomes a shipped file. Report that absolute path as backupPath, and record a checksum of the file as you found it (\`sha256sum\` in Git Bash, or \`certutil -hashfile <file> SHA256\`) — REPORT it as preHash.`,
    `3. REVERT THE FIX: overwrite the working file with its committed content — \`git show HEAD:${t.file} > "${t.file}"\` (redirect the output into the file; use Git Bash so the bytes land unchanged). Do NOT use \`git checkout\`, \`git restore\`, \`git stash\` or \`git reset\`: uncommitted work from this very run lives elsewhere in this tree and those commands would destroy it.`,
    `4. RUN: run ONLY the named test. Reverting the fix re-introduces the bug, so the test MUST FAIL on an assertion about behavior — caught=true ONLY then. A pass, a skip, or a collection/compile error means caught=false: report it with the output that proves the test is blind to the fix.`,
    `5. RESTORE: copy the temp backup back over "${t.file}". Again: NEVER \`git checkout\`/\`restore\`/\`stash\`/\`reset\`.`,
    `6. VERIFY THE RESTORE: recompute the checksum — REPORT it as postHash — and byte-compare the backup against the file (\`cmp -s\`). They must be IDENTICAL. Only then delete the temp backup and set restored=true.`,
    `If the restore does not verify: set restored=false, LEAVE THE TEMP BACKUP IN PLACE, report its absolute path in backupPath, and state exactly what differs. That is an emergency the orchestrator must see — never report restored=true on a file you did not byte-compare.`,
    `Report kind="revert-fix" (or "mutation" with fallback="untracked" if step 1 sent you down that path), caught, restored, backupPath, preHash, postHash, \`defect\` = one line naming the fix you reverted, and evidence: the assertion failure message if the test failed, or the passing output that proves it does not cover the fix if it did not.`,
    `Independent checksum agents recorded this file before you started and will recheck it after you finish, so an unreported or partial restore WILL be detected — report honestly.`,
  ].filter(Boolean).join('\n')
}

// The trailing clauses are rules this project paid for (its lessons register):
// each one was a defect that shipped green under a plainer version of the lens.
const LENS_BRIEFS = {
  correctness:
    'logic errors, broken or changed behavior, wrong edge handling, regressions in code the change touches, mismatches between what the code does and what its callers expect; for any status field or state machine, walk multi-step PATHS (two individually legal transitions that compose into a forbidden state), never just single edges; for any cancel/undo/reverse/reopen path, check the reversal enumerates EVERY field the forward path wrote, not only the one the request named; when one write is the record of another write having happened, both must hang off one named condition',
  'spec-compliance':
    'requirements that are unimplemented, half-implemented, or implemented differently than specified — walk EVERY requirement in the spec and EVERY acceptance criterion in the build plan and check the code actually delivers it; then walk the test plan coverage matrix and check it is HONEST: no requirement silently untested, no test claiming a requirement it does not exercise, no acceptance criterion with no test at all, no work package whose satisfies/provenBy IDs do not match what it shipped; also check reported deviations against the plan; treat a location a plan or bug report names as a HYPOTHESIS — re-derive which call sites can actually reach the bad state before accepting that the fix at the named site is complete',
  'test-quality':
    'the anti-slop lens, aimed at the TESTS: vacuous or tautological assertions; tests that would pass without this change; over-mocking so the mock is what is being tested; assertions on implementation detail instead of observable behavior; missing negative and error cases; sleeps or time-based waits instead of deterministic conditions; skipped or focused tests; tests with no requirement ID; an existing test that asserts the OLD behaviour and still passes (it asserts the bug — it must be inverted, not routed around); a Platform / isWeb / OS branch whose other side nothing executes; a suite whose green ran zero tests',
  'edge-cases-and-security':
    'unhandled inputs and error paths, race conditions, injection/XSS, leaked secrets, unsafe file/network operations, failure modes under bad data; plus authorization on every new endpoint, tenant/ownership scoping on every new query, and any unscoped bulk write; a guard, interceptor or filter whose triggering input cannot exist at the point in the pipeline where it runs (a global guard reading a user that no route guard has set yet) is not protection — name the input that makes it act and prove it exists there',
  operability:
    'the 20-year-DevOps lens: observability on every new failure path (at 2am, what in the logs says this broke); rollback and back-compat; migration reversibility; feature flag / plan / entitlement gating AND who can actually grant it — a gate nothing can turn on is a self-inflicted outage; blast radius; idempotency and double-submit; N+1 and unbounded queries; deploy-day behavior for the users and data that already exist',
  'design-system':
    'new UI inventing tokens, spacing, colors or components instead of reusing the derived system; a new component that an existing one could have composed; missing hover/focus/disabled/loading/empty/error states; accessibility (focus order, labels, contrast, target size); responsive behavior at every supported viewport; motion consistency',
  // Every other lens asks "is what is here correct?". This one asks "what did the
  // plan forget?" — the blind spot no amount of diff-reading closes.
  'scope-coverage':
    'files, modules, call sites, migrations, or config that this change plausibly must touch but which appear in NO work package — orphans the plan forgot. Also: work packages that satisfy no requirement (scope creep), requirements no package satisfies (holes), and sibling code that does the same job in a second place and will now drift. Search by the STATE being mutated (who else writes this status, deletes this row, credits this stock), never only by the feature name — the paths that violate an invariant are the ones that never mention it',
}

// Extra marching orders for lenses whose method differs from "read the diff".
const LENS_NOTES = {
  'scope-coverage':
    'For "scope-coverage" you must look BEYOND the diff: read the artifacts for the full requirement list and the full package list, then search the repo for the code that already does this job (grep for the same function names, routes, config keys, copy strings, or table names) and for every call site of anything the change altered. Name the real file path in the finding when one exists; use "(scope)" only when the gap is a missing package or an unsatisfied requirement with no file to point at.',
}

// scope: null = the whole change (the default). An array of paths narrows the
// FILES this reviewer owns — used only by the cascade partition, where another
// reviewer in the same run owns the rest.
// ownsUnlisted: this reviewer ALSO owns every changed file the partition never
// named. The partition comes from the preflight manifest, which was built before
// the tests and the implementation existed, so a file created during the run
// belongs to no partition — without an owner it would be reviewed by nobody.
function reviewPrompt(lensNames, implSummaries, scope, ownsUnlisted) {
  const list = [].concat(lensNames)
  const notes = list.map((l) => LENS_NOTES[l]).filter(Boolean)
  const scoped = Array.isArray(scope) && scope.length
  return [
    RUN_PREFIX(),
    // BUGFIX MODE, and only when the pack was actually built: the change's blast
    // radius, gathered once. Empty everywhere else, which leaves this prompt
    // byte-identical to the feature-mode one.
    // CONTAINMENT IS NOT FOR EVERY LENS (owner ruling 2026-09-03). "scope-coverage"
    // exists to find what the plan FORGOT — the sibling that mutates the same state
    // and was never enrolled in the new rule (L-029) — so containing it inside the
    // radius would delete its whole job. It gets the pack as a starting MAP and keeps
    // its beyond-the-diff mandate instead. A unit carrying scope-coverage alongside
    // other lenses takes the permissive wording: the broader mandate must never be
    // narrowed by a travelling companion.
    radiusPackText
      ? [
          `RADIUS PACK — the diff hunks, touched export signatures and call sites of the files this fix changes, gathered for you:`,
          radiusPackText,
          list.indexOf('scope-coverage') !== -1
            ? `The radius pack above is your starting map; your mandate is what lies BEYOND it — callers, siblings, and state the diff's files share.`
            : `PRIMARY EVIDENCE: the radius pack above. Open other files only to confirm a specific suspicion, and report any finding OUTSIDE these files only with the caller-path evidence that makes it reachable.`,
        ].join('\n')
      : '',
    list.length === 1
      ? `You are a senior code reviewer looking ONLY through the "${list[0]}" lens: ${LENS_BRIEFS[list[0]]}.`
      : `You are a senior code reviewer carrying ${list.length} lenses in a single pass. Work them ONE AT A TIME, in order, and report the findings of every one — a conclusion under one lens never excuses skipping another.\n${list.map((l) => `- "${l}": ${LENS_BRIEFS[l]}`).join('\n')}`,
    `1. Read the plan at "${planPath}" — it defines intended behavior and acceptance criteria.`,
    `2. See the change: run \`git status --short\` and \`git diff\`; read any untracked new files listed in status. The manifest says WHICH files moved; it does not say what the change means — form that judgment from the diff yourself.`,
    scoped
      ? `2b. YOUR FILES — review these${ownsUnlisted ? '' : ' and only these'}:\n${scope.map((f) => `   - ${f}`).join('\n')}\n   Another reviewer in this same run owns the ${ownsUnlisted ? 'other files the manifest names' : 'rest'}. Read anything else you need for context, but report findings only about your files.`
      : '',
    ownsUnlisted
      ? `2c. FILES THE PARTITION MISSED ARE ALSO YOURS${scoped ? '' : ', AND ARE YOUR ONLY SCOPE'}. The manifest's file list — which every reviewer's scope in this run was cut from — was built at preflight, BEFORE the tests and the implementation were written, so any file created or touched since then is on NO reviewer's list. Run \`git status --short\` and \`git diff --name-only\`: every changed or untracked file named neither above nor in the CONTEXT MANIFEST is yours, at full depth${scoped ? '' : ' — and it is the only thing to report on here, because every file the manifest DOES name is owned by another reviewer in this run'}. Nobody else will look at those files.`
      : '',
    RISK_DEPTH_NOTE,
    `3. Implementation engineers reported: ${JSON.stringify(implSummaries)}`,
    ...notes,
    `4. Report findings ONLY for defects you are confident about and can point to concretely (file + failure scenario). Do not report style nits, hypotheticals you did not check in the code, or praise. An empty findings list is a valid, good answer.`,
    `Severity guide: blocker = breaks the change or violates the plan's acceptance criteria; major = real defect users/devs will hit; minor = real but low-impact.`,
    FIX_COMPLEXITY_NOTE,
  ].filter(Boolean).join('\n')
}

// A broken build makes the whole review round worthless, so it is repaired BEFORE
// the lenses are spent, not after them.
function buildFixPrompt(gateResults) {
  return [
    RUN_PREFIX(),
    `You are the build-fix engineer. The project's verification commands FAILED on the integrated change, so no review of this tree would be worth anything until it builds and runs. ${EDIT_NOTE}`,
    `Failing gate output: ${JSON.stringify(gateResults)}`,
    `Run the failing command(s) yourself, find the real cause, fix it with the MINIMAL correct change, and re-run until they pass.`,
    `Do NOT weaken, skip or delete a test to get green, do NOT delete or comment out the failing code, and do NOT redesign anything: this round exists to make the tree build and run, not to change what it does. A reviewer sees it next.`,
    `Anything you cannot fix that way goes in skipped with a concrete reason — the review runs either way.`,
    FORMAT_NOTE,
  ].filter(Boolean).join('\n')
}

// The cascade's evidence: an Opus reviewer re-reads a deterministic sample of what
// the cheap pass cleared. Its finding count is the whole argument for or against
// ever turning CFG.cascadeReview on by default.
function spotAuditPrompt(files, implSummaries) {
  return [
    RUN_PREFIX(),
    `You are the cascade SPOT AUDIT. A cheaper reviewer already reviewed the files below and reported NOTHING on them. Re-review them yourself, at full depth, through these lenses:`,
    ...FLOOR_LENSES.map((l) => `- "${l}": ${LENS_BRIEFS[l]}`),
    `1. Read the plan at "${planPath}" — it defines intended behavior and acceptance criteria.`,
    `2. Audit exactly these files — read each one and its diff (\`git diff -- <path>\`, and read it whole if it is untracked):`,
    ...files.map((f) => `   - ${f}`),
    `3. Implementation engineers reported: ${JSON.stringify(implSummaries)}`,
    `Report every real defect the cheaper reviewer missed, each with a file and a concrete failure scenario. Do not report style nits or hypotheticals. An empty findings list is a valid, good answer — and it is the evidence that the cheap pass was sufficient.`,
    FIX_COMPLEXITY_NOTE,
  ].filter(Boolean).join('\n')
}

// ONE refuter for every pre-refutable finding on ONE file: the plan, the prefix
// and the file are read once instead of once per finding.
function refuteBatchPrompt(fileKey, list) {
  return [
    RUN_PREFIX(),
    `You are an adversarial verifier. Reviewers claim the defects below exist in or about "${fileKey}". Judge EACH one on its own and try to REFUTE it.`,
    `Read the plan at "${planPath}" and the actual code at each cited location (and its callers if relevant). Trace each failure scenario concretely.`,
    `Claimed findings:`,
    ...list.map((f, i) => `[#${i}] ${JSON.stringify(f)}`),
    `Return one verdict per index. Set refuted=true ONLY if you can demonstrate that finding is wrong, impossible, or explicitly intended by the plan — cite the exact code, spec requirement, or plan line that proves it. If the scenario holds, or you are uncertain, refuted=false. A verdict on one finding never decides another.`,
  ].filter(Boolean).join('\n')
}

// Mechanical and read-only: is the cited code where the finding says it is.
function locationCheckPrompt(list) {
  return [
    RUN_PREFIX(),
    `You are the finding LOCATION check — mechanical and read-only. For each finding below, open the cited file at the cited line (read about 15 lines either side) and decide ONLY whether the code there is what the finding describes: the named function, call, branch, query or statement actually exists at or near that location. Do NOT judge whether the defect is real — another agent does that.`,
    `Findings:`,
    ...list.map((f, i) => `[#${i}] ${f.file}:${f.line || '?'} — ${f.summary}${f.detail ? ` :: ${String(f.detail).slice(0, 240)}` : ''}`),
    `Return one entry per index. locationValid=false when the file does not exist, the cited line is far outside the file, or nothing near it matches the finding's description (a stale or invented citation). When in doubt say false — an invalid location only sends the finding to a stricter reviewer; it never drops it.`,
  ].filter(Boolean).join('\n')
}

function refutePrompt(finding) {
  return [
    RUN_PREFIX(),
    `You are an adversarial verifier. A reviewer claims this defect exists. Your job is to try to REFUTE it.`,
    `The claimed finding: ${JSON.stringify(finding)}`,
    `Read the plan at "${planPath}" and the actual code at the cited location (and its callers if relevant). Trace the failure scenario concretely.`,
    `Set refuted=true ONLY if you can demonstrate the defect is wrong, impossible, or explicitly intended by the plan — cite the exact code, spec requirement, or plan line that proves it. If the scenario holds, or you are uncertain, set refuted=false.`,
  ].filter(Boolean).join('\n')
}

function uiCfgParts(cfg) {
  return {
    flows: cfg.flows && cfg.flows.length ? cfg.flows : ['exercise the surface this change touches, end to end'],
    viewports: cfg.viewports && cfg.viewports.length ? cfg.viewports : ['desktop'],
    checks: cfg.checks && cfg.checks.length ? cfg.checks : ['console-errors', 'network-failures', 'a11y', 'design-system'],
  }
}

// THE DRIVER (Sonnet): operates the real UI and reports FACTS — no verdicts.
function uiDrivePrompt(cfg, priorFindings) {
  const { flows, viewports, checks } = uiCfgParts(cfg)
  const wants = (name) => checks.indexOf(name) !== -1
  const isRerun = Array.isArray(priorFindings)
  return [
    RUN_PREFIX(),
    `You are the UI evidence collector. Exercise the REAL running UI and record what happened as facts — screenshots, assertions, console, network, accessibility measurements. You do NOT decide what is a defect: a separate judge reads your evidence, so capture everything it could need and never assert a visual or behavioral result from reading source.`,
    isRerun
      ? `THIS IS A RE-VERIFICATION. Fix engineers have since edited the code in response to the first browser pass, but they verified their work by READING SOURCE, which cannot prove a visual or behavioral result. Re-drive every flow from scratch at every viewport and take FRESH screenshots. For each earlier finding below, drive the exact flow and viewport it names and record in that flow's notes what the rendered UI shows now — fact, not verdict. Earlier findings: ${JSON.stringify(priorFindings)}`
      : '',
    context ? `Task context from the orchestrator: ${context}` : '',
    `Target URL: ${cfg.url || '(not given — derive it from the dev-server config in this repo)'}`,
    cfg.startCommand
      ? `Start the app with: ${cfg.startCommand}. You OWN that process: STOP it before you report, even if the run fails, a flow blows up, or you run out of ideas. Leave no server, browser, or held port behind.`
      : `Assume the app is already reachable at the target URL. If it is not, start it the way this repo documents — and stop whatever you started before you report.`,
    `PREFERRED TOOL — Playwright, in this repo's existing location: find playwright.config.* and the existing e2e/spec directory, and write your spec THERE, matching the existing specs' naming, fixtures, and auth/storage-state setup. Run it headless. Use semantic locators (getByRole / getByLabel / getByText) over CSS or XPath; add a stable test id only where semantics genuinely cannot address the element. Use web-first auto-retrying assertions (\`await expect(locator).toBeVisible()\`). NEVER waitForTimeout or any sleep. NEVER check visibility and then act on the same element in a separate step — the element can move between the check and the click; act on the locator and let the assertion retry. Create the data each flow needs and scope it to a disposable account/tenant; never assert against data someone else can change.`,
    `FALLBACK — only if this repo has no Playwright and adding it is out of scope for this change: drive the browser MCP tools (\`mcp__Claude_Browser__navigate\`, \`read_page\`, \`computer\`, \`read_console_messages\`, \`read_network_requests\`, \`resize_window\`) and gather the same evidence.`,
    `Flows to drive, each end to end, asserting the outcome the UX spec or plan states for it:`,
    ...flows.map((f, i) => `  ${i + 1}. ${f}`),
    `Viewports: run every flow at each of: ${viewports.join(', ')}. Resize before the flow, not during it.`,
    `Capture per flow per viewport: ${[
      wants('console-errors') ? 'every console error or unhandled rejection, verbatim' : '',
      wants('network-failures') ? 'every request that 4xx/5xx, aborts or times out (method, URL, status)' : '',
      wants('a11y') ? 'accessibility facts — tab order actually observed, controls without an accessible name, focus-ring visibility, contrast and touch-target measurements at the mobile viewport' : '',
      wants('design-system') ? `the rendered surface's tokens and components as facts (class names, computed colors/spacing where they matter) so the judge can compare them with ${designSystemPath ? `the design system at "${designSystemPath}"` : 'the repo\'s design system'}${uxSpecPath ? ` and the UX spec at "${uxSpecPath}"` : ''}` : '',
      'the assertions you ran and whether each passed',
    ].filter(Boolean).join('; ')}.`,
    `Take a screenshot at the end of every flow at every viewport and record its path — it is how the judge and the fixer see what you saw. Write screenshots into the repo's existing test-output/artifacts directory, never into a source directory.`,
    `A flow you could not drive is status "blocked" with the reason in notes, and completed=false. Do not fix anything and do not commit. Stop every process you started before reporting, and say so in processesStopped.`,
  ].filter(Boolean).join('\n')
}

// THE JUDGE (Opus): reads the evidence and the screenshots, never operates the app.
function uiJudgePrompt(cfg, evidence, priorFindings) {
  const { flows, viewports, checks } = uiCfgParts(cfg)
  const isRerun = Array.isArray(priorFindings)
  return [
    RUN_PREFIX(),
    `You are the UI verification judge. A driver agent has just exercised the real running UI and recorded the evidence below. Decide what in it is a defect. Read the screenshot files it names (open them — they are images), the UX spec and design system where given, and the plan's acceptance criteria. Do NOT start the app or drive a browser yourself; if the evidence is insufficient to judge a flow, that is itself a finding.`,
    `Flows that were supposed to be driven: ${flows.map((f, i) => `${i + 1}. ${f}`).join(' | ')} at viewports ${viewports.join(', ')}; checks requested: ${checks.join(', ')}.`,
    `Evidence: ${JSON.stringify(evidence)}`,
    isRerun
      ? `THIS IS A RE-VERIFICATION after a fix round. For each earlier finding below, rule from the FRESH evidence whether it is gone in the rendered UI or still there; report it again if it is still there, and report anything the fixes broke. Earlier findings: ${JSON.stringify(priorFindings)}`
      : '',
    `Rules: a console error or unhandled rejection is a finding, quoted verbatim; a failed or aborted request is a finding with method, URL and status; a flow with status failed or blocked, or one that was not driven at a listed viewport, is a blocker (the change is unexercised there); accessibility gaps against the requested checks are findings; ${checks.indexOf('design-system') !== -1 ? `an invented color/spacing/component, or a missing hover/focus/disabled/loading/empty/error state, judged against ${designSystemPath ? `"${designSystemPath}"` : 'the repo\'s design system'}${uxSpecPath ? ` and "${uxSpecPath}"` : ''}, is a finding; ` : ''}evidence.completed=false or processesStopped=false is a finding in its own right.`,
    `Report ONLY defects the evidence shows, each naming the flow, the viewport and the evidence (console line, request, screenshot path). An empty findings list is a valid, good answer when the evidence is complete and clean. Severity: blocker = the flow cannot be completed, or the change's acceptance criteria fail in the browser; major = a real defect users will hit; minor = real but low-impact.`,
    `${FIX_COMPLEXITY_NOTE}\nA defect seen in a running browser is normally "judgment": its fix has to be re-observed rendered, and reading source cannot prove it.`,
  ].filter(Boolean).join('\n')
}

// Read-only digest agents. They bracket the probes so that the restore is checked
// by something other than the agent that could have broken it.
function checksumPrompt(files, when) {
  return [
    REPO_NOTE,
    `You are a mechanical checksum recorder. Compute a SHA-256 digest for each file below and report it.`,
    `Files:`,
    ...files.map((f) => `- ${f}`),
    `Use \`sha256sum <file>\` in Git Bash, or \`certutil -hashfile <file> SHA256\`. Report the digest as lowercase hex with no spaces.`,
    `Rules: read only. Do NOT modify, create, delete, format or restore any file. Do NOT run tests, builds, installs, or any git command. Do not "helpfully" repair anything you notice.`,
    `Return exactly one entry per file, using the path EXACTLY as written above. If a file cannot be read, return its checksum as the exact string "unreadable".`,
    when === 'after'
      ? `Context: these files were deliberately mutated and then restored by another agent. Your digests are the independent evidence of whether the restore actually happened.`
      : `Context: these files are about to be deliberately mutated and then restored. Your digests are the baseline that restore is checked against.`,
  ].join('\n')
}

function mutationPrompt(t) {
  return [
    RUN_PREFIX(),
    `You are the mutation probe for ONE target. You will deliberately break working code, prove a named test catches it, and then put the code back EXACTLY as it was.`,
    `Target file: ${t.file}`,
    `Behavior that must be protected: ${t.behavior || '(the behavior the named test claims to prove)'}`,
    `Test that must catch the break — run ONLY this, nothing else: ${t.test}`,
    `Do exactly this, in order:`,
    `1. BACK UP, OUTSIDE THE REPO: copy the file into the OS temp directory (Git Bash: "$TMPDIR" when set, else /tmp; a Windows shell: %TEMP%) under a unique name such as "mutprobe-<package-or-target>-<basename>". Use a file copy (\`cp\`), never git. NEVER put the backup beside the file or anywhere else inside the repo — a leftover backup in the tree becomes a shipped file. Report that absolute path as backupPath, and record a checksum of the original (\`sha256sum\` in Git Bash, or \`certutil -hashfile <file> SHA256\`) — REPORT it as preHash.`,
    `2. MUTATE: inject exactly ONE small, deliberate, behavior-breaking defect that a correct implementation would never contain — flip a comparison, drop a rounding/normalization call, return the wrong branch, skip a filter or a scope/ownership condition, move a boundary by one. Do NOT introduce a syntax or type error: the code must still build, or the test would go red for the wrong reason.`,
    `3. RUN: run ONLY the named test. The mutation is CAUGHT only if that test now FAILS on an assertion about behavior. A pass, a skip, or a collection/compile error means NOT caught — report caught=false with the output that proves it.`,
    `4. RESTORE: copy the temp backup back over "${t.file}". NEVER use \`git checkout\`, \`git restore\`, \`git stash\`, \`git reset\`, or any other git command to restore — uncommitted implementation work from this very run lives in this tree and git would destroy it.`,
    `5. VERIFY THE RESTORE: recompute the checksum — REPORT it as postHash — and byte-compare the backup against the file (\`cmp -s\`). They must be IDENTICAL. Only then delete the temp backup and set restored=true.`,
    `If the restore does not verify: set restored=false, LEAVE THE TEMP BACKUP IN PLACE, report its absolute path in backupPath, and state exactly what differs. That is an emergency the orchestrator must see — never report restored=true on a file you did not byte-compare.`,
    `Report caught, restored, backupPath, preHash, postHash, the one-line defect you injected, and evidence: the assertion failure message if caught, or the passing/erroring output that proves the test is blind to this behavior if not. preHash and postHash are load-bearing: independent agents digest this file before and after the whole probe run, and yours are what tells a file you failed to restore apart from one whose baseline was taken while another process was writing the tree.`,
    `Independent checksum agents recorded this file before you started and will recheck it after you finish, so an unreported or partial restore WILL be detected — report honestly.`,
  ].filter(Boolean).join('\n')
}

// A5 MUTANT FEEDBACK WITH ACCEPTANCE BAR (owner ruling 2026-09-11, CFG.mutationRemediate).
// A surviving mutant (the probe's own test did NOT catch the injected defect) goes to
// ONE Sonnet test-author round. It must back up whatever test file(s) it touches, the
// SAME OS-temp-dir convention the probe itself uses, so a failed acceptance bar can be
// reverted mechanically rather than trusted to an improvised undo.
function mutationRemediatePrompt(t, probe) {
  return [
    RUN_PREFIX(),
    `You are the MUTATION-REMEDIATION test author. A mutation probe deliberately broke "${t.file}" and the named test did NOT catch it — the test is too weak, not the implementation (the probe already restored the file to its correct content before you were called).`,
    `Target file: ${t.file}`,
    `Behavior that must be protected: ${t.behavior || '(the behavior the named test claims to prove)'}`,
    `Test that FAILED to catch the mutation: ${t.test}`,
    `The defect the probe injected (already reverted): ${probe && probe.defect ? probe.defect : '(not recorded)'}`,
    `Why it slipped through: ${probe && probe.evidence ? probe.evidence : '(no evidence recorded)'}`,
    `Do exactly this, in order:`,
    `1. BACK UP, OUTSIDE THE REPO, every test file you are about to touch: copy each into the OS temp directory (Git Bash: "$TMPDIR" when set, else /tmp; a Windows shell: %TEMP%) under a unique name such as "mutremediate-<basename>". Use a file copy (\`cp\`), never git. Report the FIRST one as backupPath (if you touch more than one file, note the rest in note).`,
    `2. STRENGTHEN OR ADD exactly the test(s) needed so this specific mutation — the one described above — would be caught. Do not change the implementation. Do not weaken or delete any existing assertion; add or sharpen only.`,
    `3. Run the test(s) against the CURRENT (correct) code and confirm they still PASS — a test that fails on correct code is not acceptable and must not be reported as changed.`,
    `Report filesChanged (every file you actually edited), backupPath (from step 1), and note (one line — what you strengthened and why it now catches the mutation). The engine re-injects the SAME mutation next and checks whether your test now catches it; if it does not, or the suite breaks, your change is reverted from backupPath and this round is recorded as not kept — so do not claim a change you did not make.`,
  ].filter(Boolean).join('\n')
}
// Mechanical revert: copy the pre-remediation backup back over every file the
// remediation touched. Never git — the same reason the probe restore never uses it.
function mutationRemediateRevertPrompt(t, rem) {
  return [
    RUN_PREFIX(),
    `You are the MUTATION-REMEDIATION REVERT agent — mechanical. A test-author's change to "${(rem.filesChanged || [t.file]).join(', ')}" did not meet the acceptance bar (it did not catch the mutation on re-probe, or it broke the gate), so it is being reverted.`,
    `Copy the backup at "${rem.backupPath}" back over "${(rem.filesChanged || [t.file])[0]}" (a file copy, never git). If filesChanged names more than one file and only one backup was reported, restore what you can from the backup and report exactly what you could NOT revert in note — never claim a full revert you did not verify.`,
    `Byte-compare the restored file against the backup (\`cmp -s\`) before reporting restored=true. Report restored and note.`,
  ].filter(Boolean).join('\n')
}
// THE BRIEF (Sonnet, low): the facts the fix planner decides from. Mechanical and
// read-only — the planner opens no file, so anything it is not told here it cannot
// know. Judgment of any kind belongs to the planner, not to this agent.
function fixBriefPrompt(round, list) {
  return [
    RUN_PREFIX(),
    `You are the FIX BRIEF builder for fix round ${round} — mechanical and read-only. A planner decides every fix in this round from what you write down, and it opens no file itself. Gather the facts; judge nothing.`,
    `Return one item per finding, carrying that finding's index:`,
    `- excerpt: the code around the cited line — about 60 lines centred on it, or the WHOLE file when the file is under 80 lines. A finding whose "file" is a name in parentheses names a PHASE, not a file ((gate), (red-gate), (mutation), (tests), (artifact), (gate-command), (implementation)): return an empty excerpt for those, and for a file that does not exist.`,
    `- callers: up to 8 call sites of the exported function, method, class or constant that ENCLOSES the cited line — grep the repo (excluding node_modules, dist and build output) and give each as "path:line — the calling expression". Empty when the code is not reachable from an export, or you cannot find any.`,
    `- note: ONE line of anything MECHANICAL the planner must know — the file does not exist, the cited line is past the end of the file, the enclosing symbol could not be located, the excerpt was truncated. Empty string when there is nothing to say.`,
    `Findings:`,
    ...list.map((f, i) => `[#${i}] ${f.file}:${f.line || '?'} — ${f.summary}`),
    `Do NOT decide whether a finding is real, do NOT propose a fix, and do NOT create, modify or delete any file. Read only.`,
  ].filter(Boolean).join('\n')
}

// THE PLANNER (Fable, high): ONE decision over every finding in the round. No
// RUN_PREFIX — it is a decider, like the tie-break judge and the final-pass
// decider: it reads no file and runs no command (Fable is the brain, never the
// hands, owner ruling 2026-09-03), so everything it may rule on is in this prompt.
function fixPlanPrompt(round, list, briefItems, briefRan) {
  return [
    `You are the FIX PLANNER for round ${round} of a code review's fix loop. You decide; you do not read the repository, run commands or gather anything — everything you may rule on is below. Where the evidence is insufficient, choose "fix" with a conservative design: a dropped real defect ships.`,
    context ? `Task context from the orchestrator: ${context}` : '',
    `The run's own oracles: ${runOracles()}`,
    briefRan
      ? ''
      : `NOTE: the brief agent died, so there are NO code excerpts and NO call sites below. Decide from the findings themselves and keep every design conservative.`,
    `Decide EVERY finding by its index, and give action, design, invariant, tests, route and reason for each:`,
    `- "fix" — the design in 2 to 6 sentences: what changes, where, and what must NOT change; plus the invariant the change has to preserve and the test to add or strengthen (name the T#/REG token when one exists). The executor implements your design exactly and is forbidden to improvise, so an under-specified design is a wasted round.`,
    `- "dispute" — ONLY when the excerpt or the failure scenario itself proves the finding is not real; put that proof in reason. Independent adversarial refuters re-judge every dispute, so you never drop a finding on your own. A finding marked disputeUpheld has already survived that slate and may NOT be disputed again.`,
    `- "defer" — ONLY when the fix needs a decision this run cannot make (a planning defect or an owner call) — NEVER for difficulty. Put the question in reason. A deferred finding is not fixed this run: it stays open in the result as an owner question, with your reason, and the run cannot be clean while it is there. A hard fix is still a "fix".`,
    `- route: "mechanical" only when the design is a pure transcription (a rename, an import, a path, stale text); "sonnet" for a designed change on a LOW-risk file; "opus" for anything on a HIGH-risk file, any finding whose file is a name in parentheses, and anything whose design still leaves a judgment to the executor. The engine upgrades HIGH-risk files and broad parenthesised keys to "opus" whatever you say — spend your routing decision on everything else.`,
    `- waves: groups of indices that may execute CONCURRENTLY; every later wave runs strictly after the earlier ones. Put each index you marked "fix" in exactly one wave, and keep two findings on the same file in the same wave — the engine serializes by file either way, and it discards the whole wave list if an index is missing, named twice, or one file is split across waves.`,
    `- ruled (A2, optional, "fix" only): set true ONLY when you are confirming this finding as REAL from evidence already cited above, for a finding with NO runnable check (nothing a test could show red or green either way). Leave it false/absent when a check exists — that finding earns execution evidence from its executor instead, never your say-so.`,
    `A finding marked designMismatch carries the last executor's report of why your previous design did not fit the code it found — re-decide that finding with the report in hand, not by repeating the design.`,
    `Indices refer to the numbered list below, INCLUDING the findings you dispute or defer — the numbering never shifts under you, and every field that takes an index (decisions, waves) uses that one numbering.`,
    `Findings to decide:`,
    ...list.map((f, i) => {
      const b = briefItems.get(i)
      const callers = b && Array.isArray(b.callers) ? b.callers.filter(Boolean) : []
      return [
        `[#${i}] [${f.severity || '?'}] ${f.file}${f.line ? ':' + f.line : ''} — ${f.summary}`,
        `    scenario: ${f.detail || '(none given)'}`,
        f.fixHint ? `    reviewer's fix hint: ${f.fixHint}` : '',
        `    fixComplexity: ${f.fixComplexity || 'judgment'}${f.source ? `; source: ${f.source}` : ''}${f.phase ? `; raised by: ${f.phase}` : ''}`,
        f.disputeUpheld ? `    disputeUpheld: a previous fixer disputed this and the independent refuters UPHELD it — you may not dispute it again.` : '',
        f.designMismatch ? `    designMismatch: ${f.designMismatch}` : '',
        b && b.note ? `    brief note: ${b.note}` : '',
        callers.length ? `    call sites of the enclosing export:\n${callers.map((c) => `      ${c}`).join('\n')}` : '',
        b && b.excerpt ? `    code around the cited line:\n${String(b.excerpt).split('\n').map((l) => `      ${l}`).join('\n')}` : '    code: (none supplied)',
      ].filter(Boolean).join('\n')
    }),
    `Finally, in note: this round's plan in one paragraph, for the close-out.`,
  ].filter(Boolean).join('\n')
}

// route: 'mechanical' (this group is running on the cheap fixer) or 'judgment'.
// designs: the planner's decision per finding, aligned with `group` — null/absent
// when the fix planner is off or declined, which leaves this prompt byte-identical
// to what it was before the planner existed.
function fixPrompt(fileKey, group, route, designs) {
  const planned = Array.isArray(designs) && designs.some(Boolean)
  return [
    RUN_PREFIX(),
    `You are the fix engineer for confirmed review findings. ${EDIT_NOTE}`,
    `Read the plan at "${planPath}" for intended behavior, then fix each confirmed finding below with the MINIMAL correct change. Findings are in or about "${fileKey}":`,
    JSON.stringify(group, null, 2),
    `Those findings are numbered [#0], [#1], — in the order they appear above. Whenever you report one under \`skipped\` or \`disputed\`, give its \`index\` as well as its summary: a summary you paraphrase cannot be matched back to the finding, and a report nobody can match is a defect nobody acts on.`,
    planned
      ? [
          `A planner (Fable 5.1) has already DECIDED each of these fixes, by the same indices:`,
          ...group.map((f, i) => (designs[i]
            ? `FABLE'S DESIGN for [#${i}]: ${designs[i].design || '(no design given — use the reviewer\'s fix hint)'} | invariant: ${designs[i].invariant || '(none given)'} | tests: ${designs[i].tests || '(none given)'}`
            : '')),
          `Implement the design exactly. If the design does not fit the code you find, do NOT improvise: put the finding in \`skipped\` with a reason starting "design mismatch:" and what you actually found. The planner re-decides it next round with your report — an improvised fix against a wrong design is the one outcome nothing downstream can catch.`,
        ].filter(Boolean).join('\n')
      : '',
    route === 'mechanical'
      ? `Every finding here was classified MECHANICAL: its fix is fully determined by the defect itself — a wrong path, a broken link, a stale cross-reference, a renumbering, a missing import, a budget overrun. Make exactly that fix. Do not redesign, do not refactor, and do not change behavior. If a finding turns out to need a decision about what the code SHOULD do, do NOT guess: put it in skipped with the reason "needs a judgment fixer", which routes it correctly on the next round.`
      : `These findings need judgment: decide what the code should actually do, then make the smallest change that does it.`,
    `REFUTE FIRST. Before changing code for any finding, verify it in the actual code. If you can DEMONSTRATE that a finding is wrong, impossible, or explicitly intended by the plan, do NOT touch the code for it: put it in \`disputed\` with its summary copied exactly and the exact code or plan line that proves it. Independent adversarial refuters re-judge every dispute, so a dispute never silently drops a finding — and a wrong fix on a false finding is worse than a dispute. \`skipped\` is for findings that are real but cannot be fixed here.`,
    `EXECUTION EVIDENCE (A2): if a runnable test actually failed against the ORIGINAL code and passes after your change, report it in \`verifiedFixes\` (summary, the exact test, what redOn/greenOn showed) — this is what promotes a finding from plausible to execution-verified. Never fabricate a run you did not do.`,
    group.some((f) => f.disputeUpheld)
      ? `Findings marked "disputeUpheld": a previous fixer disputed them and the independent refuters UPHELD them. Fix these — disputing them again is not allowed.`
      : '',
    `You may edit whichever files the fixes genuinely require, but keep changes minimal and in-style. Never fake a fix.`,
    FORMAT_NOTE,
    fileKey === '(gate)' ? `For gate failures: run the failing command(s) yourself, fix the cause, and re-run until they pass.` : '',
    fileKey === '(red-gate)'
      ? `For red-gate findings: the named test never proved it can fail. Strengthen it so it asserts the real observable behavior and would have failed before this change existed. Never weaken, skip, or delete it. If the behavior genuinely already existed before this change, put that in skipped and say so plainly — that is a planning defect, not something to paper over.`
      : '',
    fileKey === '(mutation)'
      ? `For mutation-probe findings, in this order: (a) RESTORATION FIRST — if a finding says a file was not restored, or that its checksum changed across the probe, put that file back by copying the backup the finding names (it is in the OS temp directory) over the file, byte-compare them (\`cmp -s\`), then delete the backup; if no backup path is named, look for a ${PROBE_BACKUP_GLOB} copy of the file in the OS temp directory, and if there is none, reconstruct the correct content by hand from the plan and say so plainly. NEVER \`git checkout\`/\`restore\`/\`stash\`/\`reset\` — uncommitted work from this run would be destroyed. (b) then strengthen or add the named test so it fails when that behavior breaks. Never weaken the implementation to match a weak test.`
      : '',
    fileKey === '(gate-command)'
      ? `For "(gate-command)" findings: the named verification command ALREADY failed on the unmodified tree, before any of this work existed — the command is broken, not the code. Do NOT change product code, tests, or config to make it pass, and do NOT invent a replacement command. Fix it only if the cause is a genuine, safe repo-level repair. Otherwise put it in skipped with the reason "broken verification command — must be corrected in the build plan", which is exactly the right answer here.`
      : '',
    fileKey === '(artifact)'
      ? `For "(artifact)" findings: a planning artifact asserts something about this repo that is not true. Correct the ARTIFACT text so it matches reality — you may edit the artifact file at the path named in the finding even if it lies outside the worktree, and nothing else outside it. Change code only when the plan genuinely requires that file, script or symbol to exist and this change was supposed to create it. Never invent a path, script or export just to make a claim true.`
      : '',
    fileKey === '(tests)'
      ? `For test-authoring findings: finish or repair the test package. Tests only — do not use this round to write implementation code.`
      : '',
    group.some((f) => f.source === 'ui-verify')
      ? `At least one finding above is marked "source": "ui-verify" — it was observed by DRIVING THE REAL UI, and its detail cites the flow, the viewport and a screenshot. Reading the source cannot prove such a fix. After you change the code, re-drive that flow at that viewport with Playwright (or the browser MCP fallback: \`mcp__Claude_Browser__navigate\`, \`read_page\`, \`computer\`, \`read_console_messages\`, \`read_network_requests\`, \`resize_window\`), take a FRESH screenshot, and re-read the console and network. Cite the new screenshot path in your report. If you cannot drive the UI, put the finding in skipped saying the fix is unverified — never claim a visual fix you did not see rendered. Stop any dev server or browser you started.`
      : '',
  ].filter(Boolean).join('\n')
}

// scopeFiles = what the fixers changed + the locations the findings cite. Re-reading
// the whole change every round buys nothing: only these files can have moved.
// heldOut: findings this round deliberately did NOT hand to a fixer — the fix
// planner disputed them (the adversarial slate is judging them right now) or
// deferred them (they need a decision this run cannot make). Both are already
// recorded; re-litigating them here would either double-count or quietly bury one.
// Empty on the legacy path, which leaves this prompt exactly as it was.
function recheckPrompt(fixedFindings, fixReports, scopeFiles, heldOut) {
  const scoped = Array.isArray(scopeFiles) && scopeFiles.length
  const held = heldOut || { disputed: [], deferred: [] }
  return [
    RUN_PREFIX(),
    `You are the re-check reviewer after a fix round.`,
    `1. Read the plan at "${planPath}".`,
    `2. These findings were supposed to be fixed: ${JSON.stringify(fixedFindings)}`,
    `3. The fixers reported: ${JSON.stringify(fixReports)}`,
    scoped
      ? `4. SCOPE — these are the files the fixers changed plus the locations the findings cite. Read THESE; do not re-read the rest of the change, which nothing in this round touched:\n${scopeFiles.map((f) => `   - ${f}`).join('\n')}\n   Verify in the ACTUAL CODE that each finding is genuinely resolved. If a file you had to open anyway shows a regression the fixes introduced, report it — but do not go hunting outside this scope.`
      : `4. Verify in the ACTUAL CODE that each finding is genuinely resolved, and skim the files the fixers changed for regressions the fixes introduced.`,
    RISK_DEPTH_NOTE,
    `Report as findings: anything still broken (carry it over) plus any NEW defect the fixes introduced. Empty findings = everything is clean. Do not re-litigate findings the fixers skipped with a sound reason — drop those. Findings the fixers listed under \`disputed\` are being re-judged by independent refuters right now — do not rule on them either way; leave them out of your report.`,
    held.disputed && held.disputed.length
      ? `The fix planner DISPUTED these findings, so no fixer touched them and the same adversarial slate is judging them right now — leave them out of your report too:\n${held.disputed.map((s) => `   - ${s}`).join('\n')}`
      : '',
    held.deferred && held.deferred.length
      ? `The fix planner DEFERRED these findings — they need a decision this run cannot make, they are already recorded as open, and this run will not fix them. Do not report them and do not treat them as resolved:\n${held.deferred.map((s) => `   - ${s}`).join('\n')}`
      : '',
    FIX_COMPLEXITY_NOTE,
  ].filter(Boolean).join('\n')
}

// ---------- helpers ----------
// Normalize path spellings so 'src\\a.ts', './src/a.ts', and 'src/a.ts' are one key.
function normPath(p) {
  return (p || '').replace(/\\/g, '/').replace(/^\.\//, '')
}

// Also the single funnel where every finding acquires a routing tag: an agent that
// omitted fixComplexity, and every finding this script authors itself, defaults to
// 'judgment' — the safe side of the mechanical/judgment decision.
// Identity of a finding across phases. f.target names the REAL file a
// synthetic-key finding ('(mutation)', …) is about. Without it those findings are
// separated only by the first 60 chars of their summary, so two targets whose
// paths share a long prefix collapse into one and the second file is never named
// to any fixer.
const findingKey = (f) => `${normPath(f.file)}::${normPath(f.target || '')}::${f.line || ''}::${(f.summary || '').toLowerCase().slice(0, 60)}`
// How a fixer's echoed summary is matched back to the finding it disputes.
const normSummary = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60)
// CORROBORATION. dedupe() keeps the FIRST finding for a key and discards the rest, so
// the fact that several independent lenses reported the same defect used to be thrown
// away with the duplicates. Count it at merge time instead: findingKey -> the set of
// DISTINCT review agents that reported it. Evidence for why: on F13 the run's top
// blocker was reported by 6 lenses independently, and the refuter overturn rate was
// 16% — a finding several lenses saw is not the kind a refuter usually overturns.
const corroborationOf = new Map()
function noteCorroboration(label, list) {
  for (const f of list || []) {
    if (!f || !f.file) continue
    const k = findingKey(f)
    const set = corroborationOf.get(k) || new Set()
    set.add(label)
    corroborationOf.set(k, set)
  }
}
// 1 for a finding no lens corroborated (or that no lens raised at all).
function corroborationCount(f) {
  const set = corroborationOf.get(findingKey(f))
  return set && set.size ? set.size : 1
}
// C2 LENS REPORT (owner ruling 2026-09-11c, engine wave 3C, "A7 signal-not-volume
// per-lens telemetry"). Two module-level collections, filled in as the run
// happens (findings are deduped/mutated/rewrapped downstream, so this is
// captured at the ONLY point every raw review finding is still attributable to
// the exact lens that raised it):
//   lensRawFindings — one entry per RAW finding a review unit returned, before
//     dedupe/merge, tagged with the lens name, model and effort that call used.
//   dropReasonByKey — every findingKey() the shared slate (judgeFindings) ever
//     dropped, at BOTH call sites (Verify's initial pass and the fix loop's
//     dispute judging) — judgeFindings is the one function both go through, so
//     one instrumentation point covers "overturned" everywhere a finding can
//     be refuted away.
const lensRawFindings = []
const dropReasonByKey = new Map()
// buildLensReport() runs at close-out, after confirmedInitial's findings carry
// their final .verification (execution/ruled/plausible) — see near resultObj.
// A merged small-scale unit (mergeLensesOnSmall, unit.lenses.length > 1) has no
// per-finding lens attribution from the model's own response, so its raw
// findings are tagged with the unit's pseudo-name (e.g. "small-combined")
// rather than guessed apart — an honest row for what actually ran as one agent,
// not a fabricated split.
function buildLensReport() {
  const finalStateByKey = new Map()
  for (const f of confirmedInitial) finalStateByKey.set(findingKey(f), f.verification)
  const byLens = new Map()
  for (const r of lensRawFindings) {
    let row = byLens.get(r.lens)
    if (!row) {
      row = { lens: r.lens, model: r.model, effort: r.effort, rawFindings: 0, corroborated: 0, executionConfirmed: 0, ruled: 0, plausible: 0, overturned: 0 }
      byLens.set(r.lens, row)
    }
    row.rawFindings++
    row.model = r.model
    row.effort = r.effort
    const corrSet = corroborationOf.get(r.key)
    if (corrSet && corrSet.size > 1) row.corroborated++
    const state = finalStateByKey.get(r.key)
    if (state === 'execution') row.executionConfirmed++
    else if (state === 'ruled') row.ruled++
    else if (state === 'plausible') row.plausible++
    if (dropReasonByKey.has(r.key)) row.overturned++
  }
  return [...byLens.values()]
}
function dedupe(findings) {
  const seen = new Set()
  const out = []
  for (const f of findings) {
    const key = findingKey(f)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(f.fixComplexity === 'mechanical' || f.fixComplexity === 'judgment' ? f : { ...f, fixComplexity: 'judgment' })
  }
  return out
}

function groupByFile(findings) {
  const groups = {}
  for (const f of findings) {
    const key = normPath(f.file) || '(unknown)'
    ;(groups[key] = groups[key] || []).push(f)
  }
  return Object.entries(groups)
}

// ---------- risk ----------
// Filled from the preflight manifest. UNKNOWN IS HIGH, always: a file nobody
// classified gets the deepest review, the judgment fixer and the mutation probe —
// never the cheap path. Risk sets DEPTH and ROUTING; it never removes a file from
// a lens's coverage.
const riskMap = {}
const changedLinesMap = {}
// The manifest's own status word per path ('modified' | 'added' | 'untracked' |
// 'deleted' | 'planned'), used by the bugfix fix-revert probe to tell a file that HAS
// committed content to revert to from one that does not. Unknown = '' = no claim.
const statusMap = {}
const fileStatus = (p) => statusMap[normPath(p)] || ''
// A file with no committed content cannot be reverted to HEAD. 'planned' and
// 'untracked' say so outright; every other status (including an unknown one) leaves
// the decision to the probe agent's own `git ls-files` / `git show HEAD:` check.
const hasNoHeadContent = (p) => {
  const s = fileStatus(p)
  return s === 'untracked' || s === 'planned'
}
function fileRisk(p) {
  const k = normPath(p)
  return Object.prototype.hasOwnProperty.call(riskMap, k) ? riskMap[k] : 'HIGH'
}
const isHighRisk = (p) => fileRisk(p) === 'HIGH'
const changedLinesOf = (p) => changedLinesMap[normPath(p)] || 0
// E3 (owner ruling 2026-09-11, wave 3): every synthetic finding key the engine
// itself emits as a `file`/`fileKey` value — collected by grepping every '(...)'
// literal this script creates, not by shape. A lens-supplied `file` like
// '(architecture)' is NOT one of these: it is a normal finding — plausible,
// refutable, routed as a real path — and keeps its `file` verbatim. Only the
// engine's own vocabulary counts as "names a phase, not a file".
const SYNTHETIC_KEYS = new Set([
  '(artifact)', '(gate)', '(gate-command)', '(red-gate)', '(mutation)',
  '(mutation-remediation)', '(tests)', '(review)', '(implementation)',
  '(ui-verify)', '(build-plan)', '(broad-fix)', '(ui-fix)', '(unknown)',
  '(final-pass)',
])
const isRealPath = (f) => typeof f === 'string' && f.length > 0 && !SYNTHETIC_KEYS.has(f)
// What a probe's temp backup is called, for the fixer that may have to restore from
// it. Bugfix mode adds the fix-revert probe, which names its backups differently — a
// fixer told to look for the wrong glob finds nothing and reconstructs by hand.
const PROBE_BACKUP_GLOB = bugfix ? '"mutprobe-*" / "revertprobe-*"' : '"mutprobe-*"'

// ---------- fix routing ----------
// Where the fix tokens went, in the three tiers a round can use: `mechanical` (the
// cheap fixer), `sonnetDesigned` (a Fable-designed change on a LOW-risk file — only
// ever non-zero with CFG.fixPlanning on) and `judgment` (the review model: HIGH-risk
// files, broad synthetic keys, and everything the legacy route calls judgment).
// It is what RAN; fixPlanning.rounds[].routes is what Fable ASKED FOR. The two
// diverge at exactly one place: where the engine upgraded a group to the review
// model (a HIGH-risk file, a broad synthetic key, or a ui-verify finding).
const fixRouting = { mechanical: 0, sonnetDesigned: 0, judgment: 0 }
// Route rank, so a group takes the DEEPEST tier any of its findings needs.
const ROUTE_RANK = { mechanical: 0, sonnet: 1, opus: 2 }
// The engine's own upgrade, applied whatever the planner said: a HIGH-risk file, a
// synthetic key whose fix is not textual, or a group carrying a finding observed by
// DRIVING THE UI is executed on the review model. The two key exceptions are exactly
// the ones fixRoute() already carves out — rewriting a false claim in an artifact,
// and correcting a verification command broken before this run. The ui-verify clause
// matches fixRoute()'s: such a fix has to be re-observed rendered in a browser, which
// reading source cannot do, so it never goes to a cheaper executor however simple the
// design looks.
function forcesOpus(fileKey, group) {
  if (!isRealPath(fileKey)) return fileKey !== '(artifact)' && fileKey !== '(gate-command)'
  if (isHighRisk(fileKey)) return true
  return Array.isArray(group) && group.some((f) => f && f.source === 'ui-verify')
}
// The tier each route actually runs at. 'judgment' is the legacy spelling of 'opus'.
function executorTier(route) {
  if (route === 'mechanical') return { model: CFG.mechanicalFixModel, effort: CFG.effort.mechanicalFix, counter: 'mechanical' }
  if (route === 'sonnet') return { model: CFG.fixExecuteSonnetModel, effort: CFG.effort.fixExecuteSonnet, counter: 'sonnetDesigned' }
  return { model: CFG.reviewModel, effort: CFG.effort.judgmentFix, counter: 'judgment' }
}
// The reviewer that found a defect tagged how it must be fixed. Mechanical work
// goes to the cheap model; anything needing a decision — and everything touching a
// HIGH-risk file — stays on the review model. Missing tag = judgment.
function fixRoute(fileKey, group) {
  // A synthetic key's fix is a decision (repair a build, restore a mutated file,
  // strengthen a test) whatever the tag says. The exceptions are the two whose
  // fix is textual: rewriting a false claim in an artifact, and correcting a
  // verification command that was already broken before this run started.
  if (!isRealPath(fileKey) && fileKey !== '(artifact)' && fileKey !== '(gate-command)') return 'judgment'
  if (isRealPath(fileKey) && isHighRisk(fileKey)) return 'judgment'
  for (const f of group) {
    if (f.fixComplexity !== 'mechanical') return 'judgment'
    if (f.source === 'ui-verify') return 'judgment' // must be re-observed in a browser
    if (isRealPath(f.file) && isHighRisk(f.file)) return 'judgment'
  }
  return 'mechanical'
}

// Command spellings differ only in whitespace; one key per command.
const normCmd = (c) => (c || '').trim().replace(/\s+/g, ' ')
function uniqueCommands(list) {
  const seen = new Set()
  const out = []
  for (const c of list) {
    const k = normCmd(c)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}

function uniquePaths(list) {
  const seen = new Set()
  const out = []
  for (const p of list) {
    if (!p) continue
    const k = normPath(p)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}

// Commands that already failed on the untouched baseline tree. Their later
// failures say nothing about this change, so they are excluded from the pass/fail
// decision — filled by the Baseline phase, empty when it did not run.
const badCommandSet = new Set()
const isBadCommand = (c) => badCommandSet.has(normCmd(c))

// CWD ENFORCEMENT (owner ruling 2026-09-11e, RUN-LOG train4-run-c). Detection
// only — askAgent has no cwd option, so this cannot stop a gate agent from
// running in the wrong directory, only catch it after the fact from the `cwd`
// it was told to self-report (CWD_NOTE). Applied to every GATE_SCHEMA result
// the moment it comes back, before ANYTHING else reads .pass — several call
// sites read g.pass directly (bGate.pass, gateStillGreen, finalGate's `pass:
// gate.pass`), not only through gateProblem(), so the correction has to live in
// the raw object, not just in gateProblem's verdict. It sets a top-level
// `cwdMismatch` reason rather than injecting a synthetic per-command result row
// on purpose: a per-command row would flow through the Baseline phase's
// badCommandSet exclusion (a workdir mismatch is not "this command is broken",
// it is "nothing here ran where it should have") and a REPEATED mismatch at a
// later gate would then be silently excluded as "already broken at baseline".
// sanitizeCwd: a gate agent on PowerShell may report Get-Location's table
// output ("\nPath\n----\nC:\\ClaudeCode\\routeflow") instead of a single path
// line — strip the header/rule lines and take the first real content line.
function sanitizeCwd(raw) {
  const s = typeof raw === 'string' ? raw : ''
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(Path|-+)$/i.test(l))
  return lines.length ? lines[0] : ''
}
function enforceCwd(g, label) {
  if (!g || !workdir) return g
  const cwd = sanitizeCwd(g.cwd)
  if (!cwd) {
    log(`WARNING: gate did not report cwd; cwd enforcement skipped (${label})`)
    return { ...g, cwdUnreported: true }
  }
  const norm = (p) => p.replace(/\\/g, '/').replace(/^\/mnt\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:').replace(/\/+$/, '').toLowerCase()
  if (norm(cwd) === norm(workdir)) return g
  log(`!!! Gate cwd mismatch (${label}): ran in "${cwd}", not the workdir "${workdir}" — treating this gate as pass:false`)
  return { ...g, pass: false, cwdMismatch: `ran outside workdir: ${cwd}` }
}
// Returns null when a gate result is acceptable, else the detail string for a
// '(gate)' finding. Only failures of commands that WORK at baseline count. An
// unknown — dead agent, or pass:false with no per-command evidence — is never
// acceptable: it must not read as success.
// Commands whose green means "tests ran and passed" — the only ones where a zero
// execution count is a lie. Typecheck and lint legitimately "run" no tests.
const isTestCommand = (c) => /\b(jest|vitest|mocha|playwright|test|tests|spec|e2e)\b/i.test(c || '')
function gateProblem(g) {
  if (!g) return 'The gate agent died or was skipped, so no verification evidence exists for this run.'
  if (g.cwdMismatch) return g.cwdMismatch
  if (g.skipped) return null
  const results = Array.isArray(g.results) ? g.results : []
  const failed = results.filter((r) => r && r.pass === false)
  const real = failed.filter((r) => !isBadCommand(r.command))
  if (real.length) return JSON.stringify(real)
  // A green that executed nothing is not green: a cache replay or a skipped step
  // reports success with zero tests run (this project's L-034 / L-041 class).
  const hollow = results.filter((r) => r && r.pass === true && r.executed === 0 && isTestCommand(r.command) && !isBadCommand(r.command))
  if (hollow.length) return `Reported green but EXECUTED NOTHING: ${JSON.stringify(hollow)}. A test command that ran zero tests (cache replay, skipped step, empty filter) proves nothing — force execution and re-run.`
  if (g.pass === true) return null
  if (failed.length) return null // every failure was a command already broken at baseline
  return `The gate reported pass:false but listed no failing command — treat it as unverified, not as a pass. Raw results: ${JSON.stringify(results)}`
}

// A6 FLAKY QUARANTINE AT THE GATE (owner ruling 2026-09-11, CFG.flakyReruns).
// Called on a gate that FAILED (gateProblem(g) truthy), before that failure is
// trusted as the red-bar/fix trigger. No-op (zero reruns spent) unless the gate
// report actually names failedTests — this is a strict addition to evidence
// that exists, never a substitute for reading a failure honestly. A test that
// fails in every rerun is left exactly as reported (isBadCommand-excluded
// commands are never touched — they are already excluded from gateProblem).
async function applyFlakyQuarantine(g, commands, labelPrefix) {
  const quarantined = []
  const quarantineAbandoned = []
  if (!CFG.flakyReruns || !g || !Array.isArray(g.results)) return { gate: g, quarantined, quarantineAbandoned }
  const flakyCandidates = g.results.filter((r) => r && r.pass === false && !isBadCommand(r.command) && Array.isArray(r.failedTests) && r.failedTests.length)
  if (!flakyCandidates.length) return { gate: g, quarantined, quarantineAbandoned }
  log(`Flaky quarantine: ${flakyCandidates.length} failing command(s) named specific tests — spending ${CFG.flakyReruns} rerun(s) on the same tree before trusting the failure`)
  const reruns = []
  for (let i = 1; i <= CFG.flakyReruns; i++) {
    reruns.push(await askAgent(gatePrompt(commands), { label: `${labelPrefix}:r${i}`, phase: 'Gate & Review', model: CFG.gateModel, effort: CFG.effort.gate, schema: GATE_SCHEMA }))
  }
  // A null/malformed rerun is NO EVIDENCE, never a pass. A dead rerun call proves
  // nothing about ANY command in this batch, so it forces every flaky candidate
  // back to "leave exactly as reported" rather than letting it slip through as
  // "did not reproduce" (an empty failedTests set from a dead call would otherwise
  // read identically to a genuine non-reproduction).
  const deadReruns = reruns.filter((rr) => !rr || !Array.isArray(rr.results))
  const newResults = g.results.map((r) => {
    if (flakyCandidates.indexOf(r) === -1) return r
    if (deadReruns.length) {
      quarantineAbandoned.push({ command: r.command, reason: 'dead rerun' })
      log(`Flaky quarantine: "${r.command}" — ${deadReruns.length}/${CFG.flakyReruns} rerun(s) returned no evidence (null or missing results[]) — abandoning quarantine, leaving the failure exactly as reported`)
      return r
    }
    const testFailCount = new Map(r.failedTests.map((name) => [name, 0]))
    for (const rr of reruns) {
      const rrResult = rr.results.find((x) => x && x.command === r.command)
      const rrFailed = new Set(rrResult && Array.isArray(rrResult.failedTests) ? rrResult.failedTests : [])
      for (const name of testFailCount.keys()) if (rrFailed.has(name)) testFailCount.set(name, testFailCount.get(name) + 1)
    }
    let anyGenuine = false
    for (const [name, failures] of testFailCount) {
      if (failures === CFG.flakyReruns) {
        anyGenuine = true // failed EVERY rerun — a confirmed, non-flaky failure
      } else if (failures > 0) {
        // Some but not all — the literal A6 quarantine signature.
        quarantined.push({ name, command: r.command, runs: CFG.flakyReruns, failures })
      }
      // failures === 0: did not reproduce in any rerun — cleared, neither
      // quarantined nor treated as genuine, but never what forces pass:true
      // on its own if a sibling test on the same command IS genuine.
    }
    if (anyGenuine) return r // still a real failure — leave it exactly as reported
    log(`Flaky quarantine: "${r.command}" has NO confirmed-genuine failure left after ${CFG.flakyReruns} rerun(s) — treating it as passed for the gate/fix trigger (raw failure kept for the audit trail)`)
    return { ...r, pass: true, flakyOverride: true }
  })
  if (quarantined.length) log(`Flaky quarantine: ${quarantined.length} test(s) quarantined — ${quarantined.map((q) => `${q.name} (${q.failures}/${q.runs})`).join(', ')}`)
  // Recompute the top-level pass too — gateProblem() reads it as a fallback when
  // no per-result failure remains, so a stale pass:false from the ORIGINAL
  // (pre-quarantine) gate would still read as "failed, no command named" and
  // block on nothing real.
  return { gate: { ...g, results: newResults, pass: newResults.every((r) => r && r.pass !== false) }, quarantined, quarantineAbandoned }
}

// One rule for what counts as a digest, used by both the agents' reports and the
// probes' self-reported preHash/postHash: lowercase hex, no spaces, or nothing at all.
function normHash(v) {
  const h = String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase()
  return /^[0-9a-f]{32,}$/.test(h) ? h : ''
}
// Digest reports -> { normalizedPath: digest }. Anything that is not a hex digest
// becomes '', so two unreadable files never compare equal to each other.
function checksumMap(report) {
  const m = {}
  if (!report || !Array.isArray(report.files)) return m
  for (const row of report.files) {
    if (!row || !row.file) continue
    m[normPath(row.file)] = normHash(row.checksum)
  }
  return m
}

// ---------- per-phase telemetry ----------
// Every phase entry is bracketed by a budget.spent() reading so the cost of a
// phase is measured, not guessed, and a phase that only ever produces refuted
// noise becomes visible across runs.
const PHASE_TITLES = ['Baseline', 'Author tests', 'Red gate', 'Implement', 'Gate & Review', 'Verify', 'UI verify', 'Mutation probe', 'Fix', 'Final pass']
// What each phase spends its tokens ON. A phase that mixes tiers says so, because
// "Red gate: 40k" means something different at Haiku prices than at Opus prices.
// These are the phase DEFAULTS; a per-package `model` override from the plan moves
// individual agents without changing this line.
const PHASE_MODELS = {
  Baseline: `${CFG.gateModel} (gate/grounding/manifest)${wantHarnessCheck ? ` + ${CFG.harnessCheckModel} (harness check)` : ''}`,
  'Author tests': CFG.testModel,
  'Red gate': `${CFG.gateModel} (run) + ${CFG.reviewModel} (audit/remediate)`,
  Implement: CFG.implementModel,
  // R1 CALIBRATION (owner ruling 2026-09-11): build-fix and recheck now default
  // to their CFG.routing.*RoutineModel (Sonnet), escalating to CFG.reviewModel
  // only when the manifest has a HIGH-risk file — same pattern as UI verify below.
  'Gate & Review': `${CFG.gateModel} (gate/regate) + ${CFG.routing.buildFixRoutineModel} (build-fix; ${CFG.reviewModel} when the manifest has a HIGH-risk file) + ${CFG.reviewModel} (lenses${CFG.cascadeReview ? ', HIGH-risk partition, spot audit' : ''})${CFG.cascadeReview ? ` + ${CFG.cascadeModel} (LOW-risk partition)` : ''}${wantRadiusPack ? ` + ${CFG.radiusPackModel} (radius pack)` : ''}`,
  'UI verify': `${CFG.uiDriverModel} (driver) + ${CFG.routing.uiJudgeModel} (judge; ${CFG.reviewModel} when the manifest has a HIGH-risk file)`,
  'Mutation probe': `${CFG.gateModel} (checksums) + ${CFG.routing.probeModel} (probes)${CFG.mutationRemediate ? ` + ${CFG.testModel} (remediation on a surviving mutant)` : ''}`,
  Fix: fixPlanningOn
    ? `${CFG.fixBriefModel} (brief) + ${CFG.fixPlannerModel} (plans every fix in the round; ${CFG.fixPlannerFallbackModel} if it declines) + ${CFG.mechanicalFixModel} (mechanical executors) + ${CFG.fixExecuteSonnetModel} (designed LOW-risk executors) + ${CFG.reviewModel} (HIGH-risk and broad-key executors) + ${CFG.routing.recheckRoutineModel} (recheck; ${CFG.reviewModel} when the manifest has a HIGH-risk file) + ${CFG.gateModel} (regate)`
    : `${CFG.reviewModel} (judgment fixers) + ${CFG.routing.recheckRoutineModel} (recheck; ${CFG.reviewModel} when the manifest has a HIGH-risk file) + ${CFG.mechanicalFixModel} (mechanical fixers) + ${CFG.gateModel} (regate)`,
  Verify: `${CFG.locationCheckModel} (location check) + ${CFG.routing.routineRefuterModel} (refuters, per file; ${CFG.reviewModel} for a blocker/major finding on a HIGH-risk file) + ${CFG.tieBreakModel} (split-vote tie-break)${wantSiblingSweep ? ` + ${CFG.siblingGrepModel} (sibling grep) + ${CFG.reviewModel} (sibling judge)` : ''}`,
  'Final pass': `${CFG.finalPassPackagerModel} (diff digest) + ${CFG.finalPassReaderModel} (adversarial read → candidates) + ${CFG.finalPassModel} (decides; ${CFG.finalPassFallbackModel} if it declines)`,
}
// The effort each phase's agents run at — reported beside the model so a
// phaseReport row can be priced and compared across runs.
const PHASE_EFFORTS = {
  Baseline: `${CFG.effort.gate}${wantHarnessCheck ? ` / ${CFG.effort.harnessCheck} harness check` : ''}`,
  'Author tests': `${CFG.effort.tests} (a package's own effort wins)`,
  'Red gate': `${CFG.effort.gate} run / ${CFG.effort.redAudit} audit / ${CFG.effort.redRemediate} remediation`,
  Implement: `${CFG.effort.implement} (a package's own effort wins)`,
  'Gate & Review': `${CFG.effort.gate} gate / ${CFG.effort.buildFix} build-fix / deep lenses ${CFG.effort.lensDeep} (${CFG.effort.lensDeepHighRisk} when any file is HIGH risk) / pattern lenses ${CFG.effort.lensPattern}${wantRadiusPack ? ` / ${CFG.effort.radiusPack} radius pack` : ''}`,
  Verify: `location check ${CFG.effort.locationCheck} / refuters ${CFG.effort.refute} (${CFG.effort.refuteHighRisk} on HIGH-risk findings) / tie-break ${CFG.effort.tieBreak}${wantSiblingSweep ? ` / ${CFG.effort.siblingGrep} sibling grep / ${CFG.effort.siblingJudge} sibling judge` : ''}`,
  'UI verify': `${CFG.effort.uiDrive} driver / ${CFG.effort.uiJudge} judge`,
  'Mutation probe': `${CFG.effort.checksum} checksums / ${CFG.effort.mutate} probes`,
  Fix: fixPlanningOn
    ? `${CFG.effort.fixBrief} brief / ${CFG.effort.fixPlan} plan (${CFG.effort.fixPlanFallback} on the fallback planner) / ${CFG.effort.mechanicalFix} mechanical / ${CFG.effort.fixExecuteSonnet} designed LOW-risk / ${CFG.effort.judgmentFix} HIGH-risk and broad keys / ${CFG.effort.recheck} re-check / ${CFG.effort.gate} gates`
    : `${CFG.effort.mechanicalFix} mechanical / ${CFG.effort.judgmentFix} judgment / ${CFG.effort.recheck} re-check / ${CFG.effort.gate} gates`,
  'Final pass': `${CFG.effort.finalPassPackage} digest / ${CFG.effort.finalPassRead} read / ${CFG.effort.finalPass} decide (${CFG.effort.finalPassFallback} on the fallback decider)`,
}
// The model whose OUTPUT price a phase's tokens are estimated at. An estimate,
// labelled as one: budget.spent() is one scalar per phase, and a mixed phase
// (Haiku gate + Opus lenses) is priced at its dominant tier.
const PHASE_PRIMARY = {
  Baseline: CFG.gateModel,
  'Author tests': CFG.testModel,
  'Red gate': CFG.reviewModel,
  Implement: CFG.implementModel,
  'Gate & Review': CFG.reviewModel,
  Verify: CFG.reviewModel,
  'UI verify': CFG.reviewModel,
  'Mutation probe': CFG.routing.probeModel,
  Fix: CFG.reviewModel,
  'Final pass': CFG.finalPassModel,
}
function estUsd(tokens, model) {
  const p = CFG.prices[model]
  if (tokens == null || !p) return null
  return Math.round((tokens / 1e6) * p[1] * 100) / 100
}
const phaseStats = {}
for (const t of PHASE_TITLES) phaseStats[t] = { ran: false, agents: 0, rawFindings: 0, sum: 0, unknown: false, at: null, overlappedWith: null, note: '' }
// Two phases that run beside each other would each count the other's tokens in
// their budget.spent() bracket. The pair runs under ONE bracket — the primary's —
// and the secondary records its agents and findings, points at the primary, and
// reports tokens: null (an unknown reading is never reported as 0).
function markOverlapped(title, primary, agents, rawFindings) {
  const s = phaseStats[title]
  s.ran = true
  s.agents += agents || 0
  s.rawFindings += rawFindings || 0
  s.overlappedWith = primary
  s.unknown = true
  s.note = `ran concurrently with ${primary}; its tokens are counted under ${primary}`
}
// What the wall-clock overlaps actually did this run — the ledger reads this.
const overlapInfo = { verifyWithUiVerify: false, finalGateWithFinalPass: false, redAuditWithImplement: null }
function readSpent() {
  try {
    if (!budget || typeof budget.spent !== 'function') return null
    const v = budget.spent()
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  } catch (e) {
    return null
  }
}
function startPhase(title) {
  phase(title)
  const s = phaseStats[title]
  s.ran = true
  s.at = readSpent()
  if (s.at == null) s.unknown = true
}
// ── C1 CHECKPOINTS (plan Part 3 §C1) ─────────────────────────────────────────
// State a legacy run (no args.runDir) never touches.
let ckSeq = 0
let snapshotCommitted = false
const checkpointLog = []
// A6 FLAKY QUARANTINE (owner ruling 2026-09-11): every test applyFlakyQuarantine()
// quarantined this run, across every gate call site it ran at. Surfaced verbatim
// on resultObj.quarantined.
const quarantinedLog = []
// E1 (owner ruling 2026-09-11, wave 3): commands whose quarantine was ABANDONED
// because a rerun returned null or lacked results[] — no evidence, so the
// original red result was left exactly as reported. Surfaced on
// resultObj.quarantineAbandoned so a dead rerun is never silently invisible.
const quarantineAbandonedLog = []
// A10 CHECKPOINT IDEMPOTENCY (owner ruling 2026-09-11). RUN_ID identifies this
// run the same way the snapshot-commit message already does (runSlugOf(runDir)
// — the run directory's own basename). checkpointAttempts counts how many
// times THIS process has written a checkpoint for a given phase title (or
// 'final'), so a phase whose checkpoint runs more than once in one process
// still gets a distinct key rather than a repeated one.
const RUN_ID = runSlugOf(runDir) || 'run'
// E4 (owner ruling 2026-09-11, wave 3): on a RESUMED run the orchestrator has
// already inspected this run dir's existing phases/*.json and passes back the
// highest `attempt` it found per phase as args.priorCheckpoints — an array of
// {phase, attempt}. This script has no fs of its own and never reads the run
// dir directly; it only ever trusts what it is handed. Defaults to [] (a fresh
// run: every phase starts at attempt 1, exactly as before this change).
const checkpointAttempts = new Map(
  (Array.isArray(args.priorCheckpoints) ? args.priorCheckpoints : [])
    .filter((p) => p && typeof p.phase === 'string' && Number.isFinite(p.attempt))
    .map((p) => [p.phase, p.attempt])
)
function nextCheckpointAttempt(key) {
  const n = (checkpointAttempts.get(key) || 0) + 1
  checkpointAttempts.set(key, n)
  return n
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'
}
// The run's own slug, for the commit message — derived from runDir's basename
// (pure string ops: this script has no fs). 'run' when runDir is absent/odd.
function runSlugOf(dir) {
  if (!dir) return 'run'
  const parts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || 'run'
}
// One phaseReport row, computed the same way here and in the final phaseReport
// map below — so a per-phase checkpoint card and the run's own summary never
// disagree about what a phase cost.
function buildPhaseRow(t) {
  const s = phaseStats[t]
  const tokens = s.unknown ? null : s.sum
  const primary = t === 'Final pass' && finalPassResult && finalPassResult.model ? finalPassResult.model : PHASE_PRIMARY[t]
  return {
    phase: t,
    ran: s.ran,
    agents: s.agents,
    rawFindings: s.rawFindings,
    tokens,
    model: PHASE_MODELS[t] || null,
    effort: PHASE_EFFORTS[t] || null,
    estUsd: estUsd(tokens, primary),
    overlappedWith: s.overlappedWith,
    note: s.note || '',
  }
}
// Cumulative totals across every phase that has ACTUALLY RUN so far. Skipping
// phases with ran:false is also what keeps this TDZ-safe: buildPhaseRow('Final
// pass') only runs here once 'Final pass' itself has ran:true, by which point
// finalPassResult is guaranteed to already exist.
function cumulativeTotals() {
  let agents = 0, tokens = 0, tokensUnknown = false, estUsdTotal = 0
  for (const t of PHASE_TITLES) {
    const s = phaseStats[t]
    if (!s.ran) continue
    agents += s.agents
    if (s.unknown) tokensUnknown = true
    else tokens += s.sum
    const row = buildPhaseRow(t)
    if (row.estUsd != null) estUsdTotal += row.estUsd
  }
  return { agents, tokens: tokensUnknown ? null : tokens, estUsd: Math.round(estUsdTotal * 100) / 100 }
}
// `findings` (declared later, at the top of the review stage) does not exist
// yet during Baseline/Author tests/Red gate/Implement's checkpoints — that is a
// TDZ ReferenceError, not an empty array, so both readers below go through
// try/catch and default to empty/zero rather than letting a checkpoint kill the
// run it is only supposed to be recording.
function findingsSeverityCounts() {
  const out = { blocker: 0, major: 0, minor: 0 }
  try {
    for (const f of findings) {
      if (f && f.severity && Object.prototype.hasOwnProperty.call(out, f.severity)) out[f.severity]++
    }
  } catch (e) { /* not declared yet this early in the run */ }
  return out
}
function phaseFindingSummaries(title) {
  const cap = CFG.checkpoint.payloadFindingChars
  try {
    return findings.filter((f) => f && f.phase === title).map((f) => String(f && f.summary || '').slice(0, cap))
  } catch (e) {
    return []
  }
}
// A10 (owner ruling 2026-09-11): a minimal, TDZ-safe partial "resultObj" built
// from whatever is already live at THIS point in the run — same try/catch
// pattern as findingsSeverityCounts/phaseFindingSummaries above, because
// `findings` does not exist yet during Baseline/Author tests/Red gate/Implement.
// Passed through buildFinalSummary() — the SAME bounding function the final
// checkpoint already uses — so the per-phase card's bounded result-so-far is
// never a second, divergent notion of "bounded".
function buildResultSoFarPartial() {
  let liveFindings = []
  try { liveFindings = findings } catch (e) { liveFindings = carried }
  // Same TDZ guard as cumulativeTotals(): buildPhaseRow('Final pass') reads
  // finalPassResult, which does not exist until that phase has actually run —
  // skip any not-yet-run phase rather than let a JS-level identifier lookup
  // (not a data question) throw out of a checkpoint.
  const phaseReport = PHASE_TITLES.map((t) => (phaseStats[t].ran ? buildPhaseRow(t) : { phase: t, ran: false, agents: 0, rawFindings: 0, tokens: 0, model: null, effort: null, estUsd: 0, overlappedWith: null, note: '' }))
  return {
    mode: MODE,
    scale,
    startedAt: startedAt || null,
    phaseReport,
    remainingFindings: liveFindings,
    // Never claimed mid-run — only the final resultObj may say the run is clean.
    clean: null,
  }
}
// The one Haiku agent per phase: writes the phase card (and, at most once per
// run, makes the snapshot commit). Never decides anything, never blocks the
// run — a dead or malformed response is logged into checkpointLog and the
// pipeline continues exactly as it would with checkpoints off.
async function runCheckpoint(title, gateGreen) {
  if (!CFG.checkpoint.enabled || !runDir) return
  ckSeq += 1
  const seq = String(ckSeq).padStart(2, '0')
  const path = `${runDir}/phases/${seq}-${slugify(title)}.json`
  const wantCommit = !!(gateGreen && CFG.checkpoint.snapshotCommit && !snapshotCommitted)
  // A10: idempotency key + the bounded result-so-far, via the SAME summary
  // builder the final checkpoint uses — a resume reads this card and restarts
  // exactly the incomplete step, instead of re-deriving partial state by hand.
  const attempt = nextCheckpointAttempt(title)
  const idempotencyKey = `${RUN_ID}:${title}:${attempt}`
  const { summary: resultSoFar, truncated: resultSoFarTruncated } = buildFinalSummary(buildResultSoFarPartial(), CFG.checkpoint.maxSummaryKb)
  const payload = {
    seq: ckSeq,
    idempotencyKey,
    phase: buildPhaseRow(title),
    totals: cumulativeTotals(),
    findingsBySeverity: findingsSeverityCounts(),
    findingSummaries: phaseFindingSummaries(title),
    mode: MODE,
    scale,
    startedAt: startedAt || null,
    args: { planPath, discoveryPath, specPath, uxSpecPath, testPlanPath, designSystemPath, lessonsPath, workdir, runDir },
    resultSoFar,
    resultSoFarTruncated,
  }
  if (wantCommit) payload.commit = { message: `wip(pipeline): ${runSlugOf(runDir)} checkpoint ${title}` }
  const prompt = [
    `You are the CHECKPOINT WRITER — mechanical. The only things you may change on disk are the one file named below, and (ONLY when told to) one commit.`,
    `1. Run \`mkdir -p "${runDir}/phases"\`.`,
    `2. Write EXACTLY this JSON, verbatim, to "${path}" (create or overwrite; do not reformat, add, or drop a field):`,
    JSON.stringify(payload),
    `3. Touch NOTHING else — no other file, no other directory.`,
    payload.commit
      ? [
          `4. Run \`git rev-parse --abbrev-ref HEAD\`. If the branch is "main" or "master", do NOT commit — report committed=false and say why in note.`,
          `5. Otherwise run \`git add -u && git add "${runDir}"\` (stages tracked changes plus only this run's own directory), then \`git commit -q -m "${payload.commit.message}"\`, then \`git rev-parse --short HEAD\` and report that as sha. NEVER run \`git add -A\`, NEVER add any untracked file outside "${runDir}", and NEVER run \`git push\`.`,
        ].join('\n')
      : `4. Do NOT run git add, git commit, or git push — no commit was requested this time.`,
    `Report written (true only if the JSON file was actually written), path (the absolute path you wrote), committed, sha (null unless you committed), and note (one line: what happened, or why written/committed is false).`,
  ].join('\n')
  let result = null
  try {
    result = await askAgent(prompt, { label: `checkpoint:${title}`, phase: title, model: CFG.checkpointModel, effort: CFG.effort.checkpoint, schema: CHECKPOINT_SCHEMA })
  } catch (e) {
    result = null
  }
  if (result && result.written && payload.commit && result.committed) snapshotCommitted = true
  checkpointLog.push({
    seq: ckSeq,
    phase: title,
    path,
    written: !!(result && result.written),
    committed: !!(result && result.committed),
    sha: (result && result.sha) || null,
    note: (result && result.note) || (result ? '' : 'checkpoint agent died or returned nothing — non-fatal, run continues'),
  })
}
// Strips the fields the plan names as too large for a ≤ maxSummaryKb summary;
// details live in the phase files, not in result.json. Falls back to trimming
// remainingFindings.detail, then to a bare count, if it is still over cap —
// truncation is reported honestly rather than silently overflowing the cap.
function buildFinalSummary(full, maxKb) {
  // Base strip: always applied, regardless of size. confirmedFindings,
  // redGate, mutationProbe, finalPass, uiVerify, manifest, confirmedByPhase,
  // overlap and checkpoints are all KEPT here — only fixReports (whole),
  // uiVerify.evidence, mutationProbe.results, and phaseReport[].note beyond
  // 200 chars are dropped. phaseReport[].note itself is kept (truncated),
  // never deleted — buildRow in pipeline-ledger.mjs reads it.
  const strip = (o) => {
    const c = { ...o }
    delete c.fixReports
    if (Array.isArray(c.phaseReport)) {
      c.phaseReport = c.phaseReport.map((r) => {
        if (!r || typeof r !== 'object') return r
        const rest = { ...r }
        if (typeof rest.note === 'string') rest.note = rest.note.slice(0, 200)
        return rest
      })
    }
    if (c.uiVerify && typeof c.uiVerify === 'object') c.uiVerify = { ...c.uiVerify, evidence: undefined }
    if (c.mutationProbe && typeof c.mutationProbe === 'object') c.mutationProbe = { ...c.mutationProbe, results: undefined }
    return c
  }
  // Only ever used once the summary is still over cap after the base strip
  // and the remainingFindings.detail truncation below — collapses a
  // findings array down to stubs. NEVER a string: a string reads back as []
  // in pipeline-ledger.mjs's arrOrEmpty, which would record 0 remaining (or
  // 0 confirmed) on exactly the runs that overflowed the cap.
  const toStubs = (arr) =>
    Array.isArray(arr) ? arr.map((f) => ({ file: (f && f.file) ?? null, severity: (f && f.severity) ?? null, phase: (f && f.phase) ?? null })) : arr
  let summary = strip(full)
  const capBytes = maxKb * 1024
  if (JSON.stringify(summary).length <= capBytes) return { summary, truncated: false }
  if (Array.isArray(summary.remainingFindings)) {
    summary = { ...summary, remainingFindings: summary.remainingFindings.map((f) => (f && f.detail ? { ...f, detail: String(f.detail).slice(0, 200) } : f)) }
  }
  if (JSON.stringify(summary).length <= capBytes) return { summary, truncated: true }
  summary = {
    ...summary,
    remainingFindings: toStubs(full.remainingFindings),
    confirmedFindings: toStubs(full.confirmedFindings),
    // A2: plausibleFindings is a sibling list of the same shape — stub it the
    // same way so a large one cannot be the reason the cap is still missed.
    plausibleFindings: toStubs(full.plausibleFindings),
  }
  return { summary, truncated: true }
}
// C1 FINAL CHECKPOINT: one more Haiku agent, at run end, writes runDir/result.json
// as the size-capped summary and lists the phase files this run already wrote
// (checkpointLog already has every path — no need to `ls` for them).
async function runFinalCheckpoint(full) {
  const { summary, truncated } = buildFinalSummary(full, CFG.checkpoint.maxSummaryKb)
  // FLAT, not { summary, truncated, phaseFiles } — pipeline-ledger.mjs's
  // `append` refuses (exit 2) any result.json without a top-level
  // phaseReport array, and buildRow reads top-level mode/scale/clean/etc.
  // directly off the file. checkpointTruncated (not `truncated`, which
  // would collide with nothing here but reads oddly next to the summary's
  // own fields) records whether buildFinalSummary had to shrink anything.
  // A10: 'final' shares the same attempt counter namespace as the per-phase
  // titles — none of PHASE_TITLES is spelled 'final', so there is no collision.
  const idempotencyKey = `${RUN_ID}:final:${nextCheckpointAttempt('final')}`
  const payload = { ...summary, idempotencyKey, checkpointTruncated: truncated, phaseFiles: checkpointLog.map((c) => c.path) }
  const path = `${runDir}/result.json`
  const prompt = [
    `You are the CHECKPOINT WRITER — mechanical. The only thing you may change on disk is the one file named below.`,
    `Write EXACTLY this JSON, verbatim, to "${path}" (create or overwrite; do not reformat, add, or drop a field):`,
    JSON.stringify(payload),
    `Touch NOTHING else. Do NOT run git add, git commit, or git push.`,
    `Report written (true only if the file was actually written), path (the absolute path you wrote), committed (always false here), sha (always null here), and note (one line).`,
  ].join('\n')
  let result = null
  try {
    result = await askAgent(prompt, { label: 'checkpoint:final', phase: 'Close-out', model: CFG.checkpointModel, effort: CFG.effort.checkpoint, schema: CHECKPOINT_SCHEMA })
  } catch (e) {
    result = null
  }
  checkpointLog.push({
    seq: ckSeq + 1,
    phase: 'Close-out',
    path,
    written: !!(result && result.written),
    committed: false,
    sha: null,
    note: (result && result.note) || (result ? '' : 'final checkpoint agent died or returned nothing — non-fatal, resultObj still returns normally'),
  })
}

// A phase entered more than once (fix rounds, UI re-verify) accumulates. One
// unreadable segment marks the whole phase unknown — a missing reading is not 0.
// gateGreen is passed ONLY by the Gate & Review call site — it is what gates
// the once-per-run snapshot commit; every other call site leaves it undefined.
async function endPhase(title, agents, rawFindings, gateGreen, opts = {}) {
  const s = phaseStats[title]
  const now = readSpent()
  if (s.at == null || now == null) s.unknown = true
  else s.sum += Math.max(0, now - s.at)
  s.at = null
  s.agents += agents || 0
  s.rawFindings += rawFindings || 0
  if (!opts.skipCheckpoint) await runCheckpoint(title, gateGreen)
}

// parallel() is a barrier over everything handed to it, so cap the in-flight
// count by running the thunks in fixed-size groups.
async function runConcurrent(thunks, size) {
  const limit = Math.max(1, size || CFG.maxConcurrent)
  const out = []
  for (let i = 0; i < thunks.length; i += limit) {
    const batch = await parallel(thunks.slice(i, i + limit))
    out.push(...batch)
  }
  return out
}

// Packages that share files must not run concurrently — schedule into waves.
// Returns { waves, issues }: issues are declared-ordering defects in the plan
// (a dependsOn id no package declares, or a dependency cycle) that would
// otherwise vanish silently.
function buildWaves(pkgs) {
  // Two ordering constraints, both honored:
  //  - packages sharing a file never run concurrently (write-conflict safety)
  //  - a package with dependsOn: ["WP1", ...] runs strictly AFTER every named
  //    dependency's wave (no more forcing order via fake file-list overlaps)
  const issues = []
  const byId = new Map()
  for (const p of pkgs) byId.set(p.id, p)

  // Wave assignment reads waveOf, which is filled as it walks — so a dependency
  // listed AFTER its dependent would contribute nothing and the constraint would
  // disappear (or invert). Depth-first topological pass first: every package is
  // scheduled only once all of its declared dependencies are.
  const ordered = []
  const state = {} // id -> 1 = on the stack, 2 = emitted
  function visit(p) {
    if (state[p.id] === 2) return
    if (state[p.id] === 1) return // cycle — reported below; do not recurse forever
    state[p.id] = 1
    for (const dep of p.dependsOn || []) {
      const d = byId.get(dep)
      if (!d) {
        issues.push(`Package ${p.id} declares dependsOn "${dep}", which matches no package id — that ordering constraint was DROPPED and ${p.id} may have run concurrently with, or before, the work it depends on.`)
        continue
      }
      if (d === p) {
        issues.push(`Package ${p.id} declares dependsOn on itself — ignored.`)
        continue
      }
      if (state[d.id] === 1) {
        issues.push(`Circular dependsOn between ${p.id} and ${d.id} — the cycle cannot be ordered, so one of those edges was DROPPED.`)
        continue
      }
      visit(d)
    }
    state[p.id] = 2
    ordered.push(p)
  }
  for (const p of pkgs) visit(p)

  const waves = []
  const waveOf = {} // package id -> wave index
  for (const p of ordered) {
    const files = new Set(p.files || [])
    const minWave = (p.dependsOn || []).reduce(
      (m, dep) => (waveOf[dep] != null ? Math.max(m, waveOf[dep] + 1) : m),
      0,
    )
    let idx = -1
    for (let i = minWave; i < waves.length; i++) {
      if (!waves[i].some((q) => (q.files || []).some((f) => files.has(f)))) { idx = i; break }
    }
    if (idx === -1) { waves.push([p]); idx = waves.length - 1 }
    else waves[idx].push(p)
    waveOf[p.id] = idx
  }
  return { waves, issues }
}

// Fixers used to run strictly serially because they can touch shared files —
// which is exactly what buildWaves already solves for implementers, so reuse it.
// The DECLARED group (one file key) is the conflict key, so fixers on disjoint
// files run concurrently and only overlapping ones serialize. RESIDUAL RISK,
// accepted knowingly: a fixer may legitimately edit a file outside its group, and
// the conflict key cannot see that. Groups whose fix can touch anything (a broken
// build, an unrestored mutation, a test package) therefore share one sentinel
// file, so they never run beside each other, and they depend on every file-scoped
// group, so they run after those have finished.
const isBroadFixKey = (k) => !isRealPath(k) && k !== '(artifact)'
// A ui-verify fix is re-driven in a real browser: the fixer starts the app's dev
// server, holds its port and drives a browser session, then stops what it started.
// Those are shared resources the file-based conflict key cannot see — two such
// fixers at once collide on the port, or one stops the server the other is mid-flow
// on. They therefore take a second sentinel file and serialize against each other,
// while still running beside ordinary source fixers.
const isUiFixGroup = (group) => group.some((f) => f && f.source === 'ui-verify')
function buildFixWaves(fixGroups) {
  const scopedKeys = fixGroups.map(([k]) => k).filter((k) => !isBroadFixKey(k))
  const pkgs = fixGroups.map(([key, group]) => {
    const broad = isBroadFixKey(key)
    const files = [broad ? '(broad-fix)' : normPath(key)]
    // Broad groups already share '(broad-fix)', so they never run beside anything.
    if (!broad && isUiFixGroup(group)) files.push('(ui-fix)')
    const p = { id: key, files, group }
    if (broad && scopedKeys.length) p.dependsOn = scopedKeys.slice()
    return p
  })
  return buildWaves(pkgs)
}

// ---------- fix planning: routing and scheduling from Fable's plan ----------
// A group's tier is the DEEPEST one the planner gave any of its findings, then the
// engine's own upgrade. A finding the planner left unrouted — or routed to something
// this engine does not recognise — counts as 'opus': never the cheap side.
function plannedGroupRoute(fileKey, group, decisionOf) {
  if (forcesOpus(fileKey, group)) return 'opus'
  let route = 'mechanical'
  for (const f of group) {
    const d = decisionOf.get(f)
    const cand = d && ROUTE_RANK[d.route] != null ? d.route : 'opus'
    if (ROUTE_RANK[cand] > ROUTE_RANK[route]) route = cand
  }
  return route
}
// The planner names CONCURRENCY; the engine keeps owning WRITE SAFETY. Returns
// Map(groupKey -> wave index) when the plan's waves are usable, else null: an
// executable index left out, one named twice, or one file split across two waves.
function plannerWaveOrder(toFixList, execSet, rawWaves) {
  if (!Array.isArray(rawWaves)) return null
  const need = new Set(execSet)
  const waveOfKey = new Map()
  const seen = new Set()
  let w = 0
  for (const wave of rawWaves) {
    if (!Array.isArray(wave)) return null
    for (const idx of wave) {
      const f = typeof idx === 'number' ? toFixList[idx] : null
      // An index the planner disputed or deferred may still appear here; it simply
      // has nothing to schedule. Only the executable set has to be covered exactly.
      if (!f || !need.has(f)) continue
      if (seen.has(f)) return null
      seen.add(f)
      const key = normPath(f.file) || '(unknown)'
      if (waveOfKey.has(key) && waveOfKey.get(key) !== w) return null
      waveOfKey.set(key, w)
    }
    w++
  }
  return seen.size === need.size ? waveOfKey : null
}
// The plan's ordering applied THROUGH buildWaves, not instead of it: the file-overlap
// rule, the broad-fix sentinel and the ui-fix sentinel all still hold, so the planner
// can never put two fixers on one file or float a build repair up beside them.
function buildPlannedFixWaves(fixGroups, waveOfKey) {
  const scopedKeys = fixGroups.map(([k]) => k).filter((k) => !isBroadFixKey(k))
  const pkgs = fixGroups.map(([key, group]) => {
    const broad = isBroadFixKey(key)
    const files = [broad ? '(broad-fix)' : normPath(key)]
    if (!broad && isUiFixGroup(group)) files.push('(ui-fix)')
    const p = { id: key, files, group }
    // A broad group already depends on every file-scoped group — a stronger
    // constraint than anything the planner can express, so leave it exactly there.
    if (broad) {
      if (scopedKeys.length) p.dependsOn = scopedKeys.slice()
    } else {
      const mine = waveOfKey.get(key)
      const deps = scopedKeys.filter((k) => k !== key && mine != null && waveOfKey.get(k) != null && waveOfKey.get(k) < mine)
      if (deps.length) p.dependsOn = deps
    }
    return p
  })
  return buildWaves(pkgs)
}

const DEAD_IMPL = { status: 'blocked', filesChanged: [], deviations: 'agent died or was skipped', notes: '' }

// Findings no fixer can act on: the phase that would have produced the evidence
// never ran ('(review)', '(ui-verify)'), or the defect is in a planning input this
// run has already consumed ('(build-plan)' — the waves it describes are done).
// They bypass the fix loop and land in remainingFindings, keeping `clean` false.
const UNFIXABLE_FILES = ['(review)', '(ui-verify)', '(build-plan)']
const isUnfixable = (f) => UNFIXABLE_FILES.indexOf(f.file) !== -1

// A dependsOn that names no package, or a cycle, means the plan's declared
// ordering did not happen — surface it instead of letting it vanish.
function carryWaveIssues(issues, where, phaseName) {
  for (const issue of issues) {
    log(`!!! ${where}: ${issue}`)
    carried.push({
      file: '(build-plan)',
      severity: 'blocker',
      phase: phaseName,
      // The issue text leads the summary so two different broken edges do not
      // dedupe into one (dedupe keys on file + the first 60 chars of summary).
      summary: issue,
      detail: `Declared ordering in the ${where} packages was not applied. dependsOn is the ONLY ordering mechanism these waves honour, so the affected package may have run concurrently with — or before — the work it depends on.`,
      fixHint: 'Fix the dependsOn ids in the build plan (they must match package ids exactly, and must not form a cycle), then re-run: this run cannot re-schedule waves it has already executed.',
    })
  }
}

// ═══════════ Phase 1: Baseline — the tree BEFORE any agent writes anything ═══════════
// Three cheap Haiku checks, concurrently:
//  - run every verify command against the untouched tree. A command that fails
//    HERE is broken, not evidence about this change; excluding it from the
//    pass/fail decision kills the false-blocker class where a wrong command
//    condemns correct code.
//  - ground the planning artifacts: every mechanically checkable claim they make
//    about the repo, verified. An invented path or script is confabulation the
//    whole run would otherwise inherit as fact.
//  - build the context manifest: which files moved or are planned, each one's risk
//    class, which commands can run, which artifacts exist. Facts only. It removes
//    the work every later agent would otherwise redo — deriving what changed and
//    what to open — without handing them a shared INTERPRETATION of the change,
//    which would give every lens the same blind spot.
// COMMAND VALIDATION BEFORE BASELINE (owner ruling 2026-09-11e; RUN-LOG
// train4-run-a: "BOTH recorded final Jest gates were void"). Purely mechanical —
// no agent spent, no filesystem access (this engine has none; every FS fact
// normally comes from an agent) — so it catches two Jest command shapes that can
// report green while verifying nothing, before a single token is spent on this
// run. The "target does not exist yet" half is necessarily approximate: it can
// only check the command's targets against files THIS RUN's own plan declares
// (plannedFiles), an exact match only — a directory-shaped target like "src"
// must never match on a mere prefix, or almost every real command would trip it.
function validateJestCommands(commands) {
  const problems = []
  const known = plannedFiles.map(normPath)
  for (const cmd of commands) {
    if (!/\bjest\b/i.test(cmd)) continue
    const tokens = cmd.trim().split(/\s+/).filter(Boolean)
    const reporterIdx = tokens.indexOf('--reporters=default')
    const next = tokens[reporterIdx + 1]
    if (reporterIdx !== -1 && next !== undefined && !next.startsWith('-')) {
      problems.push({
        file: '(build-plan)',
        severity: 'blocker',
        phase: 'Baseline',
        summary: `Jest command has --reporters=default before its last argument: \`${cmd}\``,
        detail: `--reporters=default is followed by a positional argument that yargs will swallow into --reporters; put a flag after it or move it last. This silently narrows or drops the command's intended scope while still reporting green (RUN-LOG train4-run-a: "BOTH recorded final Jest gates were void").`,
        fixHint: 'Move --reporters=default to the end of this command in verifyCommands, or put a flag (not a bare path) immediately after it.',
      })
    }
    const jestIdx = tokens.findIndex((t) => /\bjest\b/i.test(t))
    const rest = tokens.slice(jestIdx + 1)
    if (rest.includes('--passWithNoTests')) continue
    // Flags that take a following value: that value is never itself a target
    // (e.g. `-t "REG-B26"` must not contribute 'REG-B26' as a target path).
    const VALUE_FLAGS = new Set([
      '-t', '--testNamePattern', '--testPathPattern', '-c', '--config',
      '--rootDir', '--selectProjects', '--maxWorkers', '-w', '--testTimeout',
    ])
    const stripQuotes = (s) => s.replace(/^['"]|['"]$/g, '')
    const targets = []
    for (let i = 0; i < rest.length; i++) {
      const tok = stripQuotes(rest[i])
      if (!tok) continue
      if (tok.startsWith('-')) {
        if (VALUE_FLAGS.has(tok)) i++
        continue
      }
      targets.push(tok)
    }
    // A leading `cd <dir> &&` means every relative target is actually relative to
    // <dir>, not the repo root — compare it against plannedFiles the same way.
    const cdMatch = /^cd\s+([^\s&]+)\s*&&\s*/.exec(cmd.trim())
    const cdDir = cdMatch ? stripQuotes(cdMatch[1]) : null
    const resolveTarget = (t) => {
      const isAbsolute = /^([a-zA-Z]:)?[\\/]/.test(t)
      if (cdDir && !isAbsolute) return `${cdDir}/${t}`
      return t
    }
    if (targets.length && targets.every((t) => known.includes(normPath(resolveTarget(t))))) {
      problems.push({
        file: '(build-plan)',
        severity: 'blocker',
        phase: 'Baseline',
        summary: `Jest command's target path(s) are only files this run's own plan will create, with no --passWithNoTests: \`${cmd}\``,
        detail: `Every target this command names (${targets.join(', ')}) matches ONLY a file the build/test plan declares as something this run will create — none is known to exist yet — and without --passWithNoTests Jest exits nonzero on zero matched test files, so this gate is void until those files land.`,
        fixHint: 'Add --passWithNoTests if running before the test files exist is intentional, or point this command at files that already exist.',
      })
    }
  }
  return problems
}
// The tree at this moment IS the baseline, whatever state the caller left it in —
// uncommitted work included.
const baselineCommands = uniqueCommands([...vc.perRound, ...vc.final])
carried.push(...validateJestCommands(baselineCommands))
const groundingArtifacts = uniquePaths([planPath, discoveryPath, specPath, uxSpecPath, testPlanPath, designSystemPath])
let baselineResult = {
  ran: false,
  note: 'Baseline = the working tree exactly as the caller left it, uncommitted work included; that tree is what the commands ran against.',
  commands: baselineCommands,
  badCommands: [],
  gate: { ran: false, completed: false, pass: null, results: [] },
  grounding: { ran: false, completed: false, artifacts: groundingArtifacts, findings: [] },
}
// The manifest is what every later prompt carries, so it is built even when there
// is nothing else for this phase to do.
let manifestResult = {
  ran: false,
  completed: false,
  note: 'No manifest: every file is treated as HIGH risk, which is the conservative default.',
  files: [],
  validCommands: [],
  artifacts: [],
}
let riskSummary = { high: 0, low: 0 }
// FABLE BRIEF CAP flags (owner ruling 2026-09-10, CFG.caps.fableBriefBytes). Set
// by capFableBrief() when a Fable-decider prompt (tie-break judge, fix planner,
// final-pass decider) was over the byte cap and had to be truncated — recorded
// on the relevant result object so a stale/over-long packager is visible in the
// phase report, not just silently clipped.
let tieBreakBriefTruncated = false
let fixPlanBriefTruncated = false
let finalPassBriefTruncated = false
// BUGFIX MODE: what the existing test harness will break on. Never blocks the run — a
// dead agent records ran:false and the test authors simply do not get the notes.
let harnessCheck = {
  ran: false,
  issues: [],
  skipped: bugfix ? (wantHarnessCheck ? null : 'no-test-packages') : 'feature-mode',
  note: '',
}
{
  startPhase('Baseline')
  const carriedAt = carried.length
  if (bugfix) log(`MODE: bugfix — radius pack ${wantRadiusPack ? `over ${radiusFiles.length} file(s)` : 'off (no radius files)'}, harness check ${wantHarnessCheck ? `over ${harnessFiles.length} test file(s)` : 'off (no test packages)'}, sibling sweep ${wantSiblingSweep ? `over ${siblingPatterns.length} pattern(s)` : 'off (no patterns)'}, behavioral red bar, corroboration skip in Verify`)
  log(`Baseline: ${baselineCommands.length} verify command(s), ${groundingArtifacts.length} artifact(s) to ground, ${plannedFiles.length} planned file(s) to classify`)
  const baselineOut = await parallel([
    () =>
      baselineCommands.length
        ? askAgent(baselineGatePrompt(baselineCommands), { label: 'baseline-gate', phase: 'Baseline', model: CFG.gateModel, effort: CFG.effort.gate, schema: GATE_SCHEMA })
        : Promise.resolve(null),
    () =>
      groundingArtifacts.length
        ? askAgent(groundingPrompt(groundingArtifacts), { label: 'baseline-grounding', phase: 'Baseline', model: CFG.gateModel, effort: CFG.effort.grounding, schema: FINDINGS_SCHEMA })
        : Promise.resolve(null),
    () =>
      askAgent(manifestPrompt(plannedFiles, baselineCommands, groundingArtifacts), {
        label: 'baseline-manifest', phase: 'Baseline', model: CFG.gateModel, effort: CFG.effort.manifest, schema: MANIFEST_SCHEMA,
      }),
    // BUGFIX MODE: read-only, beside the manifest. Its issues are appended to the
    // matching test package's brief, so the stale mock is fixed in the same edit.
    () =>
      wantHarnessCheck
        ? askAgent(harnessCheckPrompt(harnessFiles), {
            label: 'harness-check', phase: 'Baseline', model: CFG.harnessCheckModel, effort: CFG.effort.harnessCheck, schema: HARNESS_SCHEMA,
          })
        : Promise.resolve(null),
  ])

  if (baselineCommands.length) {
    const bGate = enforceCwd(baselineOut[0], 'baseline-gate')
    if (bGate) {
      const bResults = Array.isArray(bGate.results) ? bGate.results : []
      for (const r of bResults) {
        if (!r || r.pass !== false) continue
        const cmd = r.command || ''
        if (!normCmd(cmd) || isBadCommand(cmd)) continue
        badCommandSet.add(normCmd(cmd))
        baselineResult.badCommands.push(cmd)
        // Exactly ONE finding per broken command. The command leads the summary so
        // two broken commands never dedupe into one.
        carried.push({
          file: '(gate-command)',
          severity: 'major',
          summary: `\`${cmd}\` already fails on the unmodified baseline tree — the command is broken, not the code`,
          detail: `Baseline output: ${r.summary || '(none reported)'}. This command failed BEFORE any agent wrote anything, so its failures during this run are not evidence about the change. It is excluded from the pass/fail decision and cannot make the result unclean. It still runs every round, so a change in its behavior stays visible.`,
          fixHint: 'Fix this in the PLAN, not in the code: correct or drop the command in verifyCommands (wrong script name, wrong directory, wrong flags), or install the prerequisite it needs, then re-run.',
          phase: 'Baseline',
          // Correcting or dropping a broken command is textual, not a decision
          // about what the code should do.
          fixComplexity: 'mechanical',
        })
      }
      baselineResult.gate = { ran: true, completed: true, pass: !!bGate.pass, results: bResults }
      log(`Baseline gate: ${baselineResult.badCommands.length}/${baselineCommands.length} command(s) already broken${baselineResult.badCommands.length ? ` — excluded from the verdict: ${baselineResult.badCommands.join(' | ')}` : ''}`)
    } else {
      // No baseline evidence = no exclusions. Conservative: every later gate
      // failure still counts against the run.
      baselineResult.gate = { ran: true, completed: false, pass: null, results: [] }
      log('Baseline gate: agent died or was skipped — no command is known-broken, so every later gate failure counts against this run')
    }
  }

  if (groundingArtifacts.length) {
    const bGround = baselineOut[1]
    if (bGround) {
      const groundFindings = dedupe(
        (bGround.findings || []).map((f) => ({
          ...f,
          // Keep the artifact it came from in the text; the '(artifact)' key is
          // what routes it to the right fixer.
          detail: f.file && normPath(f.file) !== '(artifact)' ? `In ${f.file}: ${f.detail || ''}` : f.detail || '',
          file: '(artifact)',
          // A mechanical existence check is major at worst — it must never open
          // the run with a blocker.
          severity: f.severity === 'blocker' ? 'major' : f.severity,
          phase: 'Baseline',
        })),
      )
      baselineResult.grounding = { ran: true, completed: true, artifacts: groundingArtifacts, findings: groundFindings }
      carried.push(...groundFindings)
      log(`Artifact grounding: ${groundFindings.length} ungrounded claim(s) across ${groundingArtifacts.length} artifact(s)`)
    } else {
      baselineResult.grounding = { ran: true, completed: false, artifacts: groundingArtifacts, findings: [] }
      log('Artifact grounding: agent died or was skipped — the artifacts are unchecked; the review lenses still read them')
    }
  }
  // ---- context manifest + risk classification ----
  const bManifest = baselineOut[2]
  const mFiles = bManifest && Array.isArray(bManifest.files) ? bManifest.files.filter((f) => f && f.path) : []
  if (mFiles.length) {
    for (const f of mFiles) {
      const k = normPath(f.path)
      // Anything that is not exactly 'LOW' is HIGH — a garbled or missing class
      // must never buy a file the cheap path.
      riskMap[k] = f.risk === 'LOW' ? 'LOW' : 'HIGH'
      const n = typeof f.changedLines === 'number' && Number.isFinite(f.changedLines) ? Math.max(0, f.changedLines) : 0
      changedLinesMap[k] = n
      statusMap[k] = typeof f.status === 'string' ? f.status.trim().toLowerCase() : ''
    }
    for (const k of Object.keys(riskMap)) riskSummary[riskMap[k] === 'LOW' ? 'low' : 'high']++
    // One row per PATH: a file can appear both in `git status` and in the plan's
    // package file lists, and a duplicate row would double-count it everywhere it
    // is used (the cascade partitions, the density threshold, the prompt note).
    const seenPaths = new Set()
    const manifestFiles = []
    for (const f of mFiles) {
      const k = normPath(f.path)
      if (seenPaths.has(k)) continue
      seenPaths.add(k)
      manifestFiles.push({ path: k, status: f.status || '', risk: riskMap[k], changedLines: changedLinesMap[k] })
    }
    manifestResult = {
      ran: true,
      completed: true,
      note: 'Facts gathered before any agent wrote anything. Unknown or unreadable files are classified HIGH.',
      files: manifestFiles,
      validCommands: Array.isArray(bManifest.validCommands) ? bManifest.validCommands : [],
      artifacts: Array.isArray(bManifest.artifacts) ? bManifest.artifacts : [],
    }
    // Cap what every later prompt carries: a huge diff must not turn the manifest
    // into the largest thing in each context window.
    const shown = manifestResult.files.slice(0, 80)
    manifestNote = [
      `CONTEXT MANIFEST (facts collected at preflight, before any agent wrote anything). It tells you WHICH files moved and what to open — it does NOT tell you what the change means, and it is not a review. Read the diff yourself.`,
      `- files (path [status, risk]): ${shown.map((f) => `${f.path} [${f.status || '?'}, ${f.risk}]`).join(', ')}${manifestResult.files.length > shown.length ? `, …and ${manifestResult.files.length - shown.length} more` : ''}`,
      `- risk: ${riskSummary.high} HIGH, ${riskSummary.low} LOW. HIGH = the path or content touches money/pricing/tax, auth/permissions, tenancy or ownership scoping, migrations/schema, PII, or payments. A file NOT listed here is HIGH by default.`,
      manifestResult.validCommands.length ? `- verification commands that can run in this repo: ${manifestResult.validCommands.join(' | ')}` : '',
      baselineResult.badCommands.length ? `- verification commands ALREADY BROKEN on the untouched tree (their failures are not evidence about this change): ${baselineResult.badCommands.join(' | ')}` : '',
      manifestResult.artifacts.length ? `- planning artifacts that exist on disk: ${manifestResult.artifacts.join(', ')}` : '',
    ].filter(Boolean).join('\n')
    log(`Context manifest: ${manifestResult.files.length} file(s) — ${riskSummary.high} HIGH risk, ${riskSummary.low} LOW`)
  } else {
    // No manifest = no classification = everything HIGH. fileRisk() already
    // returns HIGH for anything unlisted, so leaving riskMap empty IS the
    // conservative default; say so loudly rather than letting it read as LOW.
    riskSummary = { high: plannedFiles.length, low: 0 }
    manifestResult = {
      ran: true,
      completed: false,
      note: 'The manifest agent died or returned nothing. Every file is therefore treated as HIGH risk: deepest review, judgment fixers, mutation probes not skipped.',
      files: [],
      validCommands: [],
      artifacts: [],
    }
    manifestNote = `CONTEXT MANIFEST: unavailable — the preflight manifest agent died. Treat EVERY file as HIGH risk and review it at maximum depth. Establish what changed yourself with \`git status --short\` and \`git diff\`.`
    log('Context manifest: agent died or was skipped — every file is treated as HIGH risk')
  }

  // ---- harness-integrity check (bugfix mode) ----
  // Its issues go to the test author that OWNS the file, verbatim. An issue whose file
  // belongs to no test package has no author to hand it to: it is recorded and logged,
  // never silently dropped.
  if (wantHarnessCheck) {
    const hc = baselineOut[3]
    if (hc) {
      const issues = (Array.isArray(hc.issues) ? hc.issues : []).filter((i) => i && i.file && i.issue)
      const ownerOf = new Map()
      for (const p of testPkgs) for (const f of p.files || []) ownerOf.set(normPath(f), p.id)
      const byPkg = new Map()
      const unassigned = []
      for (const i of issues) {
        const owner = ownerOf.get(normPath(i.file))
        const line = `- ${i.file}:${i.line || '?'} — ${i.issue}${i.remedy ? ` | remedy: ${i.remedy}` : ''}`
        if (owner) byPkg.set(owner, (byPkg.get(owner) ? `${byPkg.get(owner)}\n` : '') + line)
        else unassigned.push(line)
      }
      for (const [id, text] of byPkg) harnessNotes.set(id, text)
      // An issue in a file no package owns (a shared fixture, a mock helper) still has
      // to reach an author: it goes to the FIRST test package, labelled as shared. One
      // deterministic owner, so no two concurrent authors edit the same unowned file.
      const sharedOwner = unassigned.length && testPkgs.length ? testPkgs[0].id : null
      if (sharedOwner) harnessSharedNotes.set(sharedOwner, unassigned.join('\n'))
      harnessCheck = {
        ran: true,
        issues,
        skipped: null,
        note: unassigned.length
          ? `${unassigned.length} issue(s) name a file no test package owns; they were routed to the first test package (${sharedOwner || 'none — there is no test package to route them to'}) under "SHARED HARNESS", and are in issues[] either way: ${unassigned.join(' ;; ')}`
          : '',
      }
      log(`Harness check: ${issues.length} harness inconsistency(ies) across ${harnessFiles.length} test file(s) — ${byPkg.size} package brief(s) carry the notes${unassigned.length ? `; ${unassigned.length} shared-harness issue(s) routed to ${sharedOwner || 'nobody (no test package)'}` : ''}`)
    } else {
      harnessCheck = { ran: false, issues: [], skipped: 'agent-died', note: 'The harness-integrity agent died or was skipped, so the existing mocks and fixtures were never checked against the planned change. It never blocks the run; the test authors simply got no notes.' }
      log('Harness check: agent died or was skipped — the existing mocks/fixtures are unchecked against the plan (non-blocking)')
    }
  }

  baselineResult.ran = true
  await endPhase('Baseline', (baselineCommands.length ? 1 : 0) + (groundingArtifacts.length ? 1 : 0) + 1 + (wantHarnessCheck ? 1 : 0), carried.length - carriedAt)
}

// ═══════════ design-system lens gating (bugfix mode) ═══════════
// Measured on F13: the design-system lens reported 3 findings, all 3 overturned, none
// survived — on a bug fix with no UI file in it. So in bugfix mode the lens runs only
// when the change actually touches a UI file. Feature mode is untouched: there the
// lens's presence is decided by the UX/design-system artifacts alone.
const isUiFile = (p) => {
  const k = normPath(p)
  if (/^packages\/ui\//.test(k)) return true
  return /^apps\/(web|mobile)\//.test(k) && /\.(tsx|jsx|css)$/.test(k)
}
if (bugfix && lenses.indexOf('design-system') !== -1) {
  const uiScope = uniquePaths([...manifestResult.files.map((f) => f.path), ...plannedFiles])
  const uiHits = uiScope.filter(isUiFile)
  if (uiHits.length) {
    log(`Design-system lens KEPT: the change touches UI file(s) — ${uiHits.slice(0, 6).join(', ')}${uiHits.length > 6 ? `, …and ${uiHits.length - 6} more` : ''}`)
  } else if (!manifestResult.completed || !uiScope.length) {
    // No trustworthy file list. Unknown is never a reason to review less.
    log('Design-system lens KEPT: the preflight manifest did not complete, so the changed-file list cannot be trusted to contain no UI file')
  } else {
    lenses = lenses.filter((l) => l !== 'design-system')
    reviewUnits = buildReviewUnits(lenses)
    log(`Design-system lens GATED OFF: none of the ${uiScope.length} changed/planned file(s) is a UI file (apps/web|apps/mobile *.tsx/.jsx/.css, or packages/ui) — lensesRun records the ${lenses.length} lens(es) that ran`)
  }
}

// ═══════════ Phase 2: Author tests (Sonnet) — skipped when testPackages is absent ═══════════
let testAuthoring = { ran: false, packages: [], rerunCount: 0 }
let testFiles = []
if (testPkgs.length) {
  startPhase('Author tests')
  const carriedAtTests = carried.length
  const { waves: testWaves, issues: testWaveIssues } = buildWaves(testPkgs)
  carryWaveIssues(testWaveIssues, 'test', 'Author tests')
  log(`Authoring ${testPkgs.length} test package(s) in ${testWaves.length} wave(s) from ${testPlanPath || planPath}`)
  const testResults = []
  for (const wave of testWaves) {
    const results = await runConcurrent(
      wave.map((p) => () =>
        askAgent(authorTestsPrompt(p), {
          label: `tests:${p.id}`,
          phase: 'Author tests',
          model: p.model || CFG.testModel,
          // A9 RUN CHEAP, RERUN FAILURES (owner ruling 2026-09-11, CFG.cheapFirst):
          // a package with no plan-set effort runs at the cheap tier first; a
          // package the plan itself pinned an effort on is never cheapened.
          effort: p.effort || (CFG.cheapFirst ? CFG.effort.testsCheap : CFG.effort.tests),
          schema: IMPL_SCHEMA,
        }).then((r) => ({ package: p.id, ...(r || DEAD_IMPL) }))
      )
    )
    testResults.push(...results.filter(Boolean))
  }
  // A9: exactly ONE rerun, at the ordinary default effort, for a package that
  // ran at the cheap tier and came back not "done" — its rerun result REPLACES
  // the cheap attempt's, never both. rerunCount is the honest record of how
  // much this knob actually spent on this run.
  let testRerunCount = 0
  if (CFG.cheapFirst) {
    const pkgsById = new Map(testPkgs.map((p) => [p.id, p]))
    const toRerun = testResults.filter((r) => r.status !== 'done' && pkgsById.has(r.package) && !pkgsById.get(r.package).effort)
    if (toRerun.length) {
      log(`Author tests: ${toRerun.length} package(s) came back not "done" at the cheap tier — rerunning once at ${CFG.effort.tests}`)
      const reruns = await runConcurrent(
        toRerun.map((r) => () => {
          const p = pkgsById.get(r.package)
          return askAgent(authorTestsPrompt(p), {
            label: `tests:${p.id}:rerun`,
            phase: 'Author tests',
            model: p.model || CFG.testModel,
            effort: CFG.effort.tests,
            schema: IMPL_SCHEMA,
          }).then((rr) => ({ package: p.id, ...(rr || DEAD_IMPL) }))
        })
      )
      testRerunCount = reruns.length
      for (const rr of reruns) {
        const idx = testResults.findIndex((x) => x.package === rr.package)
        if (idx !== -1) testResults[idx] = rr
      }
    }
  }
  testAuthoring = {
    ran: true,
    rerunCount: testRerunCount,
    packages: testResults.map((r) => ({
      package: r.package, status: r.status, filesChanged: r.filesChanged, deviations: r.deviations,
    })),
  }
  for (const p of testPkgs) testFiles.push(...(p.files || []))
  for (const r of testResults) {
    if (r.status !== 'done') {
      carried.push({
        file: '(tests)',
        severity: 'blocker',
        summary: `Test package ${r.package} is ${r.status}`,
        detail: r.deviations || r.notes || 'no detail reported',
        phase: 'Author tests',
      })
    }
  }
  log(`Test authoring: ${testResults.filter((r) => r.status === 'done').length}/${testResults.length} package(s) done`)
  await endPhase('Author tests', testPkgs.length, carried.length - carriedAtTests)
}

// ═══════════ Phase 3: Red gate — verified RED (Haiku runs, Opus audits) ═══════════
// A test that has never failed proves nothing. Every new test must fail on an
// ASSERTION (not an import/syntax/config error) and none may pass. Exactly ONE
// remediation round is allowed before implementation starts.
let redGateResult = { ran: false, properlyRed: null, structurallyRed: null, behaviorallyRed: null, remediateOn: null, attempts: 0, audits: [], remediation: null }
// Returns { agents, raw }; the caller owns the phase bracket so the phase can run
// alone or beside Implement (CFG.overlapImplementWithRedAudit).
async function runRedGate() {
  const carriedAtRed = carried.length
  let redAgents = 0
  const testFileList = testFiles.join(', ')
  // Which bar triggers the remediation round and the blocker. Small scale has no
  // mutation probe to prove oracle bite later, so it keeps the full behavioral bar.
  // BUGFIX MODE forces 'behavioral' at every scale: the new test IS the repro, and a
  // repro that fails on a stub's uniform `undefined` has not reproduced the bug.
  const remediateOn = bugfix
    ? 'behavioral'
    : scale === 'major' && CFG.redGate.remediateOn === 'structural'
      ? 'structural'
      : 'behavioral'
  const meetsBar = (v) => (remediateOn === 'structural' ? !!v.structurallyRed : !!v.properlyRed)
  let attempt = 0
  let audit = null
  let remediationReport = null
  const audits = []
  while (attempt < 1 + CFG.maxTestRemediationRounds) {
    attempt++
    redAgents++
    const run = await askAgent(redRunPrompt(redGateCfg.commands, redGateCfg.expect), {
      label: `red-run:a${attempt}`, phase: 'Red gate', model: CFG.gateModel, effort: CFG.effort.gate, schema: RED_RUN_SCHEMA,
    })
    redAgents++
    const runOut = run || { ran: false, results: [{ command: redGateCfg.commands.join(' && '), exitCode: -1, output: 'red-gate runner agent died or was skipped — no output captured' }] }
    // The audit is the evidence that the tests can fail: the Opus default, never below it.
    audit = await askAgent(opusCapped(redAuditPrompt(runOut, testFileList, attempt), CFG.reviewModel), {
      label: `red-audit:a${attempt}`, phase: 'Red gate', model: CFG.reviewModel, effort: CFG.effort.redAudit, schema: RED_AUDIT_SCHEMA,
    })
    // A dead auditor is NOT a pass — there is no evidence the tests can fail.
    const verdict = audit || { properlyRed: false, structurallyRed: false, behaviorallyRed: false, tests: [], blockers: ['STRUCTURAL: red-gate auditor died or was skipped — no verified RED evidence exists'], remediation: '' }
    // Older audits reported only properlyRed; read it as both levels.
    if (typeof verdict.structurallyRed !== 'boolean') verdict.structurallyRed = !!verdict.properlyRed
    if (typeof verdict.behaviorallyRed !== 'boolean') verdict.behaviorallyRed = !!verdict.properlyRed
    verdict.properlyRed = verdict.structurallyRed && verdict.behaviorallyRed
    audits.push({ attempt, ran: !!run, structurallyRed: verdict.structurallyRed, behaviorallyRed: verdict.behaviorallyRed, properlyRed: verdict.properlyRed, tests: verdict.tests || [], blockers: verdict.blockers || [] })
    audit = verdict
    log(`Red gate attempt ${attempt}: structural ${verdict.structurallyRed ? 'RED' : 'NOT red'}, behavioral ${verdict.behaviorallyRed ? 'RED' : 'shortfall'} — ${(verdict.blockers || []).length} note(s); bar = ${remediateOn}`)
    if (meetsBar(verdict)) break
    if (attempt >= 1 + CFG.maxTestRemediationRounds) break
    log(`Red gate: running the single allowed test-remediation round (${remediateOn} failure)`)
    redAgents++
    remediationReport = await askAgent(opusCapped(testRemediationPrompt(verdict, testFileList), CFG.routing.testRemediationModel), {
      label: 'red-remediate', phase: 'Red gate', model: CFG.routing.testRemediationModel, effort: CFG.effort.redRemediate, schema: FIX_SCHEMA,
    })
    if (!remediationReport) log(`Red gate: remediation agent died — re-running the red gate on the tests as they stand`)
  }
  const last = audit || {}
  redGateResult = {
    ran: true,
    remediateOn,
    properlyRed: !!last.properlyRed,
    structurallyRed: !!last.structurallyRed,
    behaviorallyRed: !!last.behaviorallyRed,
    attempts: attempt,
    audits,
    remediation: remediationReport || null,
  }
  if (!meetsBar(last)) {
    const blockers = last.blockers || []
    // BUGFIX MODE, behavioral-only shortfall: the tests DO fail on assertions, they
    // just do not each fail on their own expected value. That is a repro that does not
    // reproduce — major, and `redOk` below keeps the run unclean either way — while a
    // STRUCTURAL failure (a test that errored, passed or never ran) stays a blocker.
    const behavioralOnly = bugfix && last.structurallyRed === true && last.behaviorallyRed !== true
    carried.push({
      file: '(red-gate)',
      severity: behavioralOnly ? 'major' : 'blocker',
      phase: 'Red gate',
      summary: behavioralOnly
        ? 'Red gate is structurally RED but the repro does not reproduce — no test fails on its own expected value from the test plan'
        : `Red gate never went ${remediateOn === 'structural' ? 'structurally' : 'properly'} RED — the new tests are not proven able to fail`,
      detail: behavioralOnly
        ? `On a bug fix the new test IS the repro: it must fail on the bug's OWN wrong value, not on a stub's uniform undefined, or it proves the wiring rather than the defect. Auditor notes: ${JSON.stringify(blockers)}. Per-test outcomes: ${JSON.stringify(last.tests || [])}. Remediation asked for: ${last.remediation || '(none reported)'}`
        : `A test that has never failed proves nothing. Auditor notes: ${JSON.stringify(blockers)}. Per-test outcomes: ${JSON.stringify(last.tests || [])}. Remediation asked for: ${last.remediation || '(none reported)'}`,
      fixHint: behavioralOnly
        ? 'Assert the concrete wrong value the bug produces today (and the right one after the fix), so the test fails on the defect itself.'
        : 'Strengthen the vacuous tests, or rewrite the requirement if the behavior already exists.',
    })
  } else if (!last.behaviorallyRed) {
    // Structurally red, behaviorally unproven. On a major run the mutation probe
    // now covers EVERY target (its risk gate reads properlyRed), which is the
    // direct proof of oracle bite. Only when no probe can run does the shortfall
    // become a finding — otherwise it is a recorded fact, not a fix-loop item.
    if (mutationEnabled) {
      log(`Red gate: behavioral shortfall recorded — the mutation probe will cover all ${mutationTargets.length} target(s) instead of a remediation round`)
    } else {
      carried.push({
        file: '(red-gate)',
        severity: 'minor',
        phase: 'Red gate',
        summary: 'Red gate is structurally RED but the oracles are unproven — every new test fails the same way, and this run declares no mutation targets to prove them later',
        detail: `Auditor notes: ${JSON.stringify(last.blockers || [])}. Per-test outcomes: ${JSON.stringify(last.tests || [])}. Declare mutationProbe.targets for these tests, or strengthen the assertions so each fails on its own expected value.`,
        fixHint: 'Strengthen each test to assert the concrete expected value from the test plan.',
        fixComplexity: 'judgment',
      })
    }
  }
  return { agents: redAgents, raw: carried.length - carriedAtRed }
}

// ═══════════ Phase 3: Implement (Sonnet) ═══════════
const implResults = []
let implSummaries = []
// Returns { agents, raw }; the caller owns the phase bracket.
async function runImplement() {
  const carriedAtImpl = carried.length
  const { waves, issues: waveIssues } = buildWaves(packages)
  carryWaveIssues(waveIssues, 'implementation', 'Implement')
  log(`Implementing ${packages.length} package(s) in ${waves.length} wave(s) from ${planPath}`)
  for (const wave of waves) {
    const results = await runConcurrent(
      wave.map((p) => () =>
        askAgent(implementPrompt(p), {
          label: `impl:${p.id}`,
          phase: 'Implement',
          // p.model: surgical per-package upgrade (e.g. the one money-critical
          // engine package on a major task) without moving the whole fleet.
          model: p.model || CFG.implementModel,
          // p.effort: the plan's per-package override; otherwise the transcription default.
          effort: p.effort || CFG.effort.implement,
          schema: IMPL_SCHEMA,
        }).then((r) => ({ package: p.id, ...(r || DEAD_IMPL) }))
      )
    )
    implResults.push(...results.filter(Boolean))
  }
  implSummaries = implResults.map((r) => ({
    package: r.package, status: r.status, filesChanged: r.filesChanged, deviations: r.deviations,
  }))
  // Its findings ('(implementation)' blockers, plan-ordering issues) are raised in the
  // next phase's code but AUTHORED here — attribute them to the phase that produced them.
  return { agents: packages.length, raw: (carried.length - carriedAtImpl) + implResults.filter((r) => r.status !== 'done').length }
}

if (redGateCfg && CFG.overlapImplementWithRedAudit) {
  // MEASURED TRADE: the red audit reads test files; implementers edit production
  // files; a remediation round edits test files only — so they do not collide.
  // What it risks is a wave of implementation on a package the audit would have
  // sent back. One bracket (Implement, the larger spend); the red gate points at it.
  startPhase('Implement')
  log('overlapImplementWithRedAudit is ON — implementation wave(s) start while the red gate runs')
  const [rg, im] = await parallel([runRedGate, runImplement])
  await endPhase('Implement', im ? im.agents : 0, im ? im.raw : 0)
  markOverlapped('Red gate', 'Implement', rg ? rg.agents : 0, rg ? rg.raw : 0)
  if (!rg) log('!!! Red gate threw while overlapped with Implement — no RED evidence exists; the verdict treats the red gate as failed')
  if (!rg) redGateResult = { ...redGateResult, ran: true, properlyRed: false, structurallyRed: false, behaviorallyRed: false, remediateOn: CFG.redGate.remediateOn }
  overlapInfo.redAuditWithImplement = { ran: true, redGateMetBar: !!(rg && (redGateResult.remediateOn === 'structural' ? redGateResult.structurallyRed : redGateResult.properlyRed)), redGateAttempts: redGateResult.attempts }
} else {
  if (redGateCfg) {
    startPhase('Red gate')
    const rg = await runRedGate()
    await endPhase('Red gate', rg.agents, rg.raw)
  }
  startPhase('Implement')
  const im = await runImplement()
  await endPhase('Implement', im.agents, im.raw)
}

// ═══════════ Phase 4: Gate FIRST, then Review ═══════════
// The gate no longer runs concurrently with the lenses. If the build is broken,
// concurrent lenses spend a whole review round on code that does not compile — so
// gate, repair once, re-gate, and only then spend the reviewers. Seconds of
// wall-clock; a full review round of tokens saved on every broken build.
startPhase('Gate & Review')
let reviewAgents = 0
let gate
// BUGFIX MODE: the radius pack is gathered BESIDE the gate — the gate runs commands,
// the packer reads git, and the lenses (which are what the pack is for) come after
// both. built:false = the lenses read the repo exactly as they do in feature mode.
let radiusPack = {
  built: false,
  truncated: false,
  files: radiusFiles,
  skipped: bugfix ? (wantRadiusPack ? null : 'no-radius-files') : 'feature-mode',
}
const packThunk = () =>
  askAgent(radiusPackPrompt(radiusFiles), {
    label: 'radius-pack', phase: 'Gate & Review', model: CFG.radiusPackModel, effort: CFG.effort.radiusPack, schema: RADIUS_PACK_SCHEMA,
  })
const gateThunk = () =>
  askAgent(gatePrompt(vc.perRound), { label: 'gate', phase: 'Gate & Review', model: CFG.gateModel, effort: CFG.effort.gate, schema: GATE_SCHEMA })
let packOut = null
if (vc.perRound.length && wantRadiusPack) {
  reviewAgents += 2
  const both = await parallel([gateThunk, packThunk])
  gate = enforceCwd(both[0], 'gate') || { pass: false, results: [], summaryError: 'gate agent died' }
  packOut = both[1]
} else if (vc.perRound.length) {
  reviewAgents++
  gate = enforceCwd(await gateThunk(), 'gate') || { pass: false, results: [], summaryError: 'gate agent died' }
} else {
  gate = { pass: true, results: [], skipped: true }
  if (wantRadiusPack) {
    reviewAgents++
    packOut = await packThunk()
  }
}
if (wantRadiusPack) {
  const truncated = !!(packOut && packOut.truncated)
  const text = packOut && typeof packOut.pack === 'string' ? packOut.pack.trim() : ''
  if (text && !truncated) {
    radiusPackText = text
    radiusPack = {
      built: true,
      truncated: false,
      files: Array.isArray(packOut.files) && packOut.files.length ? packOut.files : radiusFiles,
      skipped: null,
    }
    log(`Radius pack: ${text.length} char(s) over ${radiusPack.files.length} file(s) — every review lens reads it as PRIMARY EVIDENCE`)
  } else {
    // A partial pack presented as the whole change is worse than no pack: a reviewer
    // would treat the missing hunks as unchanged. So a truncated or empty pack is
    // discarded and the lenses fall back to reading the repo themselves.
    radiusPack = { built: false, truncated, files: radiusFiles, skipped: !packOut ? 'agent-died' : truncated ? 'truncated' : 'empty-pack' }
    log(`!!! Radius pack UNUSABLE (${radiusPack.skipped}) — the review lenses run exactly as in feature mode, reading the change themselves`)
  }
}
// gateProblem ignores commands that were ALREADY broken at baseline — their
// failures say nothing about this change, so they must not buy a build-fix agent.
// A dead gate agent is a problem, never a pass.
let buildFixReport = null
let gateIssue = gateProblem(gate)
if (gateIssue && vc.perRound.length) {
  const fq = await applyFlakyQuarantine(gate, vc.perRound, 'gate-flaky-rerun')
  gate = fq.gate
  quarantinedLog.push(...fq.quarantined)
  quarantineAbandonedLog.push(...fq.quarantineAbandoned)
  gateIssue = gateProblem(gate)
}
if (gateIssue) {
  log(`Gate FAILED before review — one build-fix agent, then a re-gate, before any reviewer is spent: ${gateIssue.slice(0, 300)}`)
  reviewAgents++
  const buildFixModel = buildFixModelFor()
  buildFixReport = await askAgent(opusCapped(buildFixPrompt(gate.results && gate.results.length ? gate.results : gateIssue), buildFixModel), {
    label: 'build-fix', phase: 'Gate & Review', model: buildFixModel, effort: CFG.effort.buildFix, schema: FIX_SCHEMA,
  })
  if (!buildFixReport) log('Build fix: agent died or was skipped — re-gating the tree as it stands')
  if (vc.perRound.length) {
    reviewAgents++
    gate = enforceCwd(await askAgent(gatePrompt(vc.perRound), { label: 'regate:after-build-fix', phase: 'Gate & Review', model: CFG.gateModel, effort: CFG.effort.gate, schema: GATE_SCHEMA }), 'regate:after-build-fix') ||
      { pass: false, results: [], summaryError: 're-gate agent died after the build fix' }
    gateIssue = gateProblem(gate)
    if (gateIssue) {
      const fq = await applyFlakyQuarantine(gate, vc.perRound, 'regate-after-build-fix-flaky-rerun')
      gate = fq.gate
      quarantinedLog.push(...fq.quarantined)
      quarantineAbandonedLog.push(...fq.quarantineAbandoned)
      gateIssue = gateProblem(gate)
    }
  }
  // The review runs either way: a still-broken build is reviewed anyway, because
  // the lenses' findings are what tell the fix loop why it is broken.
  log(`Re-gate after build fix: ${gateIssue ? 'STILL FAILING — the review runs anyway, on a tree that does not build' : 'passed'}`)
}

// ---- review lenses ----
let lensDied = false
let findings = []
// Runs one review unit (one agent carrying one or more lenses). A unit that dies
// blocks on EVERY lens it was carrying — a merged agent must not silently take two
// dimensions down with it.
async function runReviewUnit(unit, model, scope, tag, ownsUnlisted, waveEff) {
  const label = `review:${unit.label}${tag ? `:${tag}` : ''}`
  // A8 (corrected 2026-09-11c, C1): waveEff — this unit's MODEL FAMILY's deepest
  // effort in the wave — wins when CFG.uniformLensEffort put one there;
  // otherwise this unit picks its own, exactly as before A8.
  const effort = waveEff || unitEffort(unit.lenses)
  // C2: a single-lens unit is tagged with its real lens name; a merged unit
  // (mergeLensesOnSmall) has no per-finding attribution from the model's
  // response, so it is tagged with the unit's own label ("small-combined")
  // rather than guessed apart.
  const lensName = unit.lenses.length === 1 ? unit.lenses[0] : unit.label
  const r = await askAgent(opusCapped(reviewPrompt(unit.lenses, implSummaries, scope, ownsUnlisted), model), {
    label,
    phase: 'Gate & Review',
    model,
    effort,
    schema: FINDINGS_SCHEMA,
  })
  if (r) {
    const out = (r.findings || []).map((f) => ({ ...f, phase: 'Gate & Review', lens: f.lens || lensName }))
    // Count WHO reported what before the merge throws the duplicates away.
    noteCorroboration(label, out)
    // C2: raw, pre-dedupe attribution for result.lensReport — every finding this
    // call actually returned, whatever happens to it later (dedupe, refutation,
    // fix-loop dispute).
    for (const f of out) lensRawFindings.push({ key: findingKey(f), lens: lensName, model, effort })
    return { completed: true, findings: out }
  }
  lensDied = true
  return {
    completed: false,
    findings: unit.lenses.map((l) => ({
      file: '(review)',
      severity: 'blocker',
      phase: 'Gate & Review',
      lens: l,
      summary: `Review lens "${l}" did not complete${tag ? ` (${tag} pass)` : ''} — the change is un-reviewed on this dimension`,
      detail: 'The review agent died or was skipped, so no findings exist for this lens. Do not treat the change as clean; re-run the pipeline or review this dimension manually.',
    })),
  }
}

// Files the reviewers are looking at, partitioned by risk. Only used by the
// cascade; the default path scopes nothing and every unit sees the whole change.
const manifestPaths = manifestResult.files.map((f) => f.path)
const lowRiskFiles = manifestPaths.filter((p) => fileRisk(p) === 'LOW')
const highRiskFiles = manifestPaths.filter((p) => fileRisk(p) !== 'LOW')
let cascadeAudit = null

// One review stage over a set of units. Off the cascade this is a single
// concurrent fan-out at the review model over the whole change — unchanged.
async function reviewStage(units, stageTag) {
  if (!units.length) return { findings: [], agents: 0 }
  // No cascade, or no manifest to partition on: one concurrent fan-out at the
  // review model over the WHOLE change. Without a file list the cascade would
  // review nothing at all, and the floor is not negotiable — so it falls back.
  if (!CFG.cascadeReview || !manifestPaths.length) {
    if (CFG.cascadeReview) log('Cascade review: no manifest to partition on — falling back to a full review at the review model')
    // A8: warm every distinct model this wave is about to use, THEN compute the
    // effort each MODEL FAMILY shares (its deepest unit's — C1, 2026-09-11c),
    // before the fan-out.
    await warmModels(units.map((u) => unitModel(u.lenses)), 'Gate & Review')
    const waveEffByModel = CFG.uniformLensEffort ? waveEffortByModel(units) : null
    const out = await runConcurrent(units.map((u) => () => {
      const model = unitModel(u.lenses)
      return runReviewUnit(u, model, null, stageTag, undefined, waveEffByModel ? waveEffByModel.get(model) : null)
    }))
    return { findings: [].concat(...out.map((o) => o.findings)), agents: units.length }
  }
  // NOTE: the cascade partitions and the spot audit predate bugfix mode — they get no radius pack and feed no corroboration count. Latent while cascadeReview is off.
  // MEASURED TRADE (CFG.cascadeReview): the cheap model takes the LOW-risk
  // partition for breadth; the review model takes HIGH risk plus every file the
  // cheap pass flagged. What this gives up: a subtle defect in a LOW-risk file
  // that the cheap pass misses is never seen by the review model. The spot audit
  // below is the measurement of exactly that.
  let out = []
  let agents = 0
  let flagged = []
  // E5 (owner ruling 2026-09-11, wave 3): the cascade path used to skip BOTH the
  // A8 cache warm-up and the A8 per-model-family uniform effort — every unit ran
  // cold, and effort came from unitEffort(u.lenses) per unit instead of one shared
  // (deepest) figure per model family. Warm every distinct model EITHER partition
  // is about to use, and compute the same waveEffByModel the non-cascade branch
  // above uses, BEFORE either fan-out — so flipping CFG.cascadeReview can never
  // reintroduce a cold, mixed-effort wave.
  await warmModels([CFG.cascadeModel, ...units.map((u) => unitModel(u.lenses))], 'Gate & Review')
  const cascadeEffByModel = CFG.uniformLensEffort ? waveEffortByModel(units) : null
  if (lowRiskFiles.length) {
    const lowOut = await runConcurrent(units.map((u) => () => runReviewUnit(u, CFG.cascadeModel, lowRiskFiles, `${stageTag || 'cascade'}-low`, undefined, cascadeEffByModel ? cascadeEffByModel.get(CFG.cascadeModel) : null)))
    agents += units.length
    const lowFindings = [].concat(...lowOut.map((o) => o.findings))
    out = out.concat(lowFindings)
    flagged = uniquePaths(lowFindings.map((f) => f.file).filter(isRealPath))
  }
  // The deep pass owns the HIGH-risk partition, everything the cheap pass flagged,
  // AND every changed file the preflight manifest never listed. Both partitions are
  // drawn from that manifest, which predates the test-authoring and implementation
  // phases, so a file those phases created belongs to neither — it would otherwise
  // be reviewed by no lens at all, a coverage loss the spot audit (sampled from the
  // same manifest list) is structurally blind to. It therefore runs even when the
  // deep scope is empty: the unlisted remainder is still somebody's job.
  const deepScope = uniquePaths([...highRiskFiles, ...flagged])
  const highOut = await runConcurrent(units.map((u) => () => runReviewUnit(u, unitModel(u.lenses), deepScope, `${stageTag || 'cascade'}-high`, true, cascadeEffByModel ? cascadeEffByModel.get(unitModel(u.lenses)) : null)))
  agents += units.length
  out = out.concat([].concat(...highOut.map((o) => o.findings)))
  // Spot audit: the review model re-reads a deterministic sample of what the cheap
  // pass cleared — the three largest LOW-risk files by changed lines (no randomness
  // exists in this runtime). missedFindings is the number that says whether this
  // trade is ever worth turning on by default.
  const cleared = lowRiskFiles
    .filter((p) => flagged.indexOf(p) === -1)
    .sort((a, b) => (changedLinesOf(b) - changedLinesOf(a)) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, 3)
  if (cleared.length) {
    agents++
    const auditReport = await askAgent(opusCapped(spotAuditPrompt(cleared, implSummaries), CFG.reviewModel), {
      label: `cascade-audit${stageTag ? `:${stageTag}` : ''}`, phase: 'Gate & Review', model: CFG.reviewModel, effort: CFG.effort.cascadeAudit, schema: FINDINGS_SCHEMA,
    })
    const auditFindings = auditReport ? (auditReport.findings || []).map((f) => ({ ...f, phase: 'Gate & Review' })) : []
    out = out.concat(auditFindings)
    const prior = cascadeAudit || { sampled: [], missedFindings: 0, completed: true }
    cascadeAudit = {
      sampled: uniquePaths([...prior.sampled, ...cleared]),
      // A dead auditor measured nothing — say so instead of reporting 0 missed.
      missedFindings: auditReport ? prior.missedFindings + auditFindings.length : prior.missedFindings,
      completed: prior.completed && !!auditReport,
    }
    if (!auditReport) log('!!! Cascade spot audit died — the cascade ran WITHOUT the evidence that justifies it')
    else log(`Cascade spot audit: ${auditFindings.length} defect(s) the cheap pass missed in ${cleared.join(', ')}`)
  }
  return { findings: out, agents }
}

// MEASURED TRADE (CFG.densityEscalation): run the floor lenses first; if they find
// nothing on a green, small diff, skip the rest on the defect-clustering argument.
// Off by default. escalation.lensesSkipped is what keeps a skipped lens visible.
let escalation = { enabled: !!CFG.densityEscalation, triggered: false, lensesSkipped: [], reason: '', threshold: CFG.densityThreshold }
if (!CFG.densityEscalation) {
  const all = await reviewStage(reviewUnits, '')
  findings.push(...all.findings)
  reviewAgents += all.agents
} else {
  const floorUnits = reviewUnits.filter(isFloorUnit)
  const extraUnits = reviewUnits.filter((u) => !isFloorUnit(u))
  const floorOut = await reviewStage(floorUnits, 'floor')
  findings.push(...floorOut.findings)
  reviewAgents += floorOut.agents
  const totalChangedLines = manifestResult.files.reduce((n, f) => n + (f.changedLines || 0), 0)
  // An UNKNOWN diff size counts as over the threshold: no manifest, no escalation.
  const sizeKnown = manifestResult.completed && manifestResult.files.length > 0
  const small = sizeKnown && manifestResult.files.length <= CFG.densityThreshold.files && totalChangedLines <= CFG.densityThreshold.changedLines
  const floorClean = floorOut.findings.length === 0 && !lensDied
  const reason = !extraUnits.length
    ? 'no further lenses to skip'
    : !floorClean
      ? 'the floor lenses reported findings (or one died), so defect density is not zero'
      : gateIssue
        ? 'the gate is not green'
        : !sizeKnown
          ? 'the diff size is unknown (no manifest) — unknown counts as over the threshold'
          : !small
            ? `the diff is over the stated threshold (${manifestResult.files.length} files / ${totalChangedLines} changed lines vs ${CFG.densityThreshold.files} / ${CFG.densityThreshold.changedLines})`
            : ''
  if (extraUnits.length && !reason) {
    escalation = { ...escalation, triggered: true, lensesSkipped: [].concat(...extraUnits.map((u) => u.lenses)), reason: `floor lenses clean, gate green, diff within ${CFG.densityThreshold.files} files / ${CFG.densityThreshold.changedLines} changed lines` }
    log(`!!! Density escalation: SKIPPED lens(es) ${escalation.lensesSkipped.join(', ')} — ${escalation.reason}. These dimensions were NOT reviewed.`)
  } else {
    escalation = { ...escalation, triggered: false, reason: reason || 'no further lenses to skip' }
    const extraOut = await reviewStage(extraUnits, 'extra')
    findings.push(...extraOut.findings)
    reviewAgents += extraOut.agents
  }
}
// Everything above came from THIS phase; `carried` below did not.
const reviewRawCount = findings.length
// CORROBORATION, counted in both modes (it is free — the lenses have already run) and
// acted on only in bugfix mode. In bugfix mode the surviving finding also CARRIES the
// count, so the planner and the fixer see that several independent lenses saw it; in
// feature mode nothing reads it, so nothing is added to the finding and every later
// prompt stays byte-identical.
let corroboratedFindings = 0
for (const set of corroborationOf.values()) if (set.size > 1) corroboratedFindings++
// A3 (owner ruling 2026-09-11): corroboratedBy is attached under the SAME flag
// that makes it act on control flow in Verify (CFG.skipRefuteOnCorroborated) —
// originally bugfix-only (`if (bugfix)`), now general. false restores exactly
// the old bugfix-only annotation.
if (CFG.skipRefuteOnCorroborated) {
  findings = findings.map((f) => {
    const n = corroborationCount(f)
    return n > 1 ? { ...f, corroboratedBy: n } : f
  })
  if (corroboratedFindings) log(`Corroboration: ${corroboratedFindings} finding(s) were reported by 2+ independent lenses — they skip pre-refutation in Verify and go straight to the refute-first fixers`)
}
// Blockers raised before implementation (test authoring, red gate) join the loop here.
findings.push(...carried)
findings = dedupe(findings)

// Blocked/partial packages and gate failures become findings so the fix loop handles them.
for (const r of implResults) {
  if (r.status !== 'done') {
    findings.push({ file: '(implementation)', severity: 'blocker', phase: 'Implement', summary: `Package ${r.package} is ${r.status}`, detail: r.deviations || r.notes || 'no detail reported' })
  }
}
// The VERDICT reads gateProblem(), never the agent's raw `pass`. A command that
// already failed on the untouched baseline tree is a broken COMMAND, not a defect:
// it can never become a '(gate)' blocker and can never make `clean` false — that is
// the whole point of the baseline gate. gateProblem still fails a dead gate agent
// and a pass:false with no per-command evidence. gateIssue is exactly
// gateProblem(gate) for the gate as it now stands (re-read after any build fix).
if (gateIssue) {
  findings.push({ file: '(gate)', severity: 'blocker', phase: 'Gate & Review', summary: 'Verification gate failed', detail: gateIssue })
}
log(`Gate ${gate.skipped ? 'skipped (no commands)' : gateIssue ? 'FAILED' : 'passed'}; ${findings.length} raw finding(s) from ${reviewAgents} review-phase agent(s) over ${lenses.length} lens(es)`)
// gateGreen gates the ONCE-PER-RUN C1 snapshot commit: only Gate & Review ever
// passes it, and only a truly green gate (no gateIssue) offers the commit.
await endPhase('Gate & Review', reviewAgents, reviewRawCount + (gateIssue ? 1 : 0), !gateIssue)

// ═══════════ Phase 5: Verify — adversarial refutation (major only) ═══════════
// Synthetic findings ('(gate)', '(implementation)', '(review)', '(tests)', '(red-gate)')
// are facts, not opinions — they skip refutation.
let verifyStats = {
  ran: false, mode: CFG.verify.mode, lazy: !!CFG.lazySecondVote,
  judged: 0, dropped: 0, votesCast: 0, firstVoteRefuted: 0, firstVoteRefutedRate: null, tieBreaks: 0,
  locationChecked: 0, locationInvalid: 0, preRefuted: 0, deferredToFixer: 0,
  disputed: 0, disputesDropped: 0, disputesUpheld: 0,
  // How many findings 2+ independent lenses reported (counted in BOTH modes), and how
  // many of those skipped pre-refutation because of it (bugfix mode only).
  corroborated: corroboratedFindings, corroboratedSkipped: 0,
  // FABLE BRIEF CAP (CFG.caps.fableBriefBytes): true if any tie-break judge's
  // brief in this run (Verify phase or the Fix-phase dispute slate) was over
  // the byte cap and had to be truncated.
  briefTruncated: false,
}
// effort.refute is never lowered below medium: this verdict decides whether a
// real blocker gets thrown away. A finding on a HIGH-risk file gets high.
const refuteEffort = (f) => (isHighRisk(f.file) ? CFG.effort.refuteHighRisk : CFG.effort.refute)
// TOKEN-CLASS ROUTING (owner ruling 2026-09-10, CFG.routing). Opus is reserved
// for where a wrongly-dropped finding is expensive: a blocker or major finding
// on a HIGH-risk file. Everything else — a non-HIGH-risk file, or a minor
// finding even on a HIGH-risk one — runs the same verdict on the cheaper
// Sonnet tier, at the same `high` effort.
const refuteModelFor = (f) => (isHighRisk(f.file) && (f.severity === 'blocker' || f.severity === 'major') ? CFG.reviewModel : CFG.routing.routineRefuterModel)
const castVote = (f, i, phaseName) => {
  const model = refuteModelFor(f)
  return askAgent(opusCapped(refutePrompt(f), model), { label: `refute${i + 1}:${f.file}`, phase: phaseName, model, effort: refuteEffort(f), schema: VERDICT_SCHEMA })
}

// THE SLATE. Judges a list of findings and returns { kept, dropped, agents, votesCast,
// firstRefuted, tieBreaks }. First votes are cast ONE REFUTER PER FILE (the plan,
// the prefix and the file are read once for every finding on it); only a first
// vote to REFUTE buys the rest of the slate for that finding, and a split goes to
// the Fable judge. Used before the fixer (HIGH-risk / invalid-location findings)
// and after it (findings a fixer disputed). The drop rule is identical in both
// places: the FULL slate survived and agreed, or the judge ruled.
async function judgeFindings(list, phaseName) {
  const out = { kept: [], dropped: [], agents: 0, votesCast: 0, firstRefuted: 0, tieBreaks: 0 }
  if (!list.length) return out
  const lazy = !!CFG.lazySecondVote && votes > 1
  const firstVerdicts = new Map()
  if (CFG.verify.batchPerFile) {
    const groups = groupByFile(list)
    await runConcurrent(groups.map(([fileKey, group]) => async () => {
      out.agents++
      out.votesCast += group.length
      const effort = group.some((f) => isHighRisk(f.file)) ? CFG.effort.refuteHighRisk : CFG.effort.refute
      // Same rule as castVote's refuteModelFor, at group granularity: Opus only
      // when this file is HIGH risk AND at least one finding on it is blocker/major.
      const model = group.some((f) => isHighRisk(f.file) && (f.severity === 'blocker' || f.severity === 'major')) ? CFG.reviewModel : CFG.routing.routineRefuterModel
      const r = await askAgent(opusCapped(refuteBatchPrompt(fileKey, group), model), {
        label: `refute-batch:${fileKey}`, phase: phaseName, model, effort, schema: BATCH_VERDICT_SCHEMA,
      })
      const byIndex = new Map((r && Array.isArray(r.verdicts) ? r.verdicts : []).map((v) => [v.index, v]))
      // A missing verdict is no evidence — the finding is kept.
      group.forEach((f, i) => firstVerdicts.set(f, byIndex.has(i) ? { refuted: byIndex.get(i).refuted === true, reason: byIndex.get(i).reason || '' } : null))
    }))
  } else {
    await runConcurrent(list.map((f) => async () => {
      out.agents++
      out.votesCast++
      const v = await castVote(f, 0, phaseName)
      firstVerdicts.set(f, v ? { refuted: v.refuted === true, reason: v.reason || '' } : null)
    }))
  }
  await runConcurrent(list.map((f) => async () => {
    const first = firstVerdicts.get(f)
    // LAZY SLATE: a first vote to keep — or a dead refuter, which is no evidence —
    // ends it exactly as a full slate voting keep would have.
    if (!first) { out.kept.push(f); return }
    if (first.refuted === true) out.firstRefuted++
    if (lazy && first.refuted !== true) { out.kept.push(f); return }
    let valid = [first]
    if (votes > 1) {
      out.agents += votes - 1
      out.votesCast += votes - 1
      const rest = (await parallel(Array.from({ length: votes - 1 }, (_, i) => () => castVote(f, i + 1, phaseName))))
        .filter(Boolean).map((v) => ({ refuted: v.refuted === true, reason: v.reason || '' }))
      valid = [first, ...rest]
    }
    // Dropped only if the FULL slate of refuters survived and every one of them
    // refuted it. A dead refuter is no-evidence, not a vote to discard — otherwise
    // one dead agent silently lowers the bar for throwing away a real blocker.
    let dropped = valid.length === votes && valid.every((v) => v.refuted)
    // SPLIT vote with the full slate alive: instead of defaulting keep — which sends
    // a disputed maybe-false-positive to a fixer that would MUTATE working code over
    // it — one Fable judge reads the finding plus every verdict and decides. A dead
    // judge keeps the conservative default (keep). Owner policy 2026-08-31.
    if (!dropped && valid.length === votes && valid.some((v) => v.refuted)) {
      out.tieBreaks++
      out.agents++
      // The judge DECIDES from the evidence the refuters cited; it opens no file
      // and runs nothing (Fable is the brain, never the hands — 2026-09-03).
      // FABLE BRIEF CAP: this brief is bounded to CFG.caps.fableBriefBytes.
      const tbBrief = capFableBrief(
        [
          `You are the tie-break judge on a disputed code-review finding. You decide from the material below only — do not read the repository or run commands. If the cited evidence does not settle it, keep the finding (refuted=false): a fixer re-verifies before touching code, and a real defect dropped here ships.`,
          `The finding: ${JSON.stringify(f)}`,
          `${valid.length} refuters SPLIT on it. Their verdicts and the evidence each cited, verbatim:`,
          ...valid.map((v, i) => `- refuter ${i + 1}: refuted=${v.refuted} — ${v.reason}`),
          `Weigh the arguments against each other and give the final verdict. refuted=true discards the finding permanently; refuted=false sends it to the fix loop.`,
        ].join('\n'),
      )
      if (tbBrief.truncated) tieBreakBriefTruncated = true
      const judge = await askAgent(
        tbBrief.text,
        { label: `tiebreak:${f.file}`, phase: phaseName, model: CFG.tieBreakModel, effort: CFG.effort.tieBreak, schema: VERDICT_SCHEMA },
      )
      if (judge && judge.refuted === true) dropped = true
    }
    // C2: judgeFindings is the ONE function both the initial Verify slate and the
    // fix loop's dispute judging go through, so this single mark covers
    // "overturned" (refuted/dropped) everywhere a finding can be dropped.
    if (dropped) { out.dropped.push(f); dropReasonByKey.set(findingKey(f), true) }
    else out.kept.push(f)
  }), CFG.maxConcurrent)
  return out
}

// Returns { findings, agents } computed from a SNAPSHOT of `findings` taken when it
// starts, so it can run beside UI verify without either overwriting the other.
async function runVerify() {
  // Severity x risk gate (CFG.refuteSeverities). A finding skips the slate entirely
  // only when it is BOTH below the severity bar AND on a file Baseline classed LOW
  // risk — unknown/unlisted files are HIGH by construction. Skipped findings are
  // NOT dropped: they go to the fix loop unrefuted.
  const snapshot = findings.slice()
  const refutable = (f) =>
    CFG.refuteSeverities.indexOf(f.severity) !== -1 || isHighRisk(f.file)
  const opinions = snapshot.filter((f) => !f.file.startsWith('(') && refutable(f))
  const unrefuted = snapshot.filter((f) => !f.file.startsWith('(') && !refutable(f))
  const facts = snapshot.filter((f) => f.file.startsWith('('))
  if (unrefuted.length) {
    log(`Verify: ${unrefuted.length} finding(s) below the refutation bar (severity not in [${CFG.refuteSeverities.join(', ')}] and LOW-risk file) go to the fix loop unrefuted`)
  }
  let agents = 0
  // 1. LOCATION CHECK (Sonnet, one agent, mechanical): a finding that cites code
  //    that is not there is pre-refuted whatever its risk class.
  const invalid = new Set()
  if (CFG.verify.locationCheck && opinions.length) {
    agents++
    const lc = await askAgent(locationCheckPrompt(opinions), {
      label: 'location-check', phase: 'Verify', model: CFG.locationCheckModel, effort: CFG.effort.locationCheck, schema: LOCATION_SCHEMA,
    })
    for (const c of lc && Array.isArray(lc.checks) ? lc.checks : []) {
      if (c && c.locationValid === false && opinions[c.index]) invalid.add(opinions[c.index])
    }
    verifyStats.locationChecked = lc ? opinions.length : 0
    verifyStats.locationInvalid = invalid.size
    if (!lc) log('Verify: location check agent died — no finding is treated as mis-cited; nothing is dropped on that account')
  }
  // 2. PARTITION. Pre-refute where a wrong fix is expensive (HIGH-risk file) or the
  //    citation failed; defer the rest to the fixer, which refutes first and
  //    escalates what it disputes to this same slate.
  const wouldPreRefute = CFG.verify.mode === 'all'
    ? opinions
    : opinions.filter((f) => isHighRisk(f.file) || invalid.has(f))
  //    A3 (owner ruling 2026-09-11, CFG.skipRefuteOnCorroborated): a finding 2+
  //    independent lenses reported is not the kind a refuter overturns (F13: 16%
  //    overturn rate overall; the top blocker was reported 6 times independently),
  //    so it skips the pre-refutation slate even on a HIGH-risk file. It is NOT
  //    dropped and NOT trusted: the fixer still refutes first, and anything it
  //    disputes reaches the same adversarial slate. Originally bugfix-mode only
  //    (`bugfix ? ... : []`); the flag makes it the general rule in feature mode too.
  //    A MIS-CITED finding is pre-refuted whatever its corroboration (owner ruling
  //    2026-09-03): several lenses can echo the same wrong line out of the same hunk,
  //    and the location signal already exists and costs nothing to honour.
  const corroboratedSkip = CFG.skipRefuteOnCorroborated ? wouldPreRefute.filter((f) => !invalid.has(f) && corroborationCount(f) >= 2) : []
  const corroboratedButMisCited = CFG.skipRefuteOnCorroborated ? wouldPreRefute.filter((f) => invalid.has(f) && corroborationCount(f) >= 2) : []
  if (corroboratedButMisCited.length) {
    log(`Verify: ${corroboratedButMisCited.length} corroborated finding(s) are STILL pre-refuted — the location check could not find the code they cite (${corroboratedButMisCited.map((f) => `${f.file}:${f.line || '?'}`).join(', ')})`)
  }
  const preRefute = corroboratedSkip.length ? wouldPreRefute.filter((f) => corroboratedSkip.indexOf(f) === -1) : wouldPreRefute
  if (corroboratedSkip.length) {
    log(`Verify: ${corroboratedSkip.length} corroborated finding(s) skip pre-refutation (${corroboratedSkip.map((f) => `${f.file} ×${corroborationCount(f)}`).join(', ')}) — they go to the refute-first fixer, which escalates anything it disputes`)
  }
  const deferred = opinions
    .filter((f) => preRefute.indexOf(f) === -1)
    .map((f) => ({ ...f, verifyDeferred: true }))
  const marked = preRefute.map((f) => (invalid.has(f) ? { ...f, locationInvalid: true } : f))
  // 3. THE SLATE on the pre-refutable set.
  const j = await judgeFindings(marked, 'Verify')
  agents += j.agents
  verifyStats = {
    ...verifyStats,
    ran: true,
    judged: marked.length,
    dropped: j.dropped.length,
    votesCast: j.votesCast,
    firstVoteRefuted: j.firstRefuted,
    firstVoteRefutedRate: marked.length ? Math.round((j.firstRefuted / marked.length) * 1000) / 1000 : null,
    tieBreaks: j.tieBreaks,
    preRefuted: marked.length,
    deferredToFixer: deferred.length,
    corroboratedSkipped: corroboratedSkip.length,
    briefTruncated: tieBreakBriefTruncated,
  }
  log(`Adversarial verify (${CFG.verify.mode}, per-file slate): ${marked.length} finding(s) pre-refuted with ${j.votesCast} vote(s) from ${j.agents} agent(s), ${j.dropped.length} dropped, ${j.tieBreaks} tie-break(s); ${deferred.length} LOW-risk finding(s) deferred to the refute-first fixer${invalid.size ? `; ${invalid.size} mis-cited` : ''}${unrefuted.length ? `; ${unrefuted.length} kept unrefuted below the bar` : ''}`)
  // `unrefuted` and `deferred` are carried through verbatim — skipping the slate
  // must never be a silent way to lose a finding. This phase authors no findings.
  return { findings: [...facts, ...j.kept, ...deferred, ...unrefuted], agents }
}

// ═══════════ Phase 6: UI verify — drive the real UI (skipped when uiVerify is absent) ═══════════
// Evidence from a running browser, not an opinion about source — these findings
// skip refutation and go straight into the fix loop.
let uiVerifyResult = { ran: false, completed: false, viewports: [], findings: [] }
const UI_DEAD = {
  file: '(ui-verify)',
  severity: 'blocker',
  phase: 'UI verify',
  summary: 'UI verification did not complete — the change was never exercised in a browser',
  detail: 'The UI verification agent died or was skipped, so no browser evidence exists for these flows. Do not treat the change as clean; re-run this phase or drive the flows manually. Check that no dev server or browser was left running.',
}
// Drive (Sonnet collects evidence) then judge (Opus rules on it). Returns
// { findings, evidence, completed, agents } — the caller tags and appends.
async function uiDriveAndJudge(priorFindings) {
  const rerun = Array.isArray(priorFindings)
  const evidence = await askAgent(uiDrivePrompt(uiCfg, priorFindings), {
    label: rerun ? 'ui-redrive' : 'ui-drive', phase: 'UI verify', model: CFG.uiDriverModel, effort: CFG.effort.uiDrive, schema: UI_EVIDENCE_SCHEMA,
  })
  if (!evidence) return { findings: [], evidence: null, completed: false, agents: 1 }
  // TOKEN-CLASS ROUTING (owner ruling 2026-09-10): the UI judge stays on
  // Sonnet at high unless the manifest has a HIGH-risk file, in which case it
  // escalates to Opus like every other role in CFG.routing.
  const judgeModel = riskSummary.high > 0 ? CFG.reviewModel : CFG.routing.uiJudgeModel
  const verdict = await askAgent(opusCapped(uiJudgePrompt(uiCfg, evidence, priorFindings), judgeModel), {
    label: rerun ? 'ui-rejudge' : 'ui-judge', phase: 'UI verify', model: judgeModel, effort: CFG.effort.uiJudge, schema: FINDINGS_SCHEMA,
  })
  if (!verdict) {
    // Evidence exists but nobody ruled on it — that is unverified, never clean.
    return {
      findings: [{ file: '(ui-verify)', severity: 'blocker', summary: 'UI evidence was collected but the judge did not rule on it — the browser pass is unverified', detail: `Evidence bundle: ${JSON.stringify(evidence).slice(0, 2000)}`, fixComplexity: 'judgment' }],
      evidence, completed: false, agents: 2,
    }
  }
  return { findings: dedupe(verdict.findings || []), evidence, completed: true, agents: 2 }
}

// Returns { add, agents, raw } — the findings to append, never appended itself,
// so it can run beside Verify.
async function runUiVerify() {
  const uiViewports = uiCfg.viewports && uiCfg.viewports.length ? uiCfg.viewports : ['desktop']
  log(`UI verify: ${(uiCfg.flows || []).length || 1} flow(s) at ${uiViewports.join(', ')}${uiCfg.url ? ` against ${uiCfg.url}` : ''} — ${CFG.uiDriverModel} drives, ${riskSummary.high > 0 ? CFG.reviewModel : CFG.routing.uiJudgeModel} judges`)
  const out = await uiDriveAndJudge()
  // Tag them: a UI finding carries a real source path, so it lands in the generic
  // per-file fix group — the tag is what tells that fixer the result must be
  // re-observed in a browser, not re-read in the source.
  const uiFindings = out.findings.map((f) => ({ ...f, source: 'ui-verify', phase: 'UI verify' }))
  uiVerifyResult = { ran: true, completed: out.completed, viewports: uiViewports, evidence: out.evidence, findings: uiFindings, reVerify: null }
  if (out.evidence) {
    log(`UI verify: ${uiFindings.length} finding(s) judged from the driver's evidence (${(out.evidence.flows || []).length} flow×viewport record(s), completed=${out.evidence.completed})`)
    return { add: uiFindings, agents: out.agents, raw: uiFindings.length }
  }
  log(`UI verify: driver died — recorded as a blocker`)
  return { add: [UI_DEAD], agents: out.agents, raw: 1 }
}

// ═══════════ Sibling sweep — the same defect in a second place (bugfix mode) ═══════════
// The bug being fixed has a SHAPE, and the shape usually repeats. Two agents: a cheap
// grep for the shape, then a judge that says which hits are the same defect live. Its
// findings are NOT pre-refuted — the fixers refute first and the dispute slate judges
// what they dispute, which is the cheaper place to catch a false positive here.
let siblingSweep = {
  ran: false,
  // supplied = the raw array length BEFORE normalisation; patterns = AFTER (what
  // actually runs). Invariant: patterns === args.siblingPatterns.length, or the
  // blocker below is present — the two are allowed to differ ONLY with evidence.
  supplied: rawSiblingPatterns.length,
  patterns: siblingPatterns.length,
  hits: 0,
  findings: 0,
  skipped: !siblingPatterns.length
    ? (rawSiblingPatterns.length ? 'unusable-patterns' : 'no-patterns')
    : bugfix ? null : 'feature-mode',
}
if (siblingPatterns.length && !bugfix) {
  log('Note: args.siblingPatterns is a BUGFIX-MODE argument — this run is in feature mode, so no sibling sweep ran and the patterns were ignored')
}
// Returns { add, agents, raw } so it can run beside Verify / UI verify.
async function runSiblingSweep() {
  log(`Sibling sweep: ${siblingPatterns.length} pattern(s) — ${CFG.siblingGrepModel}@${CFG.effort.siblingGrep} greps, ${CFG.reviewModel}@${CFG.effort.siblingJudge} judges`)
  let agents = 1
  const grep = await askAgent(siblingGrepPrompt(siblingPatterns), {
    label: 'sibling-grep', phase: 'Verify', model: CFG.siblingGrepModel, effort: CFG.effort.siblingGrep, schema: SIBLING_HITS_SCHEMA,
  })
  if (!grep) {
    siblingSweep = { ...siblingSweep, ran: false, skipped: 'grep-died' }
    log('!!! Sibling sweep: the grep agent died or was skipped — no sibling of this defect was looked for (non-blocking)')
    return { add: [], agents, raw: 0 }
  }
  const hits = (Array.isArray(grep.hits) ? grep.hits : []).filter((h) => h && h.file)
  const truncated = Array.isArray(grep.truncated) ? grep.truncated.filter(Boolean) : []
  if (truncated.length) log(`Sibling sweep: hit list CAPPED for pattern(s) ${truncated.join(', ')} — there may be more siblings than were judged`)
  if (!hits.length) {
    siblingSweep = { ...siblingSweep, ran: true, hits: 0, findings: 0, skipped: null, truncated }
    log('Sibling sweep: no match anywhere else in the repo — the defect looks unique to the file being fixed')
    return { add: [], agents, raw: 0 }
  }
  agents++
  const judged = await askAgent(opusCapped(siblingJudgePrompt(siblingPatterns, hits), CFG.reviewModel), {
    label: 'sibling-judge', phase: 'Verify', model: CFG.reviewModel, effort: CFG.effort.siblingJudge, schema: SIBLING_VERDICT_SCHEMA,
  })
  if (!judged) {
    // Hits nobody ruled on are not defects and not clearances — they are unjudged.
    // Recorded loudly; the sweep is a breadth aid and never blocks the fix it rides on.
    siblingSweep = { ...siblingSweep, ran: false, hits: hits.length, findings: 0, skipped: 'judge-died', truncated }
    log(`!!! Sibling sweep: the judge died or was skipped — ${hits.length} hit(s) of this defect's shape are UNJUDGED and reached no fixer (non-blocking; re-run the sweep or read them by hand)`)
    return { add: [], agents, raw: 0 }
  }
  const byIndex = new Map((Array.isArray(judged.verdicts) ? judged.verdicts : []).map((v) => [v.index, v]))
  const add = []
  const counts = { defect: 0, guarded: 0, unrelated: 0, unjudged: 0 }
  hits.forEach((h, i) => {
    const v = byIndex.get(i)
    if (!v) { counts.unjudged++; return }
    if (v.verdict !== 'defect') { counts[v.verdict === 'same-class-but-guarded' ? 'guarded' : 'unrelated']++; return }
    counts.defect++
    add.push({
      file: h.file,
      line: typeof h.line === 'number' ? h.line : 0,
      severity: v.severity === 'blocker' || v.severity === 'minor' ? v.severity : 'major',
      // file:line lead the summary so two siblings never dedupe into one finding.
      summary: `${h.file}:${h.line || '?'} carries the same defect as the bug being fixed — ${String(v.evidence || '').slice(0, 140)}`,
      detail: `Found by the sibling sweep with pattern /${h.pattern || '?'}/. Matching line: ${String(h.excerpt || '').slice(0, 200)}. Judge's evidence: ${v.evidence || '(none given)'}. This is a SECOND occurrence of the defect this run is fixing; it was not pre-refuted, so verify it in the code before changing anything.`,
      fixHint: 'Apply the same fix (or the same guard) here, in the same shape as the primary fix, and cover it with a test.',
      // The same decision the primary fix needs: judgment, not transcription.
      fixComplexity: 'judgment',
      source: 'sibling-sweep',
      phase: 'Verify',
    })
  })
  siblingSweep = { ...siblingSweep, ran: true, hits: hits.length, findings: add.length, skipped: null, truncated, verdicts: counts }
  log(`Sibling sweep: ${hits.length} hit(s) — ${counts.defect} same defect, ${counts.guarded} same shape but guarded, ${counts.unrelated} unrelated${counts.unjudged ? `, ${counts.unjudged} left unjudged by the judge` : ''}`)
  return { add, agents, raw: add.length }
}

// Verify (refuters read code) and UI verify (drives the app) are both read-only
// with respect to the tree, so they run beside each other under one bracket. The
// bugfix sibling sweep is read-only too, and joins whichever of them runs.
const verifyWanted = votes > 0 && findings.length > 0
const uiWanted = !!uiCfg
const sweepWanted = wantSiblingSweep
// A sweep that threw is not a sweep that found nothing.
const sweepThrew = () => {
  siblingSweep = { ...siblingSweep, ran: false, skipped: 'threw' }
  log('!!! Sibling sweep threw — no sibling of this defect was looked for (non-blocking)')
}
if (verifyWanted && uiWanted) {
  startPhase('Verify')
  overlapInfo.verifyWithUiVerify = true
  const [v, u, sw] = await parallel(sweepWanted ? [runVerify, runUiVerify, runSiblingSweep] : [runVerify, runUiVerify])
  if (v) findings = v.findings
  else log('!!! Verify threw — every finding is kept unrefuted')
  if (u) findings.push(...u.add)
  else { uiVerifyResult = { ...uiVerifyResult, ran: true, completed: false }; findings.push(UI_DEAD) }
  if (sweepWanted) {
    if (sw) findings.push(...sw.add)
    else sweepThrew()
  }
  await endPhase('Verify', (v ? v.agents : 0) + (sw ? sw.agents : 0), sw ? sw.raw : 0)
  markOverlapped('UI verify', 'Verify', u ? u.agents : 1, u ? u.raw : 1)
} else if (verifyWanted) {
  startPhase('Verify')
  if (sweepWanted) {
    const [v, sw] = await parallel([runVerify, runSiblingSweep])
    if (v) findings = v.findings
    else log('!!! Verify threw — every finding is kept unrefuted')
    if (sw) findings.push(...sw.add)
    else sweepThrew()
    await endPhase('Verify', (v ? v.agents : 0) + (sw ? sw.agents : 0), sw ? sw.raw : 0)
  } else {
    const v = await runVerify()
    findings = v.findings
    await endPhase('Verify', v.agents, 0)
  }
} else if (uiWanted) {
  startPhase('UI verify')
  if (sweepWanted) {
    // The sweep's agents are labelled phase 'Verify' (that is where they belong), but
    // the Verify bracket never opened this run, so their tokens are counted here.
    const [u, sw] = await parallel([runUiVerify, runSiblingSweep])
    if (u) findings.push(...u.add)
    else { uiVerifyResult = { ...uiVerifyResult, ran: true, completed: false }; findings.push(UI_DEAD) }
    if (sw) findings.push(...sw.add)
    else sweepThrew()
    phaseStats['UI verify'].note = 'includes the bugfix sibling sweep, which ran beside it'
    await endPhase('UI verify', (u ? u.agents : 1) + (sw ? sw.agents : 0), (u ? u.raw : 1) + (sw ? sw.raw : 0))
  } else {
    const u = await runUiVerify()
    findings.push(...u.add)
    await endPhase('UI verify', u.agents, u.raw)
  }
} else if (sweepWanted) {
  startPhase('Verify')
  const sw = await runSiblingSweep()
  findings.push(...sw.add)
  await endPhase('Verify', sw.agents, sw.raw)
}
if (sweepWanted) findings = dedupe(findings)

// ═══════════ Phase 7: Mutation probe — prove the tests would catch a regression ═══════════
// Major scale only. STRICTLY SEQUENTIAL: each probe leaves a deliberately broken
// file on disk for the length of its test run, so two at once would poison each
// other's results. Backup-and-restore by file copy ONLY — a git restore here
// would wipe the uncommitted implementation this very run just produced.
let mutationResult = {
  ran: false, targets: 0, results: [], allCaught: true, allRestored: true,
  // null ONLY when the phase never ran. false whenever the independent before/after
  // digests did not prove the files came back — a dead checksum agent included.
  restoredVerified: null,
  checksumMismatches: [],
  // Files whose pre-probe baseline was taken on different content than the probes
  // themselves saw — something outside this run wrote the tree between the two. Not
  // a restore failure, and never counted as one.
  baselineDisturbed: [],
  skippedTargets: [],
  // A5: one entry per surviving mutant CFG.mutationRemediate attempted to fix;
  // empty whenever the phase never ran, no target survived, or the flag is off.
  remediation: [],
  // Why the phase did not run, when it did not: 'small-scale' | 'no-targets' |
  // 'risk-gated' (every target skipped) | null when it ran.
  skipped: !mutationEnabled ? (scale !== 'major' ? 'small-scale' : 'no-targets') : null,
}
// RISK GATE. The red gate already proves each NEW test can fail for the right
// reason; the probe proves the suite catches a regression. That evidence overlaps,
// so the probe is spent only where it is not redundant: a HIGH-risk file, or a run
// where the red gate never happened. EVERY skip is logged and recorded — a probe
// that was silently skipped must never read like a probe that passed.
const probeTargets = []
const skippedProbes = []
if (mutationEnabled) {
  for (const t of mutationTargets) {
    if (isHighRisk(t.file)) probeTargets.push(t)
    // Only a red gate that actually went RED is the overlapping evidence this
    // skip trades on. A red gate that ran and FAILED proved the opposite, so the
    // probe is the run's last regression evidence — never skip it there.
    else if (!redGateResult.ran || redGateResult.properlyRed !== true) probeTargets.push(t)
    else skippedProbes.push({ file: t.file, test: t.test, reason: 'LOW-risk file and the red gate already proved these tests fail for the right reason — overlapping evidence, so no probe was spent here' })
  }
  for (const s of skippedProbes) log(`Mutation probe SKIPPED for ${s.file} (test "${s.test}") — ${s.reason}. This is NOT evidence that the test catches a regression.`)
  if (!probeTargets.length) {
    mutationResult = {
      ...mutationResult,
      targets: mutationTargets.length,
      probed: 0,
      skippedTargets: skippedProbes,
      skipped: 'risk-gated',
      note: 'Every target was skipped by the risk gate, so NO probe ran. allCaught/allRestored describe the probes that ran — here, none. This run has no mutation evidence.',
    }
    phaseStats['Mutation probe'].note = 'skipped: every target risk-gated (LOW-risk file and a red gate that already went red)'
    log(`Mutation probe: all ${mutationTargets.length} target(s) skipped by the risk gate — the phase produced NO regression evidence this run`)
  }
}
if (mutationEnabled && probeTargets.length) {
  startPhase('Mutation probe')
  const mutTargetFiles = uniquePaths(probeTargets.map((t) => t.file))
  const mutFindingsAt = findings.length
  log(`Mutation probe: ${probeTargets.length} of ${mutationTargets.length} target(s) probed (${skippedProbes.length} skipped by the risk gate), sequential; ${mutTargetFiles.length} file(s) checksummed before and after`)
  // Step 1 — PRE-checksums, by an agent that only reads. This is the record the
  // restore is judged against, taken before any file has been touched.
  const preReport = await askAgent(checksumPrompt(mutTargetFiles, 'before'), {
    label: 'mutation-checksum:before', phase: 'Mutation probe', model: CFG.gateModel, effort: CFG.effort.checksum, schema: CHECKSUM_SCHEMA,
  })
  const probes = []
  for (const t of probeTargets) {
    // BUGFIX MODE: a target marked revertFix already HAS the defect the test must
    // catch — the committed content — so the probe reverts the fix instead of
    // inventing a new defect. A file with no committed version to revert to (the
    // manifest says untracked/planned) falls back to the standard mutation, recorded.
    const wantsRevert = bugfix && t.revertFix === true
    const noHead = wantsRevert && hasNoHeadContent(t.file)
    const useRevert = wantsRevert && !noHead
    if (noHead) log(`Fix-revert probe for ${t.file} FELL BACK to the standard mutation probe — the manifest reports it "${fileStatus(t.file)}", so there is no committed content to revert to`)
    // TOKEN-CLASS ROUTING (owner ruling 2026-09-10): the probe is mechanical
    // (inject one defect, verify it caught, restore) with one judgment call —
    // CFG.routing.probeModel (Sonnet) at medium, not the review model.
    const r = await askAgent(useRevert ? revertProbePrompt(t) : mutationPrompt(t), {
      label: `mutate:${t.file}`, phase: 'Mutation probe', model: CFG.routing.probeModel, effort: CFG.effort.mutate, schema: MUTATION_SCHEMA,
    })
    // The probe agent may report its own fallback (its `git ls-files` check found no
    // committed content). Either way the run records which procedure actually ran.
    const agentFellBack = !!(r && r.fallback === 'untracked')
    const kind = useRevert && !agentFellBack ? 'revert-fix' : 'mutation'
    const fallbackNote = wantsRevert && (noHead || agentFellBack) ? 'untracked' : ''
    // A dead probe may have left the file mutated — assume the worst, loudly.
    const probe = r
      ? { ...r, target: t.test, kind, ...(fallbackNote ? { fallback: fallbackNote } : {}) }
      : { file: t.file, target: t.test, kind, ...(fallbackNote ? { fallback: fallbackNote } : {}), defect: `(unknown — ${kind === 'revert-fix' ? 'fix-revert' : 'mutation'} probe agent died)`, caught: false, restored: false, evidence: `The ${kind === 'revert-fix' ? 'fix-revert' : 'mutation'} probe agent died or was skipped. It may have left the file reverted or deliberately broken, and its backup copy in the OS temp directory (named "${kind === 'revert-fix' ? 'revertprobe' : 'mutprobe'}-*").` }
    probes.push(probe)
    // The backup lives in the OS temp directory, never beside the file — a leftover
    // backup inside the repo becomes a shipped file.
    const backupRef = probe.backupPath ? `"${probe.backupPath}"` : `the "${probe.kind === 'revert-fix' ? 'revertprobe' : 'mutprobe'}-*" copy of this file in the OS temp directory`
    if (!probe.restored) {
      log(`!!! MUTATION RESTORE FAILED for ${t.file} — a deliberate defect may still be in the working tree. Restore it from ${backupRef} by file copy; do NOT use git. Evidence: ${probe.evidence}`)
      findings.push({
        file: '(mutation)',
        severity: 'blocker',
        phase: 'Mutation probe',
        // target keeps two unrestored files in the same directory from deduping
        // into one finding — the summary alone is not a discriminator here.
        target: t.file,
        summary: `Mutation probe did not restore ${t.file} — a deliberate defect may still be in the working tree`,
        detail: `Injected defect: ${probe.defect}. Evidence: ${probe.evidence}. Restore the file by copying ${backupRef} over it and byte-comparing them; NEVER use git checkout/restore/stash here, uncommitted implementation work would be destroyed.`,
        fixHint: `cp ${backupRef} "${t.file}" then cmp -s the two, then delete the backup.`,
      })
    }
    if (!probe.caught) {
      const reverted = probe.kind === 'revert-fix'
      findings.push({
        file: '(mutation)',
        severity: 'blocker',
        phase: 'Mutation probe',
        target: t.file,
        summary: reverted
          ? `Test "${t.test}" still PASSED with the fix in ${t.file} reverted to its committed content — it does not actually cover the fix`
          : `Test "${t.test}" did not fail when ${t.file} was deliberately broken — it does not actually cover this behavior`,
        detail: reverted
          ? `Protected behavior: ${t.behavior || '(as named in the test plan)'}. The probe put the file back to HEAD, which re-introduces the bug, and the test still did not fail: ${probe.evidence}. The test passes for a reason other than the fix — it is not a regression test for this bug.`
          : `Protected behavior: ${t.behavior || '(as named in the test plan)'}. Injected defect: ${probe.defect}. Result: ${probe.evidence}. The test is passing for a reason other than the behavior it claims to prove.`,
        fixHint: 'Strengthen or add the test so this exact defect turns it red; do not weaken the implementation to match a weak test.',
      })
    }
  }
  // Step 3 — POST-checksums, by a second read-only agent that never touched a file.
  const postReport = await askAgent(checksumPrompt(mutTargetFiles, 'after'), {
    label: 'mutation-checksum:after', phase: 'Mutation probe', model: CFG.gateModel, effort: CFG.effort.checksum, schema: CHECKSUM_SCHEMA,
  })
  // The SCRIPT compares step 1 against step 3. A probe agent's own `restored: true`
  // is a self-report by the one party that could have broken the file — it can never
  // clear itself. Absent evidence is UNVERIFIED, never restored.
  const preMap = checksumMap(preReport)
  const postMap = checksumMap(postReport)
  const checksumMismatches = []
  const baselineDisturbed = []
  // THE BASELINE CAN MOVE UNDER US. The before-agent digests the tree at one moment;
  // anything outside this run that writes a file between then and the probes makes an
  // untouched file look unrestored, and the fixer that finding dispatches is told to
  // "reconstruct the correct content by hand" — on a file that was never broken.
  // The probes' OWN before/after digests settle it: if every probe on the file saw the
  // same content before and after its mutation, and that content is what the file
  // holds now, the file is intact and it was the BASELINE that was stale. Anything
  // less than that — a probe with no hashes, probes that disagree, a self-report that
  // does not match the final state — keeps today's behaviour exactly.
  function baselineWasDisturbed(k, after) {
    if (!after) return false
    const own = probes.filter((pr) => normPath(pr.file) === k)
    if (!own.length) return false
    return own.every((pr) => {
      const pre = normHash(pr.preHash)
      const post = normHash(pr.postHash)
      return pre && pre === post && post === after
    })
  }
  let restoredVerified
  if (!preReport || !postReport) {
    restoredVerified = false
    const which = !preReport && !postReport ? 'Both checksum agents' : !preReport ? 'The BEFORE checksum agent' : 'The AFTER checksum agent'
    findings.push({
      file: '(mutation)',
      severity: 'blocker',
      phase: 'Mutation probe',
      summary: 'Mutation restore is UNVERIFIED — the independent checksum evidence is missing',
      detail: `${which} died or was skipped, so nothing outside the probe agents confirms that ${mutTargetFiles.join(', ')} came back byte-identical. Unverified is not restored: a deliberately injected defect may still be in the working tree.`,
      fixHint: `Byte-compare each mutation target against the ${PROBE_BACKUP_GLOB} backup in the OS temp directory (or against the intended implementation) by hand before trusting this tree; NEVER git checkout/restore/stash here, uncommitted work from this run would be destroyed.`,
    })
    log(`!!! Mutation restore UNVERIFIED — ${which.toLowerCase()} died; treat every target as possibly still mutated`)
  } else {
    restoredVerified = true
    for (const f of mutTargetFiles) {
      const k = normPath(f)
      const before = preMap[k]
      const after = postMap[k]
      if (before && after && before === after) continue
      if (baselineWasDisturbed(k, after)) {
        baselineDisturbed.push(f)
        log(`Mutation probe: ${f} — the pre-probe baseline digest does not match, but every probe on it reports the SAME digest before and after its mutation, and that digest is the file's current content. The baseline was taken on different content (something outside this run wrote the tree); the file is intact, so this is NOT a restore failure.`)
        continue
      }
      restoredVerified = false
      checksumMismatches.push(f)
      // checksumMap blanks anything that is not a hex digest, so two unreadable
      // files never compare equal — a missing digest is a mismatch, not a match.
      const unreadable = !before || !after
      const why = unreadable
        ? 'a checksum agent could not read the file, so there is no evidence either way'
        : `digest changed across the probe: ${before} -> ${after}`
      findings.push({
        file: '(mutation)',
        severity: 'blocker',
        phase: 'Mutation probe',
        target: f,
        summary: `${f} is ${unreadable ? 'not verifiably back to' : 'NOT back to'} its pre-probe content after the mutation probe`,
        detail: `Independent before/after checksums disagree for ${f}: ${why}. The probe agent reported restored=${JSON.stringify((probes.find((p) => normPath(p.file) === k) || {}).restored)}, but that is a self-report from the agent that mutated the file. A deliberately injected defect may still be in the working tree.`,
        fixHint: `Copy the backup the probe reported (its backupPath, in the OS temp directory) over "${f}", byte-compare with \`cmp -s\`, then delete the backup. NEVER git checkout/restore/stash — uncommitted work from this run would be destroyed.`,
      })
      log(`!!! MUTATION CHECKSUM MISMATCH for ${f} — ${why}`)
    }
  }
  mutationResult = {
    ran: true,
    targets: mutationTargets.length,
    probed: probeTargets.length,
    // Targets the risk gate did not spend a probe on. They are NOT evidence of
    // anything: allCaught below speaks only for the probes that actually ran.
    skippedTargets: skippedProbes,
    results: probes,
    allCaught: probes.every((p) => p.caught === true),
    allRestored: probes.every((p) => p.restored === true),
    restoredVerified,
    checksumMismatches,
    baselineDisturbed,
    note: baselineDisturbed.length
      ? `The pre-probe baseline digest disagreed with the post-probe one for ${baselineDisturbed.join(', ')}, but every probe on those files reported the same digest before and after its own mutation, and that digest is what the file holds now: the BASELINE was taken on different content (something outside this run wrote the tree), not the file left unrestored. They are excluded from checksumMismatches and do not affect restoredVerified.`
      : '',
  }
  log(`Mutation probe: ${probes.filter((p) => p.caught).length}/${probes.length} caught, ${probes.filter((p) => p.restored).length}/${probes.length} self-reported restored, restore independently verified: ${restoredVerified}${baselineDisturbed.length ? `; ${baselineDisturbed.length} file(s) had a disturbed pre-probe baseline and were cleared by the probes' own digests: ${baselineDisturbed.join(', ')}` : ''}${skippedProbes.length ? `; ${skippedProbes.length} target(s) skipped by the risk gate and NOT probed` : ''}`)
  // A5 MUTANT FEEDBACK WITH ACCEPTANCE BAR (owner ruling 2026-09-11,
  // CFG.mutationRemediate). This is informational feedback for FUTURE runs, not
  // a retroactive fix for THIS one: allCaught/mutationOk above already recorded
  // the one-shot oracle result and are never revised by it (same philosophy as
  // "a later fix round clearing a mutation finding is NOT evidence the test now
  // catches the defect"). A kept remediation only means the strengthened test
  // survives in the tree; a reverted one leaves no trace beyond this record.
  const mutationRemediation = []
  let mutAgents = 0
  if (CFG.mutationRemediate) {
    for (const t of probeTargets) {
      const probe = probes.find((p) => normPath(p.file) === normPath(t.file) && p.target === t.test)
      if (!probe || probe.caught !== false) continue
      mutAgents++
      const remAgent = await askAgent(mutationRemediatePrompt(t, probe), {
        label: `mutation-remediate:${t.file}`, phase: 'Mutation probe', model: CFG.testModel, effort: CFG.effort.mutationRemediate, schema: MUTATION_REMEDIATE_SCHEMA,
      })
      if (!remAgent || !Array.isArray(remAgent.filesChanged) || !remAgent.filesChanged.length) {
        mutationRemediation.push({ file: t.file, test: t.test, attempted: !!remAgent, kept: false, reason: remAgent ? 'remediation agent made no change' : 'remediation agent died or was skipped' })
        continue
      }
      // Re-probe the SAME mutation: does the strengthened test now catch it?
      mutAgents++
      const reProbe = await askAgent(mutationPrompt(t), {
        label: `mutate-reprobe:${t.file}`, phase: 'Mutation probe', model: CFG.routing.probeModel, effort: CFG.effort.mutate, schema: MUTATION_SCHEMA,
      })
      const caughtNow = !!(reProbe && reProbe.caught)
      // ACCEPTANCE BAR ('kills-mutant'): caught now, AND the suite the change
      // might have broken is still green — a careless test can pass its own
      // probe and still wreck the build.
      let gateStillGreen = true
      let regateProblem = null
      let regateCwdMismatch = false
      if (caughtNow && vc.perRound.length) {
        mutAgents++
        const g = enforceCwd(await askAgent(gatePrompt(vc.perRound), { label: `gate:mutation-remediate:${t.file}`, phase: 'Mutation probe', model: CFG.gateModel, effort: CFG.effort.gate, schema: GATE_SCHEMA }), `gate:mutation-remediate:${t.file}`)
        gateStillGreen = !!(g && g.pass)
        regateProblem = g ? (g.cwdMismatch || (g.pass ? null : 'gate red')) : 'no gate result'
        regateCwdMismatch = !!(g && g.cwdMismatch)
      }
      const kept = CFG.mutationAcceptanceBar === 'kills-mutant' ? caughtNow && gateStillGreen : caughtNow
      // E2 (owner ruling 2026-09-11, wave 3): a rejected remediation's revert is
      // verified, never trusted on the reverting agent's own say-so. `restored:true`
      // is a self-report from the party that just edited the file; the independent
      // evidence is a SEPARATE read-only checksum agent (the same before/after
      // pattern the mutation probes use) confirming the file now matches its backup.
      let reverted = false
      let revertVerified = false
      let revertProblem = ''
      if (!kept) {
        if (!remAgent.backupPath) {
          revertProblem = 'no backupPath was reported for the rejected edit, so it could not be reverted'
        } else {
          mutAgents++
          const revertResult = await askAgent(mutationRemediateRevertPrompt(t, remAgent), {
            label: `mutation-remediate-revert:${t.file}`, phase: 'Mutation probe', model: CFG.gateModel, effort: CFG.effort.checksum, schema: MUTATION_REVERT_SCHEMA,
          })
          if (!revertResult) {
            revertProblem = 'the revert agent died or was skipped'
          } else if (revertResult.restored !== true) {
            revertProblem = `the revert agent reported restored=false${revertResult.note ? ` (${revertResult.note})` : ''}`
          } else {
            reverted = true
            const revertedFile = (remAgent.filesChanged || [t.file])[0]
            mutAgents++
            const cmp = await askAgent(checksumPrompt([revertedFile, remAgent.backupPath], 'after'), {
              label: `mutation-remediate-revert-checksum:${t.file}`, phase: 'Mutation probe', model: CFG.gateModel, effort: CFG.effort.checksum, schema: CHECKSUM_SCHEMA,
            })
            const cmpMap = checksumMap(cmp)
            const fileDigest = cmpMap[normPath(revertedFile)]
            const backupDigest = cmpMap[normPath(remAgent.backupPath)]
            revertVerified = !!fileDigest && !!backupDigest && fileDigest === backupDigest
            if (!revertVerified) revertProblem = 'the independent checksum agent could not confirm the reverted file matches its backup'
          }
        }
      }
      mutationRemediation.push({
        file: t.file,
        test: t.test,
        attempted: true,
        filesChanged: remAgent.filesChanged,
        caughtAfter: caughtNow,
        gateStillGreen,
        regateProblem,
        kept,
        ...(kept ? {} : { reverted, revertVerified }),
        reason: kept
          ? 'the re-probe caught the mutant and the gate stayed green'
          : !caughtNow
            ? 'the re-probe still did not catch the mutant — reverted'
            : regateCwdMismatch
              ? 'regate-cwd-mismatch'
              : 'regate-red',
      })
      if (!kept && !revertVerified) {
        // A rejected test edit that cannot be PROVEN gone is treated as still in
        // the tree — this is a blocker, not a log line, so the run cannot close clean.
        findings.push({
          file: '(mutation-remediation)',
          severity: 'blocker',
          phase: 'Mutation probe',
          target: t.file,
          summary: `Rejected test edit to ${t.file} may remain in the tree`,
          detail: `Mutation remediation on ${t.file} was rejected (${!caughtNow ? 'the re-probe still did not catch the mutant' : 'the gate broke after the change'}), and the revert could not be independently verified: ${revertProblem}.`,
          fixHint: `Byte-compare ${t.file} against ${remAgent.backupPath || 'its backup'} by hand (\`cmp -s\`) and restore it by file copy if it still carries the rejected edit; NEVER git checkout/restore/stash here.`,
        })
      }
      log(`Mutation remediation for ${t.file}: ${kept ? 'KEPT' : `REVERTED (verified=${revertVerified})`} — caughtAfter=${caughtNow}, gateStillGreen=${gateStillGreen}`)
    }
  }
  mutationResult = { ...mutationResult, remediation: mutationRemediation }
  await endPhase('Mutation probe', 2 + probes.length + mutAgents, findings.length - mutFindingsAt)
}

findings = dedupe(findings)
const confirmedInitial = [...findings]

// ═══════════ Phase 8: Fix rounds — Fable plans, Sonnet/Opus execute, re-check after each ═══════════
// finalGate tracks the LAST gate run, so the returned gate never goes stale
// when a fix round regresses the build after an initially green gate.
let finalGate = { pass: gate.pass, skipped: !!gate.skipped, results: gate.results || [], cwdMismatch: gate.cwdMismatch }
// What this run has actually PROVEN, in one line. Two deciders read it — the fix
// planner on every round and the final-pass decider at the end — and they must be
// told the same thing, so it is built in exactly one place.
function runOracles() {
  return `red gate ${redGateResult.ran ? `structural=${redGateResult.structurallyRed} behavioral=${redGateResult.behaviorallyRed} attempts=${redGateResult.attempts}` : 'not run'}; mutation probe ${mutationResult.ran ? `${(mutationResult.results || []).filter((p) => p.caught).length}/${mutationResult.probed} caught, restore verified=${mutationResult.restoredVerified}` : `not run (${mutationResult.skipped})`}; gate ${gateProblem(finalGate) === null ? 'green' : 'RED'}; lens findings confirmed before fixing: ${confirmedInitial.length}`
}
const fixReportsAll = []
// One entry per round: what Fable decided and who decided it. completed:false means
// neither the planner nor its fallback ruled, and the round ran on legacy routing.
const fixPlanRounds = []
// Findings the planner DEFERRED: the fix needs a decision this run cannot make. They
// are held out of every later round's toFix, but stay in `findings` carrying
// `deferred`, so they reach remainingFindings and keep `clean` false.
const deferredKeys = new Set()
// The owner questions this run could not answer, in the order they were raised.
// The close-out surfaces these: a deferral is a decision waiting on a person.
const deferredQuestions = []
let round = 0
// A2 EXECUTION-VERIFIED CONFIRMED (owner ruling 2026-09-11, CFG.executionVerified).
// Keyed by findingKey() rather than object identity, because a finding that
// survives a round comes back as a FRESH object from the recheck agent, not
// the same reference the fixer saw. 'execution' = a fixer's verifiedFixes
// entry (test/redOn/greenOn) corroborated by that round's own green re-gate;
// 'ruled' = Fable's fix-plan decision marked `ruled: true` from cited evidence
// (a finding with no runnable check); absent = 'plausible'. Filled in at
// close-out for every finding still in confirmedInitial.
const verificationByKey = new Map()
// ═══════════ Phase 10: Final pass — Fable over the HIGH-risk diff (major only) ═══════════
// The in-pipeline form of the house close-out rule (a Fable pass over the
// money-critical diff caught a CRITICAL that three Opus lenses and their refuters
// had passed clean). Token discipline: the strongest model reads ONLY the
// HIGH-risk files' final diffs plus what the run already knows — never the whole
// tree — and when the diff has no HIGH-risk file at all the pass is skipped and
// recorded (CFG.finalPassWhenNoHighRisk), instead of quietly reading everything.
// Its findings do NOT get a fix round on their own: at the terminal call they
// land in remainingFindings, keeping `clean` false; on major scale, before the
// LAST budgeted round (P5, CFG.finalPassBeforeLastRound), they are folded into
// that round's findings instead, so a paid fixer gets to act on them.
// MOVED HERE (owner ruling 2026-09-11e, package P5) from its old spot right
// after the fix loop: `fpPlan` must exist before the loop starts so a
// pre-last-round call inside it can read the same plan the terminal call uses —
// scale, riskMap and CFG never change mid-run, so computing it once, earlier,
// changes nothing about what it decides.
let finalPassResult = { ran: false, completed: false, skipped: scale === 'major' ? null : 'small-scale', reader: null, model: null, effort: null, fallback: false, files: [], candidates: 0, gaps: [], secondRead: false, decision: '', findings: [], briefTruncated: false }
// Snapshots of every runFinalPass() call before the terminal one — see the
// snapshot-before-overwrite at the top of runFinalPass(). Nothing else reads
// this; it exists so resultObj.finalPass.priorPasses can carry per-call detail
// (candidates/gaps/decision/findings/origin) without changing the top-level
// finalPass shape, which stays the terminal call's values exactly as before.
let finalPassRuns = []
function finalPassPlan() {
  if (scale !== 'major') return { run: false, skipped: 'small-scale', files: [], model: null, whole: false }
  const listed = Object.keys(riskMap)
  const highFiles = listed.filter((k) => riskMap[k] === 'HIGH')
  if (highFiles.length) return { run: true, skipped: null, files: highFiles, model: CFG.finalPassModel, whole: false }
  // No manifest means every file is HIGH by construction — the read is not skipped.
  if (!listed.length) return { run: true, skipped: null, files: [], model: CFG.finalPassModel, whole: true }
  if (CFG.finalPassWhenNoHighRisk === 'skip') return { run: false, skipped: 'no-high-risk-files', files: [], model: null, whole: false }
  return {
    run: true,
    skipped: null,
    files: listed,
    model: CFG.finalPassWhenNoHighRisk === 'opus' ? CFG.finalPassFallbackModel : CFG.finalPassModel,
    whole: true,
  }
}
const fpPlan = finalPassPlan()
while (round < CFG.maxFixRounds) {
  const unfixable = findings.filter(isUnfixable)
  const deferredHeld = findings.filter((f) => !isUnfixable(f) && deferredKeys.has(findingKey(f)))
  let toFix = findings.filter((f) => !isUnfixable(f) && !deferredKeys.has(findingKey(f)))
  if (!toFix.length) break
  if (budget.total && budget.remaining() < CFG.budgetFloor) {
    log(`Token budget nearly exhausted (${Math.round(budget.remaining() / 1000)}k left) — stopping before fix round ${round + 1}`)
    break
  }
  // P5 (owner ruling 2026-09-11e): on major scale, when the iteration about to
  // run is the LAST budgeted round, run the final pass FIRST instead of only
  // after the loop — in every ledger row where the terminal pass found a
  // major, fixRounds was already at the cap and the finding never got a paid
  // fix. `round` here is still the count of ROUNDS ALREADY RUN (pre-increment),
  // so `=== CFG.maxFixRounds - 1` means the round about to start is the last
  // one. Gated on `fpPlan.run` too — CFG.finalPassWhenNoHighRisk can mean the
  // final pass is not supposed to run at all, and this reorder must not run it
  // anyway. The terminal final pass after the loop is untouched and still runs.
  if (scale === 'major' && CFG.finalPassBeforeLastRound && round === CFG.maxFixRounds - 1 && fpPlan.run) {
    startPhase('Final pass')
    const pre = await runFinalPass('pre-last-round')
    const preTagged = pre.add.map((f) => ({ ...f, phase: 'Final pass', origin: 'pre-last-round' }))
    findings = dedupe([...findings, ...preTagged])
    await endPhase('Final pass', pre.agents, pre.raw, undefined, { skipCheckpoint: true })
    log(`Final pass ran BEFORE fix round ${round + 1} (the last budgeted round): ${preTagged.length} finding(s) folded in for this round to fix`)
    // Re-derive this round's scope now that the pre-last-round findings are in.
    toFix = findings.filter((f) => !isUnfixable(f) && !deferredKeys.has(findingKey(f)))
  }
  round++
  startPhase('Fix')
  log(`Fix round ${round}: ${toFix.length} finding(s)${deferredHeld.length ? `; ${deferredHeld.length} deferred earlier and held out of this round` : ''}`)

  // ---- FIX PLANNING (owner ruling 2026-09-03): Fable decides, executors implement ----
  // One Sonnet brief (excerpts + call sites, read-only), then ONE Fable decision over
  // every finding in the round: fix / dispute / defer, the design, the invariant, the
  // test, the executor tier and the waves. Fable opens no file and runs nothing, so
  // the brief is everything it knows. A dead brief still lets the planner run (it is
  // told the excerpts are missing); a dead planner AND a dead fallback drop the round
  // back to exactly the legacy routing, recorded as completed:false.
  const decisionOf = new Map()
  let plannerDisputed = []
  let deferredNow = []
  let execFindings = toFix
  let planAgents = 0
  let planEntry = null
  // PLANNING FLOOR: a round whose every finding is a synthetic key names phases, not
  // code — repair the build, restore a mutated file, strengthen a test. There is no
  // excerpt to brief, no file to route and no design to write: the content of each fix
  // is already determined by the phase that raised it. Spending a Sonnet brief and a
  // Fable decision there buys nothing, so the round runs on legacy routing and says so.
  const syntheticOnly = toFix.every((f) => !isRealPath(f.file))
  if (fixPlanningOn && syntheticOnly) {
    log(`Fix round ${round}: every finding is a synthetic key (${uniquePaths(toFix.map((f) => f.file)).join(', ')}) — no brief and no planner; the round runs on legacy routing`)
    planEntry = {
      round,
      completed: false,
      skipped: 'synthetic-only',
      briefCompleted: false,
      model: null,
      fallback: false,
      actions: { fix: 0, dispute: 0, defer: 0 },
      routes: { mechanical: 0, sonnet: 0, opus: 0 },
      waves: [],
      note: 'every finding named a phase, not a file — nothing for a planner to design',
    }
    fixPlanRounds.push(planEntry)
  } else if (fixPlanningOn) {
    planAgents++
    const brief = await askAgent(fixBriefPrompt(round, toFix), {
      label: `fix-brief:r${round}`, phase: 'Fix', model: CFG.fixBriefModel, effort: CFG.effort.fixBrief, schema: FIX_BRIEF_SCHEMA,
    })
    const briefItems = new Map()
    for (const it of brief && Array.isArray(brief.items) ? brief.items : []) {
      if (it && typeof it.index === 'number') briefItems.set(it.index, it)
    }
    if (!brief) log(`Fix round ${round}: the brief agent died — the planner is told it has no excerpts and decides conservatively`)
    let planner = CFG.fixPlannerModel
    let planEffort = CFG.effort.fixPlan
    let fallback = false
    planAgents++
    // FABLE BRIEF CAP: built once and reused verbatim on the fallback retry — it
    // is the same brief whichever model reads it.
    const planBrief = capFableBrief(fixPlanPrompt(round, toFix, briefItems, !!brief))
    if (planBrief.truncated) fixPlanBriefTruncated = true
    let plan = await askAgent(planBrief.text, {
      label: `fix-plan:r${round}`, phase: 'Fix', model: planner, effort: planEffort, schema: FIX_PLAN_SCHEMA,
    })
    // Fable's safety classifiers can decline a request outright (it surfaces as a
    // dead agent). One retry on the fallback decider, exactly as the final pass does.
    if (!plan && planner !== CFG.fixPlannerFallbackModel) {
      log(`Fix planner on ${planner} died or declined — retrying once on ${CFG.fixPlannerFallbackModel} at ${CFG.effort.fixPlanFallback}`)
      planner = CFG.fixPlannerFallbackModel
      planEffort = CFG.effort.fixPlanFallback
      fallback = true
      planAgents++
      plan = await askAgent(planBrief.text, {
        label: `fix-plan:r${round}:fallback`, phase: 'Fix', model: planner, effort: planEffort, schema: FIX_PLAN_SCHEMA,
      })
    }
    const actions = { fix: 0, dispute: 0, defer: 0 }
    const routes = { mechanical: 0, sonnet: 0, opus: 0 }
    if (plan) {
      for (const d of Array.isArray(plan.decisions) ? plan.decisions : []) {
        if (!d || typeof d.index !== 'number') continue
        const f = toFix[d.index]
        if (!f || decisionOf.has(f)) continue
        let action = d.action === 'dispute' || d.action === 'defer' ? d.action : 'fix'
        // ENGINE-ENFORCED: a finding the slate already upheld may not be disputed
        // again, and a synthetic key is not something the slate can judge — both
        // become ordinary fixes rather than a quiet way out of the loop.
        if (action === 'dispute' && (f.disputeUpheld || !isRealPath(f.file))) {
          log(`Fix round ${round}: the planner's dispute of "${f.summary}" was overridden — ${f.disputeUpheld ? 'the refuters already upheld it' : 'a synthetic key cannot be refuted'}; it is fixed instead`)
          action = 'fix'
        }
        decisionOf.set(f, { ...d, action, route: ROUTE_RANK[d.route] != null ? d.route : 'opus' })
        actions[action]++
      }
      // Silence never drops, defers or cheapens a finding: an unruled one is fixed,
      // on the deepest tier, from the reviewer's own hint.
      for (const f of toFix) {
        if (decisionOf.has(f)) continue
        decisionOf.set(f, { action: 'fix', design: '', invariant: '', tests: '', route: 'opus', reason: 'the planner returned no decision for this finding — fix it from the reviewer\'s hint' })
        actions.fix++
      }
      for (const f of toFix) {
        const d = decisionOf.get(f)
        if (d.action === 'fix') routes[d.route]++
      }
      plannerDisputed = toFix.filter((f) => decisionOf.get(f).action === 'dispute')
      deferredNow = toFix
        .filter((f) => decisionOf.get(f).action === 'defer')
        .map((f) => {
          deferredKeys.add(findingKey(f))
          const reason = decisionOf.get(f).reason || 'the fix planner deferred this finding: it needs a decision this run cannot make'
          deferredQuestions.push({ file: f.file, summary: f.summary, reason })
          return { ...f, deferred: reason }
        })
      execFindings = toFix.filter((f) => decisionOf.get(f).action === 'fix')
      // A2: Fable can mark a 'fix' decision `ruled: true` when it is confirming,
      // from evidence cited in the brief, a finding with no runnable check —
      // never a substitute for execution evidence when a check DOES exist.
      if (CFG.executionVerified) {
        for (const f of execFindings) {
          const d = decisionOf.get(f)
          if (d && d.ruled === true) verificationByKey.set(findingKey(f), { level: 'ruled' })
        }
      }
      log(`Fix plan r${round} (${planner}@${planEffort}${fallback ? ', fallback' : ''}): ${actions.fix} fix / ${actions.dispute} dispute / ${actions.defer} defer; routes ${routes.mechanical} mechanical / ${routes.sonnet} sonnet / ${routes.opus} opus`)
    } else {
      // Nobody ruled. The round is NOT skipped — it runs exactly as it did before
      // the planner existed, and the result says the plan never happened.
      decisionOf.clear()
      log(`!!! Fix round ${round}: both the planner and its fallback died — the round runs on legacy routing (mechanical vs judgment) and is recorded as unplanned`)
    }
    planEntry = {
      round,
      completed: !!plan,
      skipped: null,
      briefCompleted: !!brief,
      model: plan ? planner : null,
      fallback,
      actions,
      routes,
      waves: plan && Array.isArray(plan.waves) ? plan.waves : [],
      note: (plan && plan.note) || (plan ? '' : 'the planner and its fallback both declined — this round used legacy routing'),
      // FABLE BRIEF CAP (CFG.caps.fableBriefBytes): true if this round's planner
      // brief was over the byte cap and had to be truncated.
      briefTruncated: planBrief.truncated,
    }
    fixPlanRounds.push(planEntry)
  }
  const planned = !!(planEntry && planEntry.completed)

  // Fixers no longer run strictly sequentially. They are scheduled by the SAME
  // wave logic the implementers use: fixers on disjoint files run concurrently,
  // and the ones that can touch anything (a broken build, an unrestored mutation)
  // serialize after them. Each group is routed by the planner's tier for its
  // findings — or, unplanned, by complexity: mechanical fixes go to the cheap model,
  // judgment fixes and anything touching a HIGH-risk file stay on the review model.
  const fixReports = []
  const fixGroups = groupByFile(execFindings)
  const waveOfKey = planned ? plannerWaveOrder(toFix, execFindings, planEntry.waves) : null
  if (planned && !waveOfKey) {
    log(`Fix round ${round}: the planner's waves were unusable (an index missing, one named twice, or one file split across waves) — scheduling this round with the engine's own conflict-free waves`)
  }
  const scheduled = waveOfKey ? buildPlannedFixWaves(fixGroups, waveOfKey) : buildFixWaves(fixGroups)
  const fixWaves = scheduled.waves
  for (const issue of scheduled.issues) log(`!!! Fix scheduling: ${issue}`)
  for (const wave of fixWaves) {
    const waveOut = await runConcurrent(
      wave.map((p) => () => {
        const route = planned ? plannedGroupRoute(p.id, p.group, decisionOf) : fixRoute(p.id, p.group)
        const tier = executorTier(route)
        fixRouting[tier.counter]++
        const designs = planned
          ? p.group.map((f) => {
              const d = decisionOf.get(f)
              return d && d.action === 'fix' ? { design: d.design, invariant: d.invariant, tests: d.tests } : null
            })
          : null
        return askAgent(opusCapped(fixPrompt(p.id, p.group, route === 'mechanical' ? 'mechanical' : 'judgment', designs), tier.model), {
          label: `fix:${p.id}`,
          phase: 'Fix',
          model: tier.model,
          effort: tier.effort,
          schema: FIX_SCHEMA,
        }).then((r) => (r ? { target: p.id, route, ...r } : null))
      }),
    )
    fixReports.push(...waveOut.filter(Boolean))
  }
  fixReportsAll.push({ round, plan: planEntry, reports: fixReports })

  // Matching an executor's report back to the finding it is about. INDEX FIRST: the
  // executor was given its findings numbered, and an index cannot be paraphrased.
  // The summary match stays as the fallback for a report that omits one (a legacy
  // report, or an agent that ignored the field), and both are scoped to the group
  // that executor was actually handed — a fixer cannot speak for another one's file.
  const groupOfKey = new Map(fixGroups)
  function reportTargets(report, entry) {
    const group = groupOfKey.get(report.target) || []
    if (entry && typeof entry.index === 'number' && group[entry.index]) return [group[entry.index]]
    const ns = normSummary(entry && entry.summary)
    return ns ? group.filter((f) => normSummary(f.summary) === ns) : []
  }

  // DESIGN MISMATCH: an executor told to implement a design it could not fit reports
  // it instead of improvising. The finding is never dropped — it returns to the next
  // round carrying the executor's report, which the planner re-decides from.
  const mismatchOf = new Map()
  if (planned) {
    for (const r of fixReports) {
      for (const sk of Array.isArray(r.skipped) ? r.skipped : []) {
        const reason = String((sk && sk.reason) || '').trim()
        if (!/^design mismatch:/i.test(reason)) continue
        for (const f of reportTargets(r, sk)) if (!mismatchOf.has(f)) mismatchOf.set(f, reason)
      }
    }
  }
  const mismatched = execFindings.filter((f) => mismatchOf.has(f)).map((f) => ({ ...f, designMismatch: mismatchOf.get(f) }))
  if (mismatched.length) log(`Fix round ${round}: ${mismatched.length} finding(s) came back as "design mismatch" — the planner re-decides them next round with the executor's report`)

  // The re-check reads only what this round could have moved: the files the fixers
  // changed plus the locations the findings cite. It still reports a regression it
  // trips over in a file it had to open anyway.
  const recheckScope = uniquePaths([
    ...[].concat(...fixReports.map((r) => r.filesChanged || [])),
    ...execFindings.map((f) => f.file).filter(isRealPath),
  ])
  // REFUTE-FIRST DISPUTES: findings a fixer declined to fix with proof, plus the ones
  // the planner disputed before any fixer saw them. Neither is dropped on one agent's
  // word — the same adversarial slate judges them, beside the re-gate and the
  // re-check (all read-only). Dropped ⇒ gone; upheld ⇒ back into the loop marked
  // disputeUpheld, which neither the next planner nor the next fixer may dispute.
  const execDisputed = new Set()
  for (const r of fixReports) {
    for (const d of Array.isArray(r.disputed) ? r.disputed : []) {
      for (const f of reportTargets(r, d)) execDisputed.add(f)
    }
  }
  const disputed = plannerDisputed.concat(
    execFindings.filter((f) => isRealPath(f.file) && !f.disputeUpheld && execDisputed.has(f)),
  )
  if (disputed.length) log(`Fix round ${round}: ${disputed.length} finding(s) disputed (${plannerDisputed.length} by the planner, ${disputed.length - plannerDisputed.length} by their fixer) — the adversarial slate judges them before anything is dropped`)
  // Re-check: re-run the gate, verify the fixes landed, and judge the disputes, concurrently.
  const recheckModel = recheckModelFor()
  const recheck = await parallel([
    () =>
      vc.perRound.length
        ? askAgent(gatePrompt(vc.perRound), { label: `regate:r${round}`, phase: 'Fix', model: CFG.gateModel, effort: CFG.effort.gate, schema: GATE_SCHEMA })
        : Promise.resolve({ pass: true, results: [], skipped: true }),
    () => askAgent(opusCapped(recheckPrompt(execFindings, fixReports, recheckScope, {
      disputed: plannerDisputed.map((f) => `${f.file}: ${f.summary}`),
      deferred: deferredNow.map((f) => `${f.file}: ${f.summary}`),
    }), recheckModel), { label: `recheck:r${round}`, phase: 'Fix', model: recheckModel, effort: CFG.effort.recheck, schema: FINDINGS_SCHEMA }),
    () => judgeFindings(disputed, 'Fix'),
  ])
  const regate = enforceCwd(recheck[0], `regate:r${round}`) || { pass: false, results: [] }
  finalGate = { pass: regate.pass, skipped: !!regate.skipped, results: regate.results || [], cwdMismatch: regate.cwdMismatch }
  // A2: an executor's self-reported verifiedFixes entry (a named test, red on
  // the original tree, green on the patched one) is evidence ONLY when this
  // round's INDEPENDENT re-gate also came back green — self-report alone is
  // never enough. 'execution' wins over 'ruled' when both somehow apply.
  if (CFG.executionVerified && regate.pass) {
    for (const r of fixReports) {
      for (const v of Array.isArray(r.verifiedFixes) ? r.verifiedFixes : []) {
        if (!v || !v.test || !v.redOn || !v.greenOn) continue
        for (const f of reportTargets(r, v)) {
          verificationByKey.set(findingKey(f), { level: 'execution', verifiedBy: { test: v.test, redOn: v.redOn, greenOn: v.greenOn } })
        }
      }
    }
  }
  // If the re-check agent died, carry the findings over — never assume clean. What
  // it carries is what a fixer actually touched: deferred and disputed findings are
  // put back by their own paths below, and duplicating them here would double-count.
  const rechecked = recheck[1] ? dedupe(recheck[1].findings || []) : execFindings
  // A dead slate keeps every dispute (conservative), exactly like a dead refuter.
  const dj = recheck[2] || { kept: disputed, dropped: [], agents: 0, votesCast: 0, firstRefuted: 0, tieBreaks: 0 }
  const droppedKeys = new Set(dj.dropped.map(findingKey))
  const upheld = dj.kept.map((f) => ({ ...f, disputeUpheld: true }))
  verifyStats.disputed += disputed.length
  verifyStats.disputesDropped += dj.dropped.length
  verifyStats.disputesUpheld += upheld.length
  verifyStats.votesCast += dj.votesCast
  verifyStats.tieBreaks += dj.tieBreaks
  // FABLE BRIEF CAP: fold in any tie-break brief truncated here or in Verify.
  verifyStats.briefTruncated = verifyStats.briefTruncated || tieBreakBriefTruncated
  if (disputed.length) {
    log(`Disputes: ${dj.dropped.length} refuted and dropped, ${upheld.length} upheld and sent back to the fix loop (${dj.votesCast} vote(s), ${dj.tieBreaks} tie-break(s))`)
  }
  const fixNotes = []
  if (fixPlanningOn) {
    fixNotes.push(planned
      ? 'Fable-planned fixes (Sonnet brief -> Fable plan -> executors implementing the design)'
      : planEntry && planEntry.skipped === 'synthetic-only'
        ? 'Fable-planned fixes skipped for a round of synthetic keys only — legacy routing'
        : 'Fable-planned fixes attempted, but the planner and its fallback declined — this round used legacy routing')
  }
  if (disputed.length) fixNotes.push('includes the adversarial slate on disputed findings')
  if (fixNotes.length) phaseStats.Fix.note = fixNotes.join('; ')
  // Deferred findings ride through the round untouched, carrying the planner's
  // reason: nothing fixed them, and nothing may quietly drop them either.
  findings = [...unfixable, ...deferredHeld, ...deferredNow, ...rechecked].filter((f) => !droppedKeys.has(findingKey(f)))
  // Upheld disputes come back whatever the re-check said about them (it was told
  // to leave them out), and carry the mark the next fixer must honour.
  for (const u of upheld) {
    const k = findingKey(u)
    if (findings.some((f) => findingKey(f) === k)) findings = findings.map((f) => (findingKey(f) === k ? { ...f, disputeUpheld: true } : f))
    else findings.push(u)
  }
  // A design that did not fit the code returns whatever the re-check said, carrying
  // the executor's report so the next plan is re-decided from it, not repeated.
  for (const m of mismatched) {
    const k = findingKey(m)
    if (findings.some((f) => findingKey(f) === k)) findings = findings.map((f) => (findingKey(f) === k ? { ...f, designMismatch: m.designMismatch } : f))
    else findings.push(m)
  }
  // Same baseline filter as the initial gate: a command broken before this run
  // started must not be re-raised as a blocker every round, which would burn both
  // fix rounds on a command the fix loop is explicitly told not to "fix".
  const regateIssue = gateProblem(regate)
  if (regateIssue) {
    findings.push({ file: '(gate)', severity: 'blocker', phase: 'Fix', summary: 'Verification gate still failing after fixes', detail: regateIssue })
  }
  // Re-dedupe every round: a carried-over finding plus a fresh synthetic '(gate)'
  // entry would otherwise stack up once per round and overstate how many distinct
  // problems remain in the list the orchestrator surfaces.
  findings = dedupe(findings)
  log(`After round ${round}: ${findings.length} finding(s) remain (${fixGroups.length} fixer(s) in ${fixWaves.length} wave(s)${waveOfKey ? ', scheduled from the plan' : ''}; routing so far: ${fixRouting.mechanical} mechanical / ${fixRouting.sonnetDesigned} sonnet-designed / ${fixRouting.judgment} judgment)`)
  // The brief and the planner, one fixer per file group, the regate, the recheck,
  // and the dispute slate. Rounds accumulate.
  await endPhase('Fix', planAgents + fixGroups.length + 2 + dj.agents, regateIssue ? 1 : 0)
}

// ═══════════ UI re-verify — a UI fix is only proven in a browser ═══════════
// The fix loop checks its own work by READING SOURCE (recheckPrompt), which cannot
// show whether a rendered surface is actually fixed: a fixer adds a focus-ring class,
// the re-check reads the class, and nothing ever re-renders the page. So whenever any
// fixing happened after a UI pass, drive the real UI once more. This runs BEFORE the
// final full gate, so any spec the agent writes is covered by that gate.
if (uiCfg && round > 0) {
  startPhase('UI verify')
  const priorUi = uiVerifyResult.findings || []
  log(`UI re-verify after ${round} fix round(s): re-driving ${(uiCfg.flows || []).length || 1} flow(s) at ${(uiVerifyResult.viewports || ['desktop']).join(', ')}`)
  const re = await uiDriveAndJudge(priorUi)
  const reReport = re.evidence ? { findings: re.findings } : null
  const reFindings = re.findings.map((f) => ({ ...f, source: 'ui-verify', phase: 'UI verify' }))
  uiVerifyResult = { ...uiVerifyResult, reVerify: { completed: re.completed, evidence: re.evidence, findings: reFindings } }
  if (reReport) {
    // A completed re-verification IS the browser evidence a dead first pass lacked,
    // over the same flows and viewports — so its blocker is answered. Everything the
    // re-run still sees is pushed below and keeps `clean` false.
    findings = findings.filter((f) => f.file !== '(ui-verify)')
    findings.push(...reFindings)
    log(`UI re-verify: ${reFindings.length} finding(s) still visible in the running UI`)
  } else {
    findings.push({
      file: '(ui-verify)',
      severity: 'blocker',
      phase: 'UI verify',
      summary: 'UI re-verification did not complete — the UI fixes were never seen rendered',
      detail: 'Fixes were applied to findings that came from driving the real UI, but the re-verification agent died or was skipped, so no browser evidence exists that they worked. Source review cannot substitute. Re-run this phase or drive the flows manually, and check that no dev server or browser was left running.',
    })
    log(`UI re-verify: agent died — recorded as a blocker`)
  }
  findings = dedupe(findings)
  await endPhase('UI verify', re.agents, reReport ? reFindings.length : 1)
}

// ═══════════ Final authoritative gate (tiered mode only) ═══════════
// When perRound is a cheap subset, the FULL command set must still decide the
// result exactly once — after the last fix round, whatever its outcome.
const tiered = JSON.stringify(vc.final) !== JSON.stringify(vc.perRound)
const wantFullGate = tiered && vc.final.length > 0
// Returns { add, agents, raw }; sets finalGate. Runs alone or beside the final pass.
async function runFinalGate() {
  const fullGate = enforceCwd(await askAgent(gatePrompt(vc.final), {
    label: 'final-gate', phase: 'Fix', model: CFG.gateModel, effort: CFG.effort.gate, schema: GATE_SCHEMA,
  }), 'final-gate')
  const fg = fullGate || { pass: false, results: [], summaryError: 'final gate agent died' }
  finalGate = { pass: fg.pass, skipped: false, results: fg.results || [], cwdMismatch: fg.cwdMismatch }
  const fgIssue = gateProblem(fg)
  log(`Final full gate ${fgIssue ? 'FAILED' : 'passed'}${!fgIssue && fg.pass !== true ? ' (its only failures were commands already broken at baseline)' : ''}`)
  return {
    add: fgIssue ? [{ file: '(gate)', severity: 'blocker', phase: 'Fix', summary: 'FULL verification gate failed after fix rounds', detail: fgIssue }] : [],
    agents: 1,
    raw: fgIssue ? 1 : 0,
  }
}

// One dedupe before the last read so `known` never overstates what the run found.
findings = dedupe(findings)

// finalPassResult / finalPassPlan() / fpPlan now live BEFORE the fix loop (P5,
// owner ruling 2026-09-11e) — see the comment there. Everything below still
// reads the same `fpPlan` const; nothing here changed.
// THE PACKAGER (Sonnet): one digest with the complete diff hunks of the files the
// final pass will read plus the call sites of every changed export — so the
// strongest model spends its effort judging, not gathering.
function finalPassPackagePrompt(files, whole) {
  return [
    RUN_PREFIX(),
    `You are the final-pass PACKAGER — mechanical and read-only. Build ONE markdown digest that lets a reviewer judge ${whole ? 'the whole change' : 'the HIGH-risk part of this change'} without running git or hunting for call sites.`,
    `Files: ${whole ? 'every changed or untracked file (`git status --short`)' : files.join(', ')}.`,
    `Digest contents, in this order: (1) for each file, its COMPLETE current diff (\`git diff HEAD -- <file>\`, unified with function context; an untracked file is included whole) — never summarize or elide a hunk; (2) for every exported function, method, class or constant whose signature or body changed, one line per call site across the repo (\`grep -rn\` over apps/ and packages/, excluding node_modules, dist and .next): path:line and the calling expression; (3) a short list of any file you could not diff (binary, too large) so the reader knows the gap.`,
    `Write the digest to the OS temp directory (Git Bash: "$TMPDIR" when set, else /tmp; a Windows shell: %TEMP%) under a unique name such as "final-pass-digest-<short>.md" and return its ABSOLUTE path. Do not modify, create or delete anything inside the repository; do not run builds or tests; do not judge anything.`,
  ].filter(Boolean).join('\n')
}

// THE READER (Opus, xhigh): the adversarial read itself. Produces CANDIDATES with
// evidence; it does not have the last word.
function finalPassReadPrompt(files, known, whole, digest, focus) {
  return [
    RUN_PREFIX(),
    `You are the FINAL adversarial reader over a finished, already-reviewed change. Six lenses, refuters, a mutation probe and fix rounds have run; your job is to find what they ALL missed and hand each suspicion, with its evidence, to a decider who rules on it.`,
    focus && focus.length
      ? `FOCUSED RE-READ. The decider judged the first read's coverage thin exactly here — read these and only these, at full depth:\n${focus.map((g) => `- ${g}`).join('\n')}`
      : `Look for: any defect a hostile reviewer would raise on the whole diff that file-scoped review structurally misses — cross-file invariants no single-file lens could see; spec requirements satisfied literally but violated in spirit; money/tenancy/authorization edges in the interaction BETWEEN packages; sibling paths that reach the same state and were never enrolled in the new rule; multi-step state paths that compose into a forbidden state.`,
    digest && digest.digestPath
      ? `Read the planning artifacts (spec, test plan, build plan), then the DIGEST at "${digest.digestPath}": it holds the complete diff hunks of ${whole ? 'every changed file' : `the HIGH-risk files (${files.join(', ')})`} plus the call sites of every changed export${digest.note ? ` — gaps the packager reported: ${digest.note}` : ''}. Work from the digest; open a source file only to confirm a specific suspicion it raises. Do not re-derive the diff with git — that work is done.`
      : `Read the planning artifacts (spec, test plan, build plan) and then the FINAL state and diff of ${whole ? 'every changed file — run `git status --short` and `git diff` / `git diff HEAD` yourself' : `exactly these HIGH-risk files (run \`git diff\` / \`git diff HEAD\` yourself, scoped to them; read surrounding context in the files as needed): ${files.join(', ')}`}.`,
    `Already known to this run — do not re-report these or variants of them:\n${known || '(none)'}`,
    `Report every suspicion you can state as a concrete failure scenario, with the evidence in detail (the lines, the callers, the state path) — the decider rules only from what you write down, so an under-evidenced candidate is a lost candidate. Never style or taste. An empty list means you found nothing after genuine effort; say in the last candidate's place nothing — the decider judges coverage separately.`,
    FIX_COMPLEXITY_NOTE,
  ].filter(Boolean).join('\n')
}

// THE DECIDER (Fable, high): rules from a compact brief. No files, no commands.
function finalPassDecidePrompt(brief) {
  return [
    `You are the FINAL decider on a finished code change. You decide; you do not read the repository, run commands or gather anything — everything you may rule on is below. Where the evidence does not settle a candidate, keep it (real=true) — a fixer re-verifies before touching code, and a dropped real defect ships.`,
    `Change: ${brief.change}`,
    `Scope read: ${brief.scope}`,
    `The run's own oracles: ${brief.oracles}`,
    `Findings already confirmed and fixed or still open (do not re-raise): \n${brief.known || '(none)'}`,
    brief.pass === 2 ? `This is the SECOND read, focused on the gaps you named: ${brief.focus.join(' | ')}. Rule on the new candidates and do not name further gaps — the run ends here.` : '',
    `Candidates from the reader:\n${brief.candidates.length ? brief.candidates.map((c, i) => `[#${i}] [${c.severity}] ${c.file}${c.line ? ':' + c.line : ''} — ${c.summary}\n    evidence: ${String(c.detail || '').slice(0, 900)}`).join('\n') : '(none — the reader reported nothing)'}`,
    `Rule on each candidate: real or not, with the severity it deserves and one or two sentences of reason drawn from its evidence. Then judge COVERAGE: given the change, the files read and what the run already caught, name the specific interactions the reader should have covered and did not (a caller left unread, a sibling path to the same state, a multi-step sequence) — or an empty list if the read was sufficient. Be selective: each gap costs one more full read. State the decision in one paragraph for the close-out.`,
  ].filter(Boolean).join('\n')
}
// Returns { add, agents, raw }; sets finalPassResult. Three roles: the Sonnet
// packager gathers, the Opus reader reads and produces candidates with evidence,
// and Fable decides from a brief — real or not, severity, and where one focused
// re-read is owed. Fable's classifiers can decline outright (a dead decider); the
// decision is then retried once on the fallback model, because candidates nobody
// ruled on are kept, never dropped — an unadjudicated pass is not a clean one.
async function runFinalPass(origin = 'terminal') {
  // Snapshot-before-overwrite: capture whatever the previous invocation left
  // in finalPassResult before this call makes its own assignment, so a
  // pre-last-round call's detail survives once the terminal call overwrites
  // finalPassResult. No-op on the first call of a run (finalPassResult.ran
  // starts false).
  if (finalPassResult.ran) finalPassRuns.push({ ...finalPassResult })
  const known = [...confirmedInitial, ...findings]
    .map((f) => `- [${f.severity || '?'}] ${f.file}: ${f.summary}`)
    .join('\n')
  const scopeText = fpPlan.whole ? 'the whole diff' : `${fpPlan.files.length} HIGH-risk file(s): ${fpPlan.files.join(', ')}`
  let agents = 0
  // 1. PACKAGE (Sonnet, low). A dead packager just means the reader gathers itself.
  agents++
  const digest = await askAgent(finalPassPackagePrompt(fpPlan.files, fpPlan.whole), {
    label: 'final-pass:package', phase: 'Final pass', model: CFG.finalPassPackagerModel, effort: CFG.effort.finalPassPackage, schema: DIGEST_SCHEMA,
  })
  if (digest && digest.digestPath) log(`Final pass digest: ${digest.files} file(s), ${digest.hunks} hunk(s) at ${digest.digestPath}${digest.note ? ` — ${digest.note}` : ''}`)
  else log('Final pass digest: packager died — the reader gathers the diff itself')
  // 2. READ (Opus, xhigh) → candidates.
  const read = async (focus, tag) => {
    agents++
    const r = await askAgent(opusCapped(finalPassReadPrompt(fpPlan.files, known, fpPlan.whole, digest, focus), CFG.finalPassReaderModel), {
      label: `final-pass:read${tag}`, phase: 'Final pass', model: CFG.finalPassReaderModel, effort: CFG.effort.finalPassRead, schema: FINDINGS_SCHEMA,
    })
    return r && Array.isArray(r.findings) ? r.findings : null
  }
  // 3. DECIDE (Fable, high; Opus xhigh if Fable declines) from a brief.
  // The same line the fix planner was given every round — one statement of what this
  // run has proven, never two slightly different ones.
  const oracles = runOracles()
  let decider = CFG.finalPassModel
  let effort = CFG.effort.finalPass
  let fallback = false
  const decide = async (candidates, pass, focus) => {
    const brief = { change: context || `see ${planPath}`, scope: scopeText, oracles, known, candidates, pass, focus }
    agents++
    // FABLE BRIEF CAP: built once and reused verbatim on the fallback retry.
    const decideBrief = capFableBrief(finalPassDecidePrompt(brief))
    if (decideBrief.truncated) finalPassBriefTruncated = true
    let d = await askAgent(decideBrief.text, { label: `final-pass:decide${pass === 2 ? ':2' : ''}`, phase: 'Final pass', model: decider, effort, schema: DECISION_SCHEMA })
    if (!d && decider !== CFG.finalPassFallbackModel) {
      log(`Final pass decider on ${decider} died or declined — retrying once on ${CFG.finalPassFallbackModel} at ${CFG.effort.finalPassFallback}`)
      decider = CFG.finalPassFallbackModel
      effort = CFG.effort.finalPassFallback
      fallback = true
      agents++
      d = await askAgent(decideBrief.text, { label: `final-pass:decide${pass === 2 ? ':2' : ''}:fallback`, phase: 'Final pass', model: decider, effort, schema: DECISION_SCHEMA })
    }
    return d
  }
  const apply = (candidates, decision) => {
    // No decision = every candidate stands, unadjudicated. Never clean by default.
    if (!decision) return candidates.map((c) => ({ ...c, phase: 'Final pass', unadjudicated: true }))
    const byIndex = new Map((decision.verdicts || []).map((v) => [v.index, v]))
    return candidates
      .map((c, i) => ({ c, v: byIndex.get(i) }))
      .filter(({ v }) => !v || v.real === true)
      .map(({ c, v }) => ({ ...c, phase: 'Final pass', severity: (v && v.severity) || c.severity, decision: v ? v.reason : 'no verdict returned for this candidate — kept', unadjudicated: !v }))
  }

  const first = await read(null, '')
  if (!first) {
    // A dead reader is an UNREAD pass, not a clean one.
    finalPassResult = { ran: true, completed: false, skipped: null, reader: CFG.finalPassReaderModel, model: null, effort: null, fallback: false, files: fpPlan.files, candidates: 0, gaps: [], secondRead: false, decision: '', findings: [], briefTruncated: finalPassBriefTruncated, origin }
    log('Final pass reader died — raised a major finding; the pass is unread, not clean')
    return {
      add: [{ file: '(final-pass)', severity: 'major', phase: 'Final pass', summary: 'The final-pass reader died — the HIGH-risk diff was never given its last adversarial read', detail: `Re-run the final pass over: ${scopeText}`, fixComplexity: 'judgment' }],
      agents, raw: 0,
    }
  }
  let decision = await decide(first, 1, [])
  let out = apply(first, decision)
  let gaps = decision && Array.isArray(decision.gaps) ? decision.gaps.filter(Boolean).slice(0, 6) : []
  let secondRead = false
  let candidates = first.length
  if (gaps.length) {
    log(`Final pass decider named ${gaps.length} coverage gap(s) — one focused re-read: ${gaps.join(' | ')}`)
    const second = await read(gaps, ':2')
    secondRead = true
    if (second) {
      candidates += second.length
      const decision2 = await decide(second, 2, gaps)
      out = out.concat(apply(second, decision2))
      if (decision2 && decision2.note) decision = { ...decision, note: `${decision.note || ''}\nSecond read: ${decision2.note}` }
    } else {
      out.push({ file: '(final-pass)', severity: 'major', phase: 'Final pass', summary: 'The focused second read died — the coverage gaps the decider named were never read', detail: gaps.join(' | '), fixComplexity: 'judgment' })
    }
  }
  const unadjudicated = out.filter((f) => f.unadjudicated).length
  if (unadjudicated) out.push({ file: '(final-pass)', severity: 'major', phase: 'Final pass', summary: `${unadjudicated} final-pass candidate(s) were never ruled on — kept as findings, the pass is unadjudicated`, detail: 'The decider died on Fable and the fallback model, or returned no verdict for these indices.', fixComplexity: 'judgment' })
  finalPassResult = {
    ran: true, completed: !!decision, skipped: null,
    reader: CFG.finalPassReaderModel, model: decider, effort, fallback,
    files: fpPlan.files, candidates, gaps, secondRead, decision: decision ? decision.note || '' : '',
    findings: out,
    briefTruncated: finalPassBriefTruncated,
    origin,
  }
  log(`Final pass: ${CFG.finalPassReaderModel}@${CFG.effort.finalPassRead} read ${scopeText}${secondRead ? ' (+1 focused re-read)' : ''}, ${candidates} candidate(s); ${decider}@${effort}${fallback ? ' (fallback)' : ''} decided: ${out.length} finding(s) stand`)
  return { add: out, agents, raw: out.length }
}

if (wantFullGate && fpPlan.run) {
  // The full gate runs commands; the final pass reads. Nothing they touch overlaps,
  // so they share one bracket — the Final pass's, which therefore also carries the
  // (Haiku-priced, small) gate agent. Recorded in overlapInfo and the phase note.
  startPhase('Final pass')
  overlapInfo.finalGateWithFinalPass = true
  const [g, fp] = await parallel([runFinalGate, runFinalPass])
  if (g) findings.push(...g.add)
  else { finalGate = { pass: false, skipped: false, results: [] }; findings.push({ file: '(gate)', severity: 'blocker', phase: 'Fix', summary: 'FULL verification gate did not run after fix rounds', detail: 'The final gate threw while running beside the final pass — no full-suite evidence exists.' }) }
  if (fp) findings.push(...fp.add)
  else { finalPassResult = { ...finalPassResult, ran: true, completed: false }; findings.push({ file: '(final-pass)', severity: 'major', phase: 'Final pass', summary: 'The final-pass agent threw — the HIGH-risk diff was never given its last adversarial read', detail: `Re-run the final pass over: ${fpPlan.whole ? 'the whole diff' : fpPlan.files.join(', ')}`, fixComplexity: 'judgment' }) }
  phaseStats['Final pass'].note = 'includes the final full gate (Haiku), which ran beside the final pass'
  await endPhase('Final pass', (fp ? fp.agents : 1) + 1, fp ? fp.raw : 0)
} else {
  if (wantFullGate) {
    startPhase('Fix')
    const g = await runFinalGate()
    findings.push(...g.add)
    await endPhase('Fix', g.agents, g.raw)
  }
  if (fpPlan.run) {
    startPhase('Final pass')
    const fp = await runFinalPass()
    findings.push(...fp.add)
    await endPhase('Final pass', fp.agents, fp.raw)
  } else if (scale === 'major') {
    finalPassResult = { ...finalPassResult, ran: false, completed: false, skipped: fpPlan.skipped }
    phaseStats['Final pass'].note = `skipped: ${fpPlan.skipped}`
    log(`Final pass SKIPPED — ${fpPlan.skipped} (CFG.finalPassWhenNoHighRisk = '${CFG.finalPassWhenNoHighRisk}'); recorded, not silently omitted`)
  }
}
// One last dedupe so remainingFindings never overstates how many distinct
// problems are left — that list is what the orchestrator shows the user.
findings = dedupe(findings)

// ═══════════ Result (read by the orchestrating session) ═══════════
// `clean` is deliberately conservative: a remaining finding, a failed gate, a dead
// lens, a red gate that never went red, a mutation target left unrestored, a mutation
// the named test failed to catch, a restore no independent checksum could confirm, or
// a work/test package that never reached "done" all mean the run is NOT clean,
// whatever else went well.
// Through the baseline filter, not the raw flag: a command that already failed on
// the untouched tree can never make `clean` false. gateProblem() still rejects a
// dead gate agent and a pass:false that named no failing command, so an UNVERIFIED
// gate is not a passing one. finalGate carries `results`, which that filter needs.
const gateOk = gateProblem(finalGate) === null
// Under the 'structural' bar a behavioral shortfall is proven (or not) by the
// mutation probe, whose allCaught is a separate conjunct below; under the
// 'behavioral' bar (small scale) the red gate itself must be properly red.
const redOk = !redGateResult.ran || (redGateResult.remediateOn === 'structural' ? redGateResult.structurallyRed === true : redGateResult.properlyRed === true)
// allCaught is folded in exactly the way properlyRed is: both are one-shot test-quality
// oracles that are never re-run, so a later fix round clearing their '(mutation)' /
// '(red-gate)' finding is NOT evidence the test now catches the defect. Without this,
// a run could return clean:true beside mutationProbe.allCaught:false.
const mutationOk = mutationResult.allRestored === true && mutationResult.allCaught === true
// The probes' self-report is not evidence. A skipped mutation phase is neutral; a
// phase that ran without independent before/after checksum agreement is NOT — an
// unverified restore may have left a deliberate defect in the tree.
const restoredVerifiedOk = !mutationResult.ran || mutationResult.restoredVerified === true
// Package status is a PHASE RESULT, not an opinion, so the verdict reads it
// directly — exactly as redOk/mutationOk do. Its '(implementation)' / '(tests)'
// finding goes through the fix loop, where a fixer that cannot finish the package
// skips it with a reason and the re-check is told to drop what was skipped with a
// sound reason; without these conjuncts a blocked package can end the run as clean.
const implOk = implResults.every((r) => r && r.status === 'done')
const testsOk = testAuthoring.packages.every((p) => p && p.status === 'done')
if (!implOk || !testsOk) {
  log(`!!! NOT clean: ${implResults.filter((r) => !r || r.status !== 'done').length} work package(s) and ${testAuthoring.packages.filter((p) => !p || p.status !== 'done').length} test package(s) never reached status "done" — see implementation[] / testAuthoring.packages[]`)
}

// ---------- self-instrumentation ----------
// What each phase cost and what it produced, in phase order. Report this at
// close-out and cut any phase that has produced no CONFIRMED finding across ten
// real runs. `tokens: null` means the reading was unavailable — an unknown cost
// must never read as a free one, so it is never reported as 0.
// buildPhaseRow is the SAME function each per-phase C1 checkpoint used, so this
// final report can never disagree with what the phase cards already wrote.
const phaseReport = PHASE_TITLES.map(buildPhaseRow)
const estimatedCostUsd = Math.round(phaseReport.reduce((n, r) => n + (r.estUsd || 0), 0) * 100) / 100
// A2 EXECUTION-VERIFIED CONFIRMED: resolve every survivor's verification level
// from verificationByKey (filled in by the fix loop above). A SYNTHETIC-key
// finding — '(red-gate)', '(mutation)', '(gate)', '(gate-command)', '(artifact)',
// '(implementation)', '(tests)' — is already a mechanically observed fact (a
// command failed, a digest mismatched), never a lens's opinion, so it is
// 'execution' from the moment it is raised, same as before A2 existed. Only a
// REAL-FILE finding (a lens's claim about actual code) starts 'plausible' and
// needs the fix loop's before/after evidence or a Fable ruling to be promoted.
// With the flag off, everything counts exactly as it always did and
// plausibleFindings is empty — byte-identical to pre-A2 behaviour.
for (const f of confirmedInitial) {
  const v = verificationByKey.get(findingKey(f))
  f.verification = !isRealPath(f.file) ? 'execution' : (v ? v.level : 'plausible')
  if (v && v.verifiedBy) f.verifiedBy = v.verifiedBy
}
const plausibleFindings = CFG.executionVerified ? confirmedInitial.filter((f) => f.verification === 'plausible') : []
const verifiedConfirmed = CFG.executionVerified ? confirmedInitial.filter((f) => f.verification !== 'plausible') : confirmedInitial
// How many of each phase's RAW findings SURVIVED refutation (and the fact/evidence
// findings, which are never refutable). rawFindings high + confirmed 0, run after
// run, is a phase paying only for noise. Counts execution/ruled findings only
// (A2) — a plausible one that nothing ever verified is not "confirmed".
const confirmedByPhase = {}
for (const t of PHASE_TITLES) confirmedByPhase[t] = 0
for (const f of verifiedConfirmed) {
  const p = f && f.phase
  if (p && Object.prototype.hasOwnProperty.call(confirmedByPhase, p)) confirmedByPhase[p]++
}

// Which lenses actually ran: the full set in feature mode, minus anything bugfix mode
// gated off and anything the density escalation skipped. It is the honest answer to
// "which dimensions was this change reviewed on".
const lensesRun = lenses.filter((l) => escalation.lensesSkipped.indexOf(l) === -1)

// C2 (owner ruling 2026-09-11c, engine wave 3C, "A7"): built AFTER confirmedInitial's
// findings carry their final .verification, so executionConfirmed/ruled/plausible
// below are accurate. See buildLensReport()'s definition for what a merged
// small-scale unit's row means.
const lensReport = buildLensReport()

// C1: hoisted into a variable (not returned directly) so the final checkpoint
// below can read it before it goes back to the orchestrator. checkpointLog is
// the SAME array every runCheckpoint() call pushed onto, so the final entry
// pushed after this object is built still shows up in resultObj.checkpoints —
// no re-assignment needed.
const resultObj = {
  plan: planPath,
  // 'feature' (the default) or 'bugfix' — which preset of this one engine ran.
  mode: MODE,
  artifacts: {
    plan: planPath,
    discovery: discoveryPath,
    spec: specPath,
    uxSpec: uxSpecPath,
    testPlan: testPlanPath,
    designSystem: designSystemPath,
  },
  scale,
  // Echoed from args for the ledger (scripts cannot read the clock); the
  // orchestrator stamps the end time when the result returns.
  startedAt: startedAt || null,
  // Output-only cost estimate at CFG.prices (labelled with its date) — the number
  // the ledger tracks run over run. Unknown phases contribute nothing, and say so
  // in their own row (tokens: null).
  estimatedCostUsd,
  pricesAsOf: CFG.prices.asOf,
  // What each wall-clock overlap did this run.
  overlap: overlapInfo,
  // Refutation economics: how many votes were actually cast, how often the first
  // refuter voted to discard (what the lazy slate keys on), and the tie-breaks.
  verify: verifyStats,
  // The tree BEFORE any agent wrote anything: which verify commands were already
  // broken (excluded from the verdict), whether the baseline gate and the artifact
  // grounding agents actually completed (completed:false means unchecked, which a
  // zero finding count cannot tell you), and the honest note that the baseline is
  // whatever state the caller left the tree in.
  baseline: baselineResult,
  // Preflight facts every later agent was given, and the risk split that set review
  // depth, fix routing and which mutation targets were probed.
  manifest: manifestResult,
  riskSummary,
  // Where fix tokens went. mechanical = the cheap fixer; sonnetDesigned = a
  // Fable-designed change on a LOW-risk file; judgment = the review model.
  fixRouting,
  // The Fable fix planner, per round. enabled:false = the flag (or args.fixPlanning)
  // turned it off and the loop routed exactly as it did before the planner existed.
  // A round with completed:false is one where Fable AND the fallback declined: it
  // ran on legacy routing, and its findings were fixed without a design.
  // `deferred` is the owner's queue: every question the planner could not answer,
  // each one still open in remainingFindings and each one keeping `clean` false.
  fixPlanning: { enabled: fixPlanningOn, rounds: fixPlanRounds, deferred: deferredQuestions, briefTruncated: fixPlanBriefTruncated },
  // MEASURED TRADES. Both null when their flag is off — a null here means the trade
  // was not taken, never that it was taken and found harmless.
  // cascadeAudit.missedFindings > 0 means the cheap breadth pass let real defects
  // through: that number is the argument against ever enabling cascadeReview.
  cascadeAudit,
  // escalation.lensesSkipped names every dimension that was NOT reviewed.
  escalation: CFG.densityEscalation ? escalation : null,
  // The dimensions this change was actually reviewed on.
  lensesRun,
  // C2: one row per lens name that ran — rawFindings/corroborated/executionConfirmed/
  // ruled/plausible/overturned, computed from lensRawFindings + corroborationOf +
  // confirmedInitial's final .verification + dropReasonByKey. Read by
  // model-routing/scripts/pipeline-ledger.mjs's extractLenses().
  lensReport,
  // ── BUGFIX-MODE STAGES. Each one records whether it RAN, because "no issues" and
  // "never looked" must never read the same way.
  // radiusPack.built:false = the review lenses read the change themselves, exactly as
  // in feature mode (no pack, or one that came back truncated).
  radiusPack,
  // siblingSweep: the same defect's shape, hunted across the repo. skipped names why
  // when it did not run ('no-patterns' | 'feature-mode' | 'grep-died' | 'judge-died').
  siblingSweep,
  // harnessCheck: the existing specs' mocks/fixtures against the plan's service-surface
  // changes, checked BEFORE the tests were written. Never blocks; ran:false = unchecked.
  harnessCheck,
  testAuthoring,
  redGate: redGateResult,
  implementation: implSummaries,
  gate: finalGate, // the LAST gate run (initial gate, or the latest fix-round regate)
  buildFix: buildFixReport, // the one pre-review repair round, null when the gate was green
  uiVerify: uiVerifyResult,
  mutationProbe: mutationResult,
  // The Fable last read over the HIGH-risk diff (major only). ran:false with
  // `skipped` naming why ('small-scale' | 'no-high-risk-files'); completed:false =
  // the agent died on the primary AND the fallback model and a '(final-pass)'
  // finding keeps the run dirty; `model`/`effort`/`fallback` say which model
  // actually read. Its findings are already folded into remainingFindings.
  finalPass: { ...finalPassResult, priorPasses: finalPassRuns },
  // A2: execution/ruled survivors only; a merely 'plausible' one lives in
  // plausibleFindings instead — see CFG.executionVerified.
  confirmedFindings: verifiedConfirmed,
  plausibleFindings,
  confirmedByPhase,
  phaseReport, // report at close-out; cut a phase with no confirmed finding in ten runs
  fixRounds: round,
  fixReports: fixReportsAll,
  remainingFindings: findings, // non-empty = NOT clean; orchestrator must surface these
  clean: findings.length === 0 && gateOk && !lensDied && redOk && mutationOk && restoredVerifiedOk && implOk && testsOk,
  // C1: every checkpoint attempt this run made (per-phase + the final one below).
  // Same array reference as checkpointLog, so the entry runFinalCheckpoint() adds
  // AFTER this object exists still appears here — see the comment above.
  checkpoints: checkpointLog,
  // A6: every test the gate's flaky-rerun quarantined this run — excluded from
  // the red-bar/fix trigger, and never counted as green either. Empty when
  // CFG.flakyReruns is 0 or no gate failure ever named specific failedTests.
  quarantined: quarantinedLog,
  // E1: commands whose flaky quarantine was abandoned for lack of evidence (a
  // dead/malformed rerun) — the original red result stands. Empty when every
  // rerun this run ever made returned a usable results[].
  quarantineAbandoned: quarantineAbandonedLog,
}

// C1 FINAL CHECKPOINT — writes <runDir>/result.json as a size-capped summary of
// resultObj (details live in the phase files, not here) and lists those phase
// files. No-op when checkpoints are off or runDir was never supplied, so a
// legacy call (no args.runDir) reaches `return resultObj` with zero extra work.
if (CFG.checkpoint.enabled && runDir) {
  await runFinalCheckpoint(resultObj)
}
return resultObj
