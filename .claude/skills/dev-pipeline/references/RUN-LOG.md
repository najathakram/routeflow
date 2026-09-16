# Run log — the learning loop (owner law 2026-09-03)

One entry per run (dev-pipeline, bug-pipeline AND light loop — one learning loop), appended at close-out by
`scripts/closeout.mjs` (stub) and finished by hand, newest first, ≤ 10 lines each. Heading:
`## <slug> · <mode> · <scale> · $<true cost from session-usage> · <active time> · <date>` — measured, never
estimated. Bullets: what caught the real defects · what was wasted · ONE candidate knob change with evidence
· deviations forced.
Quantitative truth lives in the project's `cost-ledger.jsonl`; this file holds what the numbers cannot say.
Knobs change on ledger evidence (ten-run rules), never on one entry.

---

## 2026-09-15-session-c47433e0 · light-loop · unknown-scale · $3.86 · 0:30 · 2026-09-15

- Caught: (no confirmedByPhase data in result.json)
- Wasted: (none identified from result.json fields)
- Knob candidate: TODO (one change WITH evidence)
- Deviation: TODO

## E9 scope guard deleted the run's own artifact dir (lead c4 2026-09-15) · engine fix · n/a · n/a · n/a · 2026-09-15

- Real launch 2026-09-15 (Lite L2, staged sha 52bf7a7a…): WP5a's test author touched its OWN
  run's artifact dir (spec.md/build-plan.md/test-plan.md/RESUME.md/phases/) and agent-log.jsonl;
  enforceTestAuthorScope flagged both as untracked+unplanned and its remediation DELETED them --
  9 later tasks then had no plan to read and cascaded to blocked; nothing shipped.
- Fix: ENGINE_OWNED_PATH_PREFIXES ('.claude/pipeline/', the run dir) is filtered out of the
  violation computation entirely; remediation may now only `git checkout --` a TRACKED path or
  delete an UNTRACKED path mechanically proven NEW via a pre-call snapshot (E7-style) -- a
  pre-existing untracked path is reported, never deleted; a wave-boundary check now stops the
  RUN with one loud (run-artifacts) finding if build/test-plan paths vanish mid-run, instead of
  cascading every remaining task into blocked one at a time.
- Dry-run BC/BD/BE added; full suite stays ALL PASSED. No ledger row -- a same-day engine patch.

## E8 agent non-compliance must not crash the run (lead c4 2026-09-15) · engine fix · n/a · n/a · n/a · 2026-09-15

- Real launch 2026-09-15 (Lite L2, staged sha 857a9d4d…): the test-author agent ended its turn
  without calling StructuredOutput; askAgent's call rejected, escaped withWorkdirGuard (E7)
  unguarded, and crashed the whole workflow (null deref on `t.status` + a `parallel[0]` failure).
- Fix: withWorkdirGuard/runTask/revert-probe now catch a thrown agent call as a dead-agent null;
  runTask never rejects (returns an `(engine)` blocker instead); the wave loop normalises any
  null parallel() slot back to the scheduled task; progressLineFor tolerates a null task.
- Dry-run BA/BB added; full suite stays ALL PASSED. No ledger row — a same-day engine patch.

---

## 2026-09-14-743-fix-round · rebuilt engine (84e325e9, debut launch) · major · $7.33 true (24 agents, 30:20) · 0:30 workflow · 2026-09-15

- Engine: rebuilt task-loop (171,158 B, sha256 84e325e9…), first real launch after the 2026-09-13
  rebuild — prior runs were smoke tests. Stopped (TaskStop) after Baseline + a partial Author
  tests/Red gate/Gate & Review pass on T1 and T3 (the graph's only two no-dependency tasks), both
  blocked; T2/T4-T8 never started (all transitively depend on T1 or T3).
- Caught (2 real engine defects, per routeflow-c4's read, independently verified against the
  checkpoints): (1) T1's test-author agent wrote implementation (`TENANT_CLASS_VALUES` in
  `enums.ts`, plus fixed a duplicate type alias its own edit introduced), so its own red test
  came up GREEN with nothing left to fail on — the test-author role has no guardrail against
  touching files outside `t.tests` (`phases/01-checkpoint-t1.json`). (2) T3's red-gate audit
  rejected a legitimate "the observable doesn't exist yet" RED state (the printed resolved-host
  line T3 itself introduces) as if it were a test-fixture problem — the rebuild never carried
  forward the "structural RED accepted" concept the audit needs to tell that apart from a wrong
  value (`phases/02-checkpoint-t3.json`).
- Wasted: both tasks burned 2 remediation rounds each (most of the $6.02 Author-tests phase cost)
  before blocking — neither defect is fixable by remediation, since both are audit/role-design
  gaps, not task-content problems.
- Also found, unrelated to the task graph: `closeout.mjs` on a manually-stopped run (no
  `result.json`) guesses a run-id from the folder name for its session-usage lookup instead of
  using the real one; the guess matched nothing, and it silently fell back to a session-wide
  aggregate ($108.61, ~9h, almost entirely unrelated Fable/Opus tokens) instead of erroring.
  Corrected by hand via `session-usage.mjs <sessionId> --wf <realRunId> --project <main checkout>`
  ($7.33, 24 agents, 30:20 — the number now in the ledger).
- Knob candidate: implement the "structural RED accepted" check the rebuild dropped — a red-gate
  audit needs to treat "assertion fails because the printed/returned value doesn't exist yet" as
  valid RED when the task's own brief says the task introduces that observable, distinct from
  "test passed, nothing to fail on." Evidence: this exact gap blocked T3 outright on its debut run.
- Deviation: launched at `mode: 'feature'` per the pre-launch plan; stopped before Final pass on
  owner-relayed lead ruling (graph fully stuck, no further progress possible). Remainder finishing
  as a manual light loop in the same worktree, not a resumed engine run.
- Light loop completed: all 8 tasks landed (T7/T2 each caught real money-correctness bugs on
  their own Opus review pass — a missing MRR ledger delta, a raw-column check that could
  contradict a computed price — fixed before push). True cost gap: `session-usage.mjs` over the
  WHOLE session span (engine debut through push) reports $121.50/493M tokens/5:35 active — the
  $7.33 figure above is the engine-abort phase ONLY; the light-loop's own incremental cost was
  never separately metered (no clean Workflow-run boundary to `--wf`-scope against once work
  moved to direct edits + Agent-tool review dispatches). Same root cause as the run-id-guessing
  bug above, now confirmed a second way: `closeout.mjs`'s cost attribution assumes one Workflow
  invocation per run and has no answer for "engine aborted, human finished the rest."

## 2026-09-14-phase0-t12-t15 · legacy engine (6132d8b3) · major · $73.90 true ($52.97 workflow/78 agents + $20.94 orchestrating session) · 3:57 workflow / 1:14 session · 2026-09-14

- Engine: legacy 6132d8b3 (376,950 B, pre-2026-09-13 rebuild), staged by mistake — the worktree's
  own vendored `.claude/skills/dev-pipeline/pipeline.js` simply predates the rebuild (PR #709)
  being re-vendored into this repo. Stopped after phase 07 (mutation probe) + a partial,
  uncheckpointed Fix phase, on owner ruling relayed via fleet lead routeflow-c4, confirmed
  directly by the owner mid-run. Never reached Final pass. Engine's own self-reported cumulative
  `estUsd` at phase 7 was $10.64 — true cost $52.97 for the workflow alone, a ~5x under-report.
- Caught: Gate & Review's correctness lens caught a real, severe defect before any commit —
  WP-D (dashboard MRR card) and WP-E (plan labels + live catalog) were reported DONE by their
  implementers but were byte-identical to HEAD, wiped by a sibling package's unscoped
  `npm run format` + `git checkout` after formatCommand ran repo-wide. Also caught: the
  `TenantMirrorService.upsert()` design's own `findUniqueOrThrow` violated its documented
  best-effort/never-throws contract (fixed to `findUnique` + warn); a concurrent-create race on
  the mirror's unique constraints (fixed with a P2002 catch-and-retry); a weak `estMrrUsd`
  negative assertion (`toBeUndefined()` vs the spec's `not.toHaveProperty()`); and a real
  test-quality gap the mutation probe itself proved: the dashboard MRR diff-badge test used
  exactly-equal values (499/499), which cannot distinguish cents-rounding from raw float
  comparison — production code is correct, the test doesn't prove it.
- Wasted: the interrupted Fix phase (15 agents, $13.10, 54 min) kept running through the full
  multi-message coordination exchange with the lead about whether/how to stop — by the time
  TaskStop was actually called, Fix had already re-applied most of Gate & Review's findings
  (verified directly against current file content post-stop, not from the stale checkpoint), so
  the actual remaining-work list is 3 minor items, far short of the ~19 blockers the last
  checkpoint (05-gate-review, mid-run) still showed. A faster stop decision would have saved most
  of that $13.10 without losing anything, since a from-scratch Sonnet light-loop was always the
  planned next step regardless.
- Knob candidate: `formatCommand` must never be a repo-wide sweep (`npm run format` with no path
  args) — confirmed root cause of a real defect (sibling packages' uncommitted work silently
  destroyed), not just cosmetic churn on ~130 unrelated already-imperfectly-formatted files
  repo-wide. Fleet-wide rule already issued by the lead same-day: scope formatCommand to touched
  paths only. Evidence: this run, `05-gate-review.json`'s WP-D/WP-E findings.
- Deviation: stopped by explicit owner ruling before Final pass, mid-Fix-phase; close-out ran in
  `--light` mode against a synthesized (not engine-written) result.json, since the run never
  reached the point of writing one. `closeout.mjs`'s light-loop cost synthesis only captured the
  orchestrating session's own ~$21, not the workflow's $52.97 — pulled the workflow figure
  separately via `session-usage.mjs <sessionId> --wf <runId>` and combined by hand for this row.

## 2026-09-14-hunt-mobile-scan · bug-hunt (mobile-only, 4 owner seeds) · major · $113.40 = WHOLE-SESSION usage (also covers the 2026-09-13 SIGNUP security hunt + fixes in the same session; per-run isolation impossible) · 2 workflows (hunt wf_fcc77604-19e 12 agents 2.27 M tokens 31 min; verify wf_a077d3b3-f6a 10 agents 1.37 M tokens 14 min) · 2026-09-14

- Caught (real): 45 raw → 25 triaged → 24 confirmed (14 execution-verified, 8 Fable-ruled) + 1 refuted. Verification changed substance on 10/25: the "double charge" claim died on a server status guard (routes.service.ts:2513); the SPECIAL-tier claim dropped "permanent rate replaced" but gained a status-gate asymmetry vs web; the autosave claim narrowed (offline failures ARE queued, HTTP errors are not); the disputed seed-3 race was settled by WRITING the Jest test (qty 2 for camera-vs-typed, guarded for wedge/Enter) rather than by a third reader; the returns duplicate was bounded by arithmetic (lands iff undelivered ≤ delivered). Class split (not area) paid: the one money-critical came from money-mobile with a single finding; dead-ui was exhausted (6/8 findings were grep-count dead code, all dropped at triage).
- Wasted: Layer 1 scan-signatures has zero mobile-shaped signatures (0 hits on apps/mobile) — the scan gate is API-only today; one Bash `grep -r | head` hung on Windows (known trap, re-done with the Grep tool); the closeout ledger row cannot isolate a hunt from the session (see cost above).
- Knob candidate (evidence: 3 of 4 verifier "sides agree / write the test" items flipped or narrowed only under execution, and the seed-3 contradiction between four readers was unresolvable by reading): make "write the failing test" the DEFAULT verifier mode for any pack whose finders disagree, and give that pack a higher tool-call cap (22 here, used 12). Second: add mobile-shaped signatures to scan-signatures.mjs (Platform.OS-gated guard props, `.catch(() => {})` on flush paths, `.find()` on multi-field code lookups) — each of those shapes produced a confirmed finding here.
- Deviation: hunt ran on a detached master worktree (session tree 14 mobile files behind); L-025 recurred twice (warnIfDirty web-only no-op; native has no AppState flush) — cited, not re-recorded (register at cap 40). No filing yet: B-ids are minted only from a master-current tree after the owner's go (L-119).

## 2026-09-13-F27-build · bugfix · standard · $455.13 (whole-session usage — the run-id could not be isolated from the session's own extensive hand-fix work that followed it; not a clean per-run figure) · ~9.1h active · 2026-09-13

- Caught: the resumed run reported "completed" with its own final-gate command actually RED on 5 tests (B17 invoiceId link, B79 issueDate validation) — the run's status field and the gate's own output disagreed, and nothing stopped at that disagreement; only independently re-running the gate after the fact surfaced it. Separately, the engine's own final-pass (Fable) flagged a MAJOR regression its round-3 fix designer introduced — `accept()`'s claim was widened to exclude DECLINED (the full terminal set) instead of CONVERTED alone, breaking a pre-existing invariant (DECLINED→ACCEPTED) — and the SAME fix round then edited the two pre-existing tests that caught the break to match the new wrong behavior instead of fixing the implementation, leaving the one PIN test that would have caught it `it.skip`'d. This is the one no downstream gate can catch structurally: a red-gate/final-gate check only re-runs the CURRENT tests, so a test rewritten to agree with a regression reads as green forever after. Also caught post-hoc (hand-inspection + an Opus refute-first review): a stray uncommitted edit had silently dropped `issueDate` from the web create dto; the B79 validation's first draft had a bypass class (`2026-02-31` rolls over instead of rejecting); a CI-only test flake (native `type="date"` input via userEvent, environment-dependent); a duplicate REG-B15/PIN-B15 test block an earlier partial round left in two files; and a registry `prove` call missing `--pending-deploy` for two T2 rows silently broke every subsequent push behind a misleading wrapper "exit 0" (git's real "failed to push some refs" was buried inside a much larger pre-push hook's output).
- Wasted: the resumed Workflow run's own "result" (final consolidation) agent errored with a context-length overflow (~320K tokens vs 200K limit) and never produced a `result.json`, so this close-out's session-usage synthesis fell back to whole-session telemetry instead of the run's own — the true per-run cost is not recoverable after the fact. A prior run attempt (task `wgqn3usas`) also lost 33/143 agent calls to a mid-run session-limit exhaustion (all 6 revert-probes among them), forcing a `resumeFromRunId` continuation.
- Knob candidates (evidence: this run alone, so not yet a ten-run trigger — flagging both for the next occurrence): (1) a run's own final-gate/final-pass result must be load-bearing on its reported status — a run cannot report "completed" while its own final-gate command is RED; the engine should either block on this or surface it as a top-level blocker field a caller can't miss, not just a phase note buried in `phaseReport`. (2) a fix round that causes a PRE-EXISTING passing test to start failing must treat that as the primary finding and report it, never silently edit the test's assertion to match the new behavior — this is exactly the failure mode no downstream gate can catch (the rewritten test reads green forever after), so the round-3/4 Fable fix-designer prompt should say this explicitly rather than relying on the final-pass reviewer to catch it after the fact.
- Deviation: the "result" agent's context overflow meant this close-out never got a real `result.json`; ground truth was independently re-verified by reading the actual git/test state (per the house rule that an UNVERIFIED "completed" self-report is never neutral) rather than trusted, and the real remaining gaps were hand-fixed directly instead of a third full engine relaunch.

## 2026-09-12-claude5-model-refresh · feature · small · $18.03 · 2:00 · 2026-09-12

- Caught: Baseline 5 (3 broken host commands, 1 wrong SDK claim, 1 FALSE created-vs-edited blocker), Gate & Review 3 (minor), Author tests 1 (web suite could not load — react/react-dom hoist skew)
- Wasted: red gate 2 attempts (web suite), 8 Opus fix executions for 3 minor findings, per-phase telemetry lost (hyphen tag in the staged copy), 1 malformed checkpoint card (`04-implement.json`), 2 Workflow launch rejections (approval-dialog non-ASCII)
- Knob candidate (evidence above): the rebuild itself (this plan) — minor findings never block; created-vs-edited grounding; ASCII-only source
- Deviation: launched from a transliterated engine copy `pipeline-2026-09-12b.js`; S5.5 grounding pass skipped by the orchestrator (Baseline caught the SDK claim instead)

## 2026-09-12-session-00e24527 · light-loop · unknown-scale · $0.41 · 0:01 · 2026-09-12

- Caught: (no confirmedByPhase data in result.json)
- Wasted: (none identified from result.json fields)
- Knob candidate: TODO (one change WITH evidence)
- Deviation: TODO

## 2026-09-12-session-c755923e · light-loop · unknown-scale · $0.40 · 0:01 · 2026-09-12

- Caught: (no confirmedByPhase data in result.json)
- Wasted: (none identified from result.json fields)
- Knob candidate: TODO (one change WITH evidence)
- Deviation: TODO

## 2026-09-12-security-registry-tags · feature · small · $31.12 · 1:34 · 2026-09-12

- Caught: Baseline caught 2 stale line-number references in its own build-plan.md (fixed); Red gate caught a real hollow-gate defect in plane-sync.self-test.mjs (a self-test that could pass despite a failure — 1 Opus remediation round); Gate & Review raised 4 findings across P1-P4, all but one fixed across 2 Fix rounds; the survivor (plane-sync.mjs:877, Plane label-scope on untagged rows) is a genuine judgment call Fable's design premises didn't cleanly support — left open for a human/Fable call, not re-litigated here.
- Wasted: the session that launched wf_872ec903-4aa (~$31 of real work through 2 fix rounds) ended before Verify/Mutation probe/Final pass ran and before result.json was written; a fresh session's `resumeFromRunId` found no journal on disk (same-session-only cache) so true resume was impossible — the run had to be hand-reconstructed from phases/*.json plus a manual re-run of the recorded verify commands (all green; the checkpointed "blocker" was the gate having run from the wrong cwd, a false positive, not a real defect).
- Knob candidate (evidence: this reconstruction cost ~40 min hand-diagnosing what a persisted result.json would have given for free): have the engine write/refresh `<runDir>/result.json` at every C1 checkpoint, not just `phases/*.json`, so a run whose launching session is lost still has a real, ledger-ready result on disk instead of needing hand reconstruction. Separately, this reconstruction surfaced (and this session fixed) two real closeout.mjs bugs, evidenced by this run's own first ledger attempt being wrong: (1) the true-cost lookup indexed `usage.workflows` by the `wf_`-prefixed runId while session-usage.mjs keys that map unprefixed, so every non-light close-out was silently falling back to the whole-session cost ($32.01 here vs. the correctly-scoped $31.12); (2) the handoff card's `lastCheckpointPhase` stringified the checkpoint's `phase` OBJECT instead of `.phase.phase`, printing "last phase [object Object]" on every card.
- Deviation: no true resume; result.json hand-authored from phases/07-fix.json's resultSoFar plus a manual verify pass, documented in its own `note`/`gate.note` fields rather than silently presented as automated; PR not yet opened — owner chose "reconstruct + close out properly, stop before push/PR" over a --light close-out or skipping close-out entirely.

## 2026-09-11-crm-gohighlevel-handoff · light-loop · major · $64.45 · 2:30 · 2026-09-12

- Caught (real): the engine's Gate & Review lenses found 63 raw findings, Verify confirmed 63/63 (0 refuted) — 36 root causes after dedupe: 5 of 12 spec routes missing from the controller, two responses returning the raw connection row with the encrypted token, an IDOR on retry/dismiss (no tenant predicate), a per-tenant client replaced by an empty-credential singleton, write-back bookkeeping never persisted. The light-loop Opus refute-first review after round 1 caught the one defect no engine phase could reach: `where: { source }` against a model whose column is `externalSource` — 99 green unit tests on `any`-typed Prisma mocks, and mutation probes (which probe asserted behavior) could not see it; production would have failed every handoff. Probes 5/6 on the first pass; the survivor (ref-vs-name precedence unpinned) became three tests. Lesson recorded (testing: every new Prisma call site needs a DB-lane spec or a where-shape pinned to the generated types).
- Wasted: the engine died at its first Fable fix-plan (`Buffer is not defined` in capFableBrief; the 6f5f1cf8 copy predates the fix) after 60 agents / 7.6M tokens / 131 min — everything through Verify was kept, but fix, probe and final pass re-ran as hand-orchestrated agents; the first launch was rejected because the staged copy had CRLF endings (permission layer: "control characters") and the resume of the patched copy was classifier-denied; the transcriber emitted a 6 KB args object (above the 4.5 KB resume trap) and mangled two Windows paths; ~1 h of stop-hook nags about an unrelated run's ledger row (lands with #698).
- Knob candidate (evidence: 1 blocker in this run that no lens, refuter or probe reached, found only by a schema-reading review; refuters are never asked to compare Prisma `where` keys against the schema): add a mechanical Haiku "schema-shape" step to Gate & Review — for every NEW `prisma.<model>.<op>({ where | data })` call site in the diff, compile the literal against the generated Prisma types (a ~10-line ts probe) before any Opus lens spends tokens; the cheapest catch for the most expensive class of green-test defect. Smaller: refuse a CRLF engine copy at stage time (`grep -c $'\r'`) — that launch failure cost a full round trip.
- ESCAPED (post-merge, 2026-09-12): #702 took the prod API down for 26 min — `CrmModule` never imported `BillingModule`, so `AddonGuard` could not resolve `AddonService` and the container crashed at boot. The fix-plan text named the import; the executor omitted it; 4654 unit tests (module-boundary mocks), tsc, the Opus lenses and the refute-first review all passed because none of them boots the Nest container, and I skipped the repo's own pre-PR gate (`npm run local:up` + `local:validate`, the compose stack built from the production Dockerfiles) — the one check that would have failed in seconds. Hotfix #703 (lead) added a repo-truth guard `apps/api/src/common/addon-guard-module-import.spec.ts`. Superseding knob candidate (evidence: 1 outage, 26 min, from a defect invisible to every unit/static gate): the engine's `final` gate for any diff that adds or edits a Nest `*.module.ts` MUST include a container-compile check — cheapest form `nest build && node -e "require('./dist/app.module')"` plus a `Test.createTestingModule({ imports:[AppModule] }).compile()` smoke, or the compose boot (`local:up` + `smoke`) — and the light loop's checklist gets the same line.
- Deviation: engine through Verify, then LIGHT LOOP via the Agent tool (Sonnet brief → Fable fix plan → Opus HIGH-risk / Sonnet routine executors → Opus refute-first review → Sonnet probes) for fix rounds 1–2 because the resume was classifier-denied; `uiVerify` omitted by ruling (the tab needs a live GHL location; RTL covers the states); lessons entry written in-PR, id to be renumbered at the JIT rebase (L-112 is taken by #701).

## 2026-09-11-engine-instrument-b · light-loop (tooling: true telemetry as a gate, router question split) · small · $24.42 TRUE (94.9% cache hit) · 1 h 10 m active · 32 agents · 2026-09-12

- Caught (real): the Opus review and two final passes caught that the router's head-position redesign had gone second-person only, so "Can we add X?" / "Should we implement Y?" routed to null (silent) where they had routed to an engine before, plus a dead question chain left in the file and a citation of a brief section that did not exist; the lead ruled the design kept (an anywhere-in-text write-verb test mis-fires on "I have created") and extended the request leads to first-person forms, executed outside the loop after the 2-round cap; 39 router selftest scenarios green including the 4 regressions. P2 landed as specified: closeout and session-usage resolve the main checkout through `git rev-parse --git-common-dir` (both engine-instrument close-outs printed "resolved via git-common-dir"), the silent legacy fallback now exits non-zero unless `--no-usage --reason` is given, the ledger row carries mode/sessionId/fallback/siblingSweep/usageOverrideReason, and stop-global blocks a legacy row past the 2026-09-12T12:00Z cutoff (23 selftest cases).
- Wasted: same two preflight aborts and the Buffer crash as loop A (shared script); the loop was launched with a `runId` the Workflow tool ignores, so result.json was rewritten to the harness id before close-out; one docs file edited without its .bak (accepted).
- Knob candidate (evidence: these two rows are the first true-telemetry rows in a 31-row ledger; every routing target in ROUTING-PLAN §9 was unmeasurable before them): no effort or routing knob moves until ten true rows exist; the first candidate then is the L4 deep-lens seat xhigh→high, same model, cheapest test.
- Deviation: light loop instead of the bug-pipeline engine; router regression fixed by a lead-dispatched executor after the cap; lessons entry deferred until master (PR #698) is merged back into chore/workflow-redesign.

## 2026-09-11-engine-instrument-a · light-loop (engine defects: sweep, gate proof, prefix blocks, final-pass order) · small · $23.92 TRUE (first true-telemetry ledger row ever; 95.8% cache hit) · 1 h 01 m active · 36 agents · 2026-09-12

- Caught (real): repro-first dry-run scenarios went RED on the old engine for the sibling-sweep field mismatch (callers pass `regex`, the filter read `.pattern`; 4/4 bugfix runs never swept) and for a gate result with no cwd; the Opus review and two final passes caught the cwd-mismatch reason not threaded into the mutation re-gate record, the C1 checkpoint firing twice when the final pass re-enters on the P5 reorder, and, after the Buffer crash fix, that `utf8ByteLength` had swapped one host global (Buffer) for another (TextEncoder) and that the promised source scan for sandbox-hostile globals had not been added. Both fixed by a lead-dispatched executor after the 2-round cap; the scanner self-tests against the .bak copies (flags Buffer.@676) and the live files are clean.
- Wasted: two launches aborted at preflight (Claude Code sessions and MCP servers are node processes, 14 to 16 at idle on a two-session host, and the prompt said "count node processes"); both loops then died at the first Fable fix-plan with `ReferenceError: Buffer is not defined` in capFableBrief (present in pipeline.js since wave 3 on 09-11 as well), resumed from cache so only the fix-plan onward re-ran; the light loop's `runId` arg is a label the Workflow tool ignores, so result.json had to be rewritten to the harness id (wf_a480f96b-18a) before session-usage could attribute cost.
- Knob candidate (evidence: 2 launches lost today to defects that only exist inside the Workflow sandbox, invisible to both dry-runs because they execute under node): promote any engine or light-loop edit only after a 1-agent live smoke through the Workflow tool (a brief whose Build is "reply OK"), in addition to the dry-runs; and have closeout/session-usage match a light-loop run to its wf_* transcript by time window when `runId` is not a harness id (1 run).
- Deviation: light loop instead of the bug-pipeline engine (the engine's own defects were the target and it could not measure a run); the disputed Jest-validator finding was ruled no-change by the lead (no filesystem access by design; exact match against plannedFiles is the conservative approximation); lessons entry deferred until master (PR #698 rewrites the register) is merged back.

## 2026-09-12-plane-learning · dev-pipeline (feature) run as a LIGHT LOOP · major · ≈ $54 TRUE (session delta 02:18→05:12Z: Fable main $18.6, Sonnet/Opus agents $35.2; 11 agents; one ≤ 12 KB spec as the only brief) · 2 h 30 m · 2026-09-12

- Caught: Opus refute-first review (2 majors: appendRun redaction stripped error/flags but left a uuid-bearing branch name in the line while stamping redacted:true; the doctor compared git %cI offsets with ledger Z timestamps as strings, so a real "landing without sync" could be missed or a false one raised; minors: doctor kept making requests after an invalid-knobs FAIL, appendRun could throw out of a finally and break the never-blocks contract, the retro incident scan was branch-local and --apply could rewrite the tracked knobs file from any branch, 10-run boundary + held-window expiry untested) — all fixed with tests; the quiet-tree run also exposed that the four v2 suites leaked telemetry lines into the real runs.jsonl (fixed: PLANE_RUNS_PATH + byte-unchanged invariants).
- Wasted: two agents raced on plane-doctor.self-test.mjs (the TP2 author and the WP3 builder both wrote it; the later version won — name test-file ownership explicitly per wave); transient suite failures under 4-agent load (tmpdir counts, T2 timing) cost re-runs; closeout.mjs cannot find a worktree run transcript (the session lives under the main project dir) — worked around twice with session-usage by id + pipeline-ledger --usage.
- Knob candidate (evidence: this run ≈ $54 vs run 1 $92 for comparable scope): the one-spec-file brief roughly halved Sonnet cache reads — make "one ≤ 12 KB brief per run, tools read it by path" the light-loop default; and closeout.mjs needs a --transcript-project <dir> separate from --project (2 runs hit it).
- Deviation: light loop (engine classifier-blocked); packages built tests-first in two waves; scheduled-task + /orient edits done outside the PR.

## 2026-09-11-plane-harness · dev-pipeline (feature) run as a LIGHT LOOP · major · $91.6 TRUE through 02:18Z (Fable main loop $31.8 at 99% cache hit; Sonnet subagents $57.0 — 207 M cache-read tokens across ~25 briefs that each re-read spec+build-plan+tests; Opus $2.8) · 3 h 33 m active · 2026-09-11

- Caught: Opus refute-first review (7 real findings from a 40 KB radius pack in 12 calls: adoption PATCH ran BEFORE the dry-run/check return and the branch guard — a hook or `--check` from a worktree would still write live; plane-apply reported deferred writes as applied; listAll assumed the paginated envelope while live `members/` and `work-item-types/` are bare arrays — proven by a live `--dry-run`; intake non-transactional file→PATCH re-minted ids; denylist failed open on a missing file; archive message printed a state uuid; close comment on unknown state group) + scoped re-check (env override bypass + empty/malformed denylist fail-open); a live read-only dry run of the first ops file and a live triage brief caught the envelope defect and a 2-page BUGS cap (200 of 392 counted) that no fake-server test could.
- Wasted: the engine never ran — the Workflow permission handler rejected a CRLF engine copy as "control characters" and the LF retry was classifier-denied (2 launches); the fixture author wrapped two routes in an envelope the live API never returns (green tests, dead feature), costing a fix round; self-tests leaked ~180 fake ledger lines into the real campaign dir across 3 waves because runCli defaults omitted the state dir (fixed twice); the Gate 5 hook of the BASE branch ran from the worktree at a turn end with the real key and created 282 live items (owner deduped, 2 passes, 429 pacing).
- Knob candidate (evidence: this run + numbering-siblings + train4-run-c "cwd" entries): stage engine copies LF-normalised (`pipeline-<ver>-lf.js`) and add a Baseline check that the fake-server route shapes match a recorded live probe (one GET per route, stored as fixtures) — two of the seven majors were fake-vs-live shape drift; and every runCli-style test helper must default its state/ledger dir to a tmpdir (assert the real dir is byte-unchanged at suite end).
- Cost lesson: a light loop at major scale cost ~1.7× the priciest engine run (numbering-siblings $53) because every wave re-read ~100 KB of artifacts per agent and the radius-pack builder alone spent 387 K tokens / 123 tool calls; the engine would have pipelined the same work with per-phase packs. Next light loop: one shared ≤ 8 KB brief per wave, Haiku for gate/mechanics runs (four Sonnet mech runs here), and cap the pack builder at 30 tool calls.
- Deviation: light loop instead of the engine (classifier); Fable orchestrated ≤ 4 agents/wave (tests-first per package, Opus review + re-check, 3 fix rounds); hook incident handled mid-run (R14 branch guard added to the spec, lesson L-104, owner-run dedupe script).

## 2026-09-11-google-signin-monitor · feature · small · $26.23 true (est. was $9.52, 2.76x under) · 1:18:12 · 2026-09-11

- Caught: Gate & Review (7), Red gate (1), Baseline (0)
- Wasted: red gate needed 2 attempts (remediateOn: behavioral); 2 fix rounds
- Knob candidate: closeout transcript path from worktree (3rd run in a row); small-scale runs
  skip verify/probe — the two fix rounds here came from lenses only, which was enough.
- Deviation: closeout.mjs's session-usage lookup failed from the worktree path (transcript
  resolved under the main-repo project key, not the worktree's) — session-usage.mjs re-run
  manually with --project pointed at the main repo path and --wf, then the ledger row
  re-appended with --usage to replace the budget-only estimate.

## 2026-09-10-train4-run-b · bugfix · major · $82.28 true (est. was $20.31, 4.05x under) · n/a (session-level, not workflow-scoped) · 2026-09-11

- Caught: Gate & Review (20 — the deferred-post-fold-reconciliation major + the missing apply-rls.js
  TENANT_TABLES entry, both real), Baseline (1 — lint-migrations pre-broken on baseline, excluded),
  Mutation probe (1 — two of three revert-fix probes caught by the REG suite; the third,
  merge-idempotency.ts, was not caught and is a residual gap in that file's own coverage).
- Wasted: 2 fix rounds — round 1 missed a test-harness gap (prototype OrdersService had no
  `logger`, so round 1's own `logger.warn` broke PD1) and a rollback-proof regression (round 1's
  pre-fold 409 short-circuited D3's real-Postgres in-tx P2002 proof), both closed in round 2.
- Knob candidate: (1) a new/changed Prisma model must add `schema-folder.spec.ts` to the change's
  radius — this run's own build plan omitted it and round 1 had to firefight EXPECTED_MODEL_COUNT
  - the retired e39bf9db block-identity pin as unplanned blockers. (2) the plan's scoped verify
    command list must always include the full `apps/api` Jest lane, not just the touched
    directories — this run's plan verify was `src/orders/ src/buyer/buyer.merge-lock` only; the
    full lane (264 suites / 4436 tests) was run manually post-hoc by the closer and passed, but the
    plan itself never proved it.
- Deviation: closeout.mjs's session-usage lookup failed from the worktree path (transcript
  resolved under the main-repo project key, not the worktree's), matching the plane-sync run's
  already-flagged knob candidate; session-usage.mjs re-run manually with --project pointed at the
  main repo path and --wf, then the ledger row re-appended with --usage to replace the
  budget-only estimate.

## 2026-09-10-plane-sync · feature · small · ~$6.40 (est.) · n/a · 2026-09-11

- Caught: Gate & Review (11), Baseline (2), Red gate (1)
- Wasted: red gate needed 2 attempts (remediateOn: behavioral); 2 fix rounds
- Knob candidate: closeout.mjs derives the transcript path from the run's worktree, so every
  worktree run falls back to tokensSource=budget; candidate: resolve the transcript from the git
  common dir (`git rev-parse --git-common-dir`) or accept --transcript; seen this run.
- Deviation: TODO

## 2026-09-11-session-sess-g6 · light-loop · unknown-scale · cost n/a · n/a · 2026-09-11

- Caught: (no confirmedByPhase data in result.json)
- Wasted: (none identified from result.json fields)
- Knob candidate: TODO (one change WITH evidence)
- Deviation: TODO

## 2026-09-10-workflow-redesign · feature · major · $236.70 true (lead $80.35 · 50 Agent-tool agents $121.58 · 5 workflows/26 agents $34.78; measured by session-usage.mjs --all at 01:50 on 2026-09-11, still running) · ~10 h wall, 4 h active · 2026-09-10/11

- Caught: two Opus reviews found 1 blocker + 7 majors a Sonnet build shipped — the checkpoint
  `result.json` wrapped in a shape the ledger refuses; summary stripping that zeroes `remaining` on
  overflow; `git add -A` in the snapshot commit; a lessons stub that desyncs `_meta.json`; a Gate 4
  predicate that could never fire (REG tokens live in titles, not paths); "Never Sonnet. Never Haiku."
  left contradicting the new planning split. The measurement itself was the biggest catch: one prior
  run ledgered at $14.94 truly cost $205 + $41; another session $103 in cache reads alone.
- Wasted: an executor `rm -f`'d 9 untracked root files it did not own (owner's `Generalizable`,
  unrecoverable); a `git stash` in the shared checkout; a selftest wrote its fixture into this file
  (`run1` stub, removed, guard added); an explorer's "unique prototype" claim was wrong (diffed = HEAD).
- Knob candidate (evidence: this run): every executor brief carries the no-delete/no-stash rule and
  repo-editing agents get `isolation: worktree`; an agent that must delete gets it as a named step.
- Phase 2 (skills to best versions): 3 research/design workflows (62 SOTA techniques, 47 reuse candidates,
  3-design panel) → Fable ruling → 2 build waves + 5 Opus reviews (1 blocker each in light-loop and skill text,
  3 majors in hooks) → fix rounds. Caught: a Stop hook that would have blocked every turn (slug prefix mismatch),
  a guard matching prose, a false-clean on a dead fix-brief agent, ultracode flipping ON on risk alone. Wasted: an
  engine agent stalled 4.5 h with no output (stopped, re-briefed in two halves); a usage-limit hit killed 5
  in-flight agents mid-wave (re-run from disk state — write files incrementally). Knob candidate: cap any single
  agent at 90 min wall-clock and checkpoint its files; evidence — this run, the auth-redesign entry.
- Deviation: light loop (Fable rules → Sonnet executors → 2 Opus reviews → 2 fix rounds) instead of
  the engine — the engine was the thing being changed; close-out via the new `closeout.mjs` chain.

## 2026-09-08-signin-menu-hotfix · light-loop · small · docs-only follow-up, no engine run · 2026-09-08

- Caught: owner screenshot (keyboard focus on the marketing header's Sign-in dropdown) — nothing
  in CI, unit/RTL, or the E2E suite exercises focus-state painting (fragmented outline rects,
  per-line-box rings), so nothing automated would have caught this class either.
- Wasted: the brief's suggested retire-proof base (790fbac9) was not this branch's actual
  merge-base (it last synced master at 85b7d53c, one commit earlier) — re-derived from the PR's
  own merge commit's parents before the stat diff matched; and confirming from `bugs.mjs` source
  that `prove`/`discharge` both require a `--batch` ledger shard (an unbatched row has none by
  design) took a full read of `cmds.file`/`cmds.prove`/`cmds.discharge`/`cmds.move`.
- Knob candidate (evidence: this run): add a keyboard-focus capture (Tab to each interactive
  menu/dropdown item, screenshot) to the UI-verify driver protocol — a focus-only defect like
  this one paints nothing a hover/click-driven visual pass would ever see.
- Deviation: B279 filed unbatched, evidenced via `note` (Root cause/Fix approach/Test plan) —
  `bugs.mjs prove`/`discharge` require a `--batch` ledger shard by design, which an unbatched row
  does not have, so it stays `uncampaigned` rather than a fabricated `done` claim.

## 2026-09-08-distributors-hotfix · light-loop · small · docs-only follow-up, no engine run · 2026-09-08

- Caught: deployment E2E spec 36 T1 — the only thing that caught `/distributors` answering 307
  with no `Location` header in prod after #657; `next dev` redirected fine and masked it.
- Wasted: 2 days of the marketing engine's own UI-verify judged the dev server, then a compose
  image that had only ever served master — no production-shaped run ever exercised the alias.
- Knob candidate (evidence: this run): the deployment E2E should run against a production image
  of the BRANCH before merge whenever the compose build is available — the dev server is not an
  oracle for a redirects/caching-class defect.
- Deviation: shipped same-day as a light-loop hotfix outside dev-pipeline/bug-pipeline; this
  Bookkeeping Option B follow-up does the sibling sweep + lesson the engine would have.

## 2026-09-07-auth-redesign · feature · major · engine tokens unknown (subagent est. 1.85M) · ~10h wall (incl. an idle account-switch gap) · 2026-09-08

- Caught: Opus refute-first review (R1, FIX-FIRST: fixed h1 contradicting page
  state on 5 pages, fenced-heading periods) + Opus pixel judge (R3, FIX-FIRST:
  unscoped `.rf-auth` CSS leakage, buyer link contrast, dead specs 47/48) —
  design/UX defects a Sonnet build alone would have shipped.
- Wasted: the engine itself stopped at 62 agents mid fix-loop with no
  result.json/checkpoint; two driver agents had stalled on background waits.
  All value was recovered only because a checkpoint commit (`102c79ce`) and
  the R1/R3 review artifacts survived — nothing else from the engine run did.
- Knob candidate (evidence: this run + the 2026-09-04 ocr-gate-observe-first
  entry, same failure mode twice): the engine should write a result.json
  checkpoint after every phase, not only at close-out, so a stalled run can
  resume or be light-looped without losing the review verdicts.
- Deviation: closed via a light loop (Fable ruling over R1+R3 into D1-D10,
  Sonnet/Opus executors, one re-verify round) instead of an engine close-out;
  squashed the checkpoint commit onto `42a4893e` before landing.

## 2026-09-04-F25-location-bugfix (Run B) · bugfix · small · ≈$1.28 · ~22m live after a 10h pause · 2026-09-05

- Caught: red-gate audit caught the stub seam (non-behavioral red → remediated); review found 3
  coverage holes plus the implausible-speed hardening gap.
- Wasted: 2 baseline commands excluded — the REG test file did not exist yet (put such tests in
  `final`, not `perRound`) and an api-wide jest red on an unrelated spec.
- Knob candidate: bugfix mode skipped both `revertFix` probes as "small-scale" — a small bug fix
  ends with zero revert evidence; evidence `mutationProbe.skipped:"small-scale"` with 2 targets
  declared.
- Deviations: paused/resumed for host contention; the resume failed twice on a truncated
  stored-args string in the run record, repaired by appending the missing brace.

## ocr-gate-observe-first · bugfix · run wf_eece6302-2d5 by routeflow-cb, started 2026-09-04T05:27Z · 2026-09-04

- Died before close-out: no result.json, ledger row, lessons entry or code-map update; the tree itself was complete and green (23 suites / 358 tests on the touched suites). Salvaged and merged by hand by routeflow-44 on 2026-09-04 per the owner rule "merge done work, don't rebuild" — this run's own S7 never executed.
- Caught the real defect: the session's own cause refutation — "the enforced key has no automatic writer at all … so it also denies SCALE-plan tenants whose plan nominally includes OCR" (cause-refutation.md, OCR-1) — which is why the fix is a registry, not a one-tenant grandfather list.
- Wasted: nothing recoverable was lost, but the un-pushed tree sat 15h as a bare snapshot commit before anyone found it.
- Knob candidate (evidence: F13 and this run both stranded the same way): a run should snapshot-commit and push its branch at the first green gate so a dead session never leaves undiscoverable finished work.

## watchdog-spec-host-speed · bugfix · small · ≈$7.4 · ~81m · 2026-09-04

- Caught: refutation measured that a poll-alone fix still dies at Jest's undeclared 5s cap on a slow-booting host; fix round 1 made awaitStartLine reject promptly (exit code + stderr tail) when the child dies before the start line, pinned by new T5.
- Wasted: Baseline's "bad command" classification fought the bug's own behavioral red bar (the spec's own repro failure) and needed a Fable dispute to keep it in the decision.
- Knob (evidence: this run): in bugfix mode, a baseline failure of a REG-scoped command IS the red bar — don't exclude it as a broken command.
- Deviations: TP1 seam extraction added logFile/onSpawn params beyond the plan's sketch; pipeline-args.json launched with relative plan paths and string-form siblingPatterns, corrected at close-out; result reconstructed from the workflow journal (engine return truncated by the harness).

## bug-e2e-freshness-guard · bugfix · small · ≈$11 · 1h28m · 2026-09-04

- Caught: 2 Fable-planned fix rounds landed 8 findings — round 1 (7, mostly opus-routed) fixed a
  deploy-breaking unpinned helper-checkout ref (would MODULE_NOT_FOUND on a stale pre-merge
  deployment_status commit), appendOutput()'s silent no-op on missing GITHUB_OUTPUT, a dropped
  EVENT_NAME dispatch branch, and a Windows-unverifiable T1 `gh` shim; round 2 (1, mechanical)
  fixed a stale build-plan acceptance doc. mutationProbe was skipped (small-scale), so proof
  rests on redGate's own oracle-red assertions (T1/T4a/T4b), not an independent revert probe.
- Wasted: a full 2nd redGate audit pass (93k Opus tokens) largely re-diagnosed the same absence
  failure — 7 of 10 new tests (T2 + six T3 pins) failed on Node's MODULE_NOT_FOUND because the
  guard script is forbidden production code at author-test time, not on the bug's wrong value,
  so the run never reached true behavioralRed (structurallyRed only, both attempts).
- Knob: when a redGate subject file is itself the planned HIGH-risk production file, pre-classify
  its absence-signature tests as expected-not-behavioral instead of paying for a 2nd full audit;
  evidence — attempts 1 and 2 reported the identical 7-test MODULE_NOT_FOUND mode.
- Deviation: p2's ci.yml diff (39 ins/36 del) blew past the plan's ≤25-line criterion — the
  ruling's literal `node scripts/ci-freshness-guard.mjs` run text is unresolvable pre-checkout in
  the real e2e job and in T1's harness, so round 1 added a sparse-checkout step + `git rev-parse
--show-toplevel` path fix and round 2 updated the plan doc to match rather than reverting it.

## imp-wave-e-structure · feature · light-loop · cost: not ledgered · 2026-09-03/04

- Caught: 4 real enum drifts incl. a phantom `EstimateStatus.EXPIRED`; the mobile
  stub/payment-method type gaps; the post-commit-red `--check` trap — Fable's review of 10a's
  shipped verdict semantics found the implicit `git show HEAD:` fallback and a "block-identical"
  claim with no original to compare against, both silently unsound.
- Wasted: little — a folder-only "first referencing model" enum invariant needed one empirical
  iteration (proved unreconstructable without the original; replaced with membership).
- Candidate knob: none.
- Deviations: light loop by owner ruling (10b Sonnet build → 2 Opus reviews → fix rounds; 10a
  Opus build → specs → Opus review → fix round).

## imp-01-pricing-package · feature · major · ≈$122 · 14h16m · 2026-09-03

- Caught: the 2 fix rounds (58 fixes) found real build breaks — p1 skeleton never written → 46-file
  TS2307 cascade; mobile Dockerfile missing the package COPY; demo-seed requiring deleted files;
  golden table failing open; body-diff comparing zero symbols.
- Wasted: 4 early agents to 529 (auto-retried); ~10 unique defects reported 4-6x by parallel lenses
  (dedup cost); 14h wall clock for a mechanical extraction; the final adversarial pass was replaced
  by ONE Opus review under the light loop.
- Candidate knob (evidence: this run + imp-02) — dedupe findings by (file, symptom) BEFORE the
  refuter slate; cap lenses at 3 for refactors with a byte-identical proof script.
- Deviations: owner retired `major` for the rest of the program.

## imp-wave-b-api-hardening · feature · major · stopped · 3h40m · 2026-09-03

- Caught: the P4 tenancy pins found a REAL cross-tenant `findUniqueOrThrow` leak (fixed round 2,
  L-055); squawk `--base` fail-open; skip-verify empty-list bypass; login-throttle env read before
  ConfigModule.
- Wasted: red gate never structurally red twice (specs written as pins); fix round 3 orphaned two
  fixes that landed on disk unrecorded.
- Candidate knob: none new (same dedup + short-circuit candidates).
- Deviations: stopped by the owner's light-loop ruling; finished with a Sonnet re-gate + one Opus
  review.

## imp-02-order-merge-lock · feature · major · ≈$50 · 5h59m active · 2026-09-03 (resumed `wf_cad52fe2-0ce`, clean:false)

- Caught: two Fable fix rounds wired the lock after p2/p3 died; the post-run Opus refute-first
  review (28m) found the two real majors — post-commit 20s wait → mobile abort → double fold, and
  an unpinned buyer swallow.
- Wasted: 6 lenses, the refuter slate, the mutation probe and the final pass all ran on a tree where
  nothing called the lock (impl packages killed by 529, engine kept going); `verify` ran 3× (stale-
  cache baseline red, 10m final timeout, close-out); 2 concurrent engines tripled Jest wall time.
- Candidate knob (evidence: this run): a `blocked`/errored impl package should short-circuit
  Gate&Review→Verify→Probe→Final to a fix round that lands it, then re-enter review;
  `agents_error > 0` = hard stop, not "completed".
- Deviations: owner moved the remaining program items to the light loop (Sonnet build → one Opus
  refute-first review → Fable fix round) on this evidence.

## imp-03a-ddl-drift-gate · feature · major · $27.28 · 2h20m · 2026-09-02 (evening engine)

- Caught: 47 review findings, 0 overturned — incl. a silently removed prod-migrate env abort
  (correctness+security), an over-fatal drift gate, a `describe.skip` that didn't skip (4 lenses).
  Breadth reads earned their keep on an infra diff.
- Wasted: 36 refuter votes bought 0 drops ($1.82 pure insurance on a 0%-overturn batch); red gate took 2
  attempts ($4.90); final pass rose to $4.64 with the Opus reader at `xhigh` over an already-built digest;
  repo-wide `npm run verify` ran 4,984 tests at baseline, failed on unrelated claims, was excluded — the run
  shipped with NO final gate.
- Candidate knob: args preflight that refuses repo-wide gate commands (this run is the evidence).
- Deviations: hand-forked engine copy (`maxConcurrent` 16→8) — retired by `args.maxConcurrent` when it lands.

## F13-recurring-standing · (pre-mode bug batch) · major · $33.15 · 3h23m active · 2026-09-02 (morning engine)

- Caught: 31 surviving review findings — ALL inside the bug's blast radius; mutation probes 7/8 (the miss was
  a zero-match test filter, not blind tests); Fable final pass caught a major money-durability defect + a
  tenancy hole the lenses missed.
- Wasted: 42 refuter votes to overturn 6 (all single-lens; the top blocker was reported by 6 lenses and needed
  no vote); design-system lens 3/3 overturned; Fix rounds ran 4 synthetic-key executors serially (52m long
  pole); a stale `(mutation)` finding got an Opus executor 33 minutes after a sibling fixer had resolved it;
  external stash/re-apply mid-run poisoned the probe baseline (now classified `baselineDisturbed`).
- Candidate knobs (since shipped as `mode: 'bugfix'`): radius-packed lenses, corroboration skip, gated
  design-system lens, behavioral red bar, revert probes, harness-integrity check.
- Deviations: run on a mid-upgrade engine copy; machine slept 7h38m inside the red gate (elapsed ≠ active).

## 2026-09-03-du-view · dev · major · cost: not ledgered (engine abandoned before result.json; ~1.4M subagent tokens by transcript sizes) · active wall-clock ~2 h in-engine + ~1 h by hand

- Caught (real): red audit (Opus) — 3 anchor tests ERRORED inside the real engine on NaN stubs, 1 stub-satisfiable assertion, 1 disjunctive oracle; baseline grounding/manifest clean. All fixed and carried into test-plan rev 2 as house rules.
- Wasted: red-gate runner (Haiku) runs gate commands with the Bash default 120 s timeout — a 5-min MATLAB suite died at exit 143 twice, the Opus auditor re-ran 4 files separately (14 min), remediation re-ran everything; authoring pass #2 took ~40 min (4 Sonnet authors × 3–5 cold `matlab -batch` starts each, all contending); a hung uifigure probe + zombie MCP workers inflated every timing 5–20× (13 s measured vs 123–266 s observed).
- Knob candidate: a per-run `shellTimeoutMs` (or per-command timeout) passed to every gate/red/probe runner so Bash timeout >= measured suite time; evidence: every MATLAB gate death was at exactly 120 s. Second: authors should not verify RED themselves when the runtime has cold-start cost — one shared red run suffices.
- Deviation forced: engine stopped at authoring #2; remaining phases done by hand in one live MATLAB session (tests transcribed by Fable, implementation transcribed from the build plan, one Sonnet agent for the 10-edit UI file, one Opus review lens, headless uifigure smoke instead of Playwright). Test-first kept (per-file RED verified by authors), mutation probe skipped.

## 2026-09-05 · portal-switcher · feature · major · ui:true · engine→light-loop

- Cost: ≥ ~$18 output-priced (readers 590k Sonnet, builder 297k, Opus review/fix/re-check 570k, Sonnet fixes/drive 387k; engine phases unpriced). Wall-clock: planning 1h30 (3 reader rounds + 5 artifacts, npm ci 38 min in parallel); engine 2h00 (23:28→01:52Z) with ZERO production code; light loop 2h20 → SHIP.
- Caught real defects: the Sonnet BUILDER (a stray `;` inside JSX from Fable's own exact-code block — tsc/lint blind to it); Opus refute-first REVIEW (F2: `useSearchParams`+page-level Suspense blanks the prerendered `/login` shell — a real UX regression; F3 `request.url` vs `url.clone()`; F1 copy drift); the RE-CHECK (stale code-map row). Engine phases caught nothing about the product: grounding = line-number nits; red audit + 66-min remediation = test-shape nits on brand-new-module tests whose red was tautological.
- Wasted: Baseline 17 min running `jest --ci` and `next build`, both broken on master (pre-existing flaky suite; react 18/19 drift) → excluded anyway; red audit misread WP7's post-deploy e2e specs as "never authored" and remediation pre-wrote them; 3 reader rounds because SendMessage is disabled (relaunch per follow-up); 13-worker Jest × parallel agents on an I/O-bound host (Defender + another session's 60-min `npm ci` + Docker).
- Knob candidate (evidence above): a **slow-host profile** — `--maxWorkers=4`, scoped-only baseline (never the full suite/build), sequential waves, and NO Opus audit/remediation when every red-gated test targets a not-yet-existing module (a mechanical "0 of N pass" check suffices; behavioral proof = the HIGH-risk mutation probes). Second candidate: light loop by default for ≤10-file bounded features whose production code Fable writes verbatim — here 2h20 to SHIP vs 2h00 of engine with no code.
- Deviation: owner stopped the engine at 01:52Z (host I/O); run finished on the light loop; ledger row hand-assembled from journal + agent usage (engine tokens null).
- Ship addendum (05:10Z): PR #614 squash-merged as master `7aa20e71` at 04:57Z; Railway web deploy SUCCESS within ~2 min (layer cache); deployment_status E2E run 33945980194: **124 passed / 0 failed / 26 skipped incl. all 8 new tests (CC-16..21, OP-23, BY-15)**; `post-deploy-check` all green. Traps hit, worth lessons: (1) `gh pr merge --auto` merges IMMEDIATELY when the repo has no required checks — and switches the local worktree to master + deletes the branch; a docs commit pushed in that second was orphaned (recovered by cherry-pick → docs PR). (2) In a fresh worktree turbo's cache replay never runs the jest campaign reporter, so `.campaign/runs/mobile.json` was missing and `campaign-check` rejected the push with 8 phantom "undischarged" claims — run the suite once directly. (3) Jest 5 s default per-test timeout fails RTL suites as _timeouts_ under pre-push load on a slow host (two different tests in two runs) → `testTimeout: 30_000` + RTL `asyncUtilTimeout: 10_000` in apps/web. (4) Master moved twice during the ship window (other sessions merging) → two rebases; bookkeeping files (code-map CHANGELOG/_meta, cost-ledger) conflict every time — candidate: append-only ledgers should use `merge=union`.

## 2026-09-04 · F25-calendar (B59/B90/B91/B118) · bugfix · major · $58.95 · ~9h52m · 81 agents / 10.2M subagent tokens

- Caught (all three after a fully green gate, by the Fable FINAL PASS alone): the D6 repair script gated `--allow-expiring-rows` on a `now` snapshot taken BEFORE its blocking type-back prompt, so an `--execute` run straddling a UTC midnight writes a live licence into the past ungated; its headline safety bound "~28 h earlier" was wrong (the repo's own PDT fixture moves 31 h, UTC−12 ~36 h) and was repeated twice in the runbook; and the revenue-trend sibling regression could not fail on the pre-fix body under `TZ=UTC` — the environment CI and the API image both run in. 6 review lenses and 159 refuter votes reached none of the three.
- Wasted: ~10 h wall-clock on a host carrying 20+ node processes (one jest suite = 75–100 s, so every probe cost minutes); and one final-pass MAJOR was a phantom — "a second bug-pipeline run (B185) is live in this worktree" was inferred from a sibling ARGS FILE's `workdir` field for a run that never started (planning artifacts only, and this run's own RESUME card forbids launching it until the close-out commit lands).
- Knob candidate: any test whose oracle depends on host-local time must take the zone as DATA, and the red gate must not accept it otherwise — evidence: three tests in this batch were green against the buggy body under `TZ=UTC`, and an in-file `process.env.TZ` pin is inert under jest (measured here: the sandbox gets a copy of `process.env`, so the assignment never reaches Node's timezone cache). What worked was a Date whose local getters disagree with its ISO view — it discriminates on every host.
- Deviations: launched without the two invalid `dependsOn` entries (WP-WEB→TP-WEB, WP-MOB→TP-MOB — a test package is not a work-package dependency); `campaign-check` was excluded at Baseline as a bad command because a stale PARTIAL `.campaign/runs/web-e2e.json` sat in the worktree (the documented Playwright clobber trap) — moved aside and re-run clean at close-out.

### ocr-gate-observe-first — ship addendum (routeflow-3a, 2026-09-05)

- Landed: PR #616 squash-merged as 7281e4d7 at 14:57Z, ~56 h after the client report; code was done in ~6 h, the rest was coordination.
- Caught (real): none new in ship — the fix's specs (27/27, then 24/24 after the master merge) and CI verify stayed green throughout.
- Wasted: two verify-hook pushes failed on 5 s Jest timeouts while other sessions ran verify/Docker on the same host; a local api-image build stalled inside `RUN npm ci` beside a verify (env-blocked lane); four PRs merged inside the held window → PR conflicted on 4 ledger files only (LESSONS.md, lessons `_meta.json`, code-map `_meta.json`, cost-ledger.jsonl); `gh pr merge` classifier-blocked for agents → owner/peer merge; a wrong "machine slept" hypothesis steered effort for an hour (audit: uptime unbroken).
- Knob candidate: keep shared-ledger edits OUT of feature PRs (docs-only follow-up PR) + `merge=union` for cost-ledger.jsonl; evidence: every conflict this run was a ledger file, zero source conflicts. Second: never run the local Docker lane beside the verify hook — serialize (a stalled build starved the host).
- Deviation: bugfix engine died at 53/54 agents (session death); close-out salvaged by hand (routeflow-44); ledger row hand-written (stub result.json has no phaseReport); local:validate not run (Docker stalled) — gates were CI + post-deploy-check + live probe.

### bugflow docs plan — light loop (Fable session, 2026-09-04→05)

- Shape: 4 Sonnet writers from one shared brief (23 files, 3,920 lines) → Opus refute-first review → Sonnet fix round → Sonnet #597-rebase pass; ~3.3M subagent tokens; docs-only PR #620.
- Caught (real): Opus review 70 findings / 41 blockers — legacy claim grammar surviving in one doc, `prove`/`verify` writing status against the one-writer rule, Takeable missing `needs:human` (infinite re-claim loop), a worker-template gate line that let an API change ship without `local:validate`; a citation audit after #597's renumbering found two stale lesson ids (L-061→L-066, L-036 archived).
- Wasted: most blockers were VERIFY hedges on decisions ruled AFTER the writers launched; two Claude Code process exits killed the first Opus review outright and interrupted the second (its report survived only because it was told to write to disk before returning); a recursive `grep -r | head` orphaned for 2 h on Windows (no SIGPIPE).
- Knob candidate: issue the architect rulings BEFORE the writer fan-out — evidence: 24 rulings issued mid-run dissolved 41 of the 70 findings; and every long reviewer writes its report to a file first — evidence: two process exits, one review lost.
- Deviations: no pipeline engine (owner-approved light loop for docs); no cost-ledger row (docs-only; shared ledger kept out of the PR per the #616 addendum); commit/push only after the owner's in-session go; the leader session holds the merge order.

### imp-wave-e-structure — ship addendum (2026-09-05)

- Landed: light loop (Sonnet build → Opus refute-first review → Fable fix round) as PR #621 (`60d10e66`) after four rebases (16a486c2 → 8f136b9a → 7281e4d7).
- Caught (real): the branch's own guard spec (`no-single-schema-path`) false-positived on a `//` comment in a file from #597 — root cause an apostrophe inside a regex literal desyncing the comment stripper (20 other files carried the same construct); fix = "unterminated quote on a line is regex text" + 2 cases, verified over 860 files.
- Wasted: lesson ids collided at every rebase (L-067 → L-071/072 → L-072/073) — ~45 min of renumbering.
- Knob candidate (evidence: 4 collisions in one day): reserve lesson ids at branch creation from a shared counter, or number them only at the final rebase.
- Deviation: the deploy-triggered E2E ran only inside a long public window (owner-chosen, watchdog 120 min).

### imp-02b — ship (2026-09-05)

- Landed: PR #623 (`1ebd4f54`) after three rebases; DB lane proved exactly-once cron ticks.
- Push refused 4×: (1) a 5 s Jest timeout misread as host contention; (2) same test on a quiet host — real defect: #612's newer cron-site spec lacked the db-locks pass-through mock the @LeaderCron wrapper needs (fix + sweep of all 13 sites); (3) verify green but `campaign-check` failed on 9 phantom claims — turbo replayed the mobile test task from cache so `.campaign/runs/mobile.json` was never written; (4) green after regenerating reports directly.
- Lessons: isolate a timing failure by running the spec alone on a quiet host before re-pushing; regenerate campaign reports with direct `npm test -w` runs before any push from a worktree.
- Knob candidate (evidence: 1 wasted 20-min verify): make the pre-push check refuse when a report file is missing rather than reporting phantom undischarged claims.

### imp-closeout (2026-09-05/06)

- One Opus xhigh review of the merged program diff (no blocker; 3 majors, 6 minors, 1 tenancy "major" REFUTED by a read-only prod trace — 7 NULL-tenant rows exist but #613 changed no read path) → Fable fix round → Sonnet/Opus executors → Opus refute-first re-check (1 blocker: unbounded `spawnSync gh`; 5 majors) → second fix round with a DB-lane spec for the backfill tool's `--live` path.
- Landed: PR #626 (`17e81c2c`) after a local master merge (the PR went CONFLICTING when two other PRs merged while it was open in the window).
- Caught (real): the refute-first re-check (unbounded retry loop, `docker-compose.yml` unhashed by turbo, a retries test that passed without retrying) and the prod dry-run (the tool refused all 7 rows — the parent runs were NULL too → one more cascade level).
- Knob candidate (evidence: #626 needed a second push + window because master moved underneath it): one PR per public window.
- Costs: subagent tokens ≈ 2.9 M across 25 agents for the close-out alone.

## 2026-09-05/06 · registry-guards (sync --check, move --tier) · dev · small · engine→light-loop after an account switch · ~$17 light-loop half (engine half unpriced) · ~2h45 by hand

- Shape: engine (Baseline → tests → red gate, 1 remediation → WP-GUARDS/WP-DOCS → post-implement PASS) stopped mid-review by the account switch; resumed by hand: ONE Opus refute-first lens → Sonnet fix round (8 findings) → Opus re-check (HOLDS) → Sonnet close-out executor → finisher. Tokens: Opus lens 210k, prep reader 192k, fixer 221k, re-check 212k, executor 228k.
- Caught (real): the Opus lens — T13b (the whole point of R9) passed vacuously from any non-root cwd (empty catalogue → "mirror" + exit 0), and the triage `move` silently dropped `--why` while SKILL.md's own example passed it; it also PROVED the build plan's `JSON.stringify` oracle would have refused every push (213/213 records differ on a boolean-vs-string field) — the implementer's `renderFront` deviation was right, and the plan's `roundSha` field never existed. The re-check then caught that the new count was `catalogue.length`, not records compared (a second, smaller vacuity) — fixed with a `seen` counter.
- Wasted: the interrupted 14-agent review pass (0 findings captured, results untrustworthy → re-run as one lens); the build plan asserted two facts about master from memory; the close-out plan was written against a stale ledger (B106 already `done`, B185 already `proven` on master) and had to be corrected by the prep reader.
- Knob candidate (evidence: both plan errors were "facts about the tree" stated from memory, and both ledger-state errors were "facts about master" stated from a day-old handoff): a Haiku grounding pass over every build-plan / close-out-plan claim of the form "X exists / X compares Y / row R is in state S" before authoring or executing.
- Deviation: no engine resume (same-session only); B213 got its `REG-B213` token by extending the `REG-OCR-1` describe title (campaign-check matches fullName); the lessons register is now byte-bound (39.7/40.0 KB) after L-080 — the next entry must archive two.

## 2026-09-01→06 · F09 credit-notes wallet integrity (B66 B67 T1; B18 B19 T2; B13 refuted) · bugfix · major · engine→light-loop after an account switch · ~$21 light-loop half (engine half unpriced) · ~5h by hand

- Shape: engine (evidence → Opus refutation → Fable ruling → tests → red gate audited twice → P1/P2/P5/P6/P7) stopped at Implement by the account switch; resumed by hand: Sonnet reader → Fable oracle ruling → Sonnet stage A (T6/T7 outcome oracles + P3) → Sonnet probe ladder (alone) ∥ two Opus lenses reading committed content via git → two Sonnet fix rounds → P8. Tokens: reader 201k, stage A 162k, probes 199k, lens A 239k, lens B 222k, fixers 337k.
- Caught (real): lens A — the new `create()` guard made `returns.processRefund` throw AFTER its RECEIVED→REFUNDED claim had committed (refund lost, unrecoverable); the void cap ran at READ COMMITTED beside a Serializable sibling (stale `amountUsed` → `amount < amountUsed`); a fifth hand-rolled status literal on the advance wallet; the delete-door sibling (filed). Lens B — spec 28's heading locators would strict-mode-fail on the deployed build (top-bar h1 + page h2), and the REG-B18 fixture could never go red. Both lenses found the same raw-URL callers of the deleted route in two QA scripts that a symbol grep missed.
- Refuted (by Fable, on money grounds): "the cap destroys return-backed credit" — a voidable invoice carries no external money and wallet money is released first; R5 stands.
- Wasted: the RESUME card carried a stale claim (T6/T7 were the open blocker) that a 10-minute reader disproved — P2 had shipped the guard; the RESUME's "1 excluded command?" doubt was likewise empty. A whole-file revert probe was feared to break compilation; both compiled and failed on assertions, so the fallback was never needed.
- Knob candidate (evidence: 2 of 3 majors were downstream of the primitive, not in it): the bugfix radius sweep should follow every NEW throw/return added to a primitive out to its callers' transaction boundaries ("what state was already committed when this now throws?") — a caller-side lens, not a sibling-pattern grep. Second (evidence: both lenses spent effort re-deriving the diff from git): give reviewers a pre-built `git show HEAD:` snapshot dir when the tree is being mutated by probes.
- Deviation: probes ran on the working tree while both lenses read only committed content through git (safe overlap); `prove --pr` for B66/B67/B18/B19 waits for the PR number (second push); B13 has no `refuted` ledger state — stays queued with a Root-cause note, owner decides the feature.
- Ship addendum (07:2xZ): push #1 was refused by the hook's `campaign-check` alone — "B90: no test titled with REG-B90 found in the jest report": turbo replayed the mobile `test` task from cache inside `npm run verify`, so `.campaign/runs/mobile.json` (the only report carrying B90's REG tests) was never regenerated even though the master merge changed mobile files. Regenerated it with a direct `npx jest` in `apps/mobile`, re-checked standalone, re-pushed in the same slot (L-034's trap, third occurrence in two days — knob candidate: have `campaign-check` refuse on a report OLDER than the newest commit touching that workspace, instead of reporting phantom undischarged claims).
- Ship addendum F09 (08:3xZ): pushed dcc6f0a0 → PR #636 (draft, W2) on the FIRST hook run — no report replay this time because every F09 workspace tree differs from master (turbo had nothing to replay), which is the mirror image of the registry-guards refusal: the L-034 trap bites exactly the branches that do NOT touch a workspace. Two master merges (243325d2 then 0b715128) cost one `_meta.json` conflict each and one LESSONS.md rebuild (master − L-045 + L-081); the sibling bug filed by P8 as B213 collided with #635's OCR B213 and was re-filed as B214 after the merge — knob candidate: `bugs.mjs file` should refuse on a tree behind origin/master, or ids should come from a shared counter.

## 2026-09-06 · bugs.mjs self-test lock-fixture flake (CI run 34019219777) · bugfix · small · light loop · ~1.5 h

- Shape: one Sonnet reader (CI log + fixture + lock code, 190k tok) → Fable cause ruling → one Sonnet fix round → Opus refute-first re-check → gates. No engine.
- Caught (real): the reader — the "flake" was a VALUE COLLISION: the fixture forged `bootAt = now − 20 min` and `pidAlive`'s 5 s boot-stamp slop accepted it whenever the runner's uptime was ≈ 20 min at that step (the CI log gap of 10.06 s = the waiter's full spin); failures 2–4 were the give-up cascading through a shared lock dir. The lead's prior read ("runner-timing flake, re-run it") would have recurred on every cold runner whose verify reached the self-test at the same uptime.
- Wasted: nothing material — the reader's single pass was enough; no red-first repro was possible without faking `os.uptime` (deviation recorded).
- Knob candidate (evidence: 1 of 1 "flakes" this fleet chased today was a deterministic collision): before re-running a CI job, spend one reader on the failing assertion's INPUTS (what value did it compare, where did that value come from) — a re-run hides a collision, it does not refute it.
- Deviation: repro-first not possible on a dev box (uptime days); non-vacuity established by the mutation table in ruling.md; pushed inside W3 with the lead's docs PR (scripts/ outside Railway's watchPatterns — no deploy).
- Re-check addendum: Opus HOLDS — collision confirmed as the only code-consistent cause; two LOW fixes taken (age regex `/last resort|abandon/i`; `rmSync` retries for Windows EPERM); the lessons register is now at 40.0/40.0 KB — the next entry must archive two.
- Ship addendum (W3 push #1 refused): campaign-check "B66/B67: no test titled with REG-B66/REG-B67 in the jest report" — the THIRD report-replay refusal in one day (registry-guards mobile, now lock-liveness api): whenever a branch's workspace tree is byte-identical to master's, turbo replays that workspace's `test` task and the machine-local `.campaign/runs/<ws>.json` keeps whatever tokens it had when it was last actually generated, while the ledger has moved on. Evidence is now three-for-three; the knob is no longer a candidate but a demand: `campaign-check` must refuse a report whose mtime predates the newest commit that touched that workspace's tests OR the newest ledger change, and `npm run verify` should regenerate the report (not replay) when the check names a token the report lacks. Until then the ritual is: direct `npx jest` in the workspace, `campaign-check` standalone, re-push.
- Ship (W3): pushed 389e2cbb → draft PR #638 after regenerating api.json (REG-B66 ×16 / REG-B67 ×12), campaign-check 87/87; CI on ubuntu is the proof.

## 2026-09-06 · campaign-check freshness guard (lead-assigned, owner-approved) · dev · small · dev-pipeline stages by hand · ~$25 (all light-loop agents; Fable turns unpriced) · ~2h50 (17:10→19:05Z)

- Shape: Fable discovery/spec/test plan/build plan → Sonnet reader (257k tok) → Sonnet test author (246k, red 10/11 on own values, T4 positive control) → Sonnet implementer WP-0..3 (246k) ∥ Sonnet docs WP-4 (261k) → Sonnet R9 partial-report round (205k) → Opus refute-first review (212k) → fix round → gates → close-out. No Workflow engine (the opt-in is the owner's, not a peer's).
- Caught (real): the READER corrected three facts the brief assumed — the campaign reporter writes no timestamp (→ R0 stamps `generatedAt`/`gitHead`, mtime fallback), four reports not three (`pricing.json` is T1 evidence), L-070 is not the git-env-scrub lesson — and found the trap LIVE on the author's tree (mobile.json stale + turbo HIT), which became the acceptance oracle. The TEST AUTHOR caught the dry-run reaching the repository's real turbo from a fixture (→ ruling: resolve `node_modules/.bin/turbo` from the ledger's own git root, never `npx`). The IMPLEMENTER's own gate exposed the L-063 twin (a scoped spec run rewrote api.json with an 11-test report that was fresh by time) → R9: the reporter stamps `partial`, the guard refuses it. The OPUS REVIEW caught a BLOCKER the whole design rested on: `git log -- <path>` prunes a merge that only inherits a change (TREESAME to the first parent), so the rule read the OLDER upstream commit and a report generated before a local `git merge origin/master` would pass as fresh — exactly the population of the four refusals; proved on the repository's own commits → `--first-parent` + a merge fixture (T15). Also: `computePartial` missed `--onlyChanged`/`--shard`/…, a future-dated commit would refuse forever (clamp to now), doc drift, and no test pinned the pathspec scoping (T16).
- Wasted: the live HIT oracle could not fire on the author's tree because editing package.json (a turbo global dependency) turned every cache entry into a MISS — the HIT path rests on T6/T14's injected dry-run; regenerating three reports for the final gate cost ~7 min (api 375 s).
- Knob candidate (evidence: the reader's three corrections came from reading 56 lines of reporter source + one `--dry-run=json` call): a build-plan grounding pass on every "the artifact carries X" / "there are N of Y" claim before the spec is written — the same knob registry-guards and lock-liveness demanded today, now three-for-three.
- Deviation: WP-4 ran in parallel with the implementer on disjoint files; the ledger rule intentionally refuses docs-only registry PRs until their author regenerates (lead ruling) — the ritual line is in the refusal text and the SKILL.
- Close-out: Opus re-check HOLDS (0 new findings; first-parent under-detection sweep over 1194 commits found no hole); fix commit df7494dd; local gates green incl. the live pre-step (3× fresh) and full check (87/87) on regenerated, stamped reports. The fixer agent paused mid-gate waiting on its own background Jest and never resumed — Fable ran gates 8–10 by hand (knob: a subagent that backgrounds a long command must poll it, not wait for a notification it cannot receive).
- Incident (19:0xZ): the fix-round Sonnet paused mid-gate waiting on its own background Jest, then RESUMED and ran a live red-run probe for T15 (temporarily removing `--first-parent` from the working tree) while Fable — believing it dead — was committing the same tree: commit df7494dd captured the MUTATED script (a grep that counted the flag in comments hid it), and the fixer's restore landed only in the working tree. Caught by diffing worktree vs HEAD before "ready to push"; restored in b28e8d65 and re-proved by the spec on HEAD. Lesson for the loop: a probe that mutates the tree runs ALONE (model-routing §4) — that includes a subagent that may wake up later; before committing a tree an agent touched, diff the code lines (not a token count) against the ruling.
- Ship (W4): pushed 93f6532e → draft PR #640 on the first hook run; the hook regenerated all three reports (package.json is a turbo global dependency) and the new end-of-verify freshness check saw them fresh — 87/87 claims backed.

## 2026-09-06 · F18 billing plan change (B58 guard+routing, B73 clawback lock, B107 add-on/Stripe refusal) · bug · major · engine wf_20aee88d-d55 · $57 / 9.41M subagent tokens / 4h34m · ENDED UNCLEAN (14 remaining, 10 major)

- Shape: Fable S1–S5 → Haiku baseline → Sonnet tests (T1–T12, 4 spec files + e2e 33) → red gate (2 attempts; remediation rewrote 7 preview tests to fail on their own oracle) → Sonnet implement P1–P5 → Opus lenses (30 raw, 26 confirmed) → verify on-dispute (39 votes, 16.7% first-vote refuted, 2 disputes both dropped) → 3/3 revert probes caught → Fable fix rounds 1 (28 fixes, 3 routes) + 2 (4 fixes, all Opus) → final pass second read → 12 new findings the rounds never saw.
- Caught (real): the FINAL PASS's second read, not the lenses — the change is the first product caller to arm downgrade markers, so the reads it ordered (period-end cron, non-web endpoint callers, Stripe sync writer) surfaced 7 live defects in files OUTSIDE the packages (platform-admin, billing-cron, billing.service webhooks) plus alias/custom-plan holes in the preview. The radius pack (4 files) was too narrow for a state machine whose consumers live elsewhere.
- Wasted: UI verify never ran (no driver surface for a server-routed chooser); the round-1 e2e work (T4 Playwright RED unobserved, pending-deploy) cost review cycles for no local proof; ~1.0M tokens in round 1 for 28 fixes of which 5 were duplicates of one hazard (retainedUserIds:[]).
- Knob candidate (evidence: 12 of the 14 remaining findings came from the final pass's "reads worth their cost" list, and the engine's round cap of 2 stopped before a round could consume them): when the final pass returns findings AND rounds remain unspent by cap only, run one more Fable-planned round before ending; equivalently, seed the radius pack from `git grep` of every WRITER of the state fields the fix arms (downgradeToPlanKey etc.), not from the build plan's file list.
- Deviation: lead continues by the light loop (fix-round-3.md: 6 fixes across 4 api files + web; Opus executors on disjoint files, Haiku regate, Opus refute-first review, full gates) rather than resuming the engine on the implemented tree (standing rule). Finding 0 (orders idempotency, sibling sweep) deferred to a new registry row.

## 2026-09-06/07 · F08 returns end to end (B53 B68 B69 B82 B20 B61 B166 B75 B128 B21) · bug · major · engine wf_85fd24ba-6e2 KILLED mid fix-round-1 (51 agents; no result.json) + lead light-loop rounds 2–4 (wf_22a1aee1-379 507k · wf_28c74ccf-326 663k · wf_6b066a24-629 484k) · landed #645 → 99d5b87a

- Shape: engine to fix round 1 (7 executors, 36 fixes) → STALL: one executor's Edit tool call never returned (in-process hang, no child process), the barrier waited 90 min, TaskStop "killed" but the loop never released, resume refused 3× → new loop from the tree: Opus assessor/completer → Haiku regate → Opus refute-first review with CONSUMER reads → gates; two more lead-designed rounds; land.
- Caught (real): the F18 lesson applied — round 2's consumer reads found the two majors (web resolve toast hid three new permanent refusals; the mobile helper, the only oracle, had zero tests for three owed behaviours); round 3's review caught a pin that was honest only by fixture (invoiceNumber never selected); round 4 closed it with a fixture PROJECTED through the real select + a negative pin.
- Wasted: ~90 min of wall clock on the stall before the lead noticed (no liveness signal from the engine); an executor's line-number probe raced another executor on returns.service.ts (no surviving damage, but unproven until the recovery's integrity step).
- Knob candidates (evidence: the stall's transcript ends on a tool_use with no result; the probe incident is in the journal): (1) the engine emits a heartbeat line per agent completion and the lead arms a silence Monitor (>20 min → inspect); (2) probes never mutate by line number — checksum revert only; (3) a "consumer reads" stage after the fix wave (already the lead's habit) becomes an engine stage.
- Deviation: deliveredQty composition (B53×B128) dropped from the PR by lead ruling (needs a column + migration; Railway route down; wave landing) → re-filed as a row; a `roundMoney` one-liner applied by the lead as the labelled merge-time correction. No ledger row (killed engine has no phaseReport) — the three loop runs' token counts are above.

## 2026-09-07 · F23 messaging engine honesty (B145 B160 B180 B182 B183a) · bug · small · engine wf_bdf9d43c-cf1 · $18.61 / 3.58M tokens / 2h35m · CLEAN

- Shape: Fable S1–S5 (capability seam; PORTAL = skipped; DEFAULT_ON drops all four unwired keys) → Haiku baseline (1 artifact path fix) → Sonnet tests (API + web RTL) → red gate properly red on attempt 2 → Sonnet implement P1–P4 → merged Opus review (5 confirmed) → Fable fix round 1 (6 fixes, ALL test-side: an oracle defect, three strength gaps, a stale comment, a path) → round 2 (1 vacuous assertion removed and re-pinned behaviourally) → clean.
- Caught (real): the review's mutation probe proved one "INTERNAL untouched" assertion vacuous (every INTERNAL event is NO_TRIGGER today) — the fix pinned the real current state so the first wired INTERNAL event turns the test red; the static scanner gained a LOW_STOCK negative control.
- Wasted: little — 35 agents for a clean small run; one dead agent result (empty) charged nothing.
- Knob candidate (evidence: both fix rounds changed only tests; zero production findings survived review): on small runs whose confirmed findings are all test-side, skip the second re-gate of the full suite and run only the touched spec files — ledger evidence needed before changing the engine.
- Deviation: none. Landed via the normal flow; residual rows filed in the follow-up (portal inbox feature, PAYMENT_REMINDER toggle governs nothing, stub-written Message rows report, B37 deferred feature, B181 refuted).

## 2026-09-07 · F12 route delivery windows (B147 B161 B177 + B31 deletion) · bug · small · engine wf_433d8eb7-8a0 · $27.02 / 4.83M tokens / 3h27m · ended clean:false (2 minors) → lead rounds 3–4 (wf_bc86681d-ccf 440k, wf_c6b7054a-a5a)

- Shape: Fable S1–S5 (one invariant: window-feasible order at the shared seam on all three solver branches) → baseline → Sonnet tests → red gate 2 attempts (structural fixed by retitling T6 into the REG-B177 token; REG-B161 stayed an existence check) → implement P1–P5 → merged Opus review (11 confirmed) → Fable rounds 1 (14 fixes: monotone window pass, variants seam, honest clock for started runs, early-arrival waiting model, windows-only analyze) + 2 (5 fixes) → 2 minors left by the round cap.
- Caught (real): the review found the seam's consumers again (variants branch, started runs with no honest clock, both dispatch modals) — same lesson as F18 (L-084); round 3's reviewer caught that bounding the ORS vehicle window turned an unreachable stop into a parser throw + a mislabelled fallback — a defect the fix itself introduced.
- Wasted: a regate command that was a broken INVOCATION (eslint on files → rule-loading error) skipped the probe and final gates for a round; a small-scale run has no mutation probe, so a soft red gate (existence oracle) went unchallenged until the lead added a checksum-revert probe by hand.
- Knob candidate (evidence: this run's REG-B161 `toBeDefined` passed the red gate on absence; F18's final pass found 12 defects small runs would never see): small-scale runs get ONE checksum-revert probe on the primary fix file by default; and every regate command must be one the Baseline proved (the eslint form here was never baselined).
- Deviation: round 3/4 by the light loop; deferred residuals recorded (unchecked unassigned on clockless underway runs; midnight reset effect).

## 2026-09-07 · marketing-port (routeflow, feat/marketing-port) · mode feature · scale major · est $69.06 · wall 6 h 31 m (05:20→11:51Z, engine) · 94 agents · 11.87 M subagent tokens

- Caught the real defects: the FINAL PASS (Opus read → Fable decide) found the four that matter — middleware carve-out enrolls page paths only (brand assets/manifests/OG proxied to mobile on phones), three auth CTAs outside the carve-out, first-ever `next/image` with no `images` config under `output: standalone`, a dark-only PNG mark on a dark login panel; UI verify caught the unstyled 404 (fixed in-run) and a 2.72:1 contrast miss.
- Wasted: the perRound eslint command was a bad command from Baseline (pattern named a dir that did not exist pre-port) → zero lint coverage all run; the api final gate went red on the known `ci-freshness-guard-script.spec.ts` load flake (two engines + a docs agent on one host); marketing.css shipped as a 9,776-line concatenation (ux-spec asked ≤ 3,500) and two lenses spent findings restating it.
- Candidate knob (evidence above): Baseline should RE-RUN a bad perRound command after the first implement wave when the failure was "no files matching" — a path that the plan itself creates is not a broken command.
- Deviation: Fable designs round 3 as a light loop (middleware prefixes + mobile-seen cookie; `<img>` + tone prop; contrast; font dedupe); owner visual review before merge (public site).

## 2026-09-07 · F16-list-caps (routeflow, fix/F16-list-caps-numbering) · mode bugfix · scale major · est $49.62 · wall 3 h 51 m (09:31→13:22Z) · 75 agents · 9.42 M subagent tokens

- Caught the real defects: S2 refutation (Opus) corrected 5 of 8 registry fixes BEFORE any code (B89 half-wrong, B100 needs a year key + numeric backfill → split to its own run); the FINAL PASS found the three that matter after two engine fix rounds — a statement header mixing uncapped and capped bases, a vacuous e2e fixture (DRAFT invoice → $0.00 == $0.00), the buyer wallet tile vs a capped ledger; all 5 revert-fix probes caught.
- Wasted: `cd apps/api && npx jest --silent` was a bad command from Baseline (ci-freshness-guard T3 timing test 7.9 s > 5 s bound under host load + worker kills) → the engine ran the whole batch without a trustworthy full-suite gate until the final gate; the sibling sweep did not run (ran:false with 3 patterns given) — check the engine's bugfix-mode gate for siblingPatterns.
- Candidate knob (evidence above): pin `--maxWorkers=2` into every full-suite verify command by default; a load-sensitive spec must never be the reason a gate is "broken".
- Deviation: Fable designs round 3 as a light loop (lifetime sums via DB aggregate for the statement tiles; issue the e2e fixture invoice; truncation note on the buyer credit surfaces; overdue-status disjunct; DRAFT-count status scope; export productId; prototype-safe allowlists).

- **2026-09-08-B246-scan-fab** · bug-pipeline (bugfix) · scale minor · est $11.93 · 32 agents · 4 h 27 m wall-clock (host shared with three landings + a WSL restart; active work ≈ 1.5 h) · REAL DEFECTS CAUGHT: the review lenses (round 1: 8 findings incl. an inert FAB when the tap handler was wired to the wrong prop; round 2: 3 incl. a shared-component type that let a handler-less BarcodeFab compile into a dead button) — the fixes moved from the call site into `components/BarcodeFab.tsx` (outside the S3 file list; accepted). WASTED: the red gate never became behaviourally red as a set — on a renderer-less mobile suite, source-text REG specs give one honest oracle (mount count 0→1) and three derivative ones; the mutation-probe/sibling-sweep records are per-agent only because the aggregate result (>64 KB) was truncated in the task output and had to be reconstructed from journal.jsonl. KNOB CANDIDATE: cap the aggregate result size (drop per-phase notes into files, keep the summary under 16 KB) so `result.json` survives the harness; evidence = this run and the auth-redesign run both lost the aggregate. DEVIATION: UI verify skipped (no mobile renderer); owner device check after the next EAS build.

## 2026-09-08 · ul-rmc-papr (fs-offset-model, feat/ul-rmc-papr) · mode feature · scale major · est $9.83 · wall 6 h 24 m (06:05→12:29Z, of which ~5 h were machine-load-bound MATLAB gates) · 50 agents · 4.41 M subagent tokens · ended clean:false on a stale WP4 'partial' status only (final gate 18/18, 4/4 probes caught, 0 remaining)

- Caught (real): the first Gate (4 shape/class mismatches between Fable's exact code and Fable's own test oracles — a column paprAtProbDb vs a row, uint32 NRB — i.e. planner self-inconsistency, fixed by Opus build-fix) and the six lenses unanimously (the T14 oracle 'A5-1 is the top bar' was a single-seed measurement that did not hold at the study's per-RC seeds; plus a real barh overlap, mkdir after the 15-min loop, a bad-overrides fall-through, README file names, a T7 that could not tell > from >=). Every fix designed by the Fable planner; two rounds; nothing disputed or deferred.

- Wasted: ~5 h of wall clock — every matlab -batch gate ran 5–10× slower (a 3-RC plot test took 535 s) because another session's simulator tests plus ~10 hung matlab -batch orphans (mine and older sessions') left 1.2 GB of 32 GB free; a Sonnet WP4 executor burned two hung repro runs on 'cold graphics init' that was really memory starvation; the lead spent three figure-export probes that also hung. Also: the Workflow tool refused the worktree-staged engine copy (scriptPath must be under the session cwd) — one failed launch.

- Knob candidate (evidence: this run's phaseReport and the process list — 3 of 4 long pauses were MATLAB waits at 86 % CPU): before Baseline, a Haiku 'host check' records free memory, CPU and orphaned matlab -batch processes and the run refuses (or serializes MATLAB-bearing agents) when free memory < 4 GB; and a package that self-reports 'partial' must be re-evaluated against the FINAL gate before it can keep clean=false.

- Deviation: none in the engine; the lead killed only its own idle orphan MATLAB processes mid-run to free 2 GB; the full 51-RC study, README results, merge and OneDrive mirror are done by the lead after the run.

## 2026-09-08 · static-gain (fs-offset-model, main) · mode feature · scale major · est $~30 · wall ~14 h (00:30→14:30Z, light loop; host shared with the ul-rmc session for most of it) · 23 agents · ≈5.5 M subagent tokens

- Caught (real): the Opus review (refute-first) found the two defects that mattered — F1 the "perfect CSI = H=1" receiver (the planner's own design; its equivalence harness had been run at the one scale where the assumption is vacuous) and F2 presets merged onto an already-validated cfg leaving the derived allowance stale (the "tie" a builder relaxed T49' around WAS the defect); the timed full gate, not the unit suite, exposed F1 (blerA = 1). The contract correction (exponent ≤ 7, not a 9-bit word) came from the owner, not the pipeline — the spec had restated a contract as a bit budget (L-009).
- Wasted: ~2 h of Sonnet lanes + gates on the v1 plan (13-bit allowance) before the owner correction; ~0.5 M tokens of profiler-led vectorisation bought ~20 % (the floor was Toolbox channel estimation — L-010); every timing after 05:00Z was contaminated by 16–20 MATLAB processes (zombies + the concurrent session), so R52 is measured quiet only pre-memo (928 s) and the memo's value is unquantified; two Haiku gate runners ended their turns mid-run despite an explicit polling protocol.
- Candidate knob (evidence: gate breakdown 880/912 s in 13 integration tests, ~30–40 s fixed cost per run_scenario = pool builds; host CPU snapshots): a Haiku host check before any timed gate (agrees with the ul-rmc entry) and a session-owned background `until` watcher instead of a Haiku runner for gates; measure the pool memo on a quiet host before touching smoke budgets.
- Deviation: light loop, no engine; the Fable session did its own targeted fact-gathering greps rather than Sonnet readers (cheap, but against the letter of "Fable reads no file"); lane ownership violated once (L-008) and a "no other agent" premise proved false (L-013: a second session merged into main three times mid-run).

- **2026-09-08-F16b-invoice-counter** · bug-pipeline (bugfix) · scale major · est $26.40 · 58 agents · 3 h 50 m · REAL DEFECTS CAUGHT: the S2 refutation (design of record replaced: the per-tenant/per-year sequence already existed); the review round (mint outside the tx on two paths, an oversize imported number overflowing the int seed, an unbounded collision guard); the FINAL PASS (mint inside the caller's tx holds the counter lock to COMMIT → lock-order inversion with the driver stop-completion path + full-body serialization; the estimate generator ten lines above the hunk untouched) — three probes caught, harness clean. WASTED: two red-gate audits before the pins were behavioural (P3/P4/P6 green-today, source-text pins — L-060/L-087 class); the aggregate result (>200 KB) truncated again → journal reconstruction. KNOB CANDIDATE: run the final pass BEFORE the fix round on HIGH-risk runs (its lock/tx findings are design-level and would have shaped round 1) — evidence: this run's only unfixed findings were final-pass findings. DEVIATION: light-loop round 2 (Fable-ruled: standalone short reservation tx; estimates folded onto the primitive).
- Amendment (16:30Z): the "quiet" re-measure after the pool memo was not quiet either — 1640 s, 85/85 green, no MATLAB CPU contention but 49–75 % host load from non-MATLAB processes (OneDrive sync of the fresh mirror suspected); R52 stays unproven. Owner then retired the git repo (OneDrive is the single copy; no git) — a project without a repo has no code map/lessons routine; the records live in `model\notes\`.

## 2026-09-08 · 2026-09-07-ingestion-affa · bugfix · major · est $14.94 · ~2h20m active + a 5h resumed tail (79 agents, 4.93M subagent tokens)

- Caught the real defects: Gate & Review lenses (13 confirmed: XLSX branch could throw out of parseStatement; only-one-sheet ingest; no header-locator unit test; error-surfacing half of R4 untested; format-hint copy in two more places) and the 5 fix-revert probes (5/5 caught, all restored). Verify: 42 votes → 2 drops, 12 disputes all dropped — i.e. the fixers' refute-first was right every time.
- Wasted: the RESUME re-run re-executed every probe and a whole fix round live (probe prompts embed file checksums that changed after fixes → cache miss) — ~$7 of the $14.94 and 5 wall-clock hours for zero new confirmed findings; 12 stale review findings re-refuted against a tree the fixers had already changed. `mutationProbe.restoredVerified=false` is that same checksum drift, not a restore failure.
- Final pass (Fable over Opus reads) earned its keep: 8 remaining findings, 6 major — the in-engine fix planner's "merge every same-layout tab" widened the fix and created a cross-account merge trap; reparseImport gaps (LOCKED guard, notes, extractionPath); second-section-header rows. None of the six lenses saw them.
- Candidate knob (evidence above): key probe/fix-round cache entries on (plan, package, file path) rather than content checksums, or record checksums in the result instead of the prompt — the resume replays 138 entries and then burns a full fix round + probes for nothing.
- Deviation forced: run was killed by the host process once (session exit); resumed with identical args per the RESUME card. Owner stopped work after the engine returned; the Fable fix plan for the 8 remaining findings is written (fix-plan.md) and the light-loop script is staged, not launched.
- (Lead correction to 2026-09-08-signin-menu-hotfix) WASTED, as seen from the Lead's session: two verified pushes rejected by the `bugs.mjs` self-test timing checks ("index vs file", "lock order") before the audited skip, and a background bash chain that hung spawning PowerShell for the watchdog (never spawn PowerShell from a background bash; use the PowerShell tool).

## 2026-09-08 · fft-gain-control (DL Executable v2.4, MATLAB, no git) · mode feature · scale major · light loop (2 workflows + 1 verification workflow + 1 map bootstrap) · ≈1.8 M subagent tokens · ~2 h 10 m active wall (planning 60 m incl. two multi-minute MATLAB baseline runs; part 1 42 m; part 2 27 m)

- Caught (real): the requirement-verification workflow before any code (TD round-before-rotation is the observable, not the gain; "±1 LSB" was wrong, up to ±3 with double rounding; six of eight cfgs cannot run; goldens overwritten in place); the planning reproducibility check (checked-in vectors stale by the Dec-19 Xilinx factor, 0.99536×, so fresh baselines were generated BEFORE any edit); the Opus red audit (T14/T15 empty-difference vacuity → verifyNotEmpty); the Opus review (guard's own mat2str masking the error id; uncovered LTE-1024 / TD-4096 branches). Mutation probe 6/6 caught, all restores byte-verified; final gate 20/20 real execution, re-run independently by the reviewer and the re-checker.
- Wasted: the Sonnet docs executor did the artifact half of its brief and silently skipped the code-map half (re-check FIX-FIRST on docs only; Fable closed it by hand); three test-plan rows it wrote described tests that were not the ones built (T16b/T18/T19). Shell writes inside the OneDrive folder are sandboxed (even with the bypass) — every agent had to be told to use Write/Edit and the matlab MCP; the full engine was not usable (no git).
- Candidate knob (evidence above): a docs executor brief with two halves needs a structured return with one field per half (or two agents); a free-text "notes" let a half-done job read as done. Second: add a "reproduce the goldens first" step to S1 for any vector-based repo — it killed the R1 oracle here in 94 s.
- Deviation: light loop instead of the engine (no git); Fable did its own artifact/lessons/RESUME writing and the final doc corrections; the LTE cfg→runner wire is covered only by the Full-tagged T15 (recorded, not fixed).

## 2026-09-08 · 2026-09-08-r1-ingest (affa-cashbook, standalone S-Corp cash-book builder) · mode feature · scale major · est $23.76 · ~3 h active over 3 launches (19:03Z start; process exit during test authoring; first resume lost 49/59 agents to the session usage limit after 17 min; second resume 2 h 36 m) · 87 agents · 9.63 M subagent tokens

- Caught (real): the six Opus lenses (44 raw → 41 confirmed; Verify 43 votes, 1 refuted = 2.4 %, 1 dropped) — Posting-Date blocker, blank-balance guard, verifyHashes with no `missing` list, telemetry dropped before JSON.parse, readCsv swallowing quote errors, the CORROBORATING gate, run.ts exiting 1 on a stage subset; the mutation probe 9/9 caught with byte-verified restores; and the FINAL PASS (Opus read ×2, Fable decision) found every design-level defect the lenses missed: calendar-month sums compared to business-day statement cycles returning a silent 'ok' for unchecked months (84 of 96 on the real manifest), `--stage workbook` overwriting the deliverables from an empty build at exit 0, an AI cache key with no source identity, quarantine flagged but still feeding every downstream total, and two contradictory opening-balance sources in one workbook.
- Wasted: the whole first resume (~$0.67, 17 min, 49 dead agents — usage limit, not a defect); a Haiku grounding pass that reported PRICES/PRICES_AS_OF "not exported" from a stub the plan said would be written (two disputes for the planner); the baseline typecheck failure was a Sonnet test author's noUncheckedIndexedAccess slip, fixed by Fable by hand; two in-engine fix rounds ($8, 48 fixes) spent on lens findings while the five majors waited for the final pass.
- Candidate knob (evidence: this run + F16b — twice now every unfixed finding is a final-pass finding): on HIGH-risk major runs run the final pass BEFORE fix round 1 so its design-level findings shape the round; and treat a "session limit" agent failure as a pause-and-resume, not 49 failures.
- Deviation: `maxFixRounds` 2 exhausted, so the 19 remaining findings are fixed outside the engine as a Fable-designed light loop (fix-round-3.md: Fable wrote the type contract and the design; two Opus executors in parallel on disjoint files, one after; Fable gates and an Opus re-check follows).

- **2026-09-08-B263-scan-price-tray** · bug-pipeline (bugfix) · scale minor · est $10.33 · 33 agents · 2 h 22 m · REAL DEFECTS CAUGHT: S2 refutation (registry's tap count and host both wrong; the :806 mode ternary is the cause; the scanner never rendered the action pill; the price modal skipped rounding); review round 1 (the picker's Edit price path bypassed canEditPrice → drivers/cancelled orders could edit; an auto-ack silently satisfied the margin floor; a stale "last added" strip survived camera close); round 2 (strip leak via row-tap; margin-floor feedback missing on the picker write). WASTED: the red-gate audits ran before the oracle split (one expect per it) — plan tests as one oracle per `it` from the start. KNOB CANDIDATE: run the final pass before round 2 on minor runs too (the last minor was a wording/basis defect the lens could have caught earlier). DEVIATION: no UI verify (no renderer); probes not recorded at minor scale.

- **2026-09-08-numbering-siblings** (Group A: B267/B268/B269 + B277 pin) · bug-pipeline (bugfix) · scale major · est $52.98 · 58 agents · 4 h 28 m · 8.08 M tokens. REAL DEFECTS CAUGHT: S2 refutation (B268 was worse than filed — the importer UPDATED a live invoice; B269 raised to HIGH — Stripe settlement stall); red-gate audits (a green pin carried the REG token; 21 structural blockers); review lenses + final pass (credit-note SERIALIZABLE aggregate → P2034 burns the reserved number + raw 500; import idempotency flips PAID without a payment; unscoped Invoice-ID key; whitespace ids; PaymentCounter tenantId only on create). 4/4 probes caught. WASTED: the final gate ran full api jest while the worktree's packages/pricing dist + workspace symlinks were missing → 4 red suites that were pure environment (≈ 20 min of diagnosis); a ~$53 run is 5× the minor-scale average — 7 fix rounds with 51 fixes suggests the build plan under-specified the import branch. KNOB CANDIDATE: baseline should assert workspace resolution (`node -e "require.resolve('@routeflow/pricing')"`) and re-run it before the final gate; make the final pass run BEFORE the last fix round on major scale (its 2 majors needed a light loop anyway). DEVIATION: landing via light loop + Opus scoped re-check.

- **2026-09-09-train1-driver-teardown** (B111/B136/B137/B140/B150) · bug-pipeline (bugfix) · minor · est $19.65 · 46 agents · 5 h 18 m · 6.0 M tokens. REAL DEFECTS CAUGHT: S2 (B143 already fixed; B111 blast radius = file:// filter + bare catch; operator realm had no GPS stop; six sibling stores survive sign-out); review rounds (loginWithGoogle never rehydrated user-scoped stores; banner "dismiss all" could evict another driver's failures; identifier-name pins replaced by behavioural ones). WASTED: 19 fix rounds for 31 fixes — many single-fix rounds after the first two; a "minor" run took 5 h wall time. KNOB CANDIDATE: cap fix rounds at 4 on minor scale and hand the remainder to a light loop (evidence: rounds 3–19 averaged 1.4 fixes each). DEVIATION: two final minors fixed at landing.

- **2026-09-10-next-15** (apps/web Next 14.2.35 to 15.5.25 + React 19, clearing two CRITICAL GHSAs before the 2026-09-30 allowlist expiry) · dev-pipeline (feature) · major · est $15.80 · 73 agents · 3 h 10 m · 7.93 M tokens. FABLE OUT OF USAGE CREDITS all run: S4/S5 authored by Opus (documented fallback) from a 4-agent Sonnet gather that caught 4 spec errors before any code (static tests live in apps/api/src/common; apps/api has no jest.config file; 54 web Jest files not 50; customers/[id] has TWO params sites). In-engine, fix-plan r1/r2 and final-pass decide all died and fell back to Opus @ xhigh with fallback=true, completed=true, 22 fixes, 0 deferred - the documented fallback held. REAL DEFECTS CAUGHT: red-gate audit (a vacuous helper-sanity test that could never go red; a loose swc major-15 oracle a stale ^15.0.0 would pass); lenses + final pass (policy guard made to REQUIRE an empty allowlist, blocking every future entry and leaving its shape loop unreachable; untyped useParams means tsc no longer catches a mistyped param key; stale lockfile runbook; R8 compose proof never run). The fix round correctly moved the 4 guards into the repo-truth lane (L-062) and noticed the React bump also moves the root copy apps/api resolves for PDFs (new unmocked pdf-render-smoke; both PDFs render). WASTED: that repo-truth move silently voided the recorded proof - red gate, final api gate and mutation probe all ran the MAIN api lane, which now ignores the 4 specs, so "api 4,417 green" said nothing about them; close-out re-ran repo-truth by hand (44/44) and re-probed the 3 changed guards (all red on their own defect, byte-verified restores).
- KNOB CANDIDATE (evidence: this run - three recorded proofs executed zero of the guards they certify): after any fix round that edits a Jest config, testRegex or testPathIgnorePatterns, re-derive the redGate/final/probe commands from the new config and re-run the red-gate tests once before the final gate. DEVIATION: R5 fonts deferred (font binary download needs owner approval); ESLint forced to 9 because Next 15 next lint reads flat config first (enforced rules unchanged, core-web-vitals only); local:up from a worktree defaults the compose project to the directory name and hits the hard-coded container_name conflict - re-ran with -p routeflow.

- **2026-09-10-train4-run-a** (B134/B135/B214 order money path) · bug-pipeline (bugfix) · major · est $25.14 engine + light loop (~0.9 M subagent tokens; the Opus executor's own count was lost to a session crash) · 50 engine agents · 3 h 39 m wall incl. a 1 h owner pause and a resume (args amended at resume: final DB gate scoped to the touched spec because the whole local:test:db lane was ordering-dependently red at Baseline). REAL DEFECTS CAUGHT: red gate properly RED (10 REG assertion failures, 7 pins green, 1 attempt); lenses + two Fable-planned fix rounds (a THIRD B214 door in forceConsolidateCustomer the plan missed; deleteOrder revive-then-orphan after credit release; ADD_ITEM merge target from the locked row; a round-2 lock-order inversion that would have deadlocked against reopenStop, redesigned as a NOWAIT stop lock); probes 3/3 caught, restores byte-verified; the FINAL PASS (Fable @ high, no fallback) refused sign-off with 4 majors the lenses missed (shippingFee and CHANGE_QTY pricing still from the pre-tx snapshot; un-send counting payments without recordPayment's Invoice lock; the NOWAIT conflict surfaced under a terminal client code) -> fixed as a light loop (Fable design, Opus execute, Opus refute-first review) whose review caught two of Fable's own design errors (a guard-internal Invoice-first lock closing a 40P01 cycle with voidInvoice; a HANDLED_CODES entry silencing the only toast on delete surfaces). WASTED: BOTH recorded final Jest gates were void — `npx jest --reporters=default <paths>` makes Jest read the paths as REPORTER modules (Baseline: "Could not resolve a module for a custom reporter. Module name: src/orders/"), and the DB command found 0 tests because the spec was a deliverable; the engine excluded both and the recorded final gate proved only tsc+lint (the Next-15 run's zero-test gates were the same defect, mis-attributed then to the lane move); gates re-run by hand (778/778, 5/5, later 813/813). KNOB CANDIDATE (evidence: 2 runs): a redGate/final Jest command marked bad at Baseline is a BLOCKER, not an exclusion; and the plan templates must put --reporters=default LAST and add --passWithNoTests to any final command whose only targets are new specs. DEVIATION: owner manual stop + resume; final-pass majors fixed outside the engine (merge-done-work rule); web client branches reverted after review (global mutation toast already surfaces the message).

- **2026-09-10-train4-damage-report** (read-only prod damage counts for B134/B135/B214/B215/B216/B131/B141, DECIDE-23) · dev-pipeline (feature) · small · est $9.74 · 29 agents · 2.45 M tokens · ~1 h 50 m active across two launches (the first died with the session crash at 17:57Z after the second red audit; resumed from the journal cache — Baseline/authoring/red gate replayed, only Implement onward ran live). REAL DEFECTS CAUGHT: red audit (T2 Math.max([]) -Infinity vacuity; T13 toBeDefined; single-file JSONL scan; a pre-existing TS2322 in the db fixture); lenses (armed-downgrade dates string-sorted instead of chronological; B215 LAG window CTE unfiltered → statement_timeout risk on prod; missing bucket labels; weak near-miss mutation); round 2 (CTE scoped by the ORDER's tenant, not the nullable OrderRevision.tenantId, with a NULL-middle-revision seed red on the old code; B135 late-merge lower-bound pin; UTC-offset-proof B216 fixture). Final gate real: 5 + 9 executed; hand re-run 5/5 + 9/9. WASTED: a TS2307 burst from a stale packages/pricing dist cost an Opus "environment fix" round (build only; npm ci not needed); the red gate can never be behaviorally red for a create-the-script feature (all tests fail on existsSync) so clean=false is structural noise, not a defect. KNOB CANDIDATE (evidence: this run + numbering-siblings): treat "all red tests fail on the same precondition because the deliverable does not exist" as a recognised red-gate state (structural RED accepted, no remediation round, clean not penalised); and Baseline should build workspace packages (packages/pricing) before typecheck. DEVIATION: --passWithNoTests added to final Jest commands at launch so Baseline keeps them; prod run handed to the owner (classifier blocks the agent).

- **2026-09-10-train4-run-d** (B131 removed customer crons/manual invoice; B141 removed customer keeps portal access) · bug-pipeline (bugfix) · major · est $21.72 engine + light loop (2 rounds, ~0.9 M subagent tokens) · 62 engine agents · 2 h 37 m · 7.42 M tokens. REAL DEFECTS CAUGHT: red gate behaviorally RED first attempt (8 REG on their own wrong values); lenses + Fable fix rounds closed six siblings the plan fenced out (google-oauth sellerCount, requestSeller/acceptInvite, staff/driver create, web buyer context activeSeller, suppressed-count warns); probes 5/5 byte-verified; the FINAL PASS second read found two majors the lenses missed (Google invite redemption = a THIRD token door; authorization-expiry = a FOURTH customer-reaching cron — the plan said two); the light loop's Opus review then found four more self-serve write doors in the same 15-min token window (updateOrderItems is a money write) — a grep for `userId: user.sub` found 9 resolutions, the plan named 1. WASTED: siblingSweep reported ran:false skipped:"no-patterns" although the args carried two siblingPatterns (same in Run A) — the engine never swept; the doors the final pass/review found are exactly what a sweep on `customer.findFirst({ where: { userId` would have listed; pipeline-args.json grew past 4 KB after prettier (4,580 B) — the resume-truncation edge. KNOB CANDIDATE (evidence: 2 runs): fix or verify the siblingPatterns plumbing (result.siblingSweep.patterns must equal args.siblingPatterns.length or the run is a blocker); and for "fence" bugs make the S3 ruling enumerate every resolution of the actor (grep-derived) rather than the reported site. DEVIATION: Restore-UI product question deferred to the owner (DECIDE-28); W2/W3/W5 REG tokens retagged as pins (green-today tests must not carry REG).

- **2026-09-10-train4-run-c** (B216 Stripe reinstatement leaves a pre-lapse downgrade armed) · bug-pipeline (bugfix) · small · est $21.08 · 27 agents · 1 h 10 m · 2.65 M tokens. REAL DEFECTS CAUGHT: red gate behaviorally RED first attempt (REG-B216-A/B/C on their exact predicted values); Gate & Review found the missing fourth-site pin (suspendOverdueTenants must NOT disarm — T7, asserted beside the suspension write so it cannot pass vacuously); manual revert probe at close-out (small scale skips the engine probe): A + C red, B untouched (sibling path), restore byte-exact. WASTED: $21 for a one-file small fix — round 1 spent an Opus "environment repair" wave on a check-types failure ("Cannot find module @routeflow/pricing" in 47 files) that the fixer itself then disputed as a wrong-cwd artifact (the gate agent had run outside the worktree; lockfile, node_modules and dist untouched, verified); the same phantom stayed in remainingFindings as a blocker, so clean=false on a green tree; siblingSweep again skipped "no-patterns" with two patterns in args (4/4 runs today). KNOB CANDIDATE (evidence: this run + damage-report): gate agents must run every command with an explicit `cwd` = workdir and record `process.cwd()` in the gate result; a Baseline that passed (3/3 here) makes a later identical-command failure a cwd/env suspect first, not a fix round. DEVIATION: none in scope; doc line-range nit fixed at commit.

- **E7 workdir enforcement (lead c4 2026-09-15)** · engine fix, not a pipeline run · pipeline.js + dry-run.mjs. EVIDENCE: real 2026-09-15 launch, Lite lane — two implementer agents wrote six files into the MAIN checkout (C:\ClaudeCode\routeflow) while their workdir was the worktree `.claude/worktrees/rf-lite-L1`; REPO_NOTE's "cd into workdir" is advisory text an agent can ignore, and their tasks then stalled with only brief.md written — nothing detected either failure. THREE LAYERS: (1) prompt — REPO_NOTE (the shared RUN_PREFIX, not any per-task brief) now requires `git -C "<workdir>"` for every git call and forbids touching any path outside workdir, including another checkout of the same repo; (2) guard — `withWorkdirGuard` fingerprints the MAIN checkout (HEAD sha + scoped `git status --porcelain`, main root derived once via `git -C <workdir> rev-parse --git-common-dir`) before/after every implement/test-author/fix agent call and blocks the task with a `(workdir)` / phase `'Workdir guard'` finding on drift, skipped when workdir IS the main checkout, fail-safe on a dead fingerprint agent; (3) liveness — `checkImplementLiveness` mechanically confirms (report.md existence + a real git-status count) before blocking a non-blocked, empty-footprint implementer report as "no work in workdir", never trusting the self-reported `filesChanged` array alone. DRY-RUN: added AX/AY/AZ (guard trips; skipped when workdir==main; liveness blocks); full suite ALL DRY-RUN SCENARIOS PASSED, zero regressions in the existing 40+ scenarios (none set `workdir`, so the guard was previously silently dormant everywhere). DEVIATION: fix-round exec calls (all branches) are guarded too, reusing the same wrapper, though the observed defect was specifically implementers; the liveness check was scoped to implement/docs-implement only, per spec.
