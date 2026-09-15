#!/usr/bin/env node
// dry-run.mjs -- executes pipeline.js with STUBBED Workflow globals. Zero API calls.
//
// The Workflow runtime injects `agent`, `parallel`, `pipeline`, `log`, `phase`, `args`,
// `budget`, `workflow`. This harness injects fakes and asserts the shape the task-loop
// engine rebuild promises at each stage (docs/superpowers/plans/2026-09-12-task-loop-
// rebuild.md, Part A) -- zero API calls. `node --check` (see SKILL.md's IIFE-wrapper
// recipe) proves syntax; this proves the branches.
//
//   node scripts/dry-run.mjs            # all scenarios
//   node scripts/dry-run.mjs --calls    # also print every agent call (label, model, effort, phase)
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const src = fs
  .readFileSync(path.join(here, '..', 'pipeline.js'), 'utf8')
  .replace(/^export const meta = \{/m, 'const meta = {')
const showCalls = process.argv.includes('--calls')

// ---------- harness ----------
// Stubs the 8 Workflow globals. No canned agent responses yet (A1-A3 make zero
// agent calls in every scenario) -- later task groups add a responder keyed by
// label as the engine grows real stages.
// Canned responses keyed by label, used when a scenario supplies none of its
// own (`s.responses[label]`). A4-A7 make real agent calls (preflight, the
// three Baseline agents, warmup) for the first time -- every scenario that
// does not care about their content gets a harmless default here so it never
// has to hand-roll one just to reach the wave loop.
const DEFAULT_RESPONSES = {
  preflight: () => ({ contended: false, treeClean: true, resumeWritten: true, note: 'ok' }),
  warmup: () => ({ ok: true }),
  'baseline-gate': () => ({ pass: true, cwd: null, results: [] }),
  'baseline-grounding': () => ({ findings: [] }),
  'baseline-manifest': () => ({ files: [], validCommands: [], artifacts: [], planBytes: { build: 0, test: 0 } }),
  'harness-check': () => ({ issues: [] }),
  // A12 (Final pass): every scenario reaches this phase now -- a harmless
  // green default so only the scenarios that specifically test the Final
  // pass behavior (G's HIGH-risk fable read, a failing final gate) need
  // their own override.
  'final-gate': () => ({ pass: true, cwd: null, results: [] }),
  'final-read': () => ({ findings: [] }),
  // A14: runResult()'s own Haiku write-and-self-check call -- a sane default
  // endedAt so every scenario that doesn't specifically test a dead result
  // writer still gets one, matching the file's established default pattern.
  result: () => ({ written: true, path: 'auto/result.json', endedAt: '2026-09-12T00:00:00.000Z', note: 'ok' }),
}
// Fix round 1 (finding 2/11): every fix round now makes a `pack:<id>[:rN]`
// review-pack.mjs call and a `fix-base:<id>:rN` / `fix-head:<id>:rN` git-sha
// capture call. Scenarios that do not care about their content would
// otherwise need dozens of near-identical fixture entries (one per round,
// per task) -- this dynamic tier gives them a sane, well-formed default
// (a successful pack build; a distinguishable sha per call) so only the
// scenarios that specifically test finding 1/2's failure paths need an
// explicit override, which (being checked first, in `responses`) still wins.
function dynamicDefault(label) {
  if (/^pack:.+$/.test(label)) return { out: 'auto-pack/' + label + '.md', bytes: 500, truncated: false, sections: ['diff'], exitCode: 0 }
  // Fix 2 (real smoke-run finding): task-brief.mjs/fix-brief.mjs now report
  // exitCode too (SCRIPT_RESULT_SCHEMA) and briefStage/fixRound both treat a
  // missing/nonzero one as a blocker/gap -- give both labels the same sane,
  // well-formed passing default the pack: tier above already has, so only
  // scenarios AS/AT (which specifically test the failure paths) need their
  // own override. The brief: path deliberately ends in "brief.md" (matching
  // the pre-fix fallback shape) since scenario AC asserts that literal
  // substring appears in a downstream prompt.
  if (/^brief:.+$/.test(label)) return { out: 'auto-brief/' + label + '/brief.md', bytes: 220, truncated: false, sections: ['brief'], exitCode: 0 }
  if (/^fix-brief:.+$/.test(label)) return { out: 'auto-fix-brief/' + label + '.md', bytes: 220, truncated: false, sections: ['brief'], exitCode: 0 }
  if (/^fix-base:.+$/.test(label)) return { sha: 'base-' + label }
  if (/^fix-head:.+$/.test(label)) return { sha: 'head-' + label }
  // Fix round 2, finding 2: implementStage now captures a real pre-implement
  // sha for every non-blocked task (used as packPrompt's --base) -- give it
  // the same sane, distinguishable default as fix-base/fix-head so scenarios
  // that don't care about it don't need their own fixture entry.
  if (/^impl-base:.+$/.test(label)) return { sha: 'implbase-' + label }
  // A13: every fireCheckpoint() call now makes a real 'checkpoint:<...>'
  // agent call (previously a synchronous array push that never called
  // agent() at all) -- a sane, well-formed default so the many scenarios
  // that do not care about checkpoint success (most of them) don't each
  // need their own fixture entry; scenario J overrides one label directly
  // to prove the null/died path is handled instead of silently accepted.
  if (/^checkpoint:/.test(label)) return { written: true, path: 'auto-checkpoint/' + label + '.json', note: 'ok' }
  return undefined
}
async function run(s) {
  const calls = []
  const logs = []
  let spent = 0
  const responses = (s && s.responses) || {}
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, model: opts.model, effort: opts.effort, phase: opts.phase, prompt })
    spent += 1000
    const custom = responses[opts.label]
    if (typeof custom === 'function') return custom(opts, prompt)
    if (custom !== undefined) return custom
    const def = DEFAULT_RESPONSES[opts.label]
    if (def !== undefined) return typeof def === 'function' ? def(opts, prompt) : def
    const dyn = dynamicDefault(opts.label)
    if (dyn !== undefined) return dyn
    return null
  }
  // E8 (scenario BB): `s.dropParallelResultIds` simulates parallel() itself
  // dropping a slot's result (a killed worker, an internal timeout -- any
  // reason OTHER than the thunk throwing) even though the task's own thunk
  // resolved fine. Matched by the resolved result's own `.id` so this never
  // touches the OTHER parallel() calls in this file (baseline's 3-item array,
  // final-gate's 2-item array), whose resolved values carry no task id.
  const dropIds = (s && Array.isArray(s.dropParallelResultIds)) ? s.dropParallelResultIds : []
  const parallel = async (thunks) => Promise.all(thunks.map(async (t) => {
    try {
      const r = await t()
      return (r && dropIds.includes(r.id)) ? null : r
    } catch (e) { logs.push(`THROW ${e && e.message}`); return null }
  }))
  const pipelineFn = async (items, ...stages) => Promise.all(items.map(async (it, i) => {
    let v = it
    for (const st of stages) v = await st(v, it, i)
    return v
  }))
  const log = (m) => logs.push(String(m))
  // Fix 3 (hardening): a scenario can simulate budget.spent() getting STUCK
  // at a fixed reading across one named anchor-phase bracket -- the real,
  // measured production failure mode (ENGINE-NOTES.md, 2026-09-10: "the
  // engine's own budget.spent() silently read 0 on 26% of phases") -- by
  // naming that phase in s.stuckBudgetPhase. `phase()` is the sandbox marker
  // startPhase()/endPhase() call to bracket a reading; the moment it fires
  // for the stuck phase, the reading is frozen, and budget.spent() returns
  // that SAME frozen number for as long as we are inside it, however many
  // real agent calls increment the underlying counter meanwhile -- identical
  // readings at both ends of the bracket, exactly like the production bug.
  let currentPhase = null
  let frozenSpent = null
  const stuckPhase = s && s.stuckBudgetPhase
  const phase = (title) => {
    currentPhase = title
    if (stuckPhase && title === stuckPhase && frozenSpent == null) frozenSpent = spent
  }
  const budget = {
    total: null,
    spent: () => (stuckPhase && currentPhase === stuckPhase && frozenSpent != null ? frozenSpent : spent),
    remaining: () => Infinity,
  }
  const fn = new Function('agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', 'workflow', `return (async () => { ${src} })()`)
  const result = await fn(agent, parallel, pipelineFn, log, phase, s.args, budget, async () => null)
  return { result, calls, logs }
}

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`)
  else { failures++; console.log(`  FAIL ${name}${extra ? ` -- ${extra}` : ''}`) }
}

// ---------- fixtures ----------
// Fix 1 (real smoke-run finding): a realistic-looking absolute scripts
// directory, matching the shape the real launcher must supply as
// args.scriptsDir (see pipeline.js's scriptCmd()). Used by baseArgs() below
// so the WHOLE suite exercises the corrected absolute-path command-building
// logic by default, not the empty-string/missing-scriptsDir fallback path --
// scenarios AR/AS/AT (below) are the ones that specifically exercise that
// fallback and the exitCode failure paths.
const SCRIPTS_DIR = 'C:/Users/nakram/.claude/skills/dev-pipeline/scripts'
// A1: the smallest task graph that exercises dependsOn ordering -- T2 depends
// on T1, disjoint files, both type 'feature' (never blocked by A3's
// validateTasks). Every scenario below starts from this and overrides `tasks`
// (or other fields) as needed.
function baseArgs(extra) {
  return Object.assign({
    tasks: [
      { id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] },
      { id: 'T2', type: 'feature', files: ['src/b.ts'], tests: ['src/b.test.ts'], brief: 'add beta', dependsOn: ['T1'] },
    ],
    verifyCommands: { perRound: ['npm run check'], final: ['npm test'] },
    scale: 'small',
    runDir: '.claude/pipeline/dry',
    lessonsPath: '.claude/lessons/LESSONS.md',
    startedAt: '2026-09-12T00:00:00Z',
    scriptsDir: SCRIPTS_DIR,
  }, extra || {})
}

const scenarios = []
// A17 (task 18): every agent call recorded across EVERY scenario run below
// (the uniform {name, args, assert} loop, plus runScenarioN's and
// runScenarioM's own separate fixtures) -- the ground truth the CALLS AUDIT
// checks at the end of this file, and what `--calls` prints.
const allCalls = []
// `responses` (optional): { label: value | (opts, prompt) => value } -- overrides
// DEFAULT_RESPONSES for this scenario only, keyed by the same opts.label every
// askAgent() call carries.
// `extra` (optional): merged onto the pushed scenario object -- e.g.
// { stuckBudgetPhase: 'Implement' } for the budget.spent()-stuck-reading
// harness support above (scenario AQ).
function scenario(name, args, assert, responses, extra) { scenarios.push({ name, args, assert, responses, ...(extra || {}) }) }

// Fix round 1: a real build-plan path, for scenarios that need re-review's
// review-pack.mjs call (finding 2) to actually run instead of hitting the
// no-plan-path gap.
const PLAN_PATH = '.claude/pipeline/dry/build-plan.md'
// A minimal "everything up through implement passes" fixture for a task id
// -- tests RED, red-check structurally red, implementer done. Fix round 1:
// after finding 7's fix a dead/blocked implementer is now a task blocker,
// so every scenario that needs to reach pack/review/the fix loop needs an
// explicit passing 'impl:<id>' response (previously the null default was
// silently tolerated).
function passingChainFor(id, opts) {
  const o = opts || {}
  return {
    ['tests:' + id]: () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest ' + id + '.test.ts', exitCode: 1, output: 'FAIL: assertion failed as expected' }] }),
    ['red-check:' + id]: () => ({ structurallyRed: true, tests: [{ test: 'adds ' + id, outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    ['impl:' + id]: () => ({ status: 'done', filesChanged: o.filesChanged || [], deviations: '', notes: '' }),
  }
}
// Kept as a name for scenarios that need ONLY the RED-gate half passing (so
// they can supply their own 'impl:<id>' response, e.g. a deliberately
// blocked one).
const PASSING_RED_CHECK = { 'tests:T1': passingChainFor('T1')['tests:T1'], 'red-check:T1': passingChainFor('T1')['red-check:T1'] }
const PASSING_CHAIN = passingChainFor('T1', { filesChanged: ['src/a.ts'] })

// ---------- scenario A ----------
// The engine is a meta-only stub through A1-A3: it must still run to
// completion (no throw) and reports itself unimplemented. This assertion is
// EXPECTED TO FAIL until a real engine body replaces the stub return in a
// later task group (A8) -- that FAIL is the documented RED this task group
// hands off, not a bug in A1-A3 (or in A4-A7, which still end in the same
// stub `aborted:'not-implemented'` return -- A8's runTask chain is what
// finally removes it).
//
// A5 and A7 each grow this SAME scenario with a new assertion, per the plan
// (docs/superpowers/plans/2026-09-12-task-loop-rebuild.md, Task 5 and Task 7):
// A5 adds "exactly one preflight call" (the host is not contended in this
// fixture, so the 3-attempt retry loop breaks after attempt 1); A7 adds
// "T2 runs after T1" via the wave-loop's task-result order (T2 dependsOn T1,
// so buildWaves puts them in separate, sequential waves).
scenario('A. two-task feature plan runs the stub without throwing', baseArgs(), ({ result, calls }) => {
  check('A: engine does not abort (RED until the real engine lands past A3)', !result.aborted, result.aborted)
  const preflightCalls = calls.filter((c) => c.label === 'preflight')
  check('A: preflight runs exactly once when the host is not contended', preflightCalls.length === 1, preflightCalls.length)
  check(
    'A: both tasks come back through the wave loop, T1 before T2 (dependsOn order)',
    Array.isArray(result.tasks) && result.tasks.length === 2 && result.tasks[0] && result.tasks[0].id === 'T1' && result.tasks[1] && result.tasks[1].id === 'T2',
    JSON.stringify(result.tasks),
  )
})

// ---------- scenario K (A4) ----------
// Every prompt goes through askAgent(), which prepends RUN_PREFIX() then the
// PHASE/LABEL tag session-usage.mjs attributes tokens by matching. RED at A4
// (askAgent exists but nothing calls it yet -- zero calls, so the length>0
// half of this check fails); GREEN once A5's Preflight makes the first real
// askAgent() call.
scenario('K. every recorded prompt carries the PHASE/LABEL tag session-usage.mjs matches on', baseArgs(), ({ calls }) => {
  check('K: at least one agent call was recorded', calls.length > 0, calls.length)
  check(
    'K: every recorded prompt has a line matching /^PHASE: .+ · LABEL: .+$/m',
    calls.length > 0 && calls.every((c) => /^PHASE: .+ · LABEL: .+$/m.test(c.prompt)),
    JSON.stringify(calls.map((c) => (c.prompt || '').split('\n')[0])),
  )
})

// ---------- scenario L (A14) ----------
// result.json must carry every field the ledger/closeout tooling actually
// reads -- cross-checked against model-routing/scripts/pipeline-ledger.mjs's
// real buildRow() (and its extractLenses/computeReviewFindings/computeQuality
// helpers), not just the plan prose: result.phaseReport[] (each row's
// phase/ran/agents/rawFindings/tokens/estUsd/effort/model/overlappedWith/
// note -- exactly what buildRow's `phases` map reads), result.confirmedByPhase
// (buildRow reads result.confirmedByPhase?.[phase]), result.remainingFindings,
// result.confirmedFindings (computeReviewFindings iterates it directly),
// result.clean, result.fixRounds, result.fixRouting, result.riskSummary,
// result.redGate (buildRow spreads it through computeRedGateBlockers, which
// needs a real `audits` array), result.mutationProbe/finalPass/siblingSweep/
// uiVerify (each read via `result.X ?? null` then re-shaped), result.gate.pass
// (buildRow: `result.gate?.pass`), result.mode, result.scale, result.runId,
// result.checkpoints, result.startedAt/endedAt, result.estimatedCostUsd/
// pricesAsOf, result.profile (buildRow: pickField(result.profile, ...)), and
// the NEW result.tasks[] {id,type,status,rounds,reviewVerdict,reportPath} +
// result.rulings[]. Legacy/removed fields (result.overlap, result.verify,
// result.cascadeAudit, result.escalation) must be explicitly null -- present
// and readable via `??`, never simply absent -- per buildRow's own
// `result.overlap ?? null` / `result.verify ?? null` / etc. pattern.
scenario(
  'L. result.json carries every field the ledger/closeout tooling actually reads, in the right shape',
  baseArgs(),
  ({ result }) => {
    check('L: phaseReport is an array covering all ten canonical ledger phases', Array.isArray(result.phaseReport) && result.phaseReport.length === 10, JSON.stringify(result.phaseReport && result.phaseReport.map((p) => p.phase)))
    const rowKeys = ['phase', 'ran', 'agents', 'rawFindings', 'tokens', 'estUsd', 'model', 'effort', 'overlappedWith', 'note']
    check(
      'L: every phaseReport row carries phase/ran/agents/rawFindings/tokens/estUsd/model/effort/overlappedWith/note',
      Array.isArray(result.phaseReport) && result.phaseReport.every((p) => rowKeys.every((k) => k in p)),
      JSON.stringify(result.phaseReport),
    )
    check(
      "L: the five phases that only ever run inside Implement (Author tests/Red gate/Gate & Review/Fix/UI verify) report overlappedWith:'Implement' and tokens is a number (or null with estUnknown:true when the reading was unavailable/stuck/contaminated) -- never the old always-null placeholder",
      Array.isArray(result.phaseReport) &&
        ['Author tests', 'Red gate', 'Gate & Review', 'Fix', 'UI verify'].every((name) => {
          const row = result.phaseReport.find((p) => p.phase === name)
          return row && row.overlappedWith === 'Implement' && (typeof row.tokens === 'number' || (row.tokens === null && row.estUnknown === true))
        }),
      JSON.stringify(result.phaseReport),
    )
    check(
      "L: estimatedCostUsd sums only the anchor phases' (Baseline/Implement/Verify/Mutation probe/Final pass) estUsd -- the nested five (Author tests and Gate & Review both report real non-zero estUsd here) are excluded from the sum, never double-counted",
      (() => {
        const anchorNames = ['Baseline', 'Implement', 'Mutation probe', 'Verify', 'Final pass']
        const anchorSum = Math.round(result.phaseReport.filter((p) => anchorNames.includes(p.phase)).reduce((s, p) => s + (p.estUsd || 0), 0) * 100) / 100
        const nestedNonZero = result.phaseReport.some((p) => !anchorNames.includes(p.phase) && (p.estUsd || 0) > 0)
        return nestedNonZero && result.estimatedCostUsd === anchorSum
      })(),
      JSON.stringify({ estimatedCostUsd: result.estimatedCostUsd, phaseReport: result.phaseReport }),
    )
    check(
      "L: the five sandbox-bracketed phases report a real measured tokens number (never null when calls happened) and overlappedWith:null",
      ['Baseline', 'Implement', 'Final pass'].every((name) => {
        const row = result.phaseReport.find((p) => p.phase === name)
        return row && row.overlappedWith === null && typeof row.tokens === 'number'
      }),
      JSON.stringify(result.phaseReport),
    )
    check('L: confirmedByPhase is an object', result.confirmedByPhase && typeof result.confirmedByPhase === 'object', JSON.stringify(result.confirmedByPhase))
    check('L: confirmedFindings is an array', Array.isArray(result.confirmedFindings), JSON.stringify(result.confirmedFindings))
    check('L: redGate carries ran/structurallyRed/behaviorallyRed/attempts/audits', !!result.redGate && 'ran' in result.redGate && 'structurallyRed' in result.redGate && 'behaviorallyRed' in result.redGate && 'attempts' in result.redGate && Array.isArray(result.redGate.audits), JSON.stringify(result.redGate))
    check('L: gate.pass is a boolean', typeof (result.gate && result.gate.pass) === 'boolean', JSON.stringify(result.gate))
    check('L: riskSummary and fixRouting are objects, fixRounds is a number', !!result.riskSummary && !!result.fixRouting && typeof result.fixRounds === 'number', JSON.stringify({ riskSummary: result.riskSummary, fixRouting: result.fixRouting, fixRounds: result.fixRounds }))
    check('L: estimatedCostUsd is a number and pricesAsOf is set', typeof result.estimatedCostUsd === 'number' && !!result.pricesAsOf, JSON.stringify({ estimatedCostUsd: result.estimatedCostUsd, pricesAsOf: result.pricesAsOf }))
    check('L: mode, scale, runId, profile, startedAt, endedAt are all set', !!result.mode && !!result.scale && !!result.runId && !!result.profile && !!result.startedAt && !!result.endedAt, JSON.stringify({ mode: result.mode, scale: result.scale, runId: result.runId, profile: result.profile, startedAt: result.startedAt, endedAt: result.endedAt }))
    // C6 (Task 42): result.approach is the literal engine-identity constant
    // 'dev-pipeline' -- this engine only ever produces dev-pipeline-approach
    // runs (bugfix mode still runs through this SAME engine per the house
    // "one shared engine, mode is the only divergence" convention), so
    // approach must be present and equal to the literal string regardless of
    // mode/scale/profile. pipeline-ledger.mjs's buildRow reads it via
    // pickField(result.profile, meta.profile) / pickField(result.approach,
    // meta.approach) -- a result.json field always wins over a CLI flag.
    check("L: result.approach is the literal engine-identity constant 'dev-pipeline'", result.approach === 'dev-pipeline', result.approach)
    check('L: checkpoints and rulings are arrays', Array.isArray(result.checkpoints) && Array.isArray(result.rulings), JSON.stringify({ checkpoints: result.checkpoints, rulings: result.rulings }))
    check(
      'L: every task carries id/type/status/rounds/reviewVerdict/reportPath',
      Array.isArray(result.tasks) && result.tasks.length > 0 && result.tasks.every((t) => 'id' in t && 'type' in t && 'status' in t && 'rounds' in t && 'reviewVerdict' in t && 'reportPath' in t),
      JSON.stringify(result.tasks),
    )
    check(
      'L: legacy/removed fields are explicitly null, not simply absent',
      result.overlap === null && result.verify === null && result.cascadeAudit === null && result.escalation === null && result.lensesRun === null && result.lensReport === null && result.radiusPack === null && result.plausibleFindings === null && result.quarantined === null,
      JSON.stringify({ overlap: result.overlap, verify: result.verify, cascadeAudit: result.cascadeAudit, escalation: result.escalation, lensesRun: result.lensesRun, lensReport: result.lensReport, radiusPack: result.radiusPack, plausibleFindings: result.plausibleFindings, quarantined: result.quarantined }),
    )
    check('L: siblingSweep and uiVerify/mutationProbe/finalPass are all readable (not undefined)', result.siblingSweep !== undefined && result.uiVerify !== undefined && result.mutationProbe !== undefined && result.finalPass !== undefined, '')
  },
  // A15 landed 'lean' as baseArgs()'s real default (small scale, no
  // HIGH-risk) -- an implementer response is needed for both tasks so they
  // actually reach fixLoopStage (which is what sets status/rounds) instead
  // of dead-agent-blocking at Implement before ever getting there.
  {
    'impl:T1': () => ({ status: 'done', filesChanged: ['src/a.ts'], deviations: '', notes: '' }),
    'impl:T2': () => ({ status: 'done', filesChanged: ['src/b.ts'], deviations: '', notes: '' }),
    'review:T1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'review:T2': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
  },
)

// ---------- scenario B (A6) ----------
// A perRound command that already fails on the untouched baseline tree is
// recorded as known-broken and produces exactly one non-blocking finding --
// and (the observable half of "excluded from every later gate" that A4-A7
// can actually prove, ahead of A8/A9's real per-task gate) it is stripped out
// of manifest.validCommands, which is what every later gate reads instead of
// re-discovering its own command list.
scenario(
  'B. a failing perRound command at baseline is excluded from every later gate',
  baseArgs(),
  ({ result }) => {
    check('B: the broken perRound command is recorded in baseline.badCommands', Array.isArray(result.baseline && result.baseline.badCommands) && result.baseline.badCommands.includes('npm run check'), JSON.stringify(result.baseline))
    const gcFindings = (result.remainingFindings || []).filter((f) => f.file === '(gate-command)')
    check('B: exactly one non-blocking (major) finding for the broken command', gcFindings.length === 1 && gcFindings[0].severity === 'major', JSON.stringify(gcFindings))
    check('B: the broken command is stripped from validCommands, so no later gate reads it again', !(result.manifest.validCommands || []).includes('npm run check'), JSON.stringify(result.manifest.validCommands))
    check('B: the still-good command remains available to later gates', (result.manifest.validCommands || []).includes('npm test'), JSON.stringify(result.manifest.validCommands))
  },
  {
    'baseline-gate': () => ({
      pass: false,
      cwd: null,
      results: [
        { command: 'npm run check', pass: false, executed: -1, summary: 'sh: check: command not found' },
        { command: 'npm test', pass: true, executed: 5 },
      ],
    }),
    'baseline-manifest': () => ({
      files: [
        { path: 'src/a.ts', status: 'planned', exists: false, digest: '', risk: 'LOW', changedLines: 0 },
        { path: 'src/a.test.ts', status: 'planned', exists: false, digest: '', risk: 'LOW', changedLines: 0 },
        { path: 'src/b.ts', status: 'planned', exists: false, digest: '', risk: 'LOW', changedLines: 0 },
        { path: 'src/b.test.ts', status: 'planned', exists: false, digest: '', risk: 'LOW', changedLines: 0 },
      ],
      validCommands: ['npm run check', 'npm test'],
      artifacts: [],
      planBytes: { build: 0, test: 0 },
    }),
  },
)

// ---------- scenario C (A6) ----------
// validateJestCommands is now driven by the manifest's own per-file `exists`
// facts instead of assuming every task-declared file is absent: a planned
// file the manifest reports as EXISTING is "edited", never "created", so a
// Jest command targeting it with no --passWithNoTests is not a (build-plan)
// blocker (this is exactly the false-blocker class the plan's Context section
// names: "a 'files this run will create' blocker on files that already
// exist").
scenario(
  'C. an existing planned file is edited -- no (build-plan) blocker',
  baseArgs({ verifyCommands: { perRound: ['npx jest src/a.test.ts'], final: ['npm test'] } }),
  ({ result }) => {
    check('C: no (build-plan) blocker for a jest command targeting a file the manifest reports as existing', !(result.remainingFindings || []).some((f) => f.file === '(build-plan)'), JSON.stringify(result.remainingFindings))
    const row = (result.manifest.files || []).find((f) => f.path === 'src/a.test.ts')
    check('C: the manifest reports that file as existing, with a digest', !!row && row.exists === true && !!row.digest, JSON.stringify(row))
  },
  {
    'baseline-gate': () => ({
      pass: true,
      cwd: null,
      results: [
        { command: 'npx jest src/a.test.ts', pass: true, executed: 3 },
        { command: 'npm test', pass: true, executed: 10 },
      ],
    }),
    'baseline-manifest': () => ({
      files: [
        { path: 'src/a.ts', status: 'modified', exists: true, digest: 'deadbeef', risk: 'LOW', changedLines: 4 },
        { path: 'src/a.test.ts', status: 'modified', exists: true, digest: 'cafebabe', risk: 'LOW', changedLines: 2 },
        { path: 'src/b.ts', status: 'planned', exists: false, digest: '', risk: 'LOW', changedLines: 0 },
        { path: 'src/b.test.ts', status: 'planned', exists: false, digest: '', risk: 'LOW', changedLines: 0 },
      ],
      validCommands: ['npx jest src/a.test.ts', 'npm test'],
      artifacts: [],
      planBytes: { build: 0, test: 0 },
    }),
  },
)

// ---------- scenario P (A6/A7 fix round 1, finding 1) ----------
// pairsFor() used to look only at `(t.files||[])[0]` -- a task's HIGH-risk file
// that is not its FIRST `files` entry (or lives in `tests`) silently warmed
// Sonnet/`implement` instead of Fable/`implementHigh`. Single task, two
// `files` entries, only the SECOND is HIGH.
scenario(
  "P. pairsFor routes HIGH risk to Fable even when the HIGH file is not the task's first `files` entry",
  baseArgs({
    tasks: [
      { id: 'T1', type: 'feature', files: ['src/a.ts', 'src/b.ts'], tests: ['src/a.test.ts'], brief: 'two files, second is HIGH', dependsOn: [] },
    ],
  }),
  ({ calls }) => {
    const warmups = calls.filter((c) => c.label === 'warmup' && c.phase === 'Implement')
    check('P: exactly one warmup call for the single-task single-wave plan', warmups.length === 1, JSON.stringify(warmups))
    check(
      "P: the HIGH-risk second `files` entry routes the wave to Sonnet/implementHigh effort, not the LOW/implement default",
      !!warmups[0] && warmups[0].model === 'claude-sonnet-5' && warmups[0].effort === 'high',
      JSON.stringify(warmups),
    )
  },
  {
    'baseline-manifest': () => ({
      files: [
        { path: 'src/a.ts', status: 'planned', exists: false, digest: '', risk: 'LOW', changedLines: 0 },
        { path: 'src/b.ts', status: 'planned', exists: false, digest: '', risk: 'HIGH', changedLines: 0 },
        { path: 'src/a.test.ts', status: 'planned', exists: false, digest: '', risk: 'LOW', changedLines: 0 },
      ],
      validCommands: [],
      artifacts: [],
      planBytes: { build: 0, test: 0 },
    }),
  },
)

// ---------- scenario Q (A6/A7 fix round 1, finding 1) ----------
// Same defect, different shape: the HIGH-risk file lives in `tests`, which
// the old `pairsFor` never looked at (only `t.files[0]`).
scenario(
  'Q. pairsFor routes HIGH risk to Fable when the HIGH file lives in `tests`, not `files`',
  baseArgs({
    tasks: [
      { id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'the test file is HIGH', dependsOn: [] },
    ],
  }),
  ({ calls }) => {
    const warmups = calls.filter((c) => c.label === 'warmup' && c.phase === 'Implement')
    check('Q: exactly one warmup call for the single-task single-wave plan', warmups.length === 1, JSON.stringify(warmups))
    check(
      'Q: a HIGH-risk `tests` entry routes the wave to Sonnet/implementHigh effort, not the LOW/implement default',
      !!warmups[0] && warmups[0].model === 'claude-sonnet-5' && warmups[0].effort === 'high',
      JSON.stringify(warmups),
    )
  },
  {
    'baseline-manifest': () => ({
      files: [
        { path: 'src/a.ts', status: 'planned', exists: false, digest: '', risk: 'LOW', changedLines: 0 },
        { path: 'src/a.test.ts', status: 'planned', exists: false, digest: '', risk: 'HIGH', changedLines: 0 },
      ],
      validCommands: [],
      artifacts: [],
      planBytes: { build: 0, test: 0 },
    }),
  },
)

// ---------- scenario R (A6/A7 fix round 1, finding 1) ----------
// A dead/skipped baseline-manifest agent used to leave `riskMap` completely
// empty and silently proceed -- `pairsFor` then read every file as "not
// HIGH" (LOW-equivalent) instead of the documented "unknown is HIGH"
// default, AND no finding recorded the manifest's absence at all.
scenario(
  'R. a dead baseline-manifest agent produces a major finding and defaults every unclassified file to HIGH (never silently LOW)',
  baseArgs(),
  ({ result, calls }) => {
    const manifestFindings = (result.remainingFindings || []).filter((f) => f.file === '(baseline-manifest)')
    check('R: a dead manifest agent produces exactly one major finding', manifestFindings.length === 1 && manifestFindings[0].severity === 'major', JSON.stringify(manifestFindings))
    const warmups = calls.filter((c) => c.label === 'warmup' && c.phase === 'Implement')
    check(
      'R: with no manifest and no explicit task risk, the wave still routes to implementHigh effort (unknown stays HIGH), never the LOW/implement default',
      warmups.length > 0 && warmups[0].model === 'claude-sonnet-5' && warmups[0].effort === 'high',
      JSON.stringify(warmups),
    )
  },
  {
    'baseline-manifest': () => null,
  },
)

// ---------- scenario D (A8) ----------
// redCheckStage is structural: the test author's reported RED run must show
// every named test failing on an ASSERTION (none errored/skipped/passed). A
// failure here gets exactly ONE test-author remediation attempt; if the
// second red-check still is not structurallyRed, the task is blocked with a
// (red-gate) finding and never reaches implement/pack/review at all.
scenario(
  'D. RED check fails structurally, survives one remediation attempt, then becomes a (red-gate) blocker',
  // A15: this scenario specifically exercises the STANDARD-profile red-gate
  // mechanism (a separate test author + Haiku red-check) -- baseArgs()'s
  // real default is now 'lean' for a small/no-HIGH-risk fixture like this
  // one, which skips redCheckStage entirely, so profile is pinned explicitly.
  baseArgs({ profile: 'standard', tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ result, calls }) => {
    const redGate = (result.remainingFindings || []).filter((f) => f.file === '(red-gate)')
    check('D: exactly one (red-gate) blocker finding', redGate.length === 1 && redGate[0].severity === 'blocker', JSON.stringify(redGate))
    check('D: the run is not clean', result.clean === false, JSON.stringify(result.remainingFindings))
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('D: the blocked task never reaches implement/pack/review', !!t1 && t1.blocked === true && !t1.implement && !t1.review, JSON.stringify(t1))
    const redChecks = calls.filter((c) => c.label === 'red-check:T1' || c.label === 'red-check:T1:r2')
    check('D: exactly two red-check calls (initial + after remediation)', redChecks.length === 2, JSON.stringify(redChecks.map((c) => c.label)))
    const remediate = calls.filter((c) => c.label === 'tests:T1:remediate')
    check('D: exactly one remediation attempt', remediate.length === 1, JSON.stringify(remediate.map((c) => c.label)))
  },
  {
    'tests:T1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/a.test.ts', exitCode: 1, output: 'FAIL: TypeError: cannot read x' }] }),
    'red-check:T1': () => ({ structurallyRed: false, tests: [{ test: 'adds alpha', outcome: 'error', note: 'import missing' }], blockers: ['STRUCTURAL: import missing'], remediation: 'fix the import' }),
    'tests:T1:remediate': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/a.test.ts', exitCode: 1, output: 'FAIL: TypeError: cannot read x' }] }),
    'red-check:T1:r2': () => ({ structurallyRed: false, tests: [{ test: 'adds alpha', outcome: 'error', note: 'still broken' }], blockers: ['STRUCTURAL: import still missing'], remediation: 'fix the import again' }),
  },
)

// A9's scenarios exercise the fix loop, which only runs after redCheckStage
// AND implementStage pass -- PASSING_CHAIN (defined above) gives every one
// of them a clean structural RED plus a done implementer, so the chain
// reaches reviewStage instead of blocking at (red-gate)/(implement) first.
// Fix round 1, finding 2: they also need `buildPlanPath` so a fix round's
// re-review can build a real review-pack.mjs call instead of hitting the
// no-plan-path gap.

// ---------- scenario E (A9) ----------
// The fix-round routing table: rounds 1-2 use the plain executor (no
// designer). A critical finding fixed in round 1, then confirmed ADDRESSED
// by the round's re-review with no new findings, brings the task -- and the
// whole run -- to clean.
scenario(
  'E. a critical review finding is fixed in round 1 and re-review confirms ADDRESSED -- task and run go clean',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('E: task T1 completes with rounds=1', !!t1 && t1.status === 'complete' && t1.rounds === 1, JSON.stringify(t1))
    check('E: task T1 is clean', !!t1 && t1.clean === true, JSON.stringify(t1))
    check('E: the run overall is clean with no blocker findings', result.clean === true, JSON.stringify(result.remainingFindings))
    const fixCalls = calls.filter((c) => c.label === 'fix:T1:r1')
    check('E: exactly one fix call for round 1', fixCalls.length === 1, JSON.stringify(fixCalls.map((c) => c.label)))
    const designCalls = calls.filter((c) => c.label === 'fix-plan:T1:r1' || c.label === 'fix-brief:T1:r1')
    check('E: rounds 1-2 use the plain executor -- no designer calls', designCalls.length === 0, JSON.stringify(designCalls.map((c) => c.label)))
  },
  {
    ...PASSING_CHAIN,
    'review:T1': () => ({ specCompliance: 'partial', findings: [{ severity: 'critical', file: 'src/a.ts', line: 10, summary: 'off-by-one', scenario: 'loop bound wrong' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'done', filesChanged: ['src/a.ts'], deviations: '', notes: '' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'ADDRESSED', evidence: 'src/a.ts:10' }], newFindings: [] }),
  },
)

// ---------- scenario F (A9; extended fix round 1, findings 10 & 11) ----------
// A finding that survives all 4 rounds (round 1-2 run a single Sonnet
// exec-only call; round 3 onward escalates to a separate Opus fix-plan
// design call followed by a Sonnet exec call -- the old "executorIsDesigner"
// combined-call path is retired/unreachable since the 2026-09-13 ruling, so
// rounds 3 AND 4 both make their own fix-plan call) hits the maxFixRounds
// cap: a Ruling is recorded (task-level AND surfaced at the run level, never
// silently dropped) and the run stays clean:false. Extended in fix round 1
// to also prove: the exact r3 fix-brief -> fix-plan call pairing, that r4
// makes that SAME pairing again rather than collapsing (finding 10), and
// that per-round {plan,design,exec} evidence is retained with a Ruling that
// cites something real (finding 11).
scenario(
  'F. a finding survives all 4 fix rounds -- a Ruling is recorded and the run stays not clean',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('F: task T1 stays open after 4 rounds', !!t1 && t1.status === 'open' && t1.rounds === 4, JSON.stringify(t1))
    check('F: task T1 carries exactly one ruling', !!t1 && Array.isArray(t1.rulings) && t1.rulings.length === 1, JSON.stringify(t1 && t1.rulings))
    check('F: the ruling is also surfaced at the run level', Array.isArray(result.rulings) && result.rulings.length === 1, JSON.stringify(result.rulings))
    check('F: the run is not clean', result.clean === false, JSON.stringify(result.remainingFindings))
    // finding 10: exact r3 fix-brief -> fix-plan pairing, and r4 makes the
    // SAME pairing again -- rounds >= 3 never collapse designer and executor
    // into one call (that path is retired/unreachable since 2026-09-13).
    const r3Labels = calls.filter((c) => c.label === 'fix-brief:T1:r3' || c.label === 'fix-plan:T1:r3').map((c) => c.label)
    check('F: round 3 makes exactly a fix-brief then fix-plan call pair (finding 10)', JSON.stringify(r3Labels) === JSON.stringify(['fix-brief:T1:r3', 'fix-plan:T1:r3']), JSON.stringify(r3Labels))
    const r4Labels = calls.filter((c) => c.label === 'fix-brief:T1:r4' || c.label === 'fix-plan:T1:r4').map((c) => c.label)
    check('F: round 4 makes the same fix-brief then fix-plan call pair, on Opus, not a collapsed single call (finding 10)', JSON.stringify(r4Labels) === JSON.stringify(['fix-brief:T1:r4', 'fix-plan:T1:r4']), JSON.stringify(r4Labels))
    const r4PlanCall = calls.find((c) => c.label === 'fix-plan:T1:r4')
    check('F: round 4\'s fix-plan (design) call runs on Opus (finding 10)', !!r4PlanCall && r4PlanCall.model === 'claude-opus-5', JSON.stringify(r4PlanCall))
    // finding 11: per-round {plan, design, exec} evidence retained; the
    // Ruling cites something concrete, not a bare count.
    check('F: roundHistory retains all 4 rounds with plan/exec evidence (finding 11)', !!t1 && Array.isArray(t1.roundHistory) && t1.roundHistory.length === 4 && t1.roundHistory.every((r) => r.plan && 'exec' in r), JSON.stringify(t1 && t1.roundHistory))
    check('F: the Ruling cites the last round\'s real executor status, not a bare count (finding 11)', !!t1 && t1.rulings[0] && /status=/.test(t1.rulings[0].why), JSON.stringify(t1 && t1.rulings))
  },
  {
    ...PASSING_CHAIN,
    'review:T1': () => ({ specCompliance: 'fail', findings: [{ severity: 'critical', file: 'src/a.ts', line: 5, summary: 'wrong total', scenario: 'money math off' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'partial', filesChanged: [], deviations: 'could not reproduce', notes: '' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'src/a.ts:5 unchanged' }], newFindings: [] }),
    'fix:T1:r2': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r2': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'src/a.ts:5 unchanged' }], newFindings: [] }),
    'fix-plan:T1:r3': () => ({ decisions: [{ key: '#0', action: 'fix', design: 'recompute total', invariant: 'total matches sum', tests: 'T1', reason: 'confirmed' }], note: 'fix it' }),
    'fix:T1:r3': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r3': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'src/a.ts:5 unchanged' }], newFindings: [] }),
    'fix:T1:r4': () => ({ status: 'blocked', filesChanged: [], deviations: 'still wrong', notes: '' }),
    're-review:T1:r4': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'src/a.ts:5 unchanged' }], newFindings: [] }),
  },
)

// ---------- scenario I (A9) ----------
// Only critical/important findings enter the fix loop; a minor-only review
// never triggers a single fix: call and the task completes at round 0.
scenario(
  'I. minor-only review findings never enter the fix loop -- zero fix: calls',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('I: task T1 completes immediately with 0 fix rounds', !!t1 && t1.status === 'complete' && t1.rounds === 0, JSON.stringify(t1))
    const fixCalls = calls.filter((c) => (c.label || '').startsWith('fix'))
    check('I: zero fix:/fix-plan:/fix-brief: calls for a minor-only review', fixCalls.length === 0, JSON.stringify(fixCalls.map((c) => c.label)))
    check(
      'I: the minor finding is still recorded, non-blocking, and the run is clean',
      result.clean === true && (result.remainingFindings || []).some((f) => f.severity === 'minor'),
      JSON.stringify(result.remainingFindings),
    )
  },
  {
    ...PASSING_CHAIN,
    'review:T1': () => ({ specCompliance: 'partial', findings: [{ severity: 'minor', file: 'src/a.ts', line: 20, summary: 'style nit', scenario: 'inconsistent naming' }], assessment: 'approved' }),
  },
)

// ---------- scenario J (A13) ----------
// A13's real checkpoint mechanism is fire-and-forget (S5): a checkpoint
// agent that dies or returns malformed output must never throw or abort the
// run -- the attempt is logged written:false and every other task/phase
// still completes normally. Pre-A13, fireCheckpoint was a synchronous array
// push that never called agent() at all, so this scenario could not even be
// expressed against that code (no 'checkpoint:T2' label was ever recorded,
// and result.checkpoints held raw {alias, payload} with no written/note) --
// that absence IS the RED this task starts from.
scenario(
  'J. a checkpoint: agent call that returns null does not throw -- the attempt is logged written:false and the run still completes',
  baseArgs(),
  ({ result, calls }) => {
    check('J: the run completes without aborting', !result.aborted, JSON.stringify(result.aborted))
    check('J: both tasks still report a result', Array.isArray(result.tasks) && result.tasks.length === 2, JSON.stringify(result.tasks))
    check('J: a real checkpoint: agent call was actually made for T2', calls.some((c) => c.label === 'checkpoint:T2'), JSON.stringify(calls.map((c) => c.label)))
    const dead = (result.checkpoints || []).find((c) => c.alias === 'checkpoint:T2')
    check('J: the dead checkpoint is logged with written:false, not silently dropped', !!dead && dead.written === false, JSON.stringify(dead))
    const alive = (result.checkpoints || []).find((c) => c.alias === 'checkpoint:T1')
    check("J: a sibling task's checkpoint still writes normally (written:true)", !!alive && alive.written === true, JSON.stringify(alive))
  },
  { 'checkpoint:T2': () => null },
)

// ==================== FIX ROUND 1 (5 Critical, 7 Important) ====================
// Every scenario below proves one specific finding from the fix-round-1
// dispatch. Naming follows the existing P/Q/R precedent (fix-round additions
// continue the alphabet past the S5-lettered A-O set) rather than reusing a
// letter the master plan reserves for a not-yet-landed task (G/H=A10,
// J=A13's own scenario, L/M=A15, O=A10b).

// ---------- scenario S (finding 1) ----------
// Fix round 2 (test integrity): the ORIGINAL T2 fixture (radius:
// ['src/other.ts'], a single non-numeric element) passed identically against
// the OLD pre-round-1 code -- old `(t.radius||[]).join(',')` emitted
// `--radius src/other.ts`, which (no digit right after "--radius ") also
// fails to match /--radius \d/, so both the buggy old code and the fixed new
// code "look like" they omitted the flag by this check's own wording. A
// shape that IS all-numeric but still not a valid [before,after] PAIR -- 3
// elements -- makes old and new code produce genuinely different, observable
// prompts: old joins to `--radius 3,5,7` (which DOES match /--radius \d/,
// so the "omits it" assertion actually fails there); new omits the flag
// entirely (r.length !== 2). Verified against the pre-round-1 source
// (fa1fd6d~1) with a standalone probe before landing this rewrite.
scenario(
  'S. packStage emits --radius <before>,<after> only for a valid [before,after] PAIR, omits it for any other shape -- even an all-numeric one (finding 1)',
  baseArgs({
    tasks: [
      { id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [], radius: [3, 5] },
      { id: 'T2', type: 'feature', files: ['src/b.ts'], tests: ['src/b.test.ts'], brief: 'add beta', dependsOn: [], radius: [3, 5, 7] },
    ],
  }),
  ({ calls }) => {
    const packT1 = calls.find((c) => c.label === 'pack:T1')
    check('S: a valid [before,after] pair emits --radius 3,5', !!packT1 && packT1.prompt.includes(' --radius 3,5'), JSON.stringify(packT1 && packT1.prompt))
    const packT2 = calls.find((c) => c.label === 'pack:T2')
    // Match the actual CLI flag usage (a digit follows), not the prompt's OWN
    // prose note explaining the omission ("...no --radius flag...", which
    // itself legitimately contains the substring " --radius "). A 3-element,
    // all-numeric radius ([3,5,7]) is the discriminating shape -- see the
    // scenario-level comment above.
    check('S: an invalid radius shape (3 elements, not a [before,after] pair) omits the --radius flag entirely', !!packT2 && !/--radius \d/.test(packT2.prompt), JSON.stringify(packT2 && packT2.prompt))
  },
  { ...passingChainFor('T1'), ...passingChainFor('T2') },
)

// ---------- scenario T (finding 1) ----------
scenario(
  'T. a failed or missing pack.md from review-pack.mjs is a (pack) blocker, never a silent fallback path (finding 1)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('T: the task is blocked with a (pack) finding', !!t1 && t1.blocked === true && Array.isArray(t1.blockerFindings) && t1.blockerFindings.some((f) => f.file === '(pack)'), JSON.stringify(t1))
    check('T: no packPath fallback was assigned to the task', !!t1 && t1.packPath === undefined, JSON.stringify(t1 && t1.packPath))
    const reviewCalls = calls.filter((c) => c.label === 'review:T1')
    check('T: the reviewer never runs against a pack that was never built', reviewCalls.length === 0, JSON.stringify(reviewCalls))
    const packFinding = (result.remainingFindings || []).find((f) => f.file === '(pack)')
    check('T: the run carries a (pack) blocker finding, severity blocker', !!packFinding && packFinding.severity === 'blocker', JSON.stringify(packFinding))
    check('T: the run is not clean', result.clean === false, JSON.stringify(result.remainingFindings))
  },
  {
    ...passingChainFor('T1'),
    'pack:T1': () => ({ out: '', bytes: 0, truncated: false, sections: [], exitCode: 2 }),
  },
)

// ---------- scenario U (finding 2) ----------
scenario(
  'U. re-review builds a real review-pack.mjs call (real --plan, a captured --base sha, no placeholder) and reads the returned pack path (finding 2)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH }),
  ({ calls }) => {
    const rpack = calls.find((c) => c.label === 'pack:T1:r1')
    check('U: the round-1 re-review pack call passes the real --plan path', !!rpack && rpack.prompt.includes('--plan ' + PLAN_PATH), JSON.stringify(rpack && rpack.prompt))
    check('U: the round-1 re-review pack call passes a captured --base sha, never the old literal placeholder', !!rpack && rpack.prompt.includes('--base base-fix-base:T1:r1') && !rpack.prompt.includes('fix-round-1-base'), JSON.stringify(rpack && rpack.prompt))
    const baseCall = calls.find((c) => c.label === 'fix-base:T1:r1')
    check('U: a git rev-parse HEAD call captures the round base sha before the fix round runs', !!baseCall, JSON.stringify(calls.map((c) => c.label)))
    const rereview = calls.find((c) => c.label === 're-review:T1:r1')
    check('U: the re-reviewer prompt cites the pack path the script actually returned, not a fallback', !!rereview && rereview.prompt.includes('auto-pack/pack:T1:r1.md'), JSON.stringify(rereview && rereview.prompt))
  },
  {
    ...passingChainFor('T1'),
    'review:T1': () => ({ specCompliance: 'partial', findings: [{ severity: 'critical', file: 'src/a.ts', line: 1, summary: 'x', scenario: 'y' }], assessment: 'needs-fixes' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'ADDRESSED', evidence: 'src/a.ts:1' }], newFindings: [] }),
  },
)

// ---------- scenario V (finding 2) ----------
scenario(
  'V. re-review with no build plan path in scope surfaces a (pack) gap finding instead of an invalid placeholder call (finding 2)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }), // no buildPlanPath
  ({ result, calls }) => {
    const rereviewPack = calls.find((c) => c.label === 'pack:T1:r1')
    check('V: no review-pack.mjs call is attempted for the re-review when no plan path is in scope', !rereviewPack, JSON.stringify(rereviewPack))
    const gap = (result.remainingFindings || []).find((f) => f.file === '(pack)' && f.phase === 'Fix')
    check('V: a (pack) gap finding is surfaced instead of an invalid call', !!gap, JSON.stringify(result.remainingFindings))
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('V: the finding stays open (NOT ADDRESSED, fail-safe) rather than silently passing', !!t1 && t1.status === 'open', JSON.stringify(t1))
  },
  {
    ...passingChainFor('T1'),
    'review:T1': () => ({ specCompliance: 'partial', findings: [{ severity: 'critical', file: 'src/a.ts', line: 1, summary: 'x', scenario: 'y' }], assessment: 'needs-fixes' }),
  },
)

// ---------- scenario W (finding 3) ----------
scenario(
  'W. the fix-brief.mjs dispatch inlines the findings JSON and instructs writing it before running the script (finding 3)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH }),
  ({ calls }) => {
    const briefCall = calls.find((c) => c.label === 'fix-brief:T1:r3')
    check('W: a fix-brief:T1:r3 call happens', !!briefCall, JSON.stringify(calls.map((c) => c.label)))
    const findingsJson = JSON.stringify([{ severity: 'critical', file: 'src/a.ts', line: 1, summary: 'x', scenario: 'y' }])
    check('W: the prompt inlines the exact findings JSON', !!briefCall && briefCall.prompt.includes(findingsJson), JSON.stringify(briefCall && briefCall.prompt))
    check(
      // Fix 1: the command line now carries the scriptsDir-prefixed absolute
      // path ('node "<scriptsDir>/fix-brief.mjs"'), never the old bare
      // relative form -- match that, not the retired literal string.
      'W: the prompt instructs writing that JSON to a path BEFORE running fix-brief.mjs',
      !!briefCall && briefCall.prompt.indexOf(findingsJson) < briefCall.prompt.indexOf('node "' + SCRIPTS_DIR + '/fix-brief.mjs"'),
      JSON.stringify(briefCall && briefCall.prompt),
    )
  },
  {
    ...passingChainFor('T1'),
    'review:T1': () => ({ specCompliance: 'fail', findings: [{ severity: 'critical', file: 'src/a.ts', line: 1, summary: 'x', scenario: 'y' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix:T1:r2': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r2': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix-plan:T1:r3': () => ({ decisions: [{ key: '#0', action: 'fix', design: 'd', invariant: 'i', tests: 't', reason: 'r' }], note: 'n' }),
    'fix:T1:r3': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r3': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
  },
)

// ---------- scenario X (finding 4) ----------
scenario(
  'X. a dead/null reviewer response is a (review) blocker, never a silent clean pass (finding 4)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ result }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('X: the task is blocked with a (review) finding', !!t1 && t1.blocked === true && Array.isArray(t1.blockerFindings) && t1.blockerFindings.some((f) => f.file === '(review)'), JSON.stringify(t1))
    check('X: the task never reports itself complete', !!t1 && t1.status !== 'complete', JSON.stringify(t1))
    check('X: the run is not clean', result.clean === false, JSON.stringify(result.remainingFindings))
  },
  { ...passingChainFor('T1') }, // 'review:T1' deliberately not supplied -> null
)

// ---------- scenario Y (finding 5) ----------
scenario(
  'Y. an important-severity finding that survives all 4 fix rounds still makes the run not clean (finding 5)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH }),
  ({ result }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('Y: the task stays open after 4 rounds with an important (not critical) finding', !!t1 && t1.status === 'open' && Array.isArray(t1.remaining) && t1.remaining[0] && t1.remaining[0].severity === 'important', JSON.stringify(t1))
    const majorFinding = (result.remainingFindings || []).find((f) => f.file === 'src/a.ts' && f.severity === 'major')
    check('Y: the run-wide finding maps important -> major, never blocker', !!majorFinding, JSON.stringify(result.remainingFindings))
    check('Y: the run is NOT clean, even though no finding carries blocker severity', result.clean === false && !(result.remainingFindings || []).some((f) => f.severity === 'blocker'), JSON.stringify(result.remainingFindings))
  },
  {
    ...PASSING_CHAIN,
    'review:T1': () => ({ specCompliance: 'partial', findings: [{ severity: 'important', file: 'src/a.ts', line: 2, summary: 'important nit', scenario: 'z' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix:T1:r2': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r2': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix-plan:T1:r3': () => ({ decisions: [{ key: '#0', action: 'fix', design: 'd', invariant: 'i', tests: 't', reason: 'r' }], note: 'n' }),
    'fix:T1:r3': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r3': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix:T1:r4': () => ({ status: 'blocked', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r4': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
  },
)

// ---------- scenario Z (finding 6) ----------
scenario(
  'Z. _args.fixPlanOverride skips the fix-brief and fix-plan calls at round 3 (finding 6)',
  baseArgs({
    tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }],
    buildPlanPath: PLAN_PATH,
    fixPlanOverride: { decisions: [{ key: '#0', action: 'fix', design: 'ruled inline', invariant: 'i', tests: 't', reason: 'session already ruled' }], note: 'override' },
  }),
  ({ calls }) => {
    const briefCall = calls.find((c) => c.label === 'fix-brief:T1:r3')
    const planCall = calls.find((c) => c.label === 'fix-plan:T1:r3')
    check('Z: no fix-brief:T1:r3 call is made when an override is supplied', !briefCall, JSON.stringify(calls.map((c) => c.label)))
    check('Z: no fix-plan:T1:r3 call is made when an override is supplied', !planCall, JSON.stringify(calls.map((c) => c.label)))
    const execCall = calls.find((c) => c.label === 'fix:T1:r3')
    check('Z: the round-3 executor still runs, using the override design', !!execCall && execCall.prompt.includes('ruled inline'), JSON.stringify(execCall && execCall.prompt))
  },
  {
    ...PASSING_CHAIN,
    'review:T1': () => ({ specCompliance: 'fail', findings: [{ severity: 'critical', file: 'src/a.ts', line: 1, summary: 'x', scenario: 'y' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix:T1:r2': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r2': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix:T1:r3': () => ({ status: 'done', filesChanged: ['src/a.ts'], deviations: '', notes: '' }),
    're-review:T1:r3': () => ({ perFinding: [{ key: '#0', status: 'ADDRESSED', evidence: 'src/a.ts:1' }], newFindings: [] }),
  },
)

// ---------- scenario AA (finding 7) ----------
scenario(
  'AA. a blocked implementer becomes a task blocker before pack ever runs (finding 7)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('AA: the task is blocked with an (implement) finding', !!t1 && t1.blocked === true && Array.isArray(t1.blockerFindings) && t1.blockerFindings.some((f) => f.file === '(implement)'), JSON.stringify(t1))
    const packCalls = calls.filter((c) => c.label === 'pack:T1')
    check('AA: pack never runs against code that was never actually written', packCalls.length === 0, JSON.stringify(packCalls))
    const reviewCalls = calls.filter((c) => c.label === 'review:T1')
    check('AA: review never runs either', reviewCalls.length === 0, JSON.stringify(reviewCalls))
  },
  {
    ...PASSING_RED_CHECK,
    'impl:T1': () => ({ status: 'blocked', filesChanged: [], deviations: 'could not find the referenced module', notes: '' }),
  },
)

// ---------- scenario AB (finding 8) ----------
scenario(
  'AB. redCheckStage never trusts a bare structurallyRed:true claim -- it cross-checks audit.tests[] and redRun.ran mechanically (finding 8)',
  // A15: exercises the STANDARD-profile red-check mechanism directly --
  // pinned explicitly since baseArgs()'s real default is now 'lean' for a
  // small/no-HIGH-risk fixture, which skips redCheckStage entirely.
  baseArgs({ profile: 'standard', tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ result, calls }) => {
    const redGate = (result.remainingFindings || []).filter((f) => f.file === '(red-gate)')
    check('AB: a lying structurallyRed:true with an empty tests[] still blocks -- the mechanical check wins over the bare claim', redGate.length === 1 && redGate[0].severity === 'blocker', JSON.stringify(redGate))
    const redCheckPromptCall = calls.find((c) => c.label === 'red-check:T1')
    check('AB: the red-check prompt names the task\'s declared test files', !!redCheckPromptCall && redCheckPromptCall.prompt.includes('src/a.test.ts'), JSON.stringify(redCheckPromptCall && redCheckPromptCall.prompt))
  },
  {
    'tests:T1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/a.test.ts', exitCode: 0, output: 'PASS (nothing asserted yet)' }] }),
    // The auditor LIES: claims structurallyRed even though it names zero tests.
    'red-check:T1': () => ({ structurallyRed: true, tests: [], blockers: [], remediation: '' }),
    'tests:T1:remediate': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/a.test.ts', exitCode: 0, output: 'PASS (still nothing asserted)' }] }),
    'red-check:T1:r2': () => ({ structurallyRed: true, tests: [], blockers: [], remediation: '' }),
  },
)

// ---------- scenario AC (finding 9) ----------
scenario(
  'AC. the fix executor prompt carries the task\'s owned files, verifyCommands.perRound, and the prior brief/report paths (finding 9)',
  baseArgs({
    tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }],
    buildPlanPath: PLAN_PATH,
    verifyCommands: { perRound: ['npm run check'], final: ['npm test'] },
  }),
  ({ calls }) => {
    const fixCall = calls.find((c) => c.label === 'fix:T1:r1')
    check('AC: the fix executor prompt lists the task\'s owned files', !!fixCall && fixCall.prompt.includes('src/a.ts'), JSON.stringify(fixCall && fixCall.prompt))
    check('AC: the fix executor prompt includes the perRound verify command', !!fixCall && fixCall.prompt.includes('npm run check'), JSON.stringify(fixCall && fixCall.prompt))
    check('AC: the fix executor prompt references the task brief path', !!fixCall && fixCall.prompt.includes('brief.md'), JSON.stringify(fixCall && fixCall.prompt))
    check('AC: the fix executor prompt references the prior implementer report path', !!fixCall && fixCall.prompt.includes('report.md'), JSON.stringify(fixCall && fixCall.prompt))
  },
  {
    ...PASSING_CHAIN,
    'review:T1': () => ({ specCompliance: 'partial', findings: [{ severity: 'critical', file: 'src/a.ts', line: 1, summary: 'x', scenario: 'y' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'done', filesChanged: ['src/a.ts'], deviations: '', notes: '' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'ADDRESSED', evidence: 'src/a.ts:1' }], newFindings: [] }),
  },
)

// ---------- scenario AD (findings 10 & 12) ----------
// Fix round 2 (test integrity): the ORIGINAL fixture (a single task, explicit
// risk:'LOW') let this scenario's pairsFor assertion pass identically
// against the OLD buggy pairsFor -- with only one task, the global per-file
// riskMap could never disagree with that task's own risk, so the check never
// actually exercised the bug it claims to guard. The real divergence needs
// two tasks with DIFFERENT explicit risk values sharing a file: riskMap is
// populated once, up front, by iterating ALL tasks in array order, so T2's
// explicit HIGH (processed after T1) overwrites T1's explicit LOW for their
// shared file -- by the time T1's OWN wave runs, riskMap already (wrongly)
// says HIGH for T1's file. The OLD pairsFor read that contaminated riskMap
// even for an explicit-LOW task (`t.risk === 'HIGH' || ownedFiles.some(f =>
// riskMap.get(f) !== 'LOW')` -- no LOW short-circuit); isHighRisk (and the
// fixed pairsFor, which now delegates to it) checks the task's OWN risk
// field FIRST and never touches riskMap when it is set. Because the OLD
// pairsFor also warms whatever wave it (wrongly) sees as HIGH first,
// warmUp's own de-dup then SKIPS T2's later, correctly-HIGH warm-up (same
// model:effort key already warmed) -- so on the old code this produces
// exactly ONE warmup call, for the wrong wave. Verified against the
// pre-round-1 source (fa1fd6d~1) with a standalone probe before landing this
// rewrite.
scenario(
  "AD. an explicit risk:'LOW' task still routes Sonnet throughout (impl/review/fix) even sharing a file with a later, explicit risk:'HIGH' dependent -- pairsFor's per-wave warm-up agrees with isHighRisk, never confused by the shared file's riskMap entry (findings 10 & 12)",
  baseArgs({
    tasks: [
      { id: 'T1', type: 'feature', files: ['src/shared.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [], risk: 'LOW' },
      { id: 'T2', type: 'feature', files: ['src/shared.ts'], tests: ['src/b.test.ts'], brief: 'add beta', dependsOn: ['T1'], risk: 'HIGH' },
    ],
    buildPlanPath: PLAN_PATH,
  }),
  ({ calls }) => {
    const warmups = calls.filter((c) => c.label === 'warmup' && c.phase === 'Implement')
    check(
      'AD: exactly 2 warmup calls -- one per wave (T1 alone, then T2 alone; dependsOn keeps them in separate, sequential waves) (finding 12)',
      warmups.length === 2,
      JSON.stringify(warmups),
    )
    check(
      "AD: T1's wave (explicit LOW) warms Sonnet/implement -- NOT confused by T2's later explicit HIGH contaminating their shared file's riskMap entry (finding 12)",
      !!warmups[0] && warmups[0].model === 'claude-sonnet-5' && warmups[0].effort === 'medium',
      JSON.stringify(warmups),
    )
    check("AD: T2's wave (explicit HIGH) warms Sonnet at implementHigh effort (finding 12)", !!warmups[1] && warmups[1].model === 'claude-sonnet-5' && warmups[1].effort === 'high', JSON.stringify(warmups))
    const impl = calls.find((c) => c.label === 'impl:T1')
    check('AD: the T1 implementer runs on Sonnet (finding 10)', !!impl && impl.model === 'claude-sonnet-5', JSON.stringify(impl))
    const review = calls.find((c) => c.label === 'review:T1')
    check('AD: the T1 reviewer runs on Sonnet (finding 10)', !!review && review.model === 'claude-sonnet-5', JSON.stringify(review))
    const fix = calls.find((c) => c.label === 'fix:T1:r1')
    check('AD: the T1 round-1 fix executor runs on Sonnet (finding 10)', !!fix && fix.model === 'claude-sonnet-5', JSON.stringify(fix))
    const implT2 = calls.find((c) => c.label === 'impl:T2')
    check('AD: the T2 implementer runs on Sonnet at HIGH-risk implementHigh effort (finding 10, converse case)', !!implT2 && implT2.model === 'claude-sonnet-5' && implT2.effort === 'high', JSON.stringify(implT2))
  },
  {
    ...passingChainFor('T1'),
    ...passingChainFor('T2'),
    'review:T1': () => ({ specCompliance: 'partial', findings: [{ severity: 'critical', file: 'src/shared.ts', line: 1, summary: 'x', scenario: 'y' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'done', filesChanged: ['src/shared.ts'], deviations: '', notes: '' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'ADDRESSED', evidence: 'src/shared.ts:1' }], newFindings: [] }),
    'review:T2': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
  },
)

// ==================== FIX ROUND 2 (2 Important regressions fixed) ====================

// ---------- scenario AE (fix round 2, finding 1) ----------
// Proves the round-2 fix directly, on the ENGINE code (not just scenario
// content): review-pack.mjs treats ANY non-empty --test-plan value as a real
// file path (throws a ContentError trying to read it) and only skips the
// Test-plan-excerpt section when the flag is absent entirely -- so
// packPrompt must OMIT the flag, never pass a placeholder like "(none)",
// when _args.testPlanPath is unset; and must pass the real path through
// unmodified when it is set.
scenario(
  'AE. packPrompt omits --test-plan entirely when no test plan is in scope -- never a placeholder that guarantees a pack blocker (fix round 2, finding 1)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }), // no testPlanPath
  ({ calls }) => {
    const packT1 = calls.find((c) => c.label === 'pack:T1')
    // Match the actual review-pack.mjs command line, not the prompt's OWN
    // prose note explaining the omission ("...no --test-plan flag...", which
    // itself legitimately contains the substring "--test-plan"). Fix 1: the
    // command line now starts with the scriptsDir-prefixed absolute path.
    const cmdLine = packT1 && (packT1.prompt.split('\n').find((l) => l.startsWith('node "' + SCRIPTS_DIR + '/review-pack.mjs"')) || '')
    check('AE: no --test-plan flag at all on the command line when _args.testPlanPath is unset', !!packT1 && !cmdLine.includes('--test-plan'), JSON.stringify(cmdLine))
    check('AE: the command line still carries --plan (required, unaffected by this fix)', !!packT1 && cmdLine.includes('--plan'), JSON.stringify(cmdLine))
  },
  { ...passingChainFor('T1') },
)
scenario(
  'AE2. packPrompt passes the real --test-plan path through, never a placeholder, when _args.testPlanPath IS set (fix round 2, finding 1)',
  baseArgs({
    tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }],
    testPlanPath: '.claude/pipeline/dry/test-plan.md',
  }),
  ({ calls }) => {
    const packT1 = calls.find((c) => c.label === 'pack:T1')
    check('AE2: --test-plan carries the real configured path', !!packT1 && packT1.prompt.includes('--test-plan .claude/pipeline/dry/test-plan.md'), JSON.stringify(packT1 && packT1.prompt))
    check('AE2: never a placeholder like "(none)"', !!packT1 && !packT1.prompt.includes('--test-plan (none)'), JSON.stringify(packT1 && packT1.prompt))
  },
  { ...passingChainFor('T1') },
)

// ---------- scenario AF (fix round 2, finding 2) ----------
// Proves the round-2 fix directly, on the ENGINE code: (a) implementPrompt
// now carries the exact COMMIT_NOTE text the fix executors already use, so a
// real commit exists before ANY fix-base capture for round 1; (b)
// packStage's FIRST review diffs from the real pre-implement sha captured
// just before the implementer ran, not from a naive 'worktree'/HEAD-relative
// base that would go empty the instant that commit lands (git diff HEAD
// after a commit shows nothing -- verified empirically against a scratch
// repo before landing this fix).
scenario(
  "AF. implementPrompt carries the fix-executor COMMIT_NOTE verbatim, and packStage's FIRST review --base uses the captured pre-implement sha (fix round 2, finding 2)",
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ calls }) => {
    const impl = calls.find((c) => c.label === 'impl:T1')
    check(
      'AF: implementPrompt includes the exact fix-executor COMMIT_NOTE wording (reused, not a new instruction)',
      !!impl && impl.prompt.includes('Commit your change when you are done (a small, scoped commit) so this round\'s exact diff can be captured and re-reviewed -- never leave it uncommitted.'),
      JSON.stringify(impl && impl.prompt),
    )
    const implBase = calls.find((c) => c.label === 'impl-base:T1')
    check('AF: a pre-implement git-sha capture happens', !!implBase, JSON.stringify(calls.map((c) => c.label)))
    check(
      'AF: the pre-implement capture runs BEFORE the implementer call, in call order',
      !!implBase && !!impl && calls.indexOf(implBase) < calls.indexOf(impl),
      JSON.stringify(calls.map((c) => c.label)),
    )
    const pack = calls.find((c) => c.label === 'pack:T1')
    check(
      "AF: packStage's FIRST review --base uses the captured pre-implement sha, never the bare 'worktree' fallback, once a real capture exists",
      !!pack && pack.prompt.includes('--base implbase-impl-base:T1') && !pack.prompt.includes('--base worktree'),
      JSON.stringify(pack && pack.prompt),
    )
  },
  { ...passingChainFor('T1') },
)

// ==================== TASK 10 (A10): bugfix task types + gating ====================

// ---------- scenario G (A10 + A12 Final-pass-extended) ----------
// A HIGH-risk `fix` task routes its implementer to Sonnet at implementHigh
// effort (implementation is never Fable -- ruling 2026-09-13) and its
// reviewer to Opus (HIGH-risk review is Opus, same ruling); its dependent
// revert-probes run strictly sequentially (never parallel); and exactly ONE
// checksum:after agent verifies BOTH probed files' restores, in-script,
// against the digests Baseline's own manifest recorded -- never one call per
// probe, and never the probe agents' own self-report. Extended (A12) to also
// prove the Final pass's conditional Fable read: this run has a HIGH-risk
// task, so exactly one final-read call happens, on Fable (final-read is a
// session-side read, not an in-engine implement/review/root-cause role, so
// the 2026-09-13 ruling does not move it off Fable).
scenario(
  'G. a HIGH-risk fix routes Sonnet(implementHigh)/Opus(review/root-cause) throughout, its revert-probes run strictly sequentially behind exactly ONE checksum:after call, and Final pass runs its conditional Fable read',
  baseArgs({
    tasks: [
      { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'find the cause', dependsOn: [] },
      { id: 'RT1', type: 'repro-test', files: [], tests: ['src/bug.test.ts'], brief: 'prove the bug', dependsOn: [], wrongValue: 'WRONG_TOTAL' },
      { id: 'F1', type: 'fix', files: ['src/money.ts'], tests: [], brief: 'fix the money bug', dependsOn: ['RC1', 'RT1'], risk: 'HIGH' },
      { id: 'RP1', type: 'revert-probe', files: [], tests: [], brief: 'probe money.ts', dependsOn: ['F1'], file: 'src/money.ts', test: 'src/bug.test.ts' },
      { id: 'RP2', type: 'revert-probe', files: [], tests: [], brief: 'probe money-helpers.ts', dependsOn: ['F1'], file: 'src/money-helpers.ts', test: 'src/bug.test.ts' },
    ],
    buildPlanPath: PLAN_PATH,
  }),
  ({ result, calls }) => {
    const implCall = calls.find((c) => c.label === 'impl:F1')
    check('G: the HIGH-risk fix implementer runs on Sonnet at implementHigh effort', !!implCall && implCall.model === 'claude-sonnet-5' && implCall.effort === 'high', JSON.stringify(implCall))
    const reviewCall = calls.find((c) => c.label === 'review:F1')
    check('G: the HIGH-risk fix reviewer runs on Opus', !!reviewCall && reviewCall.model === 'claude-opus-5', JSON.stringify(reviewCall))
    // Fix round 1, finding 1: RC1 declares no `risk` field and empty
    // files/tests -- the natural, realistic shape for a root-cause
    // investigation (per the plan and every fixture). Its dependent fix
    // (F1) IS HIGH-risk though, and that classification must propagate
    // backward -- a HIGH-risk fix's own root-cause investigation must not
    // silently run on Sonnet just because the root-cause task itself has
    // nothing to classify.
    const rootCauseCall = calls.find((c) => c.label === 'root-cause:RC1')
    check('G: RC1\'s root-cause investigation also runs on Opus, because its dependent fix F1 is HIGH-risk', !!rootCauseCall && rootCauseCall.model === 'claude-opus-5', JSON.stringify(rootCauseCall))
    const probeLabels = calls.filter((c) => c.label === 'probe:RP1' || c.label === 'probe:RP2').map((c) => c.label)
    check('G: both revert-probes ran', probeLabels.length === 2, JSON.stringify(probeLabels))
    check(
      'G: the probes ran strictly sequentially, RP1 before RP2 (never parallel)',
      calls.findIndex((c) => c.label === 'probe:RP1') < calls.findIndex((c) => c.label === 'probe:RP2'),
      JSON.stringify(calls.map((c) => c.label)),
    )
    const checksumCalls = calls.filter((c) => c.label === 'checksum:after')
    check('G: exactly ONE checksum:after call total, not one per probe', checksumCalls.length === 1, JSON.stringify(checksumCalls.map((c) => c.label)))
    check(
      'G: mutationProbe reports 2 probed, restoredVerified true from the in-script digest comparison',
      !!result.mutationProbe && result.mutationProbe.probed === 2 && result.mutationProbe.restoredVerified === true && result.mutationProbe.allCaught === true,
      JSON.stringify(result.mutationProbe),
    )
    // A12 (Final pass), G extended: hasHighRisk is true (F1 is HIGH) -- the
    // conditional Fable read runs exactly once, alongside the final gate.
    const finalReadCalls = calls.filter((c) => c.label === 'final-read')
    check('G (Final pass): exactly one final-read call, on Fable, when the run has a HIGH-risk task', finalReadCalls.length === 1 && finalReadCalls[0].model === 'claude-fable-5-1', JSON.stringify(finalReadCalls))
    const finalGateCalls = calls.filter((c) => c.label === 'final-gate')
    check('G (Final pass): the final gate runs once', finalGateCalls.length === 1, JSON.stringify(finalGateCalls))
    check(
      'G (Final pass): finalPass reports ran/skipped/model/completed for the HIGH-risk case',
      !!result.finalPass && result.finalPass.ran === true && result.finalPass.skipped === null && result.finalPass.model === 'claude-fable-5-1' && result.finalPass.completed === true,
      JSON.stringify(result.finalPass),
    )
  },
  {
    'root-cause:RC1': () => ({ reproduced: true, causeConfirmed: true, wrongValueObserved: 'WRONG_TOTAL', note: 'confirmed' }),
    'tests:RT1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/bug.test.ts', exitCode: 1, output: 'FAIL: expected 100 but got WRONG_TOTAL' }] }),
    'red-check:RT1': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    'impl:F1': () => ({ status: 'done', filesChanged: ['src/money.ts'], deviations: '', notes: '' }),
    'review:F1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'probe:RP1': () => ({ caught: true, restored: true, evidence: 'fails as expected once reverted', backupPath: '/tmp/revertprobe-RP1', fallback: '' }),
    'probe:RP2': () => ({ caught: true, restored: true, evidence: 'fails as expected once reverted', backupPath: '/tmp/revertprobe-RP2', fallback: '' }),
    'checksum:after': () => ({ files: [{ file: 'src/money.ts', digest: 'sameA' }, { file: 'src/money-helpers.ts', digest: 'sameB' }] }),
    'baseline-manifest': () => ({
      files: [
        { path: 'src/money.ts', status: 'modified', exists: true, digest: 'sameA', risk: 'HIGH', changedLines: 4 },
        { path: 'src/money-helpers.ts', status: 'modified', exists: true, digest: 'sameB', risk: 'LOW', changedLines: 0 },
        { path: 'src/bug.test.ts', status: 'modified', exists: true, digest: 'x', risk: 'LOW', changedLines: 2 },
      ],
      validCommands: [],
      artifacts: [],
      planBytes: { build: 0, test: 0 },
    }),
  },
)

// ---------- scenario AN (A10, fix round 2 finding 1: transitive HIGH-risk inheritance) ----------
// hasHighRiskDependentFix() must promote a root-cause task to Opus when its
// dependent HIGH-risk fix reaches it through an INTERMEDIATE task, not only
// through a direct dependsOn edge (scenario G already covers the direct
// case). RC1 is a TRANSITIVE ancestor of F1 here: F1 dependsOn RT1, and RT1
// (a repro-test, which validateTasks itself already accepts as a valid
// ancestor hop for a fix's root-cause/repro-test requirement) dependsOn RC1
// -- F1 never names RC1 directly. Also proves `.some()` semantics: RC2 has
// TWO dependent fixes (F3 direct+LOW), and RC1 similarly has a second
// dependent (F2, direct+LOW) alongside F1 -- a LOW-risk sibling dependent
// must never suppress promotion driven by another, and RC2 (whose ONLY
// dependent is LOW) must stay on Sonnet, proving this is not just "any
// dependent promotes unconditionally".
scenario(
  'AN. hasHighRiskDependentFix promotes a root-cause to Fable through a TRANSITIVE fix dependency (fix -> repro-test -> root-cause), not only a direct one; a LOW-only chain stays on Sonnet',
  baseArgs({
    tasks: [
      { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'find the cause', dependsOn: [] },
      { id: 'RT1', type: 'repro-test', files: [], tests: ['src/bug.test.ts'], brief: 'prove the bug', dependsOn: ['RC1'], wrongValue: 'WRONG_TOTAL' },
      { id: 'F1', type: 'fix', files: ['src/money.ts'], tests: [], brief: 'fix the money bug', dependsOn: ['RT1'], risk: 'HIGH' },
      { id: 'F2', type: 'fix', files: ['src/other.ts'], tests: [], brief: 'an unrelated LOW-risk fix sharing the same root-cause', dependsOn: ['RC1', 'RT1'], risk: 'LOW' },
      { id: 'RC2', type: 'root-cause', files: [], tests: [], brief: 'find a different cause', dependsOn: [] },
      { id: 'RT2', type: 'repro-test', files: [], tests: ['src/other-bug.test.ts'], brief: 'prove the other bug', dependsOn: ['RC2'], wrongValue: 'OTHER_WRONG' },
      { id: 'F3', type: 'fix', files: ['src/other2.ts'], tests: [], brief: 'a LOW-risk fix whose only root-cause has no HIGH dependent', dependsOn: ['RT2'], risk: 'LOW' },
    ],
    buildPlanPath: PLAN_PATH,
  }),
  ({ calls }) => {
    const rc1Call = calls.find((c) => c.label === 'root-cause:RC1')
    check(
      'AN: RC1 (only a TRANSITIVE ancestor of HIGH-risk F1, via RT1) still runs on Opus',
      !!rc1Call && rc1Call.model === 'claude-opus-5',
      JSON.stringify(rc1Call),
    )
    const rc2Call = calls.find((c) => c.label === 'root-cause:RC2')
    check(
      'AN: RC2 (whose only dependent fix F3 is LOW-risk) stays on Sonnet -- promotion is not unconditional',
      !!rc2Call && rc2Call.model === 'claude-sonnet-5',
      JSON.stringify(rc2Call),
    )
  },
  {
    'root-cause:RC1': () => ({ reproduced: true, causeConfirmed: true, wrongValueObserved: 'WRONG_TOTAL', note: 'confirmed' }),
    'root-cause:RC2': () => ({ reproduced: true, causeConfirmed: true, wrongValueObserved: 'OTHER_WRONG', note: 'confirmed' }),
    'tests:RT1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/bug.test.ts', exitCode: 1, output: 'FAIL: expected 100 but got WRONG_TOTAL' }] }),
    'red-check:RT1': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    'tests:RT2': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/other-bug.test.ts', exitCode: 1, output: 'FAIL: expected 5 but got OTHER_WRONG' }] }),
    'red-check:RT2': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the other bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    'impl:F1': () => ({ status: 'done', filesChanged: ['src/money.ts'], deviations: '', notes: '' }),
    'review:F1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'impl:F2': () => ({ status: 'done', filesChanged: ['src/other.ts'], deviations: '', notes: '' }),
    'review:F2': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'impl:F3': () => ({ status: 'done', filesChanged: ['src/other2.ts'], deviations: '', notes: '' }),
    'review:F3': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
  },
)

// ==================== POST-AUDIT FIX ROUND: lean-profile repro-test gap, ====================
// ==================== fix-loop confirmedFindings undercount ==================================

// ---------- scenario AO (A15 fix: bugfix-mode / repro-test forces standard) ----------
// A15's profile selector defaulted a small-scale run with no explicit/
// manifest HIGH-risk task to 'lean' -- the COMMON case for an ordinary
// (non-money/auth/tenancy/schema/PII) bug fix. 'lean's "skip the separate
// test author, let the RED check read the implementer's own RED section"
// design assumes an implementer exists to carry that RED-then-GREEN
// evidence. A `repro-test` task's chain (chainForType) has NO implementer at
// all -- [briefStage, testAuthorStage, redCheckStage, finishStage] -- so
// under lean both stages short-circuit and the task makes ZERO agent calls,
// reporting a fabricated clean:true having proven nothing about the bug's
// reproduction (a direct violation of the house Pipeline Law's mandatory
// repro-first RED gate). This is the REALISTIC ordinary-bugfix shape:
// root-cause -> repro-test -> fix, no HIGH-risk task anywhere, mode:'bugfix',
// small scale -- exactly the shape that used to silently lose its only
// verification step. Before the fix: this fixture resolved to 'lean' and
// RT1 made zero calls (the reviewer's exact finding, reproduced here). After
// the fix: mode:'bugfix' (independently, also: the presence of a
// repro-test-type task) forces 'standard', so RT1's mechanical, BEHAVIORAL
// RED check (isBehaviorallyRed -- the failure output must literally contain
// t.wrongValue, never trusted from the auditor's prose alone) actually runs.
scenario(
  "AO. an ordinary bugfix run (root-cause -> repro-test -> fix, no HIGH-risk anywhere) forces the 'standard' profile so the repro-test's mandatory RED check actually runs, instead of silently making zero calls under 'lean'",
  baseArgs({
    tasks: [
      { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'find the cause', dependsOn: [] },
      { id: 'RT1', type: 'repro-test', files: [], tests: ['src/bug.test.ts'], brief: 'prove the bug', dependsOn: [], wrongValue: 'WRONG_TOTAL' },
      { id: 'F1', type: 'fix', files: ['src/money.ts'], tests: [], brief: 'fix the money bug', dependsOn: ['RC1', 'RT1'] },
    ],
    mode: 'bugfix',
    buildPlanPath: PLAN_PATH,
  }),
  ({ result, calls }) => {
    check(
      "AO: profile resolves to 'standard' for a small-scale, no-HIGH-risk bugfix run -- the mandatory repro-test red-check is never left to 'lean's default",
      result.profile === 'standard',
      result.profile,
    )
    const testCalls = calls.filter((c) => c.label === 'tests:RT1')
    check("AO: the repro-test's test author actually ran (zero calls under 'lean' was the reviewer's exact reproduced finding)", testCalls.length === 1, JSON.stringify(calls.map((c) => c.label)))
    const redChecks = calls.filter((c) => c.label === 'red-check:RT1')
    check("AO: the repro-test's mechanical RED-gate check actually ran", redChecks.length === 1, JSON.stringify(calls.map((c) => c.label)))
    const rt1 = (result.tasks || []).find((t) => t.id === 'RT1')
    check(
      "AO: RT1 completes clean with behaviorallyRed:true -- genuinely behavioral (the bug's own wrong value, not just a structural assertion failure)",
      !!rt1 && rt1.status === 'complete' && rt1.clean === true && rt1.behaviorallyRed === true,
      JSON.stringify(rt1),
    )
    check("AO: the dependent fix proceeds past a real red-gate, and the whole run reaches clean", result.clean === true, JSON.stringify(result.remainingFindings))
    check("AO: result.approach stays the literal 'dev-pipeline' even under mode:'bugfix' -- approach names the engine/methodology, mode names bugfix-vs-feature", result.approach === 'dev-pipeline', result.approach)
  },
  {
    'root-cause:RC1': () => ({ reproduced: true, causeConfirmed: true, wrongValueObserved: 'WRONG_TOTAL', note: 'confirmed' }),
    'tests:RT1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/bug.test.ts', exitCode: 1, output: 'FAIL: expected 100 but got WRONG_TOTAL' }] }),
    'red-check:RT1': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    'impl:F1': () => ({ status: 'done', filesChanged: ['src/money.ts'], deviations: '', notes: '' }),
    'review:F1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
  },
)

// ---------- scenario AP (fixLoopStage fix: confirmedFindings undercount) ----------
// fixLoopStage read t.review.findings ONCE at the top to seed openFindings,
// but a round's re-review (rr.newFindings -- defects the re-reviewer
// discovers IN the fix diff itself, distinct from the prior findings it is
// checking ADDRESSED/NOT ADDRESSED) only ever flowed into THAT round's own
// openFindings/roundHistory, never back onto t.review.findings -- the ONLY
// field A14's confirmedFindings assembly reads. Reproduces the reviewer's
// exact probe: T1's initial review finds 1 critical (F1); round 1 fixes F1,
// but its re-review discovers 2 BRAND NEW criticals (F2, F3); round 2 fixes
// both and the re-review confirms clean. Before the fix: confirmedFindings
// held only F1 (length 1) on a genuinely successful, clean run -- an
// unbounded undercount. After the fix: fixLoopStage folds every round's
// newly-discovered critical/important findings back into the review it
// returns, so confirmedFindings is the UNION of all three (length 3).
scenario(
  "AP. confirmedFindings accumulates every round's newly-discovered findings, not just the initial review pass (fix round 1 -> F1 addressed but discovers F2+F3 -> fix round 2 -> clean)",
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH }),
  ({ result }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check(
      'AP: task T1 completes clean after 2 rounds (F1 fixed round 1; F2+F3 discovered mid-loop and fixed round 2)',
      !!t1 && t1.status === 'complete' && t1.clean === true && t1.rounds === 2,
      JSON.stringify(t1),
    )
    check(
      "AP: confirmedFindings is the UNION of every finding ever confirmed across every round (F1+F2+F3 = 3), never just the initial pass's 1",
      Array.isArray(result.confirmedFindings) && result.confirmedFindings.length === 3,
      JSON.stringify(result.confirmedFindings),
    )
    const summaries = (result.confirmedFindings || []).map((f) => f.summary).sort()
    check(
      'AP: confirmedFindings names all three findings by summary -- the original plus both round-1-discovered ones',
      JSON.stringify(summaries) === JSON.stringify(['round1-discovers-F2', 'round1-discovers-F3', 'the-original-finding'].sort()),
      JSON.stringify(summaries),
    )
    check(
      "AP: every confirmedFindings entry carries taskId:'T1' and phase:'Gate & Review', matching every other entry this assembly produces",
      (result.confirmedFindings || []).every((f) => f.taskId === 'T1' && f.phase === 'Gate & Review'),
      JSON.stringify(result.confirmedFindings),
    )
  },
  {
    ...PASSING_CHAIN,
    'review:T1': () => ({ specCompliance: 'partial', findings: [{ severity: 'critical', file: 'src/a.ts', line: 10, summary: 'the-original-finding', scenario: 'F1' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'done', filesChanged: ['src/a.ts'], deviations: '', notes: '' }),
    're-review:T1:r1': () => ({
      perFinding: [{ key: '#0', status: 'ADDRESSED', evidence: 'src/a.ts:10' }],
      newFindings: [
        { severity: 'critical', file: 'src/b.ts', line: 20, summary: 'round1-discovers-F2', scenario: 'F2' },
        { severity: 'critical', file: 'src/c.ts', line: 30, summary: 'round1-discovers-F3', scenario: 'F3' },
      ],
    }),
    'fix:T1:r2': () => ({ status: 'done', filesChanged: ['src/b.ts', 'src/c.ts'], deviations: '', notes: '' }),
    're-review:T1:r2': () => ({
      perFinding: [
        { key: '#0', status: 'ADDRESSED', evidence: 'src/b.ts:20' },
        { key: '#1', status: 'ADDRESSED', evidence: 'src/c.ts:30' },
      ],
      newFindings: [],
    }),
  },
)

// ---------- scenario H (A10 + A11 sibling-sweep-extended) ----------
// mode:'bugfix': a `fix` task is blocked (chain stops, Ruling recorded, never
// silently proceeding) when its root-cause dependency reports
// reproduced:false. Extended (A11) to also prove the post-loop sibling
// sweep: a grep hit the judge classifies "defect" becomes BOTH a
// remainingFindings entry (source sibling-sweep) and a progress-ledger line.
// Fix round 1, finding 5: F1 now carries a real, PASSING test/red-check
// fixture (tests:F1/red-check:F1/impl:F1/review:F1) even though the current
// engine's chainForType('fix') never calls any of them (a `fix` task
// authors no tests of its own -- see AJ). These exist ONLY so the old,
// pre-Task-10-13 engine (no type dispatch -- every task runs the SAME
// generic test-author/red-check/implement chain) does not coincidentally
// block F1 at its own generic red-gate because F1's `tests` happened to be
// empty. Without this, "the fix task is blocked" and "no impl:F1 call was
// ever made" passed on the OLD engine too, for that unrelated reason,
// making them non-discriminating; with a real passing chain here, the OLD
// engine (which has no root-cause-gating concept at all) proceeds straight
// to impl:F1, and only the NEW engine's fixGateStage still blocks it.
scenario(
  'H. mode bugfix: a fix is blocked when its root-cause reports reproduced:false (Ruling recorded, chain stops); the post-loop sibling sweep turns a defect hit into a finding',
  baseArgs({
    tasks: [
      { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'find the cause', dependsOn: [] },
      { id: 'RT1', type: 'repro-test', files: [], tests: ['src/bug.test.ts'], brief: 'prove the bug', dependsOn: [], wrongValue: 'WRONG_TOTAL' },
      { id: 'F1', type: 'fix', files: ['src/money.ts'], tests: ['src/bug.test.ts'], brief: 'fix the money bug', dependsOn: ['RC1', 'RT1'] },
    ],
    mode: 'bugfix',
    buildPlanPath: PLAN_PATH,
    siblingPatterns: [{ pattern: 'WRONG_TOTAL', note: 'the same off-by-one shape' }],
  }),
  ({ result, calls }) => {
    const f1 = (result.tasks || []).find((t) => t.id === 'F1')
    check(
      'H: the fix task is blocked specifically by the root-cause gate, not a generic (red-gate) side effect',
      !!f1 && f1.blocked === true && Array.isArray(f1.blockerFindings) && f1.blockerFindings.length === 1 && f1.blockerFindings[0].file === '(root-cause)',
      JSON.stringify(f1),
    )
    check('H: no tests:F1/red-check:F1 call was made -- a fix authors no tests of its own even when the run is in bugfix mode', !calls.some((c) => c.label === 'tests:F1' || c.label === 'red-check:F1'), JSON.stringify(calls.map((c) => c.label)))
    const implCalls = calls.filter((c) => c.label === 'impl:F1')
    check('H: no impl:F1 call was ever made -- fixGateStage blocks the chain before implement even though F1\'s tests would otherwise pass cleanly', implCalls.length === 0, JSON.stringify(implCalls))
    const rootCauseFinding = (result.remainingFindings || []).find((f) => f.file === '(root-cause)')
    check('H: a (root-cause) blocker finding is recorded for the blocked fix', !!rootCauseFinding && rootCauseFinding.severity === 'blocker', JSON.stringify(result.remainingFindings))
    const rulingsForF1 = (result.rulings || []).filter((r) => r.taskId === 'F1')
    check('H: a Ruling is recorded for the blocked fix (never a silent discard)', rulingsForF1.length === 1, JSON.stringify(result.rulings))
    check('H: the run is not clean', result.clean === false, JSON.stringify(result.remainingFindings))
    // Fix round 1, finding 4: F1 was blocked by fixGateStage before ever
    // entering the fix-round loop (no rounds ran) -- the checkpoint's
    // progress line must say so accurately, not "fix round 0/4" (which
    // implies a fix round was attempted).
    const f1Checkpoint = (result.checkpoints || []).find((c) => c.alias === 'checkpoint:F1')
    check(
      'H: F1\'s progress line reads "blocked before fix loop", never a fabricated fix-round count',
      !!f1Checkpoint && /blocked before fix loop/.test(f1Checkpoint.payload.progressLine) && !/fix round 0/.test(f1Checkpoint.payload.progressLine),
      JSON.stringify(f1Checkpoint),
    )
    // A11: post-loop sibling sweep, bugfix mode only.
    check('H: the sibling-grep call ran (mode bugfix, patterns supplied)', calls.some((c) => c.label === 'sibling-grep'), JSON.stringify(calls.map((c) => c.label)))
    check('H: the sibling-judge call ran (a hit was found)', calls.some((c) => c.label === 'sibling-judge'), JSON.stringify(calls.map((c) => c.label)))
    const sibFinding = (result.remainingFindings || []).find((f) => f.source === 'sibling-sweep')
    check('H: a defect-classified hit becomes a remainingFindings entry sourced sibling-sweep', !!sibFinding && sibFinding.file === 'src/other.ts', JSON.stringify(result.remainingFindings))
    check(
      'H: siblingSweep reports ran/supplied/patterns/hits/findings',
      !!result.siblingSweep && result.siblingSweep.ran === true && result.siblingSweep.supplied === 1 && result.siblingSweep.patterns === 1 && result.siblingSweep.hits === 1 && result.siblingSweep.findings === 1,
      JSON.stringify(result.siblingSweep),
    )
  },
  {
    'root-cause:RC1': () => ({ reproduced: false, causeConfirmed: false, wrongValueObserved: '', note: 'could not reproduce on the current tree' }),
    'tests:RT1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/bug.test.ts', exitCode: 1, output: 'FAIL: expected 100 but got WRONG_TOTAL' }] }),
    'red-check:RT1': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    // Fix round 1, finding 5: a real, passing chain for F1 too -- unused by
    // THIS engine (a `fix` task never calls tests:/red-check:/impl: through
    // its own test-author/red-check stages, only through fixGateStage ->
    // implementStage), so these are inert here; they matter only for the
    // old-engine discrimination check documented above the scenario.
    'tests:F1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/bug.test.ts', exitCode: 1, output: 'FAIL: expected 100 but got WRONG_TOTAL' }] }),
    'red-check:F1': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    'impl:F1': () => ({ status: 'done', filesChanged: ['src/money.ts'], deviations: '', notes: '' }),
    'review:F1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'sibling-grep': () => ({ hits: [{ pattern: 'WRONG_TOTAL', file: 'src/other.ts', line: 12, excerpt: 'return WRONG_TOTAL_CALC(x, y)' }], truncated: [] }),
    'sibling-judge': () => ({ verdicts: [{ index: 0, verdict: 'defect', severity: 'major', evidence: 'the same off-by-one arithmetic is live here' }] }),
  },
)

// ---------- scenario AG (A10: repro-test's behavioral RED check) ----------
// A structurally-red test (every named test fails on an assertion) is not
// enough for a repro-test task: the failure output must literally contain
// the bug's own wrongValue. Structural pass + wrong-value-absent, even after
// one remediation attempt, still ends in a (red-gate) blocker.
scenario(
  'AG. repro-test: structurally RED but the wrong value never appears in the output -- still ends in a (red-gate) blocker after one remediation attempt',
  // A15: exercises the STANDARD-profile behavioral red-check -- pinned
  // explicitly since baseArgs()'s real default is now 'lean' for a
  // small/no-HIGH-risk fixture, which skips redCheckStage entirely (a
  // repro-test task has no implementStage of its own to fall back on, so a
  // lean-profile repro-test would otherwise do nothing at all).
  baseArgs({ profile: 'standard', tasks: [{ id: 'RT1', type: 'repro-test', files: [], tests: ['src/bug.test.ts'], brief: 'prove the bug', dependsOn: [], wrongValue: 'WRONG_TOTAL' }] }),
  ({ result, calls }) => {
    const redGate = (result.remainingFindings || []).filter((f) => f.file === '(red-gate)')
    check('AG: exactly one (red-gate) blocker -- structural pass alone is not enough for a repro-test', redGate.length === 1 && redGate[0].severity === 'blocker', JSON.stringify(redGate))
    check('AG: the blocker detail names the missing wrong value', redGate.length === 1 && /never contained the wrong value/.test(redGate[0].detail), JSON.stringify(redGate))
    const rt1 = (result.tasks || []).find((t) => t.id === 'RT1')
    check('AG: the task records behaviorallyRed:false', !!rt1 && rt1.behaviorallyRed === false, JSON.stringify(rt1))
    check('AG: the task is blocked, never reports complete', !!rt1 && rt1.blocked === true, JSON.stringify(rt1))
    const redChecks = calls.filter((c) => c.label === 'red-check:RT1' || c.label === 'red-check:RT1:r2')
    check('AG: exactly two red-check calls (initial + after remediation)', redChecks.length === 2, JSON.stringify(redChecks.map((c) => c.label)))
    const remediate = calls.filter((c) => c.label === 'tests:RT1:remediate')
    check('AG: exactly one remediation attempt', remediate.length === 1, JSON.stringify(remediate.map((c) => c.label)))
  },
  {
    // Structurally red both times (every named test fails on an assertion),
    // but the output never mentions the bug's own wrong value.
    'tests:RT1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/bug.test.ts', exitCode: 1, output: 'FAIL: expected 100 but received 42' }] }),
    'red-check:RT1': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    'tests:RT1:remediate': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/bug.test.ts', exitCode: 1, output: 'FAIL: expected 100 but still received 42' }] }),
    'red-check:RT1:r2': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
  },
)

// ---------- scenario AH / AI (A10: docs task, with and without `check`) ----------
scenario(
  'AH. docs task WITH a check command: implementer -> review chain, no tests, the check command reaches the implementer prompt',
  baseArgs({ tasks: [{ id: 'D1', type: 'docs', files: ['docs/readme.md'], tests: [], brief: 'document the new flag', dependsOn: [], check: 'npm run lint:docs' }] }),
  ({ result, calls }) => {
    const implCall = calls.find((c) => c.label === 'impl:D1')
    check('AH: the docs implementer prompt carries the check command', !!implCall && implCall.prompt.includes('npm run lint:docs'), JSON.stringify(implCall && implCall.prompt))
    check('AH: no tests:D1 or red-check:D1 call -- docs tasks author no tests', !calls.some((c) => c.label === 'tests:D1' || c.label === 'red-check:D1'), JSON.stringify(calls.map((c) => c.label)))
    const reviewCall = calls.find((c) => c.label === 'review:D1')
    check('AH: the docs task still gets an adversarial review', !!reviewCall, JSON.stringify(calls.map((c) => c.label)))
    const d1 = (result.tasks || []).find((t) => t.id === 'D1')
    check('AH: the docs task completes clean', !!d1 && d1.status === 'complete' && d1.clean === true, JSON.stringify(d1))
  },
  { 'impl:D1': () => ({ status: 'done', filesChanged: ['docs/readme.md'], deviations: '', notes: 'ran npm run lint:docs, clean' }), 'review:D1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }) },
)
scenario(
  'AI. docs task WITHOUT a check command: no check-command line appears in the implementer prompt',
  baseArgs({ tasks: [{ id: 'D1', type: 'docs', files: ['docs/readme.md'], tests: [], brief: 'document the new flag', dependsOn: [] }] }),
  ({ calls }) => {
    const implCall = calls.find((c) => c.label === 'impl:D1')
    check('AI: no check-command instruction when t.check is absent', !!implCall && !/run this exact check command/i.test(implCall.prompt), JSON.stringify(implCall && implCall.prompt))
    check('AI: the docs implementer prompt still says there are no tests', !!implCall && /no tests/i.test(implCall.prompt), JSON.stringify(implCall && implCall.prompt))
  },
  { 'impl:D1': () => ({ status: 'done', filesChanged: ['docs/readme.md'], deviations: '', notes: '' }), 'review:D1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }) },
)

// ---------- scenario AJ (A10: fix consumes its dependency's tests) ----------
scenario(
  'AJ. a fix task consumes its repro-test dependency\'s tests rather than authoring its own',
  baseArgs({
    tasks: [
      { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'find the cause', dependsOn: [] },
      { id: 'RT1', type: 'repro-test', files: [], tests: ['src/bug.test.ts'], brief: 'prove the bug', dependsOn: [], wrongValue: 'WRONG_TOTAL' },
      { id: 'F1', type: 'fix', files: ['src/money.ts'], tests: [], brief: 'fix the money bug', dependsOn: ['RC1', 'RT1'] },
    ],
    buildPlanPath: PLAN_PATH,
  }),
  ({ calls }) => {
    check('AJ: no tests:F1 or red-check:F1 call -- a fix authors no tests of its own', !calls.some((c) => c.label === 'tests:F1' || c.label === 'red-check:F1'), JSON.stringify(calls.map((c) => c.label)))
    const implCall = calls.find((c) => c.label === 'impl:F1')
    check('AJ: the fix implementer prompt lists its repro-test dependency\'s test file', !!implCall && implCall.prompt.includes('src/bug.test.ts'), JSON.stringify(implCall && implCall.prompt))
    check('AJ: the fix implementer prompt says those tests are not its own', !!implCall && /not to you/.test(implCall.prompt), JSON.stringify(implCall && implCall.prompt))
  },
  {
    'root-cause:RC1': () => ({ reproduced: true, causeConfirmed: true, wrongValueObserved: 'WRONG_TOTAL', note: 'confirmed' }),
    'tests:RT1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/bug.test.ts', exitCode: 1, output: 'FAIL: expected 100 but got WRONG_TOTAL' }] }),
    'red-check:RT1': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    'impl:F1': () => ({ status: 'done', filesChanged: ['src/money.ts'], deviations: '', notes: '' }),
    'review:F1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
  },
)

// ==================== TASK 11 (A10b): ui-verify task type ====================

// ---------- scenario O ----------
// Type dispatch inside runTask: a driver stage owns/stops the app process
// and reports facts; the task's OWN reviewStage judges that evidence. ANY
// blocked flow is itself a blocker (not merely a finding) -- exactly one
// ui-drive call, one judge call (the task's review), and a blocker for the
// undriven flow. Fix round 1, finding 2: also proves the task's OWN fix
// round feeds into the SAME cross-task "watched files changed, re-verify"
// trigger -- U1's round-1 fix (fixLoopStage, generic to every task type)
// touches src/ui/Widget.tsx, one of U1's own `files`, so a real browser
// re-drive/re-judge must happen even though it was U1's OWN fix round, not
// another task's. The re-review's diff-reading ADDRESSED claim ("mobile
// submit button now renders") is deliberately wrong here -- the fresh
// browser evidence still shows the flow blocked -- to prove the mechanism
// does not just accept that claim: a real (ui-verify) finding is recorded
// from the re-drive/re-judge, sourced 'ui-reverify'.
scenario(
  'O. ui-verify: exactly one ui-drive call, one judge call, and a blocked flow produces a blocker (not just a finding)',
  baseArgs({
    tasks: [
      {
        id: 'U1',
        type: 'ui-verify',
        files: ['src/ui/Widget.tsx'],
        tests: [],
        brief: 'verify the widget UI',
        dependsOn: [],
        url: 'http://localhost:3001',
        startCommand: 'npm run dev',
        flows: ['load the widget', 'submit the form'],
        viewports: ['desktop', 'mobile'],
      },
    ],
    buildPlanPath: PLAN_PATH,
  }),
  ({ result, calls }) => {
    const driveCalls = calls.filter((c) => c.label === 'ui-drive:U1')
    check('O: exactly one ui-drive call', driveCalls.length === 1, JSON.stringify(driveCalls.map((c) => c.label)))
    const judgeCalls = calls.filter((c) => c.label === 'review:U1')
    check('O: exactly one judge call (the task\'s own reviewStage)', judgeCalls.length === 1, JSON.stringify(judgeCalls.map((c) => c.label)))
    const u1 = (result.tasks || []).find((t) => t.id === 'U1')
    check(
      'O: the blocked flow becomes a critical blocker finding, not merely whatever the judge chose to raise',
      !!u1 && !!u1.review && u1.review.findings.some((f) => f.severity === 'critical' && f.file === '(ui-verify)' && /blocked/i.test(f.summary)),
      JSON.stringify(u1 && u1.review),
    )
    check('O: assessment is needs-fixes because of the blocked flow (the judge itself said approved)', !!u1 && u1.review.assessment === 'needs-fixes', JSON.stringify(u1 && u1.review))
    check('O: the run-level uiVerify field is populated, not left null', !!result.uiVerify && result.uiVerify.ran === true && !!result.uiVerify.evidence, JSON.stringify(result.uiVerify))
    // Fix round 1, finding 2: U1's OWN round-1 fix touched src/ui/Widget.tsx
    // (one of U1's own `files`) -- that must ALSO trigger a real browser
    // re-drive/re-judge through the same mechanism the cross-task case uses
    // (a same-task fix round is not a special, second-class case).
    check('O: reVerify reflects the same-task fix round triggering a real re-drive, not 0 as before this fix', !!result.uiVerify && result.uiVerify.reVerify === 1, JSON.stringify(result.uiVerify))
    check('O: a NEW ui-redrive call happens after U1\'s OWN fix round (not zero, as before this fix)', calls.filter((c) => c.label === 'ui-redrive:U1').length === 1, JSON.stringify(calls.map((c) => c.label)))
    check('O: a NEW ui-rejudge call happens too', calls.filter((c) => c.label === 'ui-rejudge:U1').length === 1, JSON.stringify(calls.map((c) => c.label)))
    // The diff-reading re-review ('re-review:U1:r1') claimed ADDRESSED, but
    // the fresh browser evidence below still shows the flow blocked -- the
    // real re-drive/re-judge catches this, proving the mechanism does not
    // just accept a fabricated diff-reading claim on its own.
    const reverifyFinding = (result.remainingFindings || []).find((f) => f.source === 'ui-reverify')
    // Fix round 2, finding 2 (cause a): this finding must be routed through
    // mapReviewSeverity like every other findings-merge site in the file --
    // the mock ui-rejudge response below reports raw severity 'critical',
    // which maps to 'blocker' (never left as the raw 'critical' string
    // result.clean's strict severity==='blocker' check cannot see).
    check(
      'O: the browser re-drive catches that the diff-only ADDRESSED claim was wrong -- a fresh (ui-verify) finding is recorded, MAPPED to blocker (not left as raw \'critical\', invisible to result.clean)',
      !!reverifyFinding && reverifyFinding.severity === 'blocker' && reverifyFinding.file === '(ui-verify)',
      JSON.stringify(result.remainingFindings),
    )
    // Fix round 2, finding 2 (cause a+b): this is the actual reviewer-caught
    // regression this whole fix round exists for -- a genuine browser
    // re-verify disagreement must flip result.clean to false AND the task's
    // OWN status/clean fields, not just quietly add an entry to
    // remainingFindings that the strict severity check (pre-fix) or the
    // per-task status (still pre-fix, even after cause a alone) never read.
    check('O: result.clean is false because of the ui-reverify disagreement', result.clean === false, JSON.stringify({ clean: result.clean, remainingFindings: result.remainingFindings }))
    check(
      'O: U1\'s OWN status/clean fields reflect the ui-reverify disagreement -- status is open (never complete) and clean is false',
      !!u1 && u1.status === 'open' && u1.clean === false,
      JSON.stringify({ status: u1 && u1.status, clean: u1 && u1.clean }),
    )
    // A fresh checkpoint/progress-ledger entry for this disagreement exists
    // (append-only, same fireCheckpoint pattern as the sibling sweep) -- the
    // ORIGINAL per-task checkpoint (fired in runTask, before this post-loop
    // pass ever runs) is necessarily stale ("review clean") and is never
    // retroactively rewritten; a NEW entry is what actually carries the
    // corrected line.
    const reverifyCheckpoint = (result.checkpoints || []).find((c) => c.alias === 'checkpoint:U1:ui-reverify')
    check(
      'O: a fresh checkpoint records the corrected, not-clean progress line for U1\'s ui-reverify disagreement',
      !!reverifyCheckpoint && /not clean/.test(reverifyCheckpoint.payload.progressLine),
      JSON.stringify(reverifyCheckpoint),
    )
  },
  {
    'ui-drive:U1': () => ({
      completed: false,
      specPath: 'e2e/widget.spec.ts',
      flows: [
        { flow: 'load the widget', viewport: 'desktop', status: 'passed', screenshot: 'artifacts/1.png', assertions: [{ text: 'widget visible', passed: true }], consoleErrors: [], networkFailures: [], a11y: [], notes: '' },
        { flow: 'submit the form', viewport: 'mobile', status: 'blocked', screenshot: '', assertions: [], consoleErrors: [], networkFailures: [], a11y: [], notes: 'could not find the submit button at mobile viewport' },
      ],
      processesStopped: true,
    }),
    'review:U1': () => ({ specCompliance: 'partial', findings: [], assessment: 'approved' }),
    'fix:U1:r1': () => ({ status: 'done', filesChanged: ['src/ui/Widget.tsx'], deviations: '', notes: 'added the mobile submit button' }),
    're-review:U1:r1': () => ({ perFinding: [{ key: '#0', status: 'ADDRESSED', evidence: 'src/ui/Widget.tsx: mobile submit button now renders' }], newFindings: [] }),
    // The real, independent browser evidence -- disagrees with the diff
    // read above on purpose (finding 2's whole point: a diff read cannot
    // actually confirm runtime UI behavior).
    'ui-redrive:U1': () => ({
      completed: false,
      specPath: 'e2e/widget.spec.ts',
      flows: [
        { flow: 'load the widget', viewport: 'desktop', status: 'passed', screenshot: 'artifacts/2.png', assertions: [{ text: 'widget visible', passed: true }], consoleErrors: [], networkFailures: [], a11y: [], notes: '' },
        { flow: 'submit the form', viewport: 'mobile', status: 'blocked', screenshot: '', assertions: [], consoleErrors: [], networkFailures: [], a11y: [], notes: 'submit button still not reachable at mobile viewport after the claimed fix' },
      ],
      processesStopped: true,
    }),
    'ui-rejudge:U1': () => ({
      specCompliance: 'partial',
      findings: [
        {
          severity: 'critical',
          file: '(ui-verify)',
          line: 0,
          summary: 'Flow "submit the form" at viewport "mobile" is STILL blocked after the fix round claimed ADDRESSED.',
          scenario: 'submit button still not reachable at mobile viewport after the claimed fix',
        },
      ],
      assessment: 'needs-fixes',
    }),
  },
)

// ==================== A12/A10 Final-pass/mutation-probe test-coverage completeness ====================
// These 3 scenarios (AK, AL, AM) close a pure test-coverage gap -- the
// underlying engine mechanisms already work (manually probed and confirmed
// during review); no pipeline.js change accompanies them.

// ---------- scenario AK (A12: a failing Final pass gate) ----------
scenario(
  'AK. a failing final-gate produces a (final-gate) blocker and flips finalPass.completed/result.clean to false',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ result }) => {
    const fgFindings = (result.remainingFindings || []).filter((f) => f.file === '(final-gate)')
    check('AK: exactly one (final-gate) blocker when the full verify-commands suite fails at Final pass', fgFindings.length === 1 && fgFindings[0].severity === 'blocker', JSON.stringify(fgFindings))
    check('AK: finalPass.completed is false', !!result.finalPass && result.finalPass.completed === false, JSON.stringify(result.finalPass))
    check('AK: the run is not clean', result.clean === false, JSON.stringify(result.remainingFindings))
  },
  {
    ...PASSING_CHAIN,
    'review:T1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'final-gate': () => ({ pass: false, cwd: 'C:/repo', results: [{ command: 'npm test', pass: false, executed: 3, summary: '2 tests failed: expected 100 but got 90' }] }),
  },
)

// ---------- scenario AL (A10: mutation-probe checksum mismatch) ----------
scenario(
  'AL. a checksum:after digest that mismatches Baseline\'s recorded digest for a probed file produces a (mutation) blocker and flips mutationProbe.restoredVerified/result.clean to false',
  baseArgs({
    tasks: [
      { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'find the cause', dependsOn: [] },
      { id: 'RT1', type: 'repro-test', files: [], tests: ['src/bug.test.ts'], brief: 'prove the bug', dependsOn: [], wrongValue: 'WRONG_TOTAL' },
      { id: 'F1', type: 'fix', files: ['src/money.ts'], tests: [], brief: 'fix the money bug', dependsOn: ['RC1', 'RT1'] },
      { id: 'RP1', type: 'revert-probe', files: [], tests: [], brief: 'probe money.ts', dependsOn: ['F1'], file: 'src/money.ts', test: 'src/bug.test.ts' },
    ],
    buildPlanPath: PLAN_PATH,
  }),
  ({ result }) => {
    const mutFindings = (result.remainingFindings || []).filter((f) => f.file === '(mutation)')
    check('AL: exactly one (mutation) blocker when the after-digest mismatches Baseline\'s recorded digest', mutFindings.length === 1 && mutFindings[0].severity === 'blocker', JSON.stringify(mutFindings))
    check('AL: mutationProbe.restoredVerified is false', !!result.mutationProbe && result.mutationProbe.restoredVerified === false, JSON.stringify(result.mutationProbe))
    check('AL: the run is not clean', result.clean === false, JSON.stringify(result.remainingFindings))
  },
  {
    'root-cause:RC1': () => ({ reproduced: true, causeConfirmed: true, wrongValueObserved: 'WRONG_TOTAL', note: 'confirmed' }),
    'tests:RT1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/bug.test.ts', exitCode: 1, output: 'FAIL: expected 100 but got WRONG_TOTAL' }] }),
    'red-check:RT1': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    'impl:F1': () => ({ status: 'done', filesChanged: ['src/money.ts'], deviations: '', notes: '' }),
    'review:F1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'probe:RP1': () => ({ caught: true, restored: true, evidence: 'fails as expected once reverted', backupPath: '/tmp/revertprobe-RP1', fallback: '' }),
    // The probe agent self-reports restored:true, but the independent
    // checksum:after digest -- compared IN SCRIPT against Baseline's own
    // recorded digest for this file -- disagrees. That in-script comparison,
    // never the probe's self-report, is what must decide restoredVerified.
    'checksum:after': () => ({ files: [{ file: 'src/money.ts', digest: 'MISMATCHED-DIGEST' }] }),
    'baseline-manifest': () => ({
      files: [
        { path: 'src/money.ts', status: 'modified', exists: true, digest: 'sameA', risk: 'LOW', changedLines: 4 },
        { path: 'src/bug.test.ts', status: 'modified', exists: true, digest: 'x', risk: 'LOW', changedLines: 2 },
      ],
      validCommands: [],
      artifacts: [],
      planBytes: { build: 0, test: 0 },
    }),
  },
)

// ---------- scenario AM (A12: final-read findings genuinely merged) ----------
scenario(
  'AM. final-read (the conditional Fable read) producing non-empty findings are genuinely merged into the run\'s findings/remainingFindings',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/money.ts'], tests: ['src/money.test.ts'], brief: 'add money math', dependsOn: [], risk: 'HIGH' }], buildPlanPath: PLAN_PATH }),
  ({ result, calls }) => {
    const finalReadCalls = calls.filter((c) => c.label === 'final-read')
    check('AM: exactly one final-read call, on Fable, for this HIGH-risk run', finalReadCalls.length === 1 && finalReadCalls[0].model === 'claude-fable-5-1', JSON.stringify(finalReadCalls))
    const merged = (result.remainingFindings || []).find((f) => f.file === 'src/money.ts' && f.summary === 'off-by-one cent rounding the final-read caught')
    check('AM: the final-read finding is genuinely merged into remainingFindings, not discarded', !!merged && merged.phase === 'Final pass', JSON.stringify(result.remainingFindings))
    check('AM: the run is not clean because of the merged blocker finding', result.clean === false, JSON.stringify(result.remainingFindings))
  },
  {
    ...passingChainFor('T1', { filesChanged: ['src/money.ts'] }),
    'review:T1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'final-read': () => ({
      findings: [{ severity: 'blocker', file: 'src/money.ts', summary: 'off-by-one cent rounding the final-read caught', detail: 'roundMoney applied before proration, not after' }],
    }),
  },
)

// ---------- scenario AQ (A14 hardening: budget.spent() stuck-reading note) ----------
// ENGINE-NOTES.md (2026-09-10) measured that the engine's own budget.spent()
// silently read 0 on 26% of phases in production -- it stays the best
// available telemetry source (no per-call usage data exists anywhere else to
// sum instead) and the field is honestly named tokens/estUsd, never claimed
// as ground truth, with pipeline-ledger.mjs layering real --usage-based
// trueCostUsd on top. A NULL reading was already flagged in phaseReport's
// note; a STUCK reading -- budget.spent() reports the identical number at
// both ends of an anchor-phase bracket despite real agent calls happening
// inside it -- used to look indistinguishable from "this phase legitimately
// spent nothing": tokens:0 with an empty note. Uses the dry-run harness's
// stuckBudgetPhase support (`run()`, above) to freeze the mock's reading
// across the Implement bracket and confirm the phase's own note now flags it
// instead.
scenario(
  "AQ. budget.spent() stuck at the SAME reading across an anchor-phase boundary is flagged in that phase's note, never silently reported as a bare tokens:0",
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ result }) => {
    const implementRow = (result.phaseReport || []).find((p) => p.phase === 'Implement')
    check('AQ: the Implement phase still reports real agent calls (agents > 0) despite the stuck reading', !!implementRow && implementRow.agents > 0, JSON.stringify(implementRow))
    check(
      'AQ: a stuck reading now reports tokens:null, estUsd:null, estUnknown:true -- unknown is never 0 (budget.spent() itself never failed, it just never moved)',
      !!implementRow && implementRow.tokens === null && implementRow.estUsd === null && implementRow.estUnknown === true,
      JSON.stringify(implementRow),
    )
    check(
      "AQ: the phase's note flags the stuck reading instead of silently passing tokens:0 off as \"this phase was free\"",
      !!implementRow && /stuck/i.test(implementRow.note || ''),
      JSON.stringify(implementRow),
    )
    check(
      "AQ: result.estUnknownPhases lists 'Implement' -- the anchor whose reading is stuck, so a reader can tell estimatedCostUsd's sum excludes it rather than silently treating the unknown as 0",
      Array.isArray(result.estUnknownPhases) && result.estUnknownPhases.includes('Implement'),
      JSON.stringify(result.estUnknownPhases),
    )
  },
  undefined,
  { stuckBudgetPhase: 'Implement' },
)

// ---------- scenario AR (Fix 1: real smoke-run finding) ----------
// A real Workflow launch against a throwaway scratch repo (workdir != the
// skill directory -- the normal case for any real multi-repo run) found all
// 4 helper-script invocations (task-brief.mjs, review-pack.mjs x2,
// fix-brief.mjs) were bare relative paths ('node scripts/x.mjs') that only
// resolve when the invoking agent's cwd happens to be dev-pipeline's own
// directory -- never true in practice, since every agent is told (via
// REPO_NOTE) to cd into `workdir`, the TARGET repo, first. Reuses scenario
// W's exact "a finding survives rounds 1 and 2, reaches round 3" fixture so
// brief:T1 (briefStage), pack:T1 (packStage's own review-pack.mjs call),
// pack:T1:r1 (rereviewStage's re-review pack call), and fix-brief:T1:r3 (the
// round-3 fix-brief.mjs dispatch) all fire in one run -- proving every one
// of the 4 call sites now builds its command from the launcher-supplied
// args.scriptsDir instead of the broken relative form. Confirmed RED against
// the pre-fix pipeline.js (which never read args.scriptsDir at all, so every
// one of these checks failed) before landing the fix in the same commit.
scenario(
  'AR. all 4 helper-script invocations build their command from args.scriptsDir, never the old bare relative path (Fix 1)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH }),
  ({ calls }) => {
    const briefCall = calls.find((c) => c.label === 'brief:T1')
    check('AR: task-brief.mjs call uses the scriptsDir-prefixed absolute path', !!briefCall && briefCall.prompt.includes('node "' + SCRIPTS_DIR + '/task-brief.mjs"'), JSON.stringify(briefCall && briefCall.prompt))
    const packCall = calls.find((c) => c.label === 'pack:T1')
    check('AR: review-pack.mjs (packStage) call uses the scriptsDir-prefixed absolute path', !!packCall && packCall.prompt.includes('node "' + SCRIPTS_DIR + '/review-pack.mjs"'), JSON.stringify(packCall && packCall.prompt))
    const rereviewPackCall = calls.find((c) => c.label === 'pack:T1:r1')
    check('AR: review-pack.mjs (rereviewStage) call uses the scriptsDir-prefixed absolute path', !!rereviewPackCall && rereviewPackCall.prompt.includes('node "' + SCRIPTS_DIR + '/review-pack.mjs"'), JSON.stringify(rereviewPackCall && rereviewPackCall.prompt))
    const fixBriefCall = calls.find((c) => c.label === 'fix-brief:T1:r3')
    check('AR: fix-brief.mjs call uses the scriptsDir-prefixed absolute path', !!fixBriefCall && fixBriefCall.prompt.includes('node "' + SCRIPTS_DIR + '/fix-brief.mjs"'), JSON.stringify(fixBriefCall && fixBriefCall.prompt))
    check(
      'AR: none of the 4 calls fall back to the old bare relative form',
      [briefCall, packCall, rereviewPackCall, fixBriefCall].every((c) => !c || !/node scripts\//.test(c.prompt)),
      JSON.stringify([briefCall, packCall, rereviewPackCall, fixBriefCall].map((c) => c && c.prompt)),
    )
  },
  {
    ...passingChainFor('T1'),
    'review:T1': () => ({ specCompliance: 'fail', findings: [{ severity: 'critical', file: 'src/a.ts', line: 1, summary: 'x', scenario: 'y' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix:T1:r2': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r2': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix-plan:T1:r3': () => ({ decisions: [{ key: '#0', action: 'fix', design: 'd', invariant: 'i', tests: 't', reason: 'r' }], note: 'n' }),
    'fix:T1:r3': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r3': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
  },
)

// ---------- scenario AS (Fix 2: briefStage exitCode gate) ----------
// The real smoke run's task-brief.mjs call failed (Fix 1's bug) but
// SCRIPT_RESULT_SCHEMA had no exitCode field, so the failure was silently
// swallowed: the agent returned a fabricated placeholder
// ("task-brief-script-missing", bytes:0) that briefStage accepted blindly as
// a real path, degrading silently instead of blocking. Proves briefStage now
// treats a nonzero exitCode exactly like packStage already treats a failed
// review-pack.mjs run: a (brief) blocker, never a fabricated briefPath.
// Confirmed RED against the pre-fix code (which accepted brief.out
// unconditionally, with no exitCode check at all -- t1.blocked stayed
// undefined and briefPath became the fabricated placeholder) before landing
// the fix in the same commit.
scenario(
  'AS. a nonzero-exit (or dead) task-brief.mjs response is a (brief) blocker, never a silent fallback path (Fix 2)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('AS: task T1 is blocked', !!t1 && t1.blocked === true, JSON.stringify(t1))
    const blocker = t1 && (t1.blockerFindings || []).find((f) => f.file === '(brief)')
    check('AS: a (brief) blocker finding is recorded with severity blocker', !!blocker && blocker.severity === 'blocker', JSON.stringify(t1 && t1.blockerFindings))
    check("AS: the blocker detail cites the script's real exitCode, never silently accepted", !!blocker && blocker.detail.includes('exitCode=1'), JSON.stringify(blocker))
    check('AS: the task never got a fabricated briefPath from the failed script', !t1 || t1.briefPath === undefined, JSON.stringify(t1 && t1.briefPath))
    check('AS: the run itself is not clean because of this blocker', result.clean === false, JSON.stringify({ clean: result.clean }))
    const runBlocker = (result.remainingFindings || []).find((f) => f.file === '(brief)' && f.severity === 'blocker')
    check('AS: the (brief) blocker is merged into the run\'s own remainingFindings, never dropped', !!runBlocker, JSON.stringify(result.remainingFindings))
    check('AS: implementStage never runs for the blocked task (no impl:T1 call)', !calls.some((c) => c.label === 'impl:T1'), JSON.stringify(calls.map((c) => c.label)))
    check('AS: packStage never runs for the blocked task (no pack:T1 call)', !calls.some((c) => c.label === 'pack:T1'), JSON.stringify(calls.map((c) => c.label)))
  },
  {
    'brief:T1': () => ({ out: 'task-brief-script-missing', bytes: 0, truncated: false, sections: [], exitCode: 1 }),
  },
)

// ---------- scenario AT (Fix 2: fix-brief exitCode gate) ----------
// fix-brief.mjs (round 3+ of the fix loop) shares task-brief.mjs's exact
// SCRIPT_RESULT_SCHEMA and cwd-dependent invocation risk. Unlike briefStage's
// hard gate, a failed fix-brief degrades to the design step's EXISTING
// conservative "brief agent produced nothing -- decide from the findings
// alone" fallback (fixDesignPrompt already had this branch, for a dead
// agent) rather than blocking the whole task -- but the failure must still
// be surfaced, never silently absorbed: a (brief) MAJOR finding, folded into
// the run's findings via the identical packGaps channel rereviewStage's own
// failed-pack gap already uses. Proves both halves: the gap is recorded with
// the real exitCode, AND the design prompt never cites the failed script's
// fabricated out path as if it were a real code brief. Confirmed RED against
// the pre-fix code (which had no exitCode field on SCRIPT_RESULT_SCHEMA at
// all, so briefRes.out -- the fabricated placeholder -- was accepted as a
// real code brief and cited verbatim in the design prompt) before landing
// the fix in the same commit.
scenario(
  'AT. a nonzero-exit fix-brief.mjs response degrades to the existing no-brief fallback and is surfaced as a (brief) gap finding, never cited as a real code brief (Fix 2)',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('AT: the task still completes clean despite the failed fix-brief (non-fatal, per the established pack-gap pattern)', !!t1 && t1.status === 'complete' && t1.clean === true, JSON.stringify(t1))
    const gap = (result.remainingFindings || []).find((f) => f.file === '(brief)' && f.phase === 'Fix')
    check('AT: the failed fix-brief is surfaced as a (brief) major finding, never silently absorbed', !!gap && gap.severity === 'major', JSON.stringify(result.remainingFindings))
    check('AT: the gap detail cites the real exitCode, not a fabricated path treated as valid', !!gap && gap.detail.includes('exitCode=1'), JSON.stringify(gap))
    const designCall = calls.find((c) => c.label === 'fix-plan:T1:r3')
    check(
      'AT: the design step falls back to the existing "brief agent produced nothing" path -- never cites the failed script\'s fabricated out path as a real code brief',
      !!designCall && designCall.prompt.includes('the brief agent produced nothing') && !designCall.prompt.includes('fix-brief-script-missing'),
      JSON.stringify(designCall && designCall.prompt),
    )
  },
  {
    ...passingChainFor('T1'),
    'review:T1': () => ({ specCompliance: 'fail', findings: [{ severity: 'critical', file: 'src/a.ts', line: 1, summary: 'x', scenario: 'y' }], assessment: 'needs-fixes' }),
    'fix:T1:r1': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r1': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix:T1:r2': () => ({ status: 'partial', filesChanged: [], deviations: '', notes: '' }),
    're-review:T1:r2': () => ({ perFinding: [{ key: '#0', status: 'NOT ADDRESSED', evidence: 'x' }], newFindings: [] }),
    'fix-brief:T1:r3': () => ({ out: 'fix-brief-script-missing', bytes: 0, truncated: false, sections: [], exitCode: 1 }),
    'fix-plan:T1:r3': () => ({ decisions: [{ key: '#0', action: 'fix', design: 'd', invariant: 'i', tests: 't', reason: 'r' }], note: 'n' }),
    'fix:T1:r3': () => ({ status: 'done', filesChanged: ['src/a.ts'], deviations: '', notes: '' }),
    're-review:T1:r3': () => ({ perFinding: [{ key: '#0', status: 'ADDRESSED', evidence: 'src/a.ts:1' }], newFindings: [] }),
  },
)

// ---------- scenario AU (E task loop hardening: enforceTestAuthorScope) ----------
// The test author's own scope guard: if its reported `git status` (the
// SCOPE_CHECK_SCHEMA call) shows it touched a path that belongs to this
// task's OWN `files` (implementation, not tests), that is a scope violation
// -- the guard reverts the path and the task is blocked with a (scope)
// finding, never silently accepted as if the author had written only tests.
scenario(
  'AU. enforceTestAuthorScope blocks a task whose test author touched one of its OWN `files` paths, and the run surfaces the (scope) blocker',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH, profile: 'standard' }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('AU: task T1 is blocked', !!t1 && t1.blocked === true, JSON.stringify(t1))
    const blocker = t1 && (t1.blockerFindings || []).find((f) => f.file === '(scope)')
    check('AU: a (scope) blocker finding is recorded with severity blocker', !!blocker && blocker.severity === 'blocker', JSON.stringify(t1 && t1.blockerFindings))
    check('AU: the blocker detail names the violating path and that it was reverted', !!blocker && blocker.detail.includes('src/a.ts') && blocker.detail.includes('Reverted'), JSON.stringify(blocker))
    check('AU: implementStage never runs for the blocked task (no impl:T1 call)', !calls.some((c) => c.label === 'impl:T1'), JSON.stringify(calls.map((c) => c.label)))
    check('AU: the run itself is not clean because of this blocker', result.clean === false, JSON.stringify({ clean: result.clean }))
    const runBlocker = (result.remainingFindings || []).find((f) => f.file === '(scope)' && f.severity === 'blocker')
    check('AU: the (scope) blocker is merged into the run\'s own remainingFindings, never dropped', !!runBlocker, JSON.stringify(result.remainingFindings))
    // Engine fix: redCheckStage now has the same `if (t.blocked) return t`
    // early-return guard every later stage already had -- a task the scope
    // guard already blocked must never reach a real red-check call, and its
    // blockerFindings must never be overwritten by an unrelated (red-gate)
    // finding from a remediation failure.
    check('AU: redCheckStage short-circuits on the already-blocked task -- the red-check agent is never called for it', !calls.some((c) => c.label === 'red-check:T1' || c.label === 'red-check:T1:r2'), JSON.stringify(calls.map((c) => c.label)))
    check('AU: blockerFindings still contains only the scope-guard finding, never joined or overwritten by a (red-gate) finding', !!t1 && Array.isArray(t1.blockerFindings) && t1.blockerFindings.length === 1 && t1.blockerFindings[0].file === '(scope)', JSON.stringify(t1 && t1.blockerFindings))
  },
  {
    'tests:T1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/a.test.ts', exitCode: 1, output: 'FAIL: assertion failed as expected' }] }),
    'tests:T1:scope': () => ({ ran: true, files: [{ path: 'src/a.ts', tracked: true }] }),
    'tests:T1:scope-revert': () => ({ exitCode: 0, reverted: ['src/a.ts'] }),
  },
)

// ---------- scenario AV (E4: introducesObservable structural-RED acceptance) ----------
// A task that declares introducesObservable (its tests assert on a CLI
// line/log message that does not exist yet) can never get a "properly"
// structurallyRed audit -- the pre-implementation failure is "feature
// absent" (error/import-undefined), not an assertion failure. redCheckStage
// must accept that as RED on the FIRST attempt (no wasted remediation round)
// rather than routing it into the remediation-then-block path meant for a
// test that is failing for the WRONG reason.
scenario(
  'AV. an introducesObservable task is accepted as structurally RED on the first attempt, with no remediation round',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/cli.ts'], tests: ['src/cli.test.ts'], brief: 'add --banner flag', dependsOn: [], introducesObservable: true }], buildPlanPath: PLAN_PATH, profile: 'standard' }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('AV: the task is never blocked -- structural RED is accepted, not routed to the red-gate blocker', !!t1 && t1.blocked !== true, JSON.stringify(t1))
    check('AV: t1.structuralRedAccepted is true', !!t1 && t1.structuralRedAccepted === true, JSON.stringify(t1))
    check('AV: t1.redAudit reflects the acceptance (accepted:true)', !!t1 && t1.redAudit && t1.redAudit.accepted === true, JSON.stringify(t1 && t1.redAudit))
    check('AV: no remediation round ran (exactly one red-check:T1 call, no :remediate or :r2 calls)', calls.filter((c) => c.label === 'red-check:T1').length === 1 && !calls.some((c) => /remediate|red-check:T1:r2/.test(c.label)), JSON.stringify(calls.map((c) => c.label)))
    check('AV: the task still completes clean afterward', !!t1 && t1.status === 'complete' && t1.clean === true, JSON.stringify(t1))
  },
  {
    ...passingChainFor('T1'),
    'tests:T1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/cli.test.ts', exitCode: 1, output: 'ReferenceError: showBanner is not defined' }] }),
    'red-check:T1': () => ({ structurallyRed: false, tests: [{ test: 'src/cli.test.ts', outcome: 'error', note: 'symbol does not exist yet' }], blockers: [], remediation: '' }),
    'review:T1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
  },
)

// ---------- scenario AW (E5: validateTasks files/tests overlap rejection) ----------
// A path listed in BOTH a task's OWN `files` and its OWN `tests` is a plan
// contradiction (enforceTestAuthorScope would revert the author's edit to
// that path the moment it is written, since it also names it as a `files`
// path it does not own as a test) -- validateTasks must reject this before
// any agent() call, the same as the cross-task shared-file rule scenario N
// already covers (this is the SAME-task case, E5).
scenario(
  "AW. validateTasks blocks a task that lists the SAME path in both `files` and `tests` (E5)",
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/shared.ts'], tests: ['src/shared.ts'], brief: 'spec is the fix', dependsOn: [] }] }),
  ({ result, calls }) => {
    check('AW: the run aborts as an invalid plan', result.aborted === 'invalid-plan', JSON.stringify(result.aborted))
    const blocker = (result.remainingFindings || []).find((f) => f.file === '(build-plan)' && /BOTH files and tests/.test(f.summary))
    check('AW: a (build-plan) blocker cites the path appearing in BOTH files and tests', !!blocker, JSON.stringify(result.remainingFindings))
    check('AW: result.clean === false', result.clean === false, JSON.stringify({ clean: result.clean }))
    check('AW: zero agent calls -- validateTasks runs before any agent()', calls.length === 0, JSON.stringify(calls.map((c) => c.label)))
  },
)

// ---------- scenario AX (E7: main-checkout workdir guard trips) ----------
// Real launch 2026-09-15 (Lite lane): two implementer agents edited the MAIN
// checkout while their workdir was a separate worktree, and nothing caught
// it. args.workdir names a worktree distinct from the main checkout (whose
// root withWorkdirGuard derives via 'workdir-guard:main-dir', memoized once
// for the whole run); T1's guard-before/guard-after fingerprints of that
// main checkout disagree (same HEAD sha, but a NEW modified path in
// status) -- a drift while workdir != main -- so T1 is blocked with a
// (workdir) / 'Workdir guard' finding naming the changed path, and pack/
// review never run for it. T2 is an independent task (no dependsOn edge to
// T1) whose OWN fingerprint never moves, proving the guard is scoped per
// task and does not collaterally block a sibling in the same wave.
scenario(
  'AX. the main-checkout guard blocks a task whose agent modified the MAIN checkout while workdir is a separate worktree, leaving an unrelated sibling task unaffected',
  baseArgs({
    tasks: [
      { id: 'T1', type: 'feature', files: ['apps/api/src/foo.ts'], tests: ['apps/api/src/foo.test.ts'], brief: 'add foo', dependsOn: [] },
      { id: 'T2', type: 'feature', files: ['src/b.ts'], tests: ['src/b.test.ts'], brief: 'add beta', dependsOn: [] },
    ],
    workdir: 'C:/ClaudeCode/routeflow/.claude/worktrees/rf-lite-L1',
  }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    const t2 = (result.tasks || []).find((t) => t.id === 'T2')
    check('AX: task T1 is blocked', !!t1 && t1.blocked === true, JSON.stringify(t1))
    const blocker = t1 && (t1.blockerFindings || []).find((f) => f.file === '(workdir)')
    check('AX: a (workdir) blocker finding is recorded with phase "Workdir guard" and severity blocker', !!blocker && blocker.phase === 'Workdir guard' && blocker.severity === 'blocker', JSON.stringify(t1 && t1.blockerFindings))
    check('AX: the blocker summary names the changed path', !!blocker && blocker.summary.includes('apps/api/src/foo.ts'), JSON.stringify(blocker))
    check('AX: pack/review never run for the blocked task (no pack:T1 or review:T1 call)', !calls.some((c) => c.label === 'pack:T1' || c.label === 'review:T1'), JSON.stringify(calls.map((c) => c.label)))
    const runBlocker = (result.remainingFindings || []).find((f) => f.file === '(workdir)' && f.severity === 'blocker')
    check('AX: the (workdir) blocker is merged into the run\'s own remainingFindings', !!runBlocker, JSON.stringify(result.remainingFindings))
    check('AX: result.clean === false', result.clean === false, JSON.stringify({ clean: result.clean }))
    check('AX: the unrelated sibling task T2 is NOT blocked -- its own fingerprint never moved', !!t2 && t2.blocked !== true, JSON.stringify(t2))
    check('AX: T2 still completes clean', !!t2 && t2.status === 'complete' && t2.clean === true, JSON.stringify(t2))
    check('AX: the main-dir lookup is memoized -- exactly one workdir-guard:main-dir call for the whole run', calls.filter((c) => c.label === 'workdir-guard:main-dir').length === 1, JSON.stringify(calls.map((c) => c.label)))
  },
  {
    ...passingChainFor('T1', { filesChanged: ['apps/api/src/foo.ts'] }),
    ...passingChainFor('T2', { filesChanged: ['src/b.ts'] }),
    'review:T2': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'workdir-guard:main-dir': () => ({ ran: true, dir: 'C:/ClaudeCode/routeflow/.git' }),
    'impl:T1:guard-before': () => ({ ran: true, sha: 'sha-fixed', status: '' }),
    'impl:T1:guard-after': () => ({ ran: true, sha: 'sha-fixed', status: 'M apps/api/src/foo.ts\n' }),
    'impl:T2:guard-before': () => ({ ran: true, sha: 'sha-fixed', status: '' }),
    'impl:T2:guard-after': () => ({ ran: true, sha: 'sha-fixed', status: '' }),
  },
)

// ---------- scenario AY (E7: main-checkout guard skipped when workdir IS the main checkout) ----------
// When args.workdir resolves to the SAME root the main-checkout lookup
// returns (an ordinary same-tree run, not a worktree-per-task launch),
// withWorkdirGuard has nothing to compare workdir against and must skip
// the fingerprint capture entirely -- proven here by asserting NO
// guard-before/guard-after calls happen, even though the main-dir lookup
// itself still runs once.
scenario(
  'AY. the main-checkout guard is skipped when workdir resolves to the main checkout itself',
  baseArgs({
    tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }],
    workdir: 'C:/ClaudeCode/routeflow',
  }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('AY: task T1 is never blocked by the workdir guard', !!t1 && t1.blocked !== true, JSON.stringify(t1))
    check('AY: T1 still completes clean', !!t1 && t1.status === 'complete' && t1.clean === true, JSON.stringify(t1))
    check('AY: the main-dir lookup still runs once', calls.filter((c) => c.label === 'workdir-guard:main-dir').length === 1, JSON.stringify(calls.map((c) => c.label)))
    check('AY: no guard-before/guard-after fingerprint call ever runs -- workdir IS the main checkout', !calls.some((c) => /:guard-(before|after)$/.test(c.label)), JSON.stringify(calls.map((c) => c.label)))
  },
  {
    ...passingChainFor('T1', { filesChanged: ['src/a.ts'] }),
    'review:T1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'workdir-guard:main-dir': () => ({ ran: true, dir: 'C:/ClaudeCode/routeflow/.git' }),
  },
)

// ---------- scenario AZ (E7: implement liveness guard) ----------
// The OTHER half of the 2026-09-15 Lite-lane incident: an implementer that
// reports a non-blocked status (here 'done') but changed nothing -- the
// same "stalled with only brief.md written" shape, just without a main-
// checkout drift to catch it. checkImplementLiveness's own mechanical
// check (report.md existence + a real git-status count) confirms the
// stall -- reportExists:false and changedCount:0 -- so the task is blocked
// with a (implement) / 'no work in workdir' finding rather than accepted
// as a real, if quiet, completion.
scenario(
  'AZ. an implementer reporting an empty footprint (no filesChanged) is confirmed via the mechanical liveness check and blocked as "no work in workdir"',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }] }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('AZ: task T1 is blocked', !!t1 && t1.blocked === true, JSON.stringify(t1))
    const blocker = t1 && (t1.blockerFindings || []).find((f) => f.file === '(implement)')
    check('AZ: a (implement) blocker finding names "no work in workdir"', !!blocker && /no work in workdir/.test(blocker.summary), JSON.stringify(t1 && t1.blockerFindings))
    check('AZ: the mechanical liveness check actually ran (impl:T1:liveness was called)', calls.some((c) => c.label === 'impl:T1:liveness'), JSON.stringify(calls.map((c) => c.label)))
    check('AZ: pack/review never run for the blocked task', !calls.some((c) => c.label === 'pack:T1' || c.label === 'review:T1'), JSON.stringify(calls.map((c) => c.label)))
    check('AZ: result.clean === false', result.clean === false, JSON.stringify({ clean: result.clean }))
  },
  {
    ...passingChainFor('T1'),
    'impl:T1': () => ({ status: 'done', filesChanged: [], deviations: '', notes: '' }),
    'impl:T1:liveness': () => ({ ran: true, reportExists: false, changedCount: 0 }),
  },
)

// ---------- scenario BA (E8: agent non-compliance blocks a task, never crashes the run) ----------
// Real launch 2026-09-15 (Lite L2 lane): the "Author tests" agent completed
// without calling StructuredOutput even after an in-conversation nudge --
// askAgent's underlying agent()/thunk rejected, the rejection escaped
// unguarded, and the WHOLE workflow crashed (`TypeError: null is not an
// object (evaluating 't.status')` plus a `parallel[0]` failure). RC1 here is
// a root-cause task -- rootCauseStage calls askAgent directly, with no
// withWorkdirGuard in front of it, so this specifically exercises runTask's
// OUTER safety net (blockedTaskFromEngineFailure), not withWorkdirGuard's own
// inner catch (that half is covered by reusing AX/AY/AZ's existing green
// runs, which route every implement/test-author call through the guard).
// F1 depends on RC1 (as a `fix` must, structurally) -- fixGateStage's
// existing resultsById lookup sees a real (if blocked) RC1 result with no
// `.rootCause` field and blocks F1 through its OWN pre-existing path, proving
// dependents of a non-compliant task are skipped as blocked rather than run
// on a false "confirmed" reading. T3 is an unrelated sibling in RC1's own
// wave, proving the crash (and the block) stay scoped to RC1 alone.
scenario(
  'BA. a root-cause agent that ends its turn with no usable result (thunk rejects) blocks only its own task; a dependent fix is blocked through the existing root-cause gate; an unrelated sibling in the same wave completes; the run reaches its end phase without throwing',
  baseArgs({
    tasks: [
      { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'find the cause', dependsOn: [] },
      { id: 'RT1', type: 'repro-test', files: [], tests: ['src/bug.test.ts'], brief: 'prove the bug', dependsOn: [], wrongValue: 'WRONG_TOTAL' },
      { id: 'F1', type: 'fix', files: ['src/money.ts'], tests: [], brief: 'fix the money bug', dependsOn: ['RC1', 'RT1'] },
      { id: 'T3', type: 'feature', files: ['src/c.ts'], tests: ['src/c.test.ts'], brief: 'add gamma', dependsOn: [] },
    ],
    mode: 'bugfix',
    buildPlanPath: PLAN_PATH,
  }),
  ({ result, calls }) => {
    const rc1 = (result.tasks || []).find((t) => t.id === 'RC1')
    const rt1 = (result.tasks || []).find((t) => t.id === 'RT1')
    const f1 = (result.tasks || []).find((t) => t.id === 'F1')
    const t3 = (result.tasks || []).find((t) => t.id === 'T3')
    check('BA: the root-cause agent call was actually attempted', calls.some((c) => c.label === 'root-cause:RC1'), JSON.stringify(calls.map((c) => c.label)))
    check('BA: task RC1 is blocked, not left null/undefined', !!rc1 && rc1.blocked === true, JSON.stringify(rc1))
    const blocker = rc1 && (rc1.blockerFindings || []).find((f) => f.file === '(engine)')
    check('BA: an (engine) blocker finding names the no-usable-result case', !!blocker && blocker.phase === 'Implement' && /ended without a usable result/.test(blocker.summary), JSON.stringify(rc1 && rc1.blockerFindings))
    check('BA: the (engine) blocker detail carries the underlying error message', !!blocker && /StructuredOutput/.test(blocker.detail), JSON.stringify(blocker))
    check('BA: RC1 keeps its real id/type (never a bare null)', !!rc1 && rc1.id === 'RC1' && rc1.type === 'root-cause', JSON.stringify(rc1))
    check('BA: the dependent fix F1 is blocked through the EXISTING root-cause gate (fixGateStage), not a duplicate mechanism', !!f1 && f1.blocked === true && (f1.blockerFindings || []).some((x) => x.file === '(root-cause)'), JSON.stringify(f1))
    check('BA: no impl:F1 call was ever made -- the root-cause gate stops the chain before implement', !calls.some((c) => c.label === 'impl:F1'), JSON.stringify(calls.map((c) => c.label)))
    check('BA: RT1, unaffected by RC1, completes clean', !!rt1 && rt1.blocked !== true, JSON.stringify(rt1))
    check('BA: T3, an unrelated sibling in RC1\'s own wave, completes clean', !!t3 && t3.status === 'complete' && t3.clean === true, JSON.stringify(t3))
    check('BA: result.clean === false', result.clean === false, JSON.stringify({ clean: result.clean }))
    check('BA: the run reached its end phase without throwing -- every task is present in result.tasks', (result.tasks || []).length === 4, JSON.stringify((result.tasks || []).map((t) => t.id)))
  },
  {
    ...PASSING_RED_CHECK,
    'tests:RT1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest bug.test.ts', exitCode: 1, output: 'FAIL: assertion failed -- got WRONG_TOTAL' }] }),
    'red-check:RT1': () => ({ structurallyRed: true, tests: [{ test: 'reproduces the bug', outcome: 'assertion-failure', note: 'ok' }], blockers: [], remediation: '' }),
    ...passingChainFor('T3', { filesChanged: ['src/c.ts'] }),
    'review:T3': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'root-cause:RC1': () => { throw new Error('the root-cause agent ended its turn without ever calling StructuredOutput, even after an in-conversation nudge') },
  },
)

// ---------- scenario BB (E8: a null parallel() slot is normalised, not dereferenced) ----------
// The OTHER half of the 2026-09-15 incident: even with BA's per-task guard,
// `parallel()` is a Workflow-provided primitive this engine does not control
// -- it can hand back a null/undefined slot for a reason that has nothing to
// do with the task's own thunk throwing (a killed worker, an internal
// timeout). T1's thunk resolves completely normally here; `dropParallelResultIds`
// only makes the HARNESS discard that already-successful result afterward,
// exactly like the real `parallel[0]` symptom the incident report described.
// The wave loop must map that dropped slot back to a real, blocked task
// object (never leave a bare null in taskResults/resultsById) so every
// downstream consumer -- the run-level `anyTaskNotClean` scan, the final
// tasksOut assembly, progressLineFor's own contract -- sees a real object
// instead of dereferencing null.
scenario(
  'BB. a null slot from parallel() (the task thunk itself resolved; parallel() dropped the result) is normalised to a blocked task, and the run\'s own downstream task scans render it instead of throwing',
  baseArgs({
    tasks: [
      { id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] },
      { id: 'T2', type: 'feature', files: ['src/b.ts'], tests: ['src/b.test.ts'], brief: 'add beta', dependsOn: [] },
    ],
  }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    const t2 = (result.tasks || []).find((t) => t.id === 'T2')
    check('BB: T1\'s dropped parallel() slot is normalised into a real, blocked task -- never left null', !!t1 && t1.blocked === true, JSON.stringify(t1))
    const blocker = t1 && (t1.blockerFindings || []).find((f) => f.file === '(engine)')
    check('BB: an (engine) blocker finding names the no-usable-result case', !!blocker && /ended without a usable result/.test(blocker.summary), JSON.stringify(t1 && t1.blockerFindings))
    check('BB: T1 keeps its real id/type (the ORIGINAL scheduled task, not a fabricated stand-in)', !!t1 && t1.id === 'T1' && t1.type === 'feature', JSON.stringify(t1))
    check('BB: the unrelated sibling T2 (same wave) still completes clean -- the drop stays scoped to T1\'s own slot', !!t2 && t2.status === 'complete' && t2.clean === true, JSON.stringify(t2))
    check('BB: result.clean === false', result.clean === false, JSON.stringify({ clean: result.clean }))
    check('BB: the run reached its end phase without throwing -- both tasks are present in result.tasks', (result.tasks || []).length === 2, JSON.stringify((result.tasks || []).map((t) => t.id)))
  },
  {
    ...passingChainFor('T1', { filesChanged: ['src/a.ts'] }),
    ...passingChainFor('T2', { filesChanged: ['src/b.ts'] }),
    'review:T1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'review:T2': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
  },
  { dropParallelResultIds: ['T1'] },
)

// ---------- scenario BC (E9: engine-owned paths are never flagged) ----------
// Real incident 2026-09-15 (Lite L2): the test author for WP5a touched its
// OWN run's artifact directory (spec.md, build-plan.md, test-plan.md,
// RESUME.md, phases/) and the shared agent-log.jsonl -- all under
// '.claude/pipeline/'. enforceTestAuthorScope flagged every one of them as
// "untracked and not in any task's files/tests -- unplanned" and its
// remediation deleted them. isEngineOwnedPath must strip these out BEFORE
// the violation computation even runs, so none of them are ever flagged,
// the remediation agent is never even called, and the task proceeds exactly
// as if the author had touched nothing outside scope.
scenario(
  "BC. enforceTestAuthorScope ignores engine-owned paths entirely -- a test author touching its own run's artifact dir and agent-log.jsonl is never flagged or reverted",
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH, profile: 'standard' }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('BC: task T1 is never blocked by the scope guard', !!t1 && t1.blocked !== true, JSON.stringify(t1))
    check('BC: T1 completes clean', !!t1 && t1.status === 'complete' && t1.clean === true, JSON.stringify(t1))
    check('BC: no (scope) blocker finding was ever recorded', !(t1 && (t1.blockerFindings || []).some((f) => f.file === '(scope)')), JSON.stringify(t1 && t1.blockerFindings))
    check('BC: the remediation agent is never called -- there was nothing to revert', !calls.some((c) => c.label === 'tests:T1:scope-revert'), JSON.stringify(calls.map((c) => c.label)))
    check('BC: the before-snapshot machinery still runs (E9 rule 2 is exercised even on the no-violation path)', calls.some((c) => c.label === 'tests:T1:scope-before'), JSON.stringify(calls.map((c) => c.label)))
  },
  {
    ...passingChainFor('T1', { filesChanged: ['src/a.ts'] }),
    'tests:T1:scope-before': () => ({ ran: true, files: [] }),
    'tests:T1:scope': () => ({
      ran: true,
      files: [
        { path: '.claude/pipeline/dry/spec.md', tracked: false },
        { path: '.claude/pipeline/dry/build-plan.md', tracked: false },
        { path: '.claude/pipeline/dry/test-plan.md', tracked: false },
        { path: '.claude/pipeline/dry/RESUME.md', tracked: false },
        { path: '.claude/pipeline/dry/phases/01-baseline.json', tracked: false },
        { path: '.claude/pipeline/agent-log.jsonl', tracked: false },
      ],
    }),
    'review:T1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
  },
)

// ---------- scenario BD (E9 rule 2: delete only what is provably new) ----------
// A test author that creates a genuinely new, unplanned, untracked file AND
// merely touches a pre-existing untracked file it does not own: the guard
// may delete only the first (mechanically confirmed absent from the
// before-snapshot) and must leave the second on disk, reporting it as a
// blocker instead. The remediation prompt itself must never even be told
// about the pre-existing path -- it is not sent for either checkout or
// delete.
scenario(
  'BD. a test author creating one NEW untracked out-of-scope file has only that file removed -- a pre-existing untracked file it also touched is reported but never deleted',
  baseArgs({ tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/a.test.ts'], brief: 'add alpha', dependsOn: [] }], buildPlanPath: PLAN_PATH, profile: 'standard' }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    check('BD: task T1 is blocked', !!t1 && t1.blocked === true, JSON.stringify(t1))
    const blocker = t1 && (t1.blockerFindings || []).find((f) => f.file === '(scope)')
    check('BD: a (scope) blocker finding names BOTH paths', !!blocker && blocker.summary.includes('src/stray-new.ts') && blocker.summary.includes('src/pre-existing-untracked.ts'), JSON.stringify(blocker))
    check('BD: the detail confirms the new file was reverted/deleted', !!blocker && blocker.detail.includes('Reverted') && blocker.detail.includes('src/stray-new.ts'), JSON.stringify(blocker))
    check('BD: the detail confirms the pre-existing file was left in place, never deleted', !!blocker && blocker.detail.includes('never deleted') && blocker.detail.includes('src/pre-existing-untracked.ts'), JSON.stringify(blocker))
    const revertCall = calls.find((c) => c.label === 'tests:T1:scope-revert')
    check('BD: the remediation call was made, naming only the NEW file', !!revertCall && revertCall.prompt.includes('src/stray-new.ts'), JSON.stringify(revertCall && revertCall.prompt))
    check('BD: the remediation call never even mentions the pre-existing file -- it is not an option remediation can act on', !!revertCall && !revertCall.prompt.includes('src/pre-existing-untracked.ts'), JSON.stringify(revertCall && revertCall.prompt))
    check('BD: implementStage never runs for the blocked task (no impl:T1 call)', !calls.some((c) => c.label === 'impl:T1'), JSON.stringify(calls.map((c) => c.label)))
  },
  {
    'tests:T1': () => ({ ran: true, cwd: 'C:/repo', results: [{ command: 'npx jest src/a.test.ts', exitCode: 1, output: 'FAIL: assertion failed as expected' }] }),
    'tests:T1:scope-before': () => ({ ran: true, files: ['src/pre-existing-untracked.ts'] }),
    'tests:T1:scope': () => ({
      ran: true,
      files: [
        { path: 'src/stray-new.ts', tracked: false },
        { path: 'src/pre-existing-untracked.ts', tracked: false },
      ],
    }),
    'tests:T1:scope-revert': () => ({ exitCode: 0, reverted: ['src/stray-new.ts'] }),
  },
)

// ---------- scenario BE (E9 rule 4: defence in depth against a cascade) ----------
// Even with BC/BD closing the deletion hole, this is the second, independent
// layer: if this run's build-plan.md/test-plan.md vanish from disk mid-run
// for ANY reason, task-brief.mjs/review-pack.mjs calls for every remaining
// task would otherwise fail one by one, each looking like an unrelated
// defect. T1 (wave 1) runs before the loss and completes clean; T2 (wave 2,
// dependsOn T1) is checked at the wave boundary, found missing, and blocked
// immediately -- its OWN test-author/implement/review stages never run at
// all, so this is a stop, not a cascade of independent failures.
scenario(
  'BE. plan files missing mid-run stop the run at the next wave boundary with a loud "run artifacts missing" finding, not a per-task cascade',
  baseArgs({ buildPlanPath: PLAN_PATH, profile: 'standard' }),
  ({ result, calls }) => {
    const t1 = (result.tasks || []).find((t) => t.id === 'T1')
    const t2 = (result.tasks || []).find((t) => t.id === 'T2')
    check('BE: T1 (wave 1, before the loss) completes clean', !!t1 && t1.status === 'complete' && t1.clean === true, JSON.stringify(t1))
    check('BE: T2 (wave 2, after the loss) is blocked', !!t2 && t2.blocked === true, JSON.stringify(t2))
    check('BE: T2\'s own stages never ran -- the run stopped BEFORE them, not after a failed one', !calls.some((c) => c.label === 'tests:T2' || c.label === 'impl:T2' || c.label === 'review:T2'), JSON.stringify(calls.map((c) => c.label)))
    const blocker = t2 && (t2.blockerFindings || []).find((f) => f.file === '(run-artifacts)')
    check('BE: T2 carries a (run-artifacts) blocker finding naming the missing plan path', !!blocker && blocker.detail.includes(PLAN_PATH), JSON.stringify(t2 && t2.blockerFindings))
    const runBlocker = (result.remainingFindings || []).find((f) => f.file === '(run-artifacts)' && f.severity === 'blocker')
    check('BE: the (run-artifacts) blocker is merged into the run\'s own remainingFindings', !!runBlocker, JSON.stringify(result.remainingFindings))
    check('BE: result.clean === false', result.clean === false, JSON.stringify({ clean: result.clean }))
    check('BE: the run reached its end phase without throwing -- both tasks are present in result.tasks', (result.tasks || []).length === 2, JSON.stringify((result.tasks || []).map((t) => t.id)))
  },
  {
    ...passingChainFor('T1', { filesChanged: ['src/a.ts'] }),
    'review:T1': () => ({ specCompliance: 'pass', findings: [], assessment: 'approved' }),
    'run-artifacts-check:T1': () => ({ ran: true, missing: [] }),
    'run-artifacts-check:T2': () => ({ ran: true, missing: [PLAN_PATH] }),
  },
)

// ---------- scenario N (A3) ----------
// validateTasks() must run BEFORE any agent() call and block a structurally
// invalid plan: an unknown task type, a `fix` missing a `root-cause` AND a
// `repro-test` ancestor via dependsOn, a `revert-probe` missing a `fix`
// ancestor, or two tasks sharing a file with no dependsOn path between them
// (mirrors the OLD engine's buildWaves issues, pipeline.js.bak-2026-09-12
// @2851-2907, but as a hard blocker instead of a silent same-wave split).
// Each case runs the harness independently (a different task graph per case),
// so this scenario is asserted as one block rather than the uniform
// {name, args, assert} shape the other scenarios use.
async function runScenarioN() {
  console.log('\nN. validateTasks blocks a structurally invalid plan before any agent() call')
  const cases = [
    {
      label: 'unknown task type is a (build-plan) blocker',
      tasks: [{ id: 'T1', type: 'bogus', files: ['src/a.ts'], tests: [], brief: 'b', dependsOn: [] }],
      expectBlocked: true,
    },
    {
      label: 'a fix with no root-cause or repro-test ancestor is a (build-plan) blocker',
      tasks: [{ id: 'F1', type: 'fix', files: ['src/a.ts'], tests: [], brief: 'b', dependsOn: [] }],
      expectBlocked: true,
    },
    {
      label: 'a fix with only a root-cause ancestor (missing repro-test) is still blocked',
      tasks: [
        { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'b', dependsOn: [] },
        { id: 'F1', type: 'fix', files: ['src/a.ts'], tests: [], brief: 'b', dependsOn: ['RC1'] },
      ],
      expectBlocked: true,
    },
    {
      label: 'a fix with both a root-cause and a repro-test ancestor is NOT blocked by this rule',
      tasks: [
        { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'b', dependsOn: [] },
        { id: 'RT1', type: 'repro-test', files: [], tests: ['src/a.test.ts'], brief: 'b', dependsOn: [] },
        { id: 'F1', type: 'fix', files: ['src/a.ts'], tests: [], brief: 'b', dependsOn: ['RC1', 'RT1'] },
      ],
      expectBlocked: false,
    },
    {
      label: 'a revert-probe with no fix ancestor is a (build-plan) blocker',
      tasks: [{ id: 'RP1', type: 'revert-probe', files: ['src/a.ts'], tests: [], brief: 'b', dependsOn: [] }],
      expectBlocked: true,
    },
    {
      label: 'two tasks sharing a file with no dependsOn path is a (build-plan) blocker',
      tasks: [
        { id: 'T1', type: 'feature', files: ['src/shared.ts'], tests: [], brief: 'b', dependsOn: [] },
        { id: 'T2', type: 'feature', files: ['src/shared.ts'], tests: [], brief: 'b', dependsOn: [] },
      ],
      expectBlocked: true,
    },
    {
      label: 'two tasks sharing a file WITH a dependsOn path are NOT blocked by this rule',
      tasks: [
        { id: 'T1', type: 'feature', files: ['src/shared.ts'], tests: [], brief: 'b', dependsOn: [] },
        { id: 'T2', type: 'feature', files: ['src/shared.ts'], tests: [], brief: 'b', dependsOn: ['T1'] },
      ],
      expectBlocked: false,
    },
    // ---- fix round 1 (task review): three new-letter-free additions to
    // scenario N, one per Important finding ----
    {
      // Finding 1: naive string equality let two spellings of the SAME file
      // ('src/shared.ts' vs './src/shared.ts') defeat the shared-file rule.
      label: 'two tasks sharing a file under different spellings ("src/shared.ts" vs "./src/shared.ts") is still a (build-plan) blocker',
      tasks: [
        { id: 'T1', type: 'feature', files: ['src/shared.ts'], tests: [], brief: 'b', dependsOn: [] },
        { id: 'T2', type: 'feature', files: ['./src/shared.ts'], tests: [], brief: 'b', dependsOn: [] },
      ],
      expectBlocked: true,
    },
    {
      // Finding 2a: an unknown dependsOn id used to be dropped with no finding.
      label: 'an unknown dependsOn id ("T9") is a (build-plan) blocker',
      tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: [], brief: 'b', dependsOn: ['T9'] }],
      expectBlocked: true,
    },
    {
      // Finding 2b: a self-edge used to be dropped with no finding.
      label: 'a dependsOn self-edge is a (build-plan) blocker',
      tasks: [{ id: 'T1', type: 'feature', files: ['src/a.ts'], tests: [], brief: 'b', dependsOn: ['T1'] }],
      expectBlocked: true,
    },
    {
      // Finding 2c: a 2-cycle used to satisfy dependsPathExists (each task is
      // transitively its own ancestor's ancestor) and so was treated as
      // "ordered" -- the shared-file rule alone stayed silent. These two
      // tasks ALSO share a file, to prove the cycle is caught even though the
      // shared-file rule cannot see it: assert on aborted/clean/severity only
      // (not on the shared-file rule's own blocker text).
      label: 'a 2-cycle between two tasks that also share a file is a (build-plan) blocker (caught by cycle detection, not the shared-file rule)',
      tasks: [
        { id: 'T1', type: 'feature', files: ['src/shared.ts'], tests: [], brief: 'b', dependsOn: ['T2'] },
        { id: 'T2', type: 'feature', files: ['src/shared.ts'], tests: [], brief: 'b', dependsOn: ['T1'] },
      ],
      expectBlocked: true,
    },
    {
      // Duplicate-id gap folded into finding 2's family (small addition): a
      // repeated id collapses in `byId`, so every ancestor/type check after
      // the first declaration would silently see only the LAST one.
      label: 'a duplicate task id is a (build-plan) blocker',
      tasks: [
        { id: 'T1', type: 'feature', files: ['src/a.ts'], tests: [], brief: 'b', dependsOn: [] },
        { id: 'T1', type: 'feature', files: ['src/b.ts'], tests: [], brief: 'b', dependsOn: [] },
      ],
      expectBlocked: true,
    },
    // ---- fix round 1 (A4-A7 task review, finding 2): the shared-file rule
    // was `files`-only -- two tasks that both extend the same TEST file with
    // no dependsOn ordering slipped through unblocked (and buildWaves could
    // co-schedule them into the same wave). Fixed to overlap over
    // `[...files, ...tests]` in BOTH validateTasks and buildWaves, so this
    // case is now blocked exactly like the existing shared-`files` case
    // above (chosen over silently wave-separating it in buildWaves alone, to
    // match how the existing files-only sharing is already handled today).
    {
      label: 'two tasks sharing a TESTS file with no dependsOn path is a (build-plan) blocker',
      tasks: [
        { id: 'T1', type: 'feature', files: ['src/a.ts'], tests: ['src/shared.test.ts'], brief: 'b', dependsOn: [] },
        { id: 'T2', type: 'feature', files: ['src/b.ts'], tests: ['src/shared.test.ts'], brief: 'b', dependsOn: [] },
      ],
      expectBlocked: true,
    },
  ]
  for (const c of cases) {
    const out = await run({ args: baseArgs({ tasks: c.tasks }) })
    allCalls.push(...out.calls)
    if (showCalls) for (const cc of out.calls) console.log(`     ${(cc.phase || '').padEnd(15)} ${(cc.label || '').padEnd(28)} ${String(cc.model).padEnd(18)} ${cc.effort}`)
    if (c.expectBlocked) {
      check(`N: ${c.label} -- aborted invalid-plan`, out.result.aborted === 'invalid-plan', JSON.stringify(out.result))
      check(`N: ${c.label} -- (build-plan) blocker present`, (out.result.remainingFindings || []).some((f) => f.file === '(build-plan)'), JSON.stringify(out.result.remainingFindings))
      // Finding 3: the finding shape must carry severity:'blocker' (and the
      // engine-wide clean:false), matching every other consumer of findings.
      check(`N: ${c.label} -- every (build-plan) finding carries severity:'blocker'`, (out.result.remainingFindings || []).every((f) => f.severity === 'blocker'), JSON.stringify(out.result.remainingFindings))
      check(`N: ${c.label} -- result.clean === false`, out.result.clean === false, JSON.stringify(out.result))
      check(`N: ${c.label} -- zero agent calls`, out.calls.length === 0, out.calls.length)
    } else {
      // Through A3, ANY valid plan made zero agent calls (the engine was a
      // meta-only stub past validateTasks). A4-A7 give a valid plan a real
      // Preflight + Baseline + wave loop, so a NOT-blocked case now makes
      // several calls -- that is the new, correct behavior, not a
      // regression. The invariant this scenario actually needs to hold
      // (validateTasks runs BEFORE any agent() call) is still proven by the
      // BLOCKED branch above, which returns before Preflight ever runs.
      check(`N: ${c.label} -- not blocked as invalid-plan`, out.result.aborted !== 'invalid-plan', JSON.stringify(out.result))
    }
  }
}

// ---------- scenario M (A15) ----------
// Profile selection (S6): args.profile, when 'lean' or 'standard', always
// wins; otherwise a small-scale run with no HIGH-risk task anywhere
// (explicit risk:'HIGH' on a task, or a manifest file marked HIGH) defaults
// to 'lean' (superpowers parity); anything else defaults to 'standard'. Four
// distinct fixtures, like scenario N, so this runs as its own async block
// rather than the uniform {name, args, assert} shape.
const HIGH_RISK_FIX_TASKS = [
  { id: 'RC1', type: 'root-cause', files: [], tests: [], brief: 'find the cause', dependsOn: [] },
  { id: 'RT1', type: 'repro-test', files: [], tests: ['src/bug.test.ts'], brief: 'prove the bug', dependsOn: [], wrongValue: 'WRONG_TOTAL' },
  { id: 'F1', type: 'fix', files: ['src/money.ts'], tests: [], brief: 'fix the money bug', dependsOn: ['RC1', 'RT1'], risk: 'HIGH' },
]
async function runScenarioM() {
  console.log('\nM. profile selection: small/no-HIGH picks lean, a HIGH-risk fixture picks standard, args.profile overrides both')
  const cases = [
    { label: 'a small-scale run with no HIGH-risk task anywhere picks lean', args: baseArgs({}), expect: 'lean' },
    { label: "a fixture matching scenario G's shape (explicit HIGH-risk) picks standard", args: baseArgs({ tasks: HIGH_RISK_FIX_TASKS, buildPlanPath: PLAN_PATH }), expect: 'standard' },
    { label: "args.profile:'standard' overrides the automatic no-HIGH lean default", args: baseArgs({ profile: 'standard' }), expect: 'standard' },
    { label: "args.profile:'lean' overrides a HIGH-risk fixture's automatic standard default", args: baseArgs({ profile: 'lean', tasks: HIGH_RISK_FIX_TASKS, buildPlanPath: PLAN_PATH }), expect: 'lean' },
  ]
  for (const c of cases) {
    const out = await run({ args: c.args })
    allCalls.push(...out.calls)
    if (showCalls) for (const cc of out.calls) console.log(`     ${(cc.phase || '').padEnd(15)} ${(cc.label || '').padEnd(28)} ${String(cc.model).padEnd(18)} ${cc.effort}`)
    check(`M: ${c.label}`, out.result.profile === c.expect, out.result.profile)
    check(`M: ${c.label} -- result.approach stays 'dev-pipeline' regardless of which profile was picked`, out.result.approach === 'dev-pipeline', out.result.approach)
  }
}

// ---------- run every scenario ----------
for (const s of scenarios) {
  console.log(`\n${s.name}`)
  try {
    const out = await run(s)
    allCalls.push(...out.calls)
    if (showCalls) for (const c of out.calls) console.log(`     ${(c.phase || '').padEnd(15)} ${(c.label || '').padEnd(28)} ${String(c.model).padEnd(18)} ${c.effort}`)
    out.assert = s.assert
    s.assert(out)
  } catch (e) {
    failures++
    console.log(`  FAIL scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`)
  }
}

try {
  await runScenarioN()
} catch (e) {
  failures++
  console.log(`  FAIL scenario N threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`)
}

try {
  await runScenarioM()
} catch (e) {
  failures++
  console.log(`  FAIL scenario M threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`)
}

// A17 (task 18): global CALLS AUDIT -- every agent call recorded across
// EVERY scenario above carries a real model id and an explicit effort. A
// call missing either would mean an agent ran unrouted (a default alias, an
// implicit tier) with no ledger-visible record of what it actually cost --
// `--calls | grep -c "claude-"` is only meaningful if this holds. (This
// section's own check() descriptions deliberately avoid the literal
// "claude-" substring, so that exact verify command counts only the real
// per-call print lines above, one per recorded agent call -- never one of
// these summary lines too.)
console.log(`\nCALLS AUDIT. ${allCalls.length} agent call(s) recorded across every scenario`)
const callsMissingModel = allCalls.filter((c) => typeof c.model !== 'string' || !c.model.startsWith('claude-'))
check('every recorded agent call carries a full, real model id (never a bare alias or a missing one)', callsMissingModel.length === 0, JSON.stringify(callsMissingModel.slice(0, 5)))
const callsMissingEffort = allCalls.filter((c) => typeof c.effort !== 'string' || c.effort.length === 0)
check('every recorded agent call carries an explicit, non-empty effort', callsMissingEffort.length === 0, JSON.stringify(callsMissingEffort.slice(0, 5)))

// SOURCE SCAN (owner ruling -- pipeline.js runs in a sandbox with NO host
// globals, and the Workflow approval dialog rejects a script whose source
// contains non-ASCII). Strip `src` down to real code -- `//` and `/* */`
// comments, quoted-string bodies, and template-literal LITERAL text all go
// blank (newlines kept so line numbers stay right), while every `${...}`
// substitution is walked as code, recursively -- then assert what remains
// never touches a host global. Registered through check() so a regression
// here fails the run like any other assertion. Not a general JS parser: it
// does not disambiguate regex literals from division, which pipeline.js does
// not lean on near any of the banned tokens.
console.log('\nSOURCE SCAN. pipeline.js never touches a host global the sandbox does not provide, and stays ASCII-only')
const HOST_GLOBAL_TOKENS = [
  { name: 'Buffer.', re: /Buffer\./g },
  { name: 'process.', re: /process\./g },
  { name: 'require(', re: /require\(/g },
  { name: 'fs.', re: /\bfs\./g },
  { name: 'Date.now(', re: /Date\.now\(/g },
  { name: 'Math.random(', re: /Math\.random\(/g },
  { name: 'new Date()', re: /new Date\(\)/g },
]
function stripToCode(text) {
  let out = ''
  let i = 0
  const n = text.length
  const stack = [{ type: 'top' }]
  const blank = (ch) => { out += ch === '\n' ? '\n' : ' ' }
  while (i < n) {
    const frame = stack[stack.length - 1]
    const c = text[i]
    const c2 = i + 1 < n ? text[i + 1] : ''
    if (frame.type === 'template') {
      if (c === '\\') { blank(c); i++; if (i < n) { blank(text[i]); i++ }; continue }
      if (c === '`') { out += c; i++; stack.pop(); continue }
      if (c === '$' && c2 === '{') { out += '${'; i += 2; stack.push({ type: 'sub', depth: 0 }); continue }
      blank(c); i++
      continue
    }
    if (c === '/' && c2 === '/') { while (i < n && text[i] !== '\n') { blank(text[i]); i++ }; continue }
    if (c === '/' && c2 === '*') {
      blank(text[i]); blank(text[i + 1]); i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { blank(text[i]); i++ }
      if (i < n) { blank(text[i]); blank(text[i + 1]); i += 2 }
      continue
    }
    if (c === '\'' || c === '"') {
      const quote = c
      out += c; i++
      while (i < n && text[i] !== quote) {
        if (text[i] === '\\') { blank(text[i]); i++; if (i < n) { blank(text[i]); i++ }; continue }
        blank(text[i]); i++
      }
      if (i < n) { out += text[i]; i++ }
      continue
    }
    if (c === '`') { out += c; i++; stack.push({ type: 'template' }); continue }
    if (frame.type === 'sub') {
      if (c === '{') { frame.depth++; out += c; i++; continue }
      if (c === '}') {
        if (frame.depth === 0) { out += c; i++; stack.pop(); continue }
        frame.depth--; out += c; i++
        continue
      }
    }
    out += c; i++
  }
  return out
}
function scanHostGlobals(text) {
  const stripped = stripToCode(text)
  const hits = []
  for (const { name, re } of HOST_GLOBAL_TOKENS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(stripped))) hits.push(`${name}@${stripped.slice(0, m.index).split('\n').length}`)
  }
  return hits
}
const engineHits = scanHostGlobals(src)
check(
  'pipeline.js (outside comments/strings/template text) never calls Buffer., process., require(, fs., Date.now(, Math.random(, or new Date()',
  engineHits.length === 0,
  engineHits.join(', '),
)
// A16 (folded into A1's harness so the ASCII rule is enforced from the first
// commit): the Workflow approval dialog's preview truncation reads a non-ASCII
// character mid-byte as a control character, which rejects the launch -- so
// pipeline.js's CODE (not comments or string/template text, which the dialog
// never executes as control flow) must be pure ASCII. Checked against the
// same stripToCode() output the host-global scan above already uses, so
// prose em/en-dashes in `//` comments (e.g. the 2026-09-13 ruling notes) are
// fine -- the original intent was to catch smart quotes/dashes landing IN
// code (e.g. inside an identifier or a template literal that gets emitted
// into a prompt), not in prose.
check('pipeline.js code (outside comments/strings/template text) is ASCII-only', /^[\x00-\x7f]*$/.test(stripToCode(src)), '')

// Self-test the scanners themselves (repro-first): a synthetic fixture with a
// real Buffer.from( call and exactly one literal U+00B7 character must be
// flagged by BOTH scans, or neither scan is doing real work. Replaces the
// pipeline.js.bak-2026-09-11e self-test (that file no longer reflects what the
// rebuilt engine must avoid).
const fixturePath = path.join(here, 'fixtures', 'bad-engine-sample.txt')
const fixtureText = fs.readFileSync(fixturePath, 'utf8')
const fixtureHits = scanHostGlobals(fixtureText)
check(
  'self-test: bad-engine-sample.txt (real Buffer.from( call) IS flagged by the host-global scan',
  fixtureHits.some((h) => h.startsWith('Buffer.@')),
  fixtureHits.join(', '),
)
check(
  'self-test: bad-engine-sample.txt (one literal U+00B7 character IN CODE) IS flagged by the code-only ASCII scan',
  !/^[\x00-\x7f]*$/.test(stripToCode(fixtureText)),
  '',
)
check(
  'self-test: a U+00B7 character inside a `//` comment is NOT flagged by the code-only ASCII scan (prose dashes/marks in comments are fine)',
  /^[\x00-\x7f]*$/.test(stripToCode('// stray · in a comment\nconst x = 1\n')),
  '',
)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL DRY-RUN SCENARIOS PASSED')
process.exit(failures ? 1 : 0)
