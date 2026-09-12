#!/usr/bin/env node
// light-loop-dry-run.mjs — executes light-loop.js with STUBBED Workflow globals.
// Zero API calls. Mirrors dry-run.mjs's harness shape exactly (same globals,
// same new Function() wrapper) so both scripts' contracts stay checkable the
// same way. Run after ANY edit to light-loop.js — `node --check` proves
// syntax, this proves the branches: PHASE/LABEL tagging, PHASE_ORDER-only
// aliases, checkpoint count, isolation propagation, the host-contention
// early return, maxFixRounds, and the result.json shape closeout.mjs reads.
//
//   node scripts/light-loop-dry-run.mjs            # all scenarios
//   node scripts/light-loop-dry-run.mjs --calls     # also print every agent call
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const here = path.dirname(url.fileURLToPath(import.meta.url))
const src = fs
  .readFileSync(path.join(here, 'light-loop.js'), 'utf8')
  .replace(/^export const meta = \{/m, 'const meta = {')
const showCalls = process.argv.includes('--calls')

// Canonical phase order, copied verbatim from
// model-routing/scripts/pipeline-ledger.mjs so this dry-run and the ledger
// can never silently drift apart.
const PHASE_ORDER = [
  'Baseline', 'Author tests', 'Red gate', 'Implement', 'Gate & Review',
  'Verify', 'UI verify', 'Mutation probe', 'Fix', 'Final pass',
]

const finding = (over = {}) => ({ severity: 'major', file: 'src/a.ts', line: 1, summary: 'wrong scope', evidence: 'e', scenario: 's', ...over })

// Canned responder: label prefix -> result. `overrides` lets a scenario change one answer.
function responder(s) {
  return (label, opts, prompt) => {
    const o = s.overrides || {}
    for (const k of Object.keys(o)) if (label.startsWith(k)) return typeof o[k] === 'function' ? o[k](label, opts, prompt) : o[k]
    if (label === 'preflight') return s.preflight !== undefined ? s.preflight : { contended: false, treeClean: true, resumeWritten: true, note: '' }
    if (label === 'ground') return s.ground !== undefined ? s.ground : { ok: true, missing: [], packages: s.packages || [{ id: 'WP1', title: 'w', brief: 'b', files: ['src/a.ts'], risk: 'LOW' }], note: '' }
    if (label.startsWith('build:')) return s.buildResponder ? s.buildResponder(label, opts, prompt) : { packageId: label.slice(6), filesChanged: ['src/a.ts'], gates: [{ command: 'jest a', pass: true, summary: 'ok' }], findings: s.buildFindings || [], deviations: [] }
    if (label === 'pack') return { written: true, path: 'x', bytes: 100, truncated: false, note: '' }
    if (label.startsWith('review:')) return s.reviewResponder ? s.reviewResponder(label, opts, prompt) : { claims: [], findings: s.reviewFindings || [], verdict: (s.reviewFindings || []).length ? 'FIX-FIRST' : 'SHIP' }
    if (label === 'fix-brief') return { items: (s.openFindingsAtBrief || [finding()]).map((f, i) => ({ index: i, file: f.file, line: f.line, excerpt: f.summary, severity: f.severity, evidence: f.evidence })), note: '' }
    if (label === 'fix-plan') return s.fixPlan !== undefined ? s.fixPlan : { fixes: [{ findingRef: 0, action: 'fix', design: 'apply the hint', invariant: 'x', testPin: 'jest a', executorTier: 'mechanical' }], deferred: [], note: '' }
    if (label === 'fix-plan:fallback') return s.fixPlanFallback !== undefined ? s.fixPlanFallback : { fixes: [{ findingRef: 0, action: 'fix', design: 'apply the hint', invariant: 'x', testPin: '', executorTier: 'sonnet' }], deferred: [], note: 'fallback' }
    if (label.startsWith('execute:')) return s.executeResponder ? s.executeResponder(label, opts, prompt) : { findingRef: Number(label.split(':')[1]), status: 'done', filesChanged: ['src/a.ts'], gate: { command: 'jest a', pass: true, summary: 'ok' }, note: '' }
    if (label === 'recheck') return s.recheck !== undefined ? s.recheck : { claims: [], findings: [], verdict: 'SHIP' }
    if (label.startsWith('checkpoint:')) return { written: true, path: 'x', note: '' }
    if (label === 'result') return { written: true, path: 'x', endedAt: '2026-09-10T00:00:00.000Z', note: '' }
    if (label === 'warmup') return 'OK'
    return null
  }
}

// F3: the meta.phases titles this script must call phase() with, verbatim.
// Copied here (not read off `meta` itself) because the Function wrapper below
// never returns meta -- it is a local variable inside the IIFE body.
const META_PHASE_TITLES = ['Baseline', 'Implement', 'Gate & Review', 'Fix', 'Final pass']

async function run(s) {
  const calls = []
  const logs = []
  const phaseCalls = []
  const respond = responder(s)
  const agentFn = async (prompt, opts) => {
    calls.push({ label: opts.label, model: opts.model, effort: opts.effort, phase: opts.phase, isolation: opts.isolation, prompt })
    const r = respond(opts.label, opts, prompt)
    return r === undefined ? null : r
  }
  const parallelFn = async (thunks) => Promise.all(thunks.map(async (t) => { try { return await t() } catch (e) { logs.push(`THROW ${e && e.message}`); return null } }))
  const pipelineFn = async (items, ...stages) => Promise.all(items.map(async (it, i) => { let v = it; for (const st of stages) v = await st(v, it, i); return v }))
  const log = (m) => logs.push(String(m))
  const phase = (t) => { phaseCalls.push(t) }
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  const fn = new Function('agent', 'parallel', 'pipeline', 'log', 'phase', 'args', 'budget', 'workflow', `return (async () => { ${src} })()`)
  const result = await fn(agentFn, parallelFn, pipelineFn, log, phase, s.args, budget, async () => null)
  return { result, calls, logs, phaseCalls }
}

const baseArgs = (extra = {}) => ({
  briefPath: 'brief.md', runDir: '/tmp/light-loop-dry-run', startedAt: '2026-09-10T00:00:00Z',
  lessonsPath: 'LESSONS.md', ...extra,
})

let failures = 0
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`)
  else { failures++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`) }
}
const byLabel = (calls, p) => calls.filter((c) => c.label.startsWith(p))
const FULL_IDS = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']

// The house rules every scenario re-checks (mirrors dry-run.mjs's houseRules).
function houseRules(calls) {
  check('every agent call carries a full model id', calls.every((c) => FULL_IDS.includes(c.model)), JSON.stringify([...new Set(calls.map((c) => c.model))]))
  check('every agent call carries an effort', calls.every((c) => !!c.effort), JSON.stringify(calls.filter((c) => !c.effort).map((c) => c.label)))
  check('every prompt opens with the byte-identical RUN_PREFIX (repo note first)', calls.every((c) => c.prompt.startsWith('You are working in the current directory') || c.prompt.startsWith('ALL work happens')), JSON.stringify(calls.filter((c) => !(c.prompt.startsWith('You are working in the current directory') || c.prompt.startsWith('ALL work happens'))).map((c) => c.label)))
  check('every prompt carries a PHASE: <alias> · LABEL: <slug> tag', calls.every((c) => /PHASE: .+ · LABEL: .+/.test(c.prompt)), JSON.stringify(calls.filter((c) => !/PHASE: .+ · LABEL: .+/.test(c.prompt)).map((c) => c.label)))
  const badAlias = calls.filter((c) => !PHASE_ORDER.includes(c.phase))
  check('every PHASE tag alias is a PHASE_ORDER member', badAlias.length === 0, JSON.stringify(badAlias.map((c) => [c.label, c.phase])))
  // The RUN_PREFIX explicitly PROHIBITS `git add -A` ("Never run `git add
  // -A`") -- that mention is the point, not a violation. Strip the
  // prohibition phrase first, exactly as dry-run.mjs's badGitAddA does.
  const gitAddA = calls.filter((c) => c.prompt.split('Never run `git add -A`').join('').includes('git add -A'))
  check('no prompt ever INSTRUCTS running `git add -A` (only the explicit prohibition may mention it)', gitAddA.length === 0, JSON.stringify(gitAddA.map((c) => c.label)))
}

// F3: every phase() call this run ever makes must be one of the 5 real
// meta.phases titles -- run automatically after every scenario below so a
// stray/misspelled phase() call anywhere in light-loop.js fails immediately,
// not just in the scenarios that happen to assert on it directly.
function checkPhaseCalls(phaseCalls) {
  check('every phase() call is a real meta.phases title', phaseCalls.every((t) => META_PHASE_TITLES.includes(t)), JSON.stringify(phaseCalls))
}

const scenarios = [
  {
    name: 'A. clean run: one package, no findings — a SHIP verdict never runs a fix round',
    args: baseArgs(),
    assert({ result: r, calls, phaseCalls }) {
      const order = ['preflight', 'ground', 'build:WP1', 'pack', 'review:correctness']
      const positions = order.map((l) => calls.findIndex((c) => c.label === l))
      check('preflight, ground, build, pack, review each ran exactly once, in order', positions.every((p) => p !== -1) && positions.every((p, i) => i === 0 || p > positions[i - 1]), JSON.stringify(calls.map((c) => c.label)))
      check('no fix-round labels ran', byLabel(calls, 'fix-brief').length === 0 && byLabel(calls, 'fix-plan').length === 0 && byLabel(calls, 'execute:').length === 0 && byLabel(calls, 'recheck').length === 0)
      check('result.rounds is 0', r.rounds === 0, r.rounds)
      check('result.clean is true', r.clean === true, JSON.stringify(r.remainingFindings))
      // F2: buildRow()/closeout.mjs actually read `fixRounds`, not `rounds` --
      // this key list mirrors that, so a regression here fails loudly instead
      // of quietly shipping a ledger row with fixRounds always null.
      check('result carries every key closeout.mjs / pipeline-ledger.mjs buildRow() reads', ['mode', 'scale', 'runId', 'startedAt', 'endedAt', 'fixRounds', 'clean', 'remainingFindings', 'confirmedByPhase', 'phaseReport', 'checkpoints'].every((k) => k in r), JSON.stringify(Object.keys(r)))
      check('result.fixRounds mirrors result.rounds (F2 -- both present, never a breaking rename)', r.fixRounds === r.rounds, `fixRounds=${r.fixRounds} rounds=${r.rounds}`)
      check('mode is light-loop', r.mode === 'light-loop')
      check('phaseReport is an array (buildRow() requires Array.isArray)', Array.isArray(r.phaseReport))
      check('every phaseReport row carries the F9 shape', r.phaseReport.every((row) => ['phase', 'ran', 'agents', 'rawFindings', 'tokens', 'estUsd', 'model', 'effort', 'note'].every((k) => k in row)), JSON.stringify(r.phaseReport))
      check('checkpoint count = phases run + 1', r.checkpoints.length === r.phaseReport.filter((p) => p.ran).length + 1, `checkpoints=${r.checkpoints.length} ranPhases=${r.phaseReport.filter((p) => p.ran).length}`)
      // F3: a clean run with no fix round never enters 'Fix' -- Baseline,
      // Implement, Gate & Review, Final pass (Result) all fire exactly once.
      check('phase() called for Baseline, Implement, Gate & Review, Final pass -- no Fix (no round ran)', JSON.stringify(phaseCalls) === JSON.stringify(['Baseline', 'Implement', 'Gate & Review', 'Final pass']), JSON.stringify(phaseCalls))
      // P4 addendum (2026-09-11e): preflight must count only build-tool
      // processes via command-line inspection, never a bare process count,
      // and must explicitly exclude Claude Code / MCP node processes.
      const preflightCall = calls.find((c) => c.label === 'preflight')
      check('preflight prompt names command-line inspection (not a bare process count)', !!preflightCall && /Get-CimInstance|wmic process/.test(preflightCall.prompt), preflightCall && preflightCall.prompt)
      check('preflight prompt excludes Claude Code / MCP processes from the count', !!preflightCall && /Claude Code sessions and their MCP servers.*do NOT count/s.test(preflightCall.prompt), preflightCall && preflightCall.prompt)
      check('preflight prompt names the build-tool list (jest, tsc, next, turbo, vitest, playwright, webpack, esbuild, docker, matlab, npm run/test)', !!preflightCall && ['jest', 'tsc', 'next', 'turbo', 'vitest', 'playwright', 'webpack', 'esbuild', 'docker', 'matlab'].every((t) => preflightCall.prompt.includes(t)), preflightCall && preflightCall.prompt)
      houseRules(calls)
    },
  },
  {
    name: 'B. host contention on all 3 preflight attempts — early abort, zero further calls',
    args: baseArgs(),
    preflight: { contended: true, treeClean: true, resumeWritten: true, note: 'busy' },
    assert({ result: r, calls, phaseCalls }) {
      check('result is the host-contention abort shape', r.aborted === 'host-contention' && Array.isArray(r.phaseReport) && r.phaseReport.length === 0, JSON.stringify(r))
      check('preflight was retried up to 3 times, never more', byLabel(calls, 'preflight').length === 3, byLabel(calls, 'preflight').length)
      check('ZERO further calls of any kind — only the 3 preflight attempts, no ground/build/pack/review/checkpoint/result', calls.length === 3 && calls.every((c) => c.label === 'preflight'), JSON.stringify(calls.map((c) => c.label)))
      check('phase() only ever marked Baseline — the abort never reaches closeOut, so Final pass never fires', JSON.stringify(phaseCalls) === JSON.stringify(['Baseline']), JSON.stringify(phaseCalls))
    },
  },
  {
    name: 'C. ground check fails (brief cites a missing file) — Build never runs, result still written',
    args: baseArgs(),
    ground: { ok: false, missing: ['src/does-not-exist.ts'], packages: [], note: 'missing' },
    assert({ result: r, calls, phaseCalls }) {
      check('no build/pack/review call ran', byLabel(calls, 'build:').length === 0 && byLabel(calls, 'pack').length === 0 && byLabel(calls, 'review:').length === 0)
      check('result.clean is false with the missing-file finding recorded', r.clean === false && r.remainingFindings.some((f) => f.evidence.includes('does-not-exist.ts')), JSON.stringify(r.remainingFindings))
      check('the result agent still ran (every run is closeable)', byLabel(calls, 'result').length === 1)
      check('the ground-fail finding is tagged phase: Baseline (F4)', r.remainingFindings.every((f) => f.phase === 'Baseline'), JSON.stringify(r.remainingFindings))
      check('phase() marked only Baseline then Final pass (Implement/Gate & Review/Fix never entered)', JSON.stringify(phaseCalls) === JSON.stringify(['Baseline', 'Final pass']), JSON.stringify(phaseCalls))
    },
  },
  {
    name: 'D. one fix round resolves everything — rounds=1, clean=true, confirmedByPhase bumped for the tested-green fix',
    args: baseArgs(),
    reviewFindings: [finding()],
    assert({ result: r, calls, phaseCalls }) {
      check('exactly one fix round ran (fix-brief, fix-plan, execute, recheck each once)', byLabel(calls, 'fix-brief').length === 1 && byLabel(calls, 'fix-plan').length === 1 && byLabel(calls, 'execute:').length === 1 && byLabel(calls, 'recheck').length === 1)
      check('result.rounds is 1', r.rounds === 1, r.rounds)
      check('result.fixRounds is also 1 (F2)', r.fixRounds === 1, r.fixRounds)
      check('result.clean is true', r.clean === true, JSON.stringify(r.remainingFindings))
      // F4: the finding originated in Review (Gate & Review), so the executed
      // fix's confirmed credit goes there -- never a blanket 'Final pass'.
      check('confirmedByPhase["Gate & Review"] is 1 (the finding originated in Review; F4 credits the originating phase)', r.confirmedByPhase['Gate & Review'] === 1, JSON.stringify(r.confirmedByPhase))
      check('confirmedByPhase["Final pass"] stays 0 (F4 -- crediting no longer defaults there)', r.confirmedByPhase['Final pass'] === 0, JSON.stringify(r.confirmedByPhase))
      check('the executor ran on the mechanical tier: Sonnet at low effort', byLabel(calls, 'execute:').every((c) => c.model === 'claude-sonnet-5' && c.effort === 'low'))
      check('phase() marked Baseline, Implement, Gate & Review, Fix, Final pass — one fix round entered Fix', JSON.stringify(phaseCalls) === JSON.stringify(['Baseline', 'Implement', 'Gate & Review', 'Fix', 'Final pass']), JSON.stringify(phaseCalls))
      houseRules(calls)
    },
  },
  {
    name: 'E. maxFixRounds enforced: findings never resolve — the run stops at the cap, never a 3rd round, ends clean:false',
    args: baseArgs({ maxFixRounds: 2 }),
    reviewFindings: [finding()],
    recheck: { claims: [], findings: [finding({ summary: 'still wrong' })], verdict: 'FIX-FIRST' },
    assert({ result: r, calls }) {
      check('exactly 2 fix rounds ran, never a 3rd', byLabel(calls, 'fix-brief').length === 2 && byLabel(calls, 'recheck').length === 2, `fix-brief=${byLabel(calls, 'fix-brief').length} recheck=${byLabel(calls, 'recheck').length}`)
      check('result.rounds is 2 (== maxFixRounds)', r.rounds === 2, r.rounds)
      check('result.clean is false (findings still open)', r.clean === false)
      check('remainingFindings is non-empty — the owner still has a question', r.remainingFindings.length > 0)
    },
  },
  {
    name: 'F. concurrentEditors + isolation:worktree — Build fans out with isolation propagated; the sequential default run gets none',
    args: baseArgs({ concurrentEditors: true, isolation: 'worktree' }),
    packages: [{ id: 'WP1', title: 'w', brief: 'b', files: ['src/a.ts'], risk: 'LOW' }, { id: 'WP2', title: 'w2', brief: 'b', files: ['src/b.ts'], risk: 'HIGH' }],
    assert({ result: r, calls }) {
      const builds = byLabel(calls, 'build:')
      check('both packages built', builds.length === 2, builds.length)
      check('isolation:worktree propagated to every build call', builds.every((c) => c.isolation === 'worktree'), JSON.stringify(builds.map((c) => c.isolation)))
      check('the HIGH-risk package built at Sonnet high; the LOW-risk one at medium', builds.find((c) => c.label === 'build:WP2').effort === 'high' && builds.find((c) => c.label === 'build:WP1').effort === 'medium', JSON.stringify(builds.map((c) => [c.label, c.effort])))
      check('a warm-up call preceded the parallel build wave', calls.findIndex((c) => c.label === 'warmup') !== -1 && calls.findIndex((c) => c.label === 'warmup') < calls.findIndex((c) => c.label.startsWith('build:')))
    },
  },
  {
    name: 'G. NO concurrentEditors (default) with 2 packages — single-agent-default: sequential, no isolation on any call',
    args: baseArgs(),
    packages: [{ id: 'WP1', title: 'w', brief: 'b', files: ['src/a.ts'], risk: 'LOW' }, { id: 'WP2', title: 'w2', brief: 'b', files: ['src/b.ts'], risk: 'LOW' }],
    assert({ result: r, calls }) {
      const builds = byLabel(calls, 'build:')
      check('both packages still built', builds.length === 2)
      check('no isolation on any build call — concurrentEditors was never set', builds.every((c) => c.isolation === undefined), JSON.stringify(builds.map((c) => c.isolation)))
      check('no warm-up call fired (no fan-out to warm for)', byLabel(calls, 'warmup').length === 0)
    },
  },
  {
    name: 'H. spansSkillAndRepo — two parallel Opus review lenses, both PHASE-tagged Gate & Review',
    args: baseArgs({ spansSkillAndRepo: true }),
    assert({ result: r, calls }) {
      const reviews = byLabel(calls, 'review:')
      check('exactly two review lenses ran', reviews.length === 2, reviews.map((c) => c.label))
      check('both lenses ran on Opus at high effort', reviews.every((c) => c.model === 'claude-opus-5' && c.effort === 'high'))
      check('both lenses tagged PHASE: Gate & Review', reviews.every((c) => c.phase === 'Gate & Review'))
      check('a warm-up preceded the two-lens wave', byLabel(calls, 'warmup').length >= 1)
    },
  },
  {
    name: 'I. Fable fix-planner declines (returns null) — retried once on Opus at xhigh, never silently skipped',
    args: baseArgs(),
    reviewFindings: [finding()],
    overrides: { 'fix-plan': (label) => (label === 'fix-plan' ? null : { fixes: [{ findingRef: 0, action: 'fix', design: 'apply the hint', invariant: 'x', testPin: '', executorTier: 'sonnet' }], deferred: [], note: 'fallback' }) },
    assert({ result: r, calls }) {
      const plans = calls.filter((c) => c.label === 'fix-plan' || c.label === 'fix-plan:fallback')
      check('fix-plan (Fable) then fix-plan:fallback (Opus xhigh) both ran', plans.length === 2 && plans[0].label === 'fix-plan' && plans[1].label === 'fix-plan:fallback', JSON.stringify(plans.map((c) => c.label)))
      check('the fallback ran on Opus at xhigh effort', plans[1].model === 'claude-opus-5' && plans[1].effort === 'xhigh')
      check('the fallback\'s decision was actually used to execute a fix', byLabel(calls, 'execute:').length === 1)
      check('the Opus FALLBACK fix-planner is EXEMPT from the F8 tool-call cap — it decides from brief text alone, zero repo access', !plans[1].prompt.includes('tool calls'), plans[1].prompt)
    },
  },
  {
    name: 'J. a dead build agent is a finding that enters the fix pipeline, never a silent clean pass',
    args: baseArgs(),
    overrides: { 'build:WP1': null },
    assert({ result: r, calls }) {
      // The dead agent becomes a real finding, which the run's own fix-round
      // machinery then picks up and resolves -- proving it was never treated
      // as "zero findings = clean" in the first place. Assert it surfaced
      // and was actually fed to the fix pipeline, not that the run stops dead.
      const briefCall = calls.find((c) => c.label === 'fix-brief')
      check('the dead build agent surfaced as a real finding and reached the fix brief', !!briefCall && briefCall.prompt.includes('build:WP1'), briefCall && briefCall.prompt)
      check('the run still closes out (result written) even though a package agent died', byLabel(calls, 'result').length === 1)
    },
  },
  {
    name: 'K. fix-brief agent killed every round — openFindings carry forward (never {items: []}), the run still ends clean:false with findings preserved',
    args: baseArgs({ maxFixRounds: 1 }),
    reviewFindings: [finding()],
    overrides: { 'fix-brief': null },
    assert({ result: r, calls }) {
      check('fix-brief was called (and returned null every time)', byLabel(calls, 'fix-brief').length >= 1)
      // F1: if openFindings had collapsed to {items: []}, runFixPlan would
      // short-circuit BEFORE ever calling the planner agent (`!brief.items.length`
      // returns early) — so a fix-plan call proves the finding was carried forward.
      check('fix-plan still ran on non-empty carried-forward items (never short-circuited on {items: []})', byLabel(calls, 'fix-plan').length >= 1, 'fix-plan never called — items must have been empty')
      check('result.clean is false', r.clean === false)
      check('remainingFindings is non-empty — the original finding was never silently dropped', r.remainingFindings.length > 0, JSON.stringify(r.remainingFindings))
    },
  },
  {
    name: 'L. concurrentEditors:true alone (no isolation arg at all) — F6 default is worktree, every mutating build call carries it',
    args: baseArgs({ concurrentEditors: true }),
    packages: [{ id: 'WP1', title: 'w', brief: 'b', files: ['src/a.ts'], risk: 'LOW' }, { id: 'WP2', title: 'w2', brief: 'b', files: ['src/b.ts'], risk: 'LOW' }],
    assert({ result: r, calls }) {
      const builds = byLabel(calls, 'build:')
      check('both packages built', builds.length === 2, builds.length)
      check('isolation:worktree applied to every build call even though isolation was never passed explicitly (F6)', builds.every((c) => c.isolation === 'worktree'), JSON.stringify(builds.map((c) => c.isolation)))
      check('a warm-up call preceded the parallel build wave', calls.findIndex((c) => c.label === 'warmup') !== -1 && calls.findIndex((c) => c.label === 'warmup') < calls.findIndex((c) => c.label.startsWith('build:')))
    },
  },
  {
    name: 'M. a BLOCK review verdict still enters the fix pipeline (F7); the Opus recheck + an Opus-tier executor both carry the 12-tool-call cap (F8)',
    args: baseArgs({ maxFixRounds: 1 }),
    reviewResponder: () => ({ claims: [], findings: [finding()], verdict: 'BLOCK' }),
    fixPlan: { fixes: [{ findingRef: 0, action: 'fix', design: 'apply the hint', invariant: 'x', testPin: '', executorTier: 'opus' }], deferred: [], note: '' },
    recheck: { claims: [], findings: [finding({ summary: 'still wrong' })], verdict: 'BLOCK' },
    assert({ result: r, calls }) {
      check('at least one fix round ran despite the BLOCK verdict (fix-brief, fix-plan, execute, recheck each ran)', byLabel(calls, 'fix-brief').length >= 1 && byLabel(calls, 'fix-plan').length >= 1 && byLabel(calls, 'execute:').length >= 1 && byLabel(calls, 'recheck').length >= 1)
      check('result.rounds is 1 (== maxFixRounds — the cap still applies under BLOCK)', r.rounds === 1, r.rounds)
      check('result.clean is false (recheck still reports BLOCK/findings)', r.clean === false)
      const exec = calls.find((c) => c.label === 'execute:0')
      check('the opus-tier executor ran on Opus at high effort', !!exec && exec.model === 'claude-opus-5' && exec.effort === 'high')
      check('the opus-tier executor prompt carries the 12-tool-call cap (F8)', !!exec && exec.prompt.includes('Hard cap: 12 tool calls'))
      const recheckCall = calls.find((c) => c.label === 'recheck')
      check('the recheck prompt carries the 12-tool-call cap (F8)', !!recheckCall && recheckCall.prompt.includes('Hard cap: 12 tool calls'))
    },
  },
]

for (const s of scenarios) {
  console.log(`\n${s.name}`)
  try {
    const out = await run(s)
    checkPhaseCalls(out.phaseCalls)
    await s.assert(out)
    if (showCalls) for (const c of out.calls) console.log(`     ${String(c.phase).padEnd(15)} ${c.label.padEnd(24)} ${String(c.model).padEnd(18)} ${c.effort}`)
  } catch (e) {
    failures++
    console.log(`  FAIL scenario threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`)
  }
}
// F5 static check: the fix-plan brief must be capped exactly like pipeline.js's
// capFableBrief() (same byte cap, same truncation marker, applied before BOTH
// the Fable call and its Opus fallback). None of the canned scenarios above
// produce an 8 KB+ brief, so this greps the source directly rather than
// forcing an artificial giant-findings scenario onto the shared harness.
console.log('\nF5. Fable brief cap (static check on the source)')
check('an 8192-byte cap constant is defined, mirroring CFG.caps.fableBriefBytes', /FABLE_BRIEF_CAP_BYTES\s*=\s*8192/.test(src))
check('the truncation marker matches pipeline.js\'s capFableBrief() verbatim', /\[truncated at 8 KB — packager must tighten\]/.test(src))
check('runFixPlan caps the brief once and reuses it for both the Fable call and its Opus fallback', /const capped = capFableBrief\(fixPlanPrompt\(brief\)\)/.test(src) && (src.match(/askAgent\(capped\.text/g) || []).length === 2)

// SOURCE SCAN (owner ruling — light-loop.js runs in a sandbox with NO host
// globals; capFableBrief's `Buffer.from`/`Buffer.byteLength` crashed it with
// `ReferenceError: Buffer is not defined`, which is why FIX 1 replaced
// utf8ByteLength with a pure code-point walk). Strip `src` down to real code
// — `//` and `/* */` comments, quoted-string bodies, and template-literal
// LITERAL text all go blank (newlines kept so line numbers stay right),
// while every `${...}` substitution is walked as code, recursively, so a
// host global hidden inside a nested substitution would still be caught —
// then assert what remains never touches one. Registered through check() so
// a regression here fails the run like any other assertion. Not a general JS
// parser: it does not disambiguate regex literals from division, which
// light-loop.js does not lean on near any of the banned tokens.
console.log('\nSOURCE SCAN. light-loop.js never touches a host global the sandbox does not provide')
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
  'light-loop.js (outside comments/strings/template text) never calls Buffer., process., require(, fs., Date.now(, Math.random(, or new Date()',
  engineHits.length === 0,
  engineHits.join(', '),
)
// Self-test the scanner itself (repro-first): light-loop.js.bak-2026-09-11e is
// the PRE-FIX capFableBrief with real Buffer.from/Buffer.byteLength calls. If
// the scanner did not flag that text, it would not have caught the sandbox
// crash either — this is the proof the check above is doing real work.
const lightLoopBakPath = path.join(here, 'light-loop.js.bak-2026-09-11e')
const lightLoopBakHits = fs.existsSync(lightLoopBakPath) ? scanHostGlobals(fs.readFileSync(lightLoopBakPath, 'utf8')) : null
check(
  'self-test: light-loop.js.bak-2026-09-11e (pre-fix, real Buffer.from/Buffer.byteLength calls) IS flagged for Buffer.',
  Array.isArray(lightLoopBakHits) && lightLoopBakHits.some((h) => h.startsWith('Buffer.@')),
  lightLoopBakHits ? lightLoopBakHits.join(', ') : `missing ${lightLoopBakPath}`,
)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL LIGHT-LOOP DRY-RUN SCENARIOS PASSED')
process.exit(failures ? 1 : 0)
